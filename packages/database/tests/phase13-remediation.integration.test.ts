import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseDatabaseEnvironment, parseMigrationEnvironment } from '@creatordrop/config';

import { createDatabasePool, type Database, type QueryExecutor } from '../src/index.js';

const localApplicationUrl =
  'postgresql://postgres:postgres@127.0.0.1:54322/postgres?options=-c%20role%3Dcreatordrop_app';
const localMigrationUrl = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const migrationEnvironment = parseMigrationEnvironment({
  DATABASE_MIGRATION_URL: process.env.DATABASE_MIGRATION_URL ?? localMigrationUrl,
});

const databaseOptions = (connectionString: string, applicationName: string, maxConnections = 2) =>
  parseDatabaseEnvironment({
    DATABASE_APPLICATION_NAME: applicationName,
    DATABASE_CONNECTION_TIMEOUT_MS: '5000',
    DATABASE_IDLE_TIMEOUT_MS: '1000',
    DATABASE_POOL_MAX: maxConnections.toString(),
    DATABASE_URL: connectionString,
  });

const workerUrl = new URL(migrationEnvironment.connectionString);
workerUrl.searchParams.set('options', '-c role=creatordrop_worker');

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
}

const createDeferred = <Value>(): Deferred<Value> => {
  let resolvePromise: (value: Value) => void = () => {
    throw new Error('Deferred promise was resolved before initialization.');
  };
  const promise = new Promise<Value>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
};

type Settlement =
  { readonly status: 'fulfilled' } | { readonly reason: unknown; readonly status: 'rejected' };

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
  if (backendPid === undefined) throw new Error('PostgreSQL did not return a backend PID.');
  return backendPid;
};

const observeBlocking = async (
  inspector: QueryExecutor,
  waiterPid: number,
  blockerPid: number,
  settlement: Promise<Settlement>,
): Promise<'blocked' | 'settled'> => {
  let observedSettlement: Settlement | undefined;
  void settlement.then((result) => {
    observedSettlement = result;
  });
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const result = await inspector.query<{ readonly blocked: boolean }>(
      `select $2::integer = any(pg_catalog.pg_blocking_pids($1::integer)) as blocked`,
      [waiterPid, blockerPid],
    );
    if (result.rows[0]?.blocked === true) return 'blocked';
    if (observedSettlement !== undefined) return 'settled';
  }
  throw new Error('The concurrent season operation neither blocked nor settled.');
};

const provider = 'phase13-remediation-test';
const userId = randomUUID();
const creatorId = randomUUID();
const seasonPrefix = 'Phase 13 remediation';

const insertSyntheticOpening = async (
  transaction: QueryExecutor,
  input: {
    readonly bypassUnrelatedConstraints?: boolean;
    readonly createdAt: string;
    readonly openingId: string;
  },
): Promise<void> => {
  const values = Array.from({ length: 11 }, () => randomUUID());
  if (input.bypassUnrelatedConstraints === true) {
    await transaction.query(`set local session_replication_role = replica`);
  }
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
       $1,$2,$3,$4,$5,$6,$7,$8,null,$9,0,'phase13-remediation',
       decode(repeat('11',32),'hex'),'hmac-sha256-rejection-v1',
       decode(repeat('12',32),'hex'),0,0,decode(repeat('13',32),'hex'),
       1000,'USD',2000,200,800,$10::timestamptz + interval '14 days',
       'leaderboard-v1',5,15,20,$11,$12,$13,'completed',$10
     )`,
    [
      input.openingId,
      values[0],
      userId,
      creatorId,
      values[1],
      values[2],
      values[3],
      values[4],
      values[5],
      input.createdAt,
      values[6],
      values[7],
      values[8],
    ],
  );
};

const createEndedSeason = async (
  database: Database,
  input: {
    readonly endsAt: string;
    readonly name: string;
    readonly ordinal: number;
    readonly startsAt: string;
  },
): Promise<string> => {
  const seasonId = randomUUID();
  await database.query(
    `insert into app.leaderboard_seasons (id, ordinal, name, starts_at, ends_at)
     values ($1,$2,$3,$4,$5)`,
    [seasonId, input.ordinal, input.name, input.startsAt, input.endsAt],
  );
  await database.query(`select app_private.activate_leaderboard_season($1)`, [seasonId]);
  return seasonId;
};

const insertProjectionFixture = async (database: Database): Promise<string> => {
  const eventId = randomUUID();
  await database.transaction(async (transaction) => {
    await transaction.query(`set local session_replication_role = replica`);
    await transaction.query(
      `insert into app.event_outbox (
         id, aggregate_type, aggregate_id, event_type, audience, payload,
         occurred_at, created_at, available_at
       ) select $1,'box_open',$2,'opening.completed.v1','private',
                '{"phase13Remediation":true}'::jsonb,
                timestamp.value,timestamp.value,timestamp.value
           from (select clock_timestamp() as value) as timestamp`,
      [eventId, randomUUID()],
    );
    await transaction.query(
      `insert into app.leaderboard_projection_events (
         outbox_event_id, available_at, created_at
       ) values ($1,'1970-01-01T00:00:00Z','1970-01-01T00:00:00Z')`,
      [eventId],
    );
  });
  return eventId;
};

describe('Phase 13 High-severity remediation', { concurrent: false }, () => {
  let application: Database;
  let firstConnection: Database;
  let migration: Database;
  let secondConnection: Database;
  let worker: Database;

  const cleanup = async (): Promise<void> => {
    await migration.transaction(async (transaction) => {
      await transaction.query(`set local session_replication_role = replica`);
      await transaction.query(
        `delete from app.leaderboard_projection_events
          where outbox_event_id in (
            select id from app.event_outbox
             where payload @> '{"phase13Remediation":true}'::jsonb
          )`,
      );
      await transaction.query(
        `delete from app.event_outbox
          where payload @> '{"phase13Remediation":true}'::jsonb`,
      );
      await transaction.query(
        `delete from app.user_achievements where season_id in (
           select id from app.leaderboard_seasons where name like $1
         )`,
        [`${seasonPrefix}%`],
      );
      await transaction.query(
        `delete from app.leaderboard_season_results where season_id in (
           select id from app.leaderboard_seasons where name like $1
         )`,
        [`${seasonPrefix}%`],
      );
      await transaction.query(`delete from app.box_opens where user_id = $1`, [userId]);
      await transaction.query(`delete from app.leaderboard_seasons where name like $1`, [
        `${seasonPrefix}%`,
      ]);
      await transaction.query(`delete from app.creator_memberships where creator_id = $1`, [
        creatorId,
      ]);
      await transaction.query(`delete from app.creators where id = $1`, [creatorId]);
      await transaction.query(`delete from app.users where id = $1`, [userId]);
    });
  };

  beforeAll(async () => {
    application = createDatabasePool({
      ...databaseOptions(
        process.env.DATABASE_URL ?? localApplicationUrl,
        'phase13-remediation-application',
      ),
      onUnexpectedPoolError: () => undefined,
    });
    migration = createDatabasePool({
      ...databaseOptions(migrationEnvironment.connectionString, 'phase13-remediation-migration', 4),
      onUnexpectedPoolError: () => undefined,
    });
    firstConnection = createDatabasePool({
      ...databaseOptions(
        migrationEnvironment.connectionString,
        'phase13-remediation-concurrency-a',
        1,
      ),
      onUnexpectedPoolError: () => undefined,
    });
    secondConnection = createDatabasePool({
      ...databaseOptions(
        migrationEnvironment.connectionString,
        'phase13-remediation-concurrency-b',
        1,
      ),
      onUnexpectedPoolError: () => undefined,
    });
    worker = createDatabasePool({
      ...databaseOptions(workerUrl.toString(), 'phase13-remediation-worker', 1),
      onUnexpectedPoolError: () => undefined,
    });
    await cleanup();
    await migration.query(
      `insert into app.users (id,auth_provider,auth_subject,username)
       values ($1,$2,$3,$4)`,
      [userId, provider, userId, `phase13_${userId.replaceAll('-', '')}`],
    );
    await migration.transaction(async (transaction) => {
      await transaction.query(
        `insert into app.creators (id,handle,custom_slug,display_name)
         values ($1,$2,$3,'Phase 13 Remediation Creator')`,
        [
          creatorId,
          `p13_${creatorId.replaceAll('-', '').slice(0, 20)}`,
          `p13-${creatorId.replaceAll('-', '').slice(0, 20)}`,
        ],
      );
      await transaction.query(
        `insert into app.creator_memberships (creator_id,user_id,role)
         values ($1,$2,'owner')`,
        [creatorId, userId],
      );
    });
  });

  afterAll(async () => {
    await cleanup();
    await Promise.all([
      application.close(),
      firstConnection.close(),
      migration.close(),
      secondConnection.close(),
      worker.close(),
    ]);
  });

  it('serializes an in-flight qualifying opening before finalization', async () => {
    const startsAt = '1990-01-01T00:00:00.000Z';
    const endsAt = '1990-04-01T00:00:00.000Z';
    const openedAt = '1990-02-01T00:00:00.000Z';
    const seasonId = await createEndedSeason(migration, {
      endsAt,
      name: `${seasonPrefix} opening first`,
      ordinal: 230001,
      startsAt,
    });
    const openingId = randomUUID();
    const openingReady = createDeferred<boolean>();
    const releaseOpening = createDeferred<boolean>();
    let openingPid = 0;
    const opening = firstConnection.transaction(async (transaction) => {
      openingPid = await readBackendPid(transaction);
      await transaction.query(`select app.lock_leaderboard_season_for_opening($1)`, [openedAt]);
      await insertSyntheticOpening(transaction, {
        bypassUnrelatedConstraints: true,
        createdAt: openedAt,
        openingId,
      });
      openingReady.resolve(true);
      await releaseOpening.promise;
    });
    await openingReady.promise;

    const finalizerPid = await readBackendPid(secondConnection);
    const finalization = secondConnection.query(
      `select * from app.finalize_leaderboard_season($1)`,
      [seasonId],
    );
    const finalizationSettlement = trackSettlement(finalization);
    expect(await observeBlocking(migration, finalizerPid, openingPid, finalizationSettlement)).toBe(
      'blocked',
    );
    releaseOpening.resolve(true);
    await opening;
    await expect(finalizationSettlement).resolves.toEqual({ status: 'fulfilled' });

    const state = await migration.query<{
      readonly achievements: string;
      readonly creatorResults: string;
      readonly globalResults: string;
    }>(
      `select
         count(*) filter (where result.scope_type = 'global')::text as "globalResults",
         count(*) filter (where result.scope_type = 'creator')::text as "creatorResults",
         (select count(*)::text from app.user_achievements where season_id = $1) as achievements
       from app.leaderboard_season_results as result where result.season_id = $1`,
      [seasonId],
    );
    expect(state.rows).toEqual([{ achievements: '2', creatorResults: '1', globalResults: '1' }]);
  }, 20_000);

  it('rejects an in-boundary opening after finalization owns the season barrier', async () => {
    const startsAt = '1991-01-01T00:00:00.000Z';
    const endsAt = '1991-04-01T00:00:00.000Z';
    const openedAt = '1991-02-01T00:00:00.000Z';
    const seasonId = await createEndedSeason(migration, {
      endsAt,
      name: `${seasonPrefix} finalizer first`,
      ordinal: 230002,
      startsAt,
    });
    const finalizerReady = createDeferred<boolean>();
    const releaseFinalizer = createDeferred<boolean>();
    let finalizerPid = 0;
    const finalization = firstConnection.transaction(async (transaction) => {
      finalizerPid = await readBackendPid(transaction);
      await transaction.query(`select * from app.finalize_leaderboard_season($1)`, [seasonId]);
      finalizerReady.resolve(true);
      await releaseFinalizer.promise;
    });
    await finalizerReady.promise;

    const openingId = randomUUID();
    const openingStarted = createDeferred<boolean>();
    let openingPid = 0;
    const opening = secondConnection.transaction(async (transaction) => {
      openingPid = await readBackendPid(transaction);
      openingStarted.resolve(true);
      await insertSyntheticOpening(transaction, { createdAt: openedAt, openingId });
    });
    const openingSettlement = trackSettlement(opening);
    await openingStarted.promise;
    expect(await observeBlocking(migration, openingPid, finalizerPid, openingSettlement)).toBe(
      'blocked',
    );
    releaseFinalizer.resolve(true);
    await finalization;
    await expect(openingSettlement).resolves.toMatchObject({
      reason: { code: '40001', constraint: 'leaderboard_season_already_finalized' },
      status: 'rejected',
    });
    expect(
      (await migration.query(`select 1 from app.box_opens where id = $1`, [openingId])).rows,
    ).toEqual([]);

    const trigger = await migration.query<{ readonly enabled: string }>(
      `select tgenabled as enabled from pg_catalog.pg_trigger
        where tgrelid = 'app.box_opens'::regclass
          and tgname = 'box_opens_000_leaderboard_season_lock'`,
    );
    expect(trigger.rows).toEqual([{ enabled: 'O' }]);
  }, 20_000);

  it('denies direct application-role mutation of every authoritative Phase 13 table', async () => {
    const privileges = await application.query<{
      readonly tableName: string;
      readonly canDelete: boolean;
      readonly canInsert: boolean;
      readonly canSelect: boolean;
      readonly canUpdate: boolean;
    }>(
      `select table_name as "tableName",
              has_table_privilege(current_user,'app.' || table_name,'SELECT') as "canSelect",
              has_table_privilege(current_user,'app.' || table_name,'INSERT') as "canInsert",
              has_table_privilege(current_user,'app.' || table_name,'UPDATE') as "canUpdate",
              has_table_privilege(current_user,'app.' || table_name,'DELETE') as "canDelete"
         from unnest(array['leaderboard_projection_events','leaderboard_season_results',
                           'leaderboard_seasons','user_achievements']) as table_name
        order by table_name`,
    );
    expect(privileges.rows).toEqual(
      privileges.rows.map(({ tableName }) => ({
        canDelete: false,
        canInsert: false,
        canSelect: false,
        canUpdate: false,
        tableName,
      })),
    );

    const mutations = [
      `insert into app.leaderboard_seasons (ordinal,name,starts_at,ends_at)
       values (999999,'Forged','1980-01-01','1980-02-01')`,
      `update app.leaderboard_seasons set status = 'finalized'`,
      `delete from app.leaderboard_seasons`,
      `insert into app.leaderboard_season_results (
         season_id,scope_type,winner_user_id,points,total_openings,base_reward_wins,
         score_reached_at,finalized_at
       ) values ('00000000-0000-4000-8000-000000000001','global',
                 '00000000-0000-4000-8000-000000000002',1,1,0,clock_timestamp(),clock_timestamp())`,
      `update app.leaderboard_season_results set points = points`,
      `delete from app.leaderboard_season_results`,
      `insert into app.user_achievements (
         season_result_id,user_id,achievement_type,season_id,awarded_at
       ) values ('00000000-0000-4000-8000-000000000001',
                 '00000000-0000-4000-8000-000000000002','global_season_champion',
                 '00000000-0000-4000-8000-000000000003',clock_timestamp())`,
      `update app.user_achievements set awarded_at = awarded_at`,
      `delete from app.user_achievements`,
      `insert into app.leaderboard_projection_events (outbox_event_id,available_at)
       values ('00000000-0000-4000-8000-000000000001',clock_timestamp())`,
      `update app.leaderboard_projection_events set available_at = available_at`,
      `delete from app.leaderboard_projection_events`,
    ];
    for (const mutation of mutations) {
      await expect(application.query(mutation)).rejects.toThrow(/permission denied/iu);
    }
  });

  it('terminalizes an expired final claim while preserving lower-attempt recovery', async () => {
    const finalEventId = await insertProjectionFixture(migration);
    const finalClaim = await worker.query<{
      readonly attemptCount: number;
      readonly claimToken: string;
      readonly eventId: string;
    }>(
      `select outbox_event_id as "eventId",claim_token as "claimToken",
              attempt_count as "attemptCount"
         from app.claim_leaderboard_projection_events('phase13-final',1,5000,1)`,
    );
    expect(finalClaim.rows).toHaveLength(1);
    await migration.query(
      `update app.leaderboard_projection_events
          set lease_expires_at = clock_timestamp() - interval '1 second'
        where outbox_event_id = $1`,
      [finalEventId],
    );
    expect(
      (
        await worker.query(
          `select * from app.claim_leaderboard_projection_events('phase13-recovery',1,5000,1)`,
        )
      ).rows,
    ).toEqual([]);
    const dead = await migration.query<{
      readonly attemptCount: number;
      readonly lastErrorCode: string | null;
      readonly status: string;
    }>(
      `select status,attempt_count as "attemptCount",last_error_code as "lastErrorCode"
         from app.leaderboard_projection_events where outbox_event_id = $1`,
      [finalEventId],
    );
    expect(dead.rows).toEqual([
      { attemptCount: 1, lastErrorCode: 'MAX_ATTEMPTS_EXHAUSTED', status: 'dead' },
    ]);
    const staleToken = finalClaim.rows[0]?.claimToken;
    await expect(
      worker.query(`select app.complete_leaderboard_projection_event($1,$2)`, [
        finalEventId,
        staleToken,
      ]),
    ).rejects.toMatchObject({
      code: '55000',
      constraint: 'leaderboard_projection_claim_not_owned',
    });

    const retryEventId = await insertProjectionFixture(migration);
    const firstClaim = await worker.query<{
      readonly attemptCount: number;
      readonly claimToken: string;
      readonly eventId: string;
    }>(
      `select outbox_event_id as "eventId",claim_token as "claimToken",
              attempt_count as "attemptCount"
         from app.claim_leaderboard_projection_events('phase13-first',1,5000,2)`,
    );
    expect(firstClaim.rows).toEqual([
      expect.objectContaining({ attemptCount: 1, eventId: retryEventId }),
    ]);
    await migration.query(
      `update app.leaderboard_projection_events
          set lease_expires_at = clock_timestamp() - interval '1 second'
        where outbox_event_id = $1`,
      [retryEventId],
    );
    const recovered = await worker.query<{
      readonly attemptCount: number;
      readonly claimToken: string;
      readonly eventId: string;
    }>(
      `select outbox_event_id as "eventId",claim_token as "claimToken",
              attempt_count as "attemptCount"
         from app.claim_leaderboard_projection_events('phase13-second',1,5000,2)`,
    );
    expect(recovered.rows).toEqual([
      expect.objectContaining({ attemptCount: 2, eventId: retryEventId }),
    ]);
    await expect(
      worker.query(`select app.complete_leaderboard_projection_event($1,$2)`, [
        retryEventId,
        firstClaim.rows[0]?.claimToken,
      ]),
    ).rejects.toMatchObject({
      code: '55000',
      constraint: 'leaderboard_projection_claim_not_owned',
    });
    await worker.query(`select app.complete_leaderboard_projection_event($1,$2)`, [
      retryEventId,
      recovered.rows[0]?.claimToken,
    ]);
  });
});
