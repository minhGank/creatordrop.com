import Stripe from 'stripe';
import { describe, expect, it } from 'vitest';

import { FundingWebhookSignatureError } from '../src/modules/payments/payment.errors.js';
import { createStripeFundingProvider } from '../src/modules/payments/stripe.provider.js';

describe('Stripe provider signature boundary', () => {
  const webhookSecret = 'whsec_synthetic_phase11_signature_secret';
  const provider = createStripeFundingProvider({
    apiKey: 'sk_test_synthetic_phase11_api_key',
    webhookSecret,
  });
  const payload = JSON.stringify({
    api_version: '2025-08-27.basil',
    created: 1_787_916_000,
    data: {
      object: {
        amount: 2000,
        amount_received: 2000,
        client_secret: 'pi_synthetic_secret_client',
        currency: 'usd',
        id: 'pi_synthetic_12345678',
        metadata: { creatordrop_funding_intent_id: '019d0000-0000-7000-8000-000000000001' },
        object: 'payment_intent',
        status: 'succeeded',
      },
    },
    id: 'evt_synthetic_12345678',
    livemode: false,
    object: 'event',
    pending_webhooks: 1,
    request: null,
    type: 'payment_intent.succeeded',
  });

  it('authenticates the exact raw bytes and normalizes only required financial fields', () => {
    const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: webhookSecret });
    expect(provider.parseWebhook(Buffer.from(payload), signature)).toMatchObject({
      amountMinor: 2000n,
      currency: 'USD',
      eventId: 'evt_synthetic_12345678',
      kind: 'payment_succeeded',
      livemode: false,
      localFundingIntentId: '019d0000-0000-7000-8000-000000000001',
      paymentIntentId: 'pi_synthetic_12345678',
      providerObjectId: 'pi_synthetic_12345678',
    });
  });

  it('rejects forged signatures and byte-level payload changes', () => {
    const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: webhookSecret });
    expect(() => provider.parseWebhook(Buffer.from(payload), 't=1,v1=forged')).toThrow(
      FundingWebhookSignatureError,
    );
    expect(() => provider.parseWebhook(Buffer.from(`${payload} `), signature)).toThrow(
      FundingWebhookSignatureError,
    );
  });
});
