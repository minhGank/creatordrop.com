import type { Database } from '@creatordrop/database';

export interface PublicLeaderboardRow {
  readonly asOf: string;
  readonly baseRewardWins: string;
  readonly points: string;
  readonly rank: number;
  readonly scoreReachedAt: string;
  readonly totalOpenings: string;
  readonly username: string;
}

export interface PublicLeaderboardSeason {
  readonly endsAt: string;
  readonly finalizedAt: string | null;
  readonly id: string;
  readonly name: string;
  readonly ordinal: number;
  readonly startsAt: string;
  readonly status: 'active' | 'finalized' | 'scheduled';
}

export interface PublicAchievement {
  readonly achievementType: 'creator_season_champion' | 'global_season_champion';
  readonly awardedAt: string;
  readonly creatorId: string | null;
  readonly seasonId: string;
  readonly seasonName: string;
}

export interface LeaderboardRepository {
  readAchievements(username: string): Promise<
    | {
        readonly achievements: readonly PublicAchievement[];
        readonly username: string;
      }
    | undefined
  >;
  readLeaderboard(input: {
    readonly creatorId: string | null;
    readonly scope: 'creator_all_time' | 'creator_season' | 'global_all_time' | 'global_season';
    readonly seasonId: string | null;
  }): Promise<readonly PublicLeaderboardRow[]>;
  readSeason(seasonId: string): Promise<PublicLeaderboardSeason | undefined>;
}

interface LeaderboardRow {
  readonly asOf: Date;
  readonly baseRewardWins: string;
  readonly points: string;
  readonly rank: string;
  readonly scoreReachedAt: Date;
  readonly totalOpenings: string;
  readonly username: string;
}

interface SeasonRow {
  readonly endsAt: Date;
  readonly finalizedAt: Date | null;
  readonly id: string;
  readonly name: string;
  readonly ordinal: number;
  readonly startsAt: Date;
  readonly status: string;
}

const requireSeasonStatus = (value: string): 'active' | 'finalized' | 'scheduled' => {
  if (value !== 'active' && value !== 'finalized' && value !== 'scheduled') {
    throw new Error('Database returned an invalid leaderboard season status.');
  }
  return value;
};

const requireAchievementType = (
  value: string,
): 'creator_season_champion' | 'global_season_champion' => {
  if (value !== 'creator_season_champion' && value !== 'global_season_champion') {
    throw new Error('Database returned an invalid achievement type.');
  }
  return value;
};

export const createLeaderboardRepository = (database: Database): LeaderboardRepository => ({
  readAchievements: async (username) => {
    const user = await database.query<{ readonly username: string }>(
      `select username::text as username from app.users where username = $1::extensions.citext`,
      [username],
    );
    const canonicalUsername = user.rows[0]?.username;
    if (canonicalUsername === undefined) return undefined;
    const result = await database.query<{
      readonly achievementType: string;
      readonly awardedAt: Date;
      readonly creatorId: string | null;
      readonly seasonId: string;
      readonly seasonName: string;
    }>(
      `select achievement_type as "achievementType", season_id as "seasonId",
              season_name as "seasonName", creator_id as "creatorId", awarded_at as "awardedAt"
         from app.read_public_user_achievements($1)`,
      [canonicalUsername],
    );
    return {
      achievements: result.rows.map((row) => ({
        ...row,
        achievementType: requireAchievementType(row.achievementType),
        awardedAt: row.awardedAt.toISOString(),
      })),
      username: canonicalUsername,
    };
  },
  readLeaderboard: async ({ creatorId, scope, seasonId }) => {
    const result = await database.query<LeaderboardRow>(
      `select rank, username, points, total_openings as "totalOpenings",
              base_reward_wins as "baseRewardWins", score_reached_at as "scoreReachedAt",
              as_of as "asOf"
         from app.read_public_leaderboard($1,$2,$3,$4)`,
      [scope, creatorId, seasonId, 100],
    );
    return result.rows.map((row) => {
      const rank = Number(row.rank);
      if (!Number.isSafeInteger(rank) || rank < 1) {
        throw new Error('Database returned an invalid leaderboard rank.');
      }
      return {
        ...row,
        asOf: row.asOf.toISOString(),
        rank,
        scoreReachedAt: row.scoreReachedAt.toISOString(),
      };
    });
  },
  readSeason: async (seasonId) => {
    const result = await database.query<SeasonRow>(
      `select id, ordinal, name, starts_at as "startsAt", ends_at as "endsAt",
              status, finalized_at as "finalizedAt"
         from app.read_public_leaderboard_season($1)`,
      [seasonId],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      ...row,
      endsAt: row.endsAt.toISOString(),
      finalizedAt: row.finalizedAt?.toISOString() ?? null,
      startsAt: row.startsAt.toISOString(),
      status: requireSeasonStatus(row.status),
    };
  },
});
