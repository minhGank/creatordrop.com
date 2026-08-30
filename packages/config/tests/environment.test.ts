import { describe, expect, it } from 'vitest';

import {
  parseApiEnvironment,
  parseDatabaseEnvironment,
  parseMigrationEnvironment,
  parseRngEnvironment,
  parseWorkerEnvironment,
} from '../src/index.js';

describe('environment configuration', () => {
  const syntheticWorkerDatabaseUrl = [
    'postgresql:',
    '//synthetic:',
    'local-only',
    '@database.example.test/creatordrop',
  ].join('');
  const requiredApiEnvironment = {
    AUTH_JWT_ISSUER: 'http://127.0.0.1:54321/auth/v1',
    AUTH_JWKS_URL: 'http://127.0.0.1:54321/auth/v1/.well-known/jwks.json',
    CORS_ALLOWED_ORIGINS: 'http://127.0.0.1:5173,http://localhost:5173',
    REALTIME_WORKER_TOKEN: 'synthetic-realtime-worker-token-00000001',
  } as const;
  const requiredWorkerEnvironment = {
    NODE_ENV: 'test',
    REALTIME_URL: 'http://127.0.0.1:3000',
    REALTIME_WORKER_TOKEN: 'synthetic-realtime-worker-token-00000001',
    WORKER_DATABASE_URL: syntheticWorkerDatabaseUrl,
  } as const;

  it('applies safe defaults without defaulting trusted endpoints or origins', () => {
    expect(parseApiEnvironment(requiredApiEnvironment)).toEqual({
      authAudience: 'authenticated',
      authIssuer: 'http://127.0.0.1:54321/auth/v1',
      authJwksUrl: 'http://127.0.0.1:54321/auth/v1/.well-known/jwks.json',
      authProvider: 'supabase',
      authRateLimitMax: 20,
      authRateLimitWindowMs: 60_000,
      corsAllowedOrigins: ['http://127.0.0.1:5173', 'http://localhost:5173'],
      creatorMutationRateLimitMax: 60,
      creatorMutationRateLimitWindowMs: 60_000,
      host: '127.0.0.1',
      nodeEnvironment: 'development',
      port: 3000,
      realtimeWorkerToken: 'synthetic-realtime-worker-token-00000001',
      requestBodyLimitBytes: 32_768,
      testCreditsEnabled: false,
      walletMutationRateLimitMax: 20,
      walletMutationRateLimitWindowMs: 60_000,
    });
    expect(parseWorkerEnvironment(requiredWorkerEnvironment)).toEqual({
      batchSize: 25,
      database: {
        applicationName: 'creatordrop-worker',
        connectionString: syntheticWorkerDatabaseUrl,
        connectionTimeoutMs: 5000,
        idleTimeoutMs: 10_000,
        maxConnections: 10,
      },
      leaseMs: 30_000,
      maxAttempts: 8,
      nodeEnvironment: 'test',
      pollIntervalMs: 1000,
      publishTimeoutMs: 5000,
      realtimeUrl: 'http://127.0.0.1:3000',
      realtimeWorkerToken: 'synthetic-realtime-worker-token-00000001',
      retryBaseMs: 1000,
      retryMaxMs: 60_000,
    });
  });

  it('parses valid string values from process environments', () => {
    expect(
      parseApiEnvironment({
        ...requiredApiEnvironment,
        AUTH_JWT_AUDIENCE: 'creator-fans',
        AUTH_PROVIDER: 'synthetic-provider',
        AUTH_RATE_LIMIT_MAX: '7',
        AUTH_RATE_LIMIT_WINDOW_MS: '5000',
        CREATOR_MUTATION_RATE_LIMIT_MAX: '9',
        CREATOR_MUTATION_RATE_LIMIT_WINDOW_MS: '7000',
        HOST: '0.0.0.0',
        NODE_ENV: 'test',
        PORT: '4100',
        REQUEST_BODY_LIMIT_BYTES: '4096',
        WALLET_MUTATION_RATE_LIMIT_MAX: '11',
        WALLET_MUTATION_RATE_LIMIT_WINDOW_MS: '9000',
        WALLET_TEST_CREDITS_ENABLED: 'true',
      }),
    ).toEqual({
      authAudience: 'creator-fans',
      authIssuer: 'http://127.0.0.1:54321/auth/v1',
      authJwksUrl: 'http://127.0.0.1:54321/auth/v1/.well-known/jwks.json',
      authProvider: 'synthetic-provider',
      authRateLimitMax: 7,
      authRateLimitWindowMs: 5000,
      corsAllowedOrigins: ['http://127.0.0.1:5173', 'http://localhost:5173'],
      creatorMutationRateLimitMax: 9,
      creatorMutationRateLimitWindowMs: 7000,
      host: '0.0.0.0',
      nodeEnvironment: 'test',
      port: 4100,
      realtimeWorkerToken: 'synthetic-realtime-worker-token-00000001',
      requestBodyLimitBytes: 4096,
      testCreditsEnabled: true,
      walletMutationRateLimitMax: 11,
      walletMutationRateLimitWindowMs: 9000,
    });
  });

  it.each(['development', 'test'] as const)(
    'enables test credits only with an explicit %s runtime',
    (nodeEnvironment) => {
      expect(
        parseApiEnvironment({
          ...requiredApiEnvironment,
          NODE_ENV: nodeEnvironment,
          WALLET_TEST_CREDITS_ENABLED: 'true',
        }).testCreditsEnabled,
      ).toBe(true);
    },
  );

  it.each(['development', 'test'] as const)(
    'accepts the documented local realtime worker token only with explicit %s',
    (nodeEnvironment) => {
      const localToken = 'local-development-realtime-worker-token-00000001';
      expect(
        parseApiEnvironment({
          ...requiredApiEnvironment,
          NODE_ENV: nodeEnvironment,
          REALTIME_WORKER_TOKEN: localToken,
        }).realtimeWorkerToken,
      ).toBe(localToken);
      expect(
        parseWorkerEnvironment({
          ...requiredWorkerEnvironment,
          NODE_ENV: nodeEnvironment,
          REALTIME_WORKER_TOKEN: localToken,
        }).realtimeWorkerToken,
      ).toBe(localToken);
    },
  );

  it.each([undefined, 'production'] as const)(
    'rejects the local realtime worker token for an unsafe %s runtime',
    (nodeEnvironment) => {
      const environment = {
        REALTIME_WORKER_TOKEN: 'local-development-realtime-worker-token-00000001',
        ...(nodeEnvironment === undefined ? {} : { NODE_ENV: nodeEnvironment }),
      };
      expect(() => parseApiEnvironment({ ...requiredApiEnvironment, ...environment })).toThrow();
      expect(() =>
        parseWorkerEnvironment({
          REALTIME_URL: requiredWorkerEnvironment.REALTIME_URL,
          WORKER_DATABASE_URL: requiredWorkerEnvironment.WORKER_DATABASE_URL,
          ...environment,
        }),
      ).toThrow();
    },
  );

  it.each([
    { environment: {}, label: 'omitted' },
    { environment: { NODE_ENV: '' }, label: 'empty' },
    { environment: { NODE_ENV: 'production' }, label: 'production' },
    { environment: { NODE_ENV: 'staging' }, label: 'unsupported' },
  ])('rejects test credits when NODE_ENV is $label', ({ environment }) => {
    expect(() =>
      parseApiEnvironment({
        ...requiredApiEnvironment,
        ...environment,
        WALLET_TEST_CREDITS_ENABLED: 'true',
      }),
    ).toThrow();
  });

  it.each([
    {},
    { ...requiredApiEnvironment, AUTH_JWT_ISSUER: 'not-a-url' },
    { ...requiredApiEnvironment, AUTH_JWKS_URL: 'ftp://auth.example.test/jwks' },
    { ...requiredApiEnvironment, CORS_ALLOWED_ORIGINS: '*' },
    { ...requiredApiEnvironment, CORS_ALLOWED_ORIGINS: 'https://web.example.test/path' },
    { ...requiredApiEnvironment, PORT: 'not-a-port' },
    { ...requiredApiEnvironment, PORT: '0' },
    { ...requiredApiEnvironment, PORT: '65536' },
    { ...requiredApiEnvironment, NODE_ENV: 'staging' },
  ])('rejects an invalid API environment: %o', (environment) => {
    expect(() => parseApiEnvironment(environment)).toThrow();
  });

  it.each([
    { WORKER_POLL_INTERVAL_MS: '99' },
    { WORKER_POLL_INTERVAL_MS: '60001' },
    { OUTBOX_LEASE_MS: '5000', REALTIME_PUBLISH_TIMEOUT_MS: '5000' },
    { OUTBOX_RETRY_BASE_MS: '2000', OUTBOX_RETRY_MAX_MS: '1000' },
  ])('rejects an invalid worker environment: %o', (environment) => {
    expect(() =>
      parseWorkerEnvironment({ ...requiredWorkerEnvironment, ...environment }),
    ).toThrow();
  });
});

describe('RNG lifecycle environment configuration', () => {
  const valid = {
    RNG_MASTER_KEY: '01'.repeat(32),
    RNG_MASTER_KEY_VERSION: 'synthetic-test-v1',
    RNG_MAX_OPENINGS_PER_SEED: '1000',
  } as const;

  it('parses a versioned 32-byte key and bounded rotation policy', () => {
    expect(parseRngEnvironment(valid)).toEqual({
      fairnessMutationRateLimitMax: 20,
      fairnessMutationRateLimitWindowMs: 60_000,
      historicalMasterKeys: {},
      masterKeyHex: valid.RNG_MASTER_KEY,
      masterKeyVersion: 'synthetic-test-v1',
      maxOpeningsPerSeed: 1000n,
      maxSeedAgeMs: 86_400_000,
    });
    expect(
      parseRngEnvironment({
        ...valid,
        RNG_FAIRNESS_MUTATION_RATE_LIMIT_MAX: '7',
        RNG_FAIRNESS_MUTATION_RATE_LIMIT_WINDOW_MS: '5000',
        RNG_MAX_OPENINGS_PER_SEED: '9223372036854775807',
        RNG_MAX_SEED_AGE_MS: '60000',
      }),
    ).toMatchObject({
      fairnessMutationRateLimitMax: 7,
      fairnessMutationRateLimitWindowMs: 5000,
      maxOpeningsPerSeed: 9_223_372_036_854_775_807n,
      maxSeedAgeMs: 60_000,
    });
  });

  it.each([
    {},
    { ...valid, RNG_MASTER_KEY: '01'.repeat(31) },
    { ...valid, RNG_MASTER_KEY: 'AB'.repeat(32) },
    { ...valid, RNG_MASTER_KEY_VERSION: '' },
    { ...valid, RNG_MASTER_KEY_VERSION: '__proto__' },
    { ...valid, RNG_MAX_OPENINGS_PER_SEED: '0' },
    { ...valid, RNG_MAX_OPENINGS_PER_SEED: '01' },
    { ...valid, RNG_MAX_OPENINGS_PER_SEED: '9223372036854775808' },
    { ...valid, RNG_MAX_SEED_AGE_MS: '59999' },
  ])('rejects unsafe RNG lifecycle configuration: %o', (environment) => {
    expect(() => parseRngEnvironment(environment)).toThrow();
  });

  it('parses retained decrypt-only keys and rejects active-version duplication', () => {
    expect(
      parseRngEnvironment({
        ...valid,
        RNG_HISTORICAL_MASTER_KEYS: JSON.stringify([
          { key: '02'.repeat(32), version: 'synthetic-test-v0' },
        ]),
      }).historicalMasterKeys,
    ).toEqual({ 'synthetic-test-v0': '02'.repeat(32) });
    expect(() =>
      parseRngEnvironment({
        ...valid,
        RNG_HISTORICAL_MASTER_KEYS: JSON.stringify([
          { key: '02'.repeat(32), version: valid.RNG_MASTER_KEY_VERSION },
        ]),
      }),
    ).toThrow();
    expect(() =>
      parseRngEnvironment({
        ...valid,
        RNG_HISTORICAL_MASTER_KEYS: JSON.stringify([
          { key: valid.RNG_MASTER_KEY, version: 'synthetic-test-v0' },
        ]),
      }),
    ).toThrow();
  });

  it('rejects duplicate, escaped-equivalent, reserved, and malformed historical entries', () => {
    const duplicateKey = '02'.repeat(32);
    for (const historicalKeys of [
      JSON.stringify([
        { key: duplicateKey, version: 'production-v1' },
        { key: '03'.repeat(32), version: 'production-v1' },
      ]),
      `[{"key":"${duplicateKey}","version":"production-v1"},{"key":"${'03'.repeat(
        32,
      )}","version":"production-\\u00761"}]`,
      JSON.stringify([{ key: duplicateKey, version: '__proto__' }]),
      JSON.stringify([{ key: duplicateKey, unexpected: true, version: 'production-v1' }]),
      JSON.stringify([{ key: 'not-hex', version: 'production-v1' }]),
      JSON.stringify({ 'production-v1': duplicateKey }),
    ]) {
      expect(() =>
        parseRngEnvironment({ ...valid, RNG_HISTORICAL_MASTER_KEYS: historicalKeys }),
      ).toThrow();
    }
  });

  it('allows local fixtures only with an explicit development or test runtime', () => {
    const localExample = {
      RNG_MASTER_KEY: '00'.repeat(32),
      RNG_MASTER_KEY_VERSION: 'local-dev-v1',
    } as const;
    expect(() => parseRngEnvironment(localExample)).toThrow();
    expect(() => parseRngEnvironment({ ...localExample, NODE_ENV: 'production' })).toThrow();
    for (const nodeEnvironment of ['development', 'test'] as const) {
      expect(parseRngEnvironment({ ...localExample, NODE_ENV: nodeEnvironment }).masterKeyHex).toBe(
        localExample.RNG_MASTER_KEY,
      );
    }

    expect(() =>
      parseRngEnvironment({
        ...valid,
        RNG_MASTER_KEY: localExample.RNG_MASTER_KEY,
      }),
    ).toThrow();
    expect(() =>
      parseRngEnvironment({
        ...valid,
        RNG_MASTER_KEY_VERSION: localExample.RNG_MASTER_KEY_VERSION,
      }),
    ).toThrow();
    expect(() =>
      parseRngEnvironment({
        ...valid,
        NODE_ENV: 'production',
        RNG_HISTORICAL_MASTER_KEYS: JSON.stringify([
          { key: '02'.repeat(32), version: 'local-dev-v0' },
        ]),
      }),
    ).toThrow();
  });
});

describe('database environment configuration', () => {
  const createSyntheticPostgresUrl = (username: string, suffix = ''): string =>
    [
      'postgresql:',
      '//',
      username,
      ':',
      'synthetic',
      '@database.example.test:5432/creatordrop',
      suffix,
    ].join('');

  it('parses connection and pool settings without changing the connection string', () => {
    const connectionString = createSyntheticPostgresUrl('app', '?sslmode=require');

    expect(
      parseDatabaseEnvironment({
        DATABASE_APPLICATION_NAME: 'creatordrop-api',
        DATABASE_CONNECTION_TIMEOUT_MS: '2500',
        DATABASE_IDLE_TIMEOUT_MS: '15000',
        DATABASE_POOL_MAX: '12',
        DATABASE_URL: connectionString,
      }),
    ).toEqual({
      applicationName: 'creatordrop-api',
      connectionString,
      connectionTimeoutMs: 2500,
      idleTimeoutMs: 15000,
      maxConnections: 12,
    });
  });

  it('requires PostgreSQL protocols and bounded pool values', () => {
    expect(() =>
      parseDatabaseEnvironment({ DATABASE_URL: 'https://example.test/database' }),
    ).toThrow();
    expect(() =>
      parseDatabaseEnvironment({
        DATABASE_POOL_MAX: '0',
        DATABASE_URL: createSyntheticPostgresUrl('app'),
      }),
    ).toThrow();
  });

  it('validates migration credentials separately from application credentials', () => {
    const connectionString = createSyntheticPostgresUrl('migrator');

    expect(parseMigrationEnvironment({ DATABASE_MIGRATION_URL: connectionString })).toEqual({
      connectionString,
    });
    expect(() => parseMigrationEnvironment({})).toThrow();
  });
});
