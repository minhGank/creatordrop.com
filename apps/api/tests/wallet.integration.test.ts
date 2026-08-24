import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseDatabaseEnvironment, parseMigrationEnvironment } from '@creatordrop/config';
import {
  createDatabasePool,
  type Database,
  type QueryExecutor,
  type TransactionExecutor,
} from '@creatordrop/database';
import {
  parseCurrency,
  parsePositiveMoneyMinor,
  toMoneyMinor,
  type Currency,
  type MoneyMinor,
} from '@creatordrop/domain';
import type { Logger } from '@creatordrop/observability';

import type { UserId } from '../src/modules/creators/creator.js';
import { InsufficientBalanceError } from '../src/modules/wallet/wallet.errors.js';
import {
  claimIdempotencyRecord,
  completeIdempotencyRecord,
  ensureSystemTestFundingAccount,
  ensureUserWallet,
  finalizeLedgerTransaction,
  insertLedgerEntries,
  insertLedgerTransaction,
} from '../src/modules/wallet/wallet.repository.js';
import {
  buildTestCreditFingerprint,
  createWalletService,
  creditWallet,
  debitWallet,
  reconcileWallet,
  reverseLedgerTransaction,
} from '../src/modules/wallet/wallet.service.js';
import type {
  IdempotencyRecordId,
  LedgerAccountId,
  LedgerEntry,
  LedgerEntryId,
  LedgerTransactionId,
  Wallet,
  WalletId,
} from '../src/modules/wallet/wallet.js';

const localApplicationUrl =
  'postgresql://postgres:postgres@127.0.0.1:54322/postgres?options=-c%20role%3Dcreatordrop_app';
const localMigrationUrl = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const { DATABASE_MIGRATION_URL: migrationUrl, DATABASE_URL: applicationUrl } = process.env;

const applicationEnvironment = parseDatabaseEnvironment({
  DATABASE_APPLICATION_NAME: 'creatordrop-wallet-integration',
  DATABASE_CONNECTION_TIMEOUT_MS: '5000',
  DATABASE_IDLE_TIMEOUT_MS: '1000',
  DATABASE_POOL_MAX: '4',
  DATABASE_URL: applicationUrl ?? localApplicationUrl,
});
const migrationEnvironment = parseMigrationEnvironment({
  DATABASE_MIGRATION_URL: migrationUrl ?? localMigrationUrl,
});

const usd = parseCurrency('USD');
const cad = parseCurrency('CAD');
const logger: Logger = { error: () => undefined, info: () => undefined };

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
}

type Settlement =
  { readonly status: 'fulfilled' } | { readonly reason: unknown; readonly status: 'rejected' };

const createDeferred = <Value>(): Deferred<Value> => {
  let resolver: (value: Value) => void = () => {
    throw new Error('Deferred resolver was not initialized.');
  };
  const promise = new Promise<Value>((resolve) => {
    resolver = resolve;
  });
  return { promise, resolve: resolver };
};

const trackSettlement = <Value>(operation: Promise<Value>): Promise<Settlement> =>
  operation.then(
    () => ({ status: 'fulfilled' }),
    (reason: unknown) => ({ reason, status: 'rejected' }),
  );

const readBackendPid = async (executor: QueryExecutor): Promise<number> => {
  const result = await executor.query<{ readonly backendPid: number }>(
    `select pg_catalog.pg_backend_pid() as "backendPid"`,
  );
  const pid = result.rows[0]?.backendPid;
  if (pid === undefined) throw new Error('PostgreSQL did not return its backend PID.');
  return pid;
};

const observeBlockingOrSettlement = async (
  inspector: QueryExecutor,
  waiterPid: number,
  blockerPid: number,
  settlement: Promise<Settlement>,
): Promise<'blocked' | 'settled'> => {
  let observedSettlement: Settlement | undefined;
  void settlement.then((result) => {
    observedSettlement = result;
  });
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const result = await inspector.query<{ readonly blocked: boolean }>(
      `select $2::integer = any(pg_catalog.pg_blocking_pids($1::integer)) as blocked`,
      [waiterPid, blockerPid],
    );
    if (result.rows[0]?.blocked === true) return 'blocked';
    if (observedSettlement !== undefined) return 'settled';
  }
  throw new Error('The concurrent wallet operation neither blocked nor settled.');
};

const createUser = async (database: Database, label: string): Promise<UserId> => {
  const id = randomUUID() as UserId;
  await database.query(
    `insert into app.users (id, auth_provider, auth_subject, username)
     values ($1, 'synthetic-wallet', $2, $3)`,
    [id, `${label}-${id}`, `wallet_${id.replaceAll('-', '')}`],
  );
  return id;
};

const serviceFor = (database: Database) =>
  createWalletService({ database, logger, testCreditsEnabled: true });

const grant = async (
  database: Database,
  userId: UserId,
  amountMinor: string,
  idempotencyKey = `grant_${randomUUID()}`,
) =>
  serviceFor(database).grantTestCredits({
    amountMinor: parsePositiveMoneyMinor(amountMinor),
    currency: usd,
    idempotencyKey,
    requestId: randomUUID(),
    userId,
  });

const getWallet = async (database: Database, userId: UserId, currency = usd): Promise<Wallet> => {
  const wallet = (await serviceFor(database).listWallets(userId)).find(
    (candidate) => candidate.currency === currency,
  );
  if (wallet === undefined) throw new Error('Expected the test wallet to exist.');
  return wallet;
};

const getSystemAccountId = async (database: Database, currency = usd): Promise<LedgerAccountId> => {
  const result = await database.query<{ readonly id: string }>(
    `select id::text as id from app.ledger_accounts
      where account_type = 'system_test_funding' and currency = $1`,
    [currency],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('Expected the system funding account to exist.');
  return id as LedgerAccountId;
};

const debit = (
  transaction: TransactionExecutor,
  input: {
    readonly amountMinor: string;
    readonly counterpartyAccountId: LedgerAccountId;
    readonly userId: UserId;
  },
) =>
  debitWallet(transaction, {
    actorUserId: input.userId,
    amountMinor: parsePositiveMoneyMinor(input.amountMinor),
    businessReferenceId: randomUUID(),
    businessReferenceType: 'wallet_debit_test',
    counterpartyAccountId: input.counterpartyAccountId,
    currency: usd,
    description: 'Synthetic integration debit',
    idempotencyRecordId: null,
  });

const insertRawPosting = async (
  transaction: TransactionExecutor,
  input: {
    readonly actorUserId: UserId;
    readonly currency: Currency;
    readonly entries: readonly {
      readonly accountId: LedgerAccountId;
      readonly amountMinor: MoneyMinor;
      readonly currency: Currency;
    }[];
  },
): Promise<LedgerTransactionId> => {
  const transactionId = randomUUID() as LedgerTransactionId;
  await insertLedgerTransaction(transaction, {
    actorUserId: input.actorUserId,
    businessReferenceId: randomUUID(),
    businessReferenceType: 'database_invariant_test',
    currency: input.currency,
    description: 'Synthetic invalid posting probe',
    id: transactionId,
    idempotencyRecordId: null,
    kind: 'wallet_credit',
    reversesLedgerTransactionId: null,
  });
  const entries: LedgerEntry[] = input.entries.map((entry, sequence) => ({
    amountMinor: entry.amountMinor,
    currency: entry.currency,
    id: randomUUID() as LedgerEntryId,
    ledgerAccountId: entry.accountId,
    sequence,
  }));
  await insertLedgerEntries(transaction, transactionId, entries);
  await finalizeLedgerTransaction(transaction, transactionId);
  return transactionId;
};

describe('wallet ledger and idempotency integration', { concurrent: false }, () => {
  let applicationDatabase: Database;
  let firstConcurrencyDatabase: Database;
  let migrationDatabase: Database;
  let secondConcurrencyDatabase: Database;

  beforeAll(() => {
    applicationDatabase = createDatabasePool({
      ...applicationEnvironment,
      onUnexpectedPoolError: (error) => {
        throw error;
      },
    });
    firstConcurrencyDatabase = createDatabasePool({
      ...applicationEnvironment,
      applicationName: 'creatordrop-wallet-concurrency-a',
      maxConnections: 1,
      onUnexpectedPoolError: (error) => {
        throw error;
      },
    });
    secondConcurrencyDatabase = createDatabasePool({
      ...applicationEnvironment,
      applicationName: 'creatordrop-wallet-concurrency-b',
      maxConnections: 1,
      onUnexpectedPoolError: (error) => {
        throw error;
      },
    });
    migrationDatabase = createDatabasePool({
      ...applicationEnvironment,
      applicationName: 'creatordrop-wallet-integration-admin',
      connectionString: migrationEnvironment.connectionString,
      onUnexpectedPoolError: (error) => {
        throw error;
      },
    });
  });

  afterAll(async () => {
    await Promise.all([
      applicationDatabase.close(),
      firstConcurrencyDatabase.close(),
      migrationDatabase.close(),
      secondConcurrencyDatabase.close(),
    ]);
  });

  it('grants USD test credits once, replays exactly, and rejects key reuse', async () => {
    const userId = await createUser(applicationDatabase, 'idempotency');
    const key = `grant_${randomUUID()}`;
    const first = await grant(applicationDatabase, userId, '2000', key);
    const replay = await grant(applicationDatabase, userId, '2000', key);

    expect(first.replayed).toBe(false);
    expect(replay).toEqual({ ...first, replayed: true });
    await expect(grant(applicationDatabase, userId, '2001', key)).rejects.toMatchObject({
      name: 'IdempotencyKeyReusedError',
    });
    const counts = await applicationDatabase.query<{
      readonly balance: string;
      readonly idempotencyCount: string;
      readonly transactionCount: string;
    }>(
      `select
         (select available_balance_minor::text from app.wallets
           where user_id = $1 and currency = 'USD') as balance,
         (select count(*)::text from app.idempotency_records
           where actor_user_id = $1 and operation = 'wallet.test_credit') as "idempotencyCount",
         (select count(*)::text from app.ledger_transactions
           where actor_user_id = $1 and kind = 'test_credit_grant') as "transactionCount"`,
      [userId],
    );
    expect(counts.rows).toEqual([
      { balance: '2000', idempotencyCount: '1', transactionCount: '1' },
    ]);
  });

  it('serializes concurrent identical idempotency requests without double credit', async () => {
    const userId = await createUser(applicationDatabase, 'concurrent_idempotency');
    const key = `grant_${randomUUID()}`;
    const [first, second] = await Promise.all([
      grant(firstConcurrencyDatabase, userId, '750', key),
      grant(secondConcurrencyDatabase, userId, '750', key),
    ]);

    expect([first.replayed, second.replayed].sort()).toEqual([false, true]);
    expect(first.body).toEqual(second.body);
    const wallet = await getWallet(applicationDatabase, userId);
    expect(wallet.availableBalanceMinor).toBe(750n);
    expect(
      (
        await applicationDatabase.query<{ readonly count: string }>(
          `select count(*)::text as count from app.ledger_transactions
            where actor_user_id = $1 and kind = 'test_credit_grant'`,
          [userId],
        )
      ).rows,
    ).toEqual([{ count: '1' }]);
  });

  it('enables only USD test credits and rolls signed-bigint overflow back cleanly', async () => {
    const userId = await createUser(applicationDatabase, 'currency_and_overflow');
    const service = serviceFor(applicationDatabase);
    await expect(
      createWalletService({
        database: applicationDatabase,
        logger,
        testCreditsEnabled: false,
      }).grantTestCredits({
        amountMinor: parsePositiveMoneyMinor('1'),
        currency: usd,
        idempotencyKey: `grant_${randomUUID()}`,
        requestId: randomUUID(),
        userId,
      }),
    ).rejects.toMatchObject({ name: 'TestCreditsUnavailableError' });
    await expect(
      service.grantTestCredits({
        amountMinor: parsePositiveMoneyMinor('1'),
        currency: cad,
        idempotencyKey: `grant_${randomUUID()}`,
        requestId: randomUUID(),
        userId,
      }),
    ).rejects.toMatchObject({ name: 'WalletCurrencyNotEnabledError' });

    await grant(applicationDatabase, userId, '9223372036854775807');
    await expect(grant(applicationDatabase, userId, '1')).rejects.toMatchObject({
      name: 'WalletAmountOverflowError',
    });
    const wallet = await getWallet(applicationDatabase, userId);
    expect(wallet.availableBalanceMinor).toBe(9_223_372_036_854_775_807n);
    expect(
      (
        await applicationDatabase.query<{ readonly count: string }>(
          `select count(*)::text as count from app.ledger_transactions
            where actor_user_id = $1 and kind = 'test_credit_grant'`,
          [userId],
        )
      ).rows,
    ).toEqual([{ count: '1' }]);
  });

  it('allows exactly one of two concurrent full-balance debits', async () => {
    const userId = await createUser(applicationDatabase, 'overspend');
    await grant(applicationDatabase, userId, '500');
    const counterpartyAccountId = await getSystemAccountId(applicationDatabase);
    const firstLocked = createDeferred<number>();
    const releaseFirst = createDeferred<undefined>();
    const secondStarted = createDeferred<number>();

    const first = firstConcurrencyDatabase.transaction(async (transaction) => {
      const movement = await debit(transaction, {
        amountMinor: '500',
        counterpartyAccountId,
        userId,
      });
      firstLocked.resolve(await readBackendPid(transaction));
      await releaseFirst.promise;
      return movement;
    });
    const blockerPid = await firstLocked.promise;
    const second = secondConcurrencyDatabase.transaction(async (transaction) => {
      secondStarted.resolve(await readBackendPid(transaction));
      return debit(transaction, { amountMinor: '500', counterpartyAccountId, userId });
    });
    const waiterPid = await secondStarted.promise;
    const secondSettlement = trackSettlement(second);
    expect(
      await observeBlockingOrSettlement(migrationDatabase, waiterPid, blockerPid, secondSettlement),
    ).toBe('blocked');
    releaseFirst.resolve(undefined);

    const settlements = await Promise.allSettled([first, second]);
    expect(settlements.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    const rejected = settlements.find(({ status }) => status === 'rejected');
    expect(rejected?.status).toBe('rejected');
    if (rejected?.status !== 'rejected') throw new Error('Expected one rejected debit.');
    expect(rejected.reason).toBeInstanceOf(InsufficientBalanceError);
    const wallet = await getWallet(applicationDatabase, userId);
    expect(wallet.availableBalanceMinor).toBe(0n);
    expect(await reconcileWallet(applicationDatabase, wallet.id)).toEqual({
      balanced: true,
      cachedBalanceMinor: 0n,
      ledgerBalanceMinor: 0n,
    });
    expect(
      (
        await applicationDatabase.query<{ readonly count: string }>(
          `select count(*)::text as count from app.ledger_transactions
            where actor_user_id = $1 and kind = 'wallet_debit'`,
          [userId],
        )
      ).rows,
    ).toEqual([{ count: '1' }]);
  });

  it('does not make different-user wallet mutations wait on one another', async () => {
    const firstUserId = await createUser(applicationDatabase, 'parallel_a');
    const secondUserId = await createUser(applicationDatabase, 'parallel_b');
    await Promise.all([
      grant(applicationDatabase, firstUserId, '500'),
      grant(applicationDatabase, secondUserId, '500'),
    ]);
    const counterpartyAccountId = await getSystemAccountId(applicationDatabase);
    const firstLocked = createDeferred<number>();
    const releaseFirst = createDeferred<undefined>();
    const secondStarted = createDeferred<number>();

    const first = firstConcurrencyDatabase.transaction(async (transaction) => {
      const movement = await debit(transaction, {
        amountMinor: '100',
        counterpartyAccountId,
        userId: firstUserId,
      });
      firstLocked.resolve(await readBackendPid(transaction));
      await releaseFirst.promise;
      return movement;
    });
    const blockerPid = await firstLocked.promise;
    const second = secondConcurrencyDatabase.transaction(async (transaction) => {
      secondStarted.resolve(await readBackendPid(transaction));
      return debit(transaction, {
        amountMinor: '100',
        counterpartyAccountId,
        userId: secondUserId,
      });
    });
    const waiterPid = await secondStarted.promise;
    const secondSettlement = trackSettlement(second);
    expect(
      await observeBlockingOrSettlement(migrationDatabase, waiterPid, blockerPid, secondSettlement),
    ).toBe('settled');
    expect(await secondSettlement).toEqual({ status: 'fulfilled' });
    releaseFirst.resolve(undefined);
    await expect(first).resolves.toBeDefined();
  });

  it('rolls wallet, ledger, entries, and idempotency completion back together', async () => {
    const userId = await createUser(applicationDatabase, 'rollback');
    await grant(applicationDatabase, userId, '100');
    const before = await getWallet(applicationDatabase, userId);
    const counterpartyAccountId = await getSystemAccountId(applicationDatabase);
    const recordId = randomUUID() as IdempotencyRecordId;
    const fingerprint = buildTestCreditFingerprint({
      actorUserId: userId,
      amountMinor: parsePositiveMoneyMinor('25'),
      currency: usd,
    });

    await expect(
      applicationDatabase.transaction(async (transaction) => {
        const claim = await claimIdempotencyRecord(transaction, {
          actorUserId: userId,
          fingerprint,
          id: recordId,
          idempotencyKey: `grant_${randomUUID()}`,
          operation: 'wallet.test_credit',
        });
        const movement = await creditWallet(transaction, {
          actorUserId: userId,
          amountMinor: parsePositiveMoneyMinor('25'),
          businessReferenceId: claim.record.id,
          businessReferenceType: 'test_credit_grant',
          counterpartyAccountId,
          currency: usd,
          description: 'Rollback probe',
          idempotencyRecordId: claim.record.id,
          kind: 'test_credit_grant',
        });
        await completeIdempotencyRecord(transaction, {
          httpStatus: 201,
          recordId: claim.record.id,
          resourceId: movement.ledgerTransaction.id,
          responseBody: { wallet: { id: movement.wallet.id } },
        });
        throw new Error('synthetic later failure');
      }),
    ).rejects.toThrow('synthetic later failure');

    const after = await getWallet(applicationDatabase, userId);
    expect(after.availableBalanceMinor).toBe(before.availableBalanceMinor);
    const counts = await applicationDatabase.query<{
      readonly entryCount: string;
      readonly idempotencyCount: string;
      readonly transactionCount: string;
    }>(
      `select
         (select count(*)::text from app.idempotency_records where id = $1)
           as "idempotencyCount",
         (select count(*)::text from app.ledger_transactions
           where business_reference_id = $1) as "transactionCount",
         (select count(*)::text from app.ledger_entries as entry
           join app.ledger_transactions as transaction
             on transaction.id = entry.ledger_transaction_id
           where transaction.business_reference_id = $1) as "entryCount"`,
      [recordId],
    );
    expect(counts.rows).toEqual([
      { entryCount: '0', idempotencyCount: '0', transactionCount: '0' },
    ]);
  });

  it('rejects unbalanced, one-entry, zero, and cross-currency postings in PostgreSQL', async () => {
    const userId = await createUser(applicationDatabase, 'constraints');
    await grant(applicationDatabase, userId, '1000');
    const wallet = await getWallet(applicationDatabase, userId);
    const fundingAccountId = await getSystemAccountId(applicationDatabase);
    const cadAccounts = await applicationDatabase.transaction(async (transaction) => {
      const funding = await ensureSystemTestFundingAccount(transaction, {
        accountId: randomUUID() as LedgerAccountId,
        currency: cad,
      });
      const cadWallet = await ensureUserWallet(transaction, {
        currency: cad,
        ledgerAccountId: randomUUID() as LedgerAccountId,
        userId,
        walletId: randomUUID() as WalletId,
      });
      return { cadWallet, funding };
    });

    await expect(
      applicationDatabase.transaction((transaction) =>
        insertRawPosting(transaction, {
          actorUserId: userId,
          currency: usd,
          entries: [
            { accountId: wallet.ledgerAccountId, amountMinor: toMoneyMinor(500n), currency: usd },
            { accountId: fundingAccountId, amountMinor: toMoneyMinor(-400n), currency: usd },
          ],
        }),
      ),
    ).rejects.toMatchObject({ constraint: 'ledger_transactions_unbalanced' });
    await expect(
      applicationDatabase.transaction((transaction) =>
        insertRawPosting(transaction, {
          actorUserId: userId,
          currency: usd,
          entries: [
            { accountId: wallet.ledgerAccountId, amountMinor: toMoneyMinor(500n), currency: usd },
          ],
        }),
      ),
    ).rejects.toMatchObject({ constraint: 'ledger_transactions_minimum_entries' });
    await expect(
      applicationDatabase.transaction(async (transaction) => {
        const transactionId = randomUUID() as LedgerTransactionId;
        await insertLedgerTransaction(transaction, {
          actorUserId: userId,
          businessReferenceId: randomUUID(),
          businessReferenceType: 'zero_entry_test',
          currency: usd,
          description: 'Synthetic zero-entry probe',
          id: transactionId,
          idempotencyRecordId: null,
          kind: 'wallet_credit',
          reversesLedgerTransactionId: null,
        });
        await transaction.query(
          `insert into app.ledger_entries (
             id, ledger_transaction_id, ledger_account_id, amount_minor, currency, sequence
           ) values ($1, $2, $3, 0, 'USD', 2)`,
          [randomUUID(), transactionId, fundingAccountId],
        );
      }),
    ).rejects.toMatchObject({ constraint: 'ledger_entries_amount_nonzero' });
    await expect(
      applicationDatabase.transaction((transaction) =>
        insertRawPosting(transaction, {
          actorUserId: userId,
          currency: usd,
          entries: [
            { accountId: wallet.ledgerAccountId, amountMinor: toMoneyMinor(500n), currency: usd },
            {
              accountId: cadAccounts.funding.id,
              amountMinor: toMoneyMinor(-500n),
              currency: cad,
            },
          ],
        }),
      ),
    ).rejects.toMatchObject({ constraint: 'ledger_transactions_currency_mismatch' });
  });

  it('keeps posted history immutable for the restricted application role', async () => {
    const userId = await createUser(applicationDatabase, 'immutable');
    await grant(applicationDatabase, userId, '300');
    const transactionResult = await applicationDatabase.query<{
      readonly entryId: string;
      readonly transactionId: string;
    }>(
      `select transaction.id::text as "transactionId", entry.id::text as "entryId"
         from app.ledger_transactions as transaction
         join app.ledger_entries as entry on entry.ledger_transaction_id = transaction.id
        where transaction.actor_user_id = $1
        order by entry.sequence
        limit 1`,
      [userId],
    );
    const identifiers = transactionResult.rows[0];
    if (identifiers === undefined) throw new Error('Expected posted financial history.');

    await expect(
      applicationDatabase.query(`update app.ledger_entries set amount_minor = 1 where id = $1`, [
        identifiers.entryId,
      ]),
    ).rejects.toThrow(/permission denied/iu);
    await expect(
      applicationDatabase.query(`delete from app.ledger_entries where id = $1`, [
        identifiers.entryId,
      ]),
    ).rejects.toThrow(/permission denied/iu);
    await expect(
      applicationDatabase.query(
        `update app.ledger_transactions set currency = 'CAD' where id = $1`,
        [identifiers.transactionId],
      ),
    ).rejects.toThrow(/permission denied/iu);
  });

  it('posts opposite-entry reversals without changing history and stays reconciled', async () => {
    const userId = await createUser(applicationDatabase, 'reversal');
    await grant(applicationDatabase, userId, '1000');
    const counterpartyAccountId = await getSystemAccountId(applicationDatabase);
    const original = await applicationDatabase.transaction((transaction) =>
      debit(transaction, { amountMinor: '200', counterpartyAccountId, userId }),
    );
    const originalEntriesBefore = await applicationDatabase.query<{
      readonly accountId: string;
      readonly amountMinor: string;
    }>(
      `select ledger_account_id::text as "accountId", amount_minor::text as "amountMinor"
         from app.ledger_entries where ledger_transaction_id = $1 order by sequence`,
      [original.ledgerTransaction.id],
    );
    const reversalInput = {
      actorUserId: userId,
      businessReferenceId: randomUUID(),
      businessReferenceType: 'wallet_reversal_test',
      description: 'Synthetic integration reversal',
      originalLedgerTransactionId: original.ledgerTransaction.id,
    } as const;
    const firstReversal = await applicationDatabase.transaction((transaction) =>
      reverseLedgerTransaction(transaction, reversalInput),
    );
    const replay = await applicationDatabase.transaction((transaction) =>
      reverseLedgerTransaction(transaction, {
        ...reversalInput,
        businessReferenceId: randomUUID(),
      }),
    );

    expect(replay.transaction.id).toBe(firstReversal.transaction.id);
    expect(
      (
        await applicationDatabase.query(
          `select ledger_account_id::text as "accountId", amount_minor::text as "amountMinor"
             from app.ledger_entries where ledger_transaction_id = $1 order by sequence`,
          [original.ledgerTransaction.id],
        )
      ).rows,
    ).toEqual(originalEntriesBefore.rows);
    const wallet = await getWallet(applicationDatabase, userId);
    expect(wallet.availableBalanceMinor).toBe(1000n);
    expect((await reconcileWallet(applicationDatabase, wallet.id)).balanced).toBe(true);
  });

  it('rejects transaction-owned financial primitives on an autocommit executor', async () => {
    const userId = await createUser(applicationDatabase, 'transaction_brand');
    await grant(applicationDatabase, userId, '10');
    const counterpartyAccountId = await getSystemAccountId(applicationDatabase);

    await expect(
      debitWallet(applicationDatabase as unknown as TransactionExecutor, {
        actorUserId: userId,
        amountMinor: parsePositiveMoneyMinor('1'),
        businessReferenceId: randomUUID(),
        businessReferenceType: 'transaction_brand_test',
        counterpartyAccountId,
        currency: usd,
        description: 'Must reject autocommit',
        idempotencyRecordId: null,
      }),
    ).rejects.toThrow(/active transaction executor/iu);
  });
});
