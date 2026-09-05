import type { RequestHandler } from 'express';

import type { Logger } from '@creatordrop/observability';

import { createApp, type AppOptions } from '../../src/app.js';
import type { CatalogService } from '../../src/modules/catalog/catalog.service.js';
import type { CreatorService } from '../../src/modules/creators/creator.service.js';
import type { FairnessService } from '../../src/modules/fairness/fairness.service.js';
import type { WalletService } from '../../src/modules/wallet/wallet.service.js';

export const createNoopLogger = (): Logger => ({
  error: () => undefined,
  info: () => undefined,
});

export const createSuccessfulAuthentication = (): RequestHandler => (request, _response, next) => {
  request.actor = {
    provider: 'synthetic-provider',
    subject: 'synthetic-subject',
    user: {
      id: '019c0000-0000-7000-8000-000000000001',
      status: 'active',
      username: 'synthetic_user',
    },
  };
  next();
};

export const createUnhandledCreatorService = (): CreatorService => {
  const unhandled = (): Promise<never> =>
    Promise.reject(new Error('The test did not configure the creator service operation.'));

  return {
    addMember: unhandled,
    createCreator: unhandled,
    getCreator: unhandled,
    listMembers: unhandled,
    listMyWorkspaces: unhandled,
    removeMember: unhandled,
    updateCreator: unhandled,
    updateMember: unhandled,
  };
};

export const createUnhandledCatalogService = (): CatalogService => {
  const unhandled = (): Promise<never> =>
    Promise.reject(new Error('The test did not configure the catalog service operation.'));

  return {
    archiveBox: unhandled,
    archiveReward: unhandled,
    createBox: unhandled,
    createReward: unhandled,
    getBox: unhandled,
    getDraftConfiguration: unhandled,
    getPublicBox: unhandled,
    getPublicBoxVersion: unhandled,
    getReward: unhandled,
    listBoxes: unhandled,
    listBoxVersions: unhandled,
    listRewards: unhandled,
    listRewardVersions: unhandled,
    publishBox: unhandled,
    replaceDraftConfiguration: unhandled,
    updateBox: unhandled,
    updateReward: unhandled,
  };
};

export const createUnhandledFairnessService = (): FairnessService => {
  const unhandled = (): Promise<never> =>
    Promise.reject(new Error('The test did not configure the fairness service operation.'));

  return {
    getCurrent: unhandled,
    getOpeningProof: unhandled,
    getPublicSeedSet: unhandled,
    initialize: unhandled,
    replaceCompromisedActiveSeed: unhandled,
    revealRetiredSeedSet: unhandled,
    rotate: unhandled,
    selectForOpening: unhandled,
    updateClientSeed: unhandled,
  };
};

export const createUnhandledWalletService = (): WalletService => {
  const unhandled = (): Promise<never> =>
    Promise.reject(new Error('The test did not configure the wallet service operation.'));
  return { grantTestCredits: unhandled, listWallets: unhandled };
};

export const createTestAppOptions = (overrides: Partial<AppOptions> = {}): AppOptions => ({
  authenticate: createSuccessfulAuthentication(),
  catalogService: createUnhandledCatalogService(),
  creatorService: createUnhandledCreatorService(),
  fairnessService: createUnhandledFairnessService(),
  logger: createNoopLogger(),
  runtime: { testCreditsEnabled: true },
  security: {
    allowedOrigins: ['http://localhost:5173'],
    authRateLimitMax: 100,
    authRateLimitWindowMs: 60_000,
    creatorMutationRateLimitMax: 100,
    creatorMutationRateLimitWindowMs: 60_000,
    fairnessMutationRateLimitMax: 100,
    fairnessMutationRateLimitWindowMs: 60_000,
    requestBodyLimitBytes: 32_768,
    walletMutationRateLimitMax: 100,
    walletMutationRateLimitWindowMs: 60_000,
  },
  walletService: createUnhandledWalletService(),
  ...overrides,
});

export const createTestApp = (overrides: Partial<AppOptions> = {}) =>
  createApp(createTestAppOptions(overrides));
