import type { CreatorDropApiClient } from '../src/api/client.js';
import type {
  AuthOperationResult,
  BrowserAuthClient,
  BrowserAuthSession,
} from '../src/auth/auth-client.js';
import {
  authSessionResponseFixture,
  boxOpeningFixture,
  currentFairnessFixture,
  pendingOpeningProofFixture,
  publicCreatorBoxesResponseFixture,
  publicCreatorResponseFixture,
  publicCreatorsResponseFixture,
  publishedBoxFixture,
} from './fixtures.js';

const emptyWallets = { wallets: [] } as const;

export const createTestApiClient = (
  overrides: Partial<CreatorDropApiClient> = {},
): CreatorDropApiClient => ({
  exchangeSession: overrides.exchangeSession ?? (() => Promise.resolve(authSessionResponseFixture)),
  grantUsdTestCredits:
    overrides.grantUsdTestCredits ??
    (() => Promise.reject(new Error('The test did not configure test-credit grants.'))),
  getCurrentFairness:
    overrides.getCurrentFairness ?? (() => Promise.resolve(currentFairnessFixture)),
  initializeFairness:
    overrides.initializeFairness ?? (() => Promise.resolve(currentFairnessFixture)),
  getCreator: overrides.getCreator ?? (() => Promise.resolve(publicCreatorResponseFixture)),
  getCreatorBox:
    overrides.getCreatorBox ??
    (() =>
      Promise.resolve({ box: publishedBoxFixture, creator: publicCreatorResponseFixture.creator })),
  getOpeningFairnessProof:
    overrides.getOpeningFairnessProof ?? (() => Promise.resolve(pendingOpeningProofFixture)),
  getOpeningEntitlementState:
    overrides.getOpeningEntitlementState ??
    (() =>
      Promise.resolve({
        entitlement: {
          available: false,
          boxId: publishedBoxFixture.manifest.boxId,
          consumed: '0',
          granted: '0',
          limitReached: false,
          maxOpeningsPerUser: '1',
          remaining: '0',
          successfulOpenings: '0',
        },
      })),
  getPublishedBoxVersion:
    overrides.getPublishedBoxVersion ?? (() => Promise.resolve(publishedBoxFixture)),
  listCreatorBoxes:
    overrides.listCreatorBoxes ?? (() => Promise.resolve(publicCreatorBoxesResponseFixture)),
  listCreators: overrides.listCreators ?? (() => Promise.resolve(publicCreatorsResponseFixture)),
  listWallets: overrides.listWallets ?? (() => Promise.resolve(emptyWallets)),
  openBox: overrides.openBox ?? (() => Promise.resolve(boxOpeningFixture)),
  updateCurrentClientSeed:
    overrides.updateCurrentClientSeed ?? (() => Promise.resolve(currentFairnessFixture)),
});

export const createTestAuthClient = (
  overrides: Partial<BrowserAuthClient> = {},
): BrowserAuthClient => ({
  getAccessToken: overrides.getAccessToken ?? (() => Promise.resolve(null)),
  getSession: overrides.getSession ?? (() => Promise.resolve(null)),
  onSessionChange: overrides.onSessionChange ?? (() => () => undefined),
  signIn:
    overrides.signIn ??
    (() => Promise.resolve<AuthOperationResult>({ confirmationRequired: false, session: null })),
  signOut: overrides.signOut ?? (() => Promise.resolve()),
  signUp:
    overrides.signUp ??
    (() => Promise.resolve<AuthOperationResult>({ confirmationRequired: true, session: null })),
});

export const browserSession = (accessToken = 'test-access-token'): BrowserAuthSession => ({
  accessToken,
});
