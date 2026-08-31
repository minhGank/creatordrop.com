import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { FundingWebhookSignatureError } from '../src/modules/payments/payment.errors.js';
import type { PaymentService } from '../src/modules/payments/payment.service.js';
import { createTestApp } from './support/test-app.js';

const unhandled = (): Promise<never> =>
  Promise.reject(new Error('The test did not configure this payment operation.'));

const paymentService = (overrides: Partial<PaymentService>): PaymentService => ({
  createFundingIntent: unhandled,
  processStripeWebhook: unhandled,
  reconcileFundingIntent: unhandled,
  ...overrides,
});

describe('wallet funding API boundary', () => {
  it('derives the user and returns only safe PaymentIntent client fields', async () => {
    const createFundingIntent = vi.fn<PaymentService['createFundingIntent']>().mockResolvedValue({
      amountMinor: '2000',
      clientSecret: 'pi_synthetic_secret_client',
      currency: 'USD',
      fundingIntentId: '019d0000-0000-7000-8000-000000000020',
    });
    const response = await request(
      createTestApp({
        paymentService: paymentService({ createFundingIntent }),
        runtime: { stripeFundingEnabled: true, testCreditsEnabled: true },
      }),
    )
      .post('/v1/me/wallets/USD/funding-intents')
      .set('Idempotency-Key', 'funding-command-1')
      .send({ amountMinor: '2000' });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      fundingIntent: {
        amountMinor: '2000',
        clientSecret: 'pi_synthetic_secret_client',
        currency: 'USD',
        fundingIntentId: '019d0000-0000-7000-8000-000000000020',
      },
    });
    expect(createFundingIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        amountMinor: 2000n,
        currency: 'USD',
        idempotencyKey: 'funding-command-1',
        userId: '019c0000-0000-7000-8000-000000000001',
      }),
    );
  });

  it('passes exact raw webhook bytes and rejects invalid signatures without parsing JSON', async () => {
    const rawBody = Buffer.from('{"exact":"bytes"}');
    const processStripeWebhook = vi
      .fn<PaymentService['processStripeWebhook']>()
      .mockRejectedValue(new FundingWebhookSignatureError());
    const response = await request(
      createTestApp({
        paymentService: paymentService({ processStripeWebhook }),
        runtime: { stripeFundingEnabled: true, testCreditsEnabled: true },
      }),
    )
      .post('/v1/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', 't=123456789,v1=forged-signature')
      .send(rawBody.toString('utf8'));

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: { code: 'STRIPE_SIGNATURE_INVALID' } });
    expect(processStripeWebhook).toHaveBeenCalledWith(
      rawBody,
      't=123456789,v1=forged-signature',
      expect.any(String),
    );
  });

  it('does not expose funding or webhook routes when the feature is disabled', async () => {
    const service = paymentService({});
    const app = createTestApp({
      paymentService: service,
      runtime: { stripeFundingEnabled: false, testCreditsEnabled: true },
    });
    expect(
      (
        await request(app)
          .post('/v1/me/wallets/USD/funding-intents')
          .set('Idempotency-Key', 'funding-command-2')
          .send({ amountMinor: '2000' })
      ).status,
    ).toBe(404);
    expect(
      (
        await request(app)
          .post('/v1/webhooks/stripe')
          .set('Content-Type', 'application/json')
          .set('Stripe-Signature', 't=123456789,v1=synthetic')
          .send('{}')
      ).status,
    ).toBe(404);
  });
});
