import { describe, expect, it, vi } from 'vitest';

import {
  getApiEnvironment,
  getDatabaseEnvironment,
  getFulfillmentEnvironment,
  getRngEnvironment,
  validateCryptographicKeySeparation,
} from '../src/config/environment.js';

describe('API environment adapter', () => {
  it('reads and validates process.env at the configuration boundary', () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('AUTH_JWT_ISSUER', 'http://127.0.0.1:54321/auth/v1');
    vi.stubEnv('AUTH_JWKS_URL', 'http://127.0.0.1:54321/auth/v1/.well-known/jwks.json');
    vi.stubEnv('CORS_ALLOWED_ORIGINS', 'http://localhost:5173');
    vi.stubEnv('HOST', '127.0.0.1');
    vi.stubEnv('PORT', '4321');
    vi.stubEnv('REALTIME_WORKER_TOKEN', 'synthetic-realtime-worker-token-00000001');

    expect(getApiEnvironment()).toEqual({
      authAudience: 'authenticated',
      authIssuer: 'http://127.0.0.1:54321/auth/v1',
      authJwksUrl: 'http://127.0.0.1:54321/auth/v1/.well-known/jwks.json',
      authProvider: 'supabase',
      authRateLimitMax: 20,
      authRateLimitWindowMs: 60_000,
      corsAllowedOrigins: ['http://localhost:5173'],
      creatorMutationRateLimitMax: 60,
      creatorMutationRateLimitWindowMs: 60_000,
      host: '127.0.0.1',
      nodeEnvironment: 'test',
      port: 4321,
      realtimeWorkerToken: 'synthetic-realtime-worker-token-00000001',
      requestBodyLimitBytes: 32_768,
      stripeFundingEnabled: false,
      stripeSecretKey: null,
      stripeWebhookBodyLimitBytes: 262_144,
      stripeWebhookSecret: null,
      testCreditsEnabled: false,
      walletMutationRateLimitMax: 20,
      walletMutationRateLimitWindowMs: 60_000,
    });

    vi.unstubAllEnvs();
  });

  it('reads database configuration through the same process boundary', () => {
    const connectionString = [
      'postgresql:',
      '//synthetic:',
      'local-only',
      '@database.example.test:5432/creatordrop',
    ].join('');
    vi.stubEnv('DATABASE_URL', connectionString);

    expect(getDatabaseEnvironment()).toMatchObject({
      applicationName: 'creatordrop',
      maxConnections: 10,
    });

    vi.unstubAllEnvs();
  });

  it('requires and validates RNG key material through the process boundary', () => {
    vi.stubEnv('RNG_MASTER_KEY', '01'.repeat(32));
    vi.stubEnv('RNG_MASTER_KEY_VERSION', 'synthetic-test-v1');
    vi.stubEnv('RNG_MAX_OPENINGS_PER_SEED', '1000');

    expect(getRngEnvironment()).toMatchObject({
      historicalMasterKeys: {},
      masterKeyHex: '01'.repeat(32),
      masterKeyVersion: 'synthetic-test-v1',
      maxOpeningsPerSeed: 1000n,
    });

    vi.unstubAllEnvs();
  });

  it('requires separate fulfillment encryption domains through the process boundary', () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('FULFILLMENT_ADDRESS_MASTER_KEY', '41'.repeat(32));
    vi.stubEnv('FULFILLMENT_ADDRESS_MASTER_KEY_VERSION', 'address-test-v1');
    vi.stubEnv('FULFILLMENT_ACTOR_BINDING_KEY', '45'.repeat(32));
    vi.stubEnv('FULFILLMENT_ACTOR_BINDING_KEY_VERSION', 'actor-test-v1');
    vi.stubEnv('DIGITAL_DELIVERY_MASTER_KEY', '42'.repeat(32));
    vi.stubEnv('DIGITAL_DELIVERY_MASTER_KEY_VERSION', 'digital-test-v1');
    expect(getFulfillmentEnvironment()).toMatchObject({
      actorBinding: { version: 'actor-test-v1' },
      address: { masterKeyVersion: 'address-test-v1' },
      digitalSecret: { masterKeyVersion: 'digital-test-v1' },
      retentionMs: null,
    });
    vi.unstubAllEnvs();
  });

  it('checks RNG and fulfillment key domains together at startup', () => {
    const rng = {
      fairnessMutationRateLimitMax: 20,
      fairnessMutationRateLimitWindowMs: 60_000,
      historicalMasterKeys: {},
      masterKeyHex: '41'.repeat(32),
      masterKeyVersion: 'rng-test-v1',
      maxOpeningsPerSeed: 1000n,
      maxSeedAgeMs: 86_400_000,
    };
    const fulfillment = {
      actorBinding: { keyHex: '45'.repeat(32), version: 'actor-test-v1' },
      address: {
        historicalMasterKeys: {},
        masterKeyHex: '41'.repeat(32),
        masterKeyVersion: 'address-test-v1',
      },
      digitalSecret: {
        historicalMasterKeys: {},
        masterKeyHex: '42'.repeat(32),
        masterKeyVersion: 'digital-test-v1',
      },
      retentionMs: null,
    };
    expect(() => validateCryptographicKeySeparation(rng, fulfillment)).toThrow();
  });
});
