import type { RequestHandler } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import type { Logger, LogAttributes } from '@creatordrop/observability';

import { accountNotActive, authenticationRequired } from '../src/http/errors.js';
import type { ApiError } from '../src/http/errors.js';
import { createTestApp, createTestAppOptions } from './support/test-app.js';

const createRejectingAuthentication =
  (error: ApiError): RequestHandler =>
  (_request, _response, next) => {
    next(error);
  };

describe('request security', () => {
  it('accepts only strictly formatted client request IDs', async () => {
    const accepted = await request(createTestApp())
      .get('/health')
      .set('X-Request-Id', 'client-request_123');
    const replaced = await request(createTestApp())
      .get('/health')
      .set('X-Request-Id', 'bad request id with spaces');

    expect(accepted.headers['x-request-id']).toBe('client-request_123');
    expect(replaced.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/u);
    expect(replaced.headers['x-request-id']).not.toBe('bad request id with spaces');
  });

  it('applies a strict CORS allowlist', async () => {
    const allowed = await request(createTestApp())
      .get('/health')
      .set('Origin', 'http://localhost:5173');
    const denied = await request(createTestApp())
      .get('/health')
      .set('Origin', 'https://attacker.example.test');

    expect(allowed.status).toBe(200);
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ error: { code: 'CORS_ORIGIN_DENIED' } });
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('returns consistent request-correlated 401 and 403 envelopes', async () => {
    const unauthenticated = await request(
      createTestApp({ authenticate: createRejectingAuthentication(authenticationRequired()) }),
    )
      .post('/v1/auth/session/exchange')
      .send({});
    const forbidden = await request(
      createTestApp({ authenticate: createRejectingAuthentication(accountNotActive()) }),
    )
      .post('/v1/auth/session/exchange')
      .set('X-Request-Id', 'forbidden-request-123')
      .send({});

    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.body).toMatchObject({
      error: {
        code: 'AUTHENTICATION_REQUIRED',
        details: {},
        requestId: unauthenticated.headers['x-request-id'],
      },
    });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body).toMatchObject({
      error: {
        code: 'ACCOUNT_NOT_ACTIVE',
        requestId: 'forbidden-request-123',
      },
    });
  });

  it('rejects unknown fields before authentication can bootstrap a user', async () => {
    const authenticate = vi.fn<RequestHandler>((_request, _response, next) => next());
    const response = await request(createTestApp({ authenticate }))
      .post('/v1/auth/session/exchange')
      .send({ userId: 'attacker-controlled' });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: {
        code: 'VALIDATION_ERROR',
        details: { unknownFields: ['userId'] },
      },
    });
    expect(authenticate).not.toHaveBeenCalled();
  });

  it('enforces the configured JSON body limit', async () => {
    const options = createTestAppOptions();
    const response = await request(
      createTestApp({
        ...options,
        security: { ...options.security, requestBodyLimitBytes: 1024 },
      }),
    )
      .post('/v1/auth/session/exchange')
      .send({ padding: 'x'.repeat(2048) });

    expect(response.status).toBe(413);
    expect(response.body).toMatchObject({ error: { code: 'REQUEST_BODY_TOO_LARGE' } });
  });

  it('rate-limits the bootstrap endpoint in memory', async () => {
    const options = createTestAppOptions();
    const app = createTestApp({
      ...options,
      security: { ...options.security, authRateLimitMax: 2 },
    });

    expect((await request(app).post('/v1/auth/session/exchange').send({})).status).toBe(200);
    expect((await request(app).post('/v1/auth/session/exchange').send({})).status).toBe(200);

    const limited = await request(app).post('/v1/auth/session/exchange').send({});
    expect(limited.status).toBe(429);
    expect(limited.body).toMatchObject({ error: { code: 'RATE_LIMITED' } });
  });

  it('never includes bearer tokens in structured request or error logs', async () => {
    const token = 'synthetic.bearer.token-that-must-not-appear';
    const records: { attributes: LogAttributes | undefined; message: string }[] = [];
    const logger: Logger = {
      error: (message, attributes) => records.push({ attributes, message }),
      info: (message, attributes) => records.push({ attributes, message }),
    };
    const response = await request(
      createTestApp({
        authenticate: createRejectingAuthentication(authenticationRequired()),
        logger,
      }),
    )
      .post('/v1/auth/session/exchange')
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(response.status).toBe(401);
    expect(JSON.stringify(records)).not.toContain(token);
    expect(records.map((record) => record.message)).toContain('request.rejected');
    expect(records.map((record) => record.message)).toContain('request.completed');
  });
});
