import type { RequestHandler } from 'express';

import type { Logger } from '@creatordrop/observability';

import { createApp, type AppOptions } from '../../src/app.js';

export const createNoopLogger = (): Logger => ({
  error: () => undefined,
  info: () => undefined,
});

export const createSuccessfulAuthentication = (): RequestHandler => (request, _response, next) => {
  request.actor = {
    provider: 'synthetic-provider',
    subject: 'synthetic-subject',
    user: {
      id: '019c0000-0000-7000-8000-000000000001',
      status: 'active',
      username: 'synthetic_user',
    },
  };
  next();
};

export const createTestAppOptions = (overrides: Partial<AppOptions> = {}): AppOptions => ({
  authenticate: createSuccessfulAuthentication(),
  logger: createNoopLogger(),
  security: {
    allowedOrigins: ['http://localhost:5173'],
    authRateLimitMax: 100,
    authRateLimitWindowMs: 60_000,
    requestBodyLimitBytes: 32_768,
  },
  ...overrides,
});

export const createTestApp = (overrides: Partial<AppOptions> = {}) =>
  createApp(createTestAppOptions(overrides));
