import { Router, type Request, type RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';

import { ApiError } from '../../http/errors.js';
import { createFulfillmentControllers } from './fulfillment.controller.js';
import type { FulfillmentService } from './fulfillment.service.js';

export interface FulfillmentRouterOptions {
  readonly authenticate: RequestHandler;
  readonly mutationRateLimitMax: number;
  readonly mutationRateLimitWindowMs: number;
  readonly service: FulfillmentService;
}

export const createFulfillmentRouter = ({
  authenticate,
  mutationRateLimitMax,
  mutationRateLimitWindowMs,
  service,
}: FulfillmentRouterOptions): Router => {
  const router = Router();
  const controllers = createFulfillmentControllers(service);
  const mutationLimit = rateLimit({
    handler: (_request, _response, next) => {
      next(new ApiError(429, 'RATE_LIMITED', 'Too many fulfillment mutation requests.'));
    },
    keyGenerator: (request: Request) => {
      if (request.actor === undefined)
        throw new Error('Authenticated fulfillment actor is missing.');
      return request.actor.user.id;
    },
    legacyHeaders: false,
    limit: mutationRateLimitMax,
    standardHeaders: 'draft-8',
    windowMs: mutationRateLimitWindowMs,
  });

  router.get('/me/fulfillments', authenticate, controllers.listUserFulfillments);
  router.get('/me/fulfillments/:fulfillmentId', authenticate, controllers.getUserFulfillment);
  router.get(
    '/me/fulfillments/:fulfillmentId/delivery-data',
    authenticate,
    controllers.getUserDeliveryData,
  );
  router.post(
    '/me/fulfillments/:fulfillmentId/address',
    authenticate,
    mutationLimit,
    controllers.submitAddress,
  );
  router.post(
    '/me/fulfillments/:fulfillmentId/delivery-data/redact',
    authenticate,
    mutationLimit,
    controllers.redactUserDeliveryData,
  );
  router.get(
    '/creators/:creatorId/dashboard/fulfillments',
    authenticate,
    controllers.listCreatorFulfillments,
  );
  router.get(
    '/creators/:creatorId/dashboard/fulfillments/:fulfillmentId',
    authenticate,
    controllers.getCreatorFulfillment,
  );
  router.post(
    '/creators/:creatorId/dashboard/fulfillments/:fulfillmentId/actions',
    authenticate,
    mutationLimit,
    controllers.creatorAction,
  );
  router.post(
    '/creators/:creatorId/dashboard/fulfillments/:fulfillmentId/delivery-data/access',
    authenticate,
    mutationLimit,
    controllers.getCreatorDeliveryData,
  );
  router.post(
    '/creators/:creatorId/dashboard/fulfillments/:fulfillmentId/delivery-data/redact',
    authenticate,
    mutationLimit,
    controllers.redactCreatorDeliveryData,
  );
  router.post(
    '/creators/:creatorId/dashboard/inventory-pools/:poolId/restocks',
    authenticate,
    mutationLimit,
    controllers.restock,
  );
  return router;
};
