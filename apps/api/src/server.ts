import { createConsoleLogger } from '@creatordrop/observability';
import { createDatabasePool } from '@creatordrop/database';

import { createApp } from './app.js';
import {
  getApiEnvironment,
  getDatabaseEnvironment,
  getRngEnvironment,
} from './config/environment.js';
import { createAuthenticationMiddleware } from './modules/auth/authentication.middleware.js';
import { createJwtVerifier } from './modules/auth/jwt-verifier.js';
import { createCatalogService } from './modules/catalog/catalog.service.js';
import { createUserBootstrapService } from './modules/users/bootstrap-user.service.js';
import { createCreatorService } from './modules/creators/creator.service.js';
import { createEnvironmentSeedEncryptionKeyProvider } from './modules/fairness/fairness.key-provider.js';
import { createFairnessService } from './modules/fairness/fairness.service.js';

const environment = getApiEnvironment();
const databaseEnvironment = getDatabaseEnvironment();
const rngEnvironment = getRngEnvironment();
const logger = createConsoleLogger({ service: 'api' });
const database = createDatabasePool({
  ...databaseEnvironment,
  onUnexpectedPoolError: (error) => {
    logger.error('database.pool.failed', { errorName: error.name });
  },
});
const verifyAccessToken = createJwtVerifier({
  audience: environment.authAudience,
  issuer: environment.authIssuer,
  jwksUrl: environment.authJwksUrl,
  provider: environment.authProvider,
});
const authenticate = createAuthenticationMiddleware({
  bootstrapUsers: createUserBootstrapService({ database }),
  verifyAccessToken,
});
const creatorService = createCreatorService({ database, logger });
const catalogService = createCatalogService({ database, logger });
const fairnessService = createFairnessService({
  database,
  keyProvider: createEnvironmentSeedEncryptionKeyProvider({
    historicalKeys: rngEnvironment.historicalMasterKeys,
    keyHex: rngEnvironment.masterKeyHex,
    version: rngEnvironment.masterKeyVersion,
  }),
  logger,
  policy: {
    maxAgeMs: rngEnvironment.maxSeedAgeMs,
    maxOpenings: rngEnvironment.maxOpeningsPerSeed,
  },
});
const app = createApp({
  authenticate,
  catalogService,
  creatorService,
  fairnessService,
  logger,
  security: {
    allowedOrigins: environment.corsAllowedOrigins,
    authRateLimitMax: environment.authRateLimitMax,
    authRateLimitWindowMs: environment.authRateLimitWindowMs,
    creatorMutationRateLimitMax: environment.creatorMutationRateLimitMax,
    creatorMutationRateLimitWindowMs: environment.creatorMutationRateLimitWindowMs,
    fairnessMutationRateLimitMax: rngEnvironment.fairnessMutationRateLimitMax,
    fairnessMutationRateLimitWindowMs: rngEnvironment.fairnessMutationRateLimitWindowMs,
    requestBodyLimitBytes: environment.requestBodyLimitBytes,
  },
});

const server = app.listen(environment.port, environment.host, () => {
  logger.info('api.listening', { host: environment.host, port: environment.port });
});

const shutdown = (signal: NodeJS.Signals): void => {
  logger.info('api.shutdown.started', { signal });
  server.close((error) => {
    if (error !== undefined) {
      logger.error('api.shutdown.failed', { errorName: error.name });
      process.exitCode = 1;
    }

    void database.close().catch((databaseError: unknown) => {
      logger.error('database.shutdown.failed', {
        errorName: databaseError instanceof Error ? databaseError.name : 'UnknownError',
      });
      process.exitCode = 1;
    });
  });
};

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
