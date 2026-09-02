import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseDatabaseEnvironment, parseMigrationEnvironment } from '@creatordrop/config';
import { createDatabasePool, type Database } from '@creatordrop/database';
import { createConsoleLogger } from '@creatordrop/observability';
import {
  createLeaderboardProjectionStore,
  createRedisConnection,
  type LeaderboardScope,
} from '@creatordrop/redis-projections';

import {
  createLeaderboardReconciler,
  finalizeEndedSeasons,
} from '../src/leaderboards/leaderboard.maintenance.js';
import { createLeaderboardProjectionProcessor } from '../src/leaderboards/leaderboard.processor.js';
import { createLeaderboardRepository } from '../src/leaderboards/leaderboard.repository.js';

const migrationUrl = parseMigrationEnvironment({
  DATABASE_MIGRATION_URL:
    process.env.DATABASE_MIGRATION_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
}).connectionString;
const workerUrl = new URL(migrationUrl);
workerUrl.searchParams.set('options', '-c role=creatordrop_worker');

const databaseOptions = (connectionString: string, applicationName: string) =>
  parseDatabaseEnvironment({
    DATABASE_APPLICATION_NAME: applicationName,
    DATABASE_CONNECTION_TIMEOUT_MS: '5000',
    DATABASE_IDLE_TIMEOUT_MS: '1000',
    DATABASE_POOL_MAX: '4',
    DATABASE_URL: connectionString,
  });

const logger = createConsoleLogger({ service: 'leaderboard-integration' });
const redis = createRedisConnection({
  onError: () => undefined,
  url: process.env.REDIS_URL ?? 'redis://127.0.0.1:56379',
});
const store = createLeaderboardProjectionStore(redis);
let admin: Database;
let firstWorker: Database;
let secondWorker: Database;

const alice = randomUUID();
const bob = randomUUID();
const charlie = randomUUID();
const creatorA = randomUUID();
const creatorB = randomUUID();
const seasonId = randomUUID();

interface OpeningFixture {
  readonly creatorId: string;
  readonly eventId: string;
  readonly openingId: string;
  readonly points: 5 | 20;
  readonly timestamp: string;
  readonly userId: string;
}

const fixtures: OpeningFixture[] = [
  {
    creatorId: creatorA,
    eventId: randomUUID(),
    openingId: randomUUID(),
    points: 20,
    timestamp: '2025-01-02T00:00:00.000Z',
    userId: alice,
  },
  {
    creatorId: creatorA,
    eventId: randomUUID(),
    openingId: randomUUID(),
    points: 5,
    timestamp: '2025-01-03T00:00:00.000Z',
    userId: alice,
  },
  {
    creatorId: creatorB,
    eventId: randomUUID(),
    openingId: randomUUID(),
    points: 5,
    timestamp: '2025-01-04T00:00:00.000Z',
    userId: alice,
  },
  {
    creatorId: creatorA,
    eventId: randomUUID(),
    openingId: randomUUID(),
    points: 20,
    timestamp: '2025-01-05T00:00:00.000Z',
    userId: bob,
  },
  {
    creatorId: creatorB,
    eventId: randomUUID(),
    openingId: randomUUID(),
    points: 5,
    timestamp: '2025-01-06T00:00:00.000Z',
    userId: bob,
  },
  {
    creatorId: creatorB,
    eventId: randomUUID(),
    openingId: randomUUID(),
    points: 5,
    timestamp: '2025-01-07T00:00:00.000Z',
    userId: bob,
  },
];

const insertOpening = async (opening: OpeningFixture): Promise<void> => {
  const values = Array.from({ length: 12 }, () => randomUUID());
  await admin.transaction(async (transaction) => {
    await transaction.query(`set local session_replication_role = replica`);
    await transaction.query(
      `insert into app.box_opens (
         id, public_id, user_id, creator_id, box_id, box_version_id,
         selected_box_version_reward_id, reward_version_id, inventory_pool_id,
         rng_seed_set_id, nonce, client_seed, server_seed_commitment,
         rng_algorithm_version, rng_digest, rng_selection, rng_selection_round,
         configuration_hash, gross_price_minor, currency, platform_fee_bps,
         platform_fee_minor, creator_share_minor, earnings_available_at,
         points_policy_version, base_points, bonus_points, points_awarded,
         sale_ledger_transaction_id, allocation_ledger_transaction_id,
         idempotency_record_id, status, created_at
       ) values (
         $1,$2,$3,$4,$5,$6,$7,$8,null,$9,0,'leaderboard-test',decode(repeat('01',32),'hex'),
         'hmac-sha256-rejection-v1',decode(repeat('02',32),'hex'),0,0,
         decode(repeat('03',32),'hex'),1000,'USD',2000,200,800,$10,
         'leaderboard-v1',5,$11,$12,$13,$14,$15,'completed',$16
       )`,
      [
        opening.openingId,
        values[0],
        opening.userId,
        opening.creatorId,
        values[1],
        values[2],
        values[3],
        values[4],
        values[5],
        new Date(new Date(opening.timestamp).getTime() + 14 * 86_400_000),
        opening.points === 20 ? 15 : 0,
        opening.points,
        values[6],
        values[7],
        values[8],
        opening.timestamp,
      ],
    );
  });
  await admin.query(
    `insert into app.event_outbox (
       id, aggregate_type, aggregate_id, event_type, audience, payload, occurred_at, created_at
     ) values ($1,'box_open',$2,'opening.completed.v1','private','{}',$3,$3)`,
    [opening.eventId, opening.openingId, opening.timestamp],
  );
};

const processEveryClaim = async (): Promise<void> => {
  const repository = createLeaderboardRepository(firstWorker);
  const processor = createLeaderboardProjectionProcessor({
    batchSize: 100,
    leaseMs: 30_000,
    logger,
    maxAttempts: 32,
    repository,
    retryBaseMs: 100,
    retryMaxMs: 1_000,
    store,
    workerId: `leaderboard-test:${randomUUID()}`,
  });
  for (
    let count = await processor.processBatch();
    count > 0;
    count = await processor.processBatch()
  ) {
    // Each bounded claim batch is durably acknowledged before the next one.
  }
};

describe('Phase 13 PostgreSQL and Redis leaderboard lifecycle', () => {
  beforeAll(async () => {
    admin = createDatabasePool({
      ...databaseOptions(migrationUrl, 'leaderboard-test-admin'),
      onUnexpectedPoolError: () => undefined,
    });
    firstWorker = createDatabasePool({
      ...databaseOptions(workerUrl.toString(), 'leaderboard-test-worker-one'),
      onUnexpectedPoolError: () => undefined,
    });
    secondWorker = createDatabasePool({
      ...databaseOptions(workerUrl.toString(), 'leaderboard-test-worker-two'),
      onUnexpectedPoolError: () => undefined,
    });
    await redis.sendCommand(['FLUSHDB']);
    await admin.transaction(async (transaction) => {
      await transaction.query(`set local session_replication_role = replica`);
      await transaction.query(
        `delete from app.leaderboard_projection_events
          where outbox_event_id in (
            select event.id from app.event_outbox as event
            join app.box_opens as opening on opening.id = event.aggregate_id
            join app.users as users on users.id = opening.user_id
            where users.auth_provider = 'leaderboard-test'
          )`,
      );
      await transaction.query(
        `delete from app.event_outbox where aggregate_id in (
           select opening.id from app.box_opens as opening
           join app.users as users on users.id = opening.user_id
           where users.auth_provider = 'leaderboard-test'
         )`,
      );
      await transaction.query(
        `delete from app.creators where id in (
           select distinct opening.creator_id from app.box_opens as opening
           join app.users as users on users.id = opening.user_id
           where users.auth_provider = 'leaderboard-test'
         )`,
      );
      await transaction.query(
        `delete from app.box_opens where user_id in (
           select id from app.users where auth_provider = 'leaderboard-test'
         )`,
      );
      await transaction.query(
        `delete from app.user_achievements where season_id in (
           select id from app.leaderboard_seasons where name = 'Synthetic Season 13'
         )`,
      );
      await transaction.query(
        `delete from app.leaderboard_season_results where season_id in (
           select id from app.leaderboard_seasons where name = 'Synthetic Season 13'
         )`,
      );
      await transaction.query(
        `delete from app.leaderboard_seasons where name = 'Synthetic Season 13'`,
      );
      await transaction.query(`delete from app.users where auth_provider = 'leaderboard-test'`);
    });
    await admin.transaction(async (transaction) => {
      await transaction.query(`set local session_replication_role = replica`);
      await transaction.query(
        `insert into app.users (id, auth_provider, auth_subject, username) values
           ($1::uuid,'leaderboard-test',$1::uuid::text,'alice'),
           ($2::uuid,'leaderboard-test',$2::uuid::text,'bob'),
           ($3::uuid,'leaderboard-test',$3::uuid::text,'charlie')`,
        [alice, bob, charlie],
      );
      await transaction.query(
        `insert into app.creators (id, handle, custom_slug, display_name) values
           ($1,$3,$4,'Creator A'), ($2,$5,$6,'Creator B')`,
        [
          creatorA,
          creatorB,
          `ca_${creatorA.replaceAll('-', '').slice(0, 20)}`,
          `ca-${creatorA.replaceAll('-', '').slice(0, 20)}`,
          `cb_${creatorB.replaceAll('-', '').slice(0, 20)}`,
          `cb-${creatorB.replaceAll('-', '').slice(0, 20)}`,
        ],
      );
    });
    await admin.query(
      `insert into app.leaderboard_seasons (id, ordinal, name, starts_at, ends_at)
       values ($1, 130001, 'Synthetic Season 13', '2025-01-01', '2025-04-01')`,
      [seasonId],
    );
    await admin.query(`select app_private.activate_leaderboard_season($1)`, [seasonId]);
    for (const fixture of fixtures) await insertOpening(fixture);
  });

  afterAll(async () => {
    await redis.sendCommand(['FLUSHDB']);
    await Promise.all([admin.close(), firstWorker.close(), secondWorker.close(), redis.close()]);
  });

  it('projects, replays, rebuilds, reconciles, and finalizes authoritative rankings', async () => {
    const firstRepository = createLeaderboardRepository(firstWorker);
    const secondRepository = createLeaderboardRepository(secondWorker);
    const reconciler = createLeaderboardReconciler(firstRepository, store);
    // Other serial integration files may have durable applied history while Redis is disposable.
    await reconciler.rebuild();

    const [firstClaims, secondClaims] = await Promise.all([
      firstRepository.claim({
        batchSize: 1,
        leaseMs: 30_000,
        maxAttempts: 32,
        workerId: 'worker:first',
      }),
      secondRepository.claim({
        batchSize: 1,
        leaseMs: 30_000,
        maxAttempts: 32,
        workerId: 'worker:second',
      }),
    ]);
    expect(firstClaims).toHaveLength(1);
    expect(secondClaims).toHaveLength(1);
    expect(firstClaims[0]?.eventId).not.toBe(secondClaims[0]?.eventId);
    for (const [repository, claim] of [
      [firstRepository, firstClaims[0]],
      [secondRepository, secondClaims[0]],
    ] as const) {
      if (claim === undefined) throw new Error('Expected a projection claim.');
      const snapshot = await repository.readSnapshot(claim.eventId);
      if (snapshot === undefined) throw new Error('Expected a projection snapshot.');
      await store.apply(snapshot);
      await repository.complete(claim.eventId, claim.claimToken);
    }
    await processEveryClaim();

    const globalSeason: LeaderboardScope = {
      creatorId: null,
      periodType: 'season',
      scopeType: 'global',
      seasonId,
    };
    expect(await store.read(globalSeason)).toMatchObject({
      rows: [
        { baseRewardWins: '1', points: '30', rank: 1, totalOpenings: '3', username: 'alice' },
        { baseRewardWins: '1', points: '30', rank: 2, totalOpenings: '3', username: 'bob' },
      ],
    });
    expect(
      await store.read({
        creatorId: creatorA,
        periodType: 'season',
        scopeType: 'creator',
        seasonId,
      }),
    ).toMatchObject({
      rows: [
        { points: '25', username: 'alice' },
        { points: '20', username: 'bob' },
      ],
    });
    expect(
      await store.read({
        creatorId: creatorB,
        periodType: 'season',
        scopeType: 'creator',
        seasonId,
      }),
    ).toMatchObject({
      rows: [
        { points: '10', username: 'bob' },
        { points: '5', username: 'alice' },
      ],
    });

    const outsideSeason: OpeningFixture = {
      creatorId: creatorA,
      eventId: randomUUID(),
      openingId: randomUUID(),
      points: 5,
      timestamp: '2025-05-01T00:00:00.000Z',
      userId: charlie,
    };
    await insertOpening(outsideSeason);
    let crashedClaim;
    for (;;) {
      const [claim] = await firstRepository.claim({
        batchSize: 1,
        leaseMs: 30_000,
        maxAttempts: 32,
        workerId: 'worker:crashed',
      });
      if (claim === undefined) throw new Error('The crash-window event was not claimable.');
      const snapshot = await firstRepository.readSnapshot(claim.eventId);
      if (snapshot === undefined) throw new Error('Expected a crash-window snapshot.');
      await store.apply(snapshot);
      if (claim.eventId === outsideSeason.eventId) {
        crashedClaim = claim;
        break;
      }
      await firstRepository.complete(claim.eventId, claim.claimToken);
    }
    await admin.query(
      `update app.leaderboard_projection_events
          set lease_expires_at = clock_timestamp() - interval '1 second'
        where outbox_event_id = $1 and claim_token = $2`,
      [crashedClaim.eventId, crashedClaim.claimToken],
    );
    await processEveryClaim();
    const recoveredProjection = await store.read({
      creatorId: null,
      periodType: 'all_time',
      scopeType: 'global',
      seasonId: null,
    });
    expect(
      recoveredProjection?.rows.some(
        (row) => row.points === '5' && row.totalOpenings === '1' && row.username === 'charlie',
      ),
    ).toBe(true);

    expect(await reconciler.reconcile()).toEqual([]);
    await store.apply({
      boards: [
        {
          asOf: '2025-06-01T00:00:00.000Z',
          baseRewardWins: '0',
          creatorId: null,
          periodType: 'all_time',
          points: '999',
          scoreReachedAt: '2025-06-01T00:00:00.000Z',
          scoreReachedAtMicros: '1748736000000000',
          scopeType: 'global',
          seasonId: null,
          totalOpenings: '999',
          userId: charlie,
          username: 'charlie',
        },
      ],
      eventId: randomUUID(),
      openingId: randomUUID(),
    });
    expect(await reconciler.reconcile()).not.toEqual([]);
    await reconciler.rebuild();
    expect(await reconciler.reconcile()).toEqual([]);

    await admin.query(
      `update app.leaderboard_projection_events
          set status = 'dead', claimed_by = null, claim_token = null,
              lease_expires_at = null, applied_at = null,
              last_error_code = 'MAX_ATTEMPTS_EXHAUSTED'
        where outbox_event_id = $1`,
      [outsideSeason.eventId],
    );
    const beforeLoss = await store.read(globalSeason);
    await redis.sendCommand(['FLUSHDB']);
    await reconciler.rebuild();
    expect(await store.read(globalSeason)).toEqual(beforeLoss);
    expect(
      (
        await admin.query<{ readonly status: string }>(
          `select status from app.leaderboard_projection_events where outbox_event_id = $1`,
          [outsideSeason.eventId],
        )
      ).rows,
    ).toEqual([{ status: 'dead' }]);

    expect(await finalizeEndedSeasons({ logger, reconciler, repository: firstRepository })).toBe(1);
    await Promise.all([
      firstRepository.finalizeSeason(seasonId),
      secondRepository.finalizeSeason(seasonId),
    ]);
    const results = await admin.query<{
      readonly achievementType: string;
      readonly creatorId: string | null;
      readonly username: string;
    }>(
      `select achievement.achievement_type as "achievementType",
              achievement.creator_id as "creatorId", users.username::text as username
         from app.user_achievements as achievement
         join app.users as users on users.id = achievement.user_id
        where achievement.season_id = $1
        order by achievement.achievement_type, achievement.creator_id`,
      [seasonId],
    );
    expect(results.rows).toHaveLength(3);
    expect(results.rows).toContainEqual({
      achievementType: 'creator_season_champion',
      creatorId: creatorA,
      username: 'alice',
    });
    expect(results.rows).toContainEqual({
      achievementType: 'creator_season_champion',
      creatorId: creatorB,
      username: 'bob',
    });
    expect(results.rows).toContainEqual({
      achievementType: 'global_season_champion',
      creatorId: null,
      username: 'alice',
    });
    await expect(
      firstWorker.query(
        `insert into app.user_achievements (
           season_result_id,user_id,achievement_type,season_id,creator_id,awarded_at
         ) values ($1,$2,'global_season_champion',$3,null,clock_timestamp())`,
        [randomUUID(), alice, seasonId],
      ),
    ).rejects.toThrow(/permission denied/iu);
  }, 30_000);
});
