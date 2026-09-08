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
import { createPublicCatalogRouter } from './modules/catalog/public-catalog.route.js';
import type { PublicCatalogService } from './modules/catalog/public-catalog.service.js';
import { createCreatorRouter } from './modules/creators/creator.route.js';
import type { CreatorService } from './modules/creators/creator.service.js';
import { createFairnessRouter } from './modules/fairness/fairness.route.js';
import type { FairnessService } from './modules/fairness/fairness.service.js';
import { createFulfillmentRouter } from './modules/fulfillment/fulfillment.route.js';
import type { FulfillmentService } from './modules/fulfillment/fulfillment.service.js';
import { createOpeningRouter } from './modules/openings/opening.route.js';
import type { OpeningService } from './modules/openings/opening.service.js';
import type { EntryService } from './modules/entries/entry.service.js';
import { createEntryRouter } from './modules/entries/entry.route.js';

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
  readonly openingService?: OpeningService;
  readonly entryService?: EntryService;
  readonly publicCatalogService?: PublicCatalogService;
  readonly security: {
    readonly allowedOrigins: readonly string[];
    readonly authRateLimitMax: number;
    readonly authRateLimitWindowMs: number;
    readonly creatorMutationRateLimitMax: number;
    readonly creatorMutationRateLimitWindowMs: number;
    readonly fairnessMutationRateLimitMax: number;
    readonly fairnessMutationRateLimitWindowMs: number;
    readonly openingMutationRateLimitMax: number;
    readonly openingMutationRateLimitWindowMs: number;
    readonly requestBodyLimitBytes: number;
  };
}

export const createApp = ({
  authenticate,
  catalogService,
  creatorService,
  fairnessService,
  fulfillmentService,
  logger,
  openingService,
  entryService,
  publicCatalogService,
  security,
}: AppOptions): Express => {
  const app = express();

  app.disable('x-powered-by');
  app.use(requestIdMiddleware());
  app.use(requestLoggingMiddleware({ logger }));
  app.use(helmet());
  app.use(cors(createCorsOptions(security.allowedOrigins)));
  app.use(express.json({ limit: security.requestBodyLimitBytes }));
  if (entryService !== undefined)
    app.use('/v1', createEntryRouter({ authenticate, service: entryService }));
  app.get('/health', sendStatus('ok'));
  app.get('/ready', sendStatus('ready'));
  // R3 retires public point rankings and champion/season surfaces.
  if (publicCatalogService !== undefined) {
    app.use('/v1', createPublicCatalogRouter(publicCatalogService));
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
        mutationRateLimitMax: security.openingMutationRateLimitMax,
        mutationRateLimitWindowMs: security.openingMutationRateLimitWindowMs,
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
