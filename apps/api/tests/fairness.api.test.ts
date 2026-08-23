import { createServer, request as sendRawHttpRequest } from 'node:http';

import type { RequestHandler } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { FairnessRevisionConflictError } from '../src/modules/fairness/fairness.errors.js';
import type { FairnessService } from '../src/modules/fairness/fairness.service.js';
import type {
  ClientSeed,
  CurrentFairnessState,
  PublicSeedSet,
  RngSeedSetId,
} from '../src/modules/fairness/fairness.js';
import {
  createTestApp,
  createTestAppOptions,
  createUnhandledFairnessService,
} from './support/test-app.js';

const userId = '019c0000-0000-7000-8000-000000000001';
const seedSet: PublicSeedSet = {
  algorithmVersion: 'hmac-sha256-rejection-v1',
  commitment: '01'.repeat(32),
  compromisedAt: null,
  createdAt: '2026-08-22T12:00:00.000Z',
  id: '019c0000-0000-7000-8000-000000000020' as RngSeedSetId,
  maxNonceExclusive: '1000',
  nextNonce: '0',
  retiredAt: null,
  revealedAt: null,
  revealedServerSeed: null,
  rotateAfter: '2026-08-23T12:00:00.000Z',
  status: 'active',
};
const fairness: CurrentFairnessState = {
  activeSeedSet: seedSet,
  clientSeed: 'ab'.repeat(32) as ClientSeed,
  revision: 1,
  rotationPolicy: { maxAgeMs: 86_400_000, maxOpenings: '1000' },
};

const serviceWith = (overrides: Partial<FairnessService>): FairnessService => ({
  ...createUnhandledFairnessService(),
  ...overrides,
});

describe('fairness lifecycle API', () => {
  it('returns only allowlisted active fairness state for the authenticated actor', async () => {
    const leakyFairness = {
      ...fairness,
      activeSeedSet: { ...seedSet, ciphertext: 'must-not-escape', encryptionIv: 'must-not-escape' },
      masterKey: 'must-not-escape',
    };
    const getCurrent = vi.fn<FairnessService['getCurrent']>().mockResolvedValue(leakyFairness);
    const response = await request(
      createTestApp({ fairnessService: serviceWith({ getCurrent }) }),
    ).get('/v1/me/fairness');

    expect(response.status).toBe(200);
    expect(response.headers.etag).toBe('"1"');
    expect(response.body).toEqual({ fairness });
    expect(JSON.stringify(response.body)).not.toMatch(
      /cipher|authenticationTag|encryptionIv|masterKey/iu,
    );
    expect(getCurrent).toHaveBeenCalledWith(userId);
  });

  it('initializes with an authenticated user-derived identity and canonical client seed', async () => {
    const initialize = vi
      .fn<FairnessService['initialize']>()
      .mockResolvedValue({ created: true, fairness });
    const response = await request(createTestApp({ fairnessService: serviceWith({ initialize }) }))
      .post('/v1/me/fairness')
      .send({ clientSeed: fairness.clientSeed });

    expect(response.status).toBe(201);
    expect(initialize).toHaveBeenCalledWith(
      expect.objectContaining({ clientSeed: fairness.clientSeed, userId }),
    );
  });

  it('revision-checks client-seed changes and maps stale writes to a stable conflict', async () => {
    const updateClientSeed = vi
      .fn<FairnessService['updateClientSeed']>()
      .mockRejectedValue(new FairnessRevisionConflictError(2));
    const response = await request(
      createTestApp({ fairnessService: serviceWith({ updateClientSeed }) }),
    )
      .put('/v1/me/fairness/client-seed')
      .set('If-Match', '"1"')
      .send({ clientSeed: 'cd'.repeat(32) });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      error: { code: 'FAIRNESS_REVISION_CONFLICT', details: { currentRevision: 2 } },
    });
  });

  it('requires an allowlisted idempotency key for rotation', async () => {
    const rotate = vi.fn<FairnessService['rotate']>().mockResolvedValue({
      newSeedSet: seedSet,
      previousSeedSetId: '019c0000-0000-7000-8000-000000000019' as RngSeedSetId,
      replayed: false,
    });
    const app = createTestApp({ fairnessService: serviceWith({ rotate }) });
    const missing = await request(app).post('/v1/me/fairness/rotate');
    expect(missing.status).toBe(400);

    const response = await request(app)
      .post('/v1/me/fairness/rotate')
      .set('Idempotency-Key', 'rotation_123');
    expect(response.status).toBe(200);
    expect(rotate).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: 'rotation_123',
        reason: 'user_request',
        userId,
      }),
    );

    expect(
      (
        await request(app)
          .post('/v1/me/fairness/rotate?unexpected=true')
          .set('Idempotency-Key', 'rotation_124')
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .post('/v1/me/fairness/rotate')
          .set('Idempotency-Key', 'rotation_125')
          .send({ unexpected: true })
      ).status,
    ).toBe(400);
  });

  it('rejects a chunked non-JSON rotation body', async () => {
    const rotate = vi.fn<FairnessService['rotate']>();
    const server = createServer(createTestApp({ fairnessService: serviceWith({ rotate }) }));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });

    try {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('Expected an ephemeral TCP test listener.');
      }
      const response = await new Promise<{ readonly body: unknown; readonly status: number }>(
        (resolve, reject) => {
          const rawRequest = sendRawHttpRequest(
            {
              headers: {
                'Content-Type': 'text/plain',
                'Idempotency-Key': 'rotation_chunked',
                'Transfer-Encoding': 'chunked',
              },
              host: '127.0.0.1',
              method: 'POST',
              path: '/v1/me/fairness/rotate',
              port: address.port,
            },
            (rawResponse) => {
              const chunks: Buffer[] = [];
              rawResponse.on('data', (chunk: Buffer) => chunks.push(chunk));
              rawResponse.once('error', reject);
              rawResponse.once('end', () => {
                resolve({
                  body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
                  status: rawResponse.statusCode ?? 0,
                });
              });
            },
          );
          rawRequest.once('error', reject);
          rawRequest.write('unexpected');
          rawRequest.end();
        },
      );

      expect(response.status).toBe(415);
      expect(response.body).toMatchObject({ error: { code: 'UNSUPPORTED_MEDIA_TYPE' } });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    }
    expect(rotate).not.toHaveBeenCalled();
  });

  it('provides public commitment/history metadata without authentication or encrypted fields', async () => {
    const getPublicSeedSet = vi
      .fn<FairnessService['getPublicSeedSet']>()
      .mockResolvedValue(seedSet);
    const options = createTestAppOptions({
      fairnessService: serviceWith({ getPublicSeedSet }),
    });
    const authenticate = vi.fn(options.authenticate);
    const response = await request(createTestApp({ ...options, authenticate })).get(
      `/v1/fairness/seed-sets/${seedSet.id.toUpperCase()}`,
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ seedSet });
    expect(authenticate).not.toHaveBeenCalled();
    expect(getPublicSeedSet).toHaveBeenCalledWith(seedSet.id);
  });

  it('fails closed if a non-revealed service result contains plaintext', async () => {
    const rawSeed = 'ee'.repeat(32);
    const getPublicSeedSet = vi
      .fn<FairnessService['getPublicSeedSet']>()
      .mockResolvedValue({ ...seedSet, revealedServerSeed: rawSeed });
    const response = await request(
      createTestApp({ fairnessService: serviceWith({ getPublicSeedSet }) }),
    ).get(`/v1/fairness/seed-sets/${seedSet.id}`);

    expect(response.status).toBe(500);
    expect(JSON.stringify(response.body)).not.toContain(rawSeed);
  });

  it('rate-limits fairness mutations by authenticated actor after a generous IP gate', async () => {
    const initialize = vi
      .fn<FairnessService['initialize']>()
      .mockResolvedValue({ created: true, fairness });
    const options = createTestAppOptions({ fairnessService: serviceWith({ initialize }) });
    const authenticate: RequestHandler = (request, _response, next) => {
      const actorSuffix = request.get('x-test-actor') === 'second' ? '2' : '1';
      request.actor = {
        provider: 'synthetic-provider',
        subject: `synthetic-subject-${actorSuffix}`,
        user: {
          id: `019c0000-0000-7000-8000-00000000000${actorSuffix}`,
          status: 'active',
          username: `synthetic_user_${actorSuffix}`,
        },
      };
      next();
    };
    const app = createTestApp({
      ...options,
      authenticate,
      security: { ...options.security, fairnessMutationRateLimitMax: 1 },
    });
    expect(
      (await request(app).post('/v1/me/fairness').send({ clientSeed: fairness.clientSeed })).status,
    ).toBe(201);
    const limited = await request(app)
      .post('/v1/me/fairness')
      .send({ clientSeed: fairness.clientSeed });
    expect(limited.status).toBe(429);
    expect(limited.body).toMatchObject({ error: { code: 'RATE_LIMITED' } });
    expect(
      (
        await request(app)
          .post('/v1/me/fairness')
          .set('X-Test-Actor', 'second')
          .send({ clientSeed: fairness.clientSeed })
      ).status,
    ).toBe(201);
  });
});
