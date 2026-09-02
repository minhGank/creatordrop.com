import type { Logger } from '@creatordrop/observability';
import type { LeaderboardProjectionStore } from '@creatordrop/redis-projections';

import { retryDelayMs } from '../outbox/outbox.policy.js';
import type { LeaderboardRepository } from './leaderboard.repository.js';

export interface LeaderboardProjectionProcessorOptions {
  readonly batchSize: number;
  readonly leaseMs: number;
  readonly logger: Logger;
  readonly maxAttempts: number;
  readonly now?: () => Date;
  readonly repository: LeaderboardRepository;
  readonly retryBaseMs: number;
  readonly retryMaxMs: number;
  readonly store: LeaderboardProjectionStore;
  readonly workerId: string;
}

export const createLeaderboardProjectionProcessor = ({
  batchSize,
  leaseMs,
  logger,
  maxAttempts,
  now = () => new Date(),
  repository,
  retryBaseMs,
  retryMaxMs,
  store,
  workerId,
}: LeaderboardProjectionProcessorOptions): { processBatch(): Promise<number> } => ({
  processBatch: async () => {
    const claims = await repository.claim({ batchSize, leaseMs, maxAttempts, workerId });
    await Promise.all(
      claims.map(async (claim) => {
        try {
          const snapshot = await repository.readSnapshot(claim.eventId);
          if (snapshot === undefined) throw new Error('INVALID_PROJECTION_EVENT');
          const disposition = await store.apply(snapshot);
          await repository.complete(claim.eventId, claim.claimToken);
          logger.info('leaderboard.projection.applied', {
            disposition,
            eventId: claim.eventId,
          });
        } catch (error) {
          const invalid = error instanceof Error && error.message === 'INVALID_PROJECTION_EVENT';
          const terminal = invalid || claim.attemptCount >= maxAttempts;
          await repository.fail({
            claimToken: claim.claimToken,
            eventId: claim.eventId,
            failureCode: invalid ? 'INVALID_PROJECTION_EVENT' : 'REDIS_UNAVAILABLE',
            retryAt: new Date(
              now().getTime() + retryDelayMs(claim.attemptCount, retryBaseMs, retryMaxMs),
            ),
            terminal,
          });
          logger.info('leaderboard.projection.failed', {
            eventId: claim.eventId,
            terminal,
          });
        }
      }),
    );
    return claims.length;
  },
});
