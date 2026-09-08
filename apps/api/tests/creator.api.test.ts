import type { RequestHandler } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { authenticationRequired } from '../src/http/errors.js';
import {
  CreatorNotFoundError,
  CreatorRevisionConflictError,
} from '../src/modules/creators/creator.errors.js';
import { parseCreatorId, trustedUserId } from '../src/modules/creators/creator.schema.js';
import type { CreatorService } from '../src/modules/creators/creator.service.js';
import type { CreatorWorkspace } from '../src/modules/creators/creator.js';
import { createTestApp, createUnhandledCreatorService } from './support/test-app.js';

const creator: CreatorWorkspace = {
  createdAt: '2026-08-20T18:00:00.000Z',
  customSlug: 'synthetic-creator',
  displayName: 'Synthetic Creator',
  handle: 'synthetic_creator',
  id: parseCreatorId('019c0000-0000-7000-8000-000000000010'),
  revision: 1,
  role: 'owner',
  status: 'active',
  updatedAt: '2026-08-20T18:00:00.000Z',
};

const actorUserId = trustedUserId('019c0000-0000-7000-8000-000000000001');

const serviceWith = (overrides: Partial<CreatorService>): CreatorService => ({
  ...createUnhandledCreatorService(),
  ...overrides,
});

const rejectAuthentication: RequestHandler = (_request, _response, next) => {
  next(authenticationRequired());
};

describe('creator API', () => {
  it('creates a workspace for the authenticated actor and returns its revision ETag', async () => {
    const createCreator = vi.fn<CreatorService['createCreator']>().mockResolvedValue(creator);
    const response = await request(
      createTestApp({ creatorService: serviceWith({ createCreator }) }),
    )
      .post('/v1/creators')
      .send({
        customSlug: 'synthetic-creator',
        displayName: 'Synthetic Creator',
        handle: 'synthetic_creator',
      });

    expect(response.status).toBe(201);
    expect(response.headers.etag).toBe('"1"');
    expect(response.body).toEqual({ creator });
    expect(createCreator).toHaveBeenCalledWith({
      actorUserId,
      customSlug: 'synthetic-creator',
      displayName: 'Synthetic Creator',
      handle: 'synthetic_creator',
      requestId: response.headers['x-request-id'],
    });
  });

  it('rejects unauthenticated creation and arbitrary ownership fields', async () => {
    const createCreator = vi.fn<CreatorService['createCreator']>();
    const unauthenticated = await request(
      createTestApp({
        authenticate: rejectAuthentication,
        creatorService: serviceWith({ createCreator }),
      }),
    )
      .post('/v1/creators')
      .send({
        customSlug: 'synthetic-creator',
        displayName: 'Synthetic Creator',
        handle: 'synthetic_creator',
      });
    const massAssignment = await request(
      createTestApp({ creatorService: serviceWith({ createCreator }) }),
    )
      .post('/v1/creators')
      .send({
        customSlug: 'synthetic-creator',
        displayName: 'Synthetic Creator',
        handle: 'synthetic_creator',
        ownerUserId: '019c0000-0000-7000-8000-000000000099',
      });

    expect(unauthenticated.status).toBe(401);
    expect(massAssignment.status).toBe(400);
    expect(massAssignment.body).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    expect(createCreator).not.toHaveBeenCalled();
  });

  it('requires If-Match and maps stale creator revisions to 409', async () => {
    const updateCreator = vi
      .fn<CreatorService['updateCreator']>()
      .mockRejectedValue(new CreatorRevisionConflictError(2));
    const app = createTestApp({ creatorService: serviceWith({ updateCreator }) });
    const missing = await request(app)
      .patch(`/v1/creators/${creator.id}`)
      .send({ displayName: 'Updated' });
    const stale = await request(app)
      .patch(`/v1/creators/${creator.id}`)
      .set('If-Match', '"1"')
      .send({ displayName: 'Updated' });

    expect(missing.status).toBe(428);
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({
      error: { code: 'CREATOR_REVISION_CONFLICT', details: { currentRevision: 2 } },
    });
  });

  it('conceals a creator outside the authenticated tenant scope', async () => {
    const getCreator = vi
      .fn<CreatorService['getCreator']>()
      .mockRejectedValue(new CreatorNotFoundError());
    const response = await request(
      createTestApp({ creatorService: serviceWith({ getCreator }) }),
    ).get(`/v1/creators/${creator.id}`);

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ error: { code: 'CREATOR_NOT_FOUND' } });
    expect(getCreator).toHaveBeenCalledWith({ actorUserId, creatorId: creator.id });
  });

  it('rate-limits creator mutations independently', async () => {
    const createCreator = vi.fn<CreatorService['createCreator']>().mockResolvedValue(creator);
    const options = {
      creatorService: serviceWith({ createCreator }),
      security: {
        allowedOrigins: ['http://localhost:5173'],
        authRateLimitMax: 100,
        authRateLimitWindowMs: 60_000,
        creatorMutationRateLimitMax: 1,
        creatorMutationRateLimitWindowMs: 60_000,
        fairnessMutationRateLimitMax: 100,
        fairnessMutationRateLimitWindowMs: 60_000,
        openingMutationRateLimitMax: 100,
        openingMutationRateLimitWindowMs: 60_000,
        requestBodyLimitBytes: 32_768,
      },
    } as const;
    const app = createTestApp(options);
    const body = {
      customSlug: 'synthetic-creator',
      displayName: 'Synthetic Creator',
      handle: 'synthetic_creator',
    };

    expect((await request(app).post('/v1/creators').send(body)).status).toBe(201);
    const limited = await request(app).post('/v1/creators').send(body);
    expect(limited.status).toBe(429);
    expect(limited.body).toMatchObject({ error: { code: 'RATE_LIMITED' } });
  });
});
