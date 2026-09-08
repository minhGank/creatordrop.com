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
  listMyWorkspaces: overrides.listMyWorkspaces ?? (() => Promise.resolve({ memberships: [] })),
  listWorkspaceBoxes: overrides.listWorkspaceBoxes ?? (() => Promise.resolve({ boxes: [] })),
  listEntryMethods: overrides.listEntryMethods ?? (() => Promise.resolve({ methods: [] })),
  getEntryState: overrides.getEntryState ?? ((boxId) => Promise.resolve({ boxId, methods: [] })),
  listDraftEntryMethods:
    overrides.listDraftEntryMethods ?? (() => Promise.resolve({ methods: [] })),
  saveEntryMethod:
    overrides.saveEntryMethod ?? (() => Promise.reject(new Error('Unexpected method save'))),
  publishEntryMethod:
    overrides.publishEntryMethod ??
    (() => Promise.reject(new Error('Unexpected method publication'))),
  setEntryMethodEnabled:
    overrides.setEntryMethodEnabled ??
    (() => Promise.reject(new Error('Unexpected availability update'))),
  submitEntryClaim:
    overrides.submitEntryClaim ?? (() => Promise.reject(new Error('Unexpected claim'))),
  getOwnEntryClaim:
    overrides.getOwnEntryClaim ?? (() => Promise.reject(new Error('Unexpected own claim read'))),
  listReviewClaims:
    overrides.listReviewClaims ?? (() => Promise.resolve({ claims: [], nextCursor: null })),
  getReviewClaim:
    overrides.getReviewClaim ?? (() => Promise.reject(new Error('Unexpected review read'))),
  reviewEntryClaim:
    overrides.reviewEntryClaim ?? (() => Promise.reject(new Error('Unexpected review'))),
  createEntryEvidence:
    overrides.createEntryEvidence ??
    (() => Promise.reject(new Error('Unexpected evidence registration'))),
  uploadEntryEvidence:
    overrides.uploadEntryEvidence ??
    (() => Promise.reject(new Error('Unexpected evidence upload'))),
  getReviewEvidence:
    overrides.getReviewEvidence ?? (() => Promise.reject(new Error('Unexpected evidence read'))),
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
