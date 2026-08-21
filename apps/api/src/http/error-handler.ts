import type { ErrorRequestHandler, RequestHandler } from 'express';

import type { ApiErrorResponse } from '@creatordrop/contracts';
import type { Logger } from '@creatordrop/observability';

import { ApiError } from './errors.js';

const hasErrorType = (value: unknown, expectedType: string): boolean =>
  typeof value === 'object' && value !== null && 'type' in value && value.type === expectedType;

const normalizeError = (error: unknown): ApiError => {
  if (error instanceof ApiError) {
    return error;
  }

  if (hasErrorType(error, 'entity.too.large')) {
    return new ApiError(413, 'REQUEST_BODY_TOO_LARGE', 'The request body exceeds the size limit.');
  }

  if (hasErrorType(error, 'entity.parse.failed')) {
    return new ApiError(400, 'MALFORMED_JSON', 'The request body is not valid JSON.');
  }

  return new ApiError(500, 'INTERNAL_ERROR', 'An unexpected error occurred.');
};

export const notFoundHandler: RequestHandler = (_request, _response, next) => {
  next(new ApiError(404, 'NOT_FOUND', 'The requested resource was not found.'));
};

export const createErrorHandler =
  (logger: Logger): ErrorRequestHandler =>
  (error: unknown, request, response, next) => {
    if (response.headersSent) {
      next(error);
      return;
    }

    const apiError = normalizeError(error);
    const attributes = {
      errorCode: apiError.code,
      method: request.method,
      path: request.path,
      requestId: request.requestId,
      statusCode: apiError.status,
    };

    if (apiError.status >= 500) {
      logger.error('request.failed', attributes);
    } else {
      logger.info('request.rejected', attributes);
    }

    const body: ApiErrorResponse = {
      error: {
        code: apiError.code,
        details: apiError.details,
        message: apiError.message,
        requestId: request.requestId,
      },
    };

    response.status(apiError.status).json(body);
  };
