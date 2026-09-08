import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createTestApp } from './support/test-app.js';

describe('retired fan funding API boundary', () => {
  it('does not expose funding intents from active application composition', async () => {
    const response = await request(createTestApp())
      .post('/v1/me/wallets/USD/funding-intents')
      .set('Idempotency-Key', 'retired-funding-command')
      .send({ amountMinor: '2000' });

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('does not expose the legacy fan Stripe webhook from active application composition', async () => {
    const response = await request(createTestApp())
      .post('/v1/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', 't=123456789,v1=synthetic')
      .send('{}');

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });
});
