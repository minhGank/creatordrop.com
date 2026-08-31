import Stripe from 'stripe';

import type { PositiveMoneyMinor } from '@creatordrop/domain';

import { FundingProviderUnavailableError, FundingWebhookSignatureError } from './payment.errors.js';
import type { FundingIntentId } from './payment.js';

export interface StripePaymentIntentValue {
  readonly amountMinor: bigint;
  readonly clientSecret: string;
  readonly currency: string;
  readonly id: string;
  readonly localFundingIntentId: string | null;
  readonly status: string;
}

export type StripeWebhookEventKind =
  | 'payment_canceled'
  | 'payment_failed'
  | 'payment_succeeded'
  | 'provider_dispute'
  | 'provider_refund'
  | 'unhandled';

export interface StripeWebhookEventValue {
  readonly amountMinor: bigint | null;
  readonly createdAt: Date;
  readonly currency: string | null;
  readonly eventId: string;
  readonly eventType: string;
  readonly kind: StripeWebhookEventKind;
  readonly livemode: boolean;
  readonly localFundingIntentId: string | null;
  readonly paymentIntentId: string | null;
  readonly providerObjectId: string | null;
  readonly providerStatus: string | null;
}

export interface StripeFundingProvider {
  readonly createPaymentIntent: (input: {
    readonly amountMinor: PositiveMoneyMinor;
    readonly currency: 'USD';
    readonly fundingIntentId: FundingIntentId;
    readonly idempotencyKey: string;
  }) => Promise<StripePaymentIntentValue>;
  readonly parseWebhook: (rawBody: Buffer, signature: string) => StripeWebhookEventValue;
  readonly retrievePaymentIntent: (
    providerPaymentIntentId: string,
  ) => Promise<StripePaymentIntentValue>;
}

const paymentIntentId = (value: string | Stripe.PaymentIntent | null): string | null =>
  typeof value === 'string' ? value : (value?.id ?? null);

const localIntentId = (metadata: Stripe.Metadata): string | null => {
  const value = metadata.creatordrop_funding_intent_id;
  return typeof value === 'string' && value.length > 0 ? value : null;
};

const paymentIntentValue = (value: Stripe.PaymentIntent): StripePaymentIntentValue => {
  if (value.client_secret === null) {
    throw new FundingProviderUnavailableError();
  }
  return {
    amountMinor: BigInt(value.amount),
    clientSecret: value.client_secret,
    currency: value.currency.toUpperCase(),
    id: value.id,
    localFundingIntentId: localIntentId(value.metadata),
    status: value.status,
  };
};

const normalizeWebhook = (event: Stripe.Event): StripeWebhookEventValue => {
  const base = {
    createdAt: new Date(event.created * 1000),
    eventId: event.id,
    eventType: event.type,
    livemode: event.livemode,
  } as const;
  switch (event.type) {
    case 'payment_intent.succeeded':
    case 'payment_intent.payment_failed':
    case 'payment_intent.canceled': {
      const value = event.data.object;
      return {
        ...base,
        amountMinor: BigInt(
          event.type === 'payment_intent.succeeded' ? value.amount_received : value.amount,
        ),
        currency: value.currency.toUpperCase(),
        kind:
          event.type === 'payment_intent.succeeded'
            ? 'payment_succeeded'
            : event.type === 'payment_intent.canceled'
              ? 'payment_canceled'
              : 'payment_failed',
        localFundingIntentId: localIntentId(value.metadata),
        paymentIntentId: value.id,
        providerObjectId: value.id,
        providerStatus: value.status,
      };
    }
    case 'refund.created':
    case 'refund.updated': {
      const value = event.data.object;
      return {
        ...base,
        amountMinor: BigInt(value.amount),
        currency: value.currency.toUpperCase(),
        kind: value.status === 'succeeded' ? 'provider_refund' : 'unhandled',
        localFundingIntentId: null,
        paymentIntentId: paymentIntentId(value.payment_intent),
        providerObjectId: value.id,
        providerStatus: value.status,
      };
    }
    case 'charge.dispute.created': {
      const value = event.data.object;
      return {
        ...base,
        amountMinor: BigInt(value.amount),
        currency: value.currency.toUpperCase(),
        kind: 'provider_dispute',
        localFundingIntentId: null,
        paymentIntentId: paymentIntentId(value.payment_intent),
        providerObjectId: value.id,
        providerStatus: value.status,
      };
    }
    default:
      return {
        ...base,
        amountMinor: null,
        currency: null,
        kind: 'unhandled',
        localFundingIntentId: null,
        paymentIntentId: null,
        providerObjectId:
          'id' in event.data.object && typeof event.data.object.id === 'string'
            ? event.data.object.id
            : null,
        providerStatus: null,
      };
  }
};

export const createStripeFundingProvider = (input: {
  readonly apiKey: string;
  readonly webhookSecret: string;
}): StripeFundingProvider => {
  const stripe = new Stripe(input.apiKey, {
    appInfo: { name: 'CreatorDrop', version: 'phase-11' },
    maxNetworkRetries: 2,
    telemetry: false,
  });
  return {
    createPaymentIntent: async (command) => {
      try {
        const value = await stripe.paymentIntents.create(
          {
            amount: Number(command.amountMinor),
            automatic_payment_methods: { enabled: true },
            currency: command.currency.toLowerCase(),
            metadata: { creatordrop_funding_intent_id: command.fundingIntentId },
          },
          { idempotencyKey: command.idempotencyKey },
        );
        return paymentIntentValue(value);
      } catch (error) {
        if (error instanceof FundingProviderUnavailableError) throw error;
        throw new FundingProviderUnavailableError();
      }
    },

    parseWebhook: (rawBody, signature) => {
      try {
        return normalizeWebhook(
          stripe.webhooks.constructEvent(rawBody, signature, input.webhookSecret),
        );
      } catch {
        throw new FundingWebhookSignatureError();
      }
    },

    retrievePaymentIntent: async (providerPaymentIntentId) => {
      try {
        return paymentIntentValue(await stripe.paymentIntents.retrieve(providerPaymentIntentId));
      } catch (error) {
        if (error instanceof FundingProviderUnavailableError) throw error;
        throw new FundingProviderUnavailableError();
      }
    },
  };
};
