import express, { Router, type Request, type RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';

import { ApiError } from '../../http/errors.js';
import { createPaymentControllers } from './payment.controller.js';
import type { PaymentService } from './payment.service.js';

export const createStripeWebhookRouter = (input: {
  readonly bodyLimitBytes: number;
  readonly service: PaymentService;
}): Router => {
  const router = Router();
  const controllers = createPaymentControllers(input.service);
  router.post(
    '/stripe',
    express.raw({ limit: input.bodyLimitBytes, type: 'application/json' }),
    controllers.stripeWebhook,
  );
  return router;
};

export const createPaymentRouter = (input: {
  readonly authenticate: RequestHandler;
  readonly mutationRateLimitMax: number;
  readonly mutationRateLimitWindowMs: number;
  readonly service: PaymentService;
}): Router => {
  const router = Router();
  const controllers = createPaymentControllers(input.service);
  const limiter = (limit: number, keyGenerator?: (request: Request) => string) =>
    rateLimit({
      ...(keyGenerator === undefined ? {} : { keyGenerator }),
      handler: (_request, _response, next) => {
        next(new ApiError(429, 'RATE_LIMITED', 'Too many wallet funding requests.'));
      },
      legacyHeaders: false,
      limit,
      standardHeaders: 'draft-8',
      windowMs: input.mutationRateLimitWindowMs,
    });
  const preAuthenticationLimit = limiter(Math.max(100, input.mutationRateLimitMax * 10));
  const actorLimit = limiter(input.mutationRateLimitMax, (request) => {
    if (request.actor === undefined) throw new Error('Authenticated payment actor is missing.');
    return request.actor.user.id;
  });
  router.post(
    '/me/wallets/:currency/funding-intents',
    preAuthenticationLimit,
    input.authenticate,
    actorLimit,
    controllers.createFundingIntent,
  );
  return router;
};
