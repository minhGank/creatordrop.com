import type { Database } from '@creatordrop/database';
import type {
  LeaderboardAggregate,
  LeaderboardProjectionEvent,
} from '@creatordrop/redis-projections';

interface ProjectionClaimRow {
  readonly attemptCount: number;
  readonly claimToken: string;
  readonly outboxEventId: string;
}

interface RebuildRow {
  readonly asOf: Date;
  readonly baseRewardWins: string;
  readonly creatorId: string | null;
  readonly periodType: 'all_time' | 'season';
  readonly points: string;
  readonly scoreReachedAt: Date;
  readonly scoreReachedAtMicros: string;
  readonly scopeType: 'creator' | 'global';
  readonly seasonId: string | null;
  readonly totalOpenings: string;
  readonly userId: string;
  readonly username: string;
}

export interface ProjectionClaim {
  readonly attemptCount: number;
  readonly claimToken: string;
  readonly eventId: string;
}

export interface LeaderboardRepository {
  claim(input: {
    readonly batchSize: number;
    readonly leaseMs: number;
    readonly maxAttempts: number;
    readonly workerId: string;
  }): Promise<readonly ProjectionClaim[]>;
  complete(eventId: string, claimToken: string): Promise<void>;
  fail(input: {
    readonly claimToken: string;
    readonly eventId: string;
    readonly failureCode: string;
    readonly retryAt: Date;
    readonly terminal: boolean;
  }): Promise<void>;
  finalizeSeason(seasonId: string): Promise<void>;
  readEndedSeasons(): Promise<readonly string[]>;
  readRebuildSnapshot(): Promise<{
    readonly events: readonly { readonly eventId: string; readonly openingId: string }[];
    readonly rows: readonly LeaderboardAggregate[];
  }>;
  readSnapshot(eventId: string): Promise<LeaderboardProjectionEvent | undefined>;
}

const record = (value: unknown): Readonly<Record<string, unknown>> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid leaderboard snapshot object.');
  }
  return value as Readonly<Record<string, unknown>>;
};
const string = (value: unknown): string => {
  if (typeof value !== 'string') throw new Error('Invalid leaderboard snapshot string.');
  return value;
};
const nullableString = (value: unknown): string | null => (value === null ? null : string(value));
const timestamp = (value: unknown): string => new Date(string(value)).toISOString();

const aggregate = (value: unknown): LeaderboardAggregate => {
  const row = record(value);
  const scopeType = string(row.scopeType);
  const periodType = string(row.periodType);
  if (scopeType !== 'creator' && scopeType !== 'global') throw new Error('Invalid scope type.');
  if (periodType !== 'all_time' && periodType !== 'season') throw new Error('Invalid period type.');
  return {
    asOf: timestamp(row.asOf),
    baseRewardWins: string(row.baseRewardWins),
    creatorId: nullableString(row.creatorId),
    periodType,
    points: string(row.points),
    scoreReachedAt: timestamp(row.scoreReachedAt),
    scoreReachedAtMicros: string(row.scoreReachedAtMicros),
    scopeType,
    seasonId: nullableString(row.seasonId),
    totalOpenings: string(row.totalOpenings),
    userId: string(row.userId),
    username: string(row.username),
  };
};

export const createLeaderboardRepository = (database: Database): LeaderboardRepository => ({
  claim: async ({ batchSize, leaseMs, maxAttempts, workerId }) => {
    const result = await database.query<ProjectionClaimRow>(
      `select outbox_event_id as "outboxEventId", claim_token as "claimToken",
              attempt_count as "attemptCount"
         from app.claim_leaderboard_projection_events($1,$2,$3,$4)`,
      [workerId, batchSize, leaseMs, maxAttempts],
    );
    return result.rows.map((row) => ({
      attemptCount: row.attemptCount,
      claimToken: row.claimToken,
      eventId: row.outboxEventId,
    }));
  },
  complete: async (eventId, claimToken) => {
    await database.query(`select app.complete_leaderboard_projection_event($1,$2)`, [
      eventId,
      claimToken,
    ]);
  },
  fail: async ({ claimToken, eventId, failureCode, retryAt, terminal }) => {
    await database.query(`select app.fail_leaderboard_projection_event($1,$2,$3,$4,$5)`, [
      eventId,
      claimToken,
      failureCode,
      retryAt,
      terminal,
    ]);
  },
  finalizeSeason: async (seasonId) => {
    await database.query(`select * from app.finalize_leaderboard_season($1)`, [seasonId]);
  },
  readEndedSeasons: async () => {
    const result = await database.query<{ readonly seasonId: string }>(
      `select season_id as "seasonId" from app.read_ended_active_leaderboard_seasons()`,
    );
    return result.rows.map(({ seasonId }) => seasonId);
  },
  readRebuildSnapshot: async () =>
    database.transaction(
      async (transaction) => {
        const rows = await transaction.query<RebuildRow>(
          `select scope_type as "scopeType", period_type as "periodType",
                  creator_id as "creatorId", season_id as "seasonId", user_id as "userId",
                  username, points, total_openings as "totalOpenings",
                  base_reward_wins as "baseRewardWins", score_reached_at as "scoreReachedAt",
                  score_reached_at_micros as "scoreReachedAtMicros", as_of as "asOf"
             from app.read_leaderboard_rebuild_rows()`,
        );
        const events = await transaction.query<{
          readonly eventId: string;
          readonly openingId: string;
        }>(
          `select event_id as "eventId", opening_id as "openingId"
             from app.read_leaderboard_projection_event_ids()`,
        );
        return {
          events: events.rows,
          rows: rows.rows.map((row) => ({
            ...row,
            asOf: row.asOf.toISOString(),
            scoreReachedAt: row.scoreReachedAt.toISOString(),
          })),
        };
      },
      { isolationLevel: 'repeatable-read', readOnly: true },
    ),
  readSnapshot: async (eventId) => {
    const result = await database.query<{ readonly snapshot: unknown }>(
      `select app.read_leaderboard_projection_snapshot($1) as snapshot`,
      [eventId],
    );
    const value = result.rows[0]?.snapshot;
    if (value === null || value === undefined) return undefined;
    const snapshot = record(value);
    if (!Array.isArray(snapshot.boards)) throw new Error('Invalid leaderboard board list.');
    return {
      boards: snapshot.boards.map(aggregate),
      eventId: string(snapshot.eventId),
      openingId: string(snapshot.openingId),
    };
  },
});
