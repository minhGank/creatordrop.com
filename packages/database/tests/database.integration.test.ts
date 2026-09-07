import { randomUUID } from 'node:crypto';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { parseDatabaseEnvironment, parseMigrationEnvironment } from '@creatordrop/config';

import {
  assertTransactionExecutor,
  createDatabasePool,
  type Database,
  type TransactionExecutor,
} from '../src/index.js';

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

  it('allows local-user access without exposing Supabase Auth tables', async () => {
    const applicationPrivileges = await applicationDatabase.query<{
      readonly canManageCreatorMemberships: boolean;
      readonly canManageCreators: boolean;
      readonly canManageCatalog: boolean;
      readonly canSelectUsers: boolean;
      readonly privateSchemaVisible: boolean;
    }>(`
      select
        has_table_privilege(current_user, 'app.users', 'SELECT') as "canSelectUsers",
        has_table_privilege(
          current_user,
          'app.creators',
          'SELECT, INSERT, UPDATE, DELETE'
        ) as "canManageCreators",
        has_table_privilege(
          current_user,
          'app.creator_memberships',
          'SELECT, INSERT, UPDATE, DELETE'
        ) as "canManageCreatorMemberships",
        has_table_privilege(
          current_user,
          'app.box_versions',
          'SELECT, INSERT, UPDATE, DELETE'
        ) as "canManageCatalog",
        has_schema_privilege(current_user, 'app_private', 'USAGE') as "privateSchemaVisible"
    `);

    expect(applicationPrivileges.rows).toEqual([
      {
        canManageCreatorMemberships: true,
        canManageCreators: true,
        canManageCatalog: true,
        canSelectUsers: true,
        privateSchemaVisible: false,
      },
    ]);
    await expect(applicationDatabase.query('select id from auth.users limit 1')).rejects.toThrow(
      /permission denied/iu,
    );
  });

  it('records all migrations after initialization from empty', async () => {
    const migrationResult = await migrationDatabase.query<{ version: string }>(`
      select version
      from supabase_migrations.schema_migrations
      where version in (
        '20260819000000',
        '20260820000000',
        '20260820180000',
        '20260821132759',
        '20260822150000',
        '20260823093143',
        '20260823192330',
        '20260823220000',
        '20260823230000',
        '20260824154215',
        '20260824180000',
        '20260826134113',
        '20260830024628',
        '20260830120000',
        '20260831120000',
        '20260831170000',
        '20260901090000',
        '20260901130000',
        '20260901180000',
        '20260902120000',
        '20260905065856',
        '20260906194037',
        '20260907185800'
      )
      order by version
    `);
    const foundationResult = await migrationDatabase.query<{
      applicationSchemaExists: boolean;
      applicationUsageGranted: boolean;
      boxTableExists: boolean;
      boxVersionRewardTableExists: boolean;
      boxVersionTableExists: boolean;
      citextInstalled: boolean;
      creatorMembershipTableExists: boolean;
      creatorTableExists: boolean;
      rewardTableExists: boolean;
      rewardVersionTableExists: boolean;
      userTableExists: boolean;
      privateSchemaExists: boolean;
    }>(`
      select
        to_regnamespace('app') is not null as "applicationSchemaExists",
        to_regnamespace('app_private') is not null as "privateSchemaExists",
        has_schema_privilege('creatordrop_app', 'app', 'USAGE') as "applicationUsageGranted",
        exists (
          select 1 from pg_extension where extname = 'citext'
        ) as "citextInstalled",
        to_regclass('app.users') is not null as "userTableExists",
        to_regclass('app.creators') is not null as "creatorTableExists",
        to_regclass('app.creator_memberships') is not null as "creatorMembershipTableExists",
        to_regclass('app.boxes') is not null as "boxTableExists",
        to_regclass('app.box_versions') is not null as "boxVersionTableExists",
        to_regclass('app.rewards') is not null as "rewardTableExists",
        to_regclass('app.reward_versions') is not null as "rewardVersionTableExists",
        to_regclass('app.box_version_rewards') is not null as "boxVersionRewardTableExists"
    `);

    expect(migrationResult.rows).toEqual([
      { version: '20260819000000' },
      { version: '20260820000000' },
      { version: '20260820180000' },
      { version: '20260821132759' },
      { version: '20260822150000' },
      { version: '20260823093143' },
      { version: '20260823192330' },
      { version: '20260823220000' },
      { version: '20260823230000' },
      { version: '20260824154215' },
      { version: '20260824180000' },
      { version: '20260826134113' },
      { version: '20260830024628' },
      { version: '20260830120000' },
      { version: '20260831120000' },
      { version: '20260831170000' },
      { version: '20260901090000' },
      { version: '20260901130000' },
      { version: '20260901180000' },
      { version: '20260902120000' },
      { version: '20260905065856' },
      { version: '20260906194037' },
      { version: '20260907185800' },
    ]);
    expect(foundationResult.rows).toEqual([
      {
        applicationSchemaExists: true,
        applicationUsageGranted: true,
        boxTableExists: true,
        boxVersionRewardTableExists: true,
        boxVersionTableExists: true,
        citextInstalled: true,
        creatorMembershipTableExists: true,
        creatorTableExists: true,
        privateSchemaExists: true,
        rewardTableExists: true,
        rewardVersionTableExists: true,
        userTableExists: true,
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

  it('brands only active caller-owned transaction executors at runtime', async () => {
    expect(() => assertTransactionExecutor(applicationDatabase)).toThrow(
      'An active transaction executor is required.',
    );
    const escaped: { transaction?: TransactionExecutor } = {};
    await applicationDatabase.transaction((transaction) => {
      escaped.transaction = transaction;
      expect(() => assertTransactionExecutor(transaction)).not.toThrow();
      return Promise.resolve();
    });
    expect(escaped.transaction).toBeDefined();
    const escapedTransaction = escaped.transaction;
    if (escapedTransaction === undefined) throw new Error('Expected an escaped transaction.');
    expect(() => assertTransactionExecutor(escapedTransaction)).toThrow(
      'An active transaction executor is required.',
    );
    await expect(escapedTransaction.query('select 1')).rejects.toThrow(
      'An active transaction executor is required.',
    );
  });

  it('rejects transaction-control and multi-statement SQL inside callbacks', async () => {
    await applicationDatabase.transaction(async (transaction) => {
      for (const statement of [
        'BEGIN',
        'COMMIT',
        'ROLLBACK',
        'SAVEPOINT synthetic',
        'ROLLBACK TO SAVEPOINT synthetic',
        'RELEASE SAVEPOINT synthetic',
        'START /* nested /* comment */ still comment */ TRANSACTION',
        '-- line feed\nCOMMIT',
        '-- carriage return\rROLLBACK',
        '-- carriage return and line feed\r\nSAVEPOINT synthetic',
      ]) {
        await expect(transaction.query(statement)).rejects.toThrow(
          'Transaction control is owned by the transaction helper.',
        );
      }
      await expect(transaction.query('select 1; COMMIT')).rejects.toThrow(
        'Transaction executors do not allow multi-statement SQL.',
      );
      await expect(transaction.query("select ';'; COMMIT")).rejects.toThrow(
        'Transaction executors do not allow multi-statement SQL.',
      );
      await expect(transaction.query('select $tag$; ROLLBACK$tag$; COMMIT')).rejects.toThrow(
        'Transaction executors do not allow multi-statement SQL.',
      );
      await transaction.query('insert into transaction_probe (value) values ($1)', [
        'control-rejected',
      ]);
    });

    expect(
      (await applicationDatabase.query<{ value: string }>('select value from transaction_probe'))
        .rows,
    ).toEqual([{ value: 'control-rejected' }]);
  });

  it('allows a trailing delimiter and semicolons inside PostgreSQL lexical forms', async () => {
    await applicationDatabase.transaction(async (transaction) => {
      const singleQuoted = await transaction.query<{ value: string }>(
        "select 'single;quoted'::text as value;",
      );
      const escapeQuoted = await transaction.query<{ value: string }>(
        "select E'escaped quote: \\' and ;'::text as value;",
      );
      const quotedIdentifier = await transaction.query<{ 'semi;colon': number }>(
        'select 1::integer as "semi;colon";',
      );
      const dollarQuoted = await transaction.query<{ value: string }>(
        'select $$dollar; COMMIT$$::text as value;',
      );
      const taggedDollarQuoted = await transaction.query<{ value: string }>(
        'select $audit$tagged; ROLLBACK$audit$::text as value;',
      );
      const commented = await transaction.query<{ value: number }>(
        'select 1::integer as value /* ; COMMIT */; -- ; ROLLBACK\r',
      );
      const ordinarySetting = await transaction.query<{ value: string }>(
        "select set_config('statement_timeout', '5000', true) as value;",
      );

      expect(singleQuoted.rows).toEqual([{ value: 'single;quoted' }]);
      expect(escapeQuoted.rows).toEqual([{ value: "escaped quote: ' and ;" }]);
      expect(quotedIdentifier.rows).toEqual([{ 'semi;colon': 1 }]);
      expect(dollarQuoted.rows).toEqual([{ value: 'dollar; COMMIT' }]);
      expect(taggedDollarQuoted.rows).toEqual([{ value: 'tagged; ROLLBACK' }]);
      expect(commented.rows).toEqual([{ value: 1 }]);
      expect(ordinarySetting.rows).toEqual([{ value: '5s' }]);
    });
  });

  it('rejects newline-obfuscated savepoints without allowing nonce reuse', async () => {
    await applicationDatabase.query(`
      create temporary table nonce_probe (
        singleton boolean primary key default true check (singleton),
        next_nonce bigint not null check (next_nonce >= 0)
      ) on commit preserve rows
    `);
    await applicationDatabase.query('insert into nonce_probe (next_nonce) values (0)');

    const returnedNonces = await applicationDatabase.transaction(async (transaction) => {
      const allocate = async (): Promise<string> => {
        const result = await transaction.query<{ nonce: string }>(`
          update nonce_probe
          set next_nonce = next_nonce + 1
          returning (next_nonce - 1)::text as nonce
        `);
        const row = result.rows[0];
        if (row === undefined) throw new Error('Expected a nonce row.');
        return row.nonce;
      };

      const allocated: string[] = [];
      for (const newline of ['\n', '\r\n', '\r']) {
        await expect(transaction.query(`-- audit${newline}SAVEPOINT before_nonce`)).rejects.toThrow(
          'Transaction control is owned by the transaction helper.',
        );
        allocated.push(await allocate());
        await expect(
          transaction.query(`-- audit${newline}ROLLBACK TO SAVEPOINT before_nonce`),
        ).rejects.toThrow('Transaction control is owned by the transaction helper.');
        allocated.push(await allocate());
      }
      return allocated;
    });

    const persisted = await applicationDatabase.query<{ nextNonce: string }>(`
      select next_nonce::text as "nextNonce" from nonce_probe
    `);
    expect(returnedNonces).toEqual(['0', '1', '2', '3', '4', '5']);
    expect(persisted.rows).toEqual([{ nextNonce: '6' }]);
  });

  it('rejects newline-obfuscated commits and rolls callback failures back', async () => {
    const transactionError = new Error('synthetic failure after rejected commit');

    await expect(
      applicationDatabase.transaction(async (transaction) => {
        await transaction.query('insert into transaction_probe (value) values ($1)', [
          'must-roll-back',
        ]);
        for (const newline of ['\n', '\r\n', '\r']) {
          await expect(transaction.query(`-- audit${newline}COMMIT`)).rejects.toThrow(
            'Transaction control is owned by the transaction helper.',
          );
        }
        await transaction.query('insert into transaction_probe (value) values ($1)', [
          'later-write-must-also-roll-back',
        ]);
        throw transactionError;
      }),
    ).rejects.toBe(transactionError);

    const persisted = await applicationDatabase.query<{ count: string }>(`
      select count(*)::text as count from transaction_probe
    `);
    expect(persisted.rows).toEqual([{ count: '0' }]);
  });

  it('prevents callbacks from overriding transaction characteristics', async () => {
    await applicationDatabase.transaction(
      async (transaction) => {
        for (const statement of [
          'SET TRANSACTION READ WRITE',
          'SET LOCAL TRANSACTION READ WRITE',
          'SET SESSION TRANSACTION READ WRITE',
          'SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE',
          'SET LOCAL transaction_read_only = off',
          'SET SESSION "transaction_isolation" = \'read committed\'',
          'RESET transaction_read_only',
          'RESET ALL',
        ]) {
          await expect(transaction.query(statement)).rejects.toThrow(
            'Transaction control is owned by the transaction helper.',
          );
        }
        await expect(
          transaction.query("select set_config('transaction_read_only', 'off', true) as value"),
        ).rejects.toThrow('Transaction control is owned by the transaction helper.');
        await expect(
          transaction.query('select set_config($1, $2, true) as value', [
            'transaction_read_only',
            'off',
          ]),
        ).rejects.toThrow('Transaction control is owned by the transaction helper.');
        await expect(
          transaction.query(
            "select set_config('transaction_' || 'read_only', 'off', true) as value",
          ),
        ).rejects.toThrow('Transaction control is owned by the transaction helper.');

        const state = await transaction.query<{ readOnly: string }>(`
          select current_setting('transaction_read_only') as "readOnly"
        `);
        expect(state.rows).toEqual([{ readOnly: 'on' }]);
      },
      { readOnly: true },
    );
  });

  it('uses standard-conforming string semantics regardless of the session default', async () => {
    await applicationDatabase.query('set standard_conforming_strings = off');
    try {
      await applicationDatabase.transaction(async (transaction) => {
        const state = await transaction.query<{ standardConformingStrings: string }>(`
          select current_setting('standard_conforming_strings') as "standardConformingStrings"
        `);
        expect(state.rows).toEqual([{ standardConformingStrings: 'on' }]);
      });

      const sessionState = await applicationDatabase.query<{ standardConformingStrings: string }>(`
        select current_setting('standard_conforming_strings') as "standardConformingStrings"
      `);
      expect(sessionState.rows).toEqual([{ standardConformingStrings: 'off' }]);
    } finally {
      await applicationDatabase.query('reset standard_conforming_strings');
    }
  });

  it('rejects an implicit rollback as a successful commit and cleans up executor state', async () => {
    let escapedTransaction: TransactionExecutor | undefined;

    await expect(
      applicationDatabase.transaction(async (transaction) => {
        escapedTransaction = transaction;
        await expect(
          transaction.query('insert into transaction_probe (value) values (null)'),
        ).rejects.toThrow(/null value/iu);
        return 'must-not-resolve';
      }),
    ).rejects.toThrow('PostgreSQL rolled back the transaction instead of committing.');

    const inactiveTransaction = escapedTransaction;
    if (inactiveTransaction === undefined) throw new Error('Expected an escaped transaction.');
    expect(() => assertTransactionExecutor(inactiveTransaction)).toThrow(
      'An active transaction executor is required.',
    );
    await expect(inactiveTransaction.query('select 1')).rejects.toThrow(
      'An active transaction executor is required.',
    );

    await applicationDatabase.transaction(async (transaction) => {
      await transaction.query('insert into transaction_probe (value) values ($1)', [
        'next-transaction',
      ]);
    });
    const persisted = await applicationDatabase.query<{ value: string }>(
      'select value from transaction_probe',
    );
    expect(persisted.rows).toEqual([{ value: 'next-transaction' }]);
  });

  it('rolls back when callback completion leaves executor queries outstanding', async () => {
    let unawaitedOperation: Promise<void> | undefined;
    await expect(
      applicationDatabase.transaction((transaction) => {
        unawaitedOperation = (async () => {
          await transaction.query('insert into transaction_probe (value) values ($1)', ['first']);
          await transaction.query('insert into transaction_probe (value) values ($1)', ['second']);
        })();
        void unawaitedOperation.catch(() => undefined);
        return Promise.resolve();
      }),
    ).rejects.toThrow('Transaction callback completed with outstanding queries.');

    expect(unawaitedOperation).toBeDefined();
    if (unawaitedOperation === undefined) throw new Error('Expected an unawaited operation.');
    await expect(unawaitedOperation).rejects.toThrow('An active transaction executor is required.');
    expect(
      (
        await applicationDatabase.query<{ count: string }>(
          'select count(*)::text as count from transaction_probe',
        )
      ).rows,
    ).toEqual([{ count: '0' }]);
  });

  it('deactivates rollback escapes while preserving independent outer transaction state', async () => {
    const innerDatabase = createTestPool(applicationEnvironment.connectionString);
    let escapedOuter: TransactionExecutor | undefined;
    let escapedInner: TransactionExecutor | undefined;
    try {
      await applicationDatabase.transaction(async (outer) => {
        escapedOuter = outer;
        await expect(
          innerDatabase.transaction((inner) => {
            escapedInner = inner;
            expect(() => assertTransactionExecutor(outer)).not.toThrow();
            expect(() => assertTransactionExecutor(inner)).not.toThrow();
            return Promise.reject(new Error('synthetic inner rollback'));
          }),
        ).rejects.toThrow('synthetic inner rollback');
        const inactiveInner = escapedInner;
        if (inactiveInner === undefined) throw new Error('Expected an escaped inner executor.');
        expect(() => assertTransactionExecutor(inactiveInner)).toThrow(
          'An active transaction executor is required.',
        );
        await expect(inactiveInner.query('select 1')).rejects.toThrow(
          'An active transaction executor is required.',
        );
        expect(() => assertTransactionExecutor(outer)).not.toThrow();
        await outer.query('insert into transaction_probe (value) values ($1)', ['outer']);
      });
    } finally {
      await innerDatabase.close();
    }

    const inactiveOuter = escapedOuter;
    if (inactiveOuter === undefined) throw new Error('Expected an escaped outer executor.');
    expect(() => assertTransactionExecutor(inactiveOuter)).toThrow(
      'An active transaction executor is required.',
    );
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
