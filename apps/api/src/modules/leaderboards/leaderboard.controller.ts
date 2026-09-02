import type { NextFunction, RequestHandler, Response } from 'express';

import type { PublicAchievementsResponse, PublicLeaderboardResponse } from '@creatordrop/contracts';

import { ApiError } from '../../http/errors.js';
import { parseLeaderboardUsername, parseLeaderboardUuid } from './leaderboard.schema.js';
import type { LeaderboardService } from './leaderboard.service.js';

const run = (operation: () => Promise<void>, next: NextFunction): void => {
  void operation().catch(next);
};

const parameter = (value: string | string[] | undefined): string | undefined =>
  typeof value === 'string' ? value : undefined;

const notFound = (): ApiError =>
  new ApiError(404, 'LEADERBOARD_NOT_FOUND', 'The leaderboard resource was not found.');

export interface LeaderboardControllers {
  readonly creatorAllTime: RequestHandler;
  readonly creatorSeason: RequestHandler;
  readonly globalAllTime: RequestHandler;
  readonly globalSeason: RequestHandler;
  readonly userAchievements: RequestHandler;
}

export const createLeaderboardControllers = (
  service: LeaderboardService,
): LeaderboardControllers => ({
  creatorAllTime: (request, response: Response<PublicLeaderboardResponse>, next) => {
    run(async () => {
      const result = await service.readLeaderboard({
        creatorId: parseLeaderboardUuid(parameter(request.params.creatorId), 'creatorId'),
        periodType: 'all_time',
        scopeType: 'creator',
        seasonId: null,
      });
      if (result === undefined) throw notFound();
      response.status(200).json(result);
    }, next);
  },
  creatorSeason: (request, response: Response<PublicLeaderboardResponse>, next) => {
    run(async () => {
      const result = await service.readLeaderboard({
        creatorId: parseLeaderboardUuid(parameter(request.params.creatorId), 'creatorId'),
        periodType: 'season',
        scopeType: 'creator',
        seasonId: parseLeaderboardUuid(parameter(request.params.seasonId), 'seasonId'),
      });
      if (result === undefined) throw notFound();
      response.status(200).json(result);
    }, next);
  },
  globalAllTime: (_request, response: Response<PublicLeaderboardResponse>, next) => {
    run(async () => {
      const result = await service.readLeaderboard({
        creatorId: null,
        periodType: 'all_time',
        scopeType: 'global',
        seasonId: null,
      });
      if (result === undefined) throw notFound();
      response.status(200).json(result);
    }, next);
  },
  globalSeason: (request, response: Response<PublicLeaderboardResponse>, next) => {
    run(async () => {
      const result = await service.readLeaderboard({
        creatorId: null,
        periodType: 'season',
        scopeType: 'global',
        seasonId: parseLeaderboardUuid(parameter(request.params.seasonId), 'seasonId'),
      });
      if (result === undefined) throw notFound();
      response.status(200).json(result);
    }, next);
  },
  userAchievements: (request, response: Response<PublicAchievementsResponse>, next) => {
    run(async () => {
      const result = await service.readAchievements(
        parseLeaderboardUsername(parameter(request.params.username)),
      );
      if (result === undefined) throw notFound();
      response.status(200).json(result);
    }, next);
  },
});
