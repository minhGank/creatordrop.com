import { describe, expect, it } from 'vitest';

import {
  parseApiEnvironment,
  parseDatabaseEnvironment,
  parseMigrationEnvironment,
  parseWorkerEnvironment,
} from '../src/index.js';

describe('environment configuration', () => {
  it('applies safe local defaults', () => {
    expect(parseApiEnvironment({})).toEqual({
      host: '127.0.0.1',
      nodeEnvironment: 'development',
      port: 3000,
    });
    expect(parseWorkerEnvironment({})).toEqual({
      nodeEnvironment: 'development',
      pollIntervalMs: 1000,
    });
  });

  it('parses valid string values from process environments', () => {
    expect(parseApiEnvironment({ HOST: '0.0.0.0', NODE_ENV: 'test', PORT: '4100' })).toEqual({
      host: '0.0.0.0',
      nodeEnvironment: 'test',
      port: 4100,
    });
  });

  it.each([{ PORT: 'not-a-port' }, { PORT: '0' }, { PORT: '65536' }, { NODE_ENV: 'staging' }])(
    'rejects an invalid API environment: %o',
    (environment) => {
      expect(() => parseApiEnvironment(environment)).toThrow();
    },
  );

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
