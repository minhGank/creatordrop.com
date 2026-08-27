import { randomBytes, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseDatabaseEnvironment } from '@creatordrop/config';
import {
  createDatabasePool,
  type Database,
  type QueryExecutor,
  type TransactionExecutor,
} from '@creatordrop/database';
import { parseCurrency, parsePositiveMoneyMinor, toMoneyMinor } from '@creatordrop/domain';
import type { Logger } from '@creatordrop/observability';

import {
  parseBoxDraftInput,
  parseRewardDraftInput,
} from '../src/modules/catalog/catalog.schema.js';
import type { CatalogPublicationError } from '../src/modules/catalog/catalog.errors.js';
import {
  createCatalogService,
  type CatalogService,
} from '../src/modules/catalog/catalog.service.js';
import type {
  BoxId,
  InventoryPoolId,
  ProbabilityWeight,
  RewardId,
  RewardVersionId,
} from '../src/modules/catalog/catalog.js';
import type { CreatorId, UserId } from '../src/modules/creators/creator.js';
import { createEnvironmentSeedEncryptionKeyProvider } from '../src/modules/fairness/fairness.key-provider.js';
import {
  createFairnessService,
  type FairnessService,
} from '../src/modules/fairness/fairness.service.js';
import type { ClientSeed } from '../src/modules/fairness/fairness.js';
import { OpeningRetryableError } from '../src/modules/openings/opening.errors.js';
import {
  createOpeningService,
  type OpeningService,
} from '../src/modules/openings/opening.service.js';
import {
  applyWalletDelta,
  ensureOpeningLedgerAccount,
  finalizeLedgerTransaction,
  findLedgerTransactionWithEntries,
  insertLedgerEntries,
  insertLedgerTransaction,
  lockWalletsForLedgerAccounts,
} from '../src/modules/wallet/wallet.repository.js';
import { LedgerTransactionNotReversibleError } from '../src/modules/wallet/wallet.errors.js';
import {
  createWalletService,
  reverseLedgerTransaction,
  type WalletService,
} from '../src/modules/wallet/wallet.service.js';
import type {
  LedgerAccountId,
  LedgerEntry,
  LedgerEntryId,
  LedgerTransactionId,
} from '../src/modules/wallet/wallet.js';

const localApplicationUrl =
  'postgresql://postgres:postgres@127.0.0.1:54322/postgres?options=-c%20role%3Dcreatordrop_app';
const applicationEnvironment = parseDatabaseEnvironment({
  DATABASE_APPLICATION_NAME: 'creatordrop-opening-integration',
  DATABASE_CONNECTION_TIMEOUT_MS: '5000',
  DATABASE_IDLE_TIMEOUT_MS: '1000',
  DATABASE_POOL_MAX: '12',
  DATABASE_URL: process.env.DATABASE_URL ?? localApplicationUrl,
});
const logger: Logger = { error: () => undefined, info: () => undefined };
const usd = parseCurrency('USD');
const masterKeyHex = '0'.repeat(64);

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
}

type Settlement =
  { readonly status: 'fulfilled' } | { readonly reason: unknown; readonly status: 'rejected' };

const createDeferred = <Value>(): Deferred<Value> => {
  let resolver: (value: Value) => void = () => {
    throw new Error('Deferred resolver was not initialized.');
  };
  const promise = new Promise<Value>((resolve) => {
    resolver = resolve;
  });
  return { promise, resolve: resolver };
};

const trackSettlement = <Value>(operation: Promise<Value>): Promise<Settlement> =>
  operation.then(
    () => ({ status: 'fulfilled' }),
    (reason: unknown) => ({ reason, status: 'rejected' }),
  );

const readBackendPid = async (executor: QueryExecutor): Promise<number> => {
  const result = await executor.query<{ readonly backendPid: number }>(
    `select pg_catalog.pg_backend_pid() as "backendPid"`,
  );
  const backendPid = result.rows[0]?.backendPid;
  if (backendPid === undefined) throw new Error('PostgreSQL did not return its backend PID.');
  return backendPid;
};

const observeBlocking = async (
  inspector: QueryExecutor,
  waiterPid: number,
  blockerPid: number,
  settlement: Promise<Settlement>,
): Promise<'blocked' | 'settled'> => {
  let observedSettlement: Settlement | undefined;
  let lastObservation: unknown;
  void settlement.then((result) => {
    observedSettlement = result;
  });
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const result = await inspector.query<{
      readonly blocked: boolean;
      readonly blockers: number[];
      readonly state: string | null;
      readonly waitEvent: string | null;
    }>(
      `select pg_catalog.cardinality(pg_catalog.pg_blocking_pids($1::integer)) > 0 as blocked,
              pg_catalog.pg_blocking_pids($1::integer) as blockers,
              activity.state,
              activity.wait_event as "waitEvent"
         from pg_catalog.pg_stat_activity as activity
        where activity.pid = $1 and $2::integer > 0`,
      [waiterPid, blockerPid],
    );
    lastObservation = result.rows[0];
    if (result.rows[0]?.blocked === true) return 'blocked';
    if (observedSettlement !== undefined) return 'settled';
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 1);
    });
  }
  throw new Error(
    `The opening transaction neither blocked nor settled: ${JSON.stringify(lastObservation)}`,
  );
};

interface TestUser {
  readonly clientSeed: ClientSeed;
  readonly id: UserId;
}

interface TestCatalog {
  readonly boxId: BoxId;
  readonly rewardVersionId: RewardVersionId;
}

describe('atomic box opening', { concurrent: false }, () => {
  let catalog: CatalogService;
  let database: Database;
  let blockerDatabase: Database;
  let fairness: FairnessService;
  let firstConcurrencyDatabase: Database;
  let nextServerSeed: Uint8Array | undefined;
  let openings: OpeningService;
  let secondConcurrencyDatabase: Database;
  let wallets: WalletService;

  beforeAll(() => {
    database = createDatabasePool({
      ...applicationEnvironment,
      onUnexpectedPoolError: (error) => {
        throw error;
      },
    });
    blockerDatabase = createDatabasePool({
      ...applicationEnvironment,
      applicationName: 'creatordrop-opening-blocker',
      maxConnections: 1,
      onUnexpectedPoolError: (error) => {
        throw error;
      },
    });
    firstConcurrencyDatabase = createDatabasePool({
      ...applicationEnvironment,
      applicationName: 'creatordrop-opening-concurrency-a',
      maxConnections: 1,
      onUnexpectedPoolError: (error) => {
        throw error;
      },
    });
    secondConcurrencyDatabase = createDatabasePool({
      ...applicationEnvironment,
      applicationName: 'creatordrop-opening-concurrency-b',
      maxConnections: 1,
      onUnexpectedPoolError: (error) => {
        throw error;
      },
    });
    catalog = createCatalogService({ database, logger });
    fairness = createFairnessService({
      database,
      generateSeed: () => {
        const seed = nextServerSeed;
        if (seed === undefined) throw new Error('A test server seed was not prepared.');
        nextServerSeed = undefined;
        return Uint8Array.from(seed);
      },
      keyProvider: createEnvironmentSeedEncryptionKeyProvider({
        historicalKeys: {},
        keyHex: masterKeyHex,
        version: 'local-dev-v1',
      }),
      logger,
      policy: { maxAgeMs: 86_400_000, maxOpenings: 1000n },
    });
    wallets = createWalletService({ database, logger, testCreditsEnabled: true });
    openings = createOpeningService({ database, fairnessService: fairness, logger });
  });

  afterAll(async () => {
    await Promise.all([
      blockerDatabase.close(),
      database.close(),
      firstConcurrencyDatabase.close(),
      secondConcurrencyDatabase.close(),
    ]);
  });

  const createCreator = async (): Promise<CreatorId> => {
    const creatorId = randomUUID() as CreatorId;
    const ownerId = randomUUID() as UserId;
    await database.query(
      `insert into app.users (id, auth_provider, auth_subject, username)
       values ($1, 'synthetic-opening-owner', $1::uuid::text, $2)`,
      [ownerId, `opening_owner_${ownerId.replaceAll('-', '')}`],
    );
    await database.transaction(async (transaction) => {
      await transaction.query(
        `insert into app.creators (id, handle, custom_slug, display_name)
         values ($1, $2, $3, 'Opening Creator')`,
        [
          creatorId,
          `opening_${creatorId.replaceAll('-', '').slice(0, 12)}`,
          `opening-${creatorId.replaceAll('-', '').slice(0, 12)}`,
        ],
      );
      await transaction.query(
        `insert into app.creator_memberships (creator_id, user_id, role)
         values ($1, $2, 'owner')`,
        [creatorId, ownerId],
      );
    });
    return creatorId;
  };

  const creatorOwner = async (creatorId: CreatorId): Promise<UserId> => {
    const result = await database.query<{ readonly id: string }>(
      `select user_id::text as id from app.creator_memberships
        where creator_id = $1 and role = 'owner'`,
      [creatorId],
    );
    const id = result.rows[0]?.id;
    if (id === undefined) throw new Error('Creator owner was not found.');
    return id as UserId;
  };

  const createUser = async (creditMinor: string): Promise<TestUser> => {
    const id = randomUUID() as UserId;
    const clientSeed = randomBytes(32).toString('hex') as ClientSeed;
    await database.query(
      `insert into app.users (id, auth_provider, auth_subject, username)
       values ($1, 'synthetic-opening-fan', $1::uuid::text, $2)`,
      [id, `opening_fan_${id.replaceAll('-', '')}`],
    );
    nextServerSeed = randomBytes(32);
    await fairness.initialize({ clientSeed, requestId: randomUUID(), userId: id });
    await wallets.grantTestCredits({
      amountMinor: parsePositiveMoneyMinor(creditMinor),
      currency: usd,
      idempotencyKey: `credit_${randomUUID()}`,
      requestId: randomUUID(),
      userId: id,
    });
    return { clientSeed, id };
  };

  const inventoryPoolForVersion = async (
    rewardVersionId: RewardVersionId,
  ): Promise<InventoryPoolId> => {
    const result = await database.query<{ readonly id: string }>(
      `select inventory_pool_id::text as id
         from app.reward_versions
        where id = $1 and inventory_mode = 'finite'`,
      [rewardVersionId],
    );
    const id = result.rows[0]?.id;
    if (id === undefined) throw new Error('Finite reward inventory pool was not found.');
    return id as InventoryPoolId;
  };

  const createRewardRecord = async (
    creatorId: CreatorId,
    input: {
      readonly mode: 'finite' | 'unlimited';
      readonly policy?: 'backorder' | 'pause_box';
      readonly quantity?: string;
    },
  ): Promise<{ readonly rewardId: RewardId; readonly versionId: RewardVersionId }> => {
    const ownerId = await creatorOwner(creatorId);
    const reward = await catalog.createReward({
      actorUserId: ownerId,
      creatorId,
      ...parseRewardDraftInput({
        description: '',
        inventoryMode: input.mode,
        inventoryQuantity: input.mode === 'finite' ? (input.quantity ?? '1') : null,
        inventoryStockoutPolicy: input.mode === 'finite' ? (input.policy ?? 'pause_box') : null,
        name: `Reward ${randomUUID()}`,
        rewardType: 'digital',
      }),
      requestId: randomUUID(),
    });
    if (reward.draft === null) throw new Error('Reward draft was not created.');
    return { rewardId: reward.id, versionId: reward.draft.id };
  };

  const createReward = async (
    creatorId: CreatorId,
    input: {
      readonly mode: 'finite' | 'unlimited';
      readonly policy?: 'backorder' | 'pause_box';
      readonly quantity?: string;
    },
  ): Promise<RewardVersionId> => {
    return (await createRewardRecord(creatorId, input)).versionId;
  };

  const createBox = async (
    creatorId: CreatorId,
    rewardVersionId: RewardVersionId,
    priceMinor = '999',
    currency = 'USD',
  ): Promise<TestCatalog> => {
    const ownerId = await creatorOwner(creatorId);
    const box = await catalog.createBox({
      actorUserId: ownerId,
      creatorId,
      ...parseBoxDraftInput({
        currency,
        description: '',
        name: `Box ${randomUUID()}`,
        priceMinor,
      }),
      requestId: randomUUID(),
    });
    await catalog.replaceDraftConfiguration({
      actorUserId: ownerId,
      boxId: box.id,
      creatorId,
      entries: [
        {
          isBaseReward: true,
          rewardVersionId,
          weight: 1n as ProbabilityWeight,
        },
      ],
      expectedRevision: 1,
      requestId: randomUUID(),
    });
    await catalog.publishBox({
      actorUserId: ownerId,
      boxId: box.id,
      creatorId,
      expectedRevision: 2,
      requestId: randomUUID(),
    });
    return { boxId: box.id, rewardVersionId };
  };

  const createWeightedBox = async (
    creatorId: CreatorId,
    entries: readonly {
      readonly isBaseReward: boolean;
      readonly rewardVersionId: RewardVersionId;
      readonly weight: ProbabilityWeight;
    }[],
  ): Promise<BoxId> => {
    const ownerId = await creatorOwner(creatorId);
    const box = await catalog.createBox({
      actorUserId: ownerId,
      creatorId,
      ...parseBoxDraftInput({
        currency: 'USD',
        description: '',
        name: `Concurrent box ${randomUUID()}`,
        priceMinor: '999',
      }),
      requestId: randomUUID(),
    });
    await catalog.replaceDraftConfiguration({
      actorUserId: ownerId,
      boxId: box.id,
      creatorId,
      entries,
      expectedRevision: 1,
      requestId: randomUUID(),
    });
    await catalog.publishBox({
      actorUserId: ownerId,
      boxId: box.id,
      creatorId,
      expectedRevision: 2,
      requestId: randomUUID(),
    });
    return box.id;
  };

  const open = (user: TestUser, boxId: BoxId, idempotencyKey = `open_${randomUUID()}`) =>
    openings.openBox({
      boxId,
      clientSeed: user.clientSeed,
      idempotencyKey,
      requestId: randomUUID(),
      userId: user.id,
    });

  it('commits one balanced opening, fee/earnings/points/outbox, and exact replay', async () => {
    const creatorId = await createCreator();
    const rewardVersionId = await createReward(creatorId, { mode: 'unlimited' });
    const box = await createBox(creatorId, rewardVersionId);
    const user = await createUser('999');
    const key = `opening_${randomUUID()}`;

    const first = await open(user, box.boxId, key);
    const replay = await open(user, box.boxId, key);
    expect(first.replayed).toBe(false);
    expect(replay).toEqual({ ...first, replayed: true });
    expect(first.body.opening.pointsAwarded).toBe(20);
    expect(first.body.opening.wallet.balanceMinor).toBe('0');

    const persisted = await database.query<{
      readonly creatorShare: string;
      readonly entrySum: string;
      readonly fee: string;
      readonly idempotencyCount: string;
      readonly openingCount: string;
      readonly outboxCount: string;
      readonly transactionCount: string;
    }>(
      `select
         (select creator_share_minor::text from app.box_opens where public_id = $1) as "creatorShare",
         (select platform_fee_minor::text from app.box_opens where public_id = $1) as fee,
         (select count(*)::text from app.box_opens where public_id = $1) as "openingCount",
         (select count(*)::text from app.event_outbox where aggregate_id =
            (select id from app.box_opens where public_id = $1)) as "outboxCount",
         (select count(*)::text from app.idempotency_records
            where actor_user_id = $2 and operation = 'box.open') as "idempotencyCount",
         (select count(*)::text from app.ledger_transactions
            where business_reference_id = (select id from app.box_opens where public_id = $1))
            as "transactionCount",
         (select coalesce(sum(entry.amount_minor), 0)::text
            from app.ledger_entries as entry
            join app.ledger_transactions as transaction
              on transaction.id = entry.ledger_transaction_id
           where transaction.business_reference_id =
             (select id from app.box_opens where public_id = $1)) as "entrySum"`,
      [first.body.opening.id, user.id],
    );
    expect(persisted.rows).toEqual([
      {
        creatorShare: '800',
        entrySum: '0',
        fee: '199',
        idempotencyCount: '1',
        openingCount: '1',
        outboxCount: '2',
        transactionCount: '2',
      },
    ]);

    const changedFeeUser = await createUser('999');
    const changedFeeOpening = await createOpeningService({
      database,
      fairnessService: fairness,
      logger,
      platformFeeBps: 1000,
    }).openBox({
      boxId: box.boxId,
      clientSeed: changedFeeUser.clientSeed,
      idempotencyKey: `opening_${randomUUID()}`,
      requestId: randomUUID(),
      userId: changedFeeUser.id,
    });
    const snapshots = await database.query<{
      readonly creatorShare: string;
      readonly fee: string;
      readonly feeBps: number;
      readonly holdExact: boolean;
      readonly points: number;
    }>(
      `select creator_share_minor::text as "creatorShare",
              platform_fee_minor::text as fee,
              platform_fee_bps as "feeBps",
              earnings_available_at - created_at = interval '14 days' as "holdExact",
              points_awarded as points
         from app.box_opens
        where public_id = any($1::uuid[])
        order by public_id`,
      [[first.body.opening.id, changedFeeOpening.body.opening.id].sort()],
    );
    expect(snapshots.rows).toEqual([
      first.body.opening.id < changedFeeOpening.body.opening.id
        ? { creatorShare: '800', fee: '199', feeBps: 2000, holdExact: true, points: 20 }
        : { creatorShare: '900', fee: '99', feeBps: 1000, holdExact: true, points: 20 },
      first.body.opening.id < changedFeeOpening.body.opening.id
        ? { creatorShare: '900', fee: '99', feeBps: 1000, holdExact: true, points: 20 }
        : { creatorShare: '800', fee: '199', feeBps: 2000, holdExact: true, points: 20 },
    ]);

    const internalOpening = await database.query<{ readonly id: string }>(
      `select id::text as id from app.box_opens where public_id = $1`,
      [first.body.opening.id],
    );
    const internalOpeningId = internalOpening.rows[0]?.id;
    if (internalOpeningId === undefined) throw new Error('Opening was not persisted.');
    for (const statement of [
      `update app.box_opens set status = status where id = $1`,
      `update app.reward_wins set status = status where opening_id = $1`,
      `update app.fulfillment_obligations set status = status where opening_id = $1`,
      `update app.creator_earnings set status = status where opening_id = $1`,
      `update app.event_outbox set payload = payload where aggregate_id = $1`,
    ]) {
      await expect(database.query(statement, [internalOpeningId])).rejects.toBeDefined();
    }
    await expect(
      openings.openBox({
        boxId: box.boxId,
        clientSeed: 'ff'.repeat(32) as ClientSeed,
        idempotencyKey: key,
        requestId: randomUUID(),
        userId: user.id,
      }),
    ).rejects.toMatchObject({ name: 'IdempotencyKeyReusedError' });
  });

  it('rolls back nonce, idempotency, money, inventory, and history after RNG failure', async () => {
    const creatorId = await createCreator();
    const rewardVersionId = await createReward(creatorId, { mode: 'finite', quantity: '1' });
    const box = await createBox(creatorId, rewardVersionId);
    const user = await createUser('999');
    const poolId = await inventoryPoolForVersion(rewardVersionId);
    let selectorCalls = 0;
    const failingOpenings = createOpeningService({
      database,
      fairnessService: {
        selectForOpening: async (transaction, input) => {
          selectorCalls += 1;
          await fairness.selectForOpening(transaction, input);
          throw new Error('synthetic failure after RNG');
        },
      },
      logger,
    });

    await expect(
      failingOpenings.openBox({
        boxId: box.boxId,
        clientSeed: user.clientSeed,
        idempotencyKey: `open_${randomUUID()}`,
        requestId: randomUUID(),
        userId: user.id,
      }),
    ).rejects.toThrow('synthetic failure after RNG');
    expect(selectorCalls).toBe(1);
    const state = await database.query<{
      readonly balance: string;
      readonly consumptionCount: string;
      readonly idempotencyCount: string;
      readonly ledgerCount: string;
      readonly nextNonce: string;
      readonly openingCount: string;
      readonly outboxCount: string;
      readonly quantity: string;
      readonly winCount: string;
    }>(
      `select
         (select available_balance_minor::text from app.wallets where user_id = $1) as balance,
         (select available_quantity::text from app.inventory_pools where id = $2) as quantity,
         (select count(*)::text from app.inventory_consumptions
            where inventory_pool_id = $2) as "consumptionCount",
         (select next_nonce::text from app.rng_seed_sets
            where user_id = $1 and status = 'active') as "nextNonce",
         (select count(*)::text from app.idempotency_records
            where actor_user_id = $1 and operation = 'box.open') as "idempotencyCount",
         (select count(*)::text from app.box_opens where user_id = $1) as "openingCount",
         (select count(*)::text from app.reward_wins where user_id = $1) as "winCount",
         (select count(*)::text from app.ledger_transactions
            where actor_user_id = $1 and kind in ('box_open_sale', 'box_open_allocation'))
            as "ledgerCount",
         (select count(*)::text from app.event_outbox
            where aggregate_id in (select id from app.box_opens where user_id = $1))
            as "outboxCount"`,
      [user.id, poolId],
    );
    expect(state.rows).toEqual([
      {
        balance: '999',
        consumptionCount: '0',
        idempotencyCount: '0',
        ledgerCount: '0',
        nextNonce: '0',
        openingCount: '0',
        outboxCount: '0',
        quantity: '1',
        winCount: '0',
      },
    ]);
  });

  it('rejects insufficient funds before nonce allocation, RNG, or inventory inspection', async () => {
    const creatorId = await createCreator();
    const rewardVersionId = await createReward(creatorId, { mode: 'finite', quantity: '1' });
    const box = await createBox(creatorId, rewardVersionId);
    const user = await createUser('1');
    const poolId = await inventoryPoolForVersion(rewardVersionId);
    let selectorCalls = 0;
    const guardedOpenings = createOpeningService({
      database,
      fairnessService: {
        selectForOpening: async (transaction, input) => {
          selectorCalls += 1;
          return fairness.selectForOpening(transaction, input);
        },
      },
      logger,
    });

    await expect(
      guardedOpenings.openBox({
        boxId: box.boxId,
        clientSeed: user.clientSeed,
        idempotencyKey: `open_${randomUUID()}`,
        requestId: randomUUID(),
        userId: user.id,
      }),
    ).rejects.toMatchObject({ name: 'InsufficientBalanceError' });
    expect(selectorCalls).toBe(0);
    const state = await database.query<{
      readonly claims: string;
      readonly consumptions: string;
      readonly nextNonce: string;
      readonly quantity: string;
    }>(
      `select
         (select next_nonce::text from app.rng_seed_sets
            where user_id = $1 and status = 'active') as "nextNonce",
         (select count(*)::text from app.idempotency_records
            where actor_user_id = $1 and operation = 'box.open') as claims,
         (select count(*)::text from app.inventory_consumptions
            where inventory_pool_id = $2) as consumptions,
         (select available_quantity::text from app.inventory_pools where id = $2) as quantity`,
      [user.id, poolId],
    );
    expect(state.rows).toEqual([{ claims: '0', consumptions: '0', nextNonce: '0', quantity: '1' }]);
  });

  it('rolls back transactional outbox data with its caller-owned transaction', async () => {
    const outboxId = randomUUID();
    await expect(
      database.transaction(async (transaction) => {
        await transaction.query(
          `insert into app.event_outbox (
             id, aggregate_type, aggregate_id, event_type, audience, payload
           ) values ($1, 'box_open', $2, 'opening.completed.v1', 'private', '{}'::jsonb)`,
          [outboxId, randomUUID()],
        );
        throw new Error('synthetic rollback after outbox insertion');
      }),
    ).rejects.toThrow('synthetic rollback after outbox insertion');
    expect(
      (
        await database.query<{ readonly count: string }>(
          `select count(*)::text as count from app.event_outbox where id = $1`,
          [outboxId],
        )
      ).rows,
    ).toEqual([{ count: '0' }]);
  });

  it('serializes concurrent duplicate requests into one exact opening and replay', async () => {
    const creatorId = await createCreator();
    const rewardVersionId = await createReward(creatorId, { mode: 'unlimited' });
    const box = await createBox(creatorId, rewardVersionId);
    const user = await createUser('999');
    const key = `opening_${randomUUID()}`;

    const results = await Promise.all([open(user, box.boxId, key), open(user, box.boxId, key)]);
    expect(new Set(results.map(({ body }) => body.opening.id)).size).toBe(1);
    expect(results.map(({ replayed }) => replayed).sort()).toEqual([false, true]);
    const state = await database.query<{
      readonly balance: string;
      readonly ledgerCount: string;
      readonly nextNonce: string;
      readonly openingCount: string;
    }>(
      `select
         (select available_balance_minor::text from app.wallets where user_id = $1) as balance,
         (select next_nonce::text from app.rng_seed_sets
            where user_id = $1 and status = 'active') as "nextNonce",
         (select count(*)::text from app.box_opens where user_id = $1) as "openingCount",
         (select count(*)::text from app.ledger_transactions
            where actor_user_id = $1 and kind in ('box_open_sale', 'box_open_allocation'))
            as "ledgerCount"`,
      [user.id],
    );
    expect(state.rows).toEqual([
      { balance: '0', ledgerCount: '2', nextNonce: '1', openingCount: '1' },
    ]);
  });

  it('allows only one of two concurrent opens when the wallet funds one', async () => {
    const creatorId = await createCreator();
    const rewardVersionId = await createReward(creatorId, { mode: 'unlimited' });
    const box = await createBox(creatorId, rewardVersionId);
    const user = await createUser('999');

    const outcomes = await Promise.allSettled([
      open(user, box.boxId, `opening_${randomUUID()}`),
      open(user, box.boxId, `opening_${randomUUID()}`),
    ]);
    expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find(({ status }) => status === 'rejected');
    expect(rejected).toMatchObject({ reason: { name: 'InsufficientBalanceError' } });
    const state = await database.query<{
      readonly balance: string;
      readonly nextNonce: string;
      readonly openingCount: string;
    }>(
      `select
         (select available_balance_minor::text from app.wallets where user_id = $1) as balance,
         (select next_nonce::text from app.rng_seed_sets
            where user_id = $1 and status = 'active') as "nextNonce",
         (select count(*)::text from app.box_opens where user_id = $1) as "openingCount"`,
      [user.id],
    );
    expect(state.rows).toEqual([{ balance: '0', nextNonce: '1', openingCount: '1' }]);
  });

  it('rejects a non-enabled box currency without consuming nonce or idempotency state', async () => {
    const creatorId = await createCreator();
    const rewardVersionId = await createReward(creatorId, { mode: 'unlimited' });
    const box = await createBox(creatorId, rewardVersionId, '999', 'CAD');
    const user = await createUser('999');

    await expect(open(user, box.boxId)).rejects.toMatchObject({
      name: 'OpeningCurrencyUnavailableError',
    });
    const state = await database.query<{
      readonly idempotencyCount: string;
      readonly nextNonce: string;
    }>(
      `select
         (select next_nonce::text from app.rng_seed_sets
            where user_id = $1 and status = 'active') as "nextNonce",
         (select count(*)::text from app.idempotency_records
            where actor_user_id = $1 and operation = 'box.open') as "idempotencyCount"`,
      [user.id],
    );
    expect(state.rows).toEqual([{ idempotencyCount: '0', nextNonce: '0' }]);
  });

  it('preserves the selected reward as an awaiting backorder at zero stock', async () => {
    const creatorId = await createCreator();
    const rewardVersionId = await createReward(creatorId, {
      mode: 'finite',
      policy: 'backorder',
      quantity: '1',
    });
    const box = await createBox(creatorId, rewardVersionId);
    const firstUser = await createUser('999');
    const user = await createUser('999');
    const poolId = await inventoryPoolForVersion(rewardVersionId);
    expect((await open(firstUser, box.boxId)).body.opening.fulfillmentStatus).toBe(
      'pending_fulfillment',
    );

    const result = await open(user, box.boxId);
    expect(result.body.opening.fulfillmentStatus).toBe('awaiting_restock');
    expect(result.body.opening.reward.rewardVersionId).toBe(rewardVersionId);
    expect(
      (
        await database.query<{ readonly quantity: string }>(
          `select available_quantity::text as quantity from app.inventory_pools where id = $1`,
          [poolId],
        )
      ).rows,
    ).toEqual([{ quantity: '0' }]);
  });

  it('shares one stable pool across reward versions without replenishing cloned stock', async () => {
    const creatorId = await createCreator();
    const ownerId = await creatorOwner(creatorId);
    const reward = await createRewardRecord(creatorId, { mode: 'finite', quantity: '2' });
    const firstBox = await createBox(creatorId, reward.versionId);
    const poolId = await inventoryPoolForVersion(reward.versionId);
    expect(poolId).not.toBe(reward.versionId);
    await open(await createUser('999'), firstBox.boxId);

    const current = await catalog.getReward({ actorUserId: ownerId, creatorId }, reward.rewardId);
    const updated = await catalog.updateReward({
      actorUserId: ownerId,
      creatorId,
      expectedRevision: current.revision,
      rewardId: reward.rewardId,
      ...parseRewardDraftInput({
        description: 'Versioned presentation update',
        inventoryMode: 'finite',
        inventoryQuantity: '2',
        inventoryStockoutPolicy: 'pause_box',
        name: `Updated reward ${randomUUID()}`,
        rewardType: 'digital',
      }),
      requestId: randomUUID(),
    });
    const secondVersionId = updated.draft?.id;
    if (secondVersionId === undefined) throw new Error('Reward clone was not created.');
    expect(secondVersionId).not.toBe(reward.versionId);

    const beforeSecondOpen = await database.query<{
      readonly available: string;
      readonly firstPool: string;
      readonly secondPool: string;
    }>(
      `select pool.available_quantity::text as available,
              first.inventory_pool_id::text as "firstPool",
              second.inventory_pool_id::text as "secondPool"
         from app.reward_versions as first
         join app.reward_versions as second on second.id = $2
         join app.inventory_pools as pool on pool.id = first.inventory_pool_id
        where first.id = $1`,
      [reward.versionId, secondVersionId],
    );
    expect(beforeSecondOpen.rows).toEqual([
      { available: '1', firstPool: poolId, secondPool: poolId },
    ]);

    const secondBox = await createBox(creatorId, secondVersionId);
    await open(await createUser('999'), secondBox.boxId);
    const finalState = await database.query<{
      readonly activeBoxes: string;
      readonly available: string;
      readonly consumptions: string;
    }>(
      `select
         (select available_quantity::text from app.inventory_pools where id = $1) as available,
         (select count(*)::text from app.inventory_consumptions
            where inventory_pool_id = $1) as consumptions,
         (select count(*)::text from app.boxes
            where id = any($2::uuid[]) and status = 'active') as "activeBoxes"`,
      [poolId, [firstBox.boxId, secondBox.boxId]],
    );
    expect(finalState.rows).toEqual([{ activeBoxes: '0', available: '0', consumptions: '2' }]);

    const otherCreatorId = await createCreator();
    const otherRewardVersionId = await createReward(otherCreatorId, {
      mode: 'finite',
      quantity: '1',
    });
    await expect(
      database.query(`update app.reward_versions set inventory_pool_id = $2 where id = $1`, [
        otherRewardVersionId,
        poolId,
      ]),
    ).rejects.toMatchObject({ constraint: 'reward_version_inventory_pool_creator_invalid' });
  });

  it('rejects publication against an exhausted shared PAUSE_BOX pool', async () => {
    const creatorId = await createCreator();
    const ownerId = await creatorOwner(creatorId);
    const rewardVersionId = await createReward(creatorId, { mode: 'finite', quantity: '1' });
    const firstBox = await createBox(creatorId, rewardVersionId);
    await open(await createUser('999'), firstBox.boxId);
    const poolId = await inventoryPoolForVersion(rewardVersionId);

    const draft = await catalog.createBox({
      actorUserId: ownerId,
      creatorId,
      ...parseBoxDraftInput({
        currency: 'USD',
        description: '',
        name: `Exhausted publication ${randomUUID()}`,
        priceMinor: '999',
      }),
      requestId: randomUUID(),
    });
    await catalog.replaceDraftConfiguration({
      actorUserId: ownerId,
      boxId: draft.id,
      creatorId,
      entries: [
        {
          isBaseReward: true,
          rewardVersionId,
          weight: 1n as ProbabilityWeight,
        },
      ],
      expectedRevision: 1,
      requestId: randomUUID(),
    });
    await expect(
      catalog.publishBox({
        actorUserId: ownerId,
        boxId: draft.id,
        creatorId,
        expectedRevision: 2,
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({
      name: 'CatalogPublicationError',
      reason: 'INVALID_INVENTORY',
    } satisfies Partial<CatalogPublicationError>);
    const state = await database.query<{
      readonly available: string;
      readonly publishedVersionId: string | null;
      readonly status: string;
    }>(
      `select box.status,
              box.current_published_version_id::text as "publishedVersionId",
              pool.available_quantity::text as available
         from app.boxes as box
         join app.inventory_pools as pool on pool.id = $2
        where box.id = $1`,
      [draft.id, poolId],
    );
    expect(state.rows).toEqual([{ available: '0', publishedVersionId: null, status: 'draft' }]);
  });

  it('persists five points for a selected non-base reward', async () => {
    const creatorId = await createCreator();
    const baseRewardVersionId = await createReward(creatorId, { mode: 'unlimited' });
    const normalRewardVersionId = await createReward(creatorId, { mode: 'unlimited' });
    const ownerId = await creatorOwner(creatorId);
    const draft = await catalog.createBox({
      actorUserId: ownerId,
      creatorId,
      ...parseBoxDraftInput({
        currency: 'USD',
        description: '',
        name: `Normal reward box ${randomUUID()}`,
        priceMinor: '999',
      }),
      requestId: randomUUID(),
    });
    await catalog.replaceDraftConfiguration({
      actorUserId: ownerId,
      boxId: draft.id,
      creatorId,
      entries: [
        {
          isBaseReward: false,
          rewardVersionId: normalRewardVersionId,
          weight: 9_223_372_036_854_775_806n as ProbabilityWeight,
        },
        {
          isBaseReward: true,
          rewardVersionId: baseRewardVersionId,
          weight: 1n as ProbabilityWeight,
        },
      ],
      expectedRevision: 1,
      requestId: randomUUID(),
    });
    await catalog.publishBox({
      actorUserId: ownerId,
      boxId: draft.id,
      creatorId,
      expectedRevision: 2,
      requestId: randomUUID(),
    });
    const user = await createUser('999');

    const result = await open(user, draft.id);
    expect(result.body.opening.reward.rewardVersionId).toBe(normalRewardVersionId);
    expect(result.body.opening.pointsAwarded).toBe(5);
    expect(
      (
        await database.query<{ readonly bonus: number; readonly points: number }>(
          `select bonus_points as bonus, points_awarded as points
             from app.box_opens where public_id = $1`,
          [result.body.opening.id],
        )
      ).rows,
    ).toEqual([{ bonus: 0, points: 5 }]);
  });

  it('serializes a shared PAUSE_BOX pool across two boxes without overselling', async () => {
    const creatorId = await createCreator();
    const rewardVersionId = await createReward(creatorId, { mode: 'finite', quantity: '1' });
    const firstBox = await createBox(creatorId, rewardVersionId);
    const secondBox = await createBox(creatorId, rewardVersionId);
    const poolId = await inventoryPoolForVersion(rewardVersionId);
    const firstUser = await createUser('999');
    const secondUser = await createUser('999');

    const outcomes = await Promise.allSettled([
      open(firstUser, firstBox.boxId),
      open(secondUser, secondBox.boxId),
    ]);
    expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    const state = await database.query<{
      readonly activeBoxes: string;
      readonly openings: string;
      readonly quantity: string;
    }>(
      `select
         (select available_quantity::text from app.inventory_pools where id = $1) as quantity,
         (select count(*)::text from app.box_opens where box_id = any($2::uuid[])) as openings,
         (select count(*)::text from app.boxes
            where id = any($2::uuid[]) and status = 'active') as "activeBoxes"`,
      [poolId, [firstBox.boxId, secondBox.boxId]],
    );
    expect(state.rows).toEqual([{ activeBoxes: '0', openings: '1', quantity: '0' }]);
    const fanState = await database.query<{
      readonly balance: string;
      readonly id: string;
      readonly nextNonce: string;
      readonly openings: string;
    }>(
      `select fan.id::text as id, wallet.available_balance_minor::text as balance,
              seed.next_nonce::text as "nextNonce",
              (select count(*)::text from app.box_opens where user_id = fan.id) as openings
         from app.users as fan
         join app.wallets as wallet on wallet.user_id = fan.id and wallet.currency = 'USD'
         join app.rng_seed_sets as seed on seed.user_id = fan.id and seed.status = 'active'
        where fan.id = any($1::uuid[])`,
      [[firstUser.id, secondUser.id]],
    );
    const byUser = new Map(fanState.rows.map((row) => [row.id, row]));
    outcomes.forEach((outcome, index) => {
      const user = index === 0 ? firstUser : secondUser;
      expect(byUser.get(user.id)).toMatchObject(
        outcome.status === 'fulfilled'
          ? { balance: '0', nextNonce: '1', openings: '1' }
          : { balance: '999', nextNonce: '0', openings: '0' },
      );
    });
  });

  it('does not retry an opening after RNG when PostgreSQL aborts a PAUSE_BOX deadlock', async () => {
    const creatorId = await createCreator();
    const firstRewardVersionId = await createReward(creatorId, {
      mode: 'finite',
      quantity: '1',
    });
    const secondRewardVersionId = await createReward(creatorId, {
      mode: 'finite',
      quantity: '1',
    });
    const firstPoolId = await inventoryPoolForVersion(firstRewardVersionId);
    const secondPoolId = await inventoryPoolForVersion(secondRewardVersionId);
    const maximumWeight = 9_223_372_036_854_775_806n as ProbabilityWeight;
    const minimumWeight = 1n as ProbabilityWeight;
    const barrierBoxId = await createWeightedBox(creatorId, [
      {
        isBaseReward: true,
        rewardVersionId: firstRewardVersionId,
        weight: maximumWeight,
      },
      {
        isBaseReward: false,
        rewardVersionId: secondRewardVersionId,
        weight: minimumWeight,
      },
    ]);
    const firstBoxId = await createWeightedBox(creatorId, [
      {
        isBaseReward: true,
        rewardVersionId: firstRewardVersionId,
        weight: maximumWeight,
      },
      {
        isBaseReward: false,
        rewardVersionId: secondRewardVersionId,
        weight: minimumWeight,
      },
    ]);
    const secondBoxId = await createWeightedBox(creatorId, [
      {
        isBaseReward: false,
        rewardVersionId: firstRewardVersionId,
        weight: minimumWeight,
      },
      {
        isBaseReward: true,
        rewardVersionId: secondRewardVersionId,
        weight: maximumWeight,
      },
    ]);
    expect([barrierBoxId, firstBoxId, secondBoxId].sort()[0]).toBe(barrierBoxId);

    const firstUser = await createUser('999');
    const secondUser = await createUser('999');
    const releaseBlocker = createDeferred<undefined>();
    const blockerReady = createDeferred<number>();
    const blocker = blockerDatabase.transaction(async (transaction) => {
      const blockerPid = await readBackendPid(transaction);
      await transaction.query(`select id from app.boxes where id = $1 for update`, [barrierBoxId]);
      blockerReady.resolve(blockerPid);
      await releaseBlocker.promise;
    });
    const blockerPid = await blockerReady.promise;

    const selectionGate = createDeferred<undefined>();
    const firstSelection = createDeferred<{
      readonly backendPid: number;
      readonly poolId: InventoryPoolId;
    }>();
    const secondSelection = createDeferred<{
      readonly backendPid: number;
      readonly poolId: InventoryPoolId;
    }>();
    let selectionsReady = 0;
    const selectorCalls: [number, number] = [0, 0];
    const coordinatedFairness = (
      index: 0 | 1,
      selected: Deferred<{ readonly backendPid: number; readonly poolId: InventoryPoolId }>,
    ): Pick<FairnessService, 'selectForOpening'> => ({
      selectForOpening: async (transaction: TransactionExecutor, input) => {
        selectorCalls[index] += 1;
        const backendPid = await readBackendPid(transaction);
        const result = await fairness.selectForOpening(transaction, input);
        const poolId =
          result.rewardVersionId === firstRewardVersionId
            ? firstPoolId
            : result.rewardVersionId === secondRewardVersionId
              ? secondPoolId
              : undefined;
        if (poolId === undefined) throw new Error('The selector returned an unknown reward.');
        selected.resolve({ backendPid, poolId });
        selectionsReady += 1;
        if (selectionsReady === 2) selectionGate.resolve(undefined);
        await selectionGate.promise;
        return result;
      },
    });
    const firstOpenings = createOpeningService({
      database: firstConcurrencyDatabase,
      fairnessService: coordinatedFairness(0, firstSelection),
      logger,
    });
    const secondOpenings = createOpeningService({
      database: secondConcurrencyDatabase,
      fairnessService: coordinatedFairness(1, secondSelection),
      logger,
    });
    const firstOperation = firstOpenings.openBox({
      boxId: firstBoxId,
      clientSeed: firstUser.clientSeed,
      idempotencyKey: `open_${randomUUID()}`,
      requestId: randomUUID(),
      userId: firstUser.id,
    });
    const secondOperation = secondOpenings.openBox({
      boxId: secondBoxId,
      clientSeed: secondUser.clientSeed,
      idempotencyKey: `open_${randomUUID()}`,
      requestId: randomUUID(),
      userId: secondUser.id,
    });
    const firstSettlement = trackSettlement(firstOperation);
    const secondSettlement = trackSettlement(secondOperation);

    try {
      const [firstSelectionState, secondSelectionState] = await Promise.all([
        firstSelection.promise,
        secondSelection.promise,
      ]);
      expect(firstSelectionState.poolId).toBe(firstPoolId);
      expect(secondSelectionState.poolId).toBe(secondPoolId);
      expect(
        await Promise.all([
          observeBlocking(database, firstSelectionState.backendPid, blockerPid, firstSettlement),
          observeBlocking(database, secondSelectionState.backendPid, blockerPid, secondSettlement),
        ]),
      ).toEqual(['blocked', 'blocked']);
    } finally {
      releaseBlocker.resolve(undefined);
    }
    await blocker;

    const settlements = await Promise.all([firstSettlement, secondSettlement]);
    expect(settlements.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    const rejected = settlements.find(({ status }) => status === 'rejected');
    if (rejected?.status !== 'rejected') throw new Error('A deadlock loser was not reported.');
    expect(rejected.reason).toBeInstanceOf(OpeningRetryableError);
    expect(selectorCalls).toEqual([1, 1]);

    const state = await database.query<{
      readonly available: string;
      readonly balances: string;
      readonly consumptions: string;
      readonly idempotencyRecords: string;
      readonly nonces: string;
      readonly openings: string;
      readonly outboxEvents: string;
    }>(
      `select
         (select sum(available_quantity)::text from app.inventory_pools
           where id = any($1::uuid[])) as available,
         (select sum(available_balance_minor)::text from app.wallets
           where user_id = any($2::uuid[]) and currency = 'USD') as balances,
         (select count(*)::text from app.inventory_consumptions
           where inventory_pool_id = any($1::uuid[])) as consumptions,
         (select count(*)::text from app.idempotency_records
           where actor_user_id = any($2::uuid[]) and operation = 'box.open')
           as "idempotencyRecords",
         (select sum(next_nonce)::text from app.rng_seed_sets
           where user_id = any($2::uuid[]) and status = 'active') as nonces,
         (select count(*)::text from app.box_opens
           where user_id = any($2::uuid[])) as openings,
         (select count(*)::text from app.event_outbox
           where aggregate_id in (
             select id from app.box_opens where user_id = any($2::uuid[])
           )) as "outboxEvents"`,
      [
        [firstPoolId, secondPoolId],
        [firstUser.id, secondUser.id],
      ],
    );
    expect(state.rows).toEqual([
      {
        available: '1',
        balances: '999',
        consumptions: '1',
        idempotencyRecords: '1',
        nonces: '1',
        openings: '1',
        outboxEvents: '2',
      },
    ]);
  }, 15_000);

  it('rejects orphan opening sale and allocation ledger postings at commit', async () => {
    const creatorId = await createCreator();
    const user = await createUser('1000');
    const wallet = (await wallets.listWallets(user.id))[0];
    if (wallet === undefined) throw new Error('Opening test wallet was not found.');

    await expect(
      database.transaction(async (transaction) => {
        const clearing = await ensureOpeningLedgerAccount(transaction, {
          accountId: randomUUID() as LedgerAccountId,
          accountType: 'box_sales_clearing',
          creatorId: null,
          currency: usd,
        });
        const ledgerTransactionId = randomUUID() as LedgerTransactionId;
        await insertLedgerTransaction(transaction, {
          actorUserId: user.id,
          businessReferenceId: randomUUID(),
          businessReferenceType: 'box_open_sale',
          currency: usd,
          description: 'Synthetic orphan opening sale',
          id: ledgerTransactionId,
          idempotencyRecordId: null,
          kind: 'box_open_sale',
          reversesLedgerTransactionId: null,
        });
        await insertLedgerEntries(transaction, ledgerTransactionId, [
          {
            amountMinor: toMoneyMinor(-100n),
            currency: usd,
            id: randomUUID() as LedgerEntryId,
            ledgerAccountId: wallet.ledgerAccountId,
            sequence: 0,
          },
          {
            amountMinor: toMoneyMinor(100n),
            currency: usd,
            id: randomUUID() as LedgerEntryId,
            ledgerAccountId: clearing.id,
            sequence: 1,
          },
        ]);
        if ((await applyWalletDelta(transaction, wallet.id, toMoneyMinor(-100n))) === undefined) {
          throw new Error('Synthetic orphan sale debit failed.');
        }
        await finalizeLedgerTransaction(transaction, ledgerTransactionId);
      }),
    ).rejects.toMatchObject({ constraint: 'box_open_sale_opening_link_invalid' });

    await expect(
      database.transaction(async (transaction) => {
        const clearing = await ensureOpeningLedgerAccount(transaction, {
          accountId: randomUUID() as LedgerAccountId,
          accountType: 'box_sales_clearing',
          creatorId: null,
          currency: usd,
        });
        const creatorEarnings = await ensureOpeningLedgerAccount(transaction, {
          accountId: randomUUID() as LedgerAccountId,
          accountType: 'creator_pending_earnings',
          creatorId,
          currency: usd,
        });
        const platform = await ensureOpeningLedgerAccount(transaction, {
          accountId: randomUUID() as LedgerAccountId,
          accountType: 'platform_fee',
          creatorId: null,
          currency: usd,
        });
        const ledgerTransactionId = randomUUID() as LedgerTransactionId;
        await insertLedgerTransaction(transaction, {
          actorUserId: user.id,
          businessReferenceId: randomUUID(),
          businessReferenceType: 'box_open_allocation',
          currency: usd,
          description: 'Synthetic orphan opening allocation',
          id: ledgerTransactionId,
          idempotencyRecordId: null,
          kind: 'box_open_allocation',
          reversesLedgerTransactionId: null,
        });
        await insertLedgerEntries(transaction, ledgerTransactionId, [
          {
            amountMinor: toMoneyMinor(-100n),
            currency: usd,
            id: randomUUID() as LedgerEntryId,
            ledgerAccountId: clearing.id,
            sequence: 0,
          },
          {
            amountMinor: toMoneyMinor(80n),
            currency: usd,
            id: randomUUID() as LedgerEntryId,
            ledgerAccountId: creatorEarnings.id,
            sequence: 1,
          },
          {
            amountMinor: toMoneyMinor(20n),
            currency: usd,
            id: randomUUID() as LedgerEntryId,
            ledgerAccountId: platform.id,
            sequence: 2,
          },
        ]);
        await finalizeLedgerTransaction(transaction, ledgerTransactionId);
      }),
    ).rejects.toMatchObject({ constraint: 'box_open_allocation_opening_link_invalid' });

    expect((await wallets.listWallets(user.id))[0]?.availableBalanceMinor).toBe(1000n);
  });

  it('rejects application and direct database reversal of either opening financial leg', async () => {
    const creatorId = await createCreator();
    const rewardVersionId = await createReward(creatorId, { mode: 'unlimited' });
    const box = await createBox(creatorId, rewardVersionId);
    const user = await createUser('999');
    const result = await open(user, box.boxId);
    const persisted = await database.query<{
      readonly allocationId: string;
      readonly saleId: string;
    }>(
      `select sale_ledger_transaction_id::text as "saleId",
              allocation_ledger_transaction_id::text as "allocationId"
         from app.box_opens where public_id = $1`,
      [result.body.opening.id],
    );
    const row = persisted.rows[0];
    if (row === undefined) throw new Error('Opening ledger linkage was not found.');
    const ledgerIds = [row.saleId, row.allocationId] as const;

    for (const originalId of ledgerIds) {
      await expect(
        database.transaction((transaction) =>
          reverseLedgerTransaction(transaction, {
            actorUserId: user.id,
            businessReferenceId: randomUUID(),
            businessReferenceType: 'synthetic_opening_reversal',
            description: 'Synthetic forbidden opening reversal',
            originalLedgerTransactionId: originalId as LedgerTransactionId,
          }),
        ),
      ).rejects.toBeInstanceOf(LedgerTransactionNotReversibleError);

      await expect(
        database.transaction(async (transaction) => {
          const original = await findLedgerTransactionWithEntries(
            transaction,
            originalId as LedgerTransactionId,
          );
          if (original === undefined) throw new Error('Opening ledger transaction was not found.');
          const walletsByAccount = new Map(
            (
              await lockWalletsForLedgerAccounts(
                transaction,
                original.entries.map(({ ledgerAccountId }) => ledgerAccountId),
              )
            ).map((lockedWallet) => [lockedWallet.ledgerAccountId, lockedWallet] as const),
          );
          const reversalId = randomUUID() as LedgerTransactionId;
          const reversalEntries: LedgerEntry[] = original.entries.map((entry) => ({
            ...entry,
            amountMinor: toMoneyMinor(0n - entry.amountMinor),
            id: randomUUID() as LedgerEntryId,
          }));
          await insertLedgerTransaction(transaction, {
            actorUserId: user.id,
            businessReferenceId: randomUUID(),
            businessReferenceType: 'synthetic_opening_reversal',
            currency: original.transaction.currency,
            description: 'Synthetic direct forbidden reversal',
            id: reversalId,
            idempotencyRecordId: null,
            kind: 'reversal',
            reversesLedgerTransactionId: original.transaction.id,
          });
          await insertLedgerEntries(transaction, reversalId, reversalEntries);
          for (const entry of reversalEntries) {
            const affectedWallet = walletsByAccount.get(entry.ledgerAccountId);
            if (
              affectedWallet !== undefined &&
              (await applyWalletDelta(transaction, affectedWallet.id, entry.amountMinor)) ===
                undefined
            ) {
              throw new Error('Synthetic direct reversal wallet update failed.');
            }
          }
          await finalizeLedgerTransaction(transaction, reversalId);
        }),
      ).rejects.toMatchObject({ constraint: 'box_open_financial_reversal_forbidden' });
    }

    expect((await wallets.listWallets(user.id))[0]?.availableBalanceMinor).toBe(0n);
  });

  it('rejects orphan and duplicate inventory consumption under the application role', async () => {
    const creatorId = await createCreator();
    const rewardVersionId = await createReward(creatorId, { mode: 'finite', quantity: '2' });
    const box = await createBox(creatorId, rewardVersionId);
    const poolId = await inventoryPoolForVersion(rewardVersionId);

    await expect(
      database.transaction(async (transaction) => {
        await transaction.query(`select id from app.consume_inventory_pool($1, $2)`, [
          poolId,
          randomUUID(),
        ]);
      }),
    ).rejects.toBeDefined();
    expect(
      (
        await database.query<{ readonly quantity: string }>(
          `select available_quantity::text as quantity from app.inventory_pools where id = $1`,
          [poolId],
        )
      ).rows,
    ).toEqual([{ quantity: '2' }]);

    const opening = await open(await createUser('999'), box.boxId);
    const internalOpening = await database.query<{ readonly id: string }>(
      `select id::text as id from app.box_opens where public_id = $1`,
      [opening.body.opening.id],
    );
    const openingId = internalOpening.rows[0]?.id;
    if (openingId === undefined) throw new Error('Opening consumption linkage was not found.');
    await expect(
      database.transaction(async (transaction) => {
        await transaction.query(`select id from app.consume_inventory_pool($1, $2)`, [
          poolId,
          openingId,
        ]);
      }),
    ).rejects.toBeDefined();
    const finalState = await database.query<{
      readonly consumptions: string;
      readonly quantity: string;
    }>(
      `select
         (select available_quantity::text from app.inventory_pools where id = $1) as quantity,
         (select count(*)::text from app.inventory_consumptions
            where inventory_pool_id = $1) as consumptions`,
      [poolId],
    );
    expect(finalState.rows).toEqual([{ consumptions: '1', quantity: '1' }]);
  });

  it('allows concurrent unlimited-reward openings without an inventory pool', async () => {
    const creatorId = await createCreator();
    const rewardVersionId = await createReward(creatorId, { mode: 'unlimited' });
    const box = await createBox(creatorId, rewardVersionId);
    const firstUser = await createUser('999');
    const secondUser = await createUser('999');

    const outcomes = await Promise.all([open(firstUser, box.boxId), open(secondUser, box.boxId)]);
    expect(outcomes).toHaveLength(2);
    expect(
      (
        await database.query<{ readonly pools: string }>(
          `select count(*)::text as pools from app.reward_versions
            where id = $1 and inventory_pool_id is not null`,
          [rewardVersionId],
        )
      ).rows,
    ).toEqual([{ pools: '0' }]);
  });
});
