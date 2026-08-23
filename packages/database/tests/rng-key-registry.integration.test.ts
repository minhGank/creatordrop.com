import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseDatabaseEnvironment, parseMigrationEnvironment } from '@creatordrop/config';

import { createDatabasePool, type Database, type QueryExecutor } from '../src/index.js';

const localApplicationUrl =
  'postgresql://postgres:postgres@127.0.0.1:54322/postgres?options=-c%20role%3Dcreatordrop_app';
const localMigrationUrl = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const { DATABASE_MIGRATION_URL: migrationUrl, DATABASE_URL: applicationUrl } = process.env;

const applicationEnvironment = parseDatabaseEnvironment({
  DATABASE_APPLICATION_NAME: 'creatordrop-rng-key-registry-test',
  DATABASE_CONNECTION_TIMEOUT_MS: '5000',
  DATABASE_IDLE_TIMEOUT_MS: '1000',
  DATABASE_POOL_MAX: '2',
  DATABASE_URL: applicationUrl ?? localApplicationUrl,
});
const migrationEnvironment = parseMigrationEnvironment({
  DATABASE_MIGRATION_URL: migrationUrl ?? localMigrationUrl,
});

const firstVersion = 'database-registry-v1';
const secondVersion = 'database-registry-v2';
const firstKeyIdentity = createHash('sha256').update(Buffer.alloc(32, 71)).digest('hex');
const secondKeyIdentity = createHash('sha256').update(Buffer.alloc(32, 72)).digest('hex');

const operationFingerprint = (operationType: string, reason: string): string =>
  createHash('sha256')
    .update(`creatordrop:rng-rotation:v1|${operationType}|${reason}`, 'utf8')
    .digest('hex');

type OperationSettlement =
  { readonly status: 'fulfilled' } | { readonly reason: unknown; readonly status: 'rejected' };

type BlockingObservation =
  | { readonly kind: 'blocked' }
  | { readonly kind: 'settled'; readonly settlement: OperationSettlement };

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

const observeBlockingOrSettlement = async (
  inspector: QueryExecutor,
  waiterPid: number,
  blockerPid: number,
  settlement: Promise<OperationSettlement>,
): Promise<BlockingObservation> => {
  let settled: OperationSettlement | undefined;
  void settlement.then((result) => {
    settled = result;
  });

  // This polls PostgreSQL's lock graph rather than using a timing sleep. The
  // transaction-side deferred gates below keep the blocker open until this
  // test has observed either a real wait or premature settlement.
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const result = await inspector.query<{ readonly blocked: boolean }>(
      `select $2::integer = any(pg_catalog.pg_blocking_pids($1::integer)) as blocked`,
      [waiterPid, blockerPid],
    );
    if (result.rows[0]?.blocked === true) return { kind: 'blocked' };
    if (settled !== undefined) return { kind: 'settled', settlement: settled };
  }

  throw new Error('The concurrent operation neither waited nor settled.');
};

const trackSettlement = <Value>(operation: Promise<Value>): Promise<OperationSettlement> =>
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

const addUser = async (database: Database, label: string): Promise<string> => {
  const id = randomUUID();
  await database.query(
    `insert into app.users (id, auth_provider, auth_subject, username)
     values ($1, 'synthetic-registry', $2, $3)`,
    [id, `${label}-${id}`, `registry_${id.replaceAll('-', '')}`],
  );
  await database.query(
    `insert into app.fairness_profiles (user_id, current_client_seed)
     values ($1, $2)`,
    [id, '73'.repeat(32)],
  );
  return id;
};

const insertActiveSeed = async (
  executor: QueryExecutor,
  input: {
    readonly keyIdentity?: string;
    readonly keyVersion: string;
    readonly predecessorId?: string;
    readonly userId: string;
  },
): Promise<string> => {
  const id = randomUUID();
  await executor.query(
    `insert into app.rng_seed_sets (
       id, user_id, commitment, server_seed_ciphertext, encryption_iv,
       encryption_auth_tag, encryption_key_version, rng_algorithm_version,
       max_nonce_exclusive, rotate_after, rotated_from_seed_set_id, encryption_key_identity
     ) values (
       $1, $2, $3, $4, $5, $6, $7, 'hmac-sha256-rejection-v1',
       1000, clock_timestamp() + interval '1 hour', $9, decode($8, 'hex')
     )`,
    [
      id,
      input.userId,
      createHash('sha256').update(id).digest(),
      randomBytes(32),
      randomBytes(12),
      randomBytes(16),
      input.keyVersion,
      input.keyIdentity ?? null,
      input.predecessorId ?? null,
    ],
  );
  return id;
};

const compromiseSeed = async (executor: QueryExecutor, seedSetId: string): Promise<void> => {
  await executor.query(
    `update app.rng_seed_sets
        set status = 'compromised', compromise_reason = 'key_compromise',
            compromised_at = clock_timestamp()
      where id = $1`,
    [seedSetId],
  );
};

const insertPendingCompromiseRemediation = async (
  executor: QueryExecutor,
  input: { readonly predecessorId: string; readonly userId: string },
): Promise<string> => {
  const rotationId = randomUUID();
  await executor.query(
    `insert into app.rng_seed_rotations (
       id, user_id, idempotency_key, previous_seed_set_id, new_seed_set_id,
       operation_fingerprint, operation_type, transition_reason, completed_at
     ) values (
       $1, $2, $3, $4, null, decode($5, 'hex'),
       'compromise_replacement', 'key_compromise', null
     )`,
    [
      rotationId,
      input.userId,
      `registry_${rotationId.replaceAll('-', '')}`,
      input.predecessorId,
      operationFingerprint('compromise_replacement', 'key_compromise'),
    ],
  );
  return rotationId;
};

const readLifecycleCounts = async (
  executor: QueryExecutor,
  userId: string,
): Promise<{ readonly activeCount: string; readonly pendingCount: string }> => {
  const result = await executor.query<{
    readonly activeCount: string;
    readonly pendingCount: string;
  }>(
    `select
       (select count(*)::text from app.rng_seed_sets
         where user_id = $1 and status = 'active') as "activeCount",
       (select count(*)::text from app.rng_seed_rotations
         where user_id = $1
           and operation_type = 'compromise_replacement'
           and new_seed_set_id is null) as "pendingCount"`,
    [userId],
  );
  const counts = result.rows[0];
  if (counts === undefined) throw new Error('PostgreSQL did not return lifecycle counts.');
  return counts;
};

describe('authoritative RNG encryption-key registry', { concurrent: false }, () => {
  let applicationDatabase: Database;
  let firstConcurrencyDatabase: Database;
  let migrationDatabase: Database;
  let secondConcurrencyDatabase: Database;

  beforeAll(async () => {
    applicationDatabase = createDatabasePool({
      ...applicationEnvironment,
      onUnexpectedPoolError: (error) => {
        throw error;
      },
    });
    migrationDatabase = createDatabasePool({
      ...applicationEnvironment,
      applicationName: 'creatordrop-rng-key-registry-migration-test',
      connectionString: migrationEnvironment.connectionString,
      onUnexpectedPoolError: (error) => {
        throw error;
      },
    });
    firstConcurrencyDatabase = createDatabasePool({
      ...applicationEnvironment,
      applicationName: 'creatordrop-rng-lifecycle-concurrency-a',
      maxConnections: 1,
      onUnexpectedPoolError: (error) => {
        throw error;
      },
    });
    secondConcurrencyDatabase = createDatabasePool({
      ...applicationEnvironment,
      applicationName: 'creatordrop-rng-lifecycle-concurrency-b',
      maxConnections: 1,
      onUnexpectedPoolError: (error) => {
        throw error;
      },
    });
    await migrationDatabase.query(
      `insert into app.rng_encryption_key_versions (version, key_identity)
       values ($1, decode($2, 'hex')), ($3, decode($4, 'hex'))
       on conflict (version) do nothing`,
      [firstVersion, firstKeyIdentity, secondVersion, secondKeyIdentity],
    );
  });

  afterAll(async () => {
    await Promise.all([
      applicationDatabase.close(),
      firstConcurrencyDatabase.close(),
      migrationDatabase.close(),
      secondConcurrencyDatabase.close(),
    ]);
  });

  it('makes version and key-material identity immutable and application read-only', async () => {
    const privileges = await applicationDatabase.query<{
      readonly canDelete: boolean;
      readonly canInsert: boolean;
      readonly canSelect: boolean;
      readonly canUpdate: boolean;
    }>(
      `select
         has_table_privilege(current_user, 'app.rng_encryption_key_versions', 'SELECT')
           as "canSelect",
         has_table_privilege(current_user, 'app.rng_encryption_key_versions', 'INSERT')
           as "canInsert",
         has_table_privilege(current_user, 'app.rng_encryption_key_versions', 'UPDATE')
           as "canUpdate",
         has_table_privilege(current_user, 'app.rng_encryption_key_versions', 'DELETE')
           as "canDelete"`,
    );
    expect(privileges.rows).toEqual([
      { canDelete: false, canInsert: false, canSelect: true, canUpdate: false },
    ]);

    await expect(
      applicationDatabase.query(
        `insert into app.rng_encryption_key_versions (version, key_identity)
         values ('forged-application-key', decode($1, 'hex'))`,
        ['ff'.repeat(32)],
      ),
    ).rejects.toThrow(/permission denied/iu);
    await expect(
      migrationDatabase.query(
        `insert into app.rng_encryption_key_versions (version, key_identity)
         values ('database-registry-renamed', decode($1, 'hex'))`,
        [firstKeyIdentity],
      ),
    ).rejects.toThrow(/rng_encryption_key_versions_identity_unique|duplicate key/iu);
    await expect(
      migrationDatabase.query(
        `insert into app.rng_encryption_key_versions (version, key_identity)
         values ($1, decode($2, 'hex'))`,
        [firstVersion, 'fe'.repeat(32)],
      ),
    ).rejects.toThrow(/rng_encryption_key_versions_pkey|duplicate key/iu);
  });

  it('derives seed identity from the registry and rejects application-forged identity', async () => {
    const forgedUserId = await addUser(applicationDatabase, 'forged_identity');
    await expect(
      insertActiveSeed(applicationDatabase, {
        keyIdentity: 'fd'.repeat(32),
        keyVersion: firstVersion,
        userId: forgedUserId,
      }),
    ).rejects.toMatchObject({ constraint: 'rng_seed_set_key_identity_untrusted' });

    const validUserId = await addUser(applicationDatabase, 'derived_identity');
    const seedSetId = await insertActiveSeed(applicationDatabase, {
      keyVersion: firstVersion,
      userId: validUserId,
    });
    expect(
      (
        await applicationDatabase.query<{ readonly identity: string; readonly version: string }>(
          `select encryption_key_version as version,
                  encode(encryption_key_identity, 'hex') as identity
             from app.rng_seed_sets where id = $1`,
          [seedSetId],
        )
      ).rows,
    ).toEqual([{ identity: firstKeyIdentity, version: firstVersion }]);
  });

  it('rejects compromise completion under the predecessor key version', async () => {
    const userId = await addUser(applicationDatabase, 'same_version_completion');
    const predecessorId = await insertActiveSeed(applicationDatabase, {
      keyVersion: firstVersion,
      userId,
    });
    const rotationId = randomUUID();
    await applicationDatabase.transaction(async (transaction) => {
      await transaction.query(
        `insert into app.rng_seed_rotations (
           id, user_id, idempotency_key, previous_seed_set_id, new_seed_set_id,
           operation_fingerprint, operation_type, transition_reason, completed_at
         ) values (
           $1, $2, 'registry_same_version', $3, null, decode($4, 'hex'),
           'compromise_replacement', 'key_compromise', null
         )`,
        [
          rotationId,
          userId,
          predecessorId,
          operationFingerprint('compromise_replacement', 'key_compromise'),
        ],
      );
      await transaction.query(
        `update app.rng_seed_sets
            set status = 'compromised', compromise_reason = 'key_compromise',
                compromised_at = clock_timestamp()
          where id = $1`,
        [predecessorId],
      );
    });

    await expect(
      applicationDatabase.transaction(async (transaction) => {
        const successorId = await insertActiveSeed(transaction, {
          keyVersion: firstVersion,
          predecessorId,
          userId,
        });
        await transaction.query(
          `update app.rng_seed_rotations
              set new_seed_set_id = $2, completed_at = clock_timestamp()
            where id = $1`,
          [rotationId, successorId],
        );
      }),
    ).rejects.toMatchObject({ constraint: 'rng_seed_rotation_replacement_key_unsafe' });
    expect(
      (
        await applicationDatabase.query<{ readonly activeCount: string }>(
          `select count(*)::text as "activeCount" from app.rng_seed_sets
            where user_id = $1 and status = 'active'`,
          [userId],
        )
      ).rows,
    ).toEqual([{ activeCount: '0' }]);
  });

  it('blocks standalone active seeds during pending remediation and allows atomic completion', async () => {
    const userId = await addUser(applicationDatabase, 'pending_remediation');
    const predecessorId = await insertActiveSeed(applicationDatabase, {
      keyVersion: firstVersion,
      userId,
    });
    const rotationId = randomUUID();
    await applicationDatabase.transaction(async (transaction) => {
      await transaction.query(
        `insert into app.rng_seed_rotations (
           id, user_id, idempotency_key, previous_seed_set_id, new_seed_set_id,
           operation_fingerprint, operation_type, transition_reason, completed_at
         ) values (
           $1, $2, 'registry_pending_remediation', $3, null, decode($4, 'hex'),
           'compromise_replacement', 'key_compromise', null
         )`,
        [
          rotationId,
          userId,
          predecessorId,
          operationFingerprint('compromise_replacement', 'key_compromise'),
        ],
      );
      await transaction.query(
        `update app.rng_seed_sets
            set status = 'compromised', compromise_reason = 'key_compromise',
                compromised_at = clock_timestamp()
          where id = $1`,
        [predecessorId],
      );
    });

    await expect(
      applicationDatabase.transaction((transaction) =>
        insertActiveSeed(transaction, {
          keyVersion: secondVersion,
          predecessorId,
          userId,
        }),
      ),
    ).rejects.toMatchObject({ constraint: 'rng_seed_rotation_pending_active_seed_invalid' });
    await expect(
      applicationDatabase.query(
        `update app.rng_seed_sets
            set status = 'active', compromise_reason = null, compromised_at = null
          where id = $1`,
        [predecessorId],
      ),
    ).rejects.toMatchObject({ constraint: 'rng_seed_set_transition_invalid' });

    const successorId = await applicationDatabase.transaction(async (transaction) => {
      const id = await insertActiveSeed(transaction, {
        keyVersion: secondVersion,
        predecessorId,
        userId,
      });
      await transaction.query(
        `update app.rng_seed_rotations
            set new_seed_set_id = $2, completed_at = clock_timestamp()
          where id = $1`,
        [rotationId, id],
      );
      return id;
    });
    expect(
      (
        await applicationDatabase.query<{
          readonly activeCount: string;
          readonly completedCount: string;
        }>(
          `select
             (select count(*)::text from app.rng_seed_sets
               where user_id = $1 and status = 'active') as "activeCount",
             (select count(*)::text from app.rng_seed_rotations
               where user_id = $1 and new_seed_set_id = $2) as "completedCount"`,
          [userId, successorId],
        )
      ).rows,
    ).toEqual([{ activeCount: '1', completedCount: '1' }]);
  });

  it('serializes pending remediation before a concurrent standalone active seed', async () => {
    const userId = await addUser(applicationDatabase, 'pending_first_race');
    const predecessorId = await insertActiveSeed(applicationDatabase, {
      keyVersion: firstVersion,
      userId,
    });
    await compromiseSeed(applicationDatabase, predecessorId);

    const pendingInserted = createDeferred<number>();
    const allowPendingCommit = createDeferred<true>();
    const pendingOperation = firstConcurrencyDatabase.transaction(async (transaction) => {
      const backendPid = await readBackendPid(transaction);
      await insertPendingCompromiseRemediation(transaction, { predecessorId, userId });
      pendingInserted.resolve(backendPid);
      await allowPendingCommit.promise;
    });
    const blockerPid = await pendingInserted.promise;

    const activeStarted = createDeferred<number>();
    const activeOperation = secondConcurrencyDatabase.transaction(async (transaction) => {
      activeStarted.resolve(await readBackendPid(transaction));
      await insertActiveSeed(transaction, { keyVersion: secondVersion, userId });
    });
    const activeSettlement = trackSettlement(activeOperation);
    const waiterPid = await activeStarted.promise;

    try {
      expect(
        await observeBlockingOrSettlement(
          migrationDatabase,
          waiterPid,
          blockerPid,
          activeSettlement,
        ),
      ).toEqual({ kind: 'blocked' });
    } finally {
      allowPendingCommit.resolve(true);
    }

    await pendingOperation;
    await expect(activeOperation).rejects.toMatchObject({
      constraint: 'rng_seed_rotation_pending_active_seed_invalid',
    });
    expect(await readLifecycleCounts(applicationDatabase, userId)).toEqual({
      activeCount: '0',
      pendingCount: '1',
    });
  });

  it('serializes a standalone active seed before concurrent pending remediation', async () => {
    const userId = await addUser(applicationDatabase, 'active_first_race');
    const predecessorId = await insertActiveSeed(applicationDatabase, {
      keyVersion: firstVersion,
      userId,
    });
    await compromiseSeed(applicationDatabase, predecessorId);

    const activeInserted = createDeferred<number>();
    const allowActiveCommit = createDeferred<true>();
    const activeOperation = firstConcurrencyDatabase.transaction(async (transaction) => {
      const backendPid = await readBackendPid(transaction);
      await insertActiveSeed(transaction, { keyVersion: secondVersion, userId });
      activeInserted.resolve(backendPid);
      await allowActiveCommit.promise;
    });
    const blockerPid = await activeInserted.promise;

    const pendingStarted = createDeferred<number>();
    const pendingOperation = secondConcurrencyDatabase.transaction(async (transaction) => {
      pendingStarted.resolve(await readBackendPid(transaction));
      await insertPendingCompromiseRemediation(transaction, { predecessorId, userId });
    });
    const pendingSettlement = trackSettlement(pendingOperation);
    const waiterPid = await pendingStarted.promise;

    try {
      expect(
        await observeBlockingOrSettlement(
          migrationDatabase,
          waiterPid,
          blockerPid,
          pendingSettlement,
        ),
      ).toEqual({ kind: 'blocked' });
    } finally {
      allowActiveCommit.resolve(true);
    }

    await activeOperation;
    await expect(pendingOperation).rejects.toMatchObject({
      constraint: 'rng_seed_rotation_pending_active_seed_invalid',
    });
    expect(await readLifecycleCounts(applicationDatabase, userId)).toEqual({
      activeCount: '1',
      pendingCount: '0',
    });
  });

  it('does not serialize fairness lifecycle writes for different users', async () => {
    const firstUserId = await addUser(applicationDatabase, 'different_user_a');
    const secondUserId = await addUser(applicationDatabase, 'different_user_b');
    const firstInserted = createDeferred<number>();
    const allowFirstCommit = createDeferred<true>();
    const firstOperation = firstConcurrencyDatabase.transaction(async (transaction) => {
      const backendPid = await readBackendPid(transaction);
      await insertActiveSeed(transaction, { keyVersion: firstVersion, userId: firstUserId });
      firstInserted.resolve(backendPid);
      await allowFirstCommit.promise;
    });
    const blockerPid = await firstInserted.promise;

    const secondStarted = createDeferred<number>();
    const secondOperation = secondConcurrencyDatabase.transaction(async (transaction) => {
      secondStarted.resolve(await readBackendPid(transaction));
      await insertActiveSeed(transaction, { keyVersion: firstVersion, userId: secondUserId });
    });
    const secondSettlement = trackSettlement(secondOperation);
    const waiterPid = await secondStarted.promise;

    try {
      expect(
        await observeBlockingOrSettlement(
          migrationDatabase,
          waiterPid,
          blockerPid,
          secondSettlement,
        ),
      ).toEqual({ kind: 'settled', settlement: { status: 'fulfilled' } });
    } finally {
      allowFirstCommit.resolve(true);
    }

    await Promise.all([firstOperation, secondOperation]);
    expect(await readLifecycleCounts(applicationDatabase, firstUserId)).toEqual({
      activeCount: '1',
      pendingCount: '0',
    });
    expect(await readLifecycleCounts(applicationDatabase, secondUserId)).toEqual({
      activeCount: '1',
      pendingCount: '0',
    });
  });
});
