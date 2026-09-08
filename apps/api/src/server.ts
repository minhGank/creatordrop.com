import { createServer } from 'node:http';

import { createConsoleLogger } from '@creatordrop/observability';
import { createDatabasePool } from '@creatordrop/database';
import { createRedisConnection, createRedisJsonCache } from '@creatordrop/redis-projections';

import { createApp } from './app.js';
import {
  getApiEnvironment,
  getEntryStorageEnvironment,
  getDatabaseEnvironment,
  getFulfillmentEnvironment,
  getRngEnvironment,
  validateCryptographicKeySeparation,
} from './config/environment.js';
import {
  createAccessTokenAuthenticator,
  createAuthenticationMiddleware,
} from './modules/auth/authentication.middleware.js';
import { createJwtVerifier } from './modules/auth/jwt-verifier.js';
import { createCatalogService } from './modules/catalog/catalog.service.js';
import { createPublicCatalogService } from './modules/catalog/public-catalog.service.js';
import { createUserBootstrapService } from './modules/users/bootstrap-user.service.js';
import { createCreatorService } from './modules/creators/creator.service.js';
import { createEnvironmentSeedEncryptionKeyProvider } from './modules/fairness/fairness.key-provider.js';
import { createFairnessService } from './modules/fairness/fairness.service.js';
import { createEnvironmentFulfillmentActorBindingProvider } from './modules/fulfillment/fulfillment.actor-binding.js';
import { createEnvironmentFulfillmentKeyProvider } from './modules/fulfillment/fulfillment.key-provider.js';
import { createFulfillmentService } from './modules/fulfillment/fulfillment.service.js';
import { createCreatorUsageService } from './modules/usage/usage.service.js';
import { createOpeningService } from './modules/openings/opening.service.js';
import { createEntryService } from './modules/entries/entry.service.js';
import { createEntryActorSigner } from './modules/entries/entry.actor-binding.js';
import { createSupabaseEntryStorage } from './modules/entries/entry.storage.js';
import { createRealtimeServer } from './platform/realtime/realtime.server.js';

const environment = getApiEnvironment();
const databaseEnvironment = getDatabaseEnvironment();
const rngEnvironment = getRngEnvironment();
const fulfillmentEnvironment = getFulfillmentEnvironment();
validateCryptographicKeySeparation(rngEnvironment, fulfillmentEnvironment);
const logger = createConsoleLogger({ service: 'api' });
const database = createDatabasePool({
  ...databaseEnvironment,
  onUnexpectedPoolError: (error) => {
    logger.error('database.pool.failed', { errorName: error.name });
  },
});
const redis =
  environment.redisUrl === null
    ? null
    : createRedisConnection({
        onError: (error) => logger.error('redis.connection.failed', { errorName: error.name }),
        url: environment.redisUrl,
      });
const verifyAccessToken = createJwtVerifier({
  audience: environment.authAudience,
  issuer: environment.authIssuer,
  jwksUrl: environment.authJwksUrl,
  provider: environment.authProvider,
});
const bootstrapUsers = createUserBootstrapService({ database });
const authenticationOptions = {
  bootstrapUsers,
  verifyAccessToken,
};
const authenticate = createAuthenticationMiddleware(authenticationOptions);
const authenticateAccessToken = createAccessTokenAuthenticator(authenticationOptions);
const creatorService = createCreatorService({ database, logger });
const catalogService = createCatalogService({
  ...(redis === null
    ? {}
    : {
        cache: {
          redis: createRedisJsonCache(redis),
          ttlSeconds: environment.publicCatalogCacheTtlSeconds,
        },
      }),
  database,
  logger,
});
const publicCatalogService = createPublicCatalogService({ database });
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
const usageService = createCreatorUsageService({ database });
const openingService = createOpeningService({ database, fairnessService, logger });
const entryService = createEntryService({
  database,
  signer: createEntryActorSigner({
    keyHex: fulfillmentEnvironment.actorBinding.keyHex,
    keyVersion: fulfillmentEnvironment.actorBinding.version,
  }),
  storage: createSupabaseEntryStorage(getEntryStorageEnvironment()),
});
const fulfillmentService = createFulfillmentService({
  actorBindingProvider: createEnvironmentFulfillmentActorBindingProvider({
    keyHex: fulfillmentEnvironment.actorBinding.keyHex,
    version: fulfillmentEnvironment.actorBinding.version,
  }),
  database,
  keyProvider: createEnvironmentFulfillmentKeyProvider({
    address: {
      historicalKeys: fulfillmentEnvironment.address.historicalMasterKeys,
      keyHex: fulfillmentEnvironment.address.masterKeyHex,
      version: fulfillmentEnvironment.address.masterKeyVersion,
    },
    digitalSecret: {
      historicalKeys: fulfillmentEnvironment.digitalSecret.historicalMasterKeys,
      keyHex: fulfillmentEnvironment.digitalSecret.masterKeyHex,
      version: fulfillmentEnvironment.digitalSecret.masterKeyVersion,
    },
  }),
  logger,
  retentionMs: fulfillmentEnvironment.retentionMs,
});
const app = createApp({
  authenticate,
  catalogService,
  creatorService,
  fairnessService,
  fulfillmentService,
  logger,
  openingService,
  usageService,
  entryService,
  publicCatalogService,
  security: {
    allowedOrigins: environment.corsAllowedOrigins,
    authRateLimitMax: environment.authRateLimitMax,
    authRateLimitWindowMs: environment.authRateLimitWindowMs,
    creatorMutationRateLimitMax: environment.creatorMutationRateLimitMax,
    creatorMutationRateLimitWindowMs: environment.creatorMutationRateLimitWindowMs,
    fairnessMutationRateLimitMax: rngEnvironment.fairnessMutationRateLimitMax,
    fairnessMutationRateLimitWindowMs: rngEnvironment.fairnessMutationRateLimitWindowMs,
    openingMutationRateLimitMax: environment.openingMutationRateLimitMax,
    openingMutationRateLimitWindowMs: environment.openingMutationRateLimitWindowMs,
    requestBodyLimitBytes: environment.requestBodyLimitBytes,
  },
});

const server = createServer(app);
const realtime = createRealtimeServer({
  allowedOrigins: environment.corsAllowedOrigins,
  authenticateAccessToken,
  httpServer: server,
  logger,
  workerToken: environment.realtimeWorkerToken,
});
server.listen(environment.port, environment.host, () => {
  logger.info('api.listening', { host: environment.host, port: environment.port });
});

const shutdown = (signal: NodeJS.Signals): void => {
  logger.info('api.shutdown.started', { signal });
  void realtime
    .close()
    .then(() => Promise.all([database.close(), redis?.close()]))
    .catch((databaseError: unknown) => {
      logger.error('database.shutdown.failed', {
        errorName: databaseError instanceof Error ? databaseError.name : 'UnknownError',
      });
      process.exitCode = 1;
    });
};

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
