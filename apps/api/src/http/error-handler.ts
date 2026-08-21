import type { ErrorRequestHandler, RequestHandler } from 'express';

import type { ApiErrorResponse } from '@creatordrop/contracts';
import type { Logger } from '@creatordrop/observability';

import {
  CatalogDraftConflictError,
  CatalogImmutableError,
  CatalogPermissionDeniedError,
  CatalogPublicationError,
  CatalogResourceNotFoundError,
  CatalogRevisionConflictError,
} from '../modules/catalog/catalog.errors.js';
import {
  CreatorFinalOwnerError,
  CreatorIdentityConflictError,
  CreatorMemberConflictError,
  CreatorMemberNotFoundError,
  CreatorNotFoundError,
  CreatorPermissionDeniedError,
  CreatorRevisionConflictError,
  CreatorTargetUserNotFoundError,
} from '../modules/creators/creator.errors.js';
import { ApiError } from './errors.js';

const hasErrorType = (value: unknown, expectedType: string): boolean =>
  typeof value === 'object' && value !== null && 'type' in value && value.type === expectedType;

const databaseErrorAttributes = (error: unknown): Readonly<Record<string, string>> => {
  if (typeof error !== 'object' || error === null) return {};
  const attributes: Record<string, string> = {};
  if ('code' in error && typeof error.code === 'string') attributes.databaseCode = error.code;
  if ('constraint' in error && typeof error.constraint === 'string') {
    attributes.databaseConstraint = error.constraint;
  }
  return attributes;
};

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

  if (error instanceof CreatorNotFoundError) {
    return new ApiError(404, 'CREATOR_NOT_FOUND', 'The creator workspace was not found.');
  }

  if (error instanceof CreatorPermissionDeniedError) {
    return new ApiError(403, 'CREATOR_FORBIDDEN', 'The creator action is not permitted.');
  }

  if (error instanceof CreatorIdentityConflictError) {
    return new ApiError(
      409,
      'CREATOR_IDENTITY_CONFLICT',
      'The creator handle or custom slug is already in use.',
    );
  }

  if (error instanceof CreatorRevisionConflictError) {
    return new ApiError(409, 'CREATOR_REVISION_CONFLICT', 'The creator revision is stale.', {
      currentRevision: error.currentRevision,
    });
  }

  if (error instanceof CreatorMemberConflictError) {
    return new ApiError(409, 'CREATOR_MEMBER_CONFLICT', 'The user is already a creator member.');
  }

  if (error instanceof CreatorMemberNotFoundError) {
    return new ApiError(404, 'CREATOR_MEMBER_NOT_FOUND', 'The creator member was not found.');
  }

  if (error instanceof CreatorTargetUserNotFoundError) {
    return new ApiError(404, 'USER_NOT_FOUND', 'The target active user was not found.');
  }

  if (error instanceof CreatorFinalOwnerError) {
    return new ApiError(
      409,
      'FINAL_OWNER_REQUIRED',
      'An active creator must retain at least one owner.',
    );
  }

  if (error instanceof CatalogResourceNotFoundError) {
    return new ApiError(404, 'CATALOG_NOT_FOUND', 'The catalog resource was not found.');
  }

  if (error instanceof CatalogPermissionDeniedError) {
    return new ApiError(403, 'CATALOG_FORBIDDEN', 'The catalog action is not permitted.');
  }

  if (error instanceof CatalogRevisionConflictError) {
    return new ApiError(409, 'CATALOG_REVISION_CONFLICT', 'The catalog revision is stale.', {
      currentRevision: error.currentRevision,
    });
  }

  if (error instanceof CatalogDraftConflictError) {
    return new ApiError(409, 'CATALOG_DRAFT_CONFLICT', error.message);
  }

  if (error instanceof CatalogPublicationError) {
    return new ApiError(422, `CATALOG_PUBLICATION_${error.reason}`, error.message);
  }

  if (error instanceof CatalogImmutableError) {
    return new ApiError(409, 'CATALOG_IMMUTABLE', 'Published catalog configuration is immutable.');
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
      errorName: error instanceof Error ? error.name : 'UnknownError',
      ...databaseErrorAttributes(error),
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
