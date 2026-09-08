import { ApiError } from '../src/http/errors.js';
import { parseRewardDraftInput } from '../src/modules/catalog/catalog.schema.js';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import type { BoxOpeningResponse, OpeningV2EntitlementStateResponse } from '@creatordrop/contracts';

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
  const openingService = (openBox: OpeningService['openBox']): OpeningService => ({
    getProgression: vi.fn<OpeningService['getProgression']>(),
    getEntitlementState: vi
      .fn<OpeningService['getEntitlementState']>()
      .mockRejectedValue(new Error('Entitlement state was not configured for this test.')),
    openBox,
  });
  it('reads only the authenticated progression and rejects arbitrary-user input', async () => {
    const service = openingService(vi.fn());
    const getProgression = vi.fn<OpeningService['getProgression']>().mockResolvedValue({
      progression: {
        lifetimeXp: '0',
        level: '1',
        xpInLevel: '0',
        xpForNextLevel: '100',
        universalEntriesAvailable: '0',
        universalEntriesEarned: '0',
      },
    });
    const app = createTestApp({ openingService: { ...service, getProgression } });
    await request(app)
      .get('/v1/me/progression')
      .expect(200)
      .expect('Cache-Control', 'private, no-store');
    expect(getProgression).toHaveBeenCalledWith('019c0000-0000-7000-8000-000000000001');
    await request(app).get('/v1/me/progression?userId=another-user').expect(400);
    expect(getProgression).toHaveBeenCalledOnce();
    for (const status of [401, 403]) {
      const denied = createTestApp({
        openingService: { ...service, getProgression },
        authenticate: (_req, _res, next) => next(new ApiError(status, 'AUTH_DENIED', 'Denied')),
      });
      await request(denied).get('/v1/me/progression').expect(status);
    }
    expect(getProgression).toHaveBeenCalledOnce();
    await request(app).post('/v1/me/progression').send({ xp: '100' }).expect(404);
  });
  it('validates platform-governed XP configuration and rejects legacy point rewards', () => {
    const valid = {
      description: '',
      name: 'XP',
      rewardType: 'xp',
      inventoryMode: 'unlimited',
      xpAmount: '250',
    };
    expect(parseRewardDraftInput(valid).xpAmount).toBe(250n);
    for (const invalid of [
      { xpAmount: '0' },
      { xpAmount: '501' },
      { xpAmount: '1000000' },
      { xpAmount: '2.5' },
      { xpAmount: 250 },
      { rewardType: 'points' },
      { rewardType: 'digital' },
      { inventoryMode: 'finite', inventoryQuantity: '1' },
      { declaredValueMinor: '10', declaredValueCurrency: 'USD' },
      { xpPolicyVersion: 'creator-choice' },
    ]) {
      expect(() => parseRewardDraftInput({ ...valid, ...invalid })).toThrow(ApiError);
    }
  });
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
    const response = await request(createTestApp({ openingService: openingService(openBox) }))
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

  it('returns an allowlisted non-financial opening-v2 response', async () => {
    const body = {
      opening: {
        boxId,
        boxVersionId: expectedBoxVersionId,
        entitlement: { maxOpeningsPerUser: '3', remaining: '1', successfulOpenings: '1' },
        fairness: {
          clientSeed,
          commitment: expectedServerSeedCommitment,
          configurationHash: expectedConfigurationHash,
          nonce: '0',
          seedSetId: expectedSeedSetId,
        },
        fulfillmentStatus: 'pending_fulfillment' as const,
        id: '019c0000-0000-7000-8000-000000000013',
        openingCompatibilityVersion: 'opening-v2' as const,
        reward: {
          id: '019c0000-0000-7000-8000-000000000014',
          imageUrl: null,
          name: 'Reward',
          rarity: 'common' as const,
          rarityPolicyVersion: 'rarity-v1' as const,
          rewardVersionId: '019c0000-0000-7000-8000-000000000015',
        },
      },
    };
    const openBox = vi.fn<OpeningService['openBox']>().mockResolvedValue({
      body,
      replayed: false,
      statusCode: 201,
    });
    const response = await request(createTestApp({ openingService: openingService(openBox) }))
      .post(`/v1/boxes/${boxId}/open`)
      .set('Authorization', 'Bearer synthetic')
      .set('Idempotency-Key', 'opening-key-v2')
      .send({
        clientSeed,
        expectedBoxVersionId,
        expectedConfigurationHash,
        expectedSeedSetId,
        expectedServerSeedCommitment,
      });

    expect(response.status).toBe(201);
    expect(response.body).toEqual(body);
    const responseBody = response.body as BoxOpeningResponse;
    expect(responseBody.opening).not.toHaveProperty('cost');
    expect(responseBody.opening).not.toHaveProperty('wallet');
    expect(responseBody.opening).not.toHaveProperty('pointsAwarded');
  });

  it('derives the entitlement-state user from authentication', async () => {
    const getEntitlementState = vi.fn<OpeningService['getEntitlementState']>().mockResolvedValue({
      entitlement: {
        available: true,
        boxId,
        consumed: '1',
        granted: '3',
        limitReached: false,
        maxOpeningsPerUser: '4',
        remaining: '2',
        successfulOpenings: '1',
      },
    });
    const service: OpeningService = {
      getProgression: vi.fn<OpeningService['getProgression']>(),
      getEntitlementState,
      openBox: vi.fn<OpeningService['openBox']>(),
    };
    const response = await request(createTestApp({ openingService: service }))
      .get(`/v1/boxes/${boxId}/opening-entitlement`)
      .set('Authorization', 'Bearer synthetic');

    expect(response.status).toBe(200);
    expect((response.body as OpeningV2EntitlementStateResponse).entitlement).toMatchObject({
      available: true,
      remaining: '2',
    });
    expect(getEntitlementState).toHaveBeenCalledWith({
      boxId,
      userId: '019c0000-0000-7000-8000-000000000001',
    });
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
    let operation = request(createTestApp({ openingService: openingService(openBox) }))
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
    const response = await request(createTestApp({ openingService: openingService(openBox) }))
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
    const response = await request(createTestApp({ openingService: openingService(openBox) }))
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
