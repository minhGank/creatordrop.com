import type { QueryExecutor } from '@creatordrop/database';

import type { UserId } from '../creators/creator.js';
import {
  rngSeedSetStatuses,
  type ClientSeed,
  type EncryptedSeedSet,
  type FairnessProfile,
  type PublicSeedSet,
  type RngRotationId,
  type RngSeedSetId,
  type RngSeedSetStatus,
} from './fairness.js';

interface FairnessProfileRow {
  readonly clientSeed: unknown;
  readonly createdAt: unknown;
  readonly revision: unknown;
  readonly updatedAt: unknown;
  readonly userId: unknown;
}

interface PublicSeedSetRow {
  readonly algorithmVersion: unknown;
  readonly commitment: unknown;
  readonly compromisedAt: unknown;
  readonly createdAt: unknown;
  readonly id: unknown;
  readonly maxNonceExclusive: unknown;
  readonly nextNonce: unknown;
  readonly retirementReason: unknown;
  readonly retiredAt: unknown;
  readonly revealedAt: unknown;
  readonly revealedServerSeed: unknown;
  readonly rotateAfter: unknown;
  readonly status: unknown;
}

interface SeedSetRow extends PublicSeedSetRow {
  readonly authenticationTag: unknown;
  readonly ciphertext: unknown;
  readonly encryptionIv: unknown;
  readonly encryptionKeyIdentity: unknown;
  readonly encryptionKeyVersion: unknown;
  readonly userId: unknown;
}

interface RotationRow {
  readonly id: unknown;
  readonly newSeedSetId: unknown;
  readonly operationFingerprint: unknown;
  readonly operationType: unknown;
  readonly previousSeedSetId: unknown;
  readonly transitionReason: unknown;
}

interface EncryptionKeyVersionRow {
  readonly keyIdentity: unknown;
}

export interface SeedSetInsert {
  readonly algorithmVersion: 'hmac-sha256-rejection-v1';
  readonly authenticationTag: Uint8Array;
  readonly ciphertext: Uint8Array;
  readonly commitment: string;
  readonly createdAt: string;
  readonly encryptionIv: Uint8Array;
  readonly encryptionKeyVersion: string;
  readonly id: RngSeedSetId;
  readonly maxNonceExclusive: bigint;
  readonly rotateAfter: string;
  readonly rotatedFromSeedSetId: RngSeedSetId | null;
  readonly userId: UserId;
}

export interface RotationRecord {
  readonly id: RngRotationId;
  readonly newSeedSetId: RngSeedSetId | null;
  readonly operationFingerprint: string;
  readonly operationType: 'compromise_replacement' | 'rotation';
  readonly previousSeedSetId: RngSeedSetId;
  readonly transitionReason: string;
}

const profileColumns = `
  user_id::text as "userId",
  current_client_seed as "clientSeed",
  revision,
  created_at as "createdAt",
  updated_at as "updatedAt"`;

const publicSeedSetColumns = `
  id::text as id,
  encode(commitment, 'hex') as commitment,
  rng_algorithm_version as "algorithmVersion",
  status,
  next_nonce::text as "nextNonce",
  max_nonce_exclusive::text as "maxNonceExclusive",
  rotate_after as "rotateAfter",
  retirement_reason as "retirementReason",
  created_at as "createdAt",
  retired_at as "retiredAt",
  revealed_at as "revealedAt",
  compromised_at as "compromisedAt",
  revealed_server_seed as "revealedServerSeed"`;

const seedSetColumns = `
  ${publicSeedSetColumns},
  user_id::text as "userId",
  server_seed_ciphertext as ciphertext,
  encryption_iv as "encryptionIv",
  encryption_auth_tag as "authenticationTag",
  case
    when encryption_key_identity is null then null
    else encode(encryption_key_identity, 'hex')
  end as "encryptionKeyIdentity",
  encryption_key_version as "encryptionKeyVersion"`;

const requiredString = (value: unknown, field: string): string => {
  if (typeof value !== 'string') throw new Error(`Database returned invalid ${field}.`);
  return value;
};

const keyIdentityPattern = /^[0-9a-f]{64}$/u;

const encryptionKeyIdentity = (value: unknown): string => {
  const identity = requiredString(value, 'seed encryption key identity');
  if (!keyIdentityPattern.test(identity)) {
    throw new Error('Database returned invalid seed encryption key identity.');
  }
  return identity;
};

const nullableString = (value: unknown, field: string): string | null =>
  value === null ? null : requiredString(value, field);

const requiredInteger = (value: unknown, field: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`Database returned invalid ${field}.`);
  }
  return value;
};

const timestamp = (value: unknown, field: string): string => {
  const parsed = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null;
  if (parsed === null || Number.isNaN(parsed.valueOf())) {
    throw new Error(`Database returned invalid ${field}.`);
  }
  return parsed.toISOString();
};

const nullableTimestamp = (value: unknown, field: string): string | null =>
  value === null ? null : timestamp(value, field);

const bytes = (value: unknown, field: string): Uint8Array => {
  if (!(value instanceof Uint8Array)) throw new Error(`Database returned invalid ${field}.`);
  return Uint8Array.from(value);
};

const status = (value: unknown): RngSeedSetStatus => {
  if (typeof value !== 'string' || !rngSeedSetStatuses.includes(value as RngSeedSetStatus)) {
    throw new Error('Database returned invalid RNG seed-set status.');
  }
  return value as RngSeedSetStatus;
};

const parseProfile = (row: FairnessProfileRow): FairnessProfile => ({
  clientSeed: requiredString(row.clientSeed, 'client seed') as ClientSeed,
  createdAt: timestamp(row.createdAt, 'fairness profile created timestamp'),
  revision: requiredInteger(row.revision, 'fairness profile revision'),
  updatedAt: timestamp(row.updatedAt, 'fairness profile updated timestamp'),
  userId: requiredString(row.userId, 'fairness profile user ID') as UserId,
});

const parsePublicSeedSet = (row: PublicSeedSetRow): PublicSeedSet => ({
  algorithmVersion: requiredString(
    row.algorithmVersion,
    'RNG algorithm version',
  ) as 'hmac-sha256-rejection-v1',
  commitment: requiredString(row.commitment, 'server seed commitment'),
  compromisedAt: nullableTimestamp(row.compromisedAt, 'seed compromised timestamp'),
  createdAt: timestamp(row.createdAt, 'seed created timestamp'),
  id: requiredString(row.id, 'seed-set ID') as RngSeedSetId,
  maxNonceExclusive: requiredString(row.maxNonceExclusive, 'maximum nonce'),
  nextNonce: requiredString(row.nextNonce, 'next nonce'),
  retiredAt: nullableTimestamp(row.retiredAt, 'seed retired timestamp'),
  revealedAt: nullableTimestamp(row.revealedAt, 'seed revealed timestamp'),
  revealedServerSeed:
    row.revealedServerSeed === null
      ? null
      : Buffer.from(bytes(row.revealedServerSeed, 'revealed server seed')).toString('hex'),
  rotateAfter: timestamp(row.rotateAfter, 'seed rotation timestamp'),
  status: status(row.status),
});

const parseEncryptedSeedSet = (row: SeedSetRow): EncryptedSeedSet => ({
  ...parsePublicSeedSet(row),
  authenticationTag: bytes(row.authenticationTag, 'seed authentication tag'),
  ciphertext: bytes(row.ciphertext, 'seed ciphertext'),
  encryptionIv: bytes(row.encryptionIv, 'seed encryption IV'),
  encryptionKeyIdentity:
    row.encryptionKeyIdentity === null ? null : encryptionKeyIdentity(row.encryptionKeyIdentity),
  encryptionKeyVersion: requiredString(row.encryptionKeyVersion, 'seed encryption key version'),
  retirementReason: nullableString(row.retirementReason, 'seed retirement reason'),
  userId: requiredString(row.userId, 'seed user ID') as UserId,
});

export const findFairnessProfile = async (
  executor: QueryExecutor,
  userId: UserId,
): Promise<FairnessProfile | undefined> => {
  const result = await executor.query<FairnessProfileRow>(
    `select ${profileColumns} from app.fairness_profiles where user_id = $1`,
    [userId],
  );
  return result.rows[0] === undefined ? undefined : parseProfile(result.rows[0]);
};

export const lockFairnessProfile = async (
  executor: QueryExecutor,
  userId: UserId,
): Promise<FairnessProfile | undefined> => {
  const result = await executor.query<FairnessProfileRow>(
    `select ${profileColumns} from app.fairness_profiles where user_id = $1 for update`,
    [userId],
  );
  return result.rows[0] === undefined ? undefined : parseProfile(result.rows[0]);
};

export const insertFairnessProfile = async (
  executor: QueryExecutor,
  userId: UserId,
  clientSeed: ClientSeed,
  timestampValue: string,
): Promise<FairnessProfile | undefined> => {
  const result = await executor.query<FairnessProfileRow>(
    `insert into app.fairness_profiles (
       user_id, current_client_seed, created_at, updated_at
     ) values ($1, $2, $3, $3)
     on conflict (user_id) do nothing
     returning ${profileColumns}`,
    [userId, clientSeed, timestampValue],
  );
  return result.rows[0] === undefined ? undefined : parseProfile(result.rows[0]);
};

export const updateFairnessClientSeed = async (
  executor: QueryExecutor,
  userId: UserId,
  clientSeed: ClientSeed,
  expectedRevision: number,
  timestampValue: string,
): Promise<FairnessProfile | undefined> => {
  const result = await executor.query<FairnessProfileRow>(
    `update app.fairness_profiles
        set current_client_seed = $2,
            revision = revision + 1,
            updated_at = $3
      where user_id = $1 and revision = $4
      returning ${profileColumns}`,
    [userId, clientSeed, timestampValue, expectedRevision],
  );
  return result.rows[0] === undefined ? undefined : parseProfile(result.rows[0]);
};

export const insertSeedSet = async (
  executor: QueryExecutor,
  input: SeedSetInsert,
): Promise<PublicSeedSet> => {
  const result = await executor.query<PublicSeedSetRow>(
    `insert into app.rng_seed_sets (
       id, user_id, commitment, server_seed_ciphertext, encryption_iv,
       encryption_auth_tag, encryption_key_version, rng_algorithm_version,
       max_nonce_exclusive, rotate_after, rotated_from_seed_set_id, created_at
     ) values (
       $1, $2, decode($3, 'hex'), $4, $5, $6, $7, $8, $9, $10, $11, $12
     ) returning ${publicSeedSetColumns}`,
    [
      input.id,
      input.userId,
      input.commitment,
      Buffer.from(input.ciphertext),
      Buffer.from(input.encryptionIv),
      Buffer.from(input.authenticationTag),
      input.encryptionKeyVersion,
      input.algorithmVersion,
      input.maxNonceExclusive.toString(),
      input.rotateAfter,
      input.rotatedFromSeedSetId,
      input.createdAt,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('Seed-set insertion returned no row.');
  return parsePublicSeedSet(row);
};

export const findEncryptionKeyIdentity = async (
  executor: QueryExecutor,
  version: string,
): Promise<string | undefined> => {
  const result = await executor.query<EncryptionKeyVersionRow>(
    `select encode(key_identity, 'hex') as "keyIdentity"
       from app.rng_encryption_key_versions
      where version = $1`,
    [version],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : encryptionKeyIdentity(row.keyIdentity);
};

export const findActiveSeedSet = async (
  executor: QueryExecutor,
  userId: UserId,
  lock = false,
): Promise<EncryptedSeedSet | undefined> => {
  const result = await executor.query<SeedSetRow>(
    `select ${seedSetColumns}
       from app.rng_seed_sets
      where user_id = $1 and status = 'active'
      ${lock ? 'for update' : ''}`,
    [userId],
  );
  return result.rows[0] === undefined ? undefined : parseEncryptedSeedSet(result.rows[0]);
};

export const findSeedSetForUser = async (
  executor: QueryExecutor,
  userId: UserId,
  seedSetId: RngSeedSetId,
  lock = false,
): Promise<EncryptedSeedSet | undefined> => {
  const result = await executor.query<SeedSetRow>(
    `select ${seedSetColumns}
       from app.rng_seed_sets
      where user_id = $1 and id = $2
      ${lock ? 'for update' : ''}`,
    [userId, seedSetId],
  );
  return result.rows[0] === undefined ? undefined : parseEncryptedSeedSet(result.rows[0]);
};

export const findPublicSeedSet = async (
  executor: QueryExecutor,
  seedSetId: RngSeedSetId,
): Promise<PublicSeedSet | undefined> => {
  const result = await executor.query<PublicSeedSetRow>(
    `select ${publicSeedSetColumns} from app.rng_seed_sets where id = $1`,
    [seedSetId],
  );
  return result.rows[0] === undefined ? undefined : parsePublicSeedSet(result.rows[0]);
};

export const allocateSeedSetNonce = async (
  executor: QueryExecutor,
  seedSetId: RngSeedSetId,
): Promise<string | undefined> => {
  const result = await executor.query<{ readonly nonce: unknown }>(
    `update app.rng_seed_sets
        set next_nonce = next_nonce + 1
      where id = $1
        and status = 'active'
        and next_nonce < max_nonce_exclusive
        and clock_timestamp() < rotate_after
      returning (next_nonce - 1)::text as nonce`,
    [seedSetId],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : requiredString(row.nonce, 'allocated seed nonce');
};

export const readDatabaseTimestamp = async (executor: QueryExecutor): Promise<string> => {
  const result = await executor.query<{ readonly timestamp: unknown }>(
    `select clock_timestamp() as timestamp`,
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('Database returned no lifecycle timestamp.');
  return timestamp(row.timestamp, 'lifecycle timestamp');
};

export const retireSeedSet = async (
  executor: QueryExecutor,
  seedSetId: RngSeedSetId,
  reason: string,
  timestampValue: string,
): Promise<void> => {
  const result = await executor.query(
    `update app.rng_seed_sets
        set status = 'retired', retirement_reason = $2, retired_at = $3
      where id = $1 and status = 'active'`,
    [seedSetId, reason, timestampValue],
  );
  if (result.rowCount !== 1) throw new Error('The locked active seed was not retired.');
};

export const revealSeedSet = async (
  executor: QueryExecutor,
  seedSetId: RngSeedSetId,
  serverSeed: Uint8Array,
  timestampValue: string,
): Promise<EncryptedSeedSet> => {
  const plaintextParameter = Buffer.from(serverSeed);
  try {
    const result = await executor.query<SeedSetRow>(
      `update app.rng_seed_sets
          set status = 'revealed', revealed_server_seed = $2, revealed_at = $3
        where id = $1 and status = 'retired'
        returning ${seedSetColumns}`,
      [seedSetId, plaintextParameter, timestampValue],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('The locked retired seed was not revealed.');
    return parseEncryptedSeedSet(row);
  } finally {
    plaintextParameter.fill(0);
  }
};

export const establishSeedSetKeyIdentity = async (
  executor: QueryExecutor,
  seedSetId: RngSeedSetId,
): Promise<EncryptedSeedSet> => {
  const result = await executor.query<SeedSetRow>(
    `update app.rng_seed_sets as seed_set
        set encryption_key_identity = (
          select key_identity
            from app.rng_encryption_key_versions
           where version = seed_set.encryption_key_version
        )
      where seed_set.id = $1
        and seed_set.encryption_key_identity is null
        and exists (
          select 1
            from app.rng_encryption_key_versions
           where version = seed_set.encryption_key_version
        )
      returning ${seedSetColumns}`,
    [seedSetId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('The legacy seed key identity was not established.');
  return parseEncryptedSeedSet(row);
};

export const compromiseSeedSet = async (
  executor: QueryExecutor,
  seedSetId: RngSeedSetId,
  reason: string,
  timestampValue: string,
): Promise<void> => {
  const result = await executor.query(
    `update app.rng_seed_sets
        set status = 'compromised', compromise_reason = $2, compromised_at = $3
      where id = $1 and status in ('active', 'retired')`,
    [seedSetId, reason, timestampValue],
  );
  if (result.rowCount !== 1) throw new Error('The seed set was not marked compromised.');
};

export const findRotation = async (
  executor: QueryExecutor,
  userId: UserId,
  idempotencyKey: string,
): Promise<RotationRecord | undefined> => {
  const result = await executor.query<RotationRow>(
    `select id::text as id,
            previous_seed_set_id::text as "previousSeedSetId",
            new_seed_set_id::text as "newSeedSetId",
            encode(operation_fingerprint, 'hex') as "operationFingerprint",
            operation_type as "operationType",
            transition_reason as "transitionReason"
       from app.rng_seed_rotations
      where user_id = $1 and idempotency_key = $2`,
    [userId, idempotencyKey],
  );
  const row = result.rows[0];
  if (row === undefined) return undefined;
  return {
    id: requiredString(row.id, 'rotation ID') as RngRotationId,
    newSeedSetId:
      row.newSeedSetId === null
        ? null
        : (requiredString(row.newSeedSetId, 'new seed-set ID') as RngSeedSetId),
    operationFingerprint: requiredString(row.operationFingerprint, 'rotation fingerprint'),
    operationType: requiredString(
      row.operationType,
      'rotation operation type',
    ) as RotationRecord['operationType'],
    previousSeedSetId: requiredString(
      row.previousSeedSetId,
      'previous seed-set ID',
    ) as RngSeedSetId,
    transitionReason: requiredString(row.transitionReason, 'rotation transition reason'),
  };
};

export const insertRotation = async (
  executor: QueryExecutor,
  input: RotationRecord & { readonly idempotencyKey: string; readonly userId: UserId },
): Promise<void> => {
  await executor.query(
    `insert into app.rng_seed_rotations (
       id, user_id, idempotency_key, previous_seed_set_id, new_seed_set_id,
       operation_fingerprint, operation_type, transition_reason, completed_at
     ) values ($1, $2, $3, $4, $5, decode($6, 'hex'), $7, $8,
       case when $5::uuid is null then null else clock_timestamp() end)`,
    [
      input.id,
      input.userId,
      input.idempotencyKey,
      input.previousSeedSetId,
      input.newSeedSetId,
      input.operationFingerprint,
      input.operationType,
      input.transitionReason,
    ],
  );
};

export const completeRotation = async (
  executor: QueryExecutor,
  rotationId: RngRotationId,
  newSeedSetId: RngSeedSetId,
): Promise<void> => {
  const result = await executor.query(
    `update app.rng_seed_rotations
        set new_seed_set_id = $2, completed_at = clock_timestamp()
      where id = $1 and new_seed_set_id is null`,
    [rotationId, newSeedSetId],
  );
  if (result.rowCount !== 1) throw new Error('The pending seed remediation was not completed.');
};
