import { randomUUID } from 'node:crypto';

import { createDatabasePool } from '@creatordrop/database';
import { createConsoleLogger } from '@creatordrop/observability';
import { createSocketRealtimePublisher } from './adapters/realtime.publisher.js';
import { getWorkerEnvironment } from './config/environment.js';
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
    // R3 retains historical projection modules without running rankings or season jobs.
    try {
      await processor.processBatch();
    } catch (error) {
      logger.error('worker.batch.failed', {
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
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
      return database.close();
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
