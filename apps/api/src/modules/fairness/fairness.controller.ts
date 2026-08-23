import type { NextFunction, Request, RequestHandler, Response } from 'express';

import type {
  CurrentFairnessResponse,
  PublicRngSeedSetResponse,
  RngSeedRotationResponse,
} from '@creatordrop/contracts';

import { ApiError } from '../../http/errors.js';
import type { UserId } from '../creators/creator.js';
import { trustedUserId } from '../creators/creator.schema.js';
import {
  parseClientSeedInput,
  parseEmptyRotationInput,
  parseFairnessRevision,
  parseRotationIdempotencyKey,
  parseSeedSetId,
} from './fairness.schema.js';
import type { FairnessService } from './fairness.service.js';
import { toPublicSeedSet, type CurrentFairnessState, type SeedRotationResult } from './fairness.js';

const run = (operation: () => Promise<void>, next: NextFunction): void => {
  void operation().catch(next);
};

const requireActorUserId = (request: Request): UserId => {
  if (request.actor === undefined) {
    throw new Error('Authentication middleware did not attach an actor.');
  }
  return trustedUserId(request.actor.user.id);
};

const requireJson = (request: Request): void => {
  if (!request.is('application/json')) {
    throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Request bodies must use application/json.');
  }
};

const parameter = (value: string | string[] | undefined): string | undefined =>
  typeof value === 'string' ? value : undefined;

const setRevisionEtag = (response: Response, revision: number): void => {
  response.setHeader('ETag', `"${revision.toString()}"`);
};

const publicFairness = (fairness: CurrentFairnessState): CurrentFairnessResponse['fairness'] => ({
  activeSeedSet: toPublicSeedSet(fairness.activeSeedSet),
  clientSeed: fairness.clientSeed,
  revision: fairness.revision,
  rotationPolicy: {
    maxAgeMs: fairness.rotationPolicy.maxAgeMs,
    maxOpenings: fairness.rotationPolicy.maxOpenings,
  },
});

const publicRotation = (result: SeedRotationResult): RngSeedRotationResponse => ({
  newSeedSet: toPublicSeedSet(result.newSeedSet),
  previousSeedSetId: result.previousSeedSetId,
  replayed: result.replayed,
});

export interface FairnessControllers {
  readonly getCurrent: RequestHandler;
  readonly getPublicSeedSet: RequestHandler;
  readonly initialize: RequestHandler;
  readonly rotate: RequestHandler;
  readonly updateClientSeed: RequestHandler;
}

export const createFairnessControllers = (service: FairnessService): FairnessControllers => ({
  getCurrent: (request, response: Response<CurrentFairnessResponse>, next) => {
    run(async () => {
      const fairness = await service.getCurrent(requireActorUserId(request));
      setRevisionEtag(response, fairness.revision);
      response.status(200).json({ fairness: publicFairness(fairness) });
    }, next);
  },

  getPublicSeedSet: (request, response: Response<PublicRngSeedSetResponse>, next) => {
    run(async () => {
      const seedSet = await service.getPublicSeedSet(
        parseSeedSetId(parameter(request.params.seedSetId)),
      );
      response.status(200).json({ seedSet: toPublicSeedSet(seedSet) });
    }, next);
  },

  initialize: (request, response: Response<CurrentFairnessResponse>, next) => {
    run(async () => {
      requireJson(request);
      const result = await service.initialize({
        ...parseClientSeedInput(request.body),
        requestId: request.requestId,
        userId: requireActorUserId(request),
      });
      setRevisionEtag(response, result.fairness.revision);
      response
        .status(result.created ? 201 : 200)
        .json({ fairness: publicFairness(result.fairness) });
    }, next);
  },

  rotate: (request, response: Response<RngSeedRotationResponse>, next) => {
    run(async () => {
      const contentLength = request.get('content-length');
      const transferEncoding = request.get('transfer-encoding');
      const hasBody =
        request.body !== undefined ||
        transferEncoding !== undefined ||
        (contentLength !== undefined && contentLength !== '0');
      if (hasBody) requireJson(request);
      parseEmptyRotationInput(request.body, request.query);
      const result = await service.rotate({
        idempotencyKey: parseRotationIdempotencyKey(request.get('idempotency-key')),
        reason: 'user_request',
        requestId: request.requestId,
        userId: requireActorUserId(request),
      });
      response.status(200).json(publicRotation(result));
    }, next);
  },

  updateClientSeed: (request, response: Response<CurrentFairnessResponse>, next) => {
    run(async () => {
      requireJson(request);
      const fairness = await service.updateClientSeed({
        ...parseClientSeedInput(request.body),
        expectedRevision: parseFairnessRevision(request.get('if-match')),
        requestId: request.requestId,
        userId: requireActorUserId(request),
      });
      setRevisionEtag(response, fairness.revision);
      response.status(200).json({ fairness: publicFairness(fairness) });
    }, next);
  },
});
