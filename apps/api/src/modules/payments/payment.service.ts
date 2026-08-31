import { createHash } from 'node:crypto';

import { validate as isUuid, v7 as uuidv7 } from 'uuid';

import type { Database, TransactionExecutor } from '@creatordrop/database';
import { parsePositiveMoneyMinor } from '@creatordrop/domain';
import type { Currency, PositiveMoneyMinor } from '@creatordrop/domain';
import type { Logger } from '@creatordrop/observability';

import type { UserId } from '../creators/creator.js';
import { IdempotencyKeyReusedError } from '../wallet/wallet.errors.js';
import {
  assertWalletFundingAllowed,
  ensureFundingWallet,
  lockFundingWallet,
  postProviderFundingAdjustment,
  postProviderFundingCredit,
} from '../wallet/wallet.service.js';
import {
  FundingAmountOutOfRangeError,
  FundingEventRetryRequiredError,
  FundingProviderUnavailableError,
  FundingUnavailableError,
} from './payment.errors.js';
import {
  bindFundingIntentToProvider,
  claimProviderEvent,
  completeProviderEvent,
  countFundingSettlementsForIntent,
  findFundingIntentById,
  findFundingIntentByProviderId,
  findFundingSettlementByPaymentIntent,
  fundingAdjustmentExists,
  insertFundingAdjustment,
  insertFundingIntent,
  insertFundingSettlement,
  lockFundingIntentByClientKey,
  lockFundingIntentById,
  sumFundingAdjustments,
  updateFundingIntentAfterAdjustment,
  updateFundingIntentFromProvider,
} from './payment.repository.js';
import { stripeFundingPolicy } from './payment.policy.js';
import type {
  FundingAdjustmentId,
  FundingDeficitId,
  FundingIntent,
  FundingIntentId,
  FundingSettlementId,
  ProviderEventId,
} from './payment.js';
import type {
  StripeFundingProvider,
  StripePaymentIntentValue,
  StripeWebhookEventValue,
} from './stripe.provider.js';

type CreateId = () => string;

export interface CreateFundingIntentCommand {
  readonly amountMinor: PositiveMoneyMinor;
  readonly currency: Currency;
  readonly idempotencyKey: string;
  readonly requestId: string;
  readonly userId: UserId;
}

export interface FundingIntentClientResult {
  readonly amountMinor: string;
  readonly clientSecret: string;
  readonly currency: 'USD';
  readonly fundingIntentId: string;
}

export interface FundingReconciliationResult {
  readonly fundingIntentId: string;
  readonly issues: readonly string[];
  readonly providerPaymentIntentId: string;
}

export interface PaymentService {
  readonly createFundingIntent: (
    command: CreateFundingIntentCommand,
  ) => Promise<FundingIntentClientResult>;
  readonly processStripeWebhook: (
    rawBody: Buffer,
    signature: string,
    requestId: string,
  ) => Promise<void>;
  readonly reconcileFundingIntent: (
    fundingIntentId: FundingIntentId,
  ) => Promise<FundingReconciliationResult>;
}

export interface PaymentServiceOptions {
  readonly createId?: CreateId;
  readonly database: Database;
  readonly enabled: boolean;
  readonly logger: Logger;
  readonly provider: StripeFundingProvider | null;
}

interface GeneratedIdentifiers {
  readonly fundingAdjustment: FundingAdjustmentId;
  readonly fundingDeficit: FundingDeficitId;
  readonly fundingIntent: FundingIntentId;
  readonly fundingSettlement: FundingSettlementId;
  readonly providerEvent: ProviderEventId;
  readonly publicId: string;
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

export const buildFundingIntentFingerprint = (input: {
  readonly amountMinor: PositiveMoneyMinor;
  readonly currency: Currency;
  readonly userId: UserId;
}): string =>
  createHash('sha256')
    .update(
      `creatordrop:funding-intent:v1|${input.userId}|${input.currency}|${input.amountMinor.toString()}`,
      'utf8',
    )
    .digest('hex');

const findIntentForEvent = async (
  transaction: TransactionExecutor,
  event: StripeWebhookEventValue,
): Promise<FundingIntent | undefined> => {
  if (event.paymentIntentId !== null) {
    const bound = await findFundingIntentByProviderId(transaction, event.paymentIntentId);
    if (bound !== undefined) return bound;
  }
  if (
    event.localFundingIntentId !== null &&
    isUuid(event.localFundingIntentId) &&
    event.localFundingIntentId === event.localFundingIntentId.toLowerCase()
  ) {
    return findFundingIntentById(transaction, event.localFundingIntentId as FundingIntentId);
  }
  return undefined;
};

const eventMatchesIntent = (event: StripeWebhookEventValue, intent: FundingIntent): boolean =>
  event.paymentIntentId !== null &&
  event.amountMinor === intent.requestedAmountMinor &&
  event.currency === intent.currency &&
  (event.localFundingIntentId === null || event.localFundingIntentId === intent.id) &&
  (intent.providerPaymentIntentId === null ||
    intent.providerPaymentIntentId === event.paymentIntentId);

const adjustmentLinksToIntent = (event: StripeWebhookEventValue, intent: FundingIntent): boolean =>
  event.paymentIntentId !== null &&
  event.currency === intent.currency &&
  intent.providerPaymentIntentId === event.paymentIntentId;

const isFinalIntentStatus = (intent: FundingIntent): boolean =>
  ['disputed', 'partially_reversed', 'reconciliation_required', 'reversed', 'settled'].includes(
    intent.status,
  );

const validateProviderPaymentIntent = (
  providerIntent: StripePaymentIntentValue,
  intent: FundingIntent,
): void => {
  if (
    providerIntent.id !== intent.providerPaymentIntentId ||
    providerIntent.amountMinor !== intent.requestedAmountMinor ||
    providerIntent.currency !== intent.currency ||
    providerIntent.localFundingIntentId !== intent.id
  ) {
    throw new FundingProviderUnavailableError();
  }
};

export const createPaymentService = ({
  createId = uuidv7,
  database,
  enabled,
  logger,
  provider,
}: PaymentServiceOptions): PaymentService => {
  const requireProvider = (): StripeFundingProvider => {
    if (!enabled || provider === null) throw new FundingUnavailableError();
    return provider;
  };

  return {
    createFundingIntent: async (command) => {
      const activeProvider = requireProvider();
      if (
        command.currency !== stripeFundingPolicy.currency ||
        command.amountMinor < stripeFundingPolicy.minimumAmountMinor ||
        command.amountMinor > stripeFundingPolicy.maximumAmountMinor
      ) {
        throw new FundingAmountOutOfRangeError();
      }
      const fingerprint = buildFundingIntentFingerprint(command);
      const local = await database.transaction(async (transaction) => {
        const wallet = await ensureFundingWallet(
          transaction,
          command.userId,
          command.currency,
          createId,
        );
        await assertWalletFundingAllowed(transaction, command.userId, command.currency);
        const inserted = await insertFundingIntent(transaction, {
          clientIdempotencyKey: command.idempotencyKey,
          currency: command.currency,
          fingerprint,
          id: generatedId(createId, 'Funding intent ID', 'fundingIntent'),
          publicId: generatedId(createId, 'Public funding intent ID', 'publicId'),
          requestedAmountMinor: command.amountMinor,
          userId: command.userId,
          walletId: wallet.id,
        });
        const intent =
          inserted ??
          (await lockFundingIntentByClientKey(transaction, command.userId, command.idempotencyKey));
        if (intent === undefined) throw new Error('The funding intent could not be established.');
        if (intent.requestFingerprint !== fingerprint) throw new IdempotencyKeyReusedError();
        return intent;
      });

      const providerIntent = await activeProvider.createPaymentIntent({
        amountMinor: local.requestedAmountMinor,
        currency: 'USD',
        fundingIntentId: local.id,
        idempotencyKey: `creatordrop-funding-${local.id}`,
      });
      if (
        providerIntent.amountMinor !== local.requestedAmountMinor ||
        providerIntent.currency !== local.currency ||
        providerIntent.localFundingIntentId !== local.id
      ) {
        throw new FundingProviderUnavailableError();
      }
      await database.transaction(async (transaction) => {
        await bindFundingIntentToProvider(transaction, local.id, providerIntent.id);
      });
      logger.info('funding.audit', {
        action: 'funding.intent_ready',
        actorUserId: command.userId,
        amountMinor: command.amountMinor.toString(),
        currency: command.currency,
        fundingIntentId: local.publicId,
        requestId: command.requestId,
      });
      return {
        amountMinor: local.requestedAmountMinor.toString(),
        clientSecret: providerIntent.clientSecret,
        currency: 'USD',
        fundingIntentId: local.publicId,
      };
    },

    processStripeWebhook: async (rawBody, signature, requestId) => {
      const activeProvider = requireProvider();
      const event = activeProvider.parseWebhook(rawBody, signature);
      const payloadSha256 = createHash('sha256').update(rawBody).digest('hex');
      const outcome = await database.transaction(async (transaction) => {
        const discoveredIntent = await findIntentForEvent(transaction, event);
        let intent: FundingIntent | undefined;
        if (discoveredIntent !== undefined) {
          await lockFundingWallet(transaction, discoveredIntent.userId, discoveredIntent.currency);
          intent = await lockFundingIntentById(transaction, discoveredIntent.id);
          if (intent === undefined)
            throw new Error('The funding intent disappeared while locking.');
        }
        if (
          intent?.providerPaymentIntentId === null &&
          event.paymentIntentId !== null &&
          eventMatchesIntent(event, intent)
        ) {
          intent = await bindFundingIntentToProvider(transaction, intent.id, event.paymentIntentId);
        }
        const eventId = generatedId(createId, 'Provider event ID', 'providerEvent');
        const claim = await claimProviderEvent(transaction, {
          eventId,
          eventType: event.eventType,
          fundingIntentId: intent?.id ?? null,
          payloadSha256,
          providerCreatedAt: event.createdAt,
          providerEventId: event.eventId,
          providerObjectId: event.providerObjectId,
        });
        if (!claim.created && claim.record.status === 'processed') return { retry: false };
        if (event.livemode) {
          await completeProviderEvent(transaction, claim.record.id, 'LIVE_MODE_REJECTED', false);
          return { retry: false };
        }
        if (event.kind === 'unhandled') {
          await completeProviderEvent(transaction, claim.record.id, 'IGNORED_EVENT', false);
          return { retry: false };
        }
        const linked =
          intent !== undefined &&
          (event.kind === 'provider_refund' || event.kind === 'provider_dispute'
            ? adjustmentLinksToIntent(event, intent)
            : eventMatchesIntent(event, intent));
        if (intent === undefined || !linked) {
          if (intent !== undefined) {
            await updateFundingIntentFromProvider(transaction, {
              eventCreatedAt: event.createdAt,
              fundingIntentId: intent.id,
              status: 'reconciliation_required',
            });
          }
          await completeProviderEvent(
            transaction,
            claim.record.id,
            'RECONCILIATION_REQUIRED',
            false,
          );
          return { retry: false };
        }
        if (event.kind === 'payment_failed' || event.kind === 'payment_canceled') {
          if (!isFinalIntentStatus(intent)) {
            await updateFundingIntentFromProvider(transaction, {
              eventCreatedAt: event.createdAt,
              fundingIntentId: intent.id,
              status: event.kind === 'payment_failed' ? 'failed' : 'canceled',
            });
          }
          await completeProviderEvent(
            transaction,
            claim.record.id,
            'PAYMENT_STATE_RECORDED',
            false,
          );
          return { retry: false };
        }
        if (event.kind === 'payment_succeeded') {
          const providerPaymentIntentId = event.paymentIntentId;
          if (providerPaymentIntentId === null) {
            throw new Error('A successful payment event is missing its payment-intent ID.');
          }
          const existing = await findFundingSettlementByPaymentIntent(
            transaction,
            providerPaymentIntentId,
          );
          if (existing !== undefined) {
            await completeProviderEvent(transaction, claim.record.id, 'DUPLICATE_SUCCESS', false);
            return { retry: false };
          }
          const settlementId = generatedId(createId, 'Funding settlement ID', 'fundingSettlement');
          const movement = await postProviderFundingCredit(
            transaction,
            {
              actorUserId: intent.userId,
              amountMinor: intent.requestedAmountMinor,
              currency: intent.currency,
              settlementId,
            },
            createId,
          );
          await insertFundingSettlement(transaction, {
            currency: intent.currency,
            fundingIntentId: intent.id,
            id: settlementId,
            ledgerTransactionId: movement.ledgerTransaction.id,
            providerEventId: claim.record.id,
            providerPaymentIntentId,
            settledAmountMinor: intent.requestedAmountMinor,
          });
          await updateFundingIntentFromProvider(transaction, {
            eventCreatedAt: event.createdAt,
            fundingIntentId: intent.id,
            status: 'settled',
          });
          await completeProviderEvent(transaction, claim.record.id, 'SETTLED', false);
          return { retry: false };
        }

        const providerPaymentIntentId = event.paymentIntentId;
        if (providerPaymentIntentId === null) {
          throw new Error('A provider adjustment is missing its payment-intent ID.');
        }
        const settlement = await findFundingSettlementByPaymentIntent(
          transaction,
          providerPaymentIntentId,
        );
        if (settlement === undefined) {
          await completeProviderEvent(transaction, claim.record.id, 'SETTLEMENT_NOT_READY', true);
          return { retry: true };
        }
        const adjustmentType = event.kind === 'provider_refund' ? 'refund' : 'dispute';
        if (
          event.providerObjectId === null ||
          event.amountMinor === null ||
          event.amountMinor <= 0n ||
          (await fundingAdjustmentExists(transaction, adjustmentType, event.providerObjectId))
        ) {
          await completeProviderEvent(
            transaction,
            claim.record.id,
            'ADJUSTMENT_ALREADY_RECORDED',
            false,
          );
          return { retry: false };
        }
        const priorAdjusted = await sumFundingAdjustments(transaction, settlement.id);
        if (
          event.currency !== settlement.currency ||
          priorAdjusted + event.amountMinor > settlement.settledAmountMinor
        ) {
          await updateFundingIntentFromProvider(transaction, {
            eventCreatedAt: event.createdAt,
            fundingIntentId: intent.id,
            status: 'reconciliation_required',
          });
          await completeProviderEvent(
            transaction,
            claim.record.id,
            'RECONCILIATION_REQUIRED',
            false,
          );
          return { retry: false };
        }
        const adjustmentId = generatedId(createId, 'Funding adjustment ID', 'fundingAdjustment');
        const posting = await postProviderFundingAdjustment(
          transaction,
          {
            actorUserId: intent.userId,
            adjustmentId,
            adjustmentType,
            amountMinor: parsePositiveMoneyMinor(event.amountMinor.toString()),
            currency: intent.currency,
          },
          createId,
        );
        await insertFundingAdjustment(transaction, {
          adjustmentType,
          amountMinor: event.amountMinor,
          currency: intent.currency,
          deficitLedgerAccountId: posting.deficitLedgerAccountId,
          deficitMinor: posting.deficitMinor,
          fundingAdjustmentId: adjustmentId,
          fundingDeficitId: generatedId(createId, 'Funding deficit ID', 'fundingDeficit'),
          fundingSettlementId: settlement.id,
          ledgerTransactionId: posting.ledgerTransactionId,
          providerAdjustmentId: event.providerObjectId,
          providerEventId: claim.record.id,
          userId: intent.userId,
          walletRecoveredMinor: posting.walletRecoveredMinor,
        });
        await updateFundingIntentAfterAdjustment(transaction, {
          eventCreatedAt: event.createdAt,
          fundingIntentId: intent.id,
          fundingSettlementId: settlement.id,
        });
        await completeProviderEvent(transaction, claim.record.id, 'ADJUSTMENT_RECORDED', false);
        return { retry: false };
      });
      if (outcome.retry) throw new FundingEventRetryRequiredError();
      logger.info('funding.audit', {
        action: 'funding.provider_event_processed',
        eventType: event.eventType,
        requestId,
      });
    },

    reconcileFundingIntent: async (fundingIntentId) => {
      const activeProvider = requireProvider();
      const intent = await findFundingIntentById(database, fundingIntentId);
      if (intent === undefined) {
        throw new Error('The funding intent is not bound to a provider object.');
      }
      const providerPaymentIntentId = intent.providerPaymentIntentId;
      if (providerPaymentIntentId === null) {
        throw new Error('The funding intent is not bound to a provider object.');
      }
      const providerIntent = await activeProvider.retrievePaymentIntent(providerPaymentIntentId);
      const issues: string[] = [];
      try {
        validateProviderPaymentIntent(providerIntent, intent);
      } catch (error) {
        if (!(error instanceof FundingProviderUnavailableError)) throw error;
        if (providerIntent.amountMinor !== intent.requestedAmountMinor)
          issues.push('AMOUNT_MISMATCH');
        if (providerIntent.currency !== intent.currency) issues.push('CURRENCY_MISMATCH');
        if (providerIntent.localFundingIntentId !== intent.id) issues.push('LINKAGE_MISMATCH');
      }
      const settlementCount = await countFundingSettlementsForIntent(database, intent.id);
      if (providerIntent.status === 'succeeded' && settlementCount === 0) {
        issues.push('PROVIDER_SETTLED_WITHOUT_LEDGER_SETTLEMENT');
      }
      if (providerIntent.status !== 'succeeded' && settlementCount > 0) {
        issues.push('LEDGER_SETTLEMENT_WITHOUT_PROVIDER_SUCCESS');
      }
      if (settlementCount > 1) issues.push('DUPLICATE_SETTLEMENT_LINKAGE');
      return {
        fundingIntentId: intent.publicId,
        issues,
        providerPaymentIntentId,
      };
    },
  };
};
