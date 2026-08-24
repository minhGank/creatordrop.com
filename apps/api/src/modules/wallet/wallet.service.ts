import { createHash } from 'node:crypto';

import { validate as isUuid, v7 as uuidv7 } from 'uuid';

import {
  assertTransactionExecutor,
  type Database,
  type QueryExecutor,
  type TransactionExecutor,
} from '@creatordrop/database';
import {
  maximumMoneyMinor,
  MoneyValueError,
  negateMoneyMinor,
  parseCurrency,
  toMoneyMinor,
} from '@creatordrop/domain';
import type { Currency, PositiveMoneyMinor } from '@creatordrop/domain';
import type { Logger } from '@creatordrop/observability';

import type { UserId } from '../creators/creator.js';
import {
  IdempotencyKeyReusedError,
  InsufficientBalanceError,
  LedgerTransactionNotFoundError,
  TestCreditsUnavailableError,
  WalletAmountOverflowError,
  WalletCurrencyNotEnabledError,
  WalletNotFoundError,
} from './wallet.errors.js';
import {
  applyWalletDelta,
  claimIdempotencyRecord,
  completeIdempotencyRecord,
  ensureSystemTestFundingAccount,
  ensureUserWallet,
  finalizeLedgerTransaction,
  findLedgerTransactionWithEntries,
  findReversal,
  insertLedgerEntries,
  insertLedgerTransaction,
  listWalletsForUser,
  lockWalletForUpdate,
  lockWalletsForLedgerAccounts,
  reconcileWalletProjection,
} from './wallet.repository.js';
import {
  toPublicWallet,
  type IdempotencyRecordId,
  type LedgerAccountId,
  type LedgerEntry,
  type LedgerEntryId,
  type LedgerTransaction,
  type LedgerTransactionId,
  type LedgerTransactionWithEntries,
  type Wallet,
  type WalletId,
} from './wallet.js';

const testCreditOperation = 'wallet.test_credit';
const testCreditHttpStatus = 201;

type CreateId = () => string;

export interface WalletContractValue {
  readonly balanceMinor: string;
  readonly currency: string;
  readonly id: string;
  readonly revision: string;
}

export interface TestCreditGrantBody {
  readonly wallet: WalletContractValue;
}

export interface TestCreditGrantCommand {
  readonly amountMinor: PositiveMoneyMinor;
  readonly currency: Currency;
  readonly idempotencyKey: string;
  readonly requestId: string;
  readonly userId: UserId;
}

export interface TestCreditGrantResult {
  readonly body: TestCreditGrantBody;
  readonly replayed: boolean;
  readonly statusCode: number;
}

export interface WalletService {
  readonly grantTestCredits: (command: TestCreditGrantCommand) => Promise<TestCreditGrantResult>;
  readonly listWallets: (userId: UserId) => Promise<readonly Wallet[]>;
}

export interface WalletServiceOptions {
  readonly createId?: CreateId;
  readonly database: Database;
  readonly enabledTestCreditCurrencies?: readonly Currency[];
  readonly logger: Logger;
  readonly testCreditsEnabled: boolean;
}

interface WalletMovementInput {
  readonly actorUserId: UserId;
  readonly amountMinor: PositiveMoneyMinor;
  readonly businessReferenceId: string;
  readonly businessReferenceType: string;
  readonly counterpartyAccountId: LedgerAccountId;
  readonly currency: Currency;
  readonly description: string;
  readonly idempotencyRecordId: IdempotencyRecordId | null;
  readonly kind: 'test_credit_grant' | 'wallet_credit' | 'wallet_debit';
}

interface WalletMovementResult {
  readonly ledgerTransaction: LedgerTransaction;
  readonly wallet: Wallet;
}

export interface CreditWalletInput extends Omit<WalletMovementInput, 'kind'> {
  readonly kind: 'test_credit_grant' | 'wallet_credit';
}

export type DebitWalletInput = Omit<WalletMovementInput, 'kind'>;

export interface ReverseLedgerTransactionInput {
  readonly actorUserId: UserId;
  readonly businessReferenceId: string;
  readonly businessReferenceType: string;
  readonly description: string;
  readonly originalLedgerTransactionId: LedgerTransactionId;
}

const databaseCode = (error: unknown): string | undefined =>
  typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;

interface GeneratedIdentifiers {
  readonly idempotencyRecord: IdempotencyRecordId;
  readonly ledgerAccount: LedgerAccountId;
  readonly ledgerEntry: LedgerEntryId;
  readonly ledgerTransaction: LedgerTransactionId;
  readonly wallet: WalletId;
}

const generatedId = <Kind extends keyof GeneratedIdentifiers>(
  createId: CreateId,
  label: string,
  _kind: Kind,
): GeneratedIdentifiers[Kind] => {
  void _kind;
  const id = createId();
  if (!isUuid(id) || id !== id.toLowerCase()) throw new Error(`${label} must be a canonical UUID.`);
  return id as GeneratedIdentifiers[Kind];
};

const exactKeys = (value: Record<string, unknown>, expected: readonly string[]): boolean => {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
};

const storedTestCreditBody = (value: unknown): TestCreditGrantBody => {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    !exactKeys(value as Record<string, unknown>, ['wallet'])
  ) {
    throw new Error('Stored test-credit response has an invalid shape.');
  }
  const wallet = (value as Record<string, unknown>).wallet;
  if (
    typeof wallet !== 'object' ||
    wallet === null ||
    Array.isArray(wallet) ||
    !exactKeys(wallet as Record<string, unknown>, ['balanceMinor', 'currency', 'id', 'revision'])
  ) {
    throw new Error('Stored test-credit wallet response has an invalid shape.');
  }
  const record = wallet as Record<string, unknown>;
  const id = record.id;
  const balanceMinor = record.balanceMinor;
  const revision = record.revision;
  if (
    typeof id !== 'string' ||
    !isUuid(id) ||
    id !== id.toLowerCase() ||
    typeof balanceMinor !== 'string' ||
    !/^(0|[1-9][0-9]*)$/u.test(balanceMinor) ||
    BigInt(balanceMinor) > maximumMoneyMinor ||
    typeof revision !== 'string' ||
    !/^[1-9][0-9]*$/u.test(revision)
  ) {
    throw new Error('Stored test-credit wallet response contains invalid values.');
  }
  return {
    wallet: {
      balanceMinor,
      currency: parseCurrency(record.currency),
      id,
      revision,
    },
  };
};

export const buildTestCreditFingerprint = (input: {
  readonly actorUserId: UserId;
  readonly amountMinor: PositiveMoneyMinor;
  readonly currency: Currency;
}): string =>
  createHash('sha256')
    .update(
      `creatordrop:idempotency:v1|${testCreditOperation}|${input.actorUserId}|${input.currency}|${input.amountMinor.toString()}`,
      'utf8',
    )
    .digest('hex');

const moneyOverflow = async <Result>(operation: () => Promise<Result>): Promise<Result> => {
  try {
    return await operation();
  } catch (error) {
    if (databaseCode(error) === '22003' || error instanceof MoneyValueError) {
      throw new WalletAmountOverflowError();
    }
    throw error;
  }
};

const postWalletMovement = async (
  transaction: TransactionExecutor,
  input: WalletMovementInput,
  createId: CreateId,
): Promise<WalletMovementResult> => {
  assertTransactionExecutor(transaction);
  if (input.amountMinor <= 0n || input.amountMinor > maximumMoneyMinor) {
    throw new WalletAmountOverflowError();
  }
  const lockedWallet = await lockWalletForUpdate(transaction, input.actorUserId, input.currency);
  if (lockedWallet === undefined) throw new WalletNotFoundError();

  const walletDelta =
    input.kind === 'wallet_debit'
      ? toMoneyMinor(0n - BigInt(input.amountMinor))
      : toMoneyMinor(input.amountMinor);
  if (walletDelta < 0n && lockedWallet.availableBalanceMinor + walletDelta < 0n) {
    throw new InsufficientBalanceError();
  }
  const counterpartyDelta = negateMoneyMinor(walletDelta);
  const ledgerTransactionId = generatedId(createId, 'Ledger transaction ID', 'ledgerTransaction');
  const entries: readonly LedgerEntry[] = [
    {
      amountMinor: walletDelta,
      currency: input.currency,
      id: generatedId(createId, 'Ledger entry ID', 'ledgerEntry'),
      ledgerAccountId: lockedWallet.ledgerAccountId,
      sequence: 0,
    },
    {
      amountMinor: counterpartyDelta,
      currency: input.currency,
      id: generatedId(createId, 'Ledger entry ID', 'ledgerEntry'),
      ledgerAccountId: input.counterpartyAccountId,
      sequence: 1,
    },
  ];
  await insertLedgerTransaction(transaction, {
    actorUserId: input.actorUserId,
    businessReferenceId: input.businessReferenceId,
    businessReferenceType: input.businessReferenceType,
    currency: input.currency,
    description: input.description,
    id: ledgerTransactionId,
    idempotencyRecordId: input.idempotencyRecordId,
    kind: input.kind,
    reversesLedgerTransactionId: null,
  });
  await insertLedgerEntries(transaction, ledgerTransactionId, entries);
  const wallet = await applyWalletDelta(transaction, lockedWallet.id, walletDelta);
  if (wallet === undefined) throw new InsufficientBalanceError();
  await finalizeLedgerTransaction(transaction, ledgerTransactionId);
  return {
    ledgerTransaction: {
      actorUserId: input.actorUserId,
      businessReferenceId: input.businessReferenceId,
      businessReferenceType: input.businessReferenceType,
      currency: input.currency,
      id: ledgerTransactionId,
      idempotencyRecordId: input.idempotencyRecordId,
      kind: input.kind,
      reversesLedgerTransactionId: null,
      status: 'posted',
    },
    wallet,
  };
};

export const creditWallet = async (
  transaction: TransactionExecutor,
  input: CreditWalletInput,
  createId: CreateId = uuidv7,
): Promise<WalletMovementResult> =>
  moneyOverflow(() => postWalletMovement(transaction, input, createId));

export const debitWallet = async (
  transaction: TransactionExecutor,
  input: DebitWalletInput,
  createId: CreateId = uuidv7,
): Promise<WalletMovementResult> =>
  moneyOverflow(() =>
    postWalletMovement(transaction, { ...input, kind: 'wallet_debit' }, createId),
  );

export const reverseLedgerTransaction = async (
  transaction: TransactionExecutor,
  input: ReverseLedgerTransactionInput,
  createId: CreateId = uuidv7,
): Promise<LedgerTransactionWithEntries> => {
  assertTransactionExecutor(transaction);
  const replay = await findReversal(transaction, input.originalLedgerTransactionId);
  if (replay !== undefined) return replay;
  const original = await findLedgerTransactionWithEntries(
    transaction,
    input.originalLedgerTransactionId,
  );
  if (original?.transaction.status !== 'posted') {
    throw new LedgerTransactionNotFoundError();
  }

  const lockedWallets = await lockWalletsForLedgerAccounts(
    transaction,
    original.entries.map((entry) => entry.ledgerAccountId),
  );
  const replayAfterLock = await findReversal(transaction, input.originalLedgerTransactionId);
  if (replayAfterLock !== undefined) return replayAfterLock;
  const walletByAccount = new Map(
    lockedWallets.map((wallet) => [wallet.ledgerAccountId, wallet] as const),
  );
  const reversalEntries: LedgerEntry[] = original.entries.map((entry) => ({
    ...entry,
    amountMinor: negateMoneyMinor(entry.amountMinor),
    id: generatedId(createId, 'Ledger entry ID', 'ledgerEntry'),
  }));
  for (const entry of reversalEntries) {
    const wallet = walletByAccount.get(entry.ledgerAccountId);
    if (wallet !== undefined && wallet.availableBalanceMinor + entry.amountMinor < 0n) {
      throw new InsufficientBalanceError();
    }
  }

  const ledgerTransactionId = generatedId(createId, 'Ledger transaction ID', 'ledgerTransaction');
  await insertLedgerTransaction(transaction, {
    actorUserId: input.actorUserId,
    businessReferenceId: input.businessReferenceId,
    businessReferenceType: input.businessReferenceType,
    currency: original.transaction.currency,
    description: input.description,
    id: ledgerTransactionId,
    idempotencyRecordId: null,
    kind: 'reversal',
    reversesLedgerTransactionId: original.transaction.id,
  });
  await insertLedgerEntries(transaction, ledgerTransactionId, reversalEntries);
  for (const entry of reversalEntries) {
    const wallet = walletByAccount.get(entry.ledgerAccountId);
    if (wallet !== undefined) {
      const updated = await applyWalletDelta(transaction, wallet.id, entry.amountMinor);
      if (updated === undefined) throw new InsufficientBalanceError();
    }
  }
  await finalizeLedgerTransaction(transaction, ledgerTransactionId);
  return {
    entries: reversalEntries,
    transaction: {
      actorUserId: input.actorUserId,
      businessReferenceId: input.businessReferenceId,
      businessReferenceType: input.businessReferenceType,
      currency: original.transaction.currency,
      id: ledgerTransactionId,
      idempotencyRecordId: null,
      kind: 'reversal',
      reversesLedgerTransactionId: original.transaction.id,
      status: 'posted',
    },
  };
};

export const reconcileWallet = (
  executor: QueryExecutor,
  walletId: WalletId,
): ReturnType<typeof reconcileWalletProjection> => reconcileWalletProjection(executor, walletId);

export const createWalletService = ({
  createId = uuidv7,
  database,
  enabledTestCreditCurrencies = [parseCurrency('USD')],
  logger,
  testCreditsEnabled,
}: WalletServiceOptions): WalletService => ({
  grantTestCredits: async (command) => {
    if (!testCreditsEnabled) throw new TestCreditsUnavailableError();
    if (!enabledTestCreditCurrencies.includes(command.currency)) {
      throw new WalletCurrencyNotEnabledError();
    }
    const fingerprint = buildTestCreditFingerprint({
      actorUserId: command.userId,
      amountMinor: command.amountMinor,
      currency: command.currency,
    });
    const outcome = await database.transaction(async (transaction) => {
      const idempotencyRecordId = generatedId(
        createId,
        'Idempotency record ID',
        'idempotencyRecord',
      );
      const claim = await claimIdempotencyRecord(transaction, {
        actorUserId: command.userId,
        fingerprint,
        id: idempotencyRecordId,
        idempotencyKey: command.idempotencyKey,
        operation: testCreditOperation,
      });
      if (!claim.created) {
        if (claim.record.fingerprint !== fingerprint) throw new IdempotencyKeyReusedError();
        if (
          claim.record.status !== 'completed' ||
          claim.record.httpStatus !== testCreditHttpStatus
        ) {
          throw new Error('Committed idempotency replay is incomplete.');
        }
        return {
          body: storedTestCreditBody(claim.record.responseBody),
          ledgerTransactionId: claim.record.resourceId,
          replayed: true,
          statusCode: claim.record.httpStatus,
        };
      }

      const fundingAccount = await ensureSystemTestFundingAccount(transaction, {
        accountId: generatedId(createId, 'System ledger account ID', 'ledgerAccount'),
        currency: command.currency,
      });
      await ensureUserWallet(transaction, {
        currency: command.currency,
        ledgerAccountId: generatedId(createId, 'User ledger account ID', 'ledgerAccount'),
        userId: command.userId,
        walletId: generatedId(createId, 'Wallet ID', 'wallet'),
      });
      const movement = await creditWallet(
        transaction,
        {
          actorUserId: command.userId,
          amountMinor: command.amountMinor,
          businessReferenceId: claim.record.id,
          businessReferenceType: 'test_credit_grant',
          counterpartyAccountId: fundingAccount.id,
          currency: command.currency,
          description: 'Synthetic local/test credit grant',
          idempotencyRecordId: claim.record.id,
          kind: 'test_credit_grant',
        },
        createId,
      );
      const body: TestCreditGrantBody = { wallet: toPublicWallet(movement.wallet) };
      await completeIdempotencyRecord(transaction, {
        httpStatus: testCreditHttpStatus,
        recordId: claim.record.id,
        resourceId: movement.ledgerTransaction.id,
        responseBody: body,
      });
      return {
        body,
        ledgerTransactionId: movement.ledgerTransaction.id,
        replayed: false,
        statusCode: testCreditHttpStatus,
      };
    });

    if (!outcome.replayed) {
      logger.info('wallet.audit', {
        action: 'wallet.test_credit_granted',
        actorUserId: command.userId,
        amountMinor: command.amountMinor.toString(),
        currency: command.currency,
        ledgerTransactionId: outcome.ledgerTransactionId,
        requestId: command.requestId,
      });
    }
    return { body: outcome.body, replayed: outcome.replayed, statusCode: outcome.statusCode };
  },

  listWallets: (userId) => listWalletsForUser(database, userId),
});
