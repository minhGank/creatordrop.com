import type {
  CreatorWorkspaceMembershipsResponse,
  EntryClaimContract,
  EntryMethodContract,
  EntryMethodState,
  EntryPolicySnapshot,
} from '@creatordrop/contracts';
import { openingV2BoxFixture } from './fixtures.js';

export const entryPolicy: EntryPolicySnapshot = {
  id: '00000000-0000-4000-8000-000000000601',
  methodId: '00000000-0000-4000-8000-000000000602',
  creatorId: '00000000-0000-4000-8000-000000000603',
  boxId: openingV2BoxFixture.manifest.boxId,
  boxVersionId: openingV2BoxFixture.version.id,
  versionNumber: 1,
  publishedAt: '2026-09-08T12:00:00.000Z',
  definition: {
    policyVersion: 'entry-policy-v1',
    platform: 'instagram',
    action: 'like_post',
    verificationStrategy: 'manual_evidence',
    title: 'Like our announcement',
    instructions: 'Like the post and send proof for manual review.',
    targetReference: 'https://www.instagram.com/p/synthetic/',
    openingsGranted: '1',
    perUserClaimLimit: '1',
    evidenceRequirements: {
      platform_username: 'required',
      screenshot: 'required',
      profile_url: 'not_applicable',
      order_reference: 'not_applicable',
      note: 'optional',
    },
  },
};
export const entryMethod: EntryMethodContract = {
  id: entryPolicy.methodId,
  creatorId: entryPolicy.creatorId,
  boxId: entryPolicy.boxId,
  revision: 2,
  enabled: true,
  draft: entryPolicy.definition,
  published: entryPolicy,
};
export const entryClaim: EntryClaimContract = {
  id: '00000000-0000-4000-8000-000000000604',
  creatorId: entryPolicy.creatorId,
  boxId: entryPolicy.boxId,
  policyId: entryPolicy.id,
  methodId: entryPolicy.methodId,
  policy: entryPolicy,
  status: 'pending',
  createdAt: '2026-09-08T12:01:00.000Z',
  reviewedAt: null,
  evidence: {
    platform_username: '@synthetic-fan',
    screenshot: '00000000-0000-4000-8000-000000000605',
  },
};
export const entryState = (status?: EntryClaimContract['status']): EntryMethodState => ({
  policy: entryPolicy,
  claimLimit: '1',
  reservedSlots: status === 'pending' ? '1' : '0',
  consumedSlots: status === 'approved' ? '1' : '0',
  remainingSlots: !status || status === 'rejected' ? '1' : '0',
  canSubmit: !status || status === 'rejected',
  claimCount: status ? '1' : '0',
  claims: status
    ? [
        {
          id: entryClaim.id,
          policyId: entryPolicy.id,
          status,
          createdAt: entryClaim.createdAt,
          reviewedAt: status === 'pending' ? null : '2026-09-08T12:02:00.000Z',
          openingsGranted: status === 'approved' ? '5' : '0',
        },
      ]
    : [],
});
export const membership = (
  role: 'owner' | 'manager' | 'editor' | 'viewer' = 'owner',
): CreatorWorkspaceMembershipsResponse => ({
  memberships: [
    {
      role,
      joinedAt: entryPolicy.publishedAt,
      creator: {
        id: entryPolicy.creatorId,
        customSlug: 'synthetic-creator',
        displayName: 'Synthetic creator',
        handle: 'synthetic_creator',
        status: 'active',
        revision: 1,
        createdAt: entryPolicy.publishedAt,
        updatedAt: entryPolicy.publishedAt,
      },
    },
  ],
});
