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

const sendStatus =
  (status: ServiceStatusResponse['status']) =>
  (_request: Request, response: Response<ServiceStatusResponse>): void => {
    response.status(200).json({ service: 'api', status });
  };

export interface AppOptions {
  readonly authenticate: RequestHandler;
  readonly logger: Logger;
  readonly security: {
    readonly allowedOrigins: readonly string[];
    readonly authRateLimitMax: number;
    readonly authRateLimitWindowMs: number;
    readonly requestBodyLimitBytes: number;
  };
}

export const createApp = ({ authenticate, logger, security }: AppOptions): Express => {
  const app = express();

  app.disable('x-powered-by');
  app.use(requestIdMiddleware());
  app.use(requestLoggingMiddleware({ logger }));
  app.use(helmet());
  app.use(cors(createCorsOptions(security.allowedOrigins)));
  app.use(express.json({ limit: security.requestBodyLimitBytes }));
  app.get('/health', sendStatus('ok'));
  app.get('/ready', sendStatus('ready'));
  app.use(
    '/v1/auth',
    createAuthRouter({
      authenticate,
      rateLimitMax: security.authRateLimitMax,
      rateLimitWindowMs: security.authRateLimitWindowMs,
    }),
  );
  app.use(notFoundHandler);
  app.use(createErrorHandler(logger));

  return app;
};
