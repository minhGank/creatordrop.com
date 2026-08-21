import type { RequestHandler } from 'express';

import type { AuthSessionResponse } from '@creatordrop/contracts';

import { ApiError } from '../../http/errors.js';

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const validateEmptyBody = (body: unknown): void => {
  if (body === undefined) {
    return;
  }

  if (!isPlainRecord(body)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'The request body must be a JSON object.');
  }

  const unknownFields = Object.keys(body);

  if (unknownFields.length > 0) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'The request contains unknown fields.', {
      unknownFields,
    });
  }
};

export const validateSessionExchangeRequest: RequestHandler = (request, _response, next) => {
  try {
    if (request.get('content-type') !== undefined && !request.is('application/json')) {
      throw new ApiError(
        415,
        'UNSUPPORTED_MEDIA_TYPE',
        'Request bodies must use application/json.',
      );
    }

    validateEmptyBody(request.body);
    next();
  } catch (error) {
    next(error);
  }
};

export const exchangeSession: RequestHandler<never, AuthSessionResponse> = (request, response) => {
  if (request.actor === undefined) {
    throw new Error('Authentication middleware did not attach an actor.');
  }

  response.status(200).json({
    user: {
      id: request.actor.user.id,
      status: request.actor.user.status,
      username: request.actor.user.username,
    },
  });
};
