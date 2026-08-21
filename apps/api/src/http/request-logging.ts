import type { RequestHandler } from 'express';

import type { Logger } from '@creatordrop/observability';

export interface RequestLoggingOptions {
  readonly logger: Logger;
  readonly now?: () => number;
}

export const requestLoggingMiddleware =
  ({ logger, now = () => performance.now() }: RequestLoggingOptions): RequestHandler =>
  (request, response, next) => {
    const startedAt = now();

    response.once('finish', () => {
      logger.info('request.completed', {
        durationMs: Math.max(0, Math.round(now() - startedAt)),
        method: request.method,
        path: request.path,
        requestId: request.requestId,
        statusCode: response.statusCode,
      });
    });

    next();
  };
