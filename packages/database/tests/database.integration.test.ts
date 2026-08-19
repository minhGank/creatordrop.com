import { randomUUID } from 'node:crypto';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { parseDatabaseEnvironment, parseMigrationEnvironment } from '@creatordrop/config';

import { createDatabasePool, type Database } from '../src/index.js';

const localApplicationUrl =
  'postgresql://postgres:postgres@127.0.0.1:54322/postgres?options=-c%20role%3Dcreatordrop_app';
const localMigrationUrl = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const { DATABASE_MIGRATION_URL: migrationUrl, DATABASE_URL: applicationUrl } = process.env;

const applicationEnvironment = parseDatabaseEnvironment({
  DATABASE_APPLICATION_NAME: 'creatordrop-integration-test',
  DATABASE_CONNECTION_TIMEOUT_MS: '5000',
  DATABASE_IDLE_TIMEOUT_MS: '1000',
  DATABASE_POOL_MAX: '1',
  DATABASE_URL: applicationUrl ?? localApplicationUrl,
});
const migrationEnvironment = parseMigrationEnvironment({
  DATABASE_MIGRATION_URL: migrationUrl ?? localMigrationUrl,
});

const createTestPool = (connectionString: string): Database =>
  createDatabasePool({
    ...applicationEnvironment,
    applicationName: `${applicationEnvironment.applicationName}-${randomUUID()}`,
    connectionString,
    onUnexpectedPoolError: (error) => {
      throw error;
    },
  });

describe('PostgreSQL foundation', { concurrent: false }, () => {
  let applicationDatabase: Database;
  let migrationDatabase: Database;

  beforeAll(() => {
    migrationDatabase = createTestPool(migrationEnvironment.connectionString);
  });

  afterAll(async () => {
    await migrationDatabase.close();
  });

  beforeEach(async () => {
    applicationDatabase = createTestPool(applicationEnvironment.connectionString);
    await applicationDatabase.query(`
      create temporary table transaction_probe (
        id integer generated always as identity primary key,
        value text not null
      ) on commit preserve rows
    `);
  });

  afterEach(async () => {
    await applicationDatabase.close();
  });

  it('connects through the restricted application role', async () => {
    const result = await applicationDatabase.query<{ currentUser: string; probe: number }>(`
      select current_user as "currentUser", 1::integer as probe
    `);

    expect(result.rows).toEqual([{ currentUser: 'creatordrop_app', probe: 1 }]);
  });

  it('records the foundational migration after initialization from empty', async () => {
    const migrationResult = await migrationDatabase.query<{ version: string }>(`
      select version
      from supabase_migrations.schema_migrations
      where version = '20260819000000'
    `);
    const foundationResult = await migrationDatabase.query<{
      applicationSchemaExists: boolean;
      applicationUsageGranted: boolean;
      citextInstalled: boolean;
      domainTableCount: string;
      privateSchemaExists: boolean;
    }>(`
      select
        to_regnamespace('app') is not null as "applicationSchemaExists",
        to_regnamespace('app_private') is not null as "privateSchemaExists",
        has_schema_privilege('creatordrop_app', 'app', 'USAGE') as "applicationUsageGranted",
        exists (
          select 1 from pg_extension where extname = 'citext'
        ) as "citextInstalled",
        (
          select count(*)::text
          from information_schema.tables
          where table_schema in ('app', 'app_private')
        ) as "domainTableCount"
    `);

    expect(migrationResult.rows).toEqual([{ version: '20260819000000' }]);
    expect(foundationResult.rows).toEqual([
      {
        applicationSchemaExists: true,
        applicationUsageGranted: true,
        citextInstalled: true,
        domainTableCount: '0',
        privateSchemaExists: true,
      },
    ]);
  });

  it('commits a successful transaction', async () => {
    const returnedValue = await applicationDatabase.transaction(async (transaction) => {
      await transaction.query('insert into transaction_probe (value) values ($1)', ['committed']);
      return 'transaction-result';
    });
    const result = await applicationDatabase.query<{ value: string }>(
      'select value from transaction_probe order by id',
    );

    expect(returnedValue).toBe('transaction-result');
    expect(result.rows).toEqual([{ value: 'committed' }]);
  });

  it('rolls back when the callback fails', async () => {
    const transactionError = new Error('synthetic transaction failure');

    await expect(
      applicationDatabase.transaction(async (transaction) => {
        await transaction.query('insert into transaction_probe (value) values ($1)', [
          'rolled-back',
        ]);
        throw transactionError;
      }),
    ).rejects.toBe(transactionError);

    const result = await applicationDatabase.query<{ rowCount: string }>(`
      select count(*)::text as "rowCount" from transaction_probe
    `);
    expect(result.rows).toEqual([{ rowCount: '0' }]);
  });

  it('isolates test state by PostgreSQL session', async () => {
    const firstDatabase = createTestPool(applicationEnvironment.connectionString);
    const secondDatabase = createTestPool(applicationEnvironment.connectionString);

    try {
      await firstDatabase.query('create temporary table isolation_probe (value text not null)');
      await secondDatabase.query('create temporary table isolation_probe (value text not null)');
      await firstDatabase.query('insert into isolation_probe (value) values ($1)', ['first']);
      await secondDatabase.query('insert into isolation_probe (value) values ($1)', ['second']);

      const [firstResult, secondResult] = await Promise.all([
        firstDatabase.query<{ value: string }>('select value from isolation_probe'),
        secondDatabase.query<{ value: string }>('select value from isolation_probe'),
      ]);

      expect(firstResult.rows).toEqual([{ value: 'first' }]);
      expect(secondResult.rows).toEqual([{ value: 'second' }]);
    } finally {
      await Promise.all([firstDatabase.close(), secondDatabase.close()]);
    }
  });
});
