import { createDatabasePool } from '@creatordrop/database';
import { createConsoleLogger } from '@creatordrop/observability';
import {
  createLeaderboardProjectionStore,
  createRedisConnection,
} from '@creatordrop/redis-projections';

import { getWorkerEnvironment } from '../config/environment.js';
import { createLeaderboardReconciler } from './leaderboard.maintenance.js';
import { createLeaderboardRepository } from './leaderboard.repository.js';

export const runLeaderboardMaintenance = async (
  operation: 'rebuild' | 'reconcile',
): Promise<unknown> => {
  const environment = getWorkerEnvironment();
  if (environment.redisUrl === null) throw new Error('REDIS_URL is required for maintenance.');
  const logger = createConsoleLogger({ service: `worker-leaderboard-${operation}` });
  const database = createDatabasePool({
    ...environment.database,
    onUnexpectedPoolError: (error) =>
      logger.error('database.pool.failed', { errorName: error.name }),
  });
  const redis = createRedisConnection({
    onError: (error) => logger.error('redis.connection.failed', { errorName: error.name }),
    url: environment.redisUrl,
  });
  try {
    const reconciler = createLeaderboardReconciler(
      createLeaderboardRepository(database),
      createLeaderboardProjectionStore(redis),
    );
    return operation === 'rebuild' ? await reconciler.rebuild() : await reconciler.reconcile();
  } finally {
    await Promise.all([database.close(), redis.close()]);
  }
};
