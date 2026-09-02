import cors from 'cors';
import express, { type Express, type Request, type RequestHandler, type Response } from 'express';
import helmet from 'helmet';

import type { ServiceStatusResponse } from '@creatordrop/contracts';
import type { Logger } from '@creatordrop/observability';

import { createCorsOptions } from './http/cors.js';
import { createErrorHandler, notFoundHandler } from './http/error-handler.js';
import { requestIdMiddleware } from './http/request-id.js';
import { requestLoggingMiddleware } from './http/request-logging.js';
import { createAuthRouter } from './modules/auth/auth.route.js';
import { createCatalogRouter } from './modules/catalog/catalog.route.js';
import type { CatalogService } from './modules/catalog/catalog.service.js';
import { createCreatorRouter } from './modules/creators/creator.route.js';
import type { CreatorService } from './modules/creators/creator.service.js';
import { createFairnessRouter } from './modules/fairness/fairness.route.js';
import type { FairnessService } from './modules/fairness/fairness.service.js';
import { createFulfillmentRouter } from './modules/fulfillment/fulfillment.route.js';
import type { FulfillmentService } from './modules/fulfillment/fulfillment.service.js';
import { createLeaderboardRouter } from './modules/leaderboards/leaderboard.route.js';
import type { LeaderboardService } from './modules/leaderboards/leaderboard.service.js';
import { createOpeningRouter } from './modules/openings/opening.route.js';
import type { OpeningService } from './modules/openings/opening.service.js';
import {
  createPaymentRouter,
  createStripeWebhookRouter,
} from './modules/payments/payment.route.js';
import type { PaymentService } from './modules/payments/payment.service.js';
import { createWalletRouter } from './modules/wallet/wallet.route.js';
import type { WalletService } from './modules/wallet/wallet.service.js';

const sendStatus =
  (status: ServiceStatusResponse['status']) =>
  (_request: Request, response: Response<ServiceStatusResponse>): void => {
    response.status(200).json({ service: 'api', status });
  };

export interface AppOptions {
  readonly authenticate: RequestHandler;
  readonly catalogService: CatalogService;
  readonly creatorService: CreatorService;
  readonly fairnessService: FairnessService;
  readonly fulfillmentService?: FulfillmentService;
  readonly logger: Logger;
  readonly leaderboardService?: LeaderboardService;
  readonly openingService?: OpeningService;
  readonly paymentService?: PaymentService;
  readonly runtime: {
    readonly testCreditsEnabled: boolean;
    readonly stripeFundingEnabled?: boolean;
  };
  readonly security: {
    readonly allowedOrigins: readonly string[];
    readonly authRateLimitMax: number;
    readonly authRateLimitWindowMs: number;
    readonly creatorMutationRateLimitMax: number;
    readonly creatorMutationRateLimitWindowMs: number;
    readonly fairnessMutationRateLimitMax: number;
    readonly fairnessMutationRateLimitWindowMs: number;
    readonly requestBodyLimitBytes: number;
    readonly stripeWebhookBodyLimitBytes?: number;
    readonly walletMutationRateLimitMax: number;
    readonly walletMutationRateLimitWindowMs: number;
  };
  readonly walletService: WalletService;
}

export const createApp = ({
  authenticate,
  catalogService,
  creatorService,
  fairnessService,
  fulfillmentService,
  leaderboardService,
  logger,
  openingService,
  paymentService,
  runtime,
  security,
  walletService,
}: AppOptions): Express => {
  const app = express();

  app.disable('x-powered-by');
  app.use(requestIdMiddleware());
  app.use(requestLoggingMiddleware({ logger }));
  app.use(helmet());
  app.use(cors(createCorsOptions(security.allowedOrigins)));
  if (runtime.stripeFundingEnabled && paymentService !== undefined) {
    app.use(
      '/v1/webhooks',
      createStripeWebhookRouter({
        bodyLimitBytes: security.stripeWebhookBodyLimitBytes ?? 262_144,
        service: paymentService,
      }),
    );
  }
  app.use(express.json({ limit: security.requestBodyLimitBytes }));
  app.get('/health', sendStatus('ok'));
  app.get('/ready', sendStatus('ready'));
  if (leaderboardService !== undefined) {
    app.use('/v1', createLeaderboardRouter(leaderboardService));
  }
  app.use(
    '/v1/auth',
    createAuthRouter({
      authenticate,
      rateLimitMax: security.authRateLimitMax,
      rateLimitWindowMs: security.authRateLimitWindowMs,
    }),
  );
  if (openingService !== undefined) {
    app.use(
      '/v1',
      createOpeningRouter({
        authenticate,
        mutationRateLimitMax: security.walletMutationRateLimitMax,
        mutationRateLimitWindowMs: security.walletMutationRateLimitWindowMs,
        service: openingService,
      }),
    );
  }
  app.use(
    '/v1',
    createCatalogRouter({
      authenticate,
      mutationRateLimitMax: security.creatorMutationRateLimitMax,
      mutationRateLimitWindowMs: security.creatorMutationRateLimitWindowMs,
      service: catalogService,
    }),
  );
  if (runtime.stripeFundingEnabled && paymentService !== undefined) {
    app.use(
      '/v1',
      createPaymentRouter({
        authenticate,
        mutationRateLimitMax: security.walletMutationRateLimitMax,
        mutationRateLimitWindowMs: security.walletMutationRateLimitWindowMs,
        service: paymentService,
      }),
    );
  }
  app.use(
    '/v1',
    createFairnessRouter({
      authenticate,
      mutationRateLimitMax: security.fairnessMutationRateLimitMax,
      mutationRateLimitWindowMs: security.fairnessMutationRateLimitWindowMs,
      service: fairnessService,
    }),
  );
  if (fulfillmentService !== undefined) {
    app.use(
      '/v1',
      createFulfillmentRouter({
        authenticate,
        mutationRateLimitMax: security.creatorMutationRateLimitMax,
        mutationRateLimitWindowMs: security.creatorMutationRateLimitWindowMs,
        service: fulfillmentService,
      }),
    );
  }
  app.use(
    '/v1',
    createWalletRouter({
      authenticate,
      mutationRateLimitMax: security.walletMutationRateLimitMax,
      mutationRateLimitWindowMs: security.walletMutationRateLimitWindowMs,
      service: walletService,
      testCreditsEnabled: runtime.testCreditsEnabled,
    }),
  );
  app.use(
    '/v1',
    createCreatorRouter({
      authenticate,
      mutationRateLimitMax: security.creatorMutationRateLimitMax,
      mutationRateLimitWindowMs: security.creatorMutationRateLimitWindowMs,
      service: creatorService,
    }),
  );
  app.use(notFoundHandler);
  app.use(createErrorHandler(logger));

  return app;
};
