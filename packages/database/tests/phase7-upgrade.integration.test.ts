import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { afterAll, describe, expect, it } from 'vitest';

import { parseDatabaseEnvironment, parseMigrationEnvironment } from '@creatordrop/config';

import { createDatabasePool, type Database } from '../src/index.js';

const localMigrationUrl = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const migrationEnvironment = parseMigrationEnvironment({
  DATABASE_MIGRATION_URL: process.env.DATABASE_MIGRATION_URL ?? localMigrationUrl,
});
const migrationFiles = [
  '20260819000000_foundation.sql',
  '20260820000000_users.sql',
  '20260820180000_creator_tenancy.sql',
  '20260821132759_catalog.sql',
  '20260822150000_rng_seed_lifecycle.sql',
  '20260823093143_phase7_rng_lifecycle_hardening.sql',
  '20260823192330_phase7_rng_key_identity_semantics.sql',
  '20260823220000_phase7_rng_key_registry.sql',
  '20260823230000_phase7_rng_lifecycle_user_lock.sql',
  '20260824154215_phase8_wallet_ledger_idempotency.sql',
] as const;
const originalPhase7Index = migrationFiles.indexOf('20260822150000_rng_seed_lifecycle.sql');
const firstHardeningFile = '20260823093143_phase7_rng_lifecycle_hardening.sql';
const keyIdentityHardeningFile = '20260823192330_phase7_rng_key_identity_semantics.sql';
const keyRegistryHardeningFile = '20260823220000_phase7_rng_key_registry.sql';
const lifecycleUserLockFile = '20260823230000_phase7_rng_lifecycle_user_lock.sql';
const phase8WalletFile = '20260824154215_phase8_wallet_ledger_idempotency.sql';

const migrationSql = async (fileName: (typeof migrationFiles)[number]): Promise<string> =>
  readFile(new URL(`../../../infra/supabase/migrations/${fileName}`, import.meta.url), 'utf8');

const databaseUrl = (databaseName: string): string => {
  const url = new URL(migrationEnvironment.connectionString);
  url.pathname = `/${databaseName}`;
  url.searchParams.delete('options');
  return url.toString();
};

const createPool = (connectionString: string, applicationName: string): Database =>
  createDatabasePool({
    ...parseDatabaseEnvironment({
      DATABASE_APPLICATION_NAME: applicationName,
      DATABASE_CONNECTION_TIMEOUT_MS: '5000',
      DATABASE_IDLE_TIMEOUT_MS: '1000',
      DATABASE_POOL_MAX: '2',
      DATABASE_URL: connectionString,
    }),
    onUnexpectedPoolError: (error) => {
      throw error;
    },
  });

const validTemporaryDatabaseName = (prefix: string): string => {
  const name = `${prefix}_${randomUUID().replaceAll('-', '')}`;
  if (!/^[a-z0-9_]+$/u.test(name)) throw new Error('Generated an unsafe database name.');
  return name;
};

const keyIdentity = (byte: number): string =>
  createHash('sha256').update(Buffer.alloc(32, byte)).digest('hex');

const operationFingerprint = (operationType: string, reason: string): string =>
  createHash('sha256')
    .update(`creatordrop:rng-rotation:v1|${operationType}|${reason}`, 'utf8')
    .digest('hex');

const addUser = async (database: Database, label: string): Promise<string> => {
  const userId = randomUUID();
  await database.query(
    `insert into app.users (id, auth_provider, auth_subject, username)
     values ($1, 'synthetic-upgrade', $2, $3)`,
    [userId, `subject-${label}`, `upgrade_${label}`],
  );
  await database.query(
    `insert into app.fairness_profiles (user_id, current_client_seed)
     values ($1, $2)`,
    [userId, '21'.repeat(32)],
  );
  return userId;
};

interface LegacySeedInput {
  readonly compromiseReason?: 'key_compromise' | 'operational_compromise';
  readonly keyVersion?: string;
  readonly predecessorId?: string;
  readonly retirementReason?: 'operational_request' | 'user_request';
  readonly seedByte: number;
  readonly status: 'active' | 'compromised' | 'retired' | 'revealed';
  readonly userId: string;
}

const addLegacySeed = async (database: Database, input: LegacySeedInput): Promise<string> => {
  const seedSetId = randomUUID();
  const retired = input.status === 'retired' || input.status === 'revealed';
  const revealed = input.status === 'revealed';
  const compromised = input.status === 'compromised';
  await database.query(
    `insert into app.rng_seed_sets (
       id, user_id, commitment, server_seed_ciphertext, encryption_iv,
       encryption_auth_tag, encryption_key_version, rng_algorithm_version, status,
       next_nonce, max_nonce_exclusive, rotate_after, rotated_from_seed_set_id,
       retirement_reason, compromise_reason, created_at, retired_at, revealed_at,
       compromised_at, revealed_server_seed
     ) values (
       $1::uuid, $2::uuid, extensions.digest(decode($3, 'hex'), 'sha256'),
       extensions.digest(convert_to($1::uuid::text, 'UTF8'), 'sha256'), decode($4, 'hex'),
       decode($5, 'hex'), $6, 'hmac-sha256-rejection-v1', $7,
       0, 1000, '2026-08-25T00:00:00.000Z', $8, $9, $10,
       '2026-08-20T00:00:00.000Z', $11, $12, $13, $14
     )`,
    [
      seedSetId,
      input.userId,
      input.seedByte.toString(16).padStart(2, '0').repeat(32),
      input.seedByte.toString(16).padStart(2, '0').repeat(12),
      input.seedByte.toString(16).padStart(2, '0').repeat(16),
      input.keyVersion ?? 'production-v1',
      input.status,
      input.predecessorId ?? null,
      retired ? (input.retirementReason ?? 'operational_request') : null,
      compromised ? (input.compromiseReason ?? 'operational_compromise') : null,
      retired ? '2026-08-21T00:00:00.000Z' : null,
      revealed ? '2026-08-22T00:00:00.000Z' : null,
      compromised ? '2026-08-21T00:00:00.000Z' : null,
      revealed ? Buffer.alloc(32, input.seedByte) : null,
    ],
  );
  return seedSetId;
};

describe('Phase 7 forward-migration compatibility', { concurrent: false }, () => {
  const adminDatabase = createPool(
    migrationEnvironment.connectionString,
    'creatordrop-phase7-upgrade-admin',
  );
  const databasesToDrop = new Set<string>();

  const createTemporaryDatabase = async (
    prefix: string,
  ): Promise<{
    readonly database: Database;
    readonly name: string;
  }> => {
    const name = validTemporaryDatabaseName(prefix);
    await adminDatabase.query(`create database "${name}"`);
    databasesToDrop.add(name);
    return { database: createPool(databaseUrl(name), name), name };
  };

  const dropTemporaryDatabase = async (name: string, database: Database): Promise<void> => {
    await database.close();
    await adminDatabase.query(`drop database "${name}"`);
    databasesToDrop.delete(name);
  };

  const applyThrough = async (database: Database, lastIndex: number): Promise<void> => {
    for (const fileName of migrationFiles.slice(0, lastIndex + 1)) {
      await database.query(await migrationSql(fileName));
    }
  };

  afterAll(async () => {
    for (const name of databasesToDrop) {
      await adminDatabase.query(`drop database "${name}" with (force)`);
    }
    await adminDatabase.close();
  });

  it(
    'upgrades representative original Phase 7 history and establishes true key identities',
    { timeout: 60_000 },
    async () => {
      const { database, name } = await createTemporaryDatabase('creatordrop_phase7_valid');
      try {
        await applyThrough(database, originalPhase7Index);

        const activeUser = await addUser(database, 'active');
        await addLegacySeed(database, { seedByte: 1, status: 'active', userId: activeUser });

        const revealedUser = await addUser(database, 'revealed');
        await addLegacySeed(database, { seedByte: 2, status: 'revealed', userId: revealedUser });

        const compromisedUser = await addUser(database, 'compromised');
        await addLegacySeed(database, {
          compromiseReason: 'operational_compromise',
          seedByte: 3,
          status: 'compromised',
          userId: compromisedUser,
        });

        const normalUser = await addUser(database, 'normal_rotation');
        const normalPredecessor = await addLegacySeed(database, {
          retirementReason: 'user_request',
          seedByte: 4,
          status: 'retired',
          userId: normalUser,
        });
        const normalSuccessor = await addLegacySeed(database, {
          predecessorId: normalPredecessor,
          seedByte: 5,
          status: 'active',
          userId: normalUser,
        });
        await database.query(
          `insert into app.rng_seed_rotations (
             id, user_id, idempotency_key, previous_seed_set_id, new_seed_set_id
           ) values ($1, $2, 'upgrade_normal', $3, $4)`,
          [randomUUID(), normalUser, normalPredecessor, normalSuccessor],
        );

        const replacementUser = await addUser(database, 'compromise_replacement');
        const replacementPredecessor = await addLegacySeed(database, {
          compromiseReason: 'key_compromise',
          seedByte: 6,
          status: 'compromised',
          userId: replacementUser,
        });
        const replacementSuccessor = await addLegacySeed(database, {
          keyVersion: 'production-v2',
          predecessorId: replacementPredecessor,
          seedByte: 7,
          status: 'active',
          userId: replacementUser,
        });
        await database.query(
          `insert into app.rng_seed_rotations (
             id, user_id, idempotency_key, previous_seed_set_id, new_seed_set_id
           ) values ($1, $2, 'upgrade_replace', $3, $4)`,
          [randomUUID(), replacementUser, replacementPredecessor, replacementSuccessor],
        );

        const pendingUser = await addUser(database, 'pending_replacement');
        const pendingPredecessor = await addLegacySeed(database, {
          seedByte: 8,
          status: 'active',
          userId: pendingUser,
        });

        await database.query(await migrationSql(firstHardeningFile));
        await database.transaction(async (transaction) => {
          await transaction.query(
            `insert into app.rng_seed_rotations (
               id, user_id, idempotency_key, previous_seed_set_id, new_seed_set_id,
               operation_fingerprint, operation_type, transition_reason, completed_at
             ) values ($1, $2, 'upgrade_pending', $3, null, decode($4, 'hex'),
                       'compromise_replacement', 'key_compromise', null)`,
            [
              randomUUID(),
              pendingUser,
              pendingPredecessor,
              operationFingerprint('compromise_replacement', 'key_compromise'),
            ],
          );
          await transaction.query(
            `update app.rng_seed_sets
                set status = 'compromised', compromise_reason = 'key_compromise',
                    compromised_at = '2026-08-21T00:00:00.000Z'
              where id = $1`,
            [pendingPredecessor],
          );
        });

        await database.query(await migrationSql(keyIdentityHardeningFile));
        const beforeBackfill = await database.query<{ readonly missing: string }>(
          `select count(*)::text as missing from app.rng_seed_sets
            where encryption_key_identity is null`,
        );
        expect(beforeBackfill.rows).toEqual([{ missing: '8' }]);

        await database.query(await migrationSql(keyRegistryHardeningFile));
        await database.query(await migrationSql(lifecycleUserLockFile));
        const unresolvedHistory = await database.query<{
          readonly missing: string;
          readonly productionMappings: string;
        }>(
          `select
             (select count(*)::text from app.rng_seed_sets
               where encryption_key_identity is null) as missing,
             (select count(*)::text from app.rng_encryption_key_versions
               where version like 'production-%') as "productionMappings"`,
        );
        expect(unresolvedHistory.rows).toEqual([{ missing: '8', productionMappings: '0' }]);

        const v1Identity = keyIdentity(17);
        const v2Identity = keyIdentity(34);
        await database.query(
          `insert into app.rng_encryption_key_versions (version, key_identity)
           values ('production-v1', decode($1, 'hex')),
                  ('production-v2', decode($2, 'hex'))`,
          [v1Identity, v2Identity],
        );
        await database.query(
          `update app.rng_seed_sets
              set encryption_key_identity = decode(
                case encryption_key_version
                  when 'production-v1' then $1
                  when 'production-v2' then $2
                end,
                'hex'
              )
            where encryption_key_identity is null`,
          [v1Identity, v2Identity],
        );

        const keyRows = await database.query<{
          readonly count: string;
          readonly identity: string;
          readonly version: string;
        }>(
          `select encryption_key_version as version,
                  encode(encryption_key_identity, 'hex') as identity,
                  count(*)::text as count
             from app.rng_seed_sets
            group by encryption_key_version, encryption_key_identity
            order by encryption_key_version`,
        );
        expect(keyRows.rows).toEqual([
          { count: '7', identity: v1Identity, version: 'production-v1' },
          { count: '1', identity: v2Identity, version: 'production-v2' },
        ]);

        const registeredKeys = await database.query<{
          readonly identity: string;
          readonly version: string;
        }>(
          `select version, encode(key_identity, 'hex') as identity
             from app.rng_encryption_key_versions
            where version like 'production-%'
            order by version`,
        );
        expect(registeredKeys.rows).toEqual([
          { identity: v1Identity, version: 'production-v1' },
          { identity: v2Identity, version: 'production-v2' },
        ]);

        const rotations = await database.query<{
          readonly fingerprint: string;
          readonly operationType: string;
          readonly pending: boolean;
          readonly reason: string;
        }>(
          `select encode(operation_fingerprint, 'hex') as fingerprint,
                  operation_type as "operationType", transition_reason as reason,
                  new_seed_set_id is null as pending
             from app.rng_seed_rotations
            order by idempotency_key`,
        );
        expect(rotations.rows).toEqual([
          {
            fingerprint: operationFingerprint('rotation', 'user_request'),
            operationType: 'rotation',
            pending: false,
            reason: 'user_request',
          },
          {
            fingerprint: operationFingerprint('compromise_replacement', 'key_compromise'),
            operationType: 'compromise_replacement',
            pending: true,
            reason: 'key_compromise',
          },
          {
            fingerprint: operationFingerprint('compromise_replacement', 'key_compromise'),
            operationType: 'compromise_replacement',
            pending: false,
            reason: 'key_compromise',
          },
        ]);

        await database.query(await migrationSql(phase8WalletFile));
        const phase8Upgrade = await database.query<{
          readonly idempotencyCount: string;
          readonly ledgerAccountCount: string;
          readonly ledgerEntryCount: string;
          readonly ledgerTransactionCount: string;
          readonly walletCount: string;
        }>(
          `select
             (select count(*)::text from app.idempotency_records) as "idempotencyCount",
             (select count(*)::text from app.ledger_accounts) as "ledgerAccountCount",
             (select count(*)::text from app.ledger_entries) as "ledgerEntryCount",
             (select count(*)::text from app.ledger_transactions) as "ledgerTransactionCount",
             (select count(*)::text from app.wallets) as "walletCount"`,
        );
        expect(phase8Upgrade.rows).toEqual([
          {
            idempotencyCount: '0',
            ledgerAccountCount: '0',
            ledgerEntryCount: '0',
            ledgerTransactionCount: '0',
            walletCount: '0',
          },
        ]);
        expect(
          (
            await database.query<{ readonly phase7SeedCount: string }>(
              `select count(*)::text as "phase7SeedCount" from app.rng_seed_sets`,
            )
          ).rows,
        ).toEqual([{ phase7SeedCount: '8' }]);
      } finally {
        await dropTemporaryDatabase(name, database);
      }
    },
  );

  it(
    'fails closed on an original Phase 7 completed key replacement that reused its key version',
    { timeout: 60_000 },
    async () => {
      const { database, name } = await createTemporaryDatabase('p7_same_version');
      try {
        await applyThrough(database, originalPhase7Index);
        const userId = await addUser(database, 'same_version_replacement');
        const predecessorId = await addLegacySeed(database, {
          compromiseReason: 'key_compromise',
          keyVersion: 'production-v1',
          seedByte: 31,
          status: 'compromised',
          userId,
        });
        const successorId = await addLegacySeed(database, {
          keyVersion: 'production-v1',
          predecessorId,
          seedByte: 32,
          status: 'active',
          userId,
        });
        await database.query(
          `insert into app.rng_seed_rotations (
             id, user_id, idempotency_key, previous_seed_set_id, new_seed_set_id
           ) values ($1, $2, 'unsafe_same_version', $3, $4)`,
          [randomUUID(), userId, predecessorId, successorId],
        );

        await database.query(await migrationSql(firstHardeningFile));
        await database.query(await migrationSql(keyIdentityHardeningFile));
        await expect(database.query(await migrationSql(keyRegistryHardeningFile))).rejects.toThrow(
          /rng_seed_rotation_legacy_key_history_unsafe|operator review/iu,
        );
        expect(
          (
            await database.query<{ readonly registry: string }>(
              `select to_regclass('app.rng_encryption_key_versions')::text as registry`,
            )
          ).rows,
        ).toEqual([{ registry: null }]);
      } finally {
        await dropTemporaryDatabase(name, database);
      }
    },
  );

  it(
    'fails closed when different legacy key versions have the same established identity',
    { timeout: 60_000 },
    async () => {
      const { database, name } = await createTemporaryDatabase('p7_same_identity');
      try {
        await applyThrough(database, originalPhase7Index);
        const userId = await addUser(database, 'same_identity_replacement');
        const predecessorId = await addLegacySeed(database, {
          compromiseReason: 'key_compromise',
          keyVersion: 'production-v1',
          seedByte: 41,
          status: 'compromised',
          userId,
        });
        const successorId = await addLegacySeed(database, {
          keyVersion: 'production-v2',
          predecessorId,
          seedByte: 42,
          status: 'active',
          userId,
        });
        await database.query(
          `insert into app.rng_seed_rotations (
             id, user_id, idempotency_key, previous_seed_set_id, new_seed_set_id
           ) values ($1, $2, 'unsafe_same_identity', $3, $4)`,
          [randomUUID(), userId, predecessorId, successorId],
        );

        await database.query(await migrationSql(firstHardeningFile));
        await database.query(await migrationSql(keyIdentityHardeningFile));
        const reusedIdentity = keyIdentity(51);
        await database.query(
          `update app.rng_seed_sets
              set encryption_key_identity = decode($2, 'hex')
            where id in ($1, $3)`,
          [predecessorId, reusedIdentity, successorId],
        );

        await expect(database.query(await migrationSql(keyRegistryHardeningFile))).rejects.toThrow(
          /rng_seed_rotation_legacy_key_history_unsafe|operator review/iu,
        );
      } finally {
        await dropTemporaryDatabase(name, database);
      }
    },
  );

  it(
    'rejects reused key material when unresolved legacy versions are established later',
    { timeout: 60_000 },
    async () => {
      const { database, name } = await createTemporaryDatabase('p7_late_identity');
      try {
        await applyThrough(database, originalPhase7Index);
        const userId = await addUser(database, 'late_identity_replacement');
        const predecessorId = await addLegacySeed(database, {
          compromiseReason: 'key_compromise',
          keyVersion: 'production-v1',
          seedByte: 51,
          status: 'compromised',
          userId,
        });
        const successorId = await addLegacySeed(database, {
          keyVersion: 'production-v2',
          predecessorId,
          seedByte: 52,
          status: 'active',
          userId,
        });
        await database.query(
          `insert into app.rng_seed_rotations (
             id, user_id, idempotency_key, previous_seed_set_id, new_seed_set_id
           ) values ($1, $2, 'late_same_identity', $3, $4)`,
          [randomUUID(), userId, predecessorId, successorId],
        );

        await database.query(await migrationSql(firstHardeningFile));
        await database.query(await migrationSql(keyIdentityHardeningFile));
        await database.query(await migrationSql(keyRegistryHardeningFile));
        await database.query(await migrationSql(lifecycleUserLockFile));
        const reusedIdentity = keyIdentity(61);
        await database.query(
          `insert into app.rng_encryption_key_versions (version, key_identity)
           values ('production-v1', decode($1, 'hex'))`,
          [reusedIdentity],
        );
        await expect(
          database.query(
            `insert into app.rng_encryption_key_versions (version, key_identity)
             values ('production-v2', decode($1, 'hex'))`,
            [reusedIdentity],
          ),
        ).rejects.toThrow(/rng_encryption_key_versions_identity_unique|duplicate key/iu);

        expect(
          (
            await database.query<{
              readonly missing: string;
              readonly registered: string;
            }>(
              `select
                 (select count(*)::text from app.rng_seed_sets
                   where id in ($1, $2) and encryption_key_identity is null) as missing,
                 (select count(*)::text from app.rng_encryption_key_versions
                   where version in ('production-v1', 'production-v2')) as registered`,
              [predecessorId, successorId],
            )
          ).rows,
        ).toEqual([{ missing: '2', registered: '1' }]);
      } finally {
        await dropTemporaryDatabase(name, database);
      }
    },
  );

  it(
    'fails closed instead of rewriting invalid original Phase 7 history',
    { timeout: 60_000 },
    async () => {
      const { database, name } = await createTemporaryDatabase('creatordrop_phase7_invalid');
      try {
        await applyThrough(database, originalPhase7Index);
        const userId = await addUser(database, 'invalid_null_reveal');
        await database.query(
          `insert into app.rng_seed_sets (
             id, user_id, commitment, server_seed_ciphertext, encryption_iv,
             encryption_auth_tag, encryption_key_version, rng_algorithm_version,
             status, next_nonce, max_nonce_exclusive, rotate_after,
             retirement_reason, created_at, retired_at, revealed_at,
             revealed_server_seed
           ) values (
             $1, $2, decode($3, 'hex'), decode($4, 'hex'), decode($5, 'hex'),
             decode($6, 'hex'), 'production-v1', 'hmac-sha256-rejection-v1',
             'revealed', 0, 1000, '2026-08-25T00:00:00.000Z',
             'operational_request', '2026-08-20T00:00:00.000Z',
             '2026-08-21T00:00:00.000Z', '2026-08-22T00:00:00.000Z', null
           )`,
          [
            randomUUID(),
            userId,
            '01'.repeat(32),
            '02'.repeat(32),
            '03'.repeat(12),
            '04'.repeat(16),
          ],
        );

        await expect(database.query(await migrationSql(firstHardeningFile))).rejects.toThrow(
          /rng_seed_sets_lifecycle_shape|check constraint/iu,
        );
        const invalidHistory = await database.query<{
          readonly plaintextIsNull: boolean;
          readonly status: string;
        }>(
          `select status, revealed_server_seed is null as "plaintextIsNull"
             from app.rng_seed_sets where user_id = $1`,
          [userId],
        );
        expect(invalidHistory.rows).toEqual([{ plaintextIsNull: true, status: 'revealed' }]);
      } finally {
        await dropTemporaryDatabase(name, database);
      }
    },
  );
});
