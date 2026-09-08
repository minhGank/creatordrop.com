import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseDatabaseEnvironment } from '@creatordrop/config';
import {
  createDatabasePool,
  type Database,
  type QueryExecutor,
  type TransactionExecutor,
} from '@creatordrop/database';
import {
  parseCurrency,
  parsePositiveMoneyMinor,
  toMoneyMinor,
  progressionForXp,
} from '@creatordrop/domain';
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
  BoxVersionId,
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
import { createEnvironmentFulfillmentActorBindingProvider } from '../src/modules/fulfillment/fulfillment.actor-binding.js';
import {
  buildFulfillmentAad,
  encryptFulfillmentValue,
} from '../src/modules/fulfillment/fulfillment.crypto.js';
import { createEnvironmentFulfillmentKeyProvider } from '../src/modules/fulfillment/fulfillment.key-provider.js';
import {
  createFulfillmentService,
  type FulfillmentService,
} from '../src/modules/fulfillment/fulfillment.service.js';
import type { ClientSeed, RngSeedSetId } from '../src/modules/fairness/fairness.js';
import { FairnessConfirmationStaleError } from '../src/modules/fairness/fairness.errors.js';
import {
  BoxNotOpenableError,
  OpeningConfirmationStaleError,
  OpeningEntitlementRequiredError,
  OpeningRetryableError,
} from '../src/modules/openings/opening.errors.js';
import {
  FulfillmentDataUnavailableError,
  FulfillmentKeyUnavailableError,
  FulfillmentNotFoundError,
  FulfillmentPermissionDeniedError,
  FulfillmentTransitionError,
  InventoryRestockError,
} from '../src/modules/fulfillment/fulfillment.errors.js';
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
import {
  IdempotencyKeyReusedError,
  LedgerTransactionNotReversibleError,
} from '../src/modules/wallet/wallet.errors.js';
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
const localMigrationUrl = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const localWorkerUrl =
  'postgresql://postgres:postgres@127.0.0.1:54322/postgres?options=-c%20role%3Dcreatordrop_worker';
const applicationEnvironment = parseDatabaseEnvironment({
  DATABASE_APPLICATION_NAME: 'creatordrop-opening-integration',
  DATABASE_CONNECTION_TIMEOUT_MS: '5000',
  DATABASE_IDLE_TIMEOUT_MS: '1000',
  DATABASE_POOL_MAX: '12',
  DATABASE_URL: process.env.DATABASE_URL ?? localApplicationUrl,
});
const logger: Logger = { error: () => undefined, info: () => undefined };
// Preserve the historical paid-opening invariant suite with an explicit, test-only opt-in.
const createLegacyOpeningService = (options: Parameters<typeof createOpeningService>[0]) =>
  createOpeningService({ ...options, allowLegacyPaidOpenings: true });
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
  readonly commitment: string;
  readonly id: UserId;
  readonly seedSetId: RngSeedSetId;
}

interface TestCatalog {
  readonly boxId: BoxId;
  readonly configurationHash: string;
  readonly boxVersionId: BoxVersionId;
  readonly rewardVersionId: RewardVersionId;
}

describe('atomic box opening', { concurrent: false }, () => {
  let catalog: CatalogService;
  let adminDatabase: Database;
  let database: Database;
  let blockerDatabase: Database;
  let fairness: FairnessService;
  let firstConcurrencyDatabase: Database;
  let fulfillments: FulfillmentService;
  let nextServerSeed: Uint8Array | undefined;
  let openings: OpeningService;
  let secondConcurrencyDatabase: Database;
  let wallets: WalletService;
  let workerDatabase: Database;

  beforeAll(() => {
    adminDatabase = createDatabasePool({
      ...applicationEnvironment,
      applicationName: 'creatordrop-opening-admin',
      connectionString: process.env.DATABASE_MIGRATION_URL ?? localMigrationUrl,
      maxConnections: 2,
      onUnexpectedPoolError: (error) => {
        throw error;
      },
    });
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
    workerDatabase = createDatabasePool({
      ...applicationEnvironment,
      applicationName: 'creatordrop-opening-worker',
      connectionString: process.env.WORKER_DATABASE_URL ?? localWorkerUrl,
      maxConnections: 4,
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
    openings = createLegacyOpeningService({ database, fairnessService: fairness, logger });
    fulfillments = createFulfillmentService({
      actorBindingProvider: createEnvironmentFulfillmentActorBindingProvider({
        keyHex: '33'.repeat(32),
        version: 'local-fulfillment-actor-v1',
      }),
      database,
      keyProvider: createEnvironmentFulfillmentKeyProvider({
        address: {
          historicalKeys: {},
          keyHex: '11'.repeat(32),
          version: 'local-fulfillment-address-v1',
        },
        digitalSecret: {
          historicalKeys: {},
          keyHex: '22'.repeat(32),
          version: 'local-digital-delivery-v1',
        },
      }),
      logger,
      retentionMs: null,
    });
  });

  afterAll(async () => {
    await Promise.all([
      blockerDatabase.close(),
      adminDatabase.close(),
      database.close(),
      firstConcurrencyDatabase.close(),
      secondConcurrencyDatabase.close(),
      workerDatabase.close(),
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
    const initialized = await fairness.initialize({ requestId: randomUUID(), userId: id });
    const configured = await fairness.updateClientSeed({
      clientSeed,
      expectedRevision: initialized.fairness.revision,
      expectedSeedSetId: initialized.fairness.activeSeedSet.id,
      expectedServerSeedCommitment: initialized.fairness.activeSeedSet.commitment,
      requestId: randomUUID(),
      userId: id,
    });
    await wallets.grantTestCredits({
      amountMinor: parsePositiveMoneyMinor(creditMinor),
      currency: usd,
      idempotencyKey: `credit_${randomUUID()}`,
      requestId: randomUUID(),
      userId: id,
    });
    return {
      clientSeed,
      commitment: configured.activeSeedSet.commitment,
      id,
      seedSetId: configured.activeSeedSet.id,
    };
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
      readonly rewardType?: 'digital' | 'experience' | 'physical' | 'xp';
      readonly xpAmount?: string;
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
        rewardType: input.rewardType ?? 'digital',
        ...(input.xpAmount === undefined ? {} : { xpAmount: input.xpAmount }),
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
      readonly rewardType?: 'digital' | 'experience' | 'physical' | 'xp';
      readonly xpAmount?: string;
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
    const published = await catalog.publishBox({
      actorUserId: ownerId,
      boxId: box.id,
      creatorId,
      expectedRevision: 2,
      requestId: randomUUID(),
    });
    return {
      boxId: box.id,
      boxVersionId: published.version.id,
      configurationHash: published.configurationHash,
      rewardVersionId,
    };
  };

  const createOpeningV2Box = async (
    creatorId: CreatorId,
    rewardVersionId: RewardVersionId,
    maxOpeningsPerUser = '10',
  ): Promise<TestCatalog> => {
    const ownerId = await creatorOwner(creatorId);
    const box = await catalog.createBox({
      actorUserId: ownerId,
      creatorId,
      ...parseBoxDraftInput({
        description: '',
        maxOpeningsPerUser,
        name: `Free Drop ${randomUUID()}`,
        openingCompatibilityVersion: 'opening-v2',
      }),
      requestId: randomUUID(),
    });
    await catalog.replaceDraftConfiguration({
      actorUserId: ownerId,
      boxId: box.id,
      creatorId,
      entries: [{ rewardVersionId, weight: 1n as ProbabilityWeight }],
      expectedRevision: 1,
      openingCompatibilityVersion: 'opening-v2',
      requestId: randomUUID(),
    });
    const published = await catalog.publishBox({
      actorUserId: ownerId,
      boxId: box.id,
      creatorId,
      expectedRevision: 2,
      requestId: randomUUID(),
    });
    return {
      boxId: box.id,
      boxVersionId: published.version.id,
      configurationHash: published.configurationHash,
      rewardVersionId,
    };
  };

  const republishOpeningV2Box = async (
    creatorId: CreatorId,
    box: TestCatalog,
    maxOpeningsPerUser = '10',
  ): Promise<TestCatalog> => {
    const ownerId = await creatorOwner(creatorId);
    const current = await catalog.getBox({ actorUserId: ownerId, creatorId }, box.boxId);
    await catalog.updateBox({
      actorUserId: ownerId,
      boxId: box.boxId,
      creatorId,
      ...parseBoxDraftInput({
        description: 'Republished opening-v2 integration fixture.',
        maxOpeningsPerUser,
        name: `Republished Free Drop ${randomUUID()}`,
        openingCompatibilityVersion: 'opening-v2',
      }),
      expectedRevision: current.revision,
      requestId: randomUUID(),
    });
    const updated = await catalog.getBox({ actorUserId: ownerId, creatorId }, box.boxId);
    const published = await catalog.publishBox({
      actorUserId: ownerId,
      boxId: box.boxId,
      creatorId,
      expectedRevision: updated.revision,
      requestId: randomUUID(),
    });
    return {
      boxId: box.boxId,
      boxVersionId: published.version.id,
      configurationHash: published.configurationHash,
      rewardVersionId: box.rewardVersionId,
    };
  };

  const grantOpeningEntitlement = async (
    userId: UserId,
    creatorId: CreatorId,
    boxId: BoxId,
    quantity: bigint,
    sourceIdentity = `r1b-${randomUUID()}`,
  ): Promise<string> => {
    const grantId = randomUUID();
    await adminDatabase.query(
      `select * from app_private.grant_opening_entitlement(
         $1, $2, $3, $4, $5, 'r1b_integration', $6, null, 'R1B opening test'
       )`,
      [grantId, userId, creatorId, boxId, quantity.toString(), sourceIdentity],
    );
    return grantId;
  };

  const holdOpeningV2Guard = async (userId: UserId, creatorId: CreatorId, boxId: BoxId) => {
    const started = createDeferred<number>();
    const release = createDeferred<undefined>();
    const done = adminDatabase
      .transaction(async (transaction) => {
        const pid = await readBackendPid(transaction);
        await transaction.query(`select app_private.lock_opening_v2_user_box_guard($1, $2, $3)`, [
          userId,
          creatorId,
          boxId,
        ]);
        started.resolve(pid);
        await release.promise;
        throw new Error('Release the R1B test barrier by rollback.');
      })
      .catch(() => undefined);
    return {
      blockerPid: await started.promise,
      done,
      release: () => release.resolve(undefined),
    };
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

  const openingExpectation = async (
    boxId: BoxId,
    user: TestUser,
  ): Promise<{
    readonly expectedBoxVersionId: BoxVersionId;
    readonly expectedConfigurationHash: string;
    readonly expectedSeedSetId: RngSeedSetId;
    readonly expectedServerSeedCommitment: string;
  }> => {
    const published = await catalog.getPublicBox(boxId);
    return {
      expectedBoxVersionId: published.version.id,
      expectedConfigurationHash: published.configurationHash,
      expectedSeedSetId: user.seedSetId,
      expectedServerSeedCommitment: user.commitment,
    };
  };

  const open = async (user: TestUser, boxId: BoxId, idempotencyKey = `open_${randomUUID()}`) =>
    openings.openBox({
      boxId,
      clientSeed: user.clientSeed,
      ...(await openingExpectation(boxId, user)),
      idempotencyKey,
      requestId: randomUUID(),
      userId: user.id,
    });

  const openWith = async (
    service: OpeningService,
    user: TestUser,
    boxId: BoxId,
    idempotencyKey = `open_${randomUUID()}`,
  ) =>
    service.openBox({
      boxId,
      clientSeed: user.clientSeed,
      ...(await openingExpectation(boxId, user)),
      idempotencyKey,
      requestId: randomUUID(),
      userId: user.id,
    });

  interface ClaimedEventRow {
    readonly attemptCount: number;
    readonly claimToken: string;
    readonly id: string;
  }

  const claimOutbox = async (
    workerId: string,
    batchSize = 100,
    leaseMs = 30_000,
    maxAttempts = 3,
    executor: QueryExecutor = workerDatabase,
  ): Promise<readonly ClaimedEventRow[]> =>
    (
      await executor.query<ClaimedEventRow>(
        `select id::text as id,
                attempt_count as "attemptCount",
                claim_token::text as "claimToken"
           from app.claim_outbox_events($1, $2, $3, $4)`,
        [workerId, batchSize, leaseMs, maxAttempts],
      )
    ).rows;

  const completeClaim = async (event: ClaimedEventRow): Promise<void> => {
    await workerDatabase.query(`select app.complete_outbox_event($1, $2)`, [
      event.id,
      event.claimToken,
    ]);
  };

  const drainOutbox = async (): Promise<void> => {
    for (;;) {
      const events = await claimOutbox('worker:test-drain');
      if (events.length === 0) return;
      await Promise.all(events.map(completeClaim));
    }
  };

  it('rejects new paid openings in the active service without mutating financial or opening state', async () => {
    const creatorId = await createCreator();
    const rewardVersionId = await createReward(creatorId, { mode: 'finite', quantity: '1' });
    const box = await createBox(creatorId, rewardVersionId);
    const user = await createUser('999');
    const poolId = await inventoryPoolForVersion(rewardVersionId);
    const activeOpenings = createOpeningService({ database, fairnessService: fairness, logger });
    const command = {
      boxId: box.boxId,
      clientSeed: user.clientSeed,
      ...(await openingExpectation(box.boxId, user)),
      idempotencyKey: `opening_${randomUUID()}`,
      requestId: randomUUID(),
      userId: user.id,
    };
    const state = () =>
      database.query(
        `select
         (select available_balance_minor::text from app.wallets where user_id = $1) as balance,
         (select available_quantity::text from app.inventory_pools where id = $2) as quantity,
         (select next_nonce::text from app.rng_seed_sets
            where user_id = $1 and status = 'active') as nonce,
         (select count(*)::text from app.idempotency_records
            where actor_user_id = $1 and operation = 'box.open') as idempotency,
         (select count(*)::text from app.box_opens where user_id = $1) as openings,
         (select count(*)::text from app.reward_wins where user_id = $1) as wins,
         (select count(*)::text from app.ledger_transactions
            where actor_user_id = $1) as ledger,
         (select count(*)::text from app.event_outbox
            where aggregate_id in (select id from app.box_opens where user_id = $1)) as events`,
        [user.id, poolId],
      );
    const before = await state();
    await expect(activeOpenings.openBox(command)).rejects.toBeInstanceOf(BoxNotOpenableError);
    await expect(activeOpenings.openBox(command)).rejects.toBeInstanceOf(BoxNotOpenableError);
    expect((await state()).rows).toEqual(before.rows);

    // Historical replay is still allowed after retirement, without a second debit or nonce.
    const historical = await openings.openBox(command);
    const afterHistorical = await state();
    expect(await activeOpenings.openBox(command)).toEqual({ ...historical, replayed: true });
    expect((await state()).rows).toEqual(afterHistorical.rows);
    await expect(
      activeOpenings.openBox({ ...command, clientSeed: 'ff'.repeat(32) as ClientSeed }),
    ).rejects.toBeInstanceOf(IdempotencyKeyReusedError);
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
    if ('openingCompatibilityVersion' in first.body.opening) {
      throw new Error('Expected a paid opening-v1 response.');
    }
    expect(first.body.opening.pointsAwarded).toBe(20);
    expect(first.body.opening.wallet.balanceMinor).toBe('0');
    const proof = await fairness.getOpeningProof(first.body.opening.id);
    expect(proof).toMatchObject({
      configurationHash: first.body.opening.fairness.configurationHash,
      nonce: first.body.opening.fairness.nonce,
      openingId: first.body.opening.id,
      recorded: { rewardVersionId },
      seedSetId: first.body.opening.fairness.seedSetId,
      verificationStatus: 'pending_reveal',
    });
    expect(proof).not.toHaveProperty('serverSeedHex');

    const persisted = await adminDatabase.query<{
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
    const changedFeeOpening = await createLegacyOpeningService({
      database,
      fairnessService: fairness,
      logger,
      platformFeeBps: 1000,
    }).openBox({
      boxId: box.boxId,
      clientSeed: changedFeeUser.clientSeed,
      ...(await openingExpectation(box.boxId, changedFeeUser)),
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
    await expect(
      database.transaction(async (transaction) => {
        await transaction.query(
          `create temporary table r1b_box_open_model_probe
             (like app.box_opens including defaults including constraints)
             on commit drop`,
        );
        await transaction.query(
          `insert into r1b_box_open_model_probe
           select * from app.box_opens where id = $1`,
          [internalOpeningId],
        );
        await transaction.query(
          `update r1b_box_open_model_probe
              set points_policy_version = null,
                  base_points = null,
                  bonus_points = null,
                  points_awarded = null`,
        );
      }),
    ).rejects.toMatchObject({ constraint: 'box_opens_model_shape' });
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
        ...(await openingExpectation(box.boxId, user)),
        idempotencyKey: key,
        requestId: randomUUID(),
        userId: user.id,
      }),
    ).rejects.toMatchObject({ name: 'IdempotencyKeyReusedError' });
  });

  const xpBox = async (creatorId: CreatorId, amount: string, limit = '20') =>
    createOpeningV2Box(
      creatorId,
      await createReward(creatorId, { mode: 'unlimited', rewardType: 'xp', xpAmount: amount }),
      limit,
    );

  const holdProgression = async (userId: UserId) => {
    const started = createDeferred<number>();
    const release = createDeferred<undefined>();
    const done = adminDatabase.transaction(async (transaction) => {
      await transaction.query('select app_private.lock_progression($1)', [userId]);
      started.resolve(await readBackendPid(transaction));
      await release.promise;
    });
    return { blockerPid: await started.promise, done, release: () => release.resolve(undefined) };
  };

  it('R3 database levels agree with integer domain math through signed-64 XP limits', async () => {
    for (const xp of [
      0n,
      99n,
      100n,
      299n,
      300n,
      599n,
      600n,
      1000n,
      1500n,
      9_223_372_036_854_775_807n,
    ]) {
      const result = await adminDatabase.query<{ level: string }>(
        'select app_private.level_for_xp($1)::text as level',
        [xp.toString()],
      );
      expect(result.rows[0]?.level).toBe(progressionForXp(xp).level.toString());
    }
  });

  it('R3 rejects raw opening inserts that arrive in reverse global lock order', async () => {
    const creatorId = await createCreator();
    const user = await createUser('1');
    const box = await xpBox(creatorId, '100');
    await grantOpeningEntitlement(user.id, creatorId, box.boxId, 1n);
    const opened = await open(user, box.boxId);
    const barrier = await holdProgression(user.id);
    try {
      await expect(
        database.transaction(async (transaction) => {
          await transaction.query("set local statement_timeout='2000ms'");
          await transaction.query(
            'select 1 from app.fairness_profiles where user_id=$1 for update',
            [user.id],
          );
          await transaction.query(
            'insert into app.box_opens select * from app.box_opens where public_id=$1',
            [opened.body.opening.id],
          );
        }),
      ).rejects.toMatchObject({ code: '40001', constraint: 'progression_lock_order' });
    } finally {
      barrier.release();
      await barrier.done;
    }
    expect((await openings.getProgression(user.id)).progression).toMatchObject({
      lifetimeXp: '100',
      universalEntriesEarned: '1',
    });
  });

  it('R3 starts at zero independently of legacy points and protects all progression writes', async () => {
    const user = await createUser('9999');
    const creatorId = await createCreator();
    await open(
      user,
      (await createBox(creatorId, await createReward(creatorId, { mode: 'unlimited' }))).boxId,
    );
    expect(await openings.getProgression(user.id)).toEqual({
      progression: {
        lifetimeXp: '0',
        level: '1',
        xpInLevel: '0',
        xpForNextLevel: '100',
        universalEntriesAvailable: '0',
        universalEntriesEarned: '0',
      },
    });
    for (const table of [
      'progression_accounts',
      'xp_awards',
      'universal_entry_grants',
      'universal_entry_consumptions',
    ]) {
      // Fixed infrastructure allowlist, never application input.
      await expect(database.query(`select * from app_private.${table}`)).rejects.toMatchObject({
        code: '42501',
      });
    }
    await expect(
      database.query('select app_private.lock_progression($1)', [user.id]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      database.query(
        'update app_private.progression_accounts set lifetime_xp=100 where user_id=$1',
        [user.id],
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await adminDatabase.query("update app.users set status='suspended' where id=$1", [user.id]);
    expect(
      (
        await database.query<{ state: unknown }>('select app.read_progression($1) as state', [
          user.id,
        ])
      ).rows[0]?.state,
    ).toBeNull();
  });

  it('R3 commits +250 XP and its level entry once, without points or fake fulfillment', async () => {
    const creatorId = await createCreator();
    const user = await createUser('1');
    const box = await xpBox(creatorId, '250');
    await grantOpeningEntitlement(user.id, creatorId, box.boxId, 1n);
    const key = `r3_${randomUUID()}`;
    const result = await open(user, box.boxId, key);
    expect(result.body.opening).toMatchObject({
      fulfillmentStatus: 'not_required',
      reward: { xpReward: { amount: '250', policyVersion: 'xp-v1' } },
      progression: {
        lifetimeXp: '250',
        level: '2',
        xpInLevel: '150',
        xpForNextLevel: '200',
        xpAwarded: '250',
        levelsGained: '1',
        universalEntriesGranted: '1',
        universalEntriesAvailable: '1',
      },
      entitlement: { source: 'creator', remaining: '0', universalEntriesRemaining: '1' },
    });
    expect((await open(user, box.boxId, key)).body).toEqual(result.body);
    const proof = await fairness.getOpeningProof(result.body.opening.id);
    expect(proof.manifest.entries[0]).toMatchObject({
      xpReward: { amount: '250', policyVersion: 'xp-v1' },
    });
    const persisted = await adminDatabase.query(
      `select
      (select count(*)::text from app_private.xp_awards where user_id=$1) as awards,
      (select count(*)::text from app_private.universal_entry_grants where user_id=$1) as grants,
      (select count(*)::text from app.fulfillment_obligations f join app.box_opens o on o.id=f.opening_id where o.user_id=$1) as obligations,
      (select count(*)::text from app.box_opens where user_id=$1 and points_awarded is not null) as points,
      (select count(*)::text from app.leaderboard_projection_events p join app.event_outbox e on e.id=p.outbox_event_id join app.box_opens o on o.id=e.aggregate_id where o.user_id=$1) as rankings`,
      [user.id],
    );
    expect(persisted.rows).toEqual([
      { awards: '1', grants: '1', obligations: '0', points: '0', rankings: '0' },
    ]);
    await expect(
      adminDatabase.query(
        `insert into app_private.universal_entry_grants(user_id,source_level,source_opening_id)
      select user_id,source_level,source_opening_id from app_private.universal_entry_grants where user_id=$1`,
        [user.id],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('R3 crosses every threshold for 290 + 350 XP, preserving original replay snapshots', async () => {
    const creatorId = await createCreator();
    const user = await createUser('1');
    const first = await xpBox(creatorId, '290');
    const second = await xpBox(creatorId, '350');
    await grantOpeningEntitlement(user.id, creatorId, first.boxId, 1n);
    await grantOpeningEntitlement(user.id, creatorId, second.boxId, 1n);
    const key = `r3_${randomUUID()}`;
    const original = await open(user, first.boxId, key);
    expect((await open(user, second.boxId)).body.opening).toMatchObject({
      progression: {
        lifetimeXp: '640',
        level: '4',
        levelsGained: '2',
        universalEntriesGranted: '2',
        universalEntriesAvailable: '3',
      },
    });
    expect((await open(user, first.boxId, key)).body).toEqual(original.body);
    expect(
      (
        await adminDatabase.query(
          'select source_level::text as level from app_private.universal_entry_grants where user_id=$1 order by source_level',
          [user.id],
        )
      ).rows,
    ).toEqual([{ level: '2' }, { level: '3' }, { level: '4' }]);
  });

  it.each([
    { initial: '0', amount: '100', total: '200' },
    { initial: '90', amount: '20', total: '130' },
  ])(
    'R3 serializes global concurrent XP awards: $initial + 2 × $amount',
    async ({ initial, amount, total }) => {
      const creatorId = await createCreator();
      const otherCreator = await createCreator();
      const user = await createUser('1');
      if (initial !== '0') {
        const initialBox = await xpBox(creatorId, initial);
        await grantOpeningEntitlement(user.id, creatorId, initialBox.boxId, 1n);
        await open(user, initialBox.boxId);
      }
      const firstBox = await xpBox(creatorId, amount);
      const secondBox = await xpBox(otherCreator, amount);
      await grantOpeningEntitlement(user.id, creatorId, firstBox.boxId, 1n);
      await grantOpeningEntitlement(user.id, otherCreator, secondBox.boxId, 1n);
      const firstService = createOpeningService({
        database: firstConcurrencyDatabase,
        fairnessService: fairness,
        logger,
      });
      const secondService = createOpeningService({
        database: secondConcurrencyDatabase,
        fairnessService: fairness,
        logger,
      });
      const firstPid = await readBackendPid(firstConcurrencyDatabase);
      const secondPid = await readBackendPid(secondConcurrencyDatabase);
      const barrier = await holdProgression(user.id);
      const first = trackSettlement(openWith(firstService, user, firstBox.boxId));
      const second = trackSettlement(openWith(secondService, user, secondBox.boxId));
      try {
        expect(await observeBlocking(database, firstPid, barrier.blockerPid, first)).toBe(
          'blocked',
        );
        expect(await observeBlocking(database, secondPid, barrier.blockerPid, second)).toBe(
          'blocked',
        );
      } finally {
        barrier.release();
        await barrier.done;
      }
      expect(await Promise.all([first, second])).toEqual([
        { status: 'fulfilled' },
        { status: 'fulfilled' },
      ]);
      expect(await openings.getProgression(user.id)).toMatchObject({
        progression: {
          lifetimeXp: total,
          level: '2',
          universalEntriesEarned: '1',
          universalEntriesAvailable: '1',
        },
      });
    },
  );

  it('R3 prefers creator entries, then consumes a Universal Entry on another creator, with caps intact', async () => {
    const creatorId = await createCreator();
    const otherCreator = await createCreator();
    const user = await createUser('1');
    const earned = await xpBox(creatorId, '250');
    await grantOpeningEntitlement(user.id, creatorId, earned.boxId, 1n);
    await open(user, earned.boxId);
    const box = await createOpeningV2Box(
      otherCreator,
      await createReward(otherCreator, { mode: 'unlimited' }),
      '2',
    );
    await grantOpeningEntitlement(user.id, otherCreator, box.boxId, 1n);
    expect((await open(user, box.boxId)).body.opening).toMatchObject({
      entitlement: { source: 'creator', universalEntriesRemaining: '1' },
    });
    expect(await openings.getEntitlementState({ userId: user.id, boxId: box.boxId })).toMatchObject(
      {
        entitlement: {
          remaining: '0',
          source: 'universal',
          available: true,
          universalEntriesAvailable: '1',
        },
      },
    );
    const key = `r3_${randomUUID()}`;
    const result = await open(user, box.boxId, key);
    expect(result.body.opening).toMatchObject({
      entitlement: { source: 'universal', universalEntriesRemaining: '0' },
      fulfillmentStatus: 'pending_fulfillment',
    });
    expect((await open(user, box.boxId, key)).body).toEqual(result.body);
    await grantOpeningEntitlement(user.id, creatorId, earned.boxId, 1n);
    await open(user, earned.boxId);
    expect((await openings.getProgression(user.id)).progression.universalEntriesAvailable).toBe(
      '1',
    );
    await expect(open(user, box.boxId)).rejects.toMatchObject({ name: 'OpeningLimitReachedError' });
    expect((await openings.getProgression(user.id)).progression.universalEntriesAvailable).toBe(
      '1',
    );
    const stranger = await createUser('1');
    await expect(open(stranger, box.boxId)).rejects.toBeInstanceOf(OpeningEntitlementRequiredError);
  });

  it('R3 cannot double spend one Universal Entry on concurrent different Drops', async () => {
    const creatorId = await createCreator();
    const user = await createUser('1');
    const earned = await xpBox(creatorId, '100');
    await grantOpeningEntitlement(user.id, creatorId, earned.boxId, 1n);
    await open(user, earned.boxId);
    const firstBox = await createOpeningV2Box(
      creatorId,
      await createReward(creatorId, { mode: 'unlimited' }),
    );
    const otherCreator = await createCreator();
    const secondBox = await createOpeningV2Box(
      otherCreator,
      await createReward(otherCreator, { mode: 'unlimited' }),
    );
    const firstService = createOpeningService({
      database: firstConcurrencyDatabase,
      fairnessService: fairness,
      logger,
    });
    const secondService = createOpeningService({
      database: secondConcurrencyDatabase,
      fairnessService: fairness,
      logger,
    });
    const firstPid = await readBackendPid(firstConcurrencyDatabase);
    const secondPid = await readBackendPid(secondConcurrencyDatabase);
    const barrier = await holdProgression(user.id);
    const first = trackSettlement(openWith(firstService, user, firstBox.boxId));
    const second = trackSettlement(openWith(secondService, user, secondBox.boxId));
    try {
      expect(await observeBlocking(database, firstPid, barrier.blockerPid, first)).toBe('blocked');
      expect(await observeBlocking(database, secondPid, barrier.blockerPid, second)).toBe(
        'blocked',
      );
    } finally {
      barrier.release();
      await barrier.done;
    }
    const results = await Promise.all([first, second]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { name: 'OpeningEntitlementRequiredError' },
    });
    expect(
      (
        await adminDatabase.query(
          'select count(*)::text as count from app_private.universal_entry_consumptions where user_id=$1',
          [user.id],
        )
      ).rows,
    ).toEqual([{ count: '1' }]);
    expect(
      (
        await database.query(
          'select next_nonce::text as nonce from app.rng_seed_sets where id=$1',
          [user.seedSetId],
        )
      ).rows,
    ).toEqual([{ nonce: '2' }]);
  });

  it('R3 rolls back XP, level grants, entry use and nonce on failure after XP insertion', async () => {
    const creatorId = await createCreator();
    const user = await createUser('1');
    const box = await xpBox(creatorId, '250');
    await grantOpeningEntitlement(user.id, creatorId, box.boxId, 1n);
    // Private/public outbox IDs collide after the opening-trigger has awarded XP.
    const duplicateId = randomUUID();
    const failing = createOpeningService({
      database,
      fairnessService: fairness,
      logger,
      createId: () => duplicateId,
    });
    await expect(openWith(failing, user, box.boxId)).rejects.toMatchObject({ code: '23505' });
    expect((await openings.getProgression(user.id)).progression).toMatchObject({
      lifetimeXp: '0',
      universalEntriesEarned: '0',
      universalEntriesAvailable: '0',
    });
    expect(
      (await openings.getEntitlementState({ userId: user.id, boxId: box.boxId })).entitlement,
    ).toMatchObject({ remaining: '1', successfulOpenings: '0' });
    expect(
      (
        await database.query(
          'select next_nonce::text as nonce from app.rng_seed_sets where id=$1',
          [user.seedSetId],
        )
      ).rows,
    ).toEqual([{ nonce: '0' }]);
  });

  it('R3 preserves Universal Entries when a Drop or its creator is unavailable', async () => {
    const creatorId = await createCreator();
    const user = await createUser('1');
    const earned = await xpBox(creatorId, '100');
    await grantOpeningEntitlement(user.id, creatorId, earned.boxId, 1n);
    await open(user, earned.boxId);
    const otherCreator = await createCreator();
    const reward = await createReward(otherCreator, { mode: 'finite', quantity: '1' });
    const target = await createOpeningV2Box(otherCreator, reward);
    const expectation = await openingExpectation(target.boxId, user);
    // Keep the fan's confirmed snapshot so failures exercise opening authorization,
    // rather than the public catalog hiding a now-unavailable Drop first.
    const attemptOpening = () =>
      openings.openBox({
        boxId: target.boxId,
        clientSeed: user.clientSeed,
        ...expectation,
        idempotencyKey: `r3_unavailable_${randomUUID()}`,
        requestId: randomUUID(),
        userId: user.id,
      });
    for (const status of ['paused', 'archived'] as const) {
      await adminDatabase.query('update app.boxes set status=$2 where id=$1', [
        target.boxId,
        status,
      ]);
      await expect(attemptOpening()).rejects.toBeInstanceOf(BoxNotOpenableError);
    }
    await adminDatabase.query("update app.boxes set status='active' where id=$1", [target.boxId]);
    await adminDatabase.query("update app.creators set status='suspended' where id=$1", [
      otherCreator,
    ]);
    await expect(attemptOpening()).rejects.toBeInstanceOf(BoxNotOpenableError);
    await expect(
      openings.getEntitlementState({ userId: user.id, boxId: target.boxId }),
    ).rejects.toBeInstanceOf(BoxNotOpenableError);
    await adminDatabase.query("update app.creators set status='active' where id=$1", [
      otherCreator,
    ]);
    const exhaustedBy = await createUser('1');
    await grantOpeningEntitlement(exhaustedBy.id, otherCreator, target.boxId, 1n);
    await open(exhaustedBy, target.boxId);
    await expect(attemptOpening()).rejects.toBeInstanceOf(BoxNotOpenableError);
    expect((await openings.getProgression(user.id)).progression.universalEntriesAvailable).toBe(
      '1',
    );
    expect(
      (
        await database.query(
          'select next_nonce::text as nonce from app.rng_seed_sets where id=$1',
          [user.seedSetId],
        )
      ).rows,
    ).toEqual([{ nonce: '1' }]);
  });

  it('R3 rejects out-of-policy XP, paid XP publication and immutable XP edits in PostgreSQL', async () => {
    const creatorId = await createCreator();
    const record = await createRewardRecord(creatorId, {
      mode: 'unlimited',
      rewardType: 'xp',
      xpAmount: '50',
    });
    await expect(
      database.query('update app.reward_versions set xp_amount=1000000 where id=$1', [
        record.versionId,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(createBox(creatorId, record.versionId)).rejects.toBeDefined();
    const box = await createOpeningV2Box(creatorId, record.versionId);
    await expect(
      database.query('update app.reward_versions set xp_amount=100 where id=$1', [
        record.versionId,
      ]),
    ).rejects.toBeDefined();
    expect((await catalog.getPublicBox(box.boxId)).manifest.entries[0]).toMatchObject({
      xpReward: { amount: '50', policyVersion: 'xp-v1' },
    });
  });

  it('opens opening-v2 atomically with one entitlement and no financial or leaderboard effect', async () => {
    const creatorId = await createCreator();
    const rewardVersionId = await createReward(creatorId, { mode: 'unlimited' });
    const box = await createOpeningV2Box(creatorId, rewardVersionId, '3');
    const user = await createUser('1');
    await grantOpeningEntitlement(user.id, creatorId, box.boxId, 2n);

    const beforeWallet = await database.query<{
      readonly balance: string;
      readonly revision: string;
    }>(
      `select available_balance_minor::text as balance, revision::text
         from app.wallets where user_id = $1 and currency = 'USD'`,
      [user.id],
    );
    const result = await createOpeningService({
      database,
      fairnessService: fairness,
      logger,
    }).openBox({
      boxId: box.boxId,
      clientSeed: user.clientSeed,
      ...(await openingExpectation(box.boxId, user)),
      idempotencyKey: `opening_${randomUUID()}`,
      requestId: randomUUID(),
      userId: user.id,
    });
    expect(result.replayed).toBe(false);
    if (!('openingCompatibilityVersion' in result.body.opening)) {
      throw new Error('Expected an opening-v2 response.');
    }
    expect(result.body.opening).toMatchObject({
      boxId: box.boxId,
      boxVersionId: box.boxVersionId,
      entitlement: { maxOpeningsPerUser: '3', remaining: '1', successfulOpenings: '1' },
      openingCompatibilityVersion: 'opening-v2',
      reward: { rewardVersionId },
    });
    expect(result.body.opening).not.toHaveProperty('cost');
    expect(result.body.opening).not.toHaveProperty('pointsAwarded');
    expect(result.body.opening).not.toHaveProperty('wallet');

    const proof = await fairness.getOpeningProof(result.body.opening.id);
    expect(proof.manifest).toMatchObject({
      boxVersionId: box.boxVersionId,
      maxOpeningsPerUser: '3',
      openingCompatibilityVersion: 'opening-v2',
    });
    const persisted = await adminDatabase.query<{
      readonly consumptionCount: string;
      readonly earningCount: string;
      readonly financialColumnsNull: boolean;
      readonly ledgerCount: string;
      readonly model: string;
      readonly outboxCount: string;
      readonly pointsColumnsNull: boolean;
      readonly projectionCount: string;
    }>(
      `select opening.opening_compatibility_version as model,
              num_nonnulls(opening.gross_price_minor, opening.currency,
                opening.platform_fee_bps, opening.platform_fee_minor,
                opening.creator_share_minor, opening.earnings_available_at,
                opening.sale_ledger_transaction_id,
                opening.allocation_ledger_transaction_id) = 0 as "financialColumnsNull",
              num_nonnulls(opening.points_policy_version, opening.base_points,
                opening.bonus_points, opening.points_awarded) = 0 as "pointsColumnsNull",
              (select count(*)::text from app.opening_entitlement_consumptions c
                where c.opening_id = opening.id) as "consumptionCount",
              (select count(*)::text from app.creator_earnings e
                where e.opening_id = opening.id) as "earningCount",
              (select count(*)::text from app.ledger_transactions l
                where l.business_reference_id = opening.id) as "ledgerCount",
              (select count(*)::text from app.event_outbox e
                where e.aggregate_id = opening.id) as "outboxCount",
              (select count(*)::text from app.leaderboard_projection_events p
                join app.event_outbox e on e.id = p.outbox_event_id
                where e.aggregate_id = opening.id) as "projectionCount"
         from app.box_opens as opening where opening.public_id = $1`,
      [result.body.opening.id],
    );
    expect(persisted.rows).toEqual([
      {
        consumptionCount: '1',
        earningCount: '0',
        financialColumnsNull: true,
        ledgerCount: '0',
        model: 'opening-v2',
        outboxCount: '2',
        pointsColumnsNull: true,
        projectionCount: '0',
      },
    ]);
    expect(
      await database.query(
        `select available_balance_minor::text as balance, revision::text
           from app.wallets where user_id = $1 and currency = 'USD'`,
        [user.id],
      ),
    ).toMatchObject({ rows: beforeWallet.rows });
  });

  it('fails opening-v2 without an entitlement before nonce, history, inventory, or idempotency', async () => {
    const creatorId = await createCreator();
    const rewardVersionId = await createReward(creatorId, { mode: 'finite', quantity: '2' });
    const box = await createOpeningV2Box(creatorId, rewardVersionId);
    const user = await createUser('1');

    await expect(open(user, box.boxId)).rejects.toBeInstanceOf(OpeningEntitlementRequiredError);
    const state = await adminDatabase.query<{
      readonly claims: string;
      readonly consumptions: string;
      readonly inventory: string;
      readonly nonce: string;
      readonly openings: string;
    }>(
      `select
        (select count(*)::text from app.idempotency_records
          where actor_user_id = $1 and operation = 'box.open') as claims,
        (select count(*)::text from app.opening_entitlement_consumptions
          where user_id = $1 and box_id = $2) as consumptions,
        (select count(*)::text from app.box_opens where user_id = $1 and box_id = $2) as openings,
        (select next_nonce::text from app.rng_seed_sets where id = $3) as nonce,
        (select available_quantity::text from app.inventory_pools
          where id = (select inventory_pool_id from app.reward_versions where id = $4)) as inventory`,
      [user.id, box.boxId, user.seedSetId, rewardVersionId],
    );
    expect(state.rows).toEqual([
      { claims: '0', consumptions: '0', inventory: '2', nonce: '0', openings: '0' },
    ]);
  });

  it('does not consume entitlements belonging to another user or stable box', async () => {
    const creatorId = await createCreator();
    const rewardVersionId = await createReward(creatorId, { mode: 'unlimited' });
    const box = await createOpeningV2Box(creatorId, rewardVersionId);
    const otherBox = await createOpeningV2Box(creatorId, rewardVersionId);
    const user = await createUser('1');
    const otherUser = await createUser('1');
    await grantOpeningEntitlement(user.id, creatorId, otherBox.boxId, 1n);
    await grantOpeningEntitlement(otherUser.id, creatorId, box.boxId, 1n);

    await expect(open(user, box.boxId)).rejects.toBeInstanceOf(OpeningEntitlementRequiredError);
    const state = await adminDatabase.query<{
      readonly consumptions: string;
      readonly nonce: string;
      readonly openings: string;
    }>(
      `select
         (select count(*)::text from app.opening_entitlement_consumptions
           where user_id = $1 and box_id = $2) as consumptions,
         (select next_nonce::text from app.rng_seed_sets where id = $3) as nonce,
         (select count(*)::text from app.box_opens
           where user_id = $1 and box_id = $2) as openings`,
      [user.id, box.boxId, user.seedSetId],
    );
    expect(state.rows).toEqual([{ consumptions: '0', nonce: '0', openings: '0' }]);
  });

  it('retains stable-box entitlements across publication and rejects the stale version first', async () => {
    const creatorId = await createCreator();
    const rewardVersionId = await createReward(creatorId, { mode: 'unlimited' });
    const original = await createOpeningV2Box(creatorId, rewardVersionId, '2');
    const user = await createUser('1');
    await grantOpeningEntitlement(user.id, creatorId, original.boxId, 1n);
    const staleExpectation = await openingExpectation(original.boxId, user);
    const replacement = await republishOpeningV2Box(creatorId, original, '2');
    expect(replacement.boxVersionId).not.toBe(original.boxVersionId);

    await expect(
      openings.openBox({
        boxId: original.boxId,
        clientSeed: user.clientSeed,
        ...staleExpectation,
        idempotencyKey: `open_${randomUUID()}`,
        requestId: randomUUID(),
        userId: user.id,
      }),
    ).rejects.toBeInstanceOf(OpeningConfirmationStaleError);
    expect(
      (
        await adminDatabase.query<{
          readonly claims: string;
          readonly consumptions: string;
          readonly nonce: string;
        }>(
          `select
             (select count(*)::text from app.idempotency_records
               where actor_user_id = $1 and operation = 'box.open') as claims,
             (select count(*)::text from app.opening_entitlement_consumptions
               where user_id = $1 and box_id = $2) as consumptions,
             (select next_nonce::text from app.rng_seed_sets where id = $3) as nonce`,
          [user.id, original.boxId, user.seedSetId],
        )
      ).rows,
    ).toEqual([{ claims: '0', consumptions: '0', nonce: '0' }]);

    const opened = await open(user, original.boxId);
    expect(opened.body.opening).toMatchObject({ boxVersionId: replacement.boxVersionId });
    expect(
      (
        await adminDatabase.query<{ readonly consumptions: string }>(
          `select count(*)::text as consumptions
             from app.opening_entitlement_consumptions
            where user_id = $1 and box_id = $2`,
          [user.id, original.boxId],
        )
      ).rows,
    ).toEqual([{ consumptions: '1' }]);
  });

  it('rolls back opening-v2 entitlement state when the confirmed fairness seed is stale', async () => {
    const creatorId = await createCreator();
    const rewardVersionId = await createReward(creatorId, { mode: 'unlimited' });
    const box = await createOpeningV2Box(creatorId, rewardVersionId);
    const user = await createUser('1');
    await grantOpeningEntitlement(user.id, creatorId, box.boxId, 1n);
    const staleExpectation = await openingExpectation(box.boxId, user);
    nextServerSeed = randomBytes(32);
    const rotated = await fairness.rotate({
      idempotencyKey: `rotate_${randomUUID()}`,
      requestId: randomUUID(),
      userId: user.id,
    });

    await expect(
      openings.openBox({
        boxId: box.boxId,
        clientSeed: user.clientSeed,
        ...staleExpectation,
        idempotencyKey: `open_${randomUUID()}`,
        requestId: randomUUID(),
        userId: user.id,
      }),
    ).rejects.toBeInstanceOf(FairnessConfirmationStaleError);
    const state = await adminDatabase.query<{
      readonly claims: string;
      readonly consumptions: string;
      readonly nonce: string;
      readonly openings: string;
    }>(
      `select
         (select count(*)::text from app.idempotency_records
           where actor_user_id = $1 and operation = 'box.open') as claims,
         (select count(*)::text from app.opening_entitlement_consumptions
           where user_id = $1 and box_id = $2) as consumptions,
         (select next_nonce::text from app.rng_seed_sets where id = $3) as nonce,
         (select count(*)::text from app.box_opens
           where user_id = $1 and box_id = $2) as openings`,
      [user.id, box.boxId, rotated.newSeedSet.id],
    );
    expect(state.rows).toEqual([{ claims: '0', consumptions: '0', nonce: '0', openings: '0' }]);
  });

  it('enforces the stable-box max before consuming a second entitlement or nonce', async () => {
    const creatorId = await createCreator();
    const rewardVersionId = await createReward(creatorId, { mode: 'unlimited' });
    const box = await createOpeningV2Box(creatorId, rewardVersionId, '1');
    const user = await createUser('1');
    await grantOpeningEntitlement(user.id, creatorId, box.boxId, 2n);

    const firstService = createLegacyOpeningService({
      database: firstConcurrencyDatabase,
      fairnessService: fairness,
      logger,
    });
    const secondService = createLegacyOpeningService({
      database: secondConcurrencyDatabase,
      fairnessService: fairness,
      logger,
    });
    const firstPid = await readBackendPid(firstConcurrencyDatabase);
    const secondPid = await readBackendPid(secondConcurrencyDatabase);
    const barrier = await holdOpeningV2Guard(user.id, creatorId, box.boxId);
    const first = trackSettlement(openWith(firstService, user, box.boxId));
    const second = trackSettlement(openWith(secondService, user, box.boxId));
    expect(await observeBlocking(database, firstPid, barrier.blockerPid, first)).toBe('blocked');
    expect(await observeBlocking(database, secondPid, barrier.blockerPid, second)).toBe('blocked');
    barrier.release();
    await barrier.done;
    const results = await Promise.all([first, second]);
    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(results.find(({ status }) => status === 'rejected')).toMatchObject({
      reason: { name: 'OpeningLimitReachedError' },
    });
    expect(
      (await openings.getEntitlementState({ boxId: box.boxId, userId: user.id })).entitlement,
    ).toMatchObject({
      available: false,
      consumed: '1',
      granted: '2',
      limitReached: true,
      remaining: '1',
      successfulOpenings: '1',
    });
    expect(
      (
        await database.query<{ readonly nonce: string }>(
          `select next_nonce::text as nonce from app.rng_seed_sets where id = $1`,
          [user.seedSetId],
        )
      ).rows,
    ).toEqual([{ nonce: '1' }]);
  });

  it('serializes two opening-v2 commands on one entitlement and preserves deterministic grant order', async () => {
    const creatorId = await createCreator();
    const rewardVersionId = await createReward(creatorId, { mode: 'unlimited' });
    const box = await createOpeningV2Box(creatorId, rewardVersionId, '3');
    const user = await createUser('1');
    const firstGrantId = await grantOpeningEntitlement(user.id, creatorId, box.boxId, 1n);

    const firstService = createLegacyOpeningService({
      database: firstConcurrencyDatabase,
      fairnessService: fairness,
      logger,
    });
    const secondService = createLegacyOpeningService({
      database: secondConcurrencyDatabase,
      fairnessService: fairness,
      logger,
    });
    const firstPid = await readBackendPid(firstConcurrencyDatabase);
    const secondPid = await readBackendPid(secondConcurrencyDatabase);
    const blockerStarted = createDeferred<number>();
    const releaseBlocker = createDeferred<undefined>();
    const blocker = adminDatabase
      .transaction(async (transaction) => {
        const pid = await readBackendPid(transaction);
        await transaction.query(`select app_private.lock_opening_v2_user_box_guard($1, $2, $3)`, [
          user.id,
          creatorId,
          box.boxId,
        ]);
        blockerStarted.resolve(pid);
        await releaseBlocker.promise;
        throw new Error('Release the R1B test barrier by rollback.');
      })
      .catch(() => undefined);
    const blockerPid = await blockerStarted.promise;
    const firstSettlement = trackSettlement(openWith(firstService, user, box.boxId));
    const secondSettlement = trackSettlement(openWith(secondService, user, box.boxId));
    expect(await observeBlocking(database, firstPid, blockerPid, firstSettlement)).toBe('blocked');
    expect(await observeBlocking(database, secondPid, blockerPid, secondSettlement)).toBe(
      'blocked',
    );
    releaseBlocker.resolve(undefined);
    await blocker;
    const outcomes = await Promise.all([firstSettlement, secondSettlement]);
    expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    expect(outcomes.find(({ status }) => status === 'rejected')).toMatchObject({
      reason: { name: 'OpeningEntitlementRequiredError' },
    });
    expect(
      (
        await adminDatabase.query<{ readonly grantId: string }>(
          `select grant_id::text as "grantId" from app.opening_entitlement_consumptions
            where user_id = $1 and box_id = $2`,
          [user.id, box.boxId],
        )
      ).rows,
    ).toEqual([{ grantId: firstGrantId }]);

    const secondGrantId = await grantOpeningEntitlement(user.id, creatorId, box.boxId, 1n);
    const thirdGrantId = await grantOpeningEntitlement(user.id, creatorId, box.boxId, 1n);
    const secondBarrier = await holdOpeningV2Guard(user.id, creatorId, box.boxId);
    const nextFirst = trackSettlement(openWith(firstService, user, box.boxId));
    const nextSecond = trackSettlement(openWith(secondService, user, box.boxId));
    expect(await observeBlocking(database, firstPid, secondBarrier.blockerPid, nextFirst)).toBe(
      'blocked',
    );
    expect(await observeBlocking(database, secondPid, secondBarrier.blockerPid, nextSecond)).toBe(
      'blocked',
    );
    secondBarrier.release();
    await secondBarrier.done;
    const remainingOutcomes = await Promise.all([nextFirst, nextSecond]);
    expect(remainingOutcomes.every(({ status }) => status === 'fulfilled')).toBe(true);
    const consumedGrantIds = (
      await adminDatabase.query<{ readonly grantId: string }>(
        `select grant_id::text as "grantId" from app.opening_entitlement_consumptions
          where user_id = $1 and box_id = $2 order by created_at, id`,
        [user.id, box.boxId],
      )
    ).rows.map(({ grantId }) => grantId);
    expect(consumedGrantIds).toEqual([firstGrantId, secondGrantId, thirdGrantId]);
  });

  it('serializes concurrent opening-v2 idempotent retries into one consumption and replay', async () => {
    const creatorId = await createCreator();
    const rewardVersionId = await createReward(creatorId, { mode: 'unlimited' });
    const box = await createOpeningV2Box(creatorId, rewardVersionId, '2');
    const user = await createUser('1');
    await grantOpeningEntitlement(user.id, creatorId, box.boxId, 2n);
    const key = `opening_${randomUUID()}`;
    const service = createLegacyOpeningService({ database, fairnessService: fairness, logger });

    const results = await Promise.all([
      openWith(service, user, box.boxId, key),
      openWith(service, user, box.boxId, key),
    ]);
    expect(results.filter(({ replayed }) => replayed)).toHaveLength(1);
    expect(results[0].body).toEqual(results[1].body);
    const counts = await adminDatabase.query<{
      readonly consumptions: string;
      readonly nonce: string;
      readonly openings: string;
      readonly outbox: string;
    }>(
      `select
        (select count(*)::text from app.opening_entitlement_consumptions
          where user_id = $1 and box_id = $2) as consumptions,
        (select count(*)::text from app.box_opens where user_id = $1 and box_id = $2) as openings,
        (select next_nonce::text from app.rng_seed_sets where id = $3) as nonce,
        (select count(*)::text from app.event_outbox where aggregate_id in (
          select id from app.box_opens where user_id = $1 and box_id = $2
        )) as outbox`,
      [user.id, box.boxId, user.seedSetId],
    );
    expect(counts.rows).toEqual([{ consumptions: '1', nonce: '1', openings: '1', outbox: '2' }]);
  });

  it('rolls back opening-v2 entitlement and nonce after a post-selection failure', async () => {
    const creatorId = await createCreator();
    const rewardVersionId = await createReward(creatorId, { mode: 'unlimited' });
    const box = await createOpeningV2Box(creatorId, rewardVersionId);
    const user = await createUser('1');
    await grantOpeningEntitlement(user.id, creatorId, box.boxId, 1n);
    const failingService = createLegacyOpeningService({
      database,
      fairnessService: {
        selectForOpening: async (transaction, input) => {
          await fairness.selectForOpening(transaction, input);
          throw new Error('Synthetic post-selection R1B failure.');
        },
      },
      logger,
    });

    await expect(openWith(failingService, user, box.boxId)).rejects.toThrow(
      'Synthetic post-selection R1B failure.',
    );
    const state = await adminDatabase.query<{
      readonly claims: string;
      readonly consumptions: string;
      readonly nonce: string;
      readonly openings: string;
    }>(
      `select
        (select count(*)::text from app.idempotency_records
          where actor_user_id = $1 and operation = 'box.open') as claims,
        (select count(*)::text from app.opening_entitlement_consumptions
          where user_id = $1 and box_id = $2) as consumptions,
        (select count(*)::text from app.box_opens where user_id = $1 and box_id = $2) as openings,
        (select next_nonce::text from app.rng_seed_sets where id = $3) as nonce`,
      [user.id, box.boxId, user.seedSetId],
    );
    expect(state.rows).toEqual([{ claims: '0', consumptions: '0', nonce: '0', openings: '0' }]);
  });

  it('replays an opening-v2 historical result after fairness rotation without another use', async () => {
    const creatorId = await createCreator();
    const rewardVersionId = await createReward(creatorId, { mode: 'unlimited' });
    const box = await createOpeningV2Box(creatorId, rewardVersionId, '1');
    const user = await createUser('1');
    await grantOpeningEntitlement(user.id, creatorId, box.boxId, 2n);
    const key = `opening_${randomUUID()}`;
    const first = await open(user, box.boxId, key);
    nextServerSeed = randomBytes(32);
    await fairness.rotate({
      idempotencyKey: `rotation_${randomUUID()}`,
      requestId: randomUUID(),
      userId: user.id,
    });
    const replay = await open(user, box.boxId, key);
    expect(replay).toEqual({ ...first, replayed: true });
    expect(
      (
        await adminDatabase.query<{ readonly consumptions: string; readonly openings: string }>(
          `select
            (select count(*)::text from app.opening_entitlement_consumptions
              where user_id = $1 and box_id = $2) as consumptions,
            (select count(*)::text from app.box_opens
              where user_id = $1 and box_id = $2) as openings`,
          [user.id, box.boxId],
        )
      ).rows,
    ).toEqual([{ consumptions: '1', openings: '1' }]);
  });

  it('does not serialize opening-v2 guards for different users of the same box', async () => {
    const creatorId = await createCreator();
    const rewardVersionId = await createReward(creatorId, { mode: 'unlimited' });
    const box = await createOpeningV2Box(creatorId, rewardVersionId, '2');
    const firstUser = await createUser('1');
    const secondUser = await createUser('1');
    await grantOpeningEntitlement(firstUser.id, creatorId, box.boxId, 1n);
    await grantOpeningEntitlement(secondUser.id, creatorId, box.boxId, 1n);
    const firstService = createLegacyOpeningService({
      database: firstConcurrencyDatabase,
      fairnessService: fairness,
      logger,
    });
    const secondService = createLegacyOpeningService({
      database: secondConcurrencyDatabase,
      fairnessService: fairness,
      logger,
    });
    const firstPid = await readBackendPid(firstConcurrencyDatabase);
    const barrier = await holdOpeningV2Guard(firstUser.id, creatorId, box.boxId);
    const blockedFirst = trackSettlement(openWith(firstService, firstUser, box.boxId));
    expect(await observeBlocking(database, firstPid, barrier.blockerPid, blockedFirst)).toBe(
      'blocked',
    );
    const unrelated = await openWith(secondService, secondUser, box.boxId);
    expect(unrelated.replayed).toBe(false);
    barrier.release();
    await barrier.done;
    expect(await blockedFirst).toMatchObject({ status: 'fulfilled' });
  });

  it('rolls back the losing opening-v2 entitlement in a final-unit inventory race', async () => {
    const creatorId = await createCreator();
    const rewardVersionId = await createReward(creatorId, { mode: 'finite', quantity: '1' });
    const poolId = await inventoryPoolForVersion(rewardVersionId);
    const box = await createOpeningV2Box(creatorId, rewardVersionId, '1');
    const firstUser = await createUser('1');
    const secondUser = await createUser('1');
    await grantOpeningEntitlement(firstUser.id, creatorId, box.boxId, 1n);
    await grantOpeningEntitlement(secondUser.id, creatorId, box.boxId, 1n);
    const firstService = createLegacyOpeningService({
      database: firstConcurrencyDatabase,
      fairnessService: fairness,
      logger,
    });
    const secondService = createLegacyOpeningService({
      database: secondConcurrencyDatabase,
      fairnessService: fairness,
      logger,
    });
    const firstPid = await readBackendPid(firstConcurrencyDatabase);
    const secondPid = await readBackendPid(secondConcurrencyDatabase);
    const blockerStarted = createDeferred<number>();
    const releaseBlocker = createDeferred<undefined>();
    const blocker = adminDatabase.transaction(async (transaction) => {
      const pid = await readBackendPid(transaction);
      await transaction.query(`select id from app.inventory_pools where id = $1 for update`, [
        poolId,
      ]);
      blockerStarted.resolve(pid);
      await releaseBlocker.promise;
    });
    const blockerPid = await blockerStarted.promise;
    const first = trackSettlement(openWith(firstService, firstUser, box.boxId));
    const second = trackSettlement(openWith(secondService, secondUser, box.boxId));
    try {
      expect(await observeBlocking(database, firstPid, blockerPid, first)).toBe('blocked');
      expect(await observeBlocking(database, secondPid, blockerPid, second)).toBe('blocked');
    } finally {
      releaseBlocker.resolve(undefined);
    }
    await blocker;
    const outcomes = await Promise.all([first, second]);
    expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === 'rejected')).toHaveLength(1);

    const state = await adminDatabase.query<{
      readonly consumptions: string;
      readonly fulfillments: string;
      readonly inventoryConsumptions: string;
      readonly nonces: string;
      readonly openings: string;
      readonly outbox: string;
      readonly quantity: string;
      readonly wins: string;
    }>(
      `select
         (select count(*)::text from app.opening_entitlement_consumptions
           where user_id = any($1::uuid[]) and box_id = $2) as consumptions,
         (select count(*)::text from app.box_opens
           where user_id = any($1::uuid[]) and box_id = $2) as openings,
         (select count(*)::text from app.reward_wins
           where user_id = any($1::uuid[]) and opening_id in (
             select id from app.box_opens where box_id = $2
           )) as wins,
         (select count(*)::text from app.fulfillment_obligations
           where opening_id in (
             select id from app.box_opens where user_id = any($1::uuid[]) and box_id = $2
           )) as fulfillments,
         (select count(*)::text from app.inventory_consumptions
           where inventory_pool_id = $3) as "inventoryConsumptions",
         (select sum(next_nonce)::text from app.rng_seed_sets
           where user_id = any($1::uuid[]) and status = 'active') as nonces,
         (select count(*)::text from app.event_outbox
           where aggregate_id in (
             select id from app.box_opens where user_id = any($1::uuid[]) and box_id = $2
           )) as outbox,
         (select available_quantity::text from app.inventory_pools where id = $3) as quantity`,
      [[firstUser.id, secondUser.id], box.boxId, poolId],
    );
    expect(state.rows).toEqual([
      {
        consumptions: '1',
        fulfillments: '1',
        inventoryConsumptions: '1',
        nonces: '1',
        openings: '1',
        outbox: '2',
        quantity: '0',
        wins: '1',
      },
    ]);
  });

  it('rolls back nonce, idempotency, money, inventory, and history after RNG failure', async () => {
    const creatorId = await createCreator();
    const rewardVersionId = await createReward(creatorId, { mode: 'finite', quantity: '1' });
    const box = await createBox(creatorId, rewardVersionId);
    const user = await createUser('999');
    const poolId = await inventoryPoolForVersion(rewardVersionId);
    let selectorCalls = 0;
    const failingOpenings = createLegacyOpeningService({
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
        ...(await openingExpectation(box.boxId, user)),
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
    const guardedOpenings = createLegacyOpeningService({
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
        ...(await openingExpectation(box.boxId, user)),
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

  it('rejects a stale confirmed version before wallet, nonce, RNG, or inventory mutation', async () => {
    const creatorId = await createCreator();
    const ownerId = await creatorOwner(creatorId);
    const rewardVersionId = await createReward(creatorId, { mode: 'finite', quantity: '1' });
    const box = await createBox(creatorId, rewardVersionId, '1000');
    const user = await createUser('20000');
    const originalExpectation = await openingExpectation(box.boxId, user);
    const poolId = await inventoryPoolForVersion(rewardVersionId);
    let selectorCalls = 0;
    const guardedOpenings = createLegacyOpeningService({
      database,
      fairnessService: {
        selectForOpening: async (transaction, input) => {
          selectorCalls += 1;
          return fairness.selectForOpening(transaction, input);
        },
      },
      logger,
    });
    const mismatchedConfigurationHash =
      originalExpectation.expectedConfigurationHash === '0'.repeat(64)
        ? '1'.repeat(64)
        : '0'.repeat(64);
    await expect(
      guardedOpenings.openBox({
        boxId: box.boxId,
        clientSeed: user.clientSeed,
        ...originalExpectation,
        expectedConfigurationHash: mismatchedConfigurationHash,
        idempotencyKey: `open_${randomUUID()}`,
        requestId: randomUUID(),
        userId: user.id,
      }),
    ).rejects.toBeInstanceOf(OpeningConfirmationStaleError);
    expect(selectorCalls).toBe(0);

    const beforeUpdate = await catalog.getBox({ actorUserId: ownerId, creatorId }, box.boxId);
    await catalog.updateBox({
      actorUserId: ownerId,
      boxId: box.boxId,
      creatorId,
      ...parseBoxDraftInput({
        currency: 'USD',
        description: 'Updated authoritative configuration.',
        name: 'Updated box version',
        priceMinor: '10000',
      }),
      expectedRevision: beforeUpdate.revision,
      requestId: randomUUID(),
    });
    const updated = await catalog.getBox({ actorUserId: ownerId, creatorId }, box.boxId);
    const replacement = await catalog.publishBox({
      actorUserId: ownerId,
      boxId: box.boxId,
      creatorId,
      expectedRevision: updated.revision,
      requestId: randomUUID(),
    });
    expect(replacement.version.id).not.toBe(originalExpectation.expectedBoxVersionId);
    expect(replacement.configurationHash).not.toBe(originalExpectation.expectedConfigurationHash);

    await expect(
      guardedOpenings.openBox({
        boxId: box.boxId,
        clientSeed: user.clientSeed,
        ...originalExpectation,
        idempotencyKey: `open_${randomUUID()}`,
        requestId: randomUUID(),
        userId: user.id,
      }),
    ).rejects.toBeInstanceOf(OpeningConfirmationStaleError);
    expect(selectorCalls).toBe(0);

    const state = await database.query<{
      readonly balance: string;
      readonly claims: string;
      readonly consumptions: string;
      readonly nextNonce: string;
      readonly openings: string;
      readonly quantity: string;
    }>(
      `select
         (select available_balance_minor::text from app.wallets
           where user_id = $1 and currency = 'USD') as balance,
         (select next_nonce::text from app.rng_seed_sets
           where user_id = $1 and status = 'active') as "nextNonce",
         (select count(*)::text from app.idempotency_records
           where actor_user_id = $1 and operation = 'box.open') as claims,
         (select count(*)::text from app.box_opens where user_id = $1) as openings,
         (select count(*)::text from app.inventory_consumptions
           where inventory_pool_id = $2) as consumptions,
         (select available_quantity::text from app.inventory_pools where id = $2) as quantity`,
      [user.id, poolId],
    );
    expect(state.rows).toEqual([
      {
        balance: '20000',
        claims: '0',
        consumptions: '0',
        nextNonce: '0',
        openings: '0',
        quantity: '1',
      },
    ]);
  });

  it('rejects a rotated fairness commitment before nonce, charge, inventory, or opening state', async () => {
    const creatorId = await createCreator();
    const rewardVersionId = await createReward(creatorId, { mode: 'finite', quantity: '1' });
    const box = await createBox(creatorId, rewardVersionId, '999');
    const user = await createUser('1998');
    const confirmed = await openingExpectation(box.boxId, user);
    const poolId = await inventoryPoolForVersion(rewardVersionId);

    nextServerSeed = randomBytes(32);
    const rotated = await fairness.rotate({
      idempotencyKey: `rotate_${randomUUID()}`,
      requestId: randomUUID(),
      userId: user.id,
    });
    expect(rotated.newSeedSet.id).not.toBe(confirmed.expectedSeedSetId);
    expect(rotated.newSeedSet.commitment).not.toBe(confirmed.expectedServerSeedCommitment);

    await expect(
      openings.openBox({
        boxId: box.boxId,
        clientSeed: user.clientSeed,
        ...confirmed,
        idempotencyKey: `open_${randomUUID()}`,
        requestId: randomUUID(),
        userId: user.id,
      }),
    ).rejects.toBeInstanceOf(FairnessConfirmationStaleError);

    const failedState = await database.query<{
      readonly balance: string;
      readonly claims: string;
      readonly consumptions: string;
      readonly nextNonce: string;
      readonly openings: string;
      readonly quantity: string;
    }>(
      `select
         (select available_balance_minor::text from app.wallets
           where user_id = $1 and currency = 'USD') as balance,
         (select next_nonce::text from app.rng_seed_sets
           where id = $2) as "nextNonce",
         (select count(*)::text from app.idempotency_records
           where actor_user_id = $1 and operation = 'box.open') as claims,
         (select count(*)::text from app.box_opens where user_id = $1) as openings,
         (select count(*)::text from app.inventory_consumptions
           where inventory_pool_id = $3) as consumptions,
         (select available_quantity::text from app.inventory_pools where id = $3) as quantity`,
      [user.id, rotated.newSeedSet.id, poolId],
    );
    expect(failedState.rows).toEqual([
      {
        balance: '1998',
        claims: '0',
        consumptions: '0',
        nextNonce: '0',
        openings: '0',
        quantity: '1',
      },
    ]);

    const current = await fairness.getCurrent(user.id);
    const opened = await openings.openBox({
      boxId: box.boxId,
      clientSeed: user.clientSeed,
      expectedBoxVersionId: confirmed.expectedBoxVersionId,
      expectedConfigurationHash: confirmed.expectedConfigurationHash,
      expectedSeedSetId: current.activeSeedSet.id,
      expectedServerSeedCommitment: current.activeSeedSet.commitment,
      idempotencyKey: `open_${randomUUID()}`,
      requestId: randomUUID(),
      userId: user.id,
    });
    expect(opened.body.opening.fairness).toMatchObject({
      commitment: current.activeSeedSet.commitment,
      seedSetId: current.activeSeedSet.id,
    });
  });

  it('replays one committed historical version after a newer version is published', async () => {
    const creatorId = await createCreator();
    const ownerId = await creatorOwner(creatorId);
    const rewardVersionId = await createReward(creatorId, { mode: 'unlimited' });
    const box = await createBox(creatorId, rewardVersionId, '999');
    const user = await createUser('1998');
    const confirmed = await openingExpectation(box.boxId, user);
    const idempotencyKey = `open_${randomUUID()}`;
    const command = {
      boxId: box.boxId,
      clientSeed: user.clientSeed,
      ...confirmed,
      idempotencyKey,
      requestId: randomUUID(),
      userId: user.id,
    };
    const first = await openings.openBox(command);

    const beforeUpdate = await catalog.getBox({ actorUserId: ownerId, creatorId }, box.boxId);
    await catalog.updateBox({
      actorUserId: ownerId,
      boxId: box.boxId,
      creatorId,
      ...parseBoxDraftInput({
        currency: 'USD',
        description: 'A newer version published after the committed opening.',
        name: 'New current version',
        priceMinor: '10000',
      }),
      expectedRevision: beforeUpdate.revision,
      requestId: randomUUID(),
    });
    const updated = await catalog.getBox({ actorUserId: ownerId, creatorId }, box.boxId);
    const replacement = await catalog.publishBox({
      actorUserId: ownerId,
      boxId: box.boxId,
      creatorId,
      expectedRevision: updated.revision,
      requestId: randomUUID(),
    });
    expect(replacement.version.id).not.toBe(first.body.opening.boxVersionId);

    nextServerSeed = randomBytes(32);
    const rotated = await fairness.rotate({
      idempotencyKey: `rotate_${randomUUID()}`,
      requestId: randomUUID(),
      userId: user.id,
    });
    expect(rotated.newSeedSet.id).not.toBe(first.body.opening.fairness.seedSetId);

    const replay = await openings.openBox({ ...command, requestId: randomUUID() });
    expect(replay).toEqual({ ...first, replayed: true });
    const state = await database.query<{
      readonly balance: string;
      readonly nextNonce: string;
      readonly openings: string;
    }>(
      `select
         (select available_balance_minor::text from app.wallets
           where user_id = $1 and currency = 'USD') as balance,
         (select next_nonce::text from app.rng_seed_sets
           where id = $2) as "nextNonce",
         (select count(*)::text from app.box_opens where user_id = $1) as openings`,
      [user.id, first.body.opening.fairness.seedSetId],
    );
    expect(state.rows).toEqual([{ balance: '999', nextNonce: '1', openings: '1' }]);
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

    const ownerId = await creatorOwner(creatorId);
    const obligation = await database.query<{ readonly id: string }>(
      `select obligation.id::text as id
         from app.fulfillment_obligations as obligation
         join app.box_opens as opening on opening.id = obligation.opening_id
        where opening.public_id = $1`,
      [result.body.opening.id],
    );
    const fulfillmentId = obligation.rows[0]?.id;
    if (fulfillmentId === undefined) throw new Error('Backorder fulfillment was not found.');
    await expect(
      fulfillments.applyCreatorAction({
        action: { action: 'resolve_backorder' },
        actionKey: `resolve_empty_${randomUUID()}`,
        actorUserId: ownerId,
        creatorId,
        expectedRevision: 1,
        fulfillmentId,
        requestId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(FulfillmentTransitionError);
    const restockKey = `restock_${randomUUID()}`;
    const concurrentRestocks = await Promise.all([
      fulfillments.restock({
        actionKey: restockKey,
        actorUserId: ownerId,
        creatorId,
        poolId,
        quantity: 1n,
        requestId: randomUUID(),
      }),
      fulfillments.restock({
        actionKey: restockKey,
        actorUserId: ownerId,
        creatorId,
        poolId,
        quantity: 1n,
        requestId: randomUUID(),
      }),
    ]);
    expect(concurrentRestocks.map(({ replayed }) => replayed).sort()).toEqual([false, true]);
    expect(new Set(concurrentRestocks.map(({ restockEvent }) => restockEvent.id)).size).toBe(1);
    expect(
      concurrentRestocks.every(
        ({ inventoryPool, restockEvent }) =>
          inventoryPool.availableQuantity === '1' &&
          inventoryPool.id === poolId &&
          inventoryPool.initialQuantity === '1' &&
          restockEvent.quantityAdded === '1',
      ),
    ).toBe(true);
    await expect(
      fulfillments.restock({
        actionKey: restockKey,
        actorUserId: ownerId,
        creatorId,
        poolId,
        quantity: 1n,
        requestId: randomUUID(),
      }),
    ).resolves.toMatchObject({ replayed: true });
    await expect(
      fulfillments.restock({
        actionKey: restockKey,
        actorUserId: ownerId,
        creatorId,
        poolId,
        quantity: 2n,
        requestId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(IdempotencyKeyReusedError);
    const otherCreatorId = await createCreator();
    await expect(
      fulfillments.restock({
        actionKey: `other_${randomUUID()}`,
        actorUserId: await creatorOwner(otherCreatorId),
        creatorId: otherCreatorId,
        poolId,
        quantity: 1n,
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ name: 'FulfillmentNotFoundError' });
    await expect(
      database.query(
        `select * from app.restock_inventory_pool_bound(
           $1, $2, $3, $4, 1, 'forged-restock-command',
           decode(repeat('44', 32), 'hex'), 'local-fulfillment-actor-v1',
           floor(extract(epoch from clock_timestamp()) * 1000)::bigint + 30000,
           decode(repeat('aa', 32), 'hex')
         )`,
        [poolId, creatorId, ownerId, randomUUID()],
      ),
    ).rejects.toMatchObject({ constraint: 'fulfillment_actor_binding_invalid' });

    const resolved = await fulfillments.applyCreatorAction({
      action: { action: 'resolve_backorder' },
      actionKey: `resolve_${randomUUID()}`,
      actorUserId: ownerId,
      creatorId,
      expectedRevision: 1,
      fulfillmentId,
      requestId: randomUUID(),
    });
    expect(resolved.fulfillment.state).toBe('ready_for_delivery');
    const deliveryActionKey = `deliver_${randomUUID()}`;
    const delivered = await fulfillments.applyCreatorAction({
      action: { action: 'deliver_digital', secret: 'synthetic-redemption-code' },
      actionKey: deliveryActionKey,
      actorUserId: ownerId,
      creatorId: creatorId.toUpperCase(),
      expectedRevision: 2,
      fulfillmentId,
      requestId: randomUUID(),
    });
    expect(delivered.fulfillment.state).toBe('delivered');
    await expect(
      fulfillments.applyCreatorAction({
        action: { action: 'deliver_digital', secret: 'synthetic-redemption-code' },
        actionKey: deliveryActionKey,
        actorUserId: ownerId,
        creatorId,
        expectedRevision: 2,
        fulfillmentId,
        requestId: randomUUID(),
      }),
    ).resolves.toMatchObject({ replayed: true });
    await expect(fulfillments.getUserDeliveryData(user.id, fulfillmentId)).resolves.toEqual({
      digitalSecret: 'synthetic-redemption-code',
      expiresAt: null,
      fulfillmentId,
    });
    await expect(
      fulfillments.getCreatorDeliveryData({
        actorUserId: ownerId,
        creatorId,
        fulfillmentId,
        purpose: 'fulfillment_execution',
      }),
    ).resolves.toMatchObject({ digitalSecret: 'synthetic-redemption-code' });
    const history = await adminDatabase.query<{
      readonly accessEvents: string;
      readonly available: string;
      readonly consumptions: string;
      readonly initial: string;
      readonly restocks: string;
    }>(
      `select
         (select count(*)::text from app.fulfillment_data_access_events
           where fulfillment_id = $1) as "accessEvents",
         (select available_quantity::text from app.inventory_pools where id = $2) as available,
         (select count(*)::text from app.inventory_consumptions
           where inventory_pool_id = $2) as consumptions,
         (select initial_quantity::text from app.inventory_pools where id = $2) as initial,
         (select count(*)::text from app.inventory_restock_events
           where inventory_pool_id = $2) as restocks`,
      [fulfillmentId, poolId],
    );
    expect(history.rows).toEqual([
      { accessEvents: '1', available: '0', consumptions: '2', initial: '1', restocks: '1' },
    ]);
    await adminDatabase.query(
      `update app.fulfillment_delivery_data
          set expires_at = created_at,
              updated_at = clock_timestamp() + interval '1 millisecond'
        where fulfillment_id = $1`,
      [fulfillmentId],
    );
    await expect(fulfillments.getUserDeliveryData(user.id, fulfillmentId)).rejects.toBeInstanceOf(
      FulfillmentDataUnavailableError,
    );
    await expect(fulfillments.getUserFulfillment(user.id, fulfillmentId)).resolves.toMatchObject({
      deliveryData: { available: false },
      reward: { rewardVersionId },
      state: 'delivered',
    });
    await expect(
      database.query(
        `update app.inventory_restock_events set quantity_added = 2
          where inventory_pool_id = $1`,
        [poolId],
      ),
    ).rejects.toThrow(/permission denied/iu);
    await expect(
      database.query(
        `update app.inventory_pools set initial_quantity = initial_quantity + 1 where id = $1`,
        [poolId],
      ),
    ).rejects.toBeDefined();
    await expect(
      database.query(
        `insert into app.inventory_restock_events (
           id, inventory_pool_id, creator_id, actor_user_id,
           quantity_added, action_key, command_fingerprint
         ) values ($1, $2, $3, $4, 1, 'forged-restock', decode(repeat('44', 32), 'hex'))`,
        [randomUUID(), poolId, creatorId, ownerId],
      ),
    ).rejects.toThrow(/permission denied/iu);
  });

  it('enforces physical and experience fulfillment transitions and sensitive-role access', async () => {
    const creatorId = await createCreator();
    const ownerId = await creatorOwner(creatorId);
    const managerId = randomUUID() as UserId;
    const editorId = randomUUID() as UserId;
    await database.query(
      `insert into app.users (id, auth_provider, auth_subject, username) values
         ($1, 'synthetic-fulfillment-member', $1::uuid::text, $3),
         ($2, 'synthetic-fulfillment-member', $2::uuid::text, $4)`,
      [
        managerId,
        editorId,
        `fulfillment_manager_${managerId.replaceAll('-', '')}`,
        `fulfillment_editor_${editorId.replaceAll('-', '')}`,
      ],
    );
    await database.query(
      `insert into app.creator_memberships (creator_id, user_id, role)
       values ($1, $2, 'manager'), ($1, $3, 'editor')`,
      [creatorId, managerId, editorId],
    );

    const physicalVersion = await createReward(creatorId, {
      mode: 'unlimited',
      rewardType: 'physical',
    });
    const physicalBox = await createBox(creatorId, physicalVersion);
    const physicalUser = await createUser('999');
    const physicalOpen = await open(physicalUser, physicalBox.boxId);
    const physicalIdResult = await database.query<{ readonly id: string }>(
      `select obligation.id::text as id
         from app.fulfillment_obligations as obligation
         join app.box_opens as opening on opening.id = obligation.opening_id
        where opening.public_id = $1`,
      [physicalOpen.body.opening.id],
    );
    const physicalId = physicalIdResult.rows[0]?.id;
    if (physicalId === undefined) throw new Error('Physical fulfillment was not created.');
    expect(await fulfillments.getUserFulfillment(physicalUser.id, physicalId)).toMatchObject({
      fulfillmentType: 'physical',
      state: 'awaiting_address',
    });
    const addressKey = `address_${randomUUID()}`;
    const address = {
      addressLine1: '123 Example Street',
      addressLine2: null,
      city: 'Toronto',
      country: 'CA',
      postalCode: 'M5V 2T6',
      recipientName: 'Synthetic Recipient',
      region: 'ON',
    } as const;
    const addressResult = await fulfillments.submitAddress({
      actionKey: addressKey,
      actorUserId: physicalUser.id,
      address,
      expectedRevision: 1,
      fulfillmentId: physicalId,
      requestId: randomUUID(),
    });
    expect(addressResult.fulfillment.state).toBe('ready_to_ship');
    await expect(
      fulfillments.submitAddress({
        actionKey: addressKey,
        actorUserId: physicalUser.id,
        address,
        expectedRevision: 1,
        fulfillmentId: physicalId,
        requestId: randomUUID(),
      }),
    ).resolves.toMatchObject({ fulfillment: { revision: 2 }, replayed: true });
    await expect(
      fulfillments.submitAddress({
        actionKey: addressKey,
        actorUserId: physicalUser.id,
        address: { ...address, city: 'Ottawa' },
        expectedRevision: 2,
        fulfillmentId: physicalId,
        requestId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(IdempotencyKeyReusedError);
    await expect(fulfillments.getUserFulfillment(managerId, physicalId)).rejects.toBeInstanceOf(
      FulfillmentNotFoundError,
    );
    const otherCreatorId = await createCreator();
    await expect(
      fulfillments.getCreatorFulfillment({
        actorUserId: await creatorOwner(otherCreatorId),
        creatorId: otherCreatorId,
        fulfillmentId: physicalId,
      }),
    ).rejects.toBeInstanceOf(FulfillmentNotFoundError);
    await expect(
      fulfillments.getCreatorDeliveryData({
        actorUserId: await creatorOwner(otherCreatorId),
        creatorId: otherCreatorId,
        fulfillmentId: physicalId,
        purpose: 'fulfillment_execution',
      }),
    ).rejects.toBeInstanceOf(FulfillmentNotFoundError);
    await expect(fulfillments.getUserDeliveryData(managerId, physicalId)).rejects.toBeInstanceOf(
      FulfillmentNotFoundError,
    );
    await expect(
      fulfillments.applyCreatorAction({
        action: { action: 'mark_shipped' },
        actionKey: `fan_${randomUUID()}`,
        actorUserId: physicalUser.id,
        creatorId,
        expectedRevision: 2,
        fulfillmentId: physicalId,
        requestId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(FulfillmentNotFoundError);
    await expect(
      fulfillments.applyCreatorAction({
        action: { action: 'mark_shipped' },
        actionKey: `editor_${randomUUID()}`,
        actorUserId: editorId,
        creatorId,
        expectedRevision: 2,
        fulfillmentId: physicalId,
        requestId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(FulfillmentPermissionDeniedError);
    await expect(
      fulfillments.getCreatorDeliveryData({
        actorUserId: editorId,
        creatorId,
        fulfillmentId: physicalId,
        purpose: 'fulfillment_execution',
      }),
    ).rejects.toBeInstanceOf(FulfillmentPermissionDeniedError);
    await expect(
      fulfillments.getCreatorDeliveryData({
        actorUserId: ownerId,
        creatorId,
        fulfillmentId: physicalId,
        purpose: 'fulfillment_execution',
      }),
    ).resolves.toMatchObject({ address });
    await expect(
      database.query(
        `select ciphertext from app.fulfillment_delivery_data where fulfillment_id = $1`,
        [physicalId],
      ),
    ).rejects.toThrow(/permission denied/iu);
    const protectedAddress = await adminDatabase.query<{
      readonly accessCount: string;
      readonly containsPlaintext: boolean;
      readonly fingerprint: string;
      readonly fingerprintDomain: string;
      readonly fingerprintVersion: string;
    }>(
      `select
         position(convert_to('123 Example Street', 'utf8') in ciphertext) > 0
           as "containsPlaintext",
         (select count(*)::text from app.fulfillment_data_access_events
           where fulfillment_id = $1) as "accessCount",
         (select encode(command_fingerprint, 'hex') from app.fulfillment_events
           where fulfillment_id = $1 and action = 'submit_address') as fingerprint,
         (select fingerprint_key_domain from app.fulfillment_events
           where fulfillment_id = $1 and action = 'submit_address') as "fingerprintDomain",
         (select fingerprint_key_version from app.fulfillment_events
           where fulfillment_id = $1 and action = 'submit_address') as "fingerprintVersion"
       from app.fulfillment_delivery_data where fulfillment_id = $1`,
      [physicalId],
    );
    expect(protectedAddress.rows).toHaveLength(1);
    expect(protectedAddress.rows[0]).toMatchObject({
      accessCount: '1',
      containsPlaintext: false,
      fingerprintDomain: 'address',
      fingerprintVersion: 'local-fulfillment-address-v1',
    });
    expect(protectedAddress.rows[0]?.fingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(protectedAddress.rows[0]?.fingerprint).not.toBe(
      createHash('sha256')
        .update(JSON.stringify({ action: 'submit_address', address }))
        .digest('hex'),
    );
    await expect(
      fulfillments.applyCreatorAction({
        action: { action: 'mark_delivered' },
        actionKey: `invalid_${randomUUID()}`,
        actorUserId: managerId,
        creatorId,
        expectedRevision: 2,
        fulfillmentId: physicalId,
        requestId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(FulfillmentTransitionError);
    const afterInvalid = await adminDatabase.query<{
      readonly eventCount: string;
      readonly revision: string;
      readonly state: string;
    }>(
      `select obligation.current_state as state, obligation.revision::text as revision,
              (select count(*)::text from app.fulfillment_events
                where fulfillment_id = obligation.id) as "eventCount"
         from app.fulfillment_obligations as obligation where obligation.id = $1`,
      [physicalId],
    );
    expect(afterInvalid.rows).toEqual([{ eventCount: '2', revision: '2', state: 'ready_to_ship' }]);
    const shippedKey = `ship_${randomUUID()}`;
    const shipped = await fulfillments.applyCreatorAction({
      action: { action: 'mark_shipped' },
      actionKey: shippedKey,
      actorUserId: managerId,
      creatorId,
      expectedRevision: 2,
      fulfillmentId: physicalId,
      requestId: randomUUID(),
    });
    expect(shipped.fulfillment.state).toBe('shipped');
    await expect(
      fulfillments.applyCreatorAction({
        action: { action: 'mark_shipped' },
        actionKey: shippedKey,
        actorUserId: managerId,
        creatorId,
        expectedRevision: 2,
        fulfillmentId: physicalId,
        requestId: randomUUID(),
      }),
    ).resolves.toMatchObject({ fulfillment: { revision: 3 }, replayed: true });
    await expect(
      fulfillments.applyCreatorAction({
        action: { action: 'mark_delivered' },
        actionKey: shippedKey,
        actorUserId: managerId,
        creatorId,
        expectedRevision: 3,
        fulfillmentId: physicalId,
        requestId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(IdempotencyKeyReusedError);
    const delivered = await fulfillments.applyCreatorAction({
      action: { action: 'mark_delivered' },
      actionKey: `delivered_${randomUUID()}`,
      actorUserId: ownerId,
      creatorId,
      expectedRevision: 3,
      fulfillmentId: physicalId,
      requestId: randomUUID(),
    });
    expect(delivered.fulfillment.state).toBe('delivered');
    const redacted = await fulfillments.redactUserDeliveryData({
      actionKey: `redact_${randomUUID()}`,
      actorUserId: physicalUser.id,
      expectedRevision: 4,
      fulfillmentId: physicalId,
      requestId: randomUUID(),
    });
    expect(redacted.fulfillment.deliveryData).toMatchObject({ available: false });
    await expect(
      fulfillments.getUserDeliveryData(physicalUser.id, physicalId),
    ).rejects.toBeInstanceOf(FulfillmentDataUnavailableError);
    const immutablePhysical = await adminDatabase.query<{
      readonly ciphertextRemoved: boolean;
      readonly eventCount: string;
      readonly rewardVersionId: string;
      readonly state: string;
    }>(
      `select obligation.current_state as state,
              obligation.reward_version_id::text as "rewardVersionId",
              (select count(*)::text from app.fulfillment_events
                where fulfillment_id = obligation.id) as "eventCount",
              (select ciphertext is null and encryption_iv is null
                 and encryption_auth_tag is null
                 from app.fulfillment_delivery_data where fulfillment_id = obligation.id)
                as "ciphertextRemoved"
         from app.fulfillment_obligations as obligation where obligation.id = $1`,
      [physicalId],
    );
    expect(immutablePhysical.rows).toEqual([
      {
        ciphertextRemoved: true,
        eventCount: '5',
        rewardVersionId: physicalVersion,
        state: 'delivered',
      },
    ]);
    await expect(
      database.query(
        `update app.fulfillment_obligations
            set reward_version_id = $2, current_state = 'awaiting_address'
          where id = $1`,
        [physicalId, physicalVersion],
      ),
    ).rejects.toThrow(/permission denied/iu);
    await expect(
      database.query(
        `update app.fulfillment_events set to_state = 'shipped' where fulfillment_id = $1`,
        [physicalId],
      ),
    ).rejects.toThrow(/permission denied/iu);
    await expect(
      database.query(
        `insert into app.fulfillment_obligations (id, opening_id, reward_win_id, status)
         select $2, opening_id, reward_win_id, status
           from app.fulfillment_obligations where id = $1`,
        [physicalId, randomUUID()],
      ),
    ).rejects.toBeDefined();

    const experienceVersion = await createReward(creatorId, {
      mode: 'unlimited',
      rewardType: 'experience',
    });
    const experienceBox = await createBox(creatorId, experienceVersion);
    const experienceUser = await createUser('999');
    const experienceOpen = await open(experienceUser, experienceBox.boxId);
    const experienceIdResult = await database.query<{ readonly id: string }>(
      `select obligation.id::text as id
         from app.fulfillment_obligations as obligation
         join app.box_opens as opening on opening.id = obligation.opening_id
        where opening.public_id = $1`,
      [experienceOpen.body.opening.id],
    );
    const experienceId = experienceIdResult.rows[0]?.id;
    if (experienceId === undefined) throw new Error('Experience fulfillment was not created.');
    const experience = await fulfillments.getUserFulfillment(experienceUser.id, experienceId);
    expect(experience).toMatchObject({
      fulfillmentType: 'experience',
      state: 'coordination_required',
    });
    await expect(
      fulfillments.applyCreatorAction({
        action: { action: 'fulfill_experience' },
        actionKey: `experience_${randomUUID()}`,
        actorUserId: managerId,
        creatorId,
        expectedRevision: 1,
        fulfillmentId: experienceId,
        requestId: randomUUID(),
      }),
    ).resolves.toMatchObject({ fulfillment: { state: 'fulfilled' } });
  });

  it('records protected creator access only after successful key and plaintext validation', async () => {
    const creatorId = await createCreator();
    const ownerId = await creatorOwner(creatorId);
    const rewardVersionId = await createReward(creatorId, {
      mode: 'unlimited',
      rewardType: 'physical',
    });
    const box = await createBox(creatorId, rewardVersionId);
    const user = await createUser('999');
    const result = await open(user, box.boxId);
    const fulfillmentResult = await database.query<{ readonly id: string }>(
      `select obligation.id::text as id
         from app.fulfillment_obligations as obligation
         join app.box_opens as opening on opening.id = obligation.opening_id
        where opening.public_id = $1`,
      [result.body.opening.id],
    );
    const fulfillmentId = fulfillmentResult.rows[0]?.id;
    if (fulfillmentId === undefined) throw new Error('Protected-read fixture was not created.');
    const address = {
      addressLine1: '321 Synthetic Avenue',
      addressLine2: null,
      city: 'Toronto',
      country: 'CA',
      postalCode: 'M5V 2T6',
      recipientName: 'Synthetic Reader',
      region: 'ON',
    } as const;
    await fulfillments.submitAddress({
      actionKey: `protected_${randomUUID()}`,
      actorUserId: user.id,
      address,
      expectedRevision: 1,
      fulfillmentId,
      requestId: randomUUID(),
    });

    const accessCount = async (): Promise<string> =>
      (
        await adminDatabase.query<{ readonly count: string }>(
          `select count(*)::text as count from app.fulfillment_data_access_events
            where fulfillment_id = $1`,
          [fulfillmentId],
        )
      ).rows[0]?.count ?? 'missing';
    const serviceWithAddressKey = (
      keyHex: string,
      version = 'local-fulfillment-address-v1',
      actorBinding = {
        keyHex: '33'.repeat(32),
        version: 'local-fulfillment-actor-v1',
      },
    ) =>
      createFulfillmentService({
        actorBindingProvider: createEnvironmentFulfillmentActorBindingProvider(actorBinding),
        database,
        keyProvider: createEnvironmentFulfillmentKeyProvider({
          address: { keyHex, version },
          digitalSecret: {
            keyHex: '22'.repeat(32),
            version: 'local-digital-delivery-v1',
          },
        }),
        logger,
        retentionMs: null,
      });
    const readAsCreator = (service: FulfillmentService) =>
      service.getCreatorDeliveryData({
        actorUserId: ownerId,
        creatorId,
        fulfillmentId,
        purpose: 'fulfillment_execution',
      });

    await expect(
      readAsCreator(
        serviceWithAddressKey('11'.repeat(32), 'local-fulfillment-address-v1', {
          keyHex: '44'.repeat(32),
          version: 'inactive-actor-binding-v2',
        }),
      ),
    ).rejects.toBeInstanceOf(FulfillmentKeyUnavailableError);
    expect(await accessCount()).toBe('0');

    const forgedEventId = randomUUID();
    const forgedExpiry = Date.now() + 30_000;
    const forgedSignature = Buffer.alloc(32, 0xaa);
    await expect(
      database.query(
        `select app.apply_creator_fulfillment_action_bound(
           $1,$2,$3,2,$4,'mark_shipped','forged-transition',
           decode(repeat('55',32),'hex'),'local-fulfillment-actor-v1',$5,$6
         )`,
        [fulfillmentId, creatorId, ownerId, forgedEventId, forgedExpiry, forgedSignature],
      ),
    ).rejects.toMatchObject({ constraint: 'fulfillment_actor_binding_invalid' });
    await expect(
      database.query(
        `select * from app.read_fulfillment_delivery_data_bound(
           $1,$2,$3,$4,'fulfillment_execution',
           'local-fulfillment-actor-v1',$5,$6
         )`,
        [fulfillmentId, ownerId, creatorId, forgedEventId, forgedExpiry, forgedSignature],
      ),
    ).rejects.toMatchObject({ constraint: 'fulfillment_actor_binding_invalid' });
    await expect(
      database.query(
        `select app.record_fulfillment_data_access_bound(
           $1,$2,$3,$4,'fulfillment_execution',
           'local-fulfillment-actor-v1',$5,$6
         )`,
        [fulfillmentId, ownerId, creatorId, forgedEventId, forgedExpiry, forgedSignature],
      ),
    ).rejects.toMatchObject({ constraint: 'fulfillment_actor_binding_invalid' });
    expect(await accessCount()).toBe('0');
    expect(
      (
        await database.query<{
          readonly canUseLegacyAction: boolean;
          readonly canUseLegacyRead: boolean;
          readonly state: string;
        }>(
          `select
             has_function_privilege(
               current_user,
               'app.apply_creator_fulfillment_action(uuid,uuid,uuid,bigint,uuid,text,text,bytea)',
               'EXECUTE'
             ) as "canUseLegacyAction",
             has_function_privilege(
               current_user,
               'app.read_fulfillment_delivery_data(uuid,uuid,uuid,uuid,text)',
               'EXECUTE'
             ) as "canUseLegacyRead",
             (select current_state from app.fulfillment_obligations where id = $1) as state`,
          [fulfillmentId],
        )
      ).rows,
    ).toEqual([{ canUseLegacyAction: false, canUseLegacyRead: false, state: 'ready_to_ship' }]);

    await expect(
      readAsCreator(serviceWithAddressKey('44'.repeat(32), 'unavailable-address-v1')),
    ).rejects.toMatchObject({ name: 'FulfillmentKeyUnavailableError' });
    await expect(readAsCreator(serviceWithAddressKey('44'.repeat(32)))).rejects.toMatchObject({
      name: 'FulfillmentKeyUnavailableError',
    });
    expect(await accessCount()).toBe('0');

    const original = await adminDatabase.query<{
      readonly authenticationTag: Uint8Array;
      readonly ciphertext: Uint8Array;
      readonly iv: Uint8Array;
    }>(
      `select ciphertext, encryption_iv as iv,
              encryption_auth_tag as "authenticationTag"
         from app.fulfillment_delivery_data where fulfillment_id = $1`,
      [fulfillmentId],
    );
    const protectedValue = original.rows[0];
    if (protectedValue === undefined) throw new Error('Protected address was not stored.');
    const restore = async (): Promise<void> => {
      await adminDatabase.query(
        `update app.fulfillment_delivery_data
            set ciphertext = $2, encryption_iv = $3, encryption_auth_tag = $4,
                updated_at = greatest(updated_at + interval '1 microsecond', clock_timestamp())
          where fulfillment_id = $1`,
        [
          fulfillmentId,
          protectedValue.ciphertext,
          protectedValue.iv,
          protectedValue.authenticationTag,
        ],
      );
    };
    for (const column of ['ciphertext', 'encryption_auth_tag'] as const) {
      await adminDatabase.query(
        `update app.fulfillment_delivery_data
            set ${column} = set_byte(${column}, 0, get_byte(${column}, 0) # 1),
                updated_at = greatest(updated_at + interval '1 microsecond', clock_timestamp())
          where fulfillment_id = $1`,
        [fulfillmentId],
      );
      await expect(readAsCreator(fulfillments)).rejects.toBeInstanceOf(
        FulfillmentDataUnavailableError,
      );
      expect(await accessCount()).toBe('0');
      await restore();
    }

    for (const malformedPlaintext of [
      Uint8Array.of(0xff),
      new TextEncoder().encode('{"unexpected":true}'),
    ]) {
      const malformed = encryptFulfillmentValue({
        aad: buildFulfillmentAad({
          creatorId,
          domain: 'address',
          fulfillmentId,
          keyVersion: 'local-fulfillment-address-v1',
          userId: user.id,
        }),
        key: new Uint8Array(32).fill(0x11),
        plaintext: malformedPlaintext,
      });
      await adminDatabase.query(
        `update app.fulfillment_delivery_data
            set ciphertext = $2, encryption_iv = $3, encryption_auth_tag = $4,
                updated_at = greatest(updated_at + interval '1 microsecond', clock_timestamp())
          where fulfillment_id = $1`,
        [fulfillmentId, malformed.ciphertext, malformed.iv, malformed.authenticationTag],
      );
      await expect(readAsCreator(fulfillments)).rejects.toBeInstanceOf(
        FulfillmentDataUnavailableError,
      );
      expect(await accessCount()).toBe('0');
      malformed.authenticationTag.fill(0);
      malformed.ciphertext.fill(0);
      malformed.iv.fill(0);
      malformedPlaintext.fill(0);
      await restore();
    }

    await expect(readAsCreator(fulfillments)).resolves.toMatchObject({ address });
    expect(await accessCount()).toBe('1');
  });

  it('shares one stable pool across reward versions without replenishing cloned stock', async () => {
    const creatorId = await createCreator();
    const ownerId = await creatorOwner(creatorId);
    const reward = await createRewardRecord(creatorId, { mode: 'finite', quantity: '2' });
    const poolId = await inventoryPoolForVersion(reward.versionId);
    await expect(
      fulfillments.restock({
        actionKey: `draft_${randomUUID()}`,
        actorUserId: ownerId,
        creatorId,
        poolId,
        quantity: 1n,
        requestId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(InventoryRestockError);
    const firstBox = await createBox(creatorId, reward.versionId);
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
    if ('openingCompatibilityVersion' in result.body.opening) {
      throw new Error('Expected a paid opening-v1 response.');
    }
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
    const firstOpenings = createLegacyOpeningService({
      database: firstConcurrencyDatabase,
      fairnessService: coordinatedFairness(0, firstSelection),
      logger,
    });
    const secondOpenings = createLegacyOpeningService({
      database: secondConcurrencyDatabase,
      fairnessService: coordinatedFairness(1, secondSelection),
      logger,
    });
    const [firstExpectation, secondExpectation] = await Promise.all([
      openingExpectation(firstBoxId, firstUser),
      openingExpectation(secondBoxId, secondUser),
    ]);
    const firstOperation = firstOpenings.openBox({
      boxId: firstBoxId,
      clientSeed: firstUser.clientSeed,
      ...firstExpectation,
      idempotencyKey: `open_${randomUUID()}`,
      requestId: randomUUID(),
      userId: firstUser.id,
    });
    const secondOperation = secondOpenings.openBox({
      boxId: secondBoxId,
      clientSeed: secondUser.clientSeed,
      ...secondExpectation,
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

  it('claims committed events once across two workers and protects completion by claim token', async () => {
    await drainOutbox();
    const creatorId = await createCreator();
    const rewardVersionId = await createReward(creatorId, { mode: 'unlimited' });
    const box = await createBox(creatorId, rewardVersionId);
    await open(await createUser('999'), box.boxId);

    const firstClaimed = createDeferred<ClaimedEventRow>();
    const releaseFirst = createDeferred<undefined>();
    const firstTransaction = workerDatabase.transaction(async (transaction) => {
      const events = await claimOutbox('worker:concurrent-a', 1, 30_000, 3, transaction);
      const event = events[0];
      if (event === undefined) throw new Error('The first worker did not claim an event.');
      firstClaimed.resolve(event);
      await releaseFirst.promise;
      return events;
    });
    const heldEvent = await firstClaimed.promise;
    const second = await claimOutbox('worker:concurrent-b', 1);
    releaseFirst.resolve(undefined);
    const first = await firstTransaction;
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0]).toEqual(heldEvent);
    expect(new Set([...first, ...second].map(({ id }) => id)).size).toBe(2);
    await Promise.all([...first, ...second].map(completeClaim));
    const completedEvent = first[0];
    if (completedEvent === undefined) throw new Error('The first worker did not claim an event.');
    await expect(completeClaim(completedEvent)).rejects.toMatchObject({
      constraint: 'event_outbox_claim_not_owned',
    });
    expect(
      (
        await database.query<{ readonly count: string }>(
          `select count(*)::text as count
             from app.event_outbox
            where status = 'delivered' and id = any($1::uuid[])`,
          [[...first, ...second].map(({ id }) => id)],
        )
      ).rows,
    ).toEqual([{ count: '2' }]);
  });

  it('recovers an expired worker lease without allowing the stale worker to acknowledge it', async () => {
    await drainOutbox();
    const creatorId = await createCreator();
    const rewardVersionId = await createReward(creatorId, { mode: 'unlimited' });
    const box = await createBox(creatorId, rewardVersionId);
    await open(await createUser('999'), box.boxId);

    const original = (await claimOutbox('worker:crashed', 1, 1000))[0];
    if (original === undefined) throw new Error('The crash test did not claim an event.');
    await adminDatabase.query(
      `update app.event_outbox
          set claimed_at = clock_timestamp() - interval '2 seconds',
              lease_expires_at = clock_timestamp() - interval '1 millisecond'
        where id = $1`,
      [original.id],
    );
    const recovered = (await claimOutbox('worker:recovery', 1, 1000))[0];
    if (recovered === undefined) throw new Error('The expired event was not recovered.');
    expect(recovered).toMatchObject({ attemptCount: 2, id: original.id });
    expect(recovered.claimToken).not.toBe(original.claimToken);
    await expect(completeClaim(original)).rejects.toMatchObject({
      constraint: 'event_outbox_claim_not_owned',
    });
    await expect(completeClaim(recovered)).resolves.toBeUndefined();

    const exhausted = (await claimOutbox('worker:crashed-final', 1, 1000, 1))[0];
    if (exhausted === undefined) throw new Error('The final-attempt crash event was not claimed.');
    await adminDatabase.query(
      `update app.event_outbox
          set claimed_at = clock_timestamp() - interval '2 seconds',
              lease_expires_at = clock_timestamp() - interval '1 millisecond'
        where id = $1`,
      [exhausted.id],
    );
    expect(await claimOutbox('worker:after-final-crash', 1, 1000, 1)).toHaveLength(0);
    expect(
      (
        await database.query<{ readonly errorCode: string; readonly status: string }>(
          `select status, last_error_code as "errorCode"
             from app.event_outbox where id = $1`,
          [exhausted.id],
        )
      ).rows,
    ).toEqual([{ errorCode: 'MAX_ATTEMPTS_EXCEEDED', status: 'dead' }]);
  });

  it('honors retry availability, retains terminal history, reports lag, and denies app claims', async () => {
    await drainOutbox();
    const creatorId = await createCreator();
    const rewardVersionId = await createReward(creatorId, { mode: 'unlimited' });
    const box = await createBox(creatorId, rewardVersionId);
    await open(await createUser('999'), box.boxId);
    const event = (await claimOutbox('worker:retry', 1))[0];
    if (event === undefined) throw new Error('The retry test did not claim an event.');
    await workerDatabase.query(`select app.fail_outbox_event($1, $2, $3, $4, false)`, [
      event.id,
      event.claimToken,
      'REALTIME_UNAVAILABLE',
      new Date(Date.now() + 60_000),
    ]);
    const earlyClaims = await claimOutbox('worker:too-early');
    expect(earlyClaims.map(({ id }) => id)).not.toContain(event.id);
    await Promise.all(earlyClaims.map(completeClaim));
    await adminDatabase.query(
      `update app.event_outbox
          set available_at = clock_timestamp() - interval '1 millisecond'
        where id = $1`,
      [event.id],
    );
    const retry = (await claimOutbox('worker:retry', 1))[0];
    if (retry === undefined) throw new Error('The retry did not become available.');
    await workerDatabase.query(`select app.fail_outbox_event($1, $2, $3, $4, true)`, [
      retry.id,
      retry.claimToken,
      'INVALID_EVENT',
      new Date(Date.now() + 60_000),
    ]);
    const state = await database.query<{
      readonly attemptCount: number;
      readonly lastErrorCode: string;
      readonly status: string;
    }>(
      `select status, attempt_count as "attemptCount", last_error_code as "lastErrorCode"
         from app.event_outbox where id = $1`,
      [event.id],
    );
    expect(state.rows).toEqual([
      { attemptCount: 2, lastErrorCode: 'INVALID_EVENT', status: 'dead' },
    ]);
    await expect(
      database.query(`select * from app.claim_outbox_events($1, 1, 30000, 3)`, [
        'worker:forbidden',
      ]),
    ).rejects.toThrow(/permission denied/iu);
    await expect(workerDatabase.query(`select id from app.event_outbox limit 1`)).rejects.toThrow(
      /permission denied/iu,
    );
    const lag = await workerDatabase.query<{
      readonly deadCount: string;
      readonly pendingCount: string;
    }>(
      `select dead_count::text as "deadCount", pending_count::text as "pendingCount"
         from app.read_outbox_lag()`,
    );
    const lagRow = lag.rows[0];
    expect(lagRow).toBeDefined();
    expect(BigInt(lagRow?.deadCount ?? '0')).toBeGreaterThanOrEqual(1n);
    expect(BigInt(lagRow?.pendingCount ?? '-1')).toBeGreaterThanOrEqual(0n);
  });
});
