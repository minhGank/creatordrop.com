import type { NextFunction, Request, RequestHandler, Response } from 'express';

import type {
  BoxDraftRewardsResponse,
  BoxResponse,
  BoxesResponse,
  BoxVersionsResponse,
  PublishedBoxVersionResponse,
  RewardResponse,
  RewardsResponse,
  RewardVersionsResponse,
} from '@creatordrop/contracts';

import { ApiError } from '../../http/errors.js';
import type { UserId } from '../creators/creator.js';
import { trustedUserId } from '../creators/creator.schema.js';
import {
  parseBoxDraftInput,
  parseBoxId,
  parseBoxVersionId,
  parseCatalogCreatorId,
  parseDraftRewardConfiguration,
  parseExpectedCatalogRevision,
  parseRewardDraftInput,
  parseRewardId,
} from './catalog.schema.js';
import type { CatalogReadScope, CatalogService } from './catalog.service.js';

const run = (operation: () => Promise<void>, next: NextFunction): void => {
  void operation().catch(next);
};

const requireJson = (request: Request): void => {
  if (!request.is('application/json')) {
    throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Request bodies must use application/json.');
  }
};

const parameter = (value: string | string[] | undefined): string | undefined =>
  typeof value === 'string' ? value : undefined;

const actorUserId = (request: Request): UserId => {
  if (request.actor === undefined) {
    throw new Error('Authentication middleware did not attach an actor.');
  }
  return trustedUserId(request.actor.user.id);
};

const scope = (request: Request): CatalogReadScope => ({
  actorUserId: actorUserId(request),
  creatorId: parseCatalogCreatorId(parameter(request.params.creatorId)),
});

const commandContext = (request: Request) => ({
  ...scope(request),
  requestId: request.requestId,
});

const revision = (request: Request): number =>
  parseExpectedCatalogRevision(request.get('if-match'));

const setRevisionEtag = (response: Response, value: number): void => {
  response.setHeader('ETag', `"${value.toString()}"`);
};

export interface CatalogControllers {
  readonly archiveBox: RequestHandler;
  readonly archiveReward: RequestHandler;
  readonly createBox: RequestHandler;
  readonly createReward: RequestHandler;
  readonly getBox: RequestHandler;
  readonly getDraftConfiguration: RequestHandler;
  readonly getPublicBox: RequestHandler;
  readonly getPublicBoxVersion: RequestHandler;
  readonly getReward: RequestHandler;
  readonly listBoxes: RequestHandler;
  readonly listBoxVersions: RequestHandler;
  readonly listRewards: RequestHandler;
  readonly listRewardVersions: RequestHandler;
  readonly publishBox: RequestHandler;
  readonly replaceDraftConfiguration: RequestHandler;
  readonly updateBox: RequestHandler;
  readonly updateReward: RequestHandler;
}

export const createCatalogControllers = (service: CatalogService): CatalogControllers => ({
  createBox: (request, response: Response<BoxResponse>, next) => {
    run(async () => {
      requireJson(request);
      const box = await service.createBox({
        ...commandContext(request),
        ...parseBoxDraftInput(request.body),
      });
      setRevisionEtag(response, box.revision);
      response.status(201).json({ box });
    }, next);
  },

  listBoxes: (request, response: Response<BoxesResponse>, next) => {
    run(async () => {
      response.status(200).json({ boxes: await service.listBoxes(scope(request)) });
    }, next);
  },

  getBox: (request, response: Response<BoxResponse>, next) => {
    run(async () => {
      const box = await service.getBox(scope(request), parseBoxId(parameter(request.params.boxId)));
      setRevisionEtag(response, box.revision);
      response.status(200).json({ box });
    }, next);
  },

  updateBox: (request, response: Response<BoxResponse>, next) => {
    run(async () => {
      requireJson(request);
      const box = await service.updateBox({
        ...commandContext(request),
        ...parseBoxDraftInput(request.body),
        boxId: parseBoxId(parameter(request.params.boxId)),
        expectedRevision: revision(request),
      });
      setRevisionEtag(response, box.revision);
      response.status(200).json({ box });
    }, next);
  },

  createReward: (request, response: Response<RewardResponse>, next) => {
    run(async () => {
      requireJson(request);
      const reward = await service.createReward({
        ...commandContext(request),
        ...parseRewardDraftInput(request.body),
      });
      setRevisionEtag(response, reward.revision);
      response.status(201).json({ reward });
    }, next);
  },

  listRewards: (request, response: Response<RewardsResponse>, next) => {
    run(async () => {
      response.status(200).json({ rewards: await service.listRewards(scope(request)) });
    }, next);
  },

  getReward: (request, response: Response<RewardResponse>, next) => {
    run(async () => {
      const reward = await service.getReward(
        scope(request),
        parseRewardId(parameter(request.params.rewardId)),
      );
      setRevisionEtag(response, reward.revision);
      response.status(200).json({ reward });
    }, next);
  },

  updateReward: (request, response: Response<RewardResponse>, next) => {
    run(async () => {
      requireJson(request);
      const reward = await service.updateReward({
        ...commandContext(request),
        ...parseRewardDraftInput(request.body),
        expectedRevision: revision(request),
        rewardId: parseRewardId(parameter(request.params.rewardId)),
      });
      setRevisionEtag(response, reward.revision);
      response.status(200).json({ reward });
    }, next);
  },

  getDraftConfiguration: (request, response: Response<BoxDraftRewardsResponse>, next) => {
    run(async () => {
      const entries = await service.getDraftConfiguration(
        scope(request),
        parseBoxId(parameter(request.params.boxId)),
      );
      response.status(200).json({ entries });
    }, next);
  },

  replaceDraftConfiguration: (request, response: Response<BoxDraftRewardsResponse>, next) => {
    run(async () => {
      requireJson(request);
      const expectedRevision = revision(request);
      const entries = await service.replaceDraftConfiguration({
        ...commandContext(request),
        ...parseDraftRewardConfiguration(request.body),
        boxId: parseBoxId(parameter(request.params.boxId)),
        expectedRevision,
      });
      setRevisionEtag(response, expectedRevision + 1);
      response.status(200).json({ entries });
    }, next);
  },

  publishBox: (request, response: Response<PublishedBoxVersionResponse>, next) => {
    run(async () => {
      const expectedRevision = revision(request);
      const result = await service.publishBox({
        ...commandContext(request),
        boxId: parseBoxId(parameter(request.params.boxId)),
        expectedRevision,
      });
      setRevisionEtag(response, expectedRevision + 1);
      response.status(200).json(result);
    }, next);
  },

  listBoxVersions: (request, response: Response<BoxVersionsResponse>, next) => {
    run(async () => {
      const versions = await service.listBoxVersions(
        scope(request),
        parseBoxId(parameter(request.params.boxId)),
      );
      response.status(200).json({ versions });
    }, next);
  },

  listRewardVersions: (request, response: Response<RewardVersionsResponse>, next) => {
    run(async () => {
      const versions = await service.listRewardVersions(
        scope(request),
        parseRewardId(parameter(request.params.rewardId)),
      );
      response.status(200).json({ versions });
    }, next);
  },

  getPublicBox: (request, response: Response<PublishedBoxVersionResponse>, next) => {
    run(async () => {
      response
        .status(200)
        .json(await service.getPublicBox(parseBoxId(parameter(request.params.boxId))));
    }, next);
  },

  getPublicBoxVersion: (request, response: Response<PublishedBoxVersionResponse>, next) => {
    run(async () => {
      response
        .status(200)
        .json(
          await service.getPublicBoxVersion(
            parseBoxId(parameter(request.params.boxId)),
            parseBoxVersionId(parameter(request.params.versionId)),
          ),
        );
    }, next);
  },

  archiveBox: (request, response: Response<BoxResponse>, next) => {
    run(async () => {
      const box = await service.archiveBox({
        ...commandContext(request),
        boxId: parseBoxId(parameter(request.params.boxId)),
        expectedRevision: revision(request),
      });
      setRevisionEtag(response, box.revision);
      response.status(200).json({ box });
    }, next);
  },

  archiveReward: (request, response: Response<RewardResponse>, next) => {
    run(async () => {
      const reward = await service.archiveReward({
        ...commandContext(request),
        expectedRevision: revision(request),
        rewardId: parseRewardId(parameter(request.params.rewardId)),
      });
      setRevisionEtag(response, reward.revision);
      response.status(200).json({ reward });
    }, next);
  },
});
