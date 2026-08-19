import { createConsoleLogger } from '@creatordrop/observability';

import { createApp } from './app.js';
import { getApiEnvironment } from './config/environment.js';

const environment = getApiEnvironment();
const logger = createConsoleLogger({ service: 'api' });
const app = createApp();

const server = app.listen(environment.port, environment.host, () => {
  logger.info(`listening on http://${environment.host}:${environment.port.toString()}`);
});

const shutdown = (signal: NodeJS.Signals): void => {
  logger.info(`received ${signal}; shutting down`);
  server.close((error) => {
    if (error !== undefined) {
      logger.error('graceful shutdown failed');
      process.exitCode = 1;
    }
  });
};

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
