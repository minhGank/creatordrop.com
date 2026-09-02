import { Router } from 'express';

import { createLeaderboardControllers } from './leaderboard.controller.js';
import type { LeaderboardService } from './leaderboard.service.js';

export const createLeaderboardRouter = (service: LeaderboardService): Router => {
  const router = Router();
  const controllers = createLeaderboardControllers(service);
  router.get('/leaderboards/global', controllers.globalAllTime);
  router.get('/leaderboards/global/seasons/:seasonId', controllers.globalSeason);
  router.get('/creators/:creatorId/leaderboard', controllers.creatorAllTime);
  router.get('/creators/:creatorId/leaderboard/seasons/:seasonId', controllers.creatorSeason);
  router.get('/users/:username/achievements', controllers.userAchievements);
  return router;
};
