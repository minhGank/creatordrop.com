import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createTestApp } from './support/test-app.js';

describe('retired fan wallet API boundary', () => {
  it.each([
    ['GET', '/v1/me/wallets'],
    ['POST', '/v1/me/wallets/USD/test-credits'],
  ] as const)('does not expose %s %s from active application composition', async (method, path) => {
    const operation =
      method === 'GET' ? request(createTestApp()).get(path) : request(createTestApp()).post(path);
    const response = await operation
      .set('Idempotency-Key', 'retired-wallet-command')
      .send({ amountMinor: '2000' });

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });
});
