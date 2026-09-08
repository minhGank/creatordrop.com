import type { CreatorDropApiClient } from '../src/api/client.js';
import type {
  AuthOperationResult,
  BrowserAuthClient,
  BrowserAuthSession,
} from '../src/auth/auth-client.js';
import {
  authSessionResponseFixture,
  currentFairnessFixture,
  openingV2BoxFixture,
  openingV2ResponseFixture,
  pendingOpeningV2ProofFixture,
  publicCreatorBoxesResponseFixture,
  publicCreatorResponseFixture,
  publicCreatorsResponseFixture,
} from './fixtures.js';

export const createTestApiClient = (
  overrides: Partial<CreatorDropApiClient> = {},
): CreatorDropApiClient => ({
  exchangeSession: overrides.exchangeSession ?? (() => Promise.resolve(authSessionResponseFixture)),
  getCurrentFairness:
    overrides.getCurrentFairness ?? (() => Promise.resolve(currentFairnessFixture)),
  initializeFairness:
    overrides.initializeFairness ?? (() => Promise.resolve(currentFairnessFixture)),
  getCreator: overrides.getCreator ?? (() => Promise.resolve(publicCreatorResponseFixture)),
  getCreatorBox:
    overrides.getCreatorBox ??
    (() =>
      Promise.resolve({ box: openingV2BoxFixture, creator: publicCreatorResponseFixture.creator })),
  getOpeningFairnessProof:
    overrides.getOpeningFairnessProof ?? (() => Promise.resolve(pendingOpeningV2ProofFixture)),
  getOpeningEntitlementState:
    overrides.getOpeningEntitlementState ??
    (() =>
      Promise.resolve({
        entitlement: {
          available: false,
          boxId: openingV2BoxFixture.manifest.boxId,
          consumed: '0',
          granted: '0',
          limitReached: false,
          maxOpeningsPerUser: '3',
          remaining: '0',
          successfulOpenings: '0',
        },
      })),
  getPublishedBoxVersion:
    overrides.getPublishedBoxVersion ?? (() => Promise.resolve(openingV2BoxFixture)),
  listCreatorBoxes:
    overrides.listCreatorBoxes ?? (() => Promise.resolve(publicCreatorBoxesResponseFixture)),
  listCreators: overrides.listCreators ?? (() => Promise.resolve(publicCreatorsResponseFixture)),
  openBox: overrides.openBox ?? (() => Promise.resolve(openingV2ResponseFixture)),
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
