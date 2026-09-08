import type { NextFunction, Request, RequestHandler, Response } from 'express';

import type { BoxOpeningResponse, OpeningV2EntitlementStateResponse } from '@creatordrop/contracts';

import { ApiError } from '../../http/errors.js';
import type { UserId } from '../creators/creator.js';
import { trustedUserId } from '../creators/creator.schema.js';
import {
  parseEmptyOpeningQuery,
  parseOpeningBody,
  parseOpeningBoxId,
  parseOpeningIdempotencyKey,
} from './opening.schema.js';
import type { OpeningService } from './opening.service.js';

const run = (operation: () => Promise<void>, next: NextFunction): void => {
  void operation().catch(next);
};

const parameter = (value: string | string[] | undefined): string | undefined =>
  typeof value === 'string' ? value : undefined;

const requireActorUserId = (request: Request): UserId => {
  if (request.actor === undefined) throw new Error('Authenticated opening actor is missing.');
  return trustedUserId(request.actor.user.id);
};

export const createOpeningController =
  (service: OpeningService): RequestHandler =>
  (request, response: Response<BoxOpeningResponse>, next) => {
    run(async () => {
      if (!request.is('application/json')) {
        throw new ApiError(
          415,
          'UNSUPPORTED_MEDIA_TYPE',
          'Request bodies must use application/json.',
        );
      }
      parseEmptyOpeningQuery(request.query);
      const result = await service.openBox({
        ...parseOpeningBody(request.body),
        boxId: parseOpeningBoxId(parameter(request.params.boxId)),
        idempotencyKey: parseOpeningIdempotencyKey(request.get('idempotency-key')),
        requestId: request.requestId,
        userId: requireActorUserId(request),
      });
      response.status(result.statusCode).json(result.body);
    }, next);
  };

export const createOpeningEntitlementStateController =
  (service: OpeningService): RequestHandler =>
  (request, response: Response<OpeningV2EntitlementStateResponse>, next) => {
    run(async () => {
      parseEmptyOpeningQuery(request.query);
      const result = await service.getEntitlementState({
        boxId: parseOpeningBoxId(parameter(request.params.boxId)),
        userId: requireActorUserId(request),
      });
      response.status(200).json(result);
    }, next);
  };

export const createProgressionController =
  (service: OpeningService): RequestHandler =>
  (request, response, next) => {
    run(async () => {
      parseEmptyOpeningQuery(request.query);
      response.set('Cache-Control', 'private, no-store');
      response.status(200).json(await service.getProgression(requireActorUserId(request)));
    }, next);
  };
