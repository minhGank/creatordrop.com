import { Router, type RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';

import { ApiError } from '../../http/errors.js';
import { createCreatorControllers } from './creator.controller.js';
import type { CreatorService } from './creator.service.js';

export interface CreatorRouterOptions {
  readonly authenticate: RequestHandler;
  readonly mutationRateLimitMax: number;
  readonly mutationRateLimitWindowMs: number;
  readonly service: CreatorService;
}

export const createCreatorRouter = ({
  authenticate,
  mutationRateLimitMax,
  mutationRateLimitWindowMs,
  service,
}: CreatorRouterOptions): Router => {
  const router = Router();
  const controllers = createCreatorControllers(service);
  const mutationRateLimit = rateLimit({
    handler: (_request, _response, next) => {
      next(new ApiError(429, 'RATE_LIMITED', 'Too many creator mutation requests.'));
    },
    legacyHeaders: false,
    limit: mutationRateLimitMax,
    standardHeaders: 'draft-8',
    windowMs: mutationRateLimitWindowMs,
  });

  router.get('/me/creator-memberships', authenticate, controllers.listMyWorkspaces);
  router.post('/creators', mutationRateLimit, authenticate, controllers.createCreator);
  router.get('/creators/:creatorId', authenticate, controllers.getCreator);
  router.patch('/creators/:creatorId', mutationRateLimit, authenticate, controllers.updateCreator);
  router.get('/creators/:creatorId/members', authenticate, controllers.listMembers);
  router.post(
    '/creators/:creatorId/members',
    mutationRateLimit,
    authenticate,
    controllers.addMember,
  );
  router.patch(
    '/creators/:creatorId/members/:userId',
    mutationRateLimit,
    authenticate,
    controllers.updateMember,
  );
  router.delete(
    '/creators/:creatorId/members/:userId',
    mutationRateLimit,
    authenticate,
    controllers.removeMember,
  );

  return router;
};
