import { randomUUID } from 'node:crypto';

import { createDatabasePool } from '@creatordrop/database';
import { createConsoleLogger } from '@creatordrop/observability';
import {
  createLeaderboardProjectionStore,
  createRedisConnection,
} from '@creatordrop/redis-projections';

import { createSocketRealtimePublisher } from './adapters/realtime.publisher.js';
import { getWorkerEnvironment } from './config/environment.js';
import {
  createLeaderboardReconciler,
  finalizeEndedSeasons,
} from './leaderboards/leaderboard.maintenance.js';
import { createLeaderboardProjectionProcessor } from './leaderboards/leaderboard.processor.js';
import { createLeaderboardRepository } from './leaderboards/leaderboard.repository.js';
import { createOutboxProcessor } from './outbox/outbox.processor.js';
import { createOutboxRepository } from './outbox/outbox.repository.js';
import { startWorkerRuntime } from './runtime.js';

const environment = getWorkerEnvironment();
const logger = createConsoleLogger({ service: 'worker' });
const database = createDatabasePool({
  ...environment.database,
  onUnexpectedPoolError: (error) => {
    logger.error('database.pool.failed', { errorName: error.name });
  },
});
const publisher = createSocketRealtimePublisher({
  publishTimeoutMs: environment.publishTimeoutMs,
  realtimeUrl: environment.realtimeUrl,
  workerToken: environment.realtimeWorkerToken,
});
const workerId = `worker:${randomUUID()}`;
const redis =
  environment.redisUrl === null
    ? null
    : createRedisConnection({
        onError: (error) => logger.error('redis.connection.failed', { errorName: error.name }),
        url: environment.redisUrl,
      });
const leaderboardRepository = createLeaderboardRepository(database);
const leaderboardStore = redis === null ? null : createLeaderboardProjectionStore(redis);
const leaderboardReconciler =
  leaderboardStore === null
    ? null
    : createLeaderboardReconciler(leaderboardRepository, leaderboardStore);
const leaderboardProcessor =
  leaderboardStore === null
    ? null
    : createLeaderboardProjectionProcessor({
        batchSize: environment.projectionBatchSize,
        leaseMs: environment.projectionLeaseMs,
        logger,
        maxAttempts: environment.projectionMaxAttempts,
        repository: leaderboardRepository,
        retryBaseMs: environment.retryBaseMs,
        retryMaxMs: environment.retryMaxMs,
        store: leaderboardStore,
        workerId,
      });
const processor = createOutboxProcessor({
  batchSize: environment.batchSize,
  leaseMs: environment.leaseMs,
  logger,
  maxAttempts: environment.maxAttempts,
  publisher,
  repository: createOutboxRepository(database),
  retryBaseMs: environment.retryBaseMs,
  retryMaxMs: environment.retryMaxMs,
  workerId,
});
const runtime = startWorkerRuntime({
  pollIntervalMs: environment.pollIntervalMs,
  runBatch: async () => {
    const batches: Promise<unknown>[] = [processor.processBatch()];
    if (leaderboardProcessor !== null) batches.push(leaderboardProcessor.processBatch());
    const results = await Promise.allSettled(batches);
    for (const result of results) {
      if (result.status === 'rejected') {
        logger.error('worker.batch.failed', {
          errorName: result.reason instanceof Error ? result.reason.name : 'UnknownError',
        });
      }
    }
    if (leaderboardReconciler !== null) {
      try {
        await finalizeEndedSeasons({
          logger,
          reconciler: leaderboardReconciler,
          repository: leaderboardRepository,
        });
      } catch (error) {
        logger.error('leaderboard.finalization.failed', {
          errorName: error instanceof Error ? error.name : 'UnknownError',
        });
      }
    }
  },
});

logger.info('worker.outbox.started', { workerId });

let shuttingDown = false;
const shutdown = (signal: NodeJS.Signals): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('worker.shutdown.started', { signal, workerId });
  void runtime
    .stop()
    .then(() => {
      publisher.close();
      return Promise.all([database.close(), redis?.close()]);
    })
    .catch((error: unknown) => {
      logger.error('worker.shutdown.failed', {
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
      process.exitCode = 1;
    });
};

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
