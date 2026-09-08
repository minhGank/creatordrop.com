import { createHash, randomUUID } from 'node:crypto';

import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { parseDatabaseEnvironment, parseMigrationEnvironment } from '@creatordrop/config';
import { createDatabasePool, type Database, type QueryExecutor } from '@creatordrop/database';
import type { LogAttributes, Logger } from '@creatordrop/observability';

import { createApp } from '../src/app.js';
import { createAuthenticationMiddleware } from '../src/modules/auth/authentication.middleware.js';
import { createJwtVerifier } from '../src/modules/auth/jwt-verifier.js';
import type { UserId } from '../src/modules/creators/creator.js';
import {
  commitServerSeed,
  type SecureRandomBytes,
} from '../src/modules/fairness/fairness.crypto.js';
import {
  FairnessRevisionConflictError,
  SeedRevealNotAllowedError,
  SeedEncryptionKeyUnavailableError,
  SeedReplacementKeyUnsafeError,
  SeedRotationIdempotencyConflictError,
  SeedRotationRequiredError,
  SeedSetCompromisedError,
  SeedSetNotFoundError,
  SeedSetUnavailableError,
} from '../src/modules/fairness/fairness.errors.js';
import {
  createEnvironmentSeedEncryptionKeyProvider,
  type SeedEncryptionKey,
  type SeedEncryptionKeyProvider,
} from '../src/modules/fairness/fairness.key-provider.js';
import {
  allocateSeedSetNonce,
  lockFairnessProfile,
} from '../src/modules/fairness/fairness.repository.js';
import {
  allocateNextNonce,
  createFairnessService,
  type FairnessService,
} from '../src/modules/fairness/fairness.service.js';
import type { ClientSeed, RngSeedSetId } from '../src/modules/fairness/fairness.js';
import { createUserBootstrapService } from '../src/modules/users/bootstrap-user.service.js';
import {
  createUnhandledCatalogService,
  createUnhandledCreatorService,
} from './support/test-app.js';

const localApplicationUrl =
  'postgresql://postgres:postgres@127.0.0.1:54322/postgres?options=-c%20role%3Dcreatordrop_app';
const localMigrationUrl = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const masterKeyHex = '70'.repeat(32);
const keyVersion = 'synthetic-integration-v1';
const historicalKeyVersion = 'synthetic-history-v2';
const replacementKeyVersion = 'synthetic-replacement-v2';
const concurrentReplacementKeyVersion = 'synthetic-concurrent-replacement-v2';
const legacyReplacementKeyVersion = 'synthetic-legacy-replacement-v2';
const providerRecoveryKeyVersion = 'synthetic-provider-recovery-v2';
const insertionRecoveryKeyVersion = 'synthetic-insertion-recovery-v2';
const semanticNonActiveKeyVersion = 'synthetic-semantic-nonactive-v2';
const semanticValidKeyVersion = 'synthetic-semantic-valid-v2';
const firstClientSeed = '21'.repeat(32) as ClientSeed;
const secondClientSeed = '22'.repeat(32) as ClientSeed;

const rotationFingerprint = (
  operationType: 'compromise_replacement' | 'rotation',
  reason: string,
): string =>
  createHash('sha256')
    .update(`creatordrop:rng-rotation:v1|${operationType}|${reason}`, 'utf8')
    .digest('hex');

const keyIdentity = (keyHex: string): string =>
  createHash('sha256').update(Buffer.from(keyHex, 'hex')).digest('hex');

const requireEnvironment = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Required integration environment ${name} is missing.`);
  }
  return value;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

interface LocalAuthIdentity {
  readonly accessToken: string;
  readonly subject: string;
}

interface TestActor extends LocalAuthIdentity {
  readonly userId: UserId;
}

interface AuditRecord {
  readonly attributes: LogAttributes | undefined;
  readonly message: string;
}

const parseLocalAuthIdentity = (body: unknown): LocalAuthIdentity => {
  if (
    !isRecord(body) ||
    typeof body.access_token !== 'string' ||
    !isRecord(body.user) ||
    typeof body.user.id !== 'string'
  ) {
    throw new Error('Local Supabase Auth returned an unexpected sign-up response.');
  }
  return { accessToken: body.access_token, subject: body.user.id };
};

const parseInitializedSeedSetId = (body: unknown): RngSeedSetId => {
  if (
    !isRecord(body) ||
    !isRecord(body.fairness) ||
    !isRecord(body.fairness.activeSeedSet) ||
    typeof body.fairness.activeSeedSet.id !== 'string'
  ) {
    throw new Error('Fairness initialization returned an unexpected response.');
  }
  return body.fairness.activeSeedSet.id as RngSeedSetId;
};

const parsePublicSeedSet = (body: unknown): Record<string, unknown> => {
  if (!isRecord(body) || !isRecord(body.seedSet)) {
    throw new Error('Public seed-set endpoint returned an unexpected response.');
  }
  return body.seedSet;
};

const createBarrier = (participants: number): (() => Promise<void>) => {
  let arrived = 0;
  let release: (() => void) | undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    arrived += 1;
    if (arrived === participants) release?.();
    await released;
  };
};

describe('RNG seed lifecycle', { concurrent: false }, () => {
  const apiUrl = requireEnvironment('LOCAL_SUPABASE_API_URL').replace(/\/$/u, '');
  const publishableKey = requireEnvironment('LOCAL_SUPABASE_PUBLISHABLE_KEY');
  const authIssuer = `${apiUrl}/auth/v1`;
  const applicationEnvironment = parseDatabaseEnvironment({
    DATABASE_APPLICATION_NAME: 'creatordrop-fairness-integration-test',
    DATABASE_CONNECTION_TIMEOUT_MS: '5000',
    DATABASE_IDLE_TIMEOUT_MS: '1000',
    DATABASE_POOL_MAX: '40',
    DATABASE_URL: process.env.DATABASE_URL ?? localApplicationUrl,
  });
  const migrationEnvironment = parseMigrationEnvironment({
    DATABASE_MIGRATION_URL: process.env.DATABASE_MIGRATION_URL ?? localMigrationUrl,
  });
  const auditRecords: AuditRecord[] = [];
  const logger: Logger = {
    error: (message, attributes) => auditRecords.push({ attributes, message }),
    info: (message, attributes) => auditRecords.push({ attributes, message }),
  };
  let applicationDatabase: Database;
  let migrationDatabase: Database;
  let generatedSeedHexes: string[];
  let seedByte: number;
  let ivByte: number;

  const keyProvider = (
    version = keyVersion,
    keyHex = masterKeyHex,
    historicalKeys: Readonly<Record<string, string>> = {},
  ) => createEnvironmentSeedEncryptionKeyProvider({ historicalKeys, keyHex, version });

  const generateSeed = (): Uint8Array => {
    seedByte += 1;
    const seed = new Uint8Array(32).fill(seedByte);
    generatedSeedHexes.push(Buffer.from(seed).toString('hex'));
    return seed;
  };

  const generateIv: SecureRandomBytes = (size) => {
    ivByte += 1;
    return new Uint8Array(size).fill(ivByte);
  };

  const unavailableKeyProvider = (): SeedEncryptionKeyProvider => ({
    getActiveEncryptionKey: () => Promise.reject(new SeedEncryptionKeyUnavailableError()),
    getEncryptionKey: () => Promise.reject(new SeedEncryptionKeyUnavailableError()),
  });

  const provisionKeyVersion = async (version: string, keyHex: string): Promise<void> => {
    const identity = keyIdentity(keyHex);
    await migrationDatabase.query(
      `insert into app.rng_encryption_key_versions (version, key_identity)
       values ($1, decode($2, 'hex'))
       on conflict (version) do nothing`,
      [version, identity],
    );
    const registered = await migrationDatabase.query<{ readonly identity: string }>(
      `select encode(key_identity, 'hex') as identity
         from app.rng_encryption_key_versions
        where version = $1`,
      [version],
    );
    if (registered.rows[0]?.identity !== identity) {
      throw new Error('Synthetic RNG encryption key registration does not match its fixture.');
    }
  };

  const createService = (
    overrides: {
      readonly generateSeed?: () => Uint8Array;
      readonly keyProvider?: SeedEncryptionKeyProvider;
      readonly maxAgeMs?: number;
      readonly maxOpenings?: bigint;
    } = {},
  ): FairnessService =>
    createFairnessService({
      database: applicationDatabase,
      generateEncryptionIv: generateIv,
      generateSeed: overrides.generateSeed ?? generateSeed,
      keyProvider: overrides.keyProvider ?? keyProvider(),
      logger,
      policy: {
        maxAgeMs: overrides.maxAgeMs ?? 86_400_000,
        maxOpenings: overrides.maxOpenings ?? 1000n,
      },
    });

  const createIntegratedApp = (fairnessService: FairnessService) => {
    const verifyAccessToken = createJwtVerifier({
      audience: 'authenticated',
      issuer: authIssuer,
      jwksUrl: `${authIssuer}/.well-known/jwks.json`,
      provider: 'supabase',
    });
    return createApp({
      authenticate: createAuthenticationMiddleware({
        bootstrapUsers: createUserBootstrapService({ database: applicationDatabase }),
        verifyAccessToken,
      }),
      catalogService: createUnhandledCatalogService(),
      creatorService: createUnhandledCreatorService(),
      fairnessService,
      logger,
      security: {
        allowedOrigins: ['http://localhost:5173'],
        authRateLimitMax: 10_000,
        authRateLimitWindowMs: 60_000,
        creatorMutationRateLimitMax: 10_000,
        creatorMutationRateLimitWindowMs: 60_000,
        fairnessMutationRateLimitMax: 10_000,
        fairnessMutationRateLimitWindowMs: 60_000,
        openingMutationRateLimitMax: 10_000,
        openingMutationRateLimitWindowMs: 60_000,
        requestBodyLimitBytes: 32_768,
      },
    });
  };

  const authorization = (actor: TestActor): { readonly Authorization: string } => ({
    Authorization: `Bearer ${actor.accessToken}`,
  });

  const removeSyntheticState = async (): Promise<void> => {
    await migrationDatabase.transaction(async (transaction) => {
      await transaction.query(`set local session_replication_role = replica`);
      await transaction.query(`
        delete from app.rng_seed_rotations
         where user_id in (
           select id from app.users
            where auth_provider = 'supabase' and auth_subject in (
              select id::text from auth.users where email like 'phase7-%@example.test'
            )
         )
      `);
      await transaction.query(`
        delete from app.rng_seed_sets
         where user_id in (
           select id from app.users
            where auth_provider = 'supabase' and auth_subject in (
              select id::text from auth.users where email like 'phase7-%@example.test'
            )
         )
      `);
      await transaction.query(`
        delete from app.fairness_profiles
         where user_id in (
           select id from app.users
            where auth_provider = 'supabase' and auth_subject in (
              select id::text from auth.users where email like 'phase7-%@example.test'
            )
         )
      `);
      await transaction.query(`
        delete from app.users
         where auth_provider = 'supabase' and auth_subject in (
           select id::text from auth.users where email like 'phase7-%@example.test'
         )
      `);
      await transaction.query(`delete from auth.users where email like 'phase7-%@example.test'`);
    });
    auditRecords.length = 0;
    generatedSeedHexes = [];
    seedByte = 0;
    ivByte = 0;
  };

  const createLocalAuthIdentity = async (): Promise<LocalAuthIdentity> => {
    const response = await fetch(`${authIssuer}/signup`, {
      body: JSON.stringify({
        email: `phase7-${randomUUID()}@example.test`,
        password: `Local-only-${randomUUID()}-Aa1!`,
      }),
      headers: { apikey: publishableKey, 'content-type': 'application/json' },
      method: 'POST',
    });
    if (!response.ok) {
      throw new Error(`Local Supabase Auth sign-up failed: ${response.status.toString()}.`);
    }
    return parseLocalAuthIdentity(await response.json());
  };

  const createActor = async (app: ReturnType<typeof createIntegratedApp>): Promise<TestActor> => {
    const identity = await createLocalAuthIdentity();
    const exchange = await request(app)
      .post('/v1/auth/session/exchange')
      .set(authorization({ ...identity, userId: '' as UserId }))
      .send({});
    expect(exchange.status).toBe(200);
    const result = await applicationDatabase.query<{ readonly id: string }>(
      `select id::text as id from app.users
        where auth_provider = 'supabase' and auth_subject = $1`,
      [identity.subject],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('Local fairness actor was not bootstrapped.');
    return { ...identity, userId: row.id as UserId };
  };

  const initializeDirect = async (
    service: FairnessService,
    actor: TestActor,
    clientSeed = firstClientSeed,
  ) => {
    const initialized = await service.initialize({
      requestId: randomUUID(),
      userId: actor.userId,
    });
    if (initialized.fairness.clientSeed !== null) return initialized;
    try {
      const fairness = await service.updateClientSeed({
        clientSeed,
        expectedRevision: initialized.fairness.revision,
        expectedSeedSetId: initialized.fairness.activeSeedSet.id,
        expectedServerSeedCommitment: initialized.fairness.activeSeedSet.commitment,
        requestId: randomUUID(),
        userId: actor.userId,
      });
      return { ...initialized, fairness };
    } catch (error) {
      if (!(error instanceof FairnessRevisionConflictError)) throw error;
      return { ...initialized, fairness: await service.getCurrent(actor.userId) };
    }
  };

  const corruptWithTriggersDisabled = async (operation: (tx: QueryExecutor) => Promise<void>) => {
    await migrationDatabase.transaction(async (transaction) => {
      await transaction.query(`set local session_replication_role = replica`);
      await operation(transaction);
    });
  };

  beforeAll(async () => {
    applicationDatabase = createDatabasePool({
      ...applicationEnvironment,
      onUnexpectedPoolError: (error) => {
        throw error;
      },
    });
    migrationDatabase = createDatabasePool({
      ...applicationEnvironment,
      applicationName: 'creatordrop-fairness-integration-admin',
      connectionString: migrationEnvironment.connectionString,
      onUnexpectedPoolError: (error) => {
        throw error;
      },
    });
    for (const [version, keyHex] of [
      [keyVersion, masterKeyHex],
      [historicalKeyVersion, '83'.repeat(32)],
      [replacementKeyVersion, '44'.repeat(32)],
      [concurrentReplacementKeyVersion, '45'.repeat(32)],
      [legacyReplacementKeyVersion, '46'.repeat(32)],
      [providerRecoveryKeyVersion, '55'.repeat(32)],
      [insertionRecoveryKeyVersion, '66'.repeat(32)],
      [semanticNonActiveKeyVersion, '31'.repeat(32)],
      [semanticValidKeyVersion, '32'.repeat(32)],
    ] as const) {
      await provisionKeyVersion(version, keyHex);
    }
    await removeSyntheticState();
  });

  afterEach(removeSyntheticState);

  afterAll(async () => {
    await removeSyntheticState();
    await Promise.all([applicationDatabase.close(), migrationDatabase.close()]);
  });

  it('initializes authenticated fairness state without exposing active seed material', async () => {
    const service = createService();
    const app = createIntegratedApp(service);
    const actor = await createActor(app);
    const otherActor = await createActor(app);

    expect((await request(app).get('/v1/me/fairness').set(authorization(actor))).status).toBe(404);
    const initialized = await request(app)
      .post('/v1/me/fairness')
      .set(authorization(actor))
      .send({});
    expect(initialized.status).toBe(201);
    expect(initialized.headers.etag).toBe('"1"');
    expect(initialized.body).toMatchObject({
      fairness: {
        activeSeedSet: {
          algorithmVersion: 'hmac-sha256-rejection-v1',
          nextNonce: '0',
          revealedServerSeed: null,
          status: 'active',
        },
        clientSeed: null,
        revision: 1,
      },
    });
    const seedSetId = parseInitializedSeedSetId(initialized.body);
    expect(
      (await request(app).post('/v1/me/fairness').set(authorization(actor)).send({})).status,
    ).toBe(200);
    const rawSeedHex = generatedSeedHexes[0];
    if (rawSeedHex === undefined) throw new Error('Expected generated seed evidence.');
    const persisted = await migrationDatabase.query<{
      readonly authTagLength: number;
      readonly ciphertextHex: string;
      readonly ciphertextLength: number;
      readonly commitment: string;
      readonly ivLength: number;
      readonly keyIdentity: string;
      readonly keyVersion: string;
      readonly revealed: Buffer | null;
    }>(
      `select encode(commitment, 'hex') as commitment,
              encode(server_seed_ciphertext, 'hex') as "ciphertextHex",
              octet_length(server_seed_ciphertext) as "ciphertextLength",
              octet_length(encryption_iv) as "ivLength",
              octet_length(encryption_auth_tag) as "authTagLength",
              encode(encryption_key_identity, 'hex') as "keyIdentity",
              encryption_key_version as "keyVersion",
              revealed_server_seed as revealed
         from app.rng_seed_sets where id = $1`,
      [seedSetId],
    );
    expect(persisted.rows[0]).toMatchObject({
      authTagLength: 16,
      ciphertextLength: 32,
      commitment: commitServerSeed(Buffer.from(rawSeedHex, 'hex')),
      ivLength: 12,
      keyIdentity: keyIdentity(masterKeyHex),
      keyVersion,
      revealed: null,
    });
    expect(persisted.rows[0]?.ciphertextHex).not.toBe(rawSeedHex);

    const serializedResponse = JSON.stringify(initialized.body);
    for (const secret of [rawSeedHex, persisted.rows[0]?.ciphertextHex, masterKeyHex]) {
      expect(serializedResponse).not.toContain(secret);
    }
    const publicState = await request(app).get(`/v1/fairness/seed-sets/${seedSetId}`);
    expect(publicState.status).toBe(200);
    expect(parsePublicSeedSet(publicState.body)).toMatchObject({
      commitment: persisted.rows[0]?.commitment,
      revealedServerSeed: null,
      status: 'active',
    });

    const updated = await request(app)
      .put('/v1/me/fairness/client-seed')
      .set(authorization(actor))
      .set('If-Match', '"1"')
      .send({
        clientSeed: firstClientSeed,
        expectedSeedSetId: seedSetId,
        expectedServerSeedCommitment: persisted.rows[0]?.commitment,
      });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ fairness: { clientSeed: firstClientSeed, revision: 2 } });
    const changed = await request(app)
      .put('/v1/me/fairness/client-seed')
      .set(authorization(actor))
      .set('If-Match', '"2"')
      .send({
        clientSeed: secondClientSeed,
        expectedSeedSetId: seedSetId,
        expectedServerSeedCommitment: persisted.rows[0]?.commitment,
      });
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({ fairness: { clientSeed: secondClientSeed, revision: 3 } });
    const stale = await request(app)
      .put('/v1/me/fairness/client-seed')
      .set(authorization(actor))
      .set('If-Match', '"2"')
      .send({
        clientSeed: firstClientSeed,
        expectedSeedSetId: seedSetId,
        expectedServerSeedCommitment: persisted.rows[0]?.commitment,
      });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ error: { code: 'FAIRNESS_REVISION_CONFLICT' } });
    expect(
      (
        await request(app)
          .put('/v1/me/fairness/client-seed')
          .set(authorization(actor))
          .set('If-Match', '"3"')
          .send({
            clientSeed: 'AA'.repeat(32),
            expectedSeedSetId: seedSetId,
            expectedServerSeedCommitment: persisted.rows[0]?.commitment,
          })
      ).status,
    ).toBe(400);

    expect((await request(app).get('/v1/me/fairness').set(authorization(otherActor))).status).toBe(
      404,
    );
    await expect(
      service.revealRetiredSeedSet({
        actorUserId: otherActor.userId,
        requestId: randomUUID(),
        seedSetId,
      }),
    ).rejects.toThrow(SeedSetNotFoundError);

    const serializedLogs = JSON.stringify(auditRecords);
    for (const secret of [rawSeedHex, persisted.rows[0]?.ciphertextHex, masterKeyHex]) {
      expect(serializedLogs).not.toContain(secret);
    }
  });

  it('rolls back the new fairness profile when initial active-seed insertion fails', async () => {
    const service = createService();
    const app = createIntegratedApp(service);
    const existingActor = await createActor(app);
    await initializeDirect(service, existingActor);
    const duplicateSeedHex = generatedSeedHexes.at(-1);
    if (duplicateSeedHex === undefined) throw new Error('Expected a generated server seed.');

    const newActor = await createActor(app);
    const failingService = createService({
      generateSeed: () => Uint8Array.from(Buffer.from(duplicateSeedHex, 'hex')),
    });
    await expect(initializeDirect(failingService, newActor)).rejects.toMatchObject({
      constraint: 'rng_seed_sets_commitment_unique',
    });

    const failedState = await applicationDatabase.query<{
      readonly idempotencyRecords: string;
      readonly openings: string;
      readonly profiles: string;
      readonly seedSets: string;
      readonly wallets: string;
    }>(
      `select
         (select count(*)::text from app.fairness_profiles where user_id = $1) as profiles,
         (select count(*)::text from app.rng_seed_sets where user_id = $1) as "seedSets",
         (select count(*)::text from app.wallets where user_id = $1) as wallets,
         (select count(*)::text from app.box_opens where user_id = $1) as openings,
         (select count(*)::text from app.idempotency_records where actor_user_id = $1)
           as "idempotencyRecords"`,
      [newActor.userId],
    );
    expect(failedState.rows).toEqual([
      { idempotencyRecords: '0', openings: '0', profiles: '0', seedSets: '0', wallets: '0' },
    ]);

    await expect(initializeDirect(service, newActor)).resolves.toMatchObject({
      created: true,
      fairness: { activeSeedSet: { nextNonce: '0', status: 'active' }, revision: 2 },
    });
  });

  it('allocates sequential and concurrent nonces under PostgreSQL locks with rollback reuse', async () => {
    const service = createService();
    const app = createIntegratedApp(service);
    const actor = await createActor(app);
    await initializeDirect(service, actor);

    await expect(
      Reflect.apply(allocateNextNonce, undefined, [applicationDatabase, { userId: actor.userId }]),
    ).rejects.toThrow('An active transaction executor is required.');

    await expect(
      applicationDatabase.transaction(async (transaction) => {
        await transaction.query('savepoint before_nonce');
        const allocation = await allocateNextNonce(transaction, { userId: actor.userId });
        await transaction.query('rollback to savepoint before_nonce');
        return allocation;
      }),
    ).rejects.toThrow('Transaction control is owned by the transaction helper.');
    expect((await service.getCurrent(actor.userId)).activeSeedSet.nextNonce).toBe('0');

    let unawaitedAllocation: ReturnType<typeof allocateNextNonce> | undefined;
    await expect(
      applicationDatabase.transaction((transaction) => {
        unawaitedAllocation = allocateNextNonce(transaction, { userId: actor.userId });
        void unawaitedAllocation.catch(() => undefined);
        return Promise.resolve();
      }),
    ).rejects.toThrow('Transaction callback completed with outstanding queries.');
    expect(unawaitedAllocation).toBeDefined();
    if (unawaitedAllocation === undefined) throw new Error('Expected an unawaited allocation.');
    await expect(unawaitedAllocation).rejects.toThrow(
      'An active transaction executor is required.',
    );
    expect((await service.getCurrent(actor.userId)).activeSeedSet.nextNonce).toBe('0');

    const allocate = () =>
      applicationDatabase.transaction((transaction) =>
        allocateNextNonce(transaction, { userId: actor.userId }),
      );
    expect((await allocate()).nonce).toBe(0n);
    expect((await allocate()).nonce).toBe(1n);

    await expect(
      applicationDatabase.transaction(async (transaction) => {
        const allocation = await allocateNextNonce(transaction, { userId: actor.userId });
        expect(allocation.nonce).toBe(2n);
        throw new Error('synthetic rollback');
      }),
    ).rejects.toThrow('synthetic rollback');
    expect((await service.getCurrent(actor.userId)).activeSeedSet.nextNonce).toBe('2');

    const participants = 12;
    const barrier = createBarrier(participants);
    const concurrent = await Promise.all(
      Array.from({ length: participants }, () =>
        applicationDatabase.transaction(async (transaction) => {
          await barrier();
          return allocateNextNonce(transaction, { userId: actor.userId });
        }),
      ),
    );
    expect(concurrent.map(({ nonce }) => nonce).sort((a, b) => (a < b ? -1 : 1))).toEqual(
      Array.from({ length: participants }, (_, index) => BigInt(index + 2)),
    );
    expect((await service.getCurrent(actor.userId)).activeSeedSet.nextNonce).toBe('14');

    const freshServiceInstance = createService();
    expect(
      (
        await applicationDatabase.transaction((transaction) =>
          allocateNextNonce(transaction, { userId: actor.userId }),
        )
      ).nonce,
    ).toBe(14n);
    expect((await freshServiceInstance.getCurrent(actor.userId)).activeSeedSet.nextNonce).toBe(
      '15',
    );
  });

  it('serializes rotation with allocation, keeps one active seed, and reveals only retired history', async () => {
    const service = createService();
    const app = createIntegratedApp(service);
    const actor = await createActor(app);
    const initialized = await initializeDirect(service, actor);
    const firstSeedSetId = initialized.fairness.activeSeedSet.id;
    expect(
      (
        await applicationDatabase.transaction((transaction) =>
          allocateNextNonce(transaction, { userId: actor.userId }),
        )
      ).nonce,
    ).toBe(0n);

    let releaseAllocation: (() => void) | undefined;
    const mayAllocate = new Promise<void>((resolve) => {
      releaseAllocation = resolve;
    });
    let profileLocked: (() => void) | undefined;
    const locked = new Promise<void>((resolve) => {
      profileLocked = resolve;
    });
    const allocationPromise = applicationDatabase.transaction(async (transaction) => {
      expect(await lockFairnessProfile(transaction, actor.userId)).toBeDefined();
      profileLocked?.();
      await mayAllocate;
      return allocateNextNonce(transaction, { userId: actor.userId });
    });
    await locked;
    const rotationPromise = service.rotate({
      idempotencyKey: 'race_rotation_1',
      reason: 'policy_change',
      requestId: randomUUID(),
      userId: actor.userId,
    });
    releaseAllocation?.();
    const [racedAllocation, rotation] = await Promise.all([allocationPromise, rotationPromise]);
    expect(racedAllocation.nonce).toBe(1n);
    expect(rotation).toMatchObject({ previousSeedSetId: firstSeedSetId, replayed: false });
    expect(rotation.newSeedSet).toMatchObject({ nextNonce: '0', status: 'active' });
    expect(rotation.newSeedSet.id).not.toBe(firstSeedSetId);
    expect(rotation.newSeedSet.commitment).not.toBe(initialized.fairness.activeSeedSet.commitment);

    const stateRows = await applicationDatabase.query<{
      readonly activeCount: string;
      readonly retirementReason: string;
      readonly retiredCount: string;
    }>(
      `select count(*) filter (where status = 'active')::text as "activeCount",
              count(*) filter (where status = 'retired')::text as "retiredCount",
              max(retirement_reason) as "retirementReason"
         from app.rng_seed_sets where user_id = $1`,
      [actor.userId],
    );
    expect(stateRows.rows).toEqual([
      { activeCount: '1', retiredCount: '1', retirementReason: 'policy_change' },
    ]);
    await expect(
      allocateSeedSetNonce(applicationDatabase, firstSeedSetId),
    ).resolves.toBeUndefined();

    const replay = await service.rotate({
      idempotencyKey: 'race_rotation_1',
      reason: 'policy_change',
      requestId: randomUUID(),
      userId: actor.userId,
    });
    expect(replay).toMatchObject({
      newSeedSet: { id: rotation.newSeedSet.id },
      previousSeedSetId: firstSeedSetId,
      replayed: true,
    });
    const unavailableService = createService({ keyProvider: unavailableKeyProvider() });
    await expect(
      unavailableService.rotate({
        idempotencyKey: 'race_rotation_1',
        reason: 'policy_change',
        requestId: randomUUID(),
        userId: actor.userId,
      }),
    ).resolves.toMatchObject({ newSeedSet: { id: rotation.newSeedSet.id }, replayed: true });
    await expect(
      unavailableService.rotate({
        idempotencyKey: 'race_rotation_1',
        reason: 'user_request',
        requestId: randomUUID(),
        userId: actor.userId,
      }),
    ).rejects.toThrow(SeedRotationIdempotencyConflictError);
    await expect(
      unavailableService.replaceCompromisedActiveSeed({
        idempotencyKey: 'race_rotation_1',
        reason: 'operational_compromise',
        requestId: randomUUID(),
        userId: actor.userId,
      }),
    ).rejects.toThrow(SeedRotationIdempotencyConflictError);
    await expect(
      service.revealRetiredSeedSet({
        actorUserId: actor.userId,
        requestId: randomUUID(),
        seedSetId: rotation.newSeedSet.id,
      }),
    ).rejects.toThrow(SeedRevealNotAllowedError);

    const revealed = await service.revealRetiredSeedSet({
      actorUserId: actor.userId,
      requestId: randomUUID(),
      seedSetId: firstSeedSetId,
    });
    const firstRawSeed = generatedSeedHexes[0];
    expect(revealed).toMatchObject({
      id: firstSeedSetId,
      revealedServerSeed: firstRawSeed,
      status: 'revealed',
    });
    expect(
      await service.revealRetiredSeedSet({
        actorUserId: actor.userId,
        requestId: randomUUID(),
        seedSetId: firstSeedSetId,
      }),
    ).toEqual(revealed);
    const publicHistory = await request(app).get(`/v1/fairness/seed-sets/${firstSeedSetId}`);
    expect(parsePublicSeedSet(publicHistory.body)).toMatchObject({
      commitment: initialized.fairness.activeSeedSet.commitment,
      revealedServerSeed: firstRawSeed,
      status: 'revealed',
    });

    const concurrentKey = 'concurrent_rotation_same_key';
    const concurrentRotations = await Promise.all([
      service.rotate({
        idempotencyKey: concurrentKey,
        requestId: randomUUID(),
        userId: actor.userId,
      }),
      service.rotate({
        idempotencyKey: concurrentKey,
        requestId: randomUUID(),
        userId: actor.userId,
      }),
    ]);
    expect(concurrentRotations.map(({ replayed }) => replayed).sort()).toEqual([false, true]);
    expect(new Set(concurrentRotations.map(({ newSeedSet }) => newSeedSet.id)).size).toBe(1);
    const activeCount = await applicationDatabase.query<{ readonly count: string }>(
      `select count(*)::text as count from app.rng_seed_sets
        where user_id = $1 and status = 'active'`,
      [actor.userId],
    );
    expect(activeCount.rows).toEqual([{ count: '1' }]);
  });

  it('keeps retired history retryable while an old key is unavailable or mismatched', async () => {
    const originalService = createService();
    const app = createIntegratedApp(originalService);
    const actor = await createActor(app);
    const initialized = await initializeDirect(originalService, actor);
    await originalService.rotate({
      idempotencyKey: 'historical_key_rotation',
      requestId: randomUUID(),
      userId: actor.userId,
    });

    const v2WithoutHistory = createService({
      keyProvider: keyProvider(historicalKeyVersion, '83'.repeat(32)),
    });
    await expect(
      v2WithoutHistory.revealRetiredSeedSet({
        actorUserId: actor.userId,
        requestId: randomUUID(),
        seedSetId: initialized.fairness.activeSeedSet.id,
      }),
    ).rejects.toThrow(SeedEncryptionKeyUnavailableError);
    expect(
      await originalService.getPublicSeedSet(initialized.fairness.activeSeedSet.id),
    ).toMatchObject({ revealedServerSeed: null, status: 'retired' });

    const v2WithWrongHistory = createService({
      keyProvider: keyProvider(historicalKeyVersion, '83'.repeat(32), {
        [keyVersion]: '44'.repeat(32),
      }),
    });
    await expect(
      v2WithWrongHistory.revealRetiredSeedSet({
        actorUserId: actor.userId,
        requestId: randomUUID(),
        seedSetId: initialized.fairness.activeSeedSet.id,
      }),
    ).rejects.toThrow(SeedEncryptionKeyUnavailableError);
    expect(
      await originalService.getPublicSeedSet(initialized.fairness.activeSeedSet.id),
    ).toMatchObject({ revealedServerSeed: null, status: 'retired' });

    const v2WithHistory = createService({
      keyProvider: keyProvider(historicalKeyVersion, '83'.repeat(32), {
        [keyVersion]: masterKeyHex,
      }),
    });
    await expect(
      v2WithHistory.revealRetiredSeedSet({
        actorUserId: actor.userId,
        requestId: randomUUID(),
        seedSetId: initialized.fairness.activeSeedSet.id,
      }),
    ).resolves.toMatchObject({
      revealedServerSeed: generatedSeedHexes[0],
      status: 'revealed',
    });
  });

  it('requires different key material and version for key-compromise replacement', async () => {
    const originalService = createService();
    const app = createIntegratedApp(originalService);
    const actor = await createActor(app);
    const initialized = await initializeDirect(originalService, actor);
    const command = {
      idempotencyKey: 'key_compromise_replacement',
      reason: 'key_compromise' as const,
      requestId: randomUUID(),
      userId: actor.userId,
    };

    await expect(originalService.replaceCompromisedActiveSeed(command)).rejects.toThrow(
      SeedReplacementKeyUnsafeError,
    );
    await expect(originalService.getCurrent(actor.userId)).rejects.toThrow(SeedSetUnavailableError);
    await expect(
      applicationDatabase.transaction((transaction) =>
        allocateNextNonce(transaction, { userId: actor.userId }),
      ),
    ).rejects.toThrow(SeedSetUnavailableError);
    expect(
      await originalService.getPublicSeedSet(initialized.fairness.activeSeedSet.id),
    ).toMatchObject({ status: 'compromised' });

    await expect(
      createService({
        keyProvider: keyProvider(keyVersion, '44'.repeat(32)),
      }).replaceCompromisedActiveSeed(command),
    ).rejects.toThrow(SeedEncryptionKeyUnavailableError);

    const relabeledCompromisedKeyService = createService({
      keyProvider: keyProvider('synthetic-relabeled-compromised-v2', masterKeyHex),
    });
    await expect(
      relabeledCompromisedKeyService.replaceCompromisedActiveSeed(command),
    ).rejects.toThrow(SeedEncryptionKeyUnavailableError);

    const replacementService = createService({
      keyProvider: keyProvider(replacementKeyVersion, '44'.repeat(32), {
        [keyVersion]: masterKeyHex,
      }),
    });
    const replacement = await replacementService.replaceCompromisedActiveSeed(command);
    expect(replacement).toMatchObject({
      previousSeedSetId: initialized.fairness.activeSeedSet.id,
      replayed: false,
      newSeedSet: { nextNonce: '0', status: 'active' },
    });
    const stored = await migrationDatabase.query<{
      readonly keyIdentity: string;
      readonly keyVersion: string;
    }>(
      `select encode(encryption_key_identity, 'hex') as "keyIdentity",
              encryption_key_version as "keyVersion"
         from app.rng_seed_sets where id = $1`,
      [replacement.newSeedSet.id],
    );
    expect(stored.rows).toEqual([
      {
        keyIdentity: 'bb391415c05e39d77ca17381d3be3f7d0cd5e5332e5a579311adaa0aa62106e9',
        keyVersion: replacementKeyVersion,
      },
    ]);
  });

  it('serializes concurrent key-compromise remediation to one safe successor', async () => {
    const originalService = createService();
    const app = createIntegratedApp(originalService);
    const actor = await createActor(app);
    await initializeDirect(originalService, actor);
    const command = {
      idempotencyKey: 'concurrent_key_compromise_replacement',
      reason: 'key_compromise' as const,
      requestId: randomUUID(),
      userId: actor.userId,
    };
    const replacementProvider = keyProvider(concurrentReplacementKeyVersion, '45'.repeat(32));
    const results = await Promise.all([
      createService({ keyProvider: replacementProvider }).replaceCompromisedActiveSeed(command),
      createService({ keyProvider: replacementProvider }).replaceCompromisedActiveSeed(command),
    ]);

    expect(results.map(({ replayed }) => replayed).sort()).toEqual([false, true]);
    expect(new Set(results.map(({ newSeedSet }) => newSeedSet.id)).size).toBe(1);
    const state = await migrationDatabase.query<{
      readonly activeCount: string;
      readonly successorCount: string;
    }>(
      `select count(*) filter (where status = 'active')::text as "activeCount",
              count(*) filter (where rotated_from_seed_set_id is not null)::text as "successorCount"
         from app.rng_seed_sets where user_id = $1`,
      [actor.userId],
    );
    expect(state.rows).toEqual([{ activeCount: '1', successorCount: '1' }]);
  });

  it('fails closed when a legacy predecessor identity cannot be resolved', async () => {
    const originalService = createService();
    const app = createIntegratedApp(originalService);
    const actor = await createActor(app);
    const initialized = await initializeDirect(originalService, actor);
    await corruptWithTriggersDisabled(async (transaction) => {
      await transaction.query(
        `update app.rng_seed_sets set encryption_key_identity = null where id = $1`,
        [initialized.fairness.activeSeedSet.id],
      );
    });
    const command = {
      idempotencyKey: 'legacy_identity_key_compromise',
      reason: 'key_compromise' as const,
      requestId: randomUUID(),
      userId: actor.userId,
    };

    await expect(
      createService({
        keyProvider: keyProvider('synthetic-legacy-relabeled-v2', masterKeyHex),
      }).replaceCompromisedActiveSeed(command),
    ).rejects.toThrow(SeedEncryptionKeyUnavailableError);
    expect(
      await originalService.getPublicSeedSet(initialized.fairness.activeSeedSet.id),
    ).toMatchObject({ status: 'compromised' });
    await expect(originalService.getCurrent(actor.userId)).rejects.toThrow(SeedSetUnavailableError);

    await expect(
      createService({
        keyProvider: keyProvider(legacyReplacementKeyVersion, '46'.repeat(32), {
          [keyVersion]: masterKeyHex,
        }),
      }).replaceCompromisedActiveSeed(command),
    ).resolves.toMatchObject({ newSeedSet: { status: 'active' }, replayed: false });
    const predecessor = await migrationDatabase.query<{ readonly identity: string }>(
      `select encode(encryption_key_identity, 'hex') as identity
         from app.rng_seed_sets where id = $1`,
      [initialized.fairness.activeSeedSet.id],
    );
    expect(predecessor.rows).toEqual([{ identity: keyIdentity(masterKeyHex) }]);
  });

  it('returns a completed replay when a concurrent retry provider fails after its initial miss', async () => {
    const originalService = createService();
    const app = createIntegratedApp(originalService);
    const actor = await createActor(app);
    await initializeDirect(originalService, actor);
    let reportProviderEntered: (() => void) | undefined;
    const providerEntered = new Promise<void>((resolve) => {
      reportProviderEntered = resolve;
    });
    let releaseProvider: (() => void) | undefined;
    const providerMayFail = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const failingProvider: SeedEncryptionKeyProvider = {
      getActiveEncryptionKey: async () => {
        reportProviderEntered?.();
        await providerMayFail;
        throw new SeedEncryptionKeyUnavailableError();
      },
      getEncryptionKey: () => Promise.reject(new SeedEncryptionKeyUnavailableError()),
    };
    const command = {
      idempotencyKey: 'provider_failure_completed_replay',
      requestId: randomUUID(),
      userId: actor.userId,
    };
    const retry = createService({ keyProvider: failingProvider }).rotate(command);
    await providerEntered;
    const completed = await originalService.rotate(command);
    releaseProvider?.();

    await expect(retry).resolves.toMatchObject({
      newSeedSet: { id: completed.newSeedSet.id },
      replayed: true,
    });
  });

  it('maps a malformed provider key to the stable key-unavailable error', async () => {
    const baseService = createService();
    const app = createIntegratedApp(baseService);
    const actor = await createActor(app);
    const malformedKey: unknown = 'not-byte-key-material';
    const getterKey = new Uint8Array(32).fill(91);
    const malformedCandidates: readonly unknown[] = [
      { key: malformedKey, version: 'synthetic-malformed-v1' },
      Object.defineProperty({ version: 'synthetic-malformed-v1' }, 'key', {
        get: () => {
          throw new Error('synthetic throwing key getter');
        },
      }),
      Object.defineProperty({ key: getterKey }, 'version', {
        get: () => {
          throw new Error('synthetic throwing version getter');
        },
      }),
      new Proxy(
        {},
        {
          get: () => {
            throw new Error('synthetic throwing provider proxy');
          },
        },
      ),
    ];

    for (const malformedCandidate of malformedCandidates) {
      const malformedProvider: SeedEncryptionKeyProvider = {
        getActiveEncryptionKey: () => Promise.resolve(malformedCandidate as SeedEncryptionKey),
        getEncryptionKey: () => Promise.reject(new SeedEncryptionKeyUnavailableError()),
      };
      await expect(
        initializeDirect(createService({ keyProvider: malformedProvider }), actor),
      ).rejects.toThrow(SeedEncryptionKeyUnavailableError);
    }
    expect(getterKey).toEqual(new Uint8Array(32));
  });

  it('leaves zero active seeds after replacement provider or insertion failure and resumes safely', async () => {
    const originalService = createService();
    const app = createIntegratedApp(originalService);
    const providerFailureActor = await createActor(app);
    await initializeDirect(originalService, providerFailureActor);
    const unavailableService = createService({ keyProvider: unavailableKeyProvider() });
    await expect(initializeDirect(unavailableService, providerFailureActor)).resolves.toMatchObject(
      { created: false },
    );
    const providerFailureCommand = {
      idempotencyKey: 'provider_failure_replacement',
      reason: 'key_compromise' as const,
      requestId: randomUUID(),
      userId: providerFailureActor.userId,
    };
    await expect(
      unavailableService.replaceCompromisedActiveSeed(providerFailureCommand),
    ).rejects.toThrow(SeedEncryptionKeyUnavailableError);
    await expect(originalService.getCurrent(providerFailureActor.userId)).rejects.toThrow(
      SeedSetUnavailableError,
    );
    await expect(
      createService({
        keyProvider: keyProvider(providerRecoveryKeyVersion, '55'.repeat(32)),
      }).replaceCompromisedActiveSeed(providerFailureCommand),
    ).resolves.toMatchObject({ newSeedSet: { status: 'active' }, replayed: false });

    const insertionFailureActor = await createActor(app);
    await initializeDirect(originalService, insertionFailureActor);
    const duplicateSeedHex = generatedSeedHexes.at(-1);
    if (duplicateSeedHex === undefined) throw new Error('Expected a generated server seed.');
    const insertionFailureCommand = {
      idempotencyKey: 'insertion_failure_replacement',
      reason: 'key_compromise' as const,
      requestId: randomUUID(),
      userId: insertionFailureActor.userId,
    };
    await expect(
      createService({
        generateSeed: () => Uint8Array.from(Buffer.from(duplicateSeedHex, 'hex')),
        keyProvider: keyProvider(insertionRecoveryKeyVersion, '66'.repeat(32)),
      }).replaceCompromisedActiveSeed(insertionFailureCommand),
    ).rejects.toMatchObject({ constraint: 'rng_seed_sets_commitment_unique' });
    await expect(originalService.getCurrent(insertionFailureActor.userId)).rejects.toThrow(
      SeedSetUnavailableError,
    );
    await expect(
      createService({
        keyProvider: keyProvider(insertionRecoveryKeyVersion, '66'.repeat(32)),
      }).replaceCompromisedActiveSeed(insertionFailureCommand),
    ).resolves.toMatchObject({ newSeedSet: { status: 'active' }, replayed: false });
  });

  it('enforces compromise-remediation semantics for the restricted application role at commit', async () => {
    type CompromiseReason = 'key_compromise' | 'operational_compromise';
    const service = createService();
    const app = createIntegratedApp(service);
    const initializeActor = async (): Promise<{
      readonly actor: TestActor;
      readonly seedSetId: RngSeedSetId;
    }> => {
      const actor = await createActor(app);
      const initialized = await initializeDirect(service, actor);
      return { actor, seedSetId: initialized.fairness.activeSeedSet.id };
    };
    const insertPending = async (
      transaction: QueryExecutor,
      actor: TestActor,
      predecessorId: RngSeedSetId,
      reason: CompromiseReason,
      suffix: string,
    ): Promise<string> => {
      const rotationId = randomUUID();
      await transaction.query(
        `insert into app.rng_seed_rotations (
           id, user_id, idempotency_key, previous_seed_set_id, new_seed_set_id,
           operation_fingerprint, operation_type, transition_reason, completed_at
         ) values ($1, $2, $3, $4, null, decode($5, 'hex'),
                   'compromise_replacement', $6, null)`,
        [
          rotationId,
          actor.userId,
          `semantic_${suffix}`,
          predecessorId,
          rotationFingerprint('compromise_replacement', reason),
          reason,
        ],
      );
      return rotationId;
    };
    const markCompromised = async (
      transaction: QueryExecutor,
      seedSetId: RngSeedSetId,
      reason: CompromiseReason,
    ): Promise<void> => {
      await transaction.query(
        `update app.rng_seed_sets
            set status = 'compromised', compromise_reason = $2,
                compromised_at = clock_timestamp()
          where id = $1`,
        [seedSetId, reason],
      );
    };
    const insertSuccessor = async (
      transaction: QueryExecutor,
      predecessorId: RngSeedSetId,
      identity: string,
      version: string,
    ): Promise<RngSeedSetId> => {
      const successorId = randomUUID() as RngSeedSetId;
      await transaction.query(
        `insert into app.rng_seed_sets (
           id, user_id, commitment, server_seed_ciphertext, encryption_iv,
           encryption_auth_tag, encryption_key_identity, encryption_key_version,
           rng_algorithm_version, max_nonce_exclusive, rotate_after,
           rotated_from_seed_set_id
         )
         select $2::uuid, user_id, extensions.digest(convert_to($2::text, 'UTF8'), 'sha256'),
                server_seed_ciphertext,
                set_byte(encryption_iv, 0, (get_byte(encryption_iv, 0) + 17) % 256),
                encryption_auth_tag, decode($3, 'hex'), $4, rng_algorithm_version,
                max_nonce_exclusive, clock_timestamp() + interval '1 hour', id
           from app.rng_seed_sets where id = $1`,
        [predecessorId, successorId, identity, version],
      );
      return successorId;
    };
    const complete = async (
      transaction: QueryExecutor,
      rotationId: string,
      successorId: RngSeedSetId,
    ): Promise<void> => {
      await transaction.query(
        `update app.rng_seed_rotations
            set new_seed_set_id = $2, completed_at = clock_timestamp()
          where id = $1`,
        [rotationId, successorId],
      );
    };
    const readIdentity = async (seedSetId: RngSeedSetId): Promise<string> => {
      const result = await applicationDatabase.query<{ readonly identity: string }>(
        `select encode(encryption_key_identity, 'hex') as identity
           from app.rng_seed_sets where id = $1`,
        [seedSetId],
      );
      const identity = result.rows[0]?.identity;
      if (identity === undefined) throw new Error('Expected a persisted seed key identity.');
      return identity;
    };

    const activeCase = await initializeActor();
    await expect(
      applicationDatabase.transaction((transaction) =>
        insertPending(
          transaction,
          activeCase.actor,
          activeCase.seedSetId,
          'key_compromise',
          'active',
        ),
      ),
    ).rejects.toMatchObject({
      constraint: 'rng_seed_rotation_compromised_predecessor_invalid',
    });

    const retiredCase = await initializeActor();
    await applicationDatabase.query(
      `update app.rng_seed_sets
          set status = 'retired', retirement_reason = 'operational_request',
              retired_at = clock_timestamp()
        where id = $1`,
      [retiredCase.seedSetId],
    );
    await expect(
      applicationDatabase.transaction((transaction) =>
        insertPending(
          transaction,
          retiredCase.actor,
          retiredCase.seedSetId,
          'operational_compromise',
          'retired',
        ),
      ),
    ).rejects.toMatchObject({
      constraint: 'rng_seed_rotation_compromised_predecessor_invalid',
    });

    const mismatchCase = await initializeActor();
    await expect(
      applicationDatabase.transaction(async (transaction) => {
        await insertPending(
          transaction,
          mismatchCase.actor,
          mismatchCase.seedSetId,
          'key_compromise',
          'reason_mismatch',
        );
        await markCompromised(transaction, mismatchCase.seedSetId, 'operational_compromise');
      }),
    ).rejects.toMatchObject({
      constraint: 'rng_seed_rotation_compromised_predecessor_invalid',
    });

    const nonActiveCase = await initializeActor();
    const nonActiveRotationId = await applicationDatabase.transaction(async (transaction) => {
      const id = await insertPending(
        transaction,
        nonActiveCase.actor,
        nonActiveCase.seedSetId,
        'operational_compromise',
        'nonactive_successor',
      );
      await markCompromised(transaction, nonActiveCase.seedSetId, 'operational_compromise');
      return id;
    });
    await expect(
      applicationDatabase.transaction(async (transaction) => {
        const successorId = await insertSuccessor(
          transaction,
          nonActiveCase.seedSetId,
          keyIdentity('31'.repeat(32)),
          semanticNonActiveKeyVersion,
        );
        await markCompromised(transaction, successorId, 'operational_compromise');
        await complete(transaction, nonActiveRotationId, successorId);
      }),
    ).rejects.toMatchObject({ constraint: 'rng_seed_rotation_active_successor_invalid' });

    const sameIdentityCase = await initializeActor();
    const sameIdentity = await readIdentity(sameIdentityCase.seedSetId);
    const sameIdentityRotationId = await applicationDatabase.transaction(async (transaction) => {
      const id = await insertPending(
        transaction,
        sameIdentityCase.actor,
        sameIdentityCase.seedSetId,
        'key_compromise',
        'same_identity',
      );
      await markCompromised(transaction, sameIdentityCase.seedSetId, 'key_compromise');
      return id;
    });
    await expect(
      applicationDatabase.transaction(async (transaction) => {
        const successorId = await insertSuccessor(
          transaction,
          sameIdentityCase.seedSetId,
          sameIdentity,
          'synthetic-semantic-relabeled-v2',
        );
        await complete(transaction, sameIdentityRotationId, successorId);
      }),
    ).rejects.toMatchObject({ constraint: 'rng_seed_set_key_version_unregistered' });

    const validCase = await initializeActor();
    const validRotationId = await applicationDatabase.transaction(async (transaction) => {
      const id = await insertPending(
        transaction,
        validCase.actor,
        validCase.seedSetId,
        'key_compromise',
        'valid',
      );
      await markCompromised(transaction, validCase.seedSetId, 'key_compromise');
      return id;
    });
    const validSuccessorId = await applicationDatabase.transaction(async (transaction) => {
      const successorId = await insertSuccessor(
        transaction,
        validCase.seedSetId,
        keyIdentity('32'.repeat(32)),
        semanticValidKeyVersion,
      );
      await complete(transaction, validRotationId, successorId);
      return successorId;
    });
    expect(
      (
        await applicationDatabase.query<{ readonly status: string }>(
          `select status from app.rng_seed_sets where id = $1`,
          [validSuccessorId],
        )
      ).rows,
    ).toEqual([{ status: 'active' }]);
  });

  it('marks corrupted ciphertext or commitment compromised without fabricating a reveal', async () => {
    const service = createService();
    const app = createIntegratedApp(service);
    const actor = await createActor(app);
    const initialized = await initializeDirect(service, actor);
    const firstRotation = await service.rotate({
      idempotencyKey: 'corrupt_rotation_1',
      requestId: randomUUID(),
      userId: actor.userId,
    });
    await corruptWithTriggersDisabled(async (transaction) => {
      await transaction.query(
        `update app.rng_seed_sets
            set server_seed_ciphertext = set_byte(server_seed_ciphertext, 0, 255)
          where id = $1`,
        [initialized.fairness.activeSeedSet.id],
      );
    });
    await expect(
      service.revealRetiredSeedSet({
        actorUserId: actor.userId,
        requestId: randomUUID(),
        seedSetId: initialized.fairness.activeSeedSet.id,
      }),
    ).rejects.toThrow(SeedSetCompromisedError);
    const corruptedCiphertext = await applicationDatabase.query<{
      readonly revealed: Buffer | null;
      readonly status: string;
    }>(`select status, revealed_server_seed as revealed from app.rng_seed_sets where id = $1`, [
      initialized.fairness.activeSeedSet.id,
    ]);
    expect(corruptedCiphertext.rows).toEqual([{ revealed: null, status: 'compromised' }]);
    await expect(
      allocateSeedSetNonce(applicationDatabase, initialized.fairness.activeSeedSet.id),
    ).resolves.toBeUndefined();

    const secondRotation = await service.rotate({
      idempotencyKey: 'corrupt_rotation_2',
      requestId: randomUUID(),
      userId: actor.userId,
    });
    expect(secondRotation.previousSeedSetId).toBe(firstRotation.newSeedSet.id);
    await corruptWithTriggersDisabled(async (transaction) => {
      await transaction.query(
        `update app.rng_seed_sets
            set commitment = extensions.digest('synthetic mismatch', 'sha256')
          where id = $1`,
        [firstRotation.newSeedSet.id],
      );
    });
    await expect(
      service.revealRetiredSeedSet({
        actorUserId: actor.userId,
        requestId: randomUUID(),
        seedSetId: firstRotation.newSeedSet.id,
      }),
    ).rejects.toThrow(SeedSetCompromisedError);
    expect(await service.getPublicSeedSet(firstRotation.newSeedSet.id)).toMatchObject({
      revealedServerSeed: null,
      status: 'compromised',
    });
    const operationalReplacement = await service.replaceCompromisedActiveSeed({
      idempotencyKey: 'operational_compromise_rotation',
      reason: 'operational_compromise',
      requestId: randomUUID(),
      userId: actor.userId,
    });
    expect(operationalReplacement.newSeedSet).toMatchObject({ nextNonce: '0', status: 'active' });
    expect(await service.getPublicSeedSet(operationalReplacement.previousSeedSetId)).toMatchObject({
      status: 'compromised',
    });
    expect(
      auditRecords.some(
        (record) =>
          record.message === 'fairness.audit' &&
          record.attributes?.action === 'seed.marked_compromised',
      ),
    ).toBe(true);
    const logs = JSON.stringify(auditRecords);
    for (const secret of [...generatedSeedHexes, masterKeyHex]) expect(logs).not.toContain(secret);
  });

  it('enforces initialization, rotation boundaries, lifecycle constraints, and history retention', async () => {
    const service = createService({ maxOpenings: 2n });
    const app = createIntegratedApp(service);
    const actor = await createActor(app);
    const concurrentInitialization = await Promise.all(
      Array.from({ length: 8 }, () => initializeDirect(service, actor)),
    );
    expect(concurrentInitialization.filter(({ created }) => created)).toHaveLength(1);
    const counts = await applicationDatabase.query<{
      readonly profiles: string;
      readonly seeds: string;
    }>(
      `select (select count(*)::text from app.fairness_profiles where user_id = $1) as profiles,
              (select count(*)::text from app.rng_seed_sets where user_id = $1) as seeds`,
      [actor.userId],
    );
    expect(counts.rows).toEqual([{ profiles: '1', seeds: '1' }]);

    const competingActor = await createActor(app);
    const competingInitialization = await Promise.all([
      initializeDirect(service, competingActor, firstClientSeed),
      initializeDirect(service, competingActor, secondClientSeed),
    ]);
    expect(competingInitialization.filter(({ created }) => created)).toHaveLength(1);
    expect(
      competingInitialization.every(
        ({ fairness }) =>
          fairness.activeSeedSet.id === competingInitialization[0].fairness.activeSeedSet.id,
      ),
    ).toBe(true);
    expect([firstClientSeed, secondClientSeed]).toContain(
      (await service.getCurrent(competingActor.userId)).clientSeed,
    );
    const competingCounts = await applicationDatabase.query<{
      readonly profiles: string;
      readonly seeds: string;
    }>(
      `select (select count(*)::text from app.fairness_profiles where user_id = $1) as profiles,
              (select count(*)::text from app.rng_seed_sets where user_id = $1) as seeds`,
      [competingActor.userId],
    );
    expect(competingCounts.rows).toEqual([{ profiles: '1', seeds: '1' }]);

    await applicationDatabase.transaction((transaction) =>
      allocateNextNonce(transaction, { userId: actor.userId }),
    );
    await applicationDatabase.transaction((transaction) =>
      allocateNextNonce(transaction, { userId: actor.userId }),
    );
    await expect(
      applicationDatabase.transaction((transaction) =>
        allocateNextNonce(transaction, { userId: actor.userId }),
      ),
    ).rejects.toThrow(SeedRotationRequiredError);

    const agedActor = await createActor(app);
    const agedService = createService({ maxAgeMs: 60_000 });
    await initializeDirect(agedService, agedActor);
    const agedSeedSetId = (await agedService.getCurrent(agedActor.userId)).activeSeedSet.id;
    const uninitializedActor = await createActor(app);
    await corruptWithTriggersDisabled(async (transaction) => {
      await transaction.query(
        `update app.rng_seed_sets set rotate_after = created_at + interval '1 microsecond'
          where id = $1`,
        [agedSeedSetId],
      );
    });
    await expect(
      applicationDatabase.transaction((transaction) =>
        allocateNextNonce(transaction, { userId: agedActor.userId }),
      ),
    ).rejects.toThrow(SeedRotationRequiredError);

    const seedSetId = concurrentInitialization[0]?.fairness.activeSeedSet.id;
    if (seedSetId === undefined) throw new Error('Expected initialized seed set.');
    await applicationDatabase.query(
      `insert into app.fairness_profiles (user_id, current_client_seed)
       values ($1, $2)`,
      [uninitializedActor.userId, firstClientSeed],
    );
    await expect(
      applicationDatabase.query(
        `update app.rng_seed_sets set next_nonce = next_nonce + 2 where id = $1`,
        [seedSetId],
      ),
    ).rejects.toMatchObject({ constraint: 'rng_seed_set_nonce_increment_invalid' });
    await expect(
      applicationDatabase.query(
        `update app.rng_seed_sets
            set status = 'revealed', retired_at = statement_timestamp(),
                retirement_reason = 'invalid', revealed_at = statement_timestamp(),
                revealed_server_seed = decode($2, 'hex')
          where id = $1`,
        [seedSetId, generatedSeedHexes[0]],
      ),
    ).rejects.toMatchObject({ constraint: 'rng_seed_set_transition_invalid' });
    await expect(
      applicationDatabase.query(
        `insert into app.rng_seed_sets (
           id, user_id, commitment, server_seed_ciphertext, encryption_iv,
           encryption_auth_tag, encryption_key_identity, encryption_key_version,
           rng_algorithm_version,
           max_nonce_exclusive, rotate_after
         )
         select $2::uuid, user_id, extensions.digest($2::text, 'sha256'), server_seed_ciphertext,
                set_byte(encryption_iv, 0, (get_byte(encryption_iv, 0) + 1) % 256),
                encryption_auth_tag, encryption_key_identity, encryption_key_version,
                rng_algorithm_version, max_nonce_exclusive, rotate_after
           from app.rng_seed_sets where id = $1`,
        [seedSetId, randomUUID()],
      ),
    ).rejects.toMatchObject({ constraint: 'rng_seed_sets_one_active_per_user_index' });
    await expect(
      migrationDatabase.query(`delete from app.rng_seed_sets where id = $1`, [seedSetId]),
    ).rejects.toMatchObject({ constraint: 'rng_history_delete_prohibited' });
    await expect(
      applicationDatabase.query(
        `insert into app.rng_seed_sets (
           id, user_id, commitment, server_seed_ciphertext, encryption_iv,
           encryption_auth_tag, encryption_key_identity, encryption_key_version,
           rng_algorithm_version,
           max_nonce_exclusive, rotate_after, rotated_from_seed_set_id
         )
         select $2::uuid, $4::uuid, extensions.digest($2::text, 'sha256'),
                server_seed_ciphertext,
                set_byte(encryption_iv, 0, (get_byte(encryption_iv, 0) + 1) % 256),
                encryption_auth_tag, encryption_key_identity,
                encryption_key_version, rng_algorithm_version,
                max_nonce_exclusive, rotate_after, $3::uuid
           from app.rng_seed_sets where id = $1`,
        [seedSetId, randomUUID(), agedSeedSetId, uninitializedActor.userId],
      ),
    ).rejects.toMatchObject({ constraint: 'rng_seed_sets_rotated_from_user_foreign_key' });
    await expect(
      applicationDatabase.query(
        `insert into app.rng_seed_sets (
           id, user_id, commitment, server_seed_ciphertext, encryption_iv,
           encryption_auth_tag, encryption_key_identity, encryption_key_version,
           rng_algorithm_version,
           max_nonce_exclusive, rotate_after
         )
         select $2::uuid, $3::uuid, extensions.digest($2::text, 'sha256'),
                server_seed_ciphertext, encryption_iv, encryption_auth_tag,
                encryption_key_identity,
                encryption_key_version, rng_algorithm_version,
                max_nonce_exclusive, clock_timestamp() + interval '1 minute'
           from app.rng_seed_sets where id = $1`,
        [seedSetId, randomUUID(), uninitializedActor.userId],
      ),
    ).rejects.toMatchObject({ constraint: 'rng_seed_sets_key_iv_unique' });
    await expect(
      applicationDatabase.query(
        `update app.rng_seed_sets
            set status = 'compromised', compromise_reason = 'operational_compromise',
                compromised_at = created_at - interval '1 second'
          where id = $1`,
        [seedSetId],
      ),
    ).rejects.toMatchObject({ constraint: 'rng_seed_sets_lifecycle_time_order_check' });

    await expect(
      applicationDatabase.query(
        `insert into app.rng_seed_sets (
           id, user_id, commitment, server_seed_ciphertext, encryption_iv,
           encryption_auth_tag, encryption_key_identity, encryption_key_version,
           rng_algorithm_version,
           status, max_nonce_exclusive, rotate_after, retirement_reason, retired_at
         )
         select $2::uuid, user_id, extensions.digest($2::text, 'sha256'),
                server_seed_ciphertext, encryption_iv, encryption_auth_tag,
                encryption_key_identity, encryption_key_version, rng_algorithm_version, 'retired',
                max_nonce_exclusive, clock_timestamp() + interval '1 minute',
                'operational_request', clock_timestamp()
           from app.rng_seed_sets where id = $1`,
        [seedSetId, randomUUID()],
      ),
    ).rejects.toMatchObject({ constraint: 'rng_seed_set_initial_state_invalid' });

    const retired = await service.rotate({
      idempotencyKey: 'constraint_rotation',
      requestId: randomUUID(),
      userId: actor.userId,
    });
    await expect(
      applicationDatabase.query(
        `update app.rng_seed_sets
            set status = 'revealed', revealed_at = clock_timestamp(),
                revealed_server_seed = null
          where id = $1`,
        [retired.previousSeedSetId],
      ),
    ).rejects.toMatchObject({ constraint: 'rng_seed_set_reveal_commitment_mismatch' });
    await expect(
      applicationDatabase.query(
        `update app.rng_seed_sets
            set retired_at = retired_at + interval '1 second'
          where id = $1`,
        [retired.previousSeedSetId],
      ),
    ).rejects.toMatchObject({ constraint: 'rng_seed_set_cryptographic_history_immutable' });
  });

  it('uses stored policy and PostgreSQL time when a lock waiter crosses rotation expiry', async () => {
    const initialService = createService({ maxAgeMs: 60_000, maxOpenings: 7n });
    const app = createIntegratedApp(initialService);
    const actor = await createActor(app);
    const initialized = await initializeDirect(initialService, actor);
    const differentlyConfiguredService = createService({ maxAgeMs: 120_000, maxOpenings: 99n });
    expect((await differentlyConfiguredService.getCurrent(actor.userId)).rotationPolicy).toEqual({
      maxAgeMs: 60_000,
      maxOpenings: '7',
    });

    await corruptWithTriggersDisabled(async (transaction) => {
      await transaction.query(
        `update app.rng_seed_sets
            set rotate_after = clock_timestamp() + interval '2 seconds'
          where id = $1`,
        [initialized.fairness.activeSeedSet.id],
      );
    });
    const before = await applicationDatabase.query<{ readonly eligible: boolean }>(
      `select clock_timestamp() < rotate_after as eligible
         from app.rng_seed_sets where id = $1`,
      [initialized.fairness.activeSeedSet.id],
    );
    expect(before.rows).toEqual([{ eligible: true }]);

    let profileLocked: (() => void) | undefined;
    const locked = new Promise<void>((resolve) => {
      profileLocked = resolve;
    });
    const holder = applicationDatabase.transaction(async (transaction) => {
      expect(await lockFairnessProfile(transaction, actor.userId)).toBeDefined();
      profileLocked?.();
      await transaction.query(`select pg_sleep(2.25)`);
    });
    await locked;
    const waitingAllocation = applicationDatabase.transaction((transaction) =>
      allocateNextNonce(transaction, { userId: actor.userId }),
    );
    const rejectedAllocation = expect(waitingAllocation).rejects.toThrow(SeedRotationRequiredError);
    await holder;
    await rejectedAllocation;
    expect((await initialService.getCurrent(actor.userId)).activeSeedSet.nextNonce).toBe('0');
  });
});
