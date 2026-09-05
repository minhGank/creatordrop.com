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

export const createTestApiClient = (
  overrides: Partial<CreatorDropApiClient> = {},
): CreatorDropApiClient => ({
  exchangeSession: overrides.exchangeSession ?? (() => Promise.resolve(authSessionResponseFixture)),
  getCurrentFairness:
    overrides.getCurrentFairness ?? (() => Promise.resolve(currentFairnessFixture)),
  getCreator: overrides.getCreator ?? (() => Promise.resolve(publicCreatorResponseFixture)),
  getCreatorBox:
    overrides.getCreatorBox ??
    (() =>
      Promise.resolve({ box: publishedBoxFixture, creator: publicCreatorResponseFixture.creator })),
  getOpeningFairnessProof:
    overrides.getOpeningFairnessProof ?? (() => Promise.resolve(pendingOpeningProofFixture)),
  getPublishedBoxVersion:
    overrides.getPublishedBoxVersion ?? (() => Promise.resolve(publishedBoxFixture)),
  listCreatorBoxes:
    overrides.listCreatorBoxes ?? (() => Promise.resolve(publicCreatorBoxesResponseFixture)),
  listCreators: overrides.listCreators ?? (() => Promise.resolve(publicCreatorsResponseFixture)),
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
