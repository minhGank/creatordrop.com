import type {
  PublicAchievementsResponse,
  PublicLeaderboardEntryContract,
  PublicLeaderboardResponse,
} from '@creatordrop/contracts';
import type { Logger } from '@creatordrop/observability';
import type { LeaderboardProjectionStore, LeaderboardScope } from '@creatordrop/redis-projections';

import type { LeaderboardRepository } from './leaderboard.repository.js';

export interface LeaderboardService {
  readAchievements(username: string): Promise<PublicAchievementsResponse | undefined>;
  readLeaderboard(scope: LeaderboardScope): Promise<PublicLeaderboardResponse | undefined>;
}

const entry = (row: {
  readonly baseRewardWins: string;
  readonly points: string;
  readonly rank: number;
  readonly scoreReachedAt: string;
  readonly totalOpenings: string;
  readonly username: string;
}): PublicLeaderboardEntryContract => ({
  baseRewardWins: row.baseRewardWins,
  points: row.points,
  rank: row.rank,
  scoreReachedAt: row.scoreReachedAt,
  totalOpenings: row.totalOpenings,
  user: { username: row.username },
});

const postgresScope = (
  scope: LeaderboardScope,
): 'creator_all_time' | 'creator_season' | 'global_all_time' | 'global_season' =>
  `${scope.scopeType}_${scope.periodType}`;

export const createLeaderboardService = (input: {
  readonly logger: Logger;
  readonly repository: LeaderboardRepository;
  readonly store?: LeaderboardProjectionStore;
}): LeaderboardService => ({
  readAchievements: async (username) => {
    const result = await input.repository.readAchievements(username);
    if (result === undefined) return undefined;
    return {
      achievements: result.achievements.map((achievement) => ({
        achievementType: achievement.achievementType,
        awardedAt: achievement.awardedAt,
        creatorId: achievement.creatorId,
        season: { id: achievement.seasonId, name: achievement.seasonName },
      })),
      user: { username: result.username },
    };
  },
  readLeaderboard: async (scope) => {
    const season =
      scope.seasonId === null ? null : await input.repository.readSeason(scope.seasonId);
    if (scope.seasonId !== null && season === undefined) return undefined;

    if (input.store !== undefined) {
      try {
        const projection = await input.store.read(scope, 100);
        if (projection !== undefined) {
          return {
            asOf: projection.asOf,
            entries: projection.rows.map(entry),
            season: season ?? null,
            source: 'redis',
          };
        }
      } catch (error) {
        input.logger.info('leaderboard.redis.read_failed', {
          errorName: error instanceof Error ? error.name : 'UnknownError',
        });
      }
    }

    const rows = await input.repository.readLeaderboard({
      creatorId: scope.creatorId,
      scope: postgresScope(scope),
      seasonId: scope.seasonId,
    });
    return {
      asOf: rows[0]?.asOf ?? season?.startsAt ?? new Date(0).toISOString(),
      entries: rows.map(entry),
      season: season ?? null,
      source: 'postgres',
    };
  },
});
