import { Router, type Request, type RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';

import { ApiError } from '../../http/errors.js';
import { createFairnessControllers } from './fairness.controller.js';
import type { FairnessService } from './fairness.service.js';

export interface FairnessRouterOptions {
  readonly authenticate: RequestHandler;
  readonly mutationRateLimitMax: number;
  readonly mutationRateLimitWindowMs: number;
  readonly service: FairnessService;
}

export const createFairnessRouter = ({
  authenticate,
  mutationRateLimitMax,
  mutationRateLimitWindowMs,
  service,
}: FairnessRouterOptions): Router => {
  const router = Router();
  const controllers = createFairnessControllers(service);
  const createLimit = (limit: number, keyGenerator?: (request: Request) => string) =>
    rateLimit({
      handler: (_request, _response, next) => {
        next(new ApiError(429, 'RATE_LIMITED', 'Too many fairness requests.'));
      },
      ...(keyGenerator === undefined ? {} : { keyGenerator }),
      legacyHeaders: false,
      limit,
      standardHeaders: 'draft-8',
      windowMs: mutationRateLimitWindowMs,
    });
  const preAuthenticationLimit = createLimit(Math.max(100, mutationRateLimitMax * 10));
  const actorMutationLimit = createLimit(mutationRateLimitMax, (request) => {
    if (request.actor === undefined) throw new Error('Authenticated fairness actor is missing.');
    return request.actor.user.id;
  });
  const publicReadLimit = createLimit(Math.max(100, mutationRateLimitMax * 10));

  router.get('/fairness/seed-sets/:seedSetId', publicReadLimit, controllers.getPublicSeedSet);
  router.get('/fairness/openings/:publicOpeningId', publicReadLimit, controllers.getOpeningProof);
  router.get('/me/fairness', authenticate, controllers.getCurrent);
  router.post(
    '/me/fairness',
    preAuthenticationLimit,
    authenticate,
    actorMutationLimit,
    controllers.initialize,
  );
  router.put(
    '/me/fairness/client-seed',
    preAuthenticationLimit,
    authenticate,
    actorMutationLimit,
    controllers.updateClientSeed,
  );
  router.post(
    '/me/fairness/rotate',
    preAuthenticationLimit,
    authenticate,
    actorMutationLimit,
    controllers.rotate,
  );

  return router;
};
