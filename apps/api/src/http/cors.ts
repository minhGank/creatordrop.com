import type { CorsOptions } from 'cors';

import { ApiError } from './errors.js';

export const createCorsOptions = (allowedOrigins: readonly string[]): CorsOptions => ({
  allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'If-Match', 'X-Request-Id'],
  credentials: false,
  exposedHeaders: ['ETag', 'X-Request-Id', 'RateLimit', 'RateLimit-Policy'],
  maxAge: 600,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  origin: (origin, callback) => {
    if (origin === undefined || allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }

    callback(new ApiError(403, 'CORS_ORIGIN_DENIED', 'The request origin is not allowed.'));
  },
});
