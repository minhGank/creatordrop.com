import type { Logger } from '@creatordrop/observability';
import {
  leaderboardScopeKey,
  type LeaderboardAggregate,
  type LeaderboardProjectionStore,
  type LeaderboardScope,
} from '@creatordrop/redis-projections';

import type { LeaderboardRepository } from './leaderboard.repository.js';

export interface LeaderboardRebuildResult {
  readonly eventCount: number;
  readonly rowCount: number;
}

export interface LeaderboardReconciler {
  rebuild(): Promise<LeaderboardRebuildResult>;
  reconcile(): Promise<readonly string[]>;
}

const compareRows = (left: LeaderboardAggregate, right: LeaderboardAggregate): number => {
  const pointOrder = BigInt(right.points) - BigInt(left.points);
  if (pointOrder !== 0n) return pointOrder > 0n ? 1 : -1;
  const reachedOrder = BigInt(left.scoreReachedAtMicros) - BigInt(right.scoreReachedAtMicros);
  if (reachedOrder !== 0n) return reachedOrder > 0n ? 1 : -1;
  return left.userId.localeCompare(right.userId);
};

const scopeOf = (row: LeaderboardAggregate): LeaderboardScope => ({
  creatorId: row.creatorId,
  periodType: row.periodType,
  scopeType: row.scopeType,
  seasonId: row.seasonId,
});

export const createLeaderboardReconciler = (
  repository: LeaderboardRepository,
  store: LeaderboardProjectionStore,
): LeaderboardReconciler => ({
  rebuild: async () => {
    const generation = await store.beginRebuild();
    try {
      const { events, rows } = await repository.readRebuildSnapshot();
      for (const row of rows) await store.writeRebuildAggregate(generation, row);
      for (const event of events) {
        await store.markRebuildEvent(generation, event.eventId, event.openingId);
      }
      await store.completeRebuild(generation);
      return { eventCount: events.length, rowCount: rows.length };
    } catch (error) {
      await store.abortRebuild(generation);
      throw error;
    }
  },
  reconcile: async () => {
    const { rows } = await repository.readRebuildSnapshot();
    const expected = new Map<string, LeaderboardAggregate[]>();
    for (const row of rows) {
      const key = leaderboardScopeKey(row);
      const values = expected.get(key) ?? [];
      values.push(row);
      expected.set(key, values);
    }
    const projectedScopes = await store.listProjectedScopes();
    const issues: string[] = [];
    for (const scope of projectedScopes) {
      if (!expected.has(scope)) issues.push(`EXTRA_SCOPE:${scope}`);
    }
    for (const [scopeKey, expectedRows] of expected) {
      expectedRows.sort(compareRows);
      const firstExpected = expectedRows[0];
      if (firstExpected === undefined) continue;
      const projection = await store.read(scopeOf(firstExpected), Math.max(1, expectedRows.length));
      if (projection === undefined) {
        issues.push(`MISSING_SCOPE:${scopeKey}`);
        continue;
      }
      if (projection.rows.length !== expectedRows.length) {
        issues.push(`ROW_COUNT:${scopeKey}`);
        continue;
      }
      for (const [index, expectedRow] of expectedRows.entries()) {
        const actual = projection.rows[index];
        if (
          actual?.rank !== index + 1 ||
          actual.userId !== expectedRow.userId ||
          actual.username !== expectedRow.username ||
          actual.points !== expectedRow.points ||
          actual.totalOpenings !== expectedRow.totalOpenings ||
          actual.baseRewardWins !== expectedRow.baseRewardWins ||
          actual.scoreReachedAt !== expectedRow.scoreReachedAt
        ) {
          issues.push(`ROW_DRIFT:${scopeKey}:${expectedRow.userId}`);
        }
      }
      if (projection.asOf !== firstExpected.asOf) issues.push(`AS_OF:${scopeKey}`);
    }
    return issues.sort();
  },
});

export const finalizeEndedSeasons = async (input: {
  readonly logger: Logger;
  readonly reconciler: LeaderboardReconciler;
  readonly repository: LeaderboardRepository;
}): Promise<number> => {
  const seasons = await input.repository.readEndedSeasons();
  let finalized = 0;
  for (const seasonId of seasons) {
    let issues = await input.reconciler.reconcile();
    if (issues.length > 0) {
      input.logger.info('leaderboard.drift.detected', { issueCount: issues.length, seasonId });
      await input.reconciler.rebuild();
      issues = await input.reconciler.reconcile();
    }
    if (issues.length > 0) throw new Error('Leaderboard drift remained after rebuild.');
    await input.repository.finalizeSeason(seasonId);
    finalized += 1;
    input.logger.info('leaderboard.season.finalized', { seasonId });
  }
  return finalized;
};
