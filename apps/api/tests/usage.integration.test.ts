import { readCreatorUsage } from '../src/modules/usage/usage.repository.js';
import type { CreatorOpeningCapacity } from '../src/modules/usage/creator-opening-capacity.js';
import request from 'supertest';
import { creatorUsageQuerySchema } from '@creatordrop/contracts';
import { createCreatorUsageService } from '../src/modules/usage/usage.service.js';
import { createTestApp } from './support/test-app.js';
import { randomUUID } from 'node:crypto';

import { afterAll, describe, expect, it, vi } from 'vitest';

import { createDatabasePool, type Database } from '@creatordrop/database';
import type { Logger } from '@creatordrop/observability';

import { createCatalogService } from '../src/modules/catalog/catalog.service.js';
import {
  parseBoxDraftInput,
  parseRewardDraftInput,
} from '../src/modules/catalog/catalog.schema.js';
import type { BoxId, ProbabilityWeight } from '../src/modules/catalog/catalog.js';
import type { CreatorId, UserId } from '../src/modules/creators/creator.js';
import { createFairnessService } from '../src/modules/fairness/fairness.service.js';
import { createEnvironmentSeedEncryptionKeyProvider } from '../src/modules/fairness/fairness.key-provider.js';
import type { ClientSeed } from '../src/modules/fairness/fairness.js';
import { createOpeningService } from '../src/modules/openings/opening.service.js';

const localUrl = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const pool = (connectionString: string) =>
  createDatabasePool({
    applicationName: 'r4-usage-integration',
    connectionString,
    connectionTimeoutMs: 5000,
    idleTimeoutMs: 1000,
    maxConnections: 16,
    onUnexpectedPoolError: (error) => {
      throw error;
    },
  });
const database = pool(
  process.env.DATABASE_URL ?? `${localUrl}?options=-c%20role%3Dcreatordrop_app`,
);
const admin = pool(process.env.DATABASE_MIGRATION_URL ?? localUrl);
const logger: Logger = { info: () => undefined, error: () => undefined };
const catalog = createCatalogService({ database, logger });
const fairness = createFairnessService({
  database,
  logger,
  keyProvider: createEnvironmentSeedEncryptionKeyProvider({
    historicalKeys: {},
    keyHex: '0'.repeat(64),
    version: 'local-dev-v1',
  }),
  policy: { maxAgeMs: 86_400_000, maxOpenings: 1000n },
});
const openings = createOpeningService({ database, fairnessService: fairness, logger });

const fixture = async () => {
  const userId = randomUUID() as UserId;
  const owner = randomUUID() as UserId;
  const creatorId = randomUUID() as CreatorId;
  for (const id of [userId, owner])
    await database.query(
      `insert into app.users(id,auth_provider,auth_subject,username)
     values($1,'synthetic-r4-usage',$1::uuid::text,$2)`,
      [id, `r4_usage_${id.replaceAll('-', '')}`],
    );
  await database.transaction(async (transaction) => {
    await transaction.query(
      `insert into app.creators(id,handle,custom_slug,display_name)
      values($1,$2,$3,'Synthetic R4 usage creator')`,
      [creatorId, `linkage_${creatorId.slice(0, 8)}`, `linkage-${creatorId.slice(0, 8)}`],
    );
    await transaction.query(
      `insert into app.creator_memberships(creator_id,user_id,role)
      values($1,$2,'owner')`,
      [creatorId, owner],
    );
  });
  const createBox = async (xp: boolean) => {
    const scope = { creatorId, actorUserId: owner, requestId: randomUUID() };
    const reward = await catalog.createReward({
      ...scope,
      ...parseRewardDraftInput({
        name: 'Synthetic linkage reward',
        description: '',
        rewardType: xp ? 'xp' : 'digital',
        inventoryMode: 'unlimited',
        ...(xp ? { xpAmount: '250' } : {}),
      }),
    });
    if (reward.draft === null) throw new Error('Missing reward draft.');
    const box = await catalog.createBox({
      ...scope,
      ...parseBoxDraftInput({
        name: 'Synthetic linkage Drop',
        description: '',
        openingCompatibilityVersion: 'opening-v2',
        maxOpeningsPerUser: '100',
      }),
    });
    await catalog.replaceDraftConfiguration({
      ...scope,
      boxId: box.id,
      entries: [{ rewardVersionId: reward.draft.id, weight: 1n as ProbabilityWeight }],
      expectedRevision: 1,
      openingCompatibilityVersion: 'opening-v2',
    });
    return {
      ...(await catalog.publishBox({ ...scope, boxId: box.id, expectedRevision: 2 })),
      boxId: box.id,
    };
  };
  const first = await createBox(true);
  const second = await createBox(false);
  const grant = async (boxId: BoxId, fan = userId, quantity = 1) => {
    const grantId = randomUUID();
    await admin.query(
      `select app_private.grant_opening_entitlement(
      $1,$2,$3,$4,$6,'r4_usage_integration',$5,null,'Synthetic R4 usage fixture')`,
      [grantId, fan, creatorId, boxId, randomUUID(), quantity],
    );
    return grantId;
  };
  await grant(first.boxId);
  const initial = await fairness.initialize({ userId, requestId: randomUUID() });
  const clientSeed = 'ab'.repeat(32) as ClientSeed;
  await fairness.updateClientSeed({
    userId,
    requestId: randomUUID(),
    clientSeed,
    expectedRevision: initial.fairness.revision,
    expectedSeedSetId: initial.fairness.activeSeedSet.id,
    expectedServerSeedCommitment: initial.fairness.activeSeedSet.commitment,
  });
  const command = (box: typeof first, key = randomUUID()) => ({
    userId,
    boxId: box.boxId,
    clientSeed,
    expectedSeedSetId: initial.fairness.activeSeedSet.id,
    expectedServerSeedCommitment: initial.fairness.activeSeedSet.commitment,
    expectedBoxVersionId: box.version.id,
    expectedConfigurationHash: box.configurationHash,
    idempotencyKey: `r4_usage_${key}`,
    requestId: randomUUID(),
  });
  const read = (query: unknown = { period: 'lifetime' }, clock?: Date, actorUserId = owner) =>
    createCreatorUsageService({ database, ...(clock ? { now: () => clock } : {}) }).read(
      { creatorId, actorUserId },
      creatorUsageQuerySchema.parse(query),
    );
  return { userId, owner, creatorId, first, second, command, grant, read, createBox };
};

// Only the opening's injected database timestamp is fixed; production inserts/constraints still run.
const atTime = (timestamp: string): Database => ({
  ...database,
  transaction: (callback, options) =>
    database.transaction(async (transaction) => {
      const query = transaction.query.bind(transaction);
      transaction.query = (sql, values) =>
        query(
          sql === 'select clock_timestamp() as value' ? 'select $1::timestamptz as value' : sql,
          sql === 'select clock_timestamp() as value' ? [timestamp] : values,
        );
      return callback(transaction);
    }, options),
});
const counts = (hosted: string, creator = hosted, universal = '0') => ({
  hostedOpenings: hosted,
  creatorEntitlementOpenings: creator,
  universalEntryOpenings: universal,
});

describe('R4 authoritative hosted usage', { concurrent: false }, () => {
  afterAll(async () => {
    await Promise.all([database.close(), admin.close()]);
  });

  it('counts creator and Universal openings once, preserves XP, and ignores retries/failures', async () => {
    const state = await fixture();
    expect((await state.read()).usage.totals.lifetime).toEqual(counts('0'));
    const check = vi.fn<CreatorOpeningCapacity['check']>(() => Promise.resolve());
    const service = createOpeningService({
      database,
      fairnessService: fairness,
      logger,
      creatorOpeningCapacity: { check },
    });
    const command = state.command(state.first);
    const first = await service.openBox(command);
    expect(first.body.opening).toMatchObject({
      progression: { xpAwarded: '250', universalEntriesGranted: '1' },
    });
    for (let retry = 0; retry < 10; retry += 1)
      expect(await service.openBox(command)).toMatchObject({ body: first.body, replayed: true });
    expect(check).toHaveBeenCalledTimes(1);
    const persisted = (
      await admin.query<{ id: string; created_at: Date }>(
        'select id,created_at from app.box_opens where public_id=$1',
        [first.body.opening.id],
      )
    ).rows[0];
    expect(typeof check.mock.calls[0]?.[0].query).toBe('function');
    expect(check.mock.calls[0]?.[1]).toEqual({
      creatorId: state.creatorId,
      boxId: state.first.boxId,
      boxVersionId: state.first.version.id,
      openingId: persisted?.id,
      occurredAt: persisted?.created_at.toISOString(),
    });
    expect((await state.read()).usage.totals.lifetime).toEqual(counts('1'));
    const second = await openings.openBox(state.command(state.second));
    expect(second.body.opening).toMatchObject({
      entitlement: { source: 'universal', universalEntriesRemaining: '0' },
    });
    expect((await state.read()).usage.totals.lifetime).toEqual(counts('2', '1', '1'));
    await expect(openings.openBox(state.command(state.second))).rejects.toThrow();
    await expect(
      openings.openBox({ ...command, clientSeed: 'cd'.repeat(32) as ClientSeed }),
    ).rejects.toThrow();
    const result = (await state.read()).usage;
    expect(result.totals.lifetime).toEqual(counts('2', '1', '1'));
    expect(result.drops.reduce((total, drop) => total + BigInt(drop.hostedOpenings), 0n)).toBe(2n);
    expect(JSON.stringify(result)).not.toMatch(/userId|grantId|openingId|evidence|entitlementId/u);
  });

  it('attributes a Universal Entry to the destination creator, with no increment for its origin', async () => {
    const origin = await fixture();
    const destination = await fixture();
    await openings.openBox(origin.command(origin.first));
    await openings.openBox(origin.command(destination.second));
    expect((await origin.read()).usage.totals.lifetime).toEqual(counts('1'));
    expect((await destination.read()).usage.totals.lifetime).toEqual(counts('1', '0', '1'));
    expect((await openings.getProgression(origin.userId)).progression).toMatchObject({
      lifetimeXp: '250',
      universalEntriesAvailable: '0',
    });
  });

  it('rolls back usage, consumption, nonce, progression and outbox after all writes', async () => {
    const state = await fixture();
    const rolledBack: Database = {
      ...database,
      transaction: (callback, options) =>
        database.transaction(async (transaction) => {
          await callback(transaction);
          const inside = await transaction.query<{ count: string }>(
            `select count(*)::text as count from app.box_opens where creator_id=$1`,
            [state.creatorId],
          );
          expect(inside.rows[0]?.count).toBe('1');
          expect((await state.read()).usage.totals.lifetime).toEqual(counts('0'));
          throw new Error('Synthetic failure after opening writes');
        }, options),
    };
    const service = createOpeningService({
      database: rolledBack,
      fairnessService: fairness,
      logger,
    });
    const command = state.command(state.first);
    const before = await fairness.getCurrent(state.userId);
    await expect(service.openBox(command)).rejects.toThrow(
      'Synthetic failure after opening writes',
    );
    expect((await state.read()).usage.totals.lifetime).toEqual(counts('0'));
    expect((await openings.getProgression(state.userId)).progression).toMatchObject({
      lifetimeXp: '0',
      universalEntriesAvailable: '0',
    });
    expect(await fairness.getCurrent(state.userId)).toEqual(before);
    expect(
      (await openings.getEntitlementState({ userId: state.userId, boxId: state.first.boxId }))
        .entitlement,
    ).toMatchObject({ remaining: '1' });
    const orphaned = await admin.query<{ consumptions: string; outbox: string }>(
      `select
      (select count(*)::text from app.opening_entitlement_consumptions where user_id=$1) as consumptions,
      (select count(*)::text from app.event_outbox where payload::text like '%' || $2::text || '%') as outbox`,
      [state.userId, state.first.boxId],
    );
    expect(orphaned.rows).toEqual([{ consumptions: '0', outbox: '0' }]);
    await openings.openBox(command);
    expect((await state.read()).usage.totals.lifetime).toEqual(counts('1'));
  });

  it('counts 100 concurrent successful commands exactly and concurrent replay only once', async () => {
    const state = await fixture();
    const commands = await Promise.all(
      Array.from({ length: 100 }, async () => {
        const userId = randomUUID() as UserId;
        await database.query(
          `insert into app.users(id,auth_provider,auth_subject,username) values($1,'synthetic-r4',$1::uuid::text,$2)`,
          [userId, `r4_${userId.replaceAll('-', '')}`],
        );
        await state.grant(state.second.boxId, userId);
        const initial = await fairness.initialize({ userId, requestId: randomUUID() });
        const clientSeed = 'ab'.repeat(32) as ClientSeed;
        await fairness.updateClientSeed({
          userId,
          requestId: randomUUID(),
          clientSeed,
          expectedRevision: initial.fairness.revision,
          expectedSeedSetId: initial.fairness.activeSeedSet.id,
          expectedServerSeedCommitment: initial.fairness.activeSeedSet.commitment,
        });
        return {
          ...state.command(state.second),
          userId,
          expectedSeedSetId: initial.fairness.activeSeedSet.id,
          expectedServerSeedCommitment: initial.fairness.activeSeedSet.commitment,
        };
      }),
    );
    // First eight transactions rendezvous before RNG; the pool admits later requests as they commit.
    let releaseGate: () => void = () => {
      throw new Error('Uninitialized barrier');
    };
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let entered = 0;
    const service = createOpeningService({
      database,
      fairnessService: fairness,
      logger,
      creatorOpeningCapacity: {
        check: async () => {
          entered += 1;
          if (entered === 8) releaseGate();
          await gate;
        },
      },
    });
    const receipts = await Promise.all(commands.map((command) => service.openBox(command)));
    expect(new Set(receipts.map((receipt) => receipt.body.opening.id)).size).toBe(100);
    expect((await state.read()).usage.totals.lifetime).toEqual(counts('100'));
    const first = commands[0];
    if (!first) throw new Error('Missing command.');
    expect(
      (await Promise.all(Array.from({ length: 8 }, () => service.openBox(first)))).every(
        (receipt) => receipt.replayed,
      ),
    ).toBe(true);
    const raw = await admin.query<{ openings: string; facts: string; consumptions: string }>(
      `select
      (select count(*)::text from app.box_opens where creator_id=$1) as openings,
      (select count(*)::text from app_private.hosted_opening_usage where creator_id=$1) as facts,
      (select count(*)::text from app.opening_entitlement_consumptions where creator_id=$1) as consumptions`,
      [state.creatorId],
    );
    expect(raw.rows).toEqual([{ openings: '100', facts: '100', consumptions: '100' }]);
  }, 60_000);

  it('reconciles UTC boundaries, custom ranges, stable Drop versions and cursor pages', async () => {
    const state = await fixture();
    await state.grant(state.second.boxId, state.userId, 10);
    let second = state.second;
    const times = [
      '2028-01-31T23:59:59.999Z',
      '2028-02-01T00:00:00Z',
      '2028-02-14T11:59:59.999Z',
      '2028-02-14T12:00:00Z',
      '2028-02-29T23:59:59.999Z',
      '2028-03-01T00:00:00Z',
      '2028-03-15T11:59:59.999Z',
      '2028-03-15T12:00:00Z',
    ];
    for (const [index, time] of times.entries()) {
      if (index === 4) {
        const scope = {
          creatorId: state.creatorId,
          actorUserId: state.owner,
          requestId: randomUUID(),
        };
        const current = await catalog.getBox(scope, second.boxId);
        await catalog.updateBox({
          ...scope,
          boxId: second.boxId,
          expectedRevision: current.revision,
          ...parseBoxDraftInput({
            name: 'Synthetic renamed usage Drop',
            description: '',
            openingCompatibilityVersion: 'opening-v2',
            maxOpeningsPerUser: '100',
          }),
        });
        const draft = await catalog.getBox(scope, second.boxId);
        second = {
          ...(await catalog.publishBox({
            ...scope,
            boxId: second.boxId,
            expectedRevision: draft.revision,
          })),
          boxId: second.boxId,
        };
      }
      await createOpeningService({
        database: atTime(time),
        fairnessService: fairness,
        logger,
      }).openBox(state.command(second));
    }
    await createOpeningService({
      database: atTime('2028-03-02T00:00:00Z'),
      fairnessService: fairness,
      logger,
    }).openBox(state.command(state.first));
    const clock = new Date('2028-03-15T12:00:00Z');
    const result = (
      await state.read(
        {
          period: 'custom',
          start: '2028-02-01T00:00:00Z',
          end: '2028-03-01T00:00:00Z',
          limit: '1',
        },
        clock,
      )
    ).usage;
    expect(result.totals).toEqual({
      lifetime: counts('8'),
      currentMonth: counts('3'),
      previousMonth: counts('4'),
      last30Days: counts('5'),
      selected: counts('4'),
    });
    await database.transaction(async (transaction) => {
      await transaction.query("set local timezone = 'America/New_York'");
      const zoned = await readCreatorUsage(transaction, {
        actorUserId: state.owner,
        creatorId: state.creatorId,
        start: '2028-02-01T00:00:00Z',
        end: '2028-03-01T00:00:00Z',
        asOf: clock.toISOString(),
        after: undefined,
        limit: 1,
      });
      expect(zoned.totals).toEqual(result.totals);
    });
    expect(result.drops).toEqual([
      { boxId: second.boxId, name: 'Synthetic renamed usage Drop', ...counts('4') },
    ]);
    const page1 = (await state.read({ period: 'lifetime', limit: '1' }, clock)).usage;
    expect(page1.nextCursor).toBe(page1.drops[0]?.boxId);
    const page2 = (
      await state.read({ period: 'lifetime', limit: '1', after: page1.nextCursor }, clock)
    ).usage;
    expect(page2.nextCursor).toBeNull();
    expect([...page1.drops, ...page2.drops].map((drop) => drop.boxId)).toEqual(
      [state.first.boxId, state.second.boxId].sort(),
    );
    expect(
      [...page1.drops, ...page2.drops].reduce((sum, drop) => sum + BigInt(drop.hostedOpenings), 0n),
    ).toBe(8n);
    expect(
      (await state.read({ period: 'current_month' }, new Date('2028-03-01T00:00:00Z'))).usage.totals
        .selected,
    ).toEqual(counts('0'));
  });

  it('enforces real PostgreSQL membership, role, active account and creator scope on HTTP reads', async () => {
    const state = await fixture();
    const another = await fixture();
    const service = createCreatorUsageService({ database });
    const get = (userId: UserId, creatorId = state.creatorId) =>
      request(
        createTestApp({
          usageService: service,
          authenticate: (req, _res, next) => {
            req.actor = {
              provider: 'synthetic',
              subject: userId,
              user: { id: userId, status: 'active', username: 'synthetic' },
            };
            next();
          },
        }),
      ).get(`/v1/creators/${creatorId}/usage`);
    await get(state.owner).expect(200);
    await get(another.owner).expect(404);
    await get(state.userId).expect(404);
    await get(state.owner, another.creatorId).expect(404);
    for (const role of ['manager', 'editor', 'viewer']) {
      await database.query(
        `insert into app.creator_memberships(creator_id,user_id,role) values($1,$2,$3) on conflict(creator_id,user_id) do update set role=excluded.role`,
        [state.creatorId, state.userId, role],
      );
      await get(state.userId).expect(role === 'manager' ? 200 : 403);
    }
    await database.query(`update app.users set status='suspended' where id=$1`, [state.owner]);
    await get(state.owner).expect(403);
    await database.query(`update app.users set status='active' where id=$1`, [state.owner]);
    await database.query(`update app.creators set status='suspended' where id=$1`, [
      state.creatorId,
    ]);
    await get(state.owner).expect(404);
  });

  it('denies runtime and public direct facts, mutation, and private reader access', async () => {
    await expect(
      database.query('select * from app_private.hosted_opening_usage'),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      database.query('delete from app_private.hosted_opening_usage'),
    ).rejects.toMatchObject({ code: '42501' });
    const privileges = await admin.query<{ role: string; allowed: boolean }>(
      `select role, has_function_privilege(role,'app.read_creator_hosted_usage(uuid,uuid,timestamptz,timestamptz,timestamptz,uuid,integer)','execute') as allowed from unnest(array['anon','authenticated','creatordrop_worker']) as role`,
    );
    expect(privileges.rows.every((row) => !row.allowed)).toBe(true);
    const legacy = await admin.query<{ count: string }>(
      `select count(*)::text as count from app_private.hosted_opening_usage as usage join app.box_opens as opening on opening.id=usage.opening_id where opening.opening_compatibility_version is distinct from 'opening-v2'`,
    );
    expect(legacy.rows).toEqual([{ count: '0' }]);
  });
});
