import { createConsoleLogger } from '@creatordrop/observability';

import { getWorkerEnvironment } from './config/environment.js';
import { startWorkerRuntime } from './runtime.js';

const environment = getWorkerEnvironment();
const logger = createConsoleLogger({ service: 'worker' });
const runtime = startWorkerRuntime({ pollIntervalMs: environment.pollIntervalMs });

logger.info('worker lifecycle started; no jobs are registered in Phase 1');

const shutdown = (signal: NodeJS.Signals): void => {
  logger.info(`received ${signal}; shutting down`);
  runtime.stop();
};

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
