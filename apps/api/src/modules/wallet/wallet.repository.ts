import { validate as isUuid } from 'uuid';

import { assertTransactionExecutor } from '@creatordrop/database';
import type { QueryExecutor, TransactionExecutor } from '@creatordrop/database';
import { parseCurrency, toMoneyMinor } from '@creatordrop/domain';
import type { Currency, MoneyMinor } from '@creatordrop/domain';

import type { UserId } from '../creators/creator.js';
import type {
  IdempotencyRecord,
  IdempotencyRecordId,
  LedgerAccount,
  LedgerAccountId,
  LedgerEntry,
  LedgerEntryId,
  LedgerTransaction,
  LedgerTransactionId,
  LedgerTransactionKind,
  LedgerTransactionWithEntries,
  Wallet,
  WalletId,
} from './wallet.js';

interface WalletRow {
  readonly availableBalanceMinor: unknown;
  readonly createdAt: unknown;
  readonly currency: unknown;
  readonly id: unknown;
  readonly ledgerAccountId: unknown;
  readonly revision: unknown;
  readonly updatedAt: unknown;
  readonly userId: unknown;
}

interface LedgerAccountRow {
  readonly accountType: unknown;
  readonly currency: unknown;
  readonly id: unknown;
  readonly ownerUserId: unknown;
}

interface LedgerTransactionRow {
  readonly actorUserId: unknown;
  readonly businessReferenceId: unknown;
  readonly businessReferenceType: unknown;
  readonly currency: unknown;
  readonly id: unknown;
  readonly idempotencyRecordId: unknown;
  readonly kind: unknown;
  readonly reversesLedgerTransactionId: unknown;
  readonly status: unknown;
}

interface LedgerEntryRow {
  readonly amountMinor: unknown;
  readonly currency: unknown;
  readonly id: unknown;
  readonly ledgerAccountId: unknown;
  readonly sequence: unknown;
}

interface IdempotencyRow {
  readonly actorUserId: unknown;
  readonly fingerprint: unknown;
  readonly httpStatus: unknown;
  readonly id: unknown;
  readonly operation: unknown;
  readonly resourceId: unknown;
  readonly resourceType: unknown;
  readonly responseBody: unknown;
  readonly status: unknown;
}

const walletColumns = `
  id::text as id,
  user_id::text as "userId",
  currency::text as currency,
  ledger_account_id::text as "ledgerAccountId",
  available_balance_minor::text as "availableBalanceMinor",
  revision::text as revision,
  created_at as "createdAt",
  updated_at as "updatedAt"
`;

const ledgerAccountColumns = `
  id::text as id,
  account_type as "accountType",
  owner_user_id::text as "ownerUserId",
  currency::text as currency
`;

const ledgerTransactionColumns = `
  id::text as id,
  kind,
  actor_user_id::text as "actorUserId",
  currency::text as currency,
  business_reference_type as "businessReferenceType",
  business_reference_id::text as "businessReferenceId",
  idempotency_record_id::text as "idempotencyRecordId",
  reverses_ledger_transaction_id::text as "reversesLedgerTransactionId",
  status
`;

const ledgerEntryColumns = `
  id::text as id,
  ledger_account_id::text as "ledgerAccountId",
  amount_minor::text as "amountMinor",
  currency::text as currency,
  sequence
`;

const idempotencyColumns = `
  id::text as id,
  actor_user_id::text as "actorUserId",
  operation,
  encode(request_fingerprint, 'hex') as fingerprint,
  status,
  http_status as "httpStatus",
  response_body as "responseBody",
  resource_type as "resourceType",
  resource_id::text as "resourceId"
`;

const requiredString = (value: unknown, label: string): string => {
  if (typeof value !== 'string') throw new Error(`Database returned an invalid ${label}.`);
  return value;
};

const nullableString = (value: unknown, label: string): string | null =>
  value === null ? null : requiredString(value, label);

const requiredUuid = (value: unknown, label: string): string => {
  const parsed = requiredString(value, label);
  if (!isUuid(parsed) || parsed !== parsed.toLowerCase()) {
    throw new Error(`Database returned a noncanonical ${label}.`);
  }
  return parsed;
};

const timestamp = (value: unknown, label: string): string => {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error(`Database returned an invalid ${label}.`);
  }
  return value.toISOString();
};

const bigintValue = (value: unknown, label: string): bigint => {
  const parsed = requiredString(value, label);
  if (!/^-?(0|[1-9][0-9]*)$/u.test(parsed)) {
    throw new Error(`Database returned a noncanonical ${label}.`);
  }
  return BigInt(parsed);
};

const parseWallet = (row: WalletRow): Wallet => ({
  availableBalanceMinor: toMoneyMinor(bigintValue(row.availableBalanceMinor, 'wallet balance')),
  createdAt: timestamp(row.createdAt, 'wallet creation timestamp'),
  currency: parseCurrency(row.currency),
  id: requiredUuid(row.id, 'wallet ID') as WalletId,
  ledgerAccountId: requiredUuid(row.ledgerAccountId, 'ledger account ID') as LedgerAccountId,
  revision: bigintValue(row.revision, 'wallet revision'),
  updatedAt: timestamp(row.updatedAt, 'wallet update timestamp'),
  userId: requiredUuid(row.userId, 'wallet user ID') as UserId,
});

const parseLedgerAccount = (row: LedgerAccountRow): LedgerAccount => {
  const accountType = requiredString(row.accountType, 'ledger account type');
  if (accountType !== 'system_test_funding' && accountType !== 'user_wallet') {
    throw new Error('Database returned an invalid ledger account type.');
  }
  return {
    accountType,
    currency: parseCurrency(row.currency),
    id: requiredUuid(row.id, 'ledger account ID') as LedgerAccountId,
    ownerUserId:
      row.ownerUserId === null
        ? null
        : (requiredUuid(row.ownerUserId, 'ledger account owner ID') as UserId),
  };
};

const parseLedgerTransaction = (row: LedgerTransactionRow): LedgerTransaction => {
  const kind = requiredString(row.kind, 'ledger transaction kind');
  if (!['reversal', 'test_credit_grant', 'wallet_credit', 'wallet_debit'].includes(kind)) {
    throw new Error('Database returned an invalid ledger transaction kind.');
  }
  const status = requiredString(row.status, 'ledger transaction status');
  if (status !== 'pending' && status !== 'posted') {
    throw new Error('Database returned an invalid ledger transaction status.');
  }
  return {
    actorUserId: requiredUuid(row.actorUserId, 'ledger actor user ID') as UserId,
    businessReferenceId: requiredUuid(row.businessReferenceId, 'ledger business reference ID'),
    businessReferenceType: requiredString(
      row.businessReferenceType,
      'ledger business reference type',
    ),
    currency: parseCurrency(row.currency),
    id: requiredUuid(row.id, 'ledger transaction ID') as LedgerTransactionId,
    idempotencyRecordId:
      row.idempotencyRecordId === null
        ? null
        : (requiredUuid(row.idempotencyRecordId, 'idempotency record ID') as IdempotencyRecordId),
    kind: kind as LedgerTransactionKind,
    reversesLedgerTransactionId:
      row.reversesLedgerTransactionId === null
        ? null
        : (requiredUuid(
            row.reversesLedgerTransactionId,
            'reversed ledger transaction ID',
          ) as LedgerTransactionId),
    status,
  };
};

const parseLedgerEntry = (row: LedgerEntryRow): LedgerEntry => {
  if (typeof row.sequence !== 'number' || !Number.isSafeInteger(row.sequence) || row.sequence < 0) {
    throw new Error('Database returned an invalid ledger entry sequence.');
  }
  return {
    amountMinor: toMoneyMinor(bigintValue(row.amountMinor, 'ledger entry amount')),
    currency: parseCurrency(row.currency),
    id: requiredUuid(row.id, 'ledger entry ID') as LedgerEntryId,
    ledgerAccountId: requiredUuid(
      row.ledgerAccountId,
      'ledger entry account ID',
    ) as LedgerAccountId,
    sequence: row.sequence,
  };
};

const parseIdempotencyRecord = (row: IdempotencyRow): IdempotencyRecord => {
  const status = requiredString(row.status, 'idempotency status');
  if (status !== 'processing' && status !== 'completed') {
    throw new Error('Database returned an invalid idempotency status.');
  }
  if (
    row.httpStatus !== null &&
    (typeof row.httpStatus !== 'number' || !Number.isInteger(row.httpStatus))
  ) {
    throw new Error('Database returned an invalid idempotency HTTP status.');
  }
  return {
    actorUserId: requiredUuid(row.actorUserId, 'idempotency actor user ID') as UserId,
    fingerprint: requiredString(row.fingerprint, 'idempotency fingerprint'),
    httpStatus: row.httpStatus,
    id: requiredUuid(row.id, 'idempotency record ID') as IdempotencyRecordId,
    operation: requiredString(row.operation, 'idempotency operation'),
    resourceId: nullableString(row.resourceId, 'idempotency resource ID'),
    resourceType: nullableString(row.resourceType, 'idempotency resource type'),
    responseBody: row.responseBody,
    status,
  };
};

export const listWalletsForUser = async (
  executor: QueryExecutor,
  userId: UserId,
): Promise<readonly Wallet[]> => {
  const result = await executor.query<WalletRow>(
    `
    select ${walletColumns}
      from app.wallets
      where user_id = $1
      order by currency, id
  `,
    [userId],
  );
  return result.rows.map(parseWallet);
};

export const lockWalletForUpdate = async (
  transaction: TransactionExecutor,
  userId: UserId,
  currency: Currency,
): Promise<Wallet | undefined> => {
  assertTransactionExecutor(transaction);
  const result = await transaction.query<WalletRow>(
    `
    select ${walletColumns}
      from app.lock_user_wallet($1, $2)
  `,
    [userId, currency],
  );
  return result.rows[0] === undefined ? undefined : parseWallet(result.rows[0]);
};

export const ensureUserWallet = async (
  transaction: TransactionExecutor,
  input: {
    readonly currency: Currency;
    readonly ledgerAccountId: LedgerAccountId;
    readonly userId: UserId;
    readonly walletId: WalletId;
  },
): Promise<Wallet> => {
  assertTransactionExecutor(transaction);
  await transaction.query(
    `insert into app.ledger_accounts (id, account_type, owner_user_id, currency)
     values ($1, 'user_wallet', $2, $3)
     on conflict do nothing`,
    [input.ledgerAccountId, input.userId, input.currency],
  );
  const accountResult = await transaction.query<LedgerAccountRow>(
    `
    select ${ledgerAccountColumns}
      from app.ledger_accounts
      where account_type = 'user_wallet' and owner_user_id = $1 and currency = $2
  `,
    [input.userId, input.currency],
  );
  const accountRow = accountResult.rows[0];
  if (accountRow === undefined)
    throw new Error('The user ledger account could not be established.');
  const account = parseLedgerAccount(accountRow);

  await transaction.query(
    `insert into app.wallets (id, user_id, currency, ledger_account_id)
     values ($1, $2, $3, $4)
     on conflict do nothing`,
    [input.walletId, input.userId, input.currency, account.id],
  );
  const wallet = await lockWalletForUpdate(transaction, input.userId, input.currency);
  if (wallet === undefined) throw new Error('The user wallet could not be established.');
  return wallet;
};

export const ensureSystemTestFundingAccount = async (
  transaction: TransactionExecutor,
  input: { readonly accountId: LedgerAccountId; readonly currency: Currency },
): Promise<LedgerAccount> => {
  assertTransactionExecutor(transaction);
  await transaction.query(
    `insert into app.ledger_accounts (id, account_type, owner_user_id, currency)
     values ($1, 'system_test_funding', null, $2)
     on conflict do nothing`,
    [input.accountId, input.currency],
  );
  const result = await transaction.query<LedgerAccountRow>(
    `
    select ${ledgerAccountColumns}
      from app.ledger_accounts
      where account_type = 'system_test_funding' and currency = $1
  `,
    [input.currency],
  );
  const row = result.rows[0];
  if (row === undefined)
    throw new Error('The system test-funding account could not be established.');
  return parseLedgerAccount(row);
};

export const claimIdempotencyRecord = async (
  transaction: TransactionExecutor,
  input: {
    readonly actorUserId: UserId;
    readonly fingerprint: string;
    readonly id: IdempotencyRecordId;
    readonly idempotencyKey: string;
    readonly operation: string;
  },
): Promise<{ readonly created: boolean; readonly record: IdempotencyRecord }> => {
  assertTransactionExecutor(transaction);
  const inserted = await transaction.query<IdempotencyRow>(
    `
    insert into app.idempotency_records (
      id, actor_user_id, operation, idempotency_key, request_fingerprint
    ) values ($1, $2, $3, $4, decode($5, 'hex'))
    on conflict (actor_user_id, operation, idempotency_key) do nothing
    returning ${idempotencyColumns}
  `,
    [input.id, input.actorUserId, input.operation, input.idempotencyKey, input.fingerprint],
  );
  const insertedRow = inserted.rows[0];
  if (insertedRow !== undefined)
    return { created: true, record: parseIdempotencyRecord(insertedRow) };

  const existing = await transaction.query<IdempotencyRow>(
    `
    select ${idempotencyColumns}
      from app.idempotency_records
      where actor_user_id = $1 and operation = $2 and idempotency_key = $3
  `,
    [input.actorUserId, input.operation, input.idempotencyKey],
  );
  const existingRow = existing.rows[0];
  if (existingRow === undefined) throw new Error('The idempotency claim could not be resolved.');
  return { created: false, record: parseIdempotencyRecord(existingRow) };
};

export const completeIdempotencyRecord = async (
  transaction: TransactionExecutor,
  input: {
    readonly httpStatus: number;
    readonly recordId: IdempotencyRecordId;
    readonly resourceId: LedgerTransactionId;
    readonly responseBody: Readonly<object>;
  },
): Promise<void> => {
  assertTransactionExecutor(transaction);
  await transaction.query(
    `select app.complete_idempotency_record($1, $2, $3::jsonb, 'ledger_transaction', $4)`,
    [input.recordId, input.httpStatus, JSON.stringify(input.responseBody), input.resourceId],
  );
};

export const insertLedgerTransaction = async (
  transaction: TransactionExecutor,
  input: {
    readonly actorUserId: UserId;
    readonly businessReferenceId: string;
    readonly businessReferenceType: string;
    readonly currency: Currency;
    readonly description: string;
    readonly id: LedgerTransactionId;
    readonly idempotencyRecordId: IdempotencyRecordId | null;
    readonly kind: LedgerTransactionKind;
    readonly reversesLedgerTransactionId: LedgerTransactionId | null;
  },
): Promise<void> => {
  assertTransactionExecutor(transaction);
  await transaction.query(
    `insert into app.ledger_transactions (
       id, kind, actor_user_id, currency, business_reference_type,
       business_reference_id, idempotency_record_id, reverses_ledger_transaction_id,
       description
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      input.id,
      input.kind,
      input.actorUserId,
      input.currency,
      input.businessReferenceType,
      input.businessReferenceId,
      input.idempotencyRecordId,
      input.reversesLedgerTransactionId,
      input.description,
    ],
  );
};

export const insertLedgerEntries = async (
  transaction: TransactionExecutor,
  ledgerTransactionId: LedgerTransactionId,
  entries: readonly LedgerEntry[],
): Promise<void> => {
  assertTransactionExecutor(transaction);
  for (const entry of entries) {
    await transaction.query(
      `insert into app.ledger_entries (
         id, ledger_transaction_id, ledger_account_id, amount_minor, currency, sequence
       ) values ($1, $2, $3, $4, $5, $6)`,
      [
        entry.id,
        ledgerTransactionId,
        entry.ledgerAccountId,
        entry.amountMinor.toString(),
        entry.currency,
        entry.sequence,
      ],
    );
  }
};

export const finalizeLedgerTransaction = async (
  transaction: TransactionExecutor,
  ledgerTransactionId: LedgerTransactionId,
): Promise<void> => {
  assertTransactionExecutor(transaction);
  await transaction.query(`select app.finalize_ledger_transaction($1)`, [ledgerTransactionId]);
};

export const applyWalletDelta = async (
  transaction: TransactionExecutor,
  walletId: WalletId,
  deltaMinor: MoneyMinor,
): Promise<Wallet | undefined> => {
  assertTransactionExecutor(transaction);
  const result = await transaction.query<WalletRow>(
    `
    select ${walletColumns}
      from app.apply_wallet_balance($1, $2)
  `,
    [walletId, deltaMinor.toString()],
  );
  return result.rows[0] === undefined ? undefined : parseWallet(result.rows[0]);
};

export const findLedgerTransactionWithEntries = async (
  executor: QueryExecutor,
  ledgerTransactionId: LedgerTransactionId,
): Promise<LedgerTransactionWithEntries | undefined> => {
  const transactionResult = await executor.query<LedgerTransactionRow>(
    `
    select ${ledgerTransactionColumns}
      from app.ledger_transactions
      where id = $1
  `,
    [ledgerTransactionId],
  );
  const transactionRow = transactionResult.rows[0];
  if (transactionRow === undefined) return undefined;
  const entryResult = await executor.query<LedgerEntryRow>(
    `
    select ${ledgerEntryColumns}
      from app.ledger_entries
      where ledger_transaction_id = $1
      order by sequence
  `,
    [ledgerTransactionId],
  );
  return {
    entries: entryResult.rows.map(parseLedgerEntry),
    transaction: parseLedgerTransaction(transactionRow),
  };
};

export const findReversal = async (
  executor: QueryExecutor,
  originalLedgerTransactionId: LedgerTransactionId,
): Promise<LedgerTransactionWithEntries | undefined> => {
  const result = await executor.query<{ readonly id: unknown }>(
    `select id::text as id
       from app.ledger_transactions
       where reverses_ledger_transaction_id = $1`,
    [originalLedgerTransactionId],
  );
  const row = result.rows[0];
  if (row === undefined) return undefined;
  return findLedgerTransactionWithEntries(
    executor,
    requiredUuid(row.id, 'reversal transaction ID') as LedgerTransactionId,
  );
};

export const lockWalletsForLedgerAccounts = async (
  transaction: TransactionExecutor,
  ledgerAccountIds: readonly LedgerAccountId[],
): Promise<readonly Wallet[]> => {
  assertTransactionExecutor(transaction);
  if (ledgerAccountIds.length === 0) return [];
  const result = await transaction.query<WalletRow>(
    `
    select ${walletColumns}
      from app.lock_wallets_for_ledger_accounts($1::uuid[])
  `,
    [ledgerAccountIds],
  );
  return result.rows.map(parseWallet);
};

export const reconcileWalletProjection = async (
  executor: QueryExecutor,
  walletId: WalletId,
): Promise<{
  readonly balanced: boolean;
  readonly cachedBalanceMinor: MoneyMinor;
  readonly ledgerBalanceMinor: MoneyMinor;
}> => {
  const result = await executor.query<{
    readonly cachedBalanceMinor: unknown;
    readonly ledgerBalanceMinor: unknown;
  }>(
    `select wallet.available_balance_minor::text as "cachedBalanceMinor",
            coalesce(sum(entry.amount_minor), 0)::text as "ledgerBalanceMinor"
       from app.wallets as wallet
       left join app.ledger_entries as entry
         on entry.ledger_account_id = wallet.ledger_account_id
      where wallet.id = $1
      group by wallet.id`,
    [walletId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('The wallet projection could not be reconciled.');
  const cachedBalanceMinor = toMoneyMinor(bigintValue(row.cachedBalanceMinor, 'cached balance'));
  const ledgerBalanceMinor = toMoneyMinor(bigintValue(row.ledgerBalanceMinor, 'ledger balance'));
  return {
    balanced: cachedBalanceMinor === ledgerBalanceMinor,
    cachedBalanceMinor,
    ledgerBalanceMinor,
  };
};
