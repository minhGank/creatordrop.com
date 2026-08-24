import { Router, type Request, type RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';

import { ApiError } from '../../http/errors.js';
import { createWalletControllers } from './wallet.controller.js';
import type { WalletService } from './wallet.service.js';

export interface WalletRouterOptions {
  readonly authenticate: RequestHandler;
  readonly mutationRateLimitMax: number;
  readonly mutationRateLimitWindowMs: number;
  readonly service: WalletService;
  readonly testCreditsEnabled: boolean;
}

export const createWalletRouter = ({
  authenticate,
  mutationRateLimitMax,
  mutationRateLimitWindowMs,
  service,
  testCreditsEnabled,
}: WalletRouterOptions): Router => {
  const router = Router();
  const controllers = createWalletControllers(service);
  const createLimit = (limit: number, keyGenerator?: (request: Request) => string) =>
    rateLimit({
      handler: (_request, _response, next) => {
        next(new ApiError(429, 'RATE_LIMITED', 'Too many wallet requests.'));
      },
      ...(keyGenerator === undefined ? {} : { keyGenerator }),
      legacyHeaders: false,
      limit,
      standardHeaders: 'draft-8',
      windowMs: mutationRateLimitWindowMs,
    });
  const preAuthenticationLimit = createLimit(Math.max(100, mutationRateLimitMax * 10));
  const actorMutationLimit = createLimit(mutationRateLimitMax, (request) => {
    if (request.actor === undefined) throw new Error('Authenticated wallet actor is missing.');
    return request.actor.user.id;
  });

  router.get('/me/wallets', authenticate, controllers.listWallets);
  if (testCreditsEnabled) {
    router.post(
      '/me/wallets/:currency/test-credits',
      preAuthenticationLimit,
      authenticate,
      actorMutationLimit,
      controllers.grantTestCredits,
    );
  }
  return router;
};
