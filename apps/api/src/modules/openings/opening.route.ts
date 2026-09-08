import { Router, type Request, type RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';

import { ApiError } from '../../http/errors.js';
import {
  createOpeningController,
  createOpeningEntitlementStateController,
} from './opening.controller.js';
import type { OpeningService } from './opening.service.js';

export const createOpeningRouter = (options: {
  readonly authenticate: RequestHandler;
  readonly mutationRateLimitMax: number;
  readonly mutationRateLimitWindowMs: number;
  readonly service: OpeningService;
}): Router => {
  const router = Router();
  const createLimit = (limit: number, keyGenerator?: (request: Request) => string) =>
    rateLimit({
      handler: (_request, _response, next) => {
        next(new ApiError(429, 'RATE_LIMITED', 'Too many box-opening requests.'));
      },
      ...(keyGenerator === undefined ? {} : { keyGenerator }),
      legacyHeaders: false,
      limit,
      standardHeaders: 'draft-8',
      windowMs: options.mutationRateLimitWindowMs,
    });
  const preAuthenticationLimit = createLimit(Math.max(100, options.mutationRateLimitMax * 10));
  const actorMutationLimit = createLimit(options.mutationRateLimitMax, (request) => {
    if (request.actor === undefined) throw new Error('Authenticated opening actor is missing.');
    return request.actor.user.id;
  });
  router.get(
    '/boxes/:boxId/opening-entitlement',
    preAuthenticationLimit,
    options.authenticate,
    createOpeningEntitlementStateController(options.service),
  );
  router.post(
    '/boxes/:boxId/open',
    preAuthenticationLimit,
    options.authenticate,
    actorMutationLimit,
    createOpeningController(options.service),
  );
  return router;
};
