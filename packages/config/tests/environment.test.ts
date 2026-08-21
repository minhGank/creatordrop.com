import { describe, expect, it } from 'vitest';

import {
  parseApiEnvironment,
  parseDatabaseEnvironment,
  parseMigrationEnvironment,
  parseWorkerEnvironment,
} from '../src/index.js';

describe('environment configuration', () => {
  const requiredApiEnvironment = {
    AUTH_JWT_ISSUER: 'http://127.0.0.1:54321/auth/v1',
    AUTH_JWKS_URL: 'http://127.0.0.1:54321/auth/v1/.well-known/jwks.json',
    CORS_ALLOWED_ORIGINS: 'http://127.0.0.1:5173,http://localhost:5173',
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
      host: '127.0.0.1',
      nodeEnvironment: 'development',
      port: 3000,
      requestBodyLimitBytes: 32_768,
    });
    expect(parseWorkerEnvironment({})).toEqual({
      nodeEnvironment: 'development',
      pollIntervalMs: 1000,
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
        HOST: '0.0.0.0',
        NODE_ENV: 'test',
        PORT: '4100',
        REQUEST_BODY_LIMIT_BYTES: '4096',
      }),
    ).toEqual({
      authAudience: 'creator-fans',
      authIssuer: 'http://127.0.0.1:54321/auth/v1',
      authJwksUrl: 'http://127.0.0.1:54321/auth/v1/.well-known/jwks.json',
      authProvider: 'synthetic-provider',
      authRateLimitMax: 7,
      authRateLimitWindowMs: 5000,
      corsAllowedOrigins: ['http://127.0.0.1:5173', 'http://localhost:5173'],
      host: '0.0.0.0',
      nodeEnvironment: 'test',
      port: 4100,
      requestBodyLimitBytes: 4096,
    });
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

  it.each([{ WORKER_POLL_INTERVAL_MS: '99' }, { WORKER_POLL_INTERVAL_MS: '60001' }])(
    'rejects an invalid worker environment: %o',
    (environment) => {
      expect(() => parseWorkerEnvironment(environment)).toThrow();
    },
  );
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
