import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseDatabaseEnvironment } from '@creatordrop/config';
import { createDatabasePool, type Database } from '@creatordrop/database';
import { parseCurrency, parsePositiveMoneyMinor, toMoneyMinor } from '@creatordrop/domain';
import type { Logger } from '@creatordrop/observability';

import type { UserId } from '../src/modules/creators/creator.js';
import { AccountFundingRestrictedError } from '../src/modules/wallet/wallet.errors.js';
import { IdempotencyKeyReusedError } from '../src/modules/wallet/wallet.errors.js';
import {
  FundingAmountOutOfRangeError,
  FundingEventRetryRequiredError,
  FundingProviderUnavailableError,
} from '../src/modules/payments/payment.errors.js';
import {
  applyWalletDelta,
  ensureProviderFundingLedgerAccount,
  ensureSystemTestFundingAccount,
  finalizeLedgerTransaction,
  insertLedgerEntries,
  insertLedgerTransaction,
} from '../src/modules/wallet/wallet.repository.js';
import { creditWallet, debitWallet } from '../src/modules/wallet/wallet.service.js';
import type {
  LedgerAccountId,
  LedgerEntryId,
  LedgerTransactionId,
  WalletId,
} from '../src/modules/wallet/wallet.js';
import { createPaymentService } from '../src/modules/payments/payment.service.js';
import type { FundingIntentId } from '../src/modules/payments/payment.js';
import type {
  StripeFundingProvider,
  StripePaymentIntentValue,
  StripeWebhookEventValue,
} from '../src/modules/payments/stripe.provider.js';

const localApplicationUrl =
  'postgresql://postgres:postgres@127.0.0.1:54322/postgres?options=-c%20role%3Dcreatordrop_app';
const applicationEnvironment = parseDatabaseEnvironment({
  DATABASE_APPLICATION_NAME: 'creatordrop-payment-integration',
  DATABASE_CONNECTION_TIMEOUT_MS: '5000',
  DATABASE_IDLE_TIMEOUT_MS: '1000',
  DATABASE_POOL_MAX: '6',
  DATABASE_URL: process.env.DATABASE_URL ?? localApplicationUrl,
});
const usd = parseCurrency('USD');
const logger: Logger = { error: () => undefined, info: () => undefined };

class SyntheticStripeProvider implements StripeFundingProvider {
  createAmountOverride: bigint | undefined;
  readonly intents = new Map<string, StripePaymentIntentValue>();
  event: StripeWebhookEventValue | undefined;

  createPaymentIntent: StripeFundingProvider['createPaymentIntent'] = (input) => {
    const id = `pi_synthetic_${input.fundingIntentId.replaceAll('-', '')}`;
    const existing = this.intents.get(id);
    if (existing !== undefined) return Promise.resolve(existing);
    const value: StripePaymentIntentValue = {
      amountMinor: this.createAmountOverride ?? input.amountMinor,
      clientSecret: `${id}_secret_synthetic`,
      currency: input.currency,
      id,
      localFundingIntentId: input.fundingIntentId,
      status: 'requires_payment_method',
    };
    this.intents.set(id, value);
    return Promise.resolve(value);
  };

  parseWebhook: StripeFundingProvider['parseWebhook'] = () => {
    if (this.event === undefined) throw new Error('No synthetic Stripe event was configured.');
    return this.event;
  };

  retrievePaymentIntent: StripeFundingProvider['retrievePaymentIntent'] = (id) => {
    const value = this.intents.get(id);
    if (value === undefined) throw new Error('Synthetic PaymentIntent was not found.');
    return Promise.resolve(value);
  };
}

const providerEvent = (
  input: Partial<StripeWebhookEventValue> &
    Pick<StripeWebhookEventValue, 'eventId' | 'kind' | 'paymentIntentId' | 'providerObjectId'>,
): StripeWebhookEventValue => ({
  amountMinor: 2000n,
  createdAt: new Date('2026-08-30T12:00:00.000Z'),
  currency: 'USD',
  eventType: input.kind === 'payment_succeeded' ? 'payment_intent.succeeded' : input.kind,
  livemode: false,
  localFundingIntentId: null,
  providerStatus: 'succeeded',
  ...input,
});

const createUser = async (database: Database, label: string): Promise<UserId> => {
  const id = randomUUID() as UserId;
  await database.query(
    `insert into app.users (id, auth_provider, auth_subject, username)
     values ($1, 'synthetic-payment', $2, $3)`,
    [id, `${label}-${id}`, `payment_${id.replaceAll('-', '')}`],
  );
  return id;
};

describe('Stripe funding and provider accounting integration', { concurrent: false }, () => {
  let database: Database;

  beforeAll(() => {
    database = createDatabasePool({
      ...applicationEnvironment,
      onUnexpectedPoolError: (error) => {
        throw error;
      },
    });
  });

  afterAll(async () => {
    await database.close();
  });

  const createFunding = async (
    userId: UserId,
    provider: SyntheticStripeProvider,
    amountMinor = '2000',
    idempotencyKey = `funding_${randomUUID()}`,
  ) => {
    const service = createPaymentService({ database, enabled: true, logger, provider });
    const result = await service.createFundingIntent({
      amountMinor: parsePositiveMoneyMinor(amountMinor),
      currency: usd,
      idempotencyKey,
      requestId: randomUUID(),
      userId,
    });
    const intent = [...provider.intents.values()].at(-1);
    if (intent === undefined) throw new Error('Synthetic PaymentIntent was not created.');
    return { intent, result, service };
  };

  const settleFunding = async (
    provider: SyntheticStripeProvider,
    service: ReturnType<typeof createPaymentService>,
    intent: StripePaymentIntentValue,
    label: string,
  ): Promise<void> => {
    provider.event = providerEvent({
      eventId: `evt_${randomUUID().replaceAll('-', '')}`,
      kind: 'payment_succeeded',
      localFundingIntentId: intent.localFundingIntentId,
      paymentIntentId: intent.id,
      providerObjectId: intent.id,
    });
    await service.processStripeWebhook(
      Buffer.from(JSON.stringify({ label, type: 'payment_intent.succeeded' })),
      'synthetic',
      randomUUID(),
    );
  };

  it('enforces centralized USD limits and client-command idempotency', async () => {
    const userId = await createUser(database, 'limits');
    const provider = new SyntheticStripeProvider();
    const service = createPaymentService({ database, enabled: true, logger, provider });
    const command = (amountMinor: string, currency = usd, key = `funding_${randomUUID()}`) =>
      service.createFundingIntent({
        amountMinor: parsePositiveMoneyMinor(amountMinor),
        currency,
        idempotencyKey: key,
        requestId: randomUUID(),
        userId,
      });
    await expect(command('499')).rejects.toBeInstanceOf(FundingAmountOutOfRangeError);
    await expect(command('50001')).rejects.toBeInstanceOf(FundingAmountOutOfRangeError);
    await expect(command('500', parseCurrency('CAD'))).rejects.toBeInstanceOf(
      FundingAmountOutOfRangeError,
    );
    await expect(command('500')).resolves.toMatchObject({ amountMinor: '500', currency: 'USD' });
    await expect(command('50000')).resolves.toMatchObject({
      amountMinor: '50000',
      currency: 'USD',
    });
    const key = `funding_${randomUUID()}`;
    const first = await command('2000', usd, key);
    await expect(command('2000', usd, key)).resolves.toEqual(first);
    await expect(command('2001', usd, key)).rejects.toBeInstanceOf(IdempotencyKeyReusedError);
  });

  it('credits one balanced settlement only after a verified provider success', async () => {
    const userId = await createUser(database, 'settlement');
    const provider = new SyntheticStripeProvider();
    const { intent, service } = await createFunding(userId, provider);
    const before = await database.query<{ readonly balance: string }>(
      `select available_balance_minor::text as balance from app.wallets where user_id = $1`,
      [userId],
    );
    expect(before.rows[0]?.balance).toBe('0');

    provider.event = providerEvent({
      eventId: `evt_${randomUUID().replaceAll('-', '')}`,
      kind: 'payment_succeeded',
      localFundingIntentId: intent.localFundingIntentId,
      paymentIntentId: intent.id,
      providerObjectId: intent.id,
    });
    await service.processStripeWebhook(Buffer.from('{"verified":true}'), 'synthetic', randomUUID());

    const state = await database.query<{
      readonly balance: string;
      readonly entrySum: string;
      readonly events: number;
      readonly settlements: number;
    }>(
      `select wallet.available_balance_minor::text as balance,
              (select sum(entry.amount_minor)::text
                 from app.ledger_entries as entry
                 join app.ledger_transactions as transaction
                   on transaction.id = entry.ledger_transaction_id
                where transaction.kind = 'provider_funding_credit'
                  and transaction.actor_user_id = $1) as "entrySum",
              (select count(*)::int from app.provider_events
                where funding_intent_id = intent.id) as events,
              (select count(*)::int from app.funding_settlements
                where funding_intent_id = intent.id) as settlements
         from app.wallets as wallet
         join app.funding_intents as intent on intent.wallet_id = wallet.id
        where wallet.user_id = $1`,
      [userId],
    );
    expect(state.rows).toEqual([{ balance: '2000', entrySum: '0', events: 1, settlements: 1 }]);
  });

  it('serializes duplicate and distinct success events to one wallet credit', async () => {
    const userId = await createUser(database, 'duplicates');
    const provider = new SyntheticStripeProvider();
    const { intent, service } = await createFunding(userId, provider);
    const firstEvent = providerEvent({
      eventId: `evt_${randomUUID().replaceAll('-', '')}`,
      kind: 'payment_succeeded',
      localFundingIntentId: intent.localFundingIntentId,
      paymentIntentId: intent.id,
      providerObjectId: intent.id,
    });
    provider.event = firstEvent;
    await Promise.all([
      service.processStripeWebhook(Buffer.from('{"same":true}'), 'synthetic', randomUUID()),
      service.processStripeWebhook(Buffer.from('{"same":true}'), 'synthetic', randomUUID()),
    ]);
    provider.event = { ...firstEvent, eventId: `evt_${randomUUID().replaceAll('-', '')}` };
    await service.processStripeWebhook(
      Buffer.from('{"different":true}'),
      'synthetic',
      randomUUID(),
    );

    const result = await database.query<{
      readonly balance: string;
      readonly credits: number;
      readonly settlements: number;
    }>(
      `select wallet.available_balance_minor::text as balance,
              (select count(*)::int from app.ledger_transactions
                where kind = 'provider_funding_credit' and actor_user_id = $1) as credits,
              (select count(*)::int from app.funding_settlements as settlement
                join app.funding_intents as intent on intent.id = settlement.funding_intent_id
               where intent.user_id = $1) as settlements
         from app.wallets as wallet where wallet.user_id = $1 and wallet.currency = 'USD'`,
      [userId],
    );
    expect(result.rows).toEqual([{ balance: '2000', credits: 1, settlements: 1 }]);
  });

  it('rolls back provider event, ledger, settlement, and wallet state on mid-settlement failure', async () => {
    const userId = await createUser(database, 'rollback');
    const provider = new SyntheticStripeProvider();
    let calls = 0;
    let previous = '';
    const createId = (): string => {
      calls += 1;
      if (calls === 10) return previous;
      previous = randomUUID();
      return previous;
    };
    const service = createPaymentService({ createId, database, enabled: true, logger, provider });
    await service.createFundingIntent({
      amountMinor: parsePositiveMoneyMinor('2000'),
      currency: usd,
      idempotencyKey: `funding_${randomUUID()}`,
      requestId: randomUUID(),
      userId,
    });
    const intent = [...provider.intents.values()].at(-1);
    if (intent === undefined) throw new Error('Synthetic PaymentIntent was not created.');
    provider.event = providerEvent({
      eventId: `evt_${randomUUID().replaceAll('-', '')}`,
      kind: 'payment_succeeded',
      localFundingIntentId: intent.localFundingIntentId,
      paymentIntentId: intent.id,
      providerObjectId: intent.id,
    });
    const payload = Buffer.from('{"rollback":true}');
    await expect(
      service.processStripeWebhook(payload, 'synthetic', randomUUID()),
    ).rejects.toThrow();
    const rolledBack = await database.query<{
      readonly balance: string;
      readonly credits: number;
      readonly events: number;
      readonly settlements: number;
    }>(
      `select wallet.available_balance_minor::text as balance,
              (select count(*)::int from app.provider_events
                where funding_intent_id = intent.id) as events,
              (select count(*)::int from app.funding_settlements
                where funding_intent_id = intent.id) as settlements,
              (select count(*)::int from app.ledger_transactions
                where actor_user_id = $1 and kind = 'provider_funding_credit') as credits
         from app.wallets as wallet
         join app.funding_intents as intent on intent.wallet_id = wallet.id
        where intent.user_id = $1`,
      [userId],
    );
    expect(rolledBack.rows).toEqual([{ balance: '0', credits: 0, events: 0, settlements: 0 }]);
    await service.processStripeWebhook(payload, 'synthetic', randomUUID());
    const retried = await database.query<{
      readonly balance: string;
      readonly settlements: number;
    }>(
      `select wallet.available_balance_minor::text as balance,
              (select count(*)::int from app.funding_settlements as settlement
                join app.funding_intents as intent on intent.id = settlement.funding_intent_id
               where intent.user_id = $1) as settlements
         from app.wallets as wallet where wallet.user_id = $1`,
      [userId],
    );
    expect(retried.rows).toEqual([{ balance: '2000', settlements: 1 }]);
  });

  it('fails closed on amount mismatch without crediting the wallet', async () => {
    const userId = await createUser(database, 'mismatch');
    const provider = new SyntheticStripeProvider();
    const { intent, service } = await createFunding(userId, provider);
    provider.event = providerEvent({
      amountMinor: 1999n,
      eventId: `evt_${randomUUID().replaceAll('-', '')}`,
      kind: 'payment_succeeded',
      localFundingIntentId: intent.localFundingIntentId,
      paymentIntentId: intent.id,
      providerObjectId: intent.id,
    });
    await service.processStripeWebhook(Buffer.from('{"mismatch":true}'), 'synthetic', randomUUID());
    const result = await database.query<{ readonly balance: string; readonly status: string }>(
      `select wallet.available_balance_minor::text as balance, intent.status
         from app.wallets as wallet
         join app.funding_intents as intent on intent.wallet_id = wallet.id
        where intent.user_id = $1`,
      [userId],
    );
    expect(result.rows).toEqual([{ balance: '0', status: 'reconciliation_required' }]);
  });

  it('rejects orphan provider credits and generic reversal under the application role', async () => {
    const userId = await createUser(database, 'database-guards');
    const provider = new SyntheticStripeProvider();
    const { intent, service } = await createFunding(userId, provider);
    provider.event = providerEvent({
      eventId: `evt_${randomUUID().replaceAll('-', '')}`,
      kind: 'payment_succeeded',
      localFundingIntentId: intent.localFundingIntentId,
      paymentIntentId: intent.id,
      providerObjectId: intent.id,
    });
    await service.processStripeWebhook(Buffer.from('{"guard":true}'), 'synthetic', randomUUID());
    const state = await database.query<{
      readonly clearingAccountId: string;
      readonly ledgerTransactionId: string;
      readonly walletAccountId: string;
      readonly walletId: string;
    }>(
      `select wallet.id::text as "walletId",
              wallet.ledger_account_id::text as "walletAccountId",
              (select id::text from app.ledger_accounts
                where account_type = 'provider_funding_clearing' and currency = 'USD')
                as "clearingAccountId",
              (select id::text from app.ledger_transactions
                where actor_user_id = $1 and kind = 'provider_funding_credit')
                as "ledgerTransactionId"
         from app.wallets as wallet where wallet.user_id = $1`,
      [userId],
    );
    const row = state.rows[0];
    if (row === undefined) throw new Error('Provider funding guard fixture is incomplete.');
    await expect(
      database.transaction((transaction) =>
        insertLedgerTransaction(transaction, {
          actorUserId: userId,
          businessReferenceId: randomUUID(),
          businessReferenceType: 'forbidden_generic_reversal',
          currency: usd,
          description: 'Forbidden provider credit reversal',
          id: randomUUID() as LedgerTransactionId,
          idempotencyRecordId: null,
          kind: 'reversal',
          reversesLedgerTransactionId: row.ledgerTransactionId as LedgerTransactionId,
        }),
      ),
    ).rejects.toMatchObject({ constraint: 'controlled_financial_reversal_required' });

    await expect(
      database.transaction(async (transaction) => {
        const transactionId = randomUUID() as LedgerTransactionId;
        await insertLedgerTransaction(transaction, {
          actorUserId: userId,
          businessReferenceId: randomUUID(),
          businessReferenceType: 'funding_settlement',
          currency: usd,
          description: 'Orphan provider credit probe',
          id: transactionId,
          idempotencyRecordId: null,
          kind: 'provider_funding_credit',
          reversesLedgerTransactionId: null,
        });
        await insertLedgerEntries(transaction, transactionId, [
          {
            amountMinor: toMoneyMinor(1n),
            currency: usd,
            id: randomUUID() as LedgerEntryId,
            ledgerAccountId: row.walletAccountId as LedgerAccountId,
            sequence: 0,
          },
          {
            amountMinor: toMoneyMinor(-1n),
            currency: usd,
            id: randomUUID() as LedgerEntryId,
            ledgerAccountId: row.clearingAccountId as LedgerAccountId,
            sequence: 1,
          },
        ]);
        await applyWalletDelta(transaction, row.walletId as WalletId, toMoneyMinor(1n));
        await finalizeLedgerTransaction(transaction, transactionId);
      }),
    ).rejects.toMatchObject({ constraint: 'provider_funding_settlement_link_invalid' });
    const balance = await database.query<{ readonly value: string }>(
      `select available_balance_minor::text as value from app.wallets where user_id = $1`,
      [userId],
    );
    expect(balance.rows[0]?.value).toBe('2000');
  });

  it('retries reordered refund delivery and posts one controlled compensation', async () => {
    const userId = await createUser(database, 'reordered-refund');
    const provider = new SyntheticStripeProvider();
    const { intent, service } = await createFunding(userId, provider);
    const refund = providerEvent({
      amountMinor: 500n,
      eventId: `evt_${randomUUID().replaceAll('-', '')}`,
      eventType: 'refund.updated',
      kind: 'provider_refund',
      paymentIntentId: intent.id,
      providerObjectId: `re_${randomUUID().replaceAll('-', '')}`,
    });
    provider.event = refund;
    await expect(
      service.processStripeWebhook(Buffer.from('{"refund":true}'), 'synthetic', randomUUID()),
    ).rejects.toBeInstanceOf(FundingEventRetryRequiredError);

    provider.event = providerEvent({
      eventId: `evt_${randomUUID().replaceAll('-', '')}`,
      kind: 'payment_succeeded',
      localFundingIntentId: intent.localFundingIntentId,
      paymentIntentId: intent.id,
      providerObjectId: intent.id,
    });
    await service.processStripeWebhook(Buffer.from('{"settled":true}'), 'synthetic', randomUUID());
    provider.event = refund;
    await service.processStripeWebhook(Buffer.from('{"refund":true}'), 'synthetic', randomUUID());
    await service.processStripeWebhook(Buffer.from('{"refund":true}'), 'synthetic', randomUUID());

    const result = await database.query<{
      readonly adjustments: number;
      readonly balance: string;
      readonly originalCredits: number;
    }>(
      `select wallet.available_balance_minor::text as balance,
              (select count(*)::int from app.funding_adjustments as adjustment
                join app.funding_settlements as settlement
                  on settlement.id = adjustment.funding_settlement_id
               where settlement.funding_intent_id = intent.id) as adjustments,
              (select count(*)::int from app.ledger_transactions
                where actor_user_id = $1 and kind = 'provider_funding_credit') as "originalCredits"
         from app.wallets as wallet
         join app.funding_intents as intent on intent.wallet_id = wallet.id
        where intent.user_id = $1`,
      [userId],
    );
    expect(result.rows).toEqual([{ adjustments: 1, balance: '1500', originalCredits: 1 }]);
  });

  it('detects provider/local reconciliation drift without mutating financial history', async () => {
    const userId = await createUser(database, 'reconciliation');
    const provider = new SyntheticStripeProvider();
    const { intent, service } = await createFunding(userId, provider);
    provider.intents.set(intent.id, { ...intent, status: 'succeeded' });
    const internal = await database.query<{ readonly id: string }>(
      `select id::text as id from app.funding_intents where user_id = $1`,
      [userId],
    );
    const internalId = internal.rows[0]?.id;
    if (internalId === undefined) throw new Error('Funding intent was not persisted.');
    const result = await service.reconcileFundingIntent(internalId as FundingIntentId);
    expect(result.issues).toEqual(['PROVIDER_SETTLED_WITHOUT_LEDGER_SETTLEMENT']);
    const wallet = await database.query<{ readonly balance: string }>(
      `select available_balance_minor::text as balance from app.wallets where user_id = $1`,
      [userId],
    );
    expect(wallet.rows[0]?.balance).toBe('0');
  });

  it('records refund/dispute compensation once and creates a separate deficit', async () => {
    const userId = await createUser(database, 'adjustments');
    const provider = new SyntheticStripeProvider();
    const { intent, service } = await createFunding(userId, provider, '10000');
    provider.event = providerEvent({
      amountMinor: 10000n,
      eventId: `evt_${randomUUID().replaceAll('-', '')}`,
      kind: 'payment_succeeded',
      localFundingIntentId: intent.localFundingIntentId,
      paymentIntentId: intent.id,
      providerObjectId: intent.id,
    });
    await service.processStripeWebhook(Buffer.from('{"settled":true}'), 'synthetic', randomUUID());

    let counterpartyAccountId: LedgerAccountId | undefined;
    await database.transaction(async (transaction) => {
      const counterparty = await ensureSystemTestFundingAccount(transaction, {
        accountId: randomUUID() as LedgerAccountId,
        currency: usd,
      });
      counterpartyAccountId = counterparty.id;
      await debitWallet(transaction, {
        actorUserId: userId,
        amountMinor: parsePositiveMoneyMinor('8000'),
        businessReferenceId: randomUUID(),
        businessReferenceType: 'synthetic-spend',
        counterpartyAccountId: counterparty.id,
        currency: usd,
        description: 'Synthetic pre-dispute spend',
        idempotencyRecordId: null,
      });
    });

    const dispute = providerEvent({
      amountMinor: 10000n,
      eventId: `evt_${randomUUID().replaceAll('-', '')}`,
      eventType: 'charge.dispute.created',
      kind: 'provider_dispute',
      paymentIntentId: intent.id,
      providerObjectId: `dp_${randomUUID().replaceAll('-', '')}`,
      providerStatus: 'needs_response',
    });
    provider.event = dispute;
    await service.processStripeWebhook(Buffer.from('{"dispute":true}'), 'synthetic', randomUUID());
    await service.processStripeWebhook(Buffer.from('{"dispute":true}'), 'synthetic', randomUUID());

    const result = await database.query<{
      readonly adjustments: number;
      readonly balance: string;
      readonly deficit: string;
      readonly status: string;
    }>(
      `select wallet.available_balance_minor::text as balance, intent.status,
              (select count(*)::int from app.funding_adjustments as adjustment
                join app.funding_settlements as settlement
                  on settlement.id = adjustment.funding_settlement_id
               where settlement.funding_intent_id = intent.id) as adjustments,
              (select sum(amount_minor)::text from app.funding_deficits
                where user_id = $1 and status = 'unresolved') as deficit
         from app.wallets as wallet
         join app.funding_intents as intent on intent.wallet_id = wallet.id
        where intent.user_id = $1`,
      [userId],
    );
    expect(result.rows).toEqual([
      { adjustments: 1, balance: '0', deficit: '8000', status: 'reversed' },
    ]);
    if (counterpartyAccountId === undefined)
      throw new Error('Counterparty account was not created.');
    const establishedCounterpartyAccountId = counterpartyAccountId;
    await expect(
      database.transaction((transaction) =>
        debitWallet(transaction, {
          actorUserId: userId,
          amountMinor: parsePositiveMoneyMinor('1'),
          businessReferenceId: randomUUID(),
          businessReferenceType: 'blocked-spend',
          counterpartyAccountId: establishedCounterpartyAccountId,
          currency: usd,
          description: 'Blocked synthetic spend',
          idempotencyRecordId: null,
        }),
      ),
    ).rejects.toBeInstanceOf(AccountFundingRestrictedError);
  });

  it('retains a distinct late success after reversal without crediting or regressing state', async () => {
    const userId = await createUser(database, 'late-success');
    const provider = new SyntheticStripeProvider();
    const { intent, service } = await createFunding(userId, provider);
    await settleFunding(provider, service, intent, 'initial-settlement');

    provider.event = providerEvent({
      amountMinor: 2000n,
      createdAt: new Date('2026-08-30T12:01:00.000Z'),
      eventId: `evt_${randomUUID().replaceAll('-', '')}`,
      eventType: 'refund.updated',
      kind: 'provider_refund',
      paymentIntentId: intent.id,
      providerObjectId: `re_${randomUUID().replaceAll('-', '')}`,
    });
    await service.processStripeWebhook(Buffer.from('{"refund":"full"}'), 'synthetic', randomUUID());

    const lateEventId = `evt_${randomUUID().replaceAll('-', '')}`;
    provider.event = providerEvent({
      createdAt: new Date('2026-08-30T12:02:00.000Z'),
      eventId: lateEventId,
      kind: 'payment_succeeded',
      localFundingIntentId: intent.localFundingIntentId,
      paymentIntentId: intent.id,
      providerObjectId: intent.id,
    });
    const latePayload = Buffer.from('{"success":"late"}');
    await service.processStripeWebhook(latePayload, 'synthetic', randomUUID());
    await service.processStripeWebhook(latePayload, 'synthetic', randomUUID());

    const state = await database.query<{
      readonly adjustments: number;
      readonly balance: string;
      readonly credits: number;
      readonly lateEvents: number;
      readonly settlements: number;
      readonly status: string;
    }>(
      `select intent.status, wallet.available_balance_minor::text as balance,
              (select count(*)::int from app.funding_settlements
                where funding_intent_id = intent.id) as settlements,
              (select count(*)::int from app.funding_adjustments as adjustment
                join app.funding_settlements as settlement
                  on settlement.id = adjustment.funding_settlement_id
               where settlement.funding_intent_id = intent.id) as adjustments,
              (select count(*)::int from app.ledger_transactions
                where actor_user_id = $1 and kind = 'provider_funding_credit') as credits,
              (select count(*)::int from app.provider_events
                where provider_event_id = $2 and funding_intent_id = intent.id
                  and status = 'processed' and result_code = 'DUPLICATE_SUCCESS') as "lateEvents"
         from app.funding_intents as intent
         join app.wallets as wallet on wallet.id = intent.wallet_id
        where intent.user_id = $1`,
      [userId, lateEventId],
    );
    expect(state.rows).toEqual([
      {
        adjustments: 1,
        balance: '0',
        credits: 1,
        lateEvents: 1,
        settlements: 1,
        status: 'reversed',
      },
    ]);
  });

  it('derives aggregate reversal state independently of provider event order', async () => {
    const userId = await createUser(database, 'reordered-aggregate');
    const provider = new SyntheticStripeProvider();
    const { intent, service } = await createFunding(userId, provider);
    await settleFunding(provider, service, intent, 'aggregate-settlement');

    for (const [label, createdAt] of [
      ['newer', '2026-08-30T12:02:00.000Z'],
      ['older', '2026-08-30T12:01:00.000Z'],
    ] as const) {
      provider.event = providerEvent({
        amountMinor: 1000n,
        createdAt: new Date(createdAt),
        eventId: `evt_${randomUUID().replaceAll('-', '')}`,
        eventType: 'refund.updated',
        kind: 'provider_refund',
        paymentIntentId: intent.id,
        providerObjectId: `re_${randomUUID().replaceAll('-', '')}`,
      });
      await service.processStripeWebhook(
        Buffer.from(JSON.stringify({ refund: label })),
        'synthetic',
        randomUUID(),
      );
    }
    provider.intents.set(intent.id, { ...intent, status: 'succeeded' });

    const internal = await database.query<{ readonly id: string }>(
      `select id::text as id from app.funding_intents where user_id = $1`,
      [userId],
    );
    const internalId = internal.rows[0]?.id;
    if (internalId === undefined) throw new Error('Aggregate funding intent was not persisted.');
    await expect(
      service.reconcileFundingIntent(internalId as FundingIntentId),
    ).resolves.toMatchObject({
      issues: [],
    });
    const state = await database.query<{
      readonly adjusted: string;
      readonly balance: string;
      readonly deficit: string;
      readonly status: string;
    }>(
      `select intent.status, wallet.available_balance_minor::text as balance,
              (select coalesce(sum(adjustment.amount_minor), 0)::text
                 from app.funding_adjustments as adjustment
                 join app.funding_settlements as settlement
                   on settlement.id = adjustment.funding_settlement_id
                where settlement.funding_intent_id = intent.id) as adjusted,
              (select coalesce(sum(amount_minor), 0)::text from app.funding_deficits
                where user_id = $1 and status = 'unresolved') as deficit
         from app.funding_intents as intent
         join app.wallets as wallet on wallet.id = intent.wallet_id
        where intent.user_id = $1`,
      [userId],
    );
    expect(state.rows).toEqual([
      { adjusted: '2000', balance: '0', deficit: '0', status: 'reversed' },
    ]);
  });

  it('retains a verified mismatch for an unbound intent without wallet credit', async () => {
    const userId = await createUser(database, 'unbound-mismatch');
    const provider = new SyntheticStripeProvider();
    provider.createAmountOverride = 1999n;
    const service = createPaymentService({ database, enabled: true, logger, provider });
    await expect(
      service.createFundingIntent({
        amountMinor: parsePositiveMoneyMinor('2000'),
        currency: usd,
        idempotencyKey: `funding_${randomUUID()}`,
        requestId: randomUUID(),
        userId,
      }),
    ).rejects.toBeInstanceOf(FundingProviderUnavailableError);
    const providerIntent = [...provider.intents.values()].at(-1);
    if (providerIntent?.localFundingIntentId === null || providerIntent === undefined) {
      throw new Error('The mismatched provider intent was not created.');
    }
    const eventId = `evt_${randomUUID().replaceAll('-', '')}`;
    provider.event = providerEvent({
      amountMinor: 1999n,
      eventId,
      kind: 'payment_succeeded',
      localFundingIntentId: providerIntent.localFundingIntentId,
      paymentIntentId: providerIntent.id,
      providerObjectId: providerIntent.id,
    });
    const payload = Buffer.from('{"success":"mismatched"}');
    await service.processStripeWebhook(payload, 'synthetic', randomUUID());
    await service.processStripeWebhook(payload, 'synthetic', randomUUID());

    const state = await database.query<{
      readonly balance: string;
      readonly events: number;
      readonly eventObjectId: string;
      readonly providerPaymentIntentId: string | null;
      readonly status: string;
    }>(
      `select intent.status,
              intent.provider_payment_intent_id as "providerPaymentIntentId",
              wallet.available_balance_minor::text as balance,
              count(event.id)::int as events,
              max(event.provider_object_id) as "eventObjectId"
         from app.funding_intents as intent
         join app.wallets as wallet on wallet.id = intent.wallet_id
         join app.provider_events as event on event.funding_intent_id = intent.id
        where intent.user_id = $1 and event.provider_event_id = $2
          and event.status = 'processed' and event.result_code = 'RECONCILIATION_REQUIRED'
        group by intent.status, intent.provider_payment_intent_id,
                 wallet.available_balance_minor`,
      [userId, eventId],
    );
    expect(state.rows).toEqual([
      {
        balance: '0',
        eventObjectId: providerIntent.id,
        events: 1,
        providerPaymentIntentId: null,
        status: 'reconciliation_required',
      },
    ]);
  });

  it('rejects a settlement whose provider event has null business linkage', async () => {
    const userId = await createUser(database, 'null-provider-link');
    const provider = new SyntheticStripeProvider();
    const { intent } = await createFunding(userId, provider);
    const fixture = await database.query<{
      readonly fundingIntentId: string;
      readonly requestedAmountMinor: string;
      readonly walletAccountId: string;
      readonly walletId: string;
    }>(
      `select intent.id::text as "fundingIntentId",
              intent.requested_amount_minor::text as "requestedAmountMinor",
              wallet.id::text as "walletId",
              wallet.ledger_account_id::text as "walletAccountId"
         from app.funding_intents as intent
         join app.wallets as wallet on wallet.id = intent.wallet_id
        where intent.user_id = $1`,
      [userId],
    );
    const row = fixture.rows[0];
    if (row === undefined) throw new Error('Null-link settlement fixture is missing.');

    await expect(
      database.transaction(async (transaction) => {
        const clearing = await ensureProviderFundingLedgerAccount(transaction, {
          accountId: randomUUID() as LedgerAccountId,
          accountType: 'provider_funding_clearing',
          currency: usd,
          userId: null,
        });
        const providerEventId = randomUUID();
        const settlementId = randomUUID();
        const ledgerTransactionId = randomUUID() as LedgerTransactionId;
        await transaction.query(
          `insert into app.provider_events (
             id, provider, provider_event_id, event_type, provider_object_id,
             funding_intent_id, payload_sha256, provider_created_at
           ) values ($1, 'stripe', $2, 'payment_intent.succeeded', null,
                     null, decode(repeat('71', 32), 'hex'), clock_timestamp())`,
          [providerEventId, `evt_${randomUUID().replaceAll('-', '')}`],
        );
        await transaction.query(
          `update app.provider_events
              set status = 'processed', result_code = 'SETTLED', processed_at = clock_timestamp()
            where id = $1`,
          [providerEventId],
        );
        await transaction.query(
          `update app.funding_intents
              set status = 'settled', last_provider_event_created_at = clock_timestamp(),
                  updated_at = clock_timestamp()
            where id = $1`,
          [row.fundingIntentId],
        );
        await insertLedgerTransaction(transaction, {
          actorUserId: userId,
          businessReferenceId: settlementId,
          businessReferenceType: 'funding_settlement',
          currency: usd,
          description: 'Null provider linkage probe',
          id: ledgerTransactionId,
          idempotencyRecordId: null,
          kind: 'provider_funding_credit',
          reversesLedgerTransactionId: null,
        });
        await insertLedgerEntries(transaction, ledgerTransactionId, [
          {
            amountMinor: toMoneyMinor(BigInt(row.requestedAmountMinor)),
            currency: usd,
            id: randomUUID() as LedgerEntryId,
            ledgerAccountId: row.walletAccountId as LedgerAccountId,
            sequence: 0,
          },
          {
            amountMinor: toMoneyMinor(-BigInt(row.requestedAmountMinor)),
            currency: usd,
            id: randomUUID() as LedgerEntryId,
            ledgerAccountId: clearing.id,
            sequence: 1,
          },
        ]);
        await applyWalletDelta(
          transaction,
          row.walletId as WalletId,
          toMoneyMinor(BigInt(row.requestedAmountMinor)),
        );
        await finalizeLedgerTransaction(transaction, ledgerTransactionId);
        await transaction.query(
          `insert into app.funding_settlements (
             id, funding_intent_id, provider_event_id, provider,
             provider_payment_intent_id, ledger_transaction_id,
             settled_amount_minor, currency
           ) values ($1, $2, $3, 'stripe', $4, $5, $6, 'USD')`,
          [
            settlementId,
            row.fundingIntentId,
            providerEventId,
            intent.id,
            ledgerTransactionId,
            row.requestedAmountMinor,
          ],
        );
      }),
    ).rejects.toMatchObject({ constraint: 'provider_funding_settlement_link_invalid' });
    const unchanged = await database.query<{
      readonly balance: string;
      readonly settlements: number;
    }>(
      `select wallet.available_balance_minor::text as balance,
              (select count(*)::int from app.funding_settlements
                where funding_intent_id = intent.id) as settlements
         from app.funding_intents as intent
         join app.wallets as wallet on wallet.id = intent.wallet_id
        where intent.user_id = $1`,
      [userId],
    );
    expect(unchanged.rows).toEqual([{ balance: '0', settlements: 0 }]);
  });

  it('rejects a cross-currency provider adjustment under the application role', async () => {
    const userId = await createUser(database, 'cross-currency-adjustment');
    const provider = new SyntheticStripeProvider();
    const { intent, service } = await createFunding(userId, provider);
    await settleFunding(provider, service, intent, 'cross-currency-settlement');
    const fixture = await database.query<{
      readonly fundingIntentId: string;
      readonly settlementId: string;
    }>(
      `select intent.id::text as "fundingIntentId", settlement.id::text as "settlementId"
         from app.funding_intents as intent
         join app.funding_settlements as settlement on settlement.funding_intent_id = intent.id
        where intent.user_id = $1`,
      [userId],
    );
    const row = fixture.rows[0];
    if (row === undefined) throw new Error('Cross-currency adjustment fixture is missing.');
    const cad = parseCurrency('CAD');

    await expect(
      database.transaction(async (transaction) => {
        const clearing = await ensureProviderFundingLedgerAccount(transaction, {
          accountId: randomUUID() as LedgerAccountId,
          accountType: 'provider_funding_clearing',
          currency: cad,
          userId: null,
        });
        const deficit = await ensureProviderFundingLedgerAccount(transaction, {
          accountId: randomUUID() as LedgerAccountId,
          accountType: 'user_funding_deficit',
          currency: cad,
          userId,
        });
        const adjustmentId = randomUUID();
        const providerEventId = randomUUID();
        const providerAdjustmentId = `re_${randomUUID().replaceAll('-', '')}`;
        const ledgerTransactionId = randomUUID() as LedgerTransactionId;
        await transaction.query(
          `insert into app.provider_events (
             id, provider, provider_event_id, event_type, provider_object_id,
             funding_intent_id, payload_sha256, provider_created_at
           ) values ($1, 'stripe', $2, 'refund.updated', $3,
                     $4, decode(repeat('72', 32), 'hex'), clock_timestamp())`,
          [
            providerEventId,
            `evt_${randomUUID().replaceAll('-', '')}`,
            providerAdjustmentId,
            row.fundingIntentId,
          ],
        );
        await transaction.query(
          `update app.provider_events
              set status = 'processed', result_code = 'ADJUSTMENT_RECORDED',
                  processed_at = clock_timestamp()
            where id = $1`,
          [providerEventId],
        );
        await insertLedgerTransaction(transaction, {
          actorUserId: userId,
          businessReferenceId: adjustmentId,
          businessReferenceType: 'funding_adjustment',
          currency: cad,
          description: 'Cross-currency provider refund probe',
          id: ledgerTransactionId,
          idempotencyRecordId: null,
          kind: 'provider_funding_refund',
          reversesLedgerTransactionId: null,
        });
        await insertLedgerEntries(transaction, ledgerTransactionId, [
          {
            amountMinor: toMoneyMinor(500n),
            currency: cad,
            id: randomUUID() as LedgerEntryId,
            ledgerAccountId: clearing.id,
            sequence: 0,
          },
          {
            amountMinor: toMoneyMinor(-500n),
            currency: cad,
            id: randomUUID() as LedgerEntryId,
            ledgerAccountId: deficit.id,
            sequence: 1,
          },
        ]);
        await finalizeLedgerTransaction(transaction, ledgerTransactionId);
        await transaction.query(
          `insert into app.funding_adjustments (
             id, funding_settlement_id, provider_event_id, provider,
             provider_adjustment_id, adjustment_type, ledger_transaction_id,
             amount_minor, wallet_recovered_minor, deficit_minor, currency
           ) values ($1, $2, $3, 'stripe', $4, 'refund', $5, 500, 0, 500, 'CAD')`,
          [
            adjustmentId,
            row.settlementId,
            providerEventId,
            providerAdjustmentId,
            ledgerTransactionId,
          ],
        );
        await transaction.query(
          `insert into app.funding_deficits (
             id, funding_adjustment_id, user_id, ledger_account_id, currency, amount_minor
           ) values ($1, $2, $3, $4, 'CAD', 500)`,
          [randomUUID(), adjustmentId, userId, deficit.id],
        );
      }),
    ).rejects.toMatchObject({ constraint: 'provider_funding_adjustment_link_invalid' });
  });

  it('enforces exact bidirectional deficit lineage for provider adjustments', async () => {
    const zeroDeficitUserId = await createUser(database, 'zero-deficit-lineage');
    const zeroDeficitProvider = new SyntheticStripeProvider();
    const zeroDeficitFunding = await createFunding(zeroDeficitUserId, zeroDeficitProvider);
    await settleFunding(
      zeroDeficitProvider,
      zeroDeficitFunding.service,
      zeroDeficitFunding.intent,
      'zero-deficit-settlement',
    );
    zeroDeficitProvider.event = providerEvent({
      amountMinor: 500n,
      eventId: `evt_${randomUUID().replaceAll('-', '')}`,
      eventType: 'refund.updated',
      kind: 'provider_refund',
      paymentIntentId: zeroDeficitFunding.intent.id,
      providerObjectId: `re_${randomUUID().replaceAll('-', '')}`,
    });
    await zeroDeficitFunding.service.processStripeWebhook(
      Buffer.from('{"refund":"zero-deficit"}'),
      'synthetic',
      randomUUID(),
    );
    const zeroAdjustment = await database.query<{ readonly id: string }>(
      `select adjustment.id::text as id
         from app.funding_adjustments as adjustment
         join app.funding_settlements as settlement
           on settlement.id = adjustment.funding_settlement_id
         join app.funding_intents as intent on intent.id = settlement.funding_intent_id
        where intent.user_id = $1`,
      [zeroDeficitUserId],
    );
    const zeroAdjustmentId = zeroAdjustment.rows[0]?.id;
    if (zeroAdjustmentId === undefined) throw new Error('Zero-deficit adjustment is missing.');
    const unrelatedUserId = await createUser(database, 'unrelated-deficit');
    await expect(
      database.transaction(async (transaction) => {
        const unrelatedAccount = await ensureProviderFundingLedgerAccount(transaction, {
          accountId: randomUUID() as LedgerAccountId,
          accountType: 'user_funding_deficit',
          currency: usd,
          userId: unrelatedUserId,
        });
        await transaction.query(
          `insert into app.funding_deficits (
             id, funding_adjustment_id, user_id, ledger_account_id, currency, amount_minor
           ) values ($1, $2, $3, $4, 'USD', 999)`,
          [randomUUID(), zeroAdjustmentId, unrelatedUserId, unrelatedAccount.id],
        );
      }),
    ).rejects.toMatchObject({ constraint: 'provider_funding_deficit_link_invalid' });

    const deficitUserId = await createUser(database, 'required-deficit-lineage');
    const deficitProvider = new SyntheticStripeProvider();
    const deficitFunding = await createFunding(deficitUserId, deficitProvider);
    await settleFunding(
      deficitProvider,
      deficitFunding.service,
      deficitFunding.intent,
      'required-deficit-settlement',
    );
    let counterpartyId: LedgerAccountId | undefined;
    await database.transaction(async (transaction) => {
      const counterparty = await ensureSystemTestFundingAccount(transaction, {
        accountId: randomUUID() as LedgerAccountId,
        currency: usd,
      });
      counterpartyId = counterparty.id;
      await debitWallet(transaction, {
        actorUserId: deficitUserId,
        amountMinor: parsePositiveMoneyMinor('2000'),
        businessReferenceId: randomUUID(),
        businessReferenceType: 'deficit-lineage-spend',
        counterpartyAccountId: counterparty.id,
        currency: usd,
        description: 'Spend before deficit linkage probes',
        idempotencyRecordId: null,
      });
    });
    if (counterpartyId === undefined) throw new Error('Deficit counterparty account is missing.');
    const deficitFixture = await database.query<{
      readonly fundingIntentId: string;
      readonly settlementId: string;
    }>(
      `select intent.id::text as "fundingIntentId", settlement.id::text as "settlementId"
         from app.funding_intents as intent
         join app.funding_settlements as settlement on settlement.funding_intent_id = intent.id
        where intent.user_id = $1`,
      [deficitUserId],
    );
    const deficitRow = deficitFixture.rows[0];
    if (deficitRow === undefined) throw new Error('Required-deficit settlement is missing.');

    const attemptDeficit = async (
      shape: 'correct-and-duplicate' | 'missing' | 'wrong-amount' | 'wrong-currency' | 'wrong-user',
    ): Promise<void> => {
      await database.transaction(async (transaction) => {
        const clearing = await ensureProviderFundingLedgerAccount(transaction, {
          accountId: randomUUID() as LedgerAccountId,
          accountType: 'provider_funding_clearing',
          currency: usd,
          userId: null,
        });
        const deficitAccount = await ensureProviderFundingLedgerAccount(transaction, {
          accountId: randomUUID() as LedgerAccountId,
          accountType: 'user_funding_deficit',
          currency: usd,
          userId: deficitUserId,
        });
        const adjustmentId = randomUUID();
        const providerEventId = randomUUID();
        const providerAdjustmentId = `re_${randomUUID().replaceAll('-', '')}`;
        const ledgerTransactionId = randomUUID() as LedgerTransactionId;
        await transaction.query(
          `insert into app.provider_events (
             id, provider, provider_event_id, event_type, provider_object_id,
             funding_intent_id, payload_sha256, provider_created_at
           ) values ($1, 'stripe', $2, 'refund.updated', $3,
                     $4, decode(repeat('73', 32), 'hex'), clock_timestamp())`,
          [
            providerEventId,
            `evt_${randomUUID().replaceAll('-', '')}`,
            providerAdjustmentId,
            deficitRow.fundingIntentId,
          ],
        );
        await transaction.query(
          `update app.provider_events
              set status = 'processed', result_code = 'ADJUSTMENT_RECORDED',
                  processed_at = clock_timestamp()
            where id = $1`,
          [providerEventId],
        );
        await insertLedgerTransaction(transaction, {
          actorUserId: deficitUserId,
          businessReferenceId: adjustmentId,
          businessReferenceType: 'funding_adjustment',
          currency: usd,
          description: 'Deficit lineage probe',
          id: ledgerTransactionId,
          idempotencyRecordId: null,
          kind: 'provider_funding_refund',
          reversesLedgerTransactionId: null,
        });
        await insertLedgerEntries(transaction, ledgerTransactionId, [
          {
            amountMinor: toMoneyMinor(1000n),
            currency: usd,
            id: randomUUID() as LedgerEntryId,
            ledgerAccountId: clearing.id,
            sequence: 0,
          },
          {
            amountMinor: toMoneyMinor(-1000n),
            currency: usd,
            id: randomUUID() as LedgerEntryId,
            ledgerAccountId: deficitAccount.id,
            sequence: 1,
          },
        ]);
        await finalizeLedgerTransaction(transaction, ledgerTransactionId);
        await transaction.query(
          `insert into app.funding_adjustments (
             id, funding_settlement_id, provider_event_id, provider,
             provider_adjustment_id, adjustment_type, ledger_transaction_id,
             amount_minor, wallet_recovered_minor, deficit_minor, currency
           ) values ($1, $2, $3, 'stripe', $4, 'refund', $5, 1000, 0, 1000, 'USD')`,
          [
            adjustmentId,
            deficitRow.settlementId,
            providerEventId,
            providerAdjustmentId,
            ledgerTransactionId,
          ],
        );
        if (shape === 'missing') return;
        await transaction.query(
          `insert into app.funding_deficits (
             id, funding_adjustment_id, user_id, ledger_account_id, currency, amount_minor
           ) values ($1, $2, $3, $4, $5, $6)`,
          [
            randomUUID(),
            adjustmentId,
            shape === 'wrong-user' ? unrelatedUserId : deficitUserId,
            deficitAccount.id,
            shape === 'wrong-currency' ? 'CAD' : 'USD',
            shape === 'wrong-amount' ? '999' : '1000',
          ],
        );
        if (shape === 'correct-and-duplicate') {
          await transaction.query(
            `insert into app.funding_deficits (
               id, funding_adjustment_id, user_id, ledger_account_id, currency, amount_minor
             ) values ($1, $2, $3, $4, 'USD', 1000)`,
            [randomUUID(), adjustmentId, deficitUserId, deficitAccount.id],
          );
        }
      });
    };

    for (const shape of ['missing', 'wrong-amount', 'wrong-currency', 'wrong-user'] as const) {
      await expect(attemptDeficit(shape)).rejects.toMatchObject({
        constraint: 'provider_funding_deficit_link_invalid',
      });
    }
    await expect(attemptDeficit('correct-and-duplicate')).rejects.toMatchObject({ code: '23505' });
  });

  it('scopes provider wallet recovery so ordinary debits cannot bypass a deficit', async () => {
    const userId = await createUser(database, 'scoped-provider-recovery');
    const provider = new SyntheticStripeProvider();
    const { intent, service } = await createFunding(userId, provider);
    await settleFunding(provider, service, intent, 'scoped-recovery-settlement');
    let counterpartyAccountId: LedgerAccountId | undefined;
    await database.transaction(async (transaction) => {
      const counterparty = await ensureSystemTestFundingAccount(transaction, {
        accountId: randomUUID() as LedgerAccountId,
        currency: usd,
      });
      counterpartyAccountId = counterparty.id;
      await debitWallet(transaction, {
        actorUserId: userId,
        amountMinor: parsePositiveMoneyMinor('1000'),
        businessReferenceId: randomUUID(),
        businessReferenceType: 'scoped-recovery-spend',
        counterpartyAccountId: counterparty.id,
        currency: usd,
        description: 'Spend before provider recovery',
        idempotencyRecordId: null,
      });
    });
    if (counterpartyAccountId === undefined) throw new Error('Recovery counterparty is missing.');
    const establishedCounterpartyAccountId = counterpartyAccountId;
    provider.event = providerEvent({
      amountMinor: 2000n,
      eventId: `evt_${randomUUID().replaceAll('-', '')}`,
      eventType: 'charge.dispute.created',
      kind: 'provider_dispute',
      paymentIntentId: intent.id,
      providerObjectId: `dp_${randomUUID().replaceAll('-', '')}`,
    });
    await service.processStripeWebhook(
      Buffer.from('{"dispute":"scoped"}'),
      'synthetic',
      randomUUID(),
    );

    await database.transaction(async (transaction) => {
      await creditWallet(transaction, {
        actorUserId: userId,
        amountMinor: parsePositiveMoneyMinor('10'),
        businessReferenceId: randomUUID(),
        businessReferenceType: 'post-deficit-credit',
        counterpartyAccountId: establishedCounterpartyAccountId,
        currency: usd,
        description: 'Synthetic balance after deficit',
        idempotencyRecordId: null,
        kind: 'wallet_credit',
      });
    });
    const wallet = await database.query<{
      readonly accountId: string;
      readonly balance: string;
      readonly id: string;
    }>(
      `select id::text as id, ledger_account_id::text as "accountId",
              available_balance_minor::text as balance
         from app.wallets where user_id = $1 and currency = 'USD'`,
      [userId],
    );
    const walletRow = wallet.rows[0];
    if (walletRow === undefined) throw new Error('Restricted wallet is missing.');
    let bypassRows = -1;
    await expect(
      database.transaction(async (transaction) => {
        const ledgerTransactionId = randomUUID() as LedgerTransactionId;
        const businessReferenceId = randomUUID();
        await insertLedgerTransaction(transaction, {
          actorUserId: userId,
          businessReferenceId,
          businessReferenceType: 'blocked-provider-function-bypass',
          currency: usd,
          description: 'Ordinary debit must not use provider recovery',
          id: ledgerTransactionId,
          idempotencyRecordId: null,
          kind: 'wallet_debit',
          reversesLedgerTransactionId: null,
        });
        await insertLedgerEntries(transaction, ledgerTransactionId, [
          {
            amountMinor: toMoneyMinor(-1n),
            currency: usd,
            id: randomUUID() as LedgerEntryId,
            ledgerAccountId: walletRow.accountId as LedgerAccountId,
            sequence: 0,
          },
          {
            amountMinor: toMoneyMinor(1n),
            currency: usd,
            id: randomUUID() as LedgerEntryId,
            ledgerAccountId: establishedCounterpartyAccountId,
            sequence: 1,
          },
        ]);
        const result = await transaction.query(
          `select * from app.apply_provider_adjustment_wallet_balance($1, $2, $3, -1)`,
          [walletRow.id, ledgerTransactionId, businessReferenceId],
        );
        bypassRows = result.rowCount ?? result.rows.length;
        await finalizeLedgerTransaction(transaction, ledgerTransactionId);
      }),
    ).rejects.toMatchObject({ constraint: 'wallets_ledger_projection_mismatch' });
    expect(bypassRows).toBe(0);
    await expect(
      database.query(`select app.apply_provider_adjustment_wallet_balance($1, -1)`, [walletRow.id]),
    ).rejects.toMatchObject({ code: '42883' });
    const final = await database.query<{ readonly balance: string; readonly deficits: string }>(
      `select wallet.available_balance_minor::text as balance,
              (select coalesce(sum(amount_minor), 0)::text from app.funding_deficits
                where user_id = $1 and status = 'unresolved') as deficits
         from app.wallets as wallet where wallet.user_id = $1 and wallet.currency = 'USD'`,
      [userId],
    );
    expect(final.rows).toEqual([{ balance: '10', deficits: '1000' }]);
  });
});
