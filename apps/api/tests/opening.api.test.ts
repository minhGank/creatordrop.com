import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import type { OpeningService } from '../src/modules/openings/opening.service.js';
import { createTestApp } from './support/test-app.js';

const boxId = '019c0000-0000-7000-8000-000000000010';
const clientSeed = 'ab'.repeat(32);

describe('box opening API boundary', () => {
  it('derives the actor, validates exact input, and returns an allowlisted response', async () => {
    const body = {
      opening: {
        boxId,
        boxVersionId: '019c0000-0000-7000-8000-000000000011',
        cost: { currency: 'USD', priceMinor: '999' },
        fairness: {
          clientSeed,
          commitment: '22'.repeat(32),
          configurationHash: '33'.repeat(32),
          nonce: '0',
          seedSetId: '019c0000-0000-7000-8000-000000000012',
        },
        fulfillmentStatus: 'pending_fulfillment' as const,
        id: '019c0000-0000-7000-8000-000000000013',
        pointsAwarded: 20 as const,
        reward: {
          id: '019c0000-0000-7000-8000-000000000014',
          imageUrl: null,
          name: 'Reward',
          rewardVersionId: '019c0000-0000-7000-8000-000000000015',
        },
        wallet: {
          balanceMinor: '1',
          currency: 'USD',
          id: '019c0000-0000-7000-8000-000000000016',
          revision: '2',
        },
      },
    };
    const openBox = vi.fn<OpeningService['openBox']>().mockResolvedValue({
      body,
      replayed: false,
      statusCode: 201,
    });
    const response = await request(createTestApp({ openingService: { openBox } }))
      .post(`/v1/boxes/${boxId}/open`)
      .set('Authorization', 'Bearer synthetic')
      .set('Idempotency-Key', 'opening-key-1')
      .send({ clientSeed });

    expect(response.status).toBe(201);
    expect(response.body).toEqual(body);
    const command = openBox.mock.calls[0]?.[0];
    if (command === undefined) throw new Error('Opening service was not called.');
    expect(openBox).toHaveBeenCalledWith({
      boxId,
      clientSeed,
      idempotencyKey: 'opening-key-1',
      requestId: command.requestId,
      userId: '019c0000-0000-7000-8000-000000000001',
    });
    expect(typeof command.requestId).toBe('string');
  });

  it.each([
    { body: { clientSeed, userId: '019c0000-0000-7000-8000-000000000099' }, key: 'opening-key-2' },
    { body: { clientSeed: clientSeed.toUpperCase() }, key: 'opening-key-3' },
    { body: { clientSeed }, key: undefined },
  ])('rejects noncanonical or client-authoritative requests: %o', async ({ body, key }) => {
    const openBox = vi.fn<OpeningService['openBox']>();
    let operation = request(createTestApp({ openingService: { openBox } }))
      .post(`/v1/boxes/${boxId}/open`)
      .set('Authorization', 'Bearer synthetic');
    if (key !== undefined) operation = operation.set('Idempotency-Key', key);
    const response = await operation.send(body);
    expect(response.status).toBe(400);
    expect(openBox).not.toHaveBeenCalled();
  });
});
