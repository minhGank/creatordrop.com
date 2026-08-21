import { Router, type RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';

import { ApiError } from '../../http/errors.js';
import { createCatalogControllers } from './catalog.controller.js';
import type { CatalogService } from './catalog.service.js';

export interface CatalogRouterOptions {
  readonly authenticate: RequestHandler;
  readonly mutationRateLimitMax: number;
  readonly mutationRateLimitWindowMs: number;
  readonly service: CatalogService;
}

export const createCatalogRouter = ({
  authenticate,
  mutationRateLimitMax,
  mutationRateLimitWindowMs,
  service,
}: CatalogRouterOptions): Router => {
  const router = Router();
  const controllers = createCatalogControllers(service);
  const mutationLimit = rateLimit({
    handler: (_request, _response, next) => {
      next(new ApiError(429, 'RATE_LIMITED', 'Too many catalog mutation requests.'));
    },
    legacyHeaders: false,
    limit: mutationRateLimitMax,
    standardHeaders: 'draft-8',
    windowMs: mutationRateLimitWindowMs,
  });

  router.get('/boxes/:boxId', controllers.getPublicBox);
  router.get('/boxes/:boxId/versions/:versionId', controllers.getPublicBoxVersion);

  router.get('/creators/:creatorId/boxes', authenticate, controllers.listBoxes);
  router.post('/creators/:creatorId/boxes', mutationLimit, authenticate, controllers.createBox);
  router.get('/creators/:creatorId/boxes/:boxId', authenticate, controllers.getBox);
  router.patch(
    '/creators/:creatorId/boxes/:boxId/draft',
    mutationLimit,
    authenticate,
    controllers.updateBox,
  );
  router.get(
    '/creators/:creatorId/boxes/:boxId/draft/rewards',
    authenticate,
    controllers.getDraftConfiguration,
  );
  router.put(
    '/creators/:creatorId/boxes/:boxId/draft/rewards',
    mutationLimit,
    authenticate,
    controllers.replaceDraftConfiguration,
  );
  router.post(
    '/creators/:creatorId/boxes/:boxId/publish',
    mutationLimit,
    authenticate,
    controllers.publishBox,
  );
  router.post(
    '/creators/:creatorId/boxes/:boxId/archive',
    mutationLimit,
    authenticate,
    controllers.archiveBox,
  );
  router.get(
    '/creators/:creatorId/boxes/:boxId/versions',
    authenticate,
    controllers.listBoxVersions,
  );

  router.get('/creators/:creatorId/rewards', authenticate, controllers.listRewards);
  router.post(
    '/creators/:creatorId/rewards',
    mutationLimit,
    authenticate,
    controllers.createReward,
  );
  router.get('/creators/:creatorId/rewards/:rewardId', authenticate, controllers.getReward);
  router.patch(
    '/creators/:creatorId/rewards/:rewardId/draft',
    mutationLimit,
    authenticate,
    controllers.updateReward,
  );
  router.post(
    '/creators/:creatorId/rewards/:rewardId/archive',
    mutationLimit,
    authenticate,
    controllers.archiveReward,
  );
  router.get(
    '/creators/:creatorId/rewards/:rewardId/versions',
    authenticate,
    controllers.listRewardVersions,
  );

  return router;
};
