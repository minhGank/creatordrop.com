import { Router, type RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';

import { ApiError } from '../../http/errors.js';
import { exchangeSession, validateSessionExchangeRequest } from './auth.controller.js';

export interface AuthRouterOptions {
  readonly authenticate: RequestHandler;
  readonly rateLimitMax: number;
  readonly rateLimitWindowMs: number;
}

export const createAuthRouter = ({
  authenticate,
  rateLimitMax,
  rateLimitWindowMs,
}: AuthRouterOptions): Router => {
  const router = Router();
  const bootstrapRateLimit = rateLimit({
    handler: (_request, _response, next) => {
      next(new ApiError(429, 'RATE_LIMITED', 'Too many authentication requests.'));
    },
    legacyHeaders: false,
    limit: rateLimitMax,
    standardHeaders: 'draft-8',
    windowMs: rateLimitWindowMs,
  });

  router.post(
    '/session/exchange',
    bootstrapRateLimit,
    validateSessionExchangeRequest,
    authenticate,
    exchangeSession,
  );

  return router;
};
