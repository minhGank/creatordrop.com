import { validate as isUuid } from 'uuid';

import { assertTransactionExecutor } from '@creatordrop/database';
import type { QueryExecutor, TransactionExecutor } from '@creatordrop/database';
import { parseCurrency, parsePositiveMoneyMinor } from '@creatordrop/domain';

import type { UserId } from '../creators/creator.js';
import type { LedgerAccountId, LedgerTransactionId, WalletId } from '../wallet/wallet.js';
import type {
  FundingAdjustmentId,
  FundingDeficitId,
  FundingIntent,
  FundingIntentId,
  FundingIntentStatus,
  FundingSettlement,
  FundingSettlementId,
  ProviderEventId,
  ProviderEventRecord,
} from './payment.js';

interface FundingIntentRow {
  readonly clientIdempotencyKey: unknown;
  readonly currency: unknown;
  readonly id: unknown;
  readonly lastProviderEventCreatedAt: unknown;
  readonly providerPaymentIntentId: unknown;
  readonly publicId: unknown;
  readonly requestFingerprint: unknown;
  readonly requestedAmountMinor: unknown;
  readonly status: unknown;
  readonly userId: unknown;
  readonly walletId: unknown;
}

interface ProviderEventRow {
  readonly attemptCount: unknown;
  readonly fundingIntentId: unknown;
  readonly id: unknown;
  readonly payloadSha256: unknown;
  readonly status: unknown;
}

interface FundingSettlementRow {
  readonly currency: unknown;
  readonly fundingIntentId: unknown;
  readonly id: unknown;
  readonly ledgerTransactionId: unknown;
  readonly providerPaymentIntentId: unknown;
  readonly settledAmountMinor: unknown;
}

const fundingIntentColumns = `
  id::text as id,
  public_id::text as "publicId",
  user_id::text as "userId",
  wallet_id::text as "walletId",
  provider_payment_intent_id as "providerPaymentIntentId",
  client_idempotency_key as "clientIdempotencyKey",
  encode(request_fingerprint, 'hex') as "requestFingerprint",
  requested_amount_minor::text as "requestedAmountMinor",
  currency::text as currency,
  status,
  last_provider_event_created_at as "lastProviderEventCreatedAt"
`;

const settlementColumns = `
  id::text as id,
  funding_intent_id::text as "fundingIntentId",
  provider_payment_intent_id as "providerPaymentIntentId",
  ledger_transaction_id::text as "ledgerTransactionId",
  settled_amount_minor::text as "settledAmountMinor",
  currency::text as currency
`;

const requiredString = (value: unknown, label: string): string => {
  if (typeof value !== 'string') throw new Error(`Database returned an invalid ${label}.`);
  return value;
};

const uuid = (value: unknown, label: string): string => {
  const parsed = requiredString(value, label);
  if (!isUuid(parsed) || parsed !== parsed.toLowerCase()) {
    throw new Error(`Database returned a noncanonical ${label}.`);
  }
  return parsed;
};

const nullableTimestamp = (value: unknown, label: string): string | null => {
  if (value === null) return null;
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error(`Database returned an invalid ${label}.`);
  }
  return value.toISOString();
};

const parseFundingIntent = (row: FundingIntentRow): FundingIntent => {
  const status = requiredString(row.status, 'funding intent status');
  if (
    ![
      'canceled',
      'disputed',
      'failed',
      'partially_reversed',
      'provider_pending',
      'reconciliation_required',
      'requires_payment',
      'reversed',
      'settled',
    ].includes(status)
  ) {
    throw new Error('Database returned an invalid funding intent status.');
  }
  const providerPaymentIntentId = row.providerPaymentIntentId;
  if (providerPaymentIntentId !== null && typeof providerPaymentIntentId !== 'string') {
    throw new Error('Database returned an invalid provider payment-intent ID.');
  }
  return {
    clientIdempotencyKey: requiredString(row.clientIdempotencyKey, 'client idempotency key'),
    currency: parseCurrency(row.currency),
    id: uuid(row.id, 'funding intent ID') as FundingIntentId,
    lastProviderEventCreatedAt: nullableTimestamp(
      row.lastProviderEventCreatedAt,
      'last provider event timestamp',
    ),
    providerPaymentIntentId,
    publicId: uuid(row.publicId, 'public funding intent ID'),
    requestFingerprint: requiredString(row.requestFingerprint, 'request fingerprint'),
    requestedAmountMinor: parsePositiveMoneyMinor(row.requestedAmountMinor),
    status: status as FundingIntentStatus,
    userId: uuid(row.userId, 'funding intent user ID') as UserId,
    walletId: uuid(row.walletId, 'funding intent wallet ID') as WalletId,
  };
};

const parseProviderEvent = (row: ProviderEventRow): ProviderEventRecord => {
  const status = requiredString(row.status, 'provider event status');
  if (status !== 'processing' && status !== 'processed' && status !== 'retryable') {
    throw new Error('Database returned an invalid provider event status.');
  }
  if (
    typeof row.attemptCount !== 'number' ||
    !Number.isSafeInteger(row.attemptCount) ||
    row.attemptCount <= 0
  ) {
    throw new Error('Database returned an invalid provider event attempt count.');
  }
  return {
    attemptCount: row.attemptCount,
    fundingIntentId:
      row.fundingIntentId === null
        ? null
        : (uuid(row.fundingIntentId, 'provider event funding intent ID') as FundingIntentId),
    id: uuid(row.id, 'provider event ID') as ProviderEventId,
    payloadSha256: requiredString(row.payloadSha256, 'provider event payload hash'),
    status,
  };
};

const parseSettlement = (row: FundingSettlementRow): FundingSettlement => ({
  currency: parseCurrency(row.currency),
  fundingIntentId: uuid(row.fundingIntentId, 'settlement funding intent ID') as FundingIntentId,
  id: uuid(row.id, 'funding settlement ID') as FundingSettlementId,
  ledgerTransactionId: uuid(
    row.ledgerTransactionId,
    'settlement ledger transaction ID',
  ) as LedgerTransactionId,
  providerPaymentIntentId: requiredString(
    row.providerPaymentIntentId,
    'settlement payment-intent ID',
  ),
  settledAmountMinor: parsePositiveMoneyMinor(row.settledAmountMinor),
});

export const insertFundingIntent = async (
  transaction: TransactionExecutor,
  input: {
    readonly clientIdempotencyKey: string;
    readonly currency: string;
    readonly fingerprint: string;
    readonly id: FundingIntentId;
    readonly publicId: string;
    readonly requestedAmountMinor: bigint;
    readonly userId: UserId;
    readonly walletId: WalletId;
  },
): Promise<FundingIntent | undefined> => {
  assertTransactionExecutor(transaction);
  const result = await transaction.query<FundingIntentRow>(
    `insert into app.funding_intents (
       id, public_id, user_id, wallet_id, provider, client_idempotency_key,
       request_fingerprint, requested_amount_minor, currency
     ) values ($1, $2, $3, $4, 'stripe', $5, decode($6, 'hex'), $7, $8)
     on conflict (user_id, client_idempotency_key) do nothing
     returning ${fundingIntentColumns}`,
    [
      input.id,
      input.publicId,
      input.userId,
      input.walletId,
      input.clientIdempotencyKey,
      input.fingerprint,
      input.requestedAmountMinor.toString(),
      input.currency,
    ],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : parseFundingIntent(row);
};

export const lockFundingIntentByClientKey = async (
  transaction: TransactionExecutor,
  userId: UserId,
  clientIdempotencyKey: string,
): Promise<FundingIntent | undefined> => {
  assertTransactionExecutor(transaction);
  const result = await transaction.query<FundingIntentRow>(
    `select ${fundingIntentColumns}
       from app.funding_intents
      where user_id = $1 and client_idempotency_key = $2
      for update`,
    [userId, clientIdempotencyKey],
  );
  return result.rows[0] === undefined ? undefined : parseFundingIntent(result.rows[0]);
};

export const lockFundingIntentByProviderId = async (
  transaction: TransactionExecutor,
  providerPaymentIntentId: string,
): Promise<FundingIntent | undefined> => {
  assertTransactionExecutor(transaction);
  const result = await transaction.query<FundingIntentRow>(
    `select ${fundingIntentColumns}
       from app.funding_intents
      where provider = 'stripe' and provider_payment_intent_id = $1
      for update`,
    [providerPaymentIntentId],
  );
  return result.rows[0] === undefined ? undefined : parseFundingIntent(result.rows[0]);
};

export const findFundingIntentByProviderId = async (
  executor: QueryExecutor,
  providerPaymentIntentId: string,
): Promise<FundingIntent | undefined> => {
  const result = await executor.query<FundingIntentRow>(
    `select ${fundingIntentColumns}
       from app.funding_intents
      where provider = 'stripe' and provider_payment_intent_id = $1`,
    [providerPaymentIntentId],
  );
  return result.rows[0] === undefined ? undefined : parseFundingIntent(result.rows[0]);
};

export const lockFundingIntentById = async (
  transaction: TransactionExecutor,
  fundingIntentId: FundingIntentId,
): Promise<FundingIntent | undefined> => {
  assertTransactionExecutor(transaction);
  const result = await transaction.query<FundingIntentRow>(
    `select ${fundingIntentColumns}
       from app.funding_intents
      where id = $1
      for update`,
    [fundingIntentId],
  );
  return result.rows[0] === undefined ? undefined : parseFundingIntent(result.rows[0]);
};

export const findFundingIntentById = async (
  executor: QueryExecutor,
  fundingIntentId: FundingIntentId,
): Promise<FundingIntent | undefined> => {
  const result = await executor.query<FundingIntentRow>(
    `select ${fundingIntentColumns} from app.funding_intents where id = $1`,
    [fundingIntentId],
  );
  return result.rows[0] === undefined ? undefined : parseFundingIntent(result.rows[0]);
};

export const bindFundingIntentToProvider = async (
  transaction: TransactionExecutor,
  fundingIntentId: FundingIntentId,
  providerPaymentIntentId: string,
): Promise<FundingIntent> => {
  assertTransactionExecutor(transaction);
  const result = await transaction.query<FundingIntentRow>(
    `update app.funding_intents
        set provider_payment_intent_id = $2,
            status = 'requires_payment',
            updated_at = clock_timestamp()
      where id = $1
        and status = 'provider_pending'
        and provider_payment_intent_id is null
      returning ${fundingIntentColumns}`,
    [fundingIntentId, providerPaymentIntentId],
  );
  const row = result.rows[0];
  if (row !== undefined) return parseFundingIntent(row);
  const existing = await transaction.query<FundingIntentRow>(
    `select ${fundingIntentColumns} from app.funding_intents where id = $1 for update`,
    [fundingIntentId],
  );
  const existingRow = existing.rows[0];
  if (existingRow === undefined) throw new Error('The funding intent disappeared during binding.');
  const parsed = parseFundingIntent(existingRow);
  if (parsed.providerPaymentIntentId !== providerPaymentIntentId) {
    throw new Error('The funding intent has conflicting provider identity.');
  }
  return parsed;
};

export const claimProviderEvent = async (
  transaction: TransactionExecutor,
  input: {
    readonly eventId: ProviderEventId;
    readonly eventType: string;
    readonly fundingIntentId: FundingIntentId | null;
    readonly payloadSha256: string;
    readonly providerCreatedAt: Date;
    readonly providerEventId: string;
    readonly providerObjectId: string | null;
  },
): Promise<{ readonly created: boolean; readonly record: ProviderEventRecord }> => {
  assertTransactionExecutor(transaction);
  const inserted = await transaction.query<ProviderEventRow>(
    `insert into app.provider_events (
       id, provider, provider_event_id, event_type, provider_object_id,
       funding_intent_id, payload_sha256, provider_created_at
     ) values ($1, 'stripe', $2, $3, $4, $5, decode($6, 'hex'), $7)
     on conflict (provider, provider_event_id) do nothing
     returning id::text as id, funding_intent_id::text as "fundingIntentId",
               encode(payload_sha256, 'hex') as "payloadSha256", status,
               attempt_count as "attemptCount"`,
    [
      input.eventId,
      input.providerEventId,
      input.eventType,
      input.providerObjectId,
      input.fundingIntentId,
      input.payloadSha256,
      input.providerCreatedAt,
    ],
  );
  if (inserted.rows[0] !== undefined) {
    return { created: true, record: parseProviderEvent(inserted.rows[0]) };
  }
  const existing = await transaction.query<
    ProviderEventRow & {
      readonly eventType: unknown;
      readonly providerObjectId: unknown;
    }
  >(
    `select id::text as id, funding_intent_id::text as "fundingIntentId",
            encode(payload_sha256, 'hex') as "payloadSha256", status,
            attempt_count as "attemptCount", event_type as "eventType",
            provider_object_id as "providerObjectId"
       from app.provider_events
      where provider = 'stripe' and provider_event_id = $1
      for update`,
    [input.providerEventId],
  );
  const row = existing.rows[0];
  if (row === undefined) throw new Error('The provider event claim could not be resolved.');
  const record = parseProviderEvent(row);
  if (
    record.payloadSha256 !== input.payloadSha256 ||
    row.eventType !== input.eventType ||
    row.providerObjectId !== input.providerObjectId ||
    record.fundingIntentId !== input.fundingIntentId
  ) {
    throw new Error('A provider event ID was reused with conflicting content.');
  }
  if (record.status === 'retryable') {
    const retried = await transaction.query<ProviderEventRow>(
      `update app.provider_events
          set status = 'processing', result_code = null, processed_at = null,
              attempt_count = attempt_count + 1
        where id = $1
        returning id::text as id, funding_intent_id::text as "fundingIntentId",
                  encode(payload_sha256, 'hex') as "payloadSha256", status,
                  attempt_count as "attemptCount"`,
      [record.id],
    );
    const retriedRow = retried.rows[0];
    if (retriedRow === undefined) throw new Error('The provider event retry could not be claimed.');
    return { created: false, record: parseProviderEvent(retriedRow) };
  }
  return { created: false, record };
};

export const completeProviderEvent = async (
  transaction: TransactionExecutor,
  eventId: ProviderEventId,
  resultCode: string,
  retryable: boolean,
): Promise<void> => {
  assertTransactionExecutor(transaction);
  const result = await transaction.query(
    `update app.provider_events
        set status = $2, result_code = $3, processed_at = clock_timestamp()
      where id = $1 and status = 'processing'`,
    [eventId, retryable ? 'retryable' : 'processed', resultCode],
  );
  if (result.rowCount !== 1) throw new Error('The provider event could not be completed.');
};

export const updateFundingIntentFromProvider = async (
  transaction: TransactionExecutor,
  input: {
    readonly eventCreatedAt: Date;
    readonly fundingIntentId: FundingIntentId;
    readonly status: FundingIntentStatus;
  },
): Promise<void> => {
  assertTransactionExecutor(transaction);
  await transaction.query(
    `update app.funding_intents
        set status = $2,
            last_provider_event_created_at = greatest(
              coalesce(last_provider_event_created_at, '-infinity'::timestamptz),
              $3::timestamptz
            ),
            updated_at = clock_timestamp()
      where id = $1
        and (
          last_provider_event_created_at is null
          or last_provider_event_created_at <= $3
          or $2 in ('settled', 'reconciliation_required')
        )`,
    [input.fundingIntentId, input.status, input.eventCreatedAt],
  );
};

export const updateFundingIntentAfterAdjustment = async (
  transaction: TransactionExecutor,
  input: {
    readonly eventCreatedAt: Date;
    readonly fundingIntentId: FundingIntentId;
    readonly fundingSettlementId: FundingSettlementId;
  },
): Promise<void> => {
  assertTransactionExecutor(transaction);
  const result = await transaction.query(
    `with adjustment_state as (
       select settlement.settled_amount_minor::numeric as settled_amount,
              coalesce(sum(adjustment.amount_minor::numeric), 0) as adjusted_amount,
              coalesce(bool_or(adjustment.adjustment_type = 'dispute'), false) as has_dispute
         from app.funding_settlements as settlement
         left join app.funding_adjustments as adjustment
           on adjustment.funding_settlement_id = settlement.id
        where settlement.id = $2
          and settlement.funding_intent_id = $1
        group by settlement.settled_amount_minor
     )
     update app.funding_intents as intent
        set status = case
              when state.adjusted_amount = 0 then 'settled'
              when state.adjusted_amount >= state.settled_amount then 'reversed'
              when state.has_dispute then 'disputed'
              else 'partially_reversed'
            end,
            last_provider_event_created_at = greatest(
              coalesce(intent.last_provider_event_created_at, '-infinity'::timestamptz),
              $3::timestamptz
            ),
            updated_at = clock_timestamp()
       from adjustment_state as state
      where intent.id = $1`,
    [input.fundingIntentId, input.fundingSettlementId, input.eventCreatedAt],
  );
  if (result.rowCount !== 1) {
    throw new Error('The funding intent adjustment state could not be derived.');
  }
};

export const insertFundingSettlement = async (
  transaction: TransactionExecutor,
  input: {
    readonly currency: string;
    readonly fundingIntentId: FundingIntentId;
    readonly id: FundingSettlementId;
    readonly ledgerTransactionId: LedgerTransactionId;
    readonly providerEventId: ProviderEventId;
    readonly providerPaymentIntentId: string;
    readonly settledAmountMinor: bigint;
  },
): Promise<void> => {
  assertTransactionExecutor(transaction);
  await transaction.query(
    `insert into app.funding_settlements (
       id, funding_intent_id, provider_event_id, provider,
       provider_payment_intent_id, ledger_transaction_id,
       settled_amount_minor, currency
     ) values ($1, $2, $3, 'stripe', $4, $5, $6, $7)`,
    [
      input.id,
      input.fundingIntentId,
      input.providerEventId,
      input.providerPaymentIntentId,
      input.ledgerTransactionId,
      input.settledAmountMinor.toString(),
      input.currency,
    ],
  );
};

export const findFundingSettlementByPaymentIntent = async (
  executor: QueryExecutor,
  providerPaymentIntentId: string,
): Promise<FundingSettlement | undefined> => {
  const result = await executor.query<FundingSettlementRow>(
    `select ${settlementColumns}
       from app.funding_settlements
      where provider = 'stripe' and provider_payment_intent_id = $1`,
    [providerPaymentIntentId],
  );
  return result.rows[0] === undefined ? undefined : parseSettlement(result.rows[0]);
};

export const fundingAdjustmentExists = async (
  executor: QueryExecutor,
  adjustmentType: 'dispute' | 'refund',
  providerAdjustmentId: string,
): Promise<boolean> => {
  const result = await executor.query<{ readonly exists: unknown }>(
    `select exists (
       select 1 from app.funding_adjustments
        where provider = 'stripe'
          and adjustment_type = $1
          and provider_adjustment_id = $2
     ) as exists`,
    [adjustmentType, providerAdjustmentId],
  );
  const exists = result.rows[0]?.exists;
  if (typeof exists !== 'boolean') throw new Error('Adjustment existence could not be resolved.');
  return exists;
};

export const insertFundingAdjustment = async (
  transaction: TransactionExecutor,
  input: {
    readonly adjustmentType: 'dispute' | 'refund';
    readonly amountMinor: bigint;
    readonly currency: string;
    readonly deficitLedgerAccountId: LedgerAccountId | null;
    readonly deficitMinor: bigint;
    readonly fundingAdjustmentId: FundingAdjustmentId;
    readonly fundingDeficitId: FundingDeficitId;
    readonly fundingSettlementId: FundingSettlementId;
    readonly ledgerTransactionId: LedgerTransactionId;
    readonly providerAdjustmentId: string;
    readonly providerEventId: ProviderEventId;
    readonly userId: UserId;
    readonly walletRecoveredMinor: bigint;
  },
): Promise<void> => {
  assertTransactionExecutor(transaction);
  await transaction.query(
    `insert into app.funding_adjustments (
       id, funding_settlement_id, provider_event_id, provider,
       provider_adjustment_id, adjustment_type, ledger_transaction_id,
       amount_minor, wallet_recovered_minor, deficit_minor, currency
     ) values ($1, $2, $3, 'stripe', $4, $5, $6, $7, $8, $9, $10)`,
    [
      input.fundingAdjustmentId,
      input.fundingSettlementId,
      input.providerEventId,
      input.providerAdjustmentId,
      input.adjustmentType,
      input.ledgerTransactionId,
      input.amountMinor.toString(),
      input.walletRecoveredMinor.toString(),
      input.deficitMinor.toString(),
      input.currency,
    ],
  );
  if (input.deficitMinor > 0n) {
    if (input.deficitLedgerAccountId === null) {
      throw new Error('A positive funding deficit requires its ledger account.');
    }
    await transaction.query(
      `insert into app.funding_deficits (
         id, funding_adjustment_id, user_id, ledger_account_id, currency, amount_minor
       ) values ($1, $2, $3, $4, $5, $6)`,
      [
        input.fundingDeficitId,
        input.fundingAdjustmentId,
        input.userId,
        input.deficitLedgerAccountId,
        input.currency,
        input.deficitMinor.toString(),
      ],
    );
  }
};

export const countFundingSettlementsForIntent = async (
  executor: QueryExecutor,
  fundingIntentId: FundingIntentId,
): Promise<number> => {
  const result = await executor.query<{ readonly count: unknown }>(
    `select count(*)::int as count from app.funding_settlements where funding_intent_id = $1`,
    [fundingIntentId],
  );
  const count = result.rows[0]?.count;
  if (typeof count !== 'number' || !Number.isSafeInteger(count)) {
    throw new Error('Settlement count could not be resolved.');
  }
  return count;
};

export const sumFundingAdjustments = async (
  executor: QueryExecutor,
  fundingSettlementId: FundingSettlementId,
): Promise<bigint> => {
  const result = await executor.query<{ readonly total: unknown }>(
    `select coalesce(sum(amount_minor::numeric), 0)::text as total
       from app.funding_adjustments
      where funding_settlement_id = $1`,
    [fundingSettlementId],
  );
  const total = result.rows[0]?.total;
  if (typeof total !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(total)) {
    throw new Error('Funding adjustment total could not be resolved.');
  }
  return BigInt(total);
};
