import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import type { OpeningService } from '../src/modules/openings/opening.service.js';
import { FairnessConfirmationStaleError } from '../src/modules/fairness/fairness.errors.js';
import { OpeningConfirmationStaleError } from '../src/modules/openings/opening.errors.js';
import { createTestApp } from './support/test-app.js';

const boxId = '019c0000-0000-7000-8000-000000000010';
const expectedBoxVersionId = '019c0000-0000-7000-8000-000000000011';
const expectedConfigurationHash = '33'.repeat(32);
const expectedSeedSetId = '019c0000-0000-7000-8000-000000000012';
const expectedServerSeedCommitment = '22'.repeat(32);
const clientSeed = 'ab'.repeat(32);

describe('box opening API boundary', () => {
  it('derives the actor, validates exact input, and returns an allowlisted response', async () => {
    const body = {
      opening: {
        boxId,
        boxVersionId: expectedBoxVersionId,
        cost: { currency: 'USD', priceMinor: '999' },
        fairness: {
          clientSeed,
          commitment: expectedServerSeedCommitment,
          configurationHash: expectedConfigurationHash,
          nonce: '0',
          seedSetId: expectedSeedSetId,
        },
        fulfillmentStatus: 'pending_fulfillment' as const,
        id: '019c0000-0000-7000-8000-000000000013',
        pointsAwarded: 20 as const,
        reward: {
          id: '019c0000-0000-7000-8000-000000000014',
          imageUrl: null,
          name: 'Reward',
          rarity: 'common' as const,
          rarityPolicyVersion: 'rarity-v1' as const,
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
      .send({
        clientSeed,
        expectedBoxVersionId,
        expectedConfigurationHash,
        expectedSeedSetId,
        expectedServerSeedCommitment,
      });

    expect(response.status).toBe(201);
    expect(response.body).toEqual(body);
    const command = openBox.mock.calls[0]?.[0];
    if (command === undefined) throw new Error('Opening service was not called.');
    expect(openBox).toHaveBeenCalledWith({
      boxId,
      clientSeed,
      expectedBoxVersionId,
      expectedConfigurationHash,
      expectedSeedSetId,
      expectedServerSeedCommitment,
      idempotencyKey: 'opening-key-1',
      requestId: command.requestId,
      userId: '019c0000-0000-7000-8000-000000000001',
    });
    expect(typeof command.requestId).toBe('string');
  });

  it.each([
    {
      body: {
        clientSeed,
        expectedBoxVersionId,
        expectedConfigurationHash,
        expectedSeedSetId,
        expectedServerSeedCommitment,
        userId: '019c0000-0000-7000-8000-000000000099',
      },
      key: 'opening-key-2',
    },
    {
      body: {
        clientSeed,
        currency: 'USD',
        expectedBoxVersionId,
        expectedConfigurationHash,
        expectedSeedSetId,
        expectedServerSeedCommitment,
        priceMinor: '1',
      },
      key: 'opening-key-client-price',
    },
    {
      body: {
        clientSeed: clientSeed.toUpperCase(),
        expectedBoxVersionId,
        expectedConfigurationHash,
        expectedSeedSetId,
        expectedServerSeedCommitment,
      },
      key: 'opening-key-3',
    },
    {
      body: {
        clientSeed,
        expectedBoxVersionId,
        expectedConfigurationHash,
        expectedSeedSetId,
        expectedServerSeedCommitment,
      },
      key: undefined,
    },
    {
      body: {
        clientSeed,
        expectedConfigurationHash,
        expectedSeedSetId,
        expectedServerSeedCommitment,
      },
      key: 'opening-key-4',
    },
    {
      body: {
        clientSeed,
        expectedBoxVersionId,
        expectedConfigurationHash: 'FF'.repeat(32),
        expectedSeedSetId,
        expectedServerSeedCommitment,
      },
      key: 'opening-key-5',
    },
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

  it('returns a stable stale-confirmation error without opening a different version', async () => {
    const openBox = vi
      .fn<OpeningService['openBox']>()
      .mockRejectedValue(new OpeningConfirmationStaleError());
    const response = await request(createTestApp({ openingService: { openBox } }))
      .post(`/v1/boxes/${boxId}/open`)
      .set('Authorization', 'Bearer synthetic')
      .set('Idempotency-Key', 'opening-key-stale')
      .send({
        clientSeed,
        expectedBoxVersionId,
        expectedConfigurationHash,
        expectedSeedSetId,
        expectedServerSeedCommitment,
      });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      error: {
        code: 'OPENING_CONFIRMATION_STALE',
        message:
          'The box changed after it was loaded. Review the current version and confirm again.',
      },
    });
  });

  it('returns a stable stale-fairness error when the confirmed seed set changed', async () => {
    const openBox = vi
      .fn<OpeningService['openBox']>()
      .mockRejectedValue(new FairnessConfirmationStaleError());
    const response = await request(createTestApp({ openingService: { openBox } }))
      .post(`/v1/boxes/${boxId}/open`)
      .set('Authorization', 'Bearer synthetic')
      .set('Idempotency-Key', 'opening-key-fairness-stale')
      .send({
        clientSeed,
        expectedBoxVersionId,
        expectedConfigurationHash,
        expectedSeedSetId,
        expectedServerSeedCommitment,
      });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      error: {
        code: 'FAIRNESS_CONFIRMATION_STALE',
        message: 'The active fairness seed changed. Review the new commitment and confirm again.',
      },
    });
  });
});
