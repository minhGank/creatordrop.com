import type { CreatorDropApiClient } from '../src/api/client.js';
import type {
  AuthOperationResult,
  BrowserAuthClient,
  BrowserAuthSession,
} from '../src/auth/auth-client.js';
import {
  authSessionResponseFixture,
  publicCreatorBoxesResponseFixture,
  publicCreatorResponseFixture,
  publicCreatorsResponseFixture,
  publishedBoxFixture,
} from './fixtures.js';

export const createTestApiClient = (
  overrides: Partial<CreatorDropApiClient> = {},
): CreatorDropApiClient => ({
  exchangeSession: overrides.exchangeSession ?? (() => Promise.resolve(authSessionResponseFixture)),
  getCreator: overrides.getCreator ?? (() => Promise.resolve(publicCreatorResponseFixture)),
  getCreatorBox:
    overrides.getCreatorBox ??
    (() =>
      Promise.resolve({ box: publishedBoxFixture, creator: publicCreatorResponseFixture.creator })),
  listCreatorBoxes:
    overrides.listCreatorBoxes ?? (() => Promise.resolve(publicCreatorBoxesResponseFixture)),
  listCreators: overrides.listCreators ?? (() => Promise.resolve(publicCreatorsResponseFixture)),
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
