/** Additive entry-policy-v1 registry; eligibility is deliberately not an RNG input. */
export const entryPlatformActions = {
  instagram: ['follow_account', 'like_post', 'comment_post', 'share_post'],
  youtube: ['subscribe_channel', 'like_video', 'comment_video', 'paid_channel_member'],
  twitch: ['follow_channel', 'paid_subscription'],
  tiktok: ['follow_account', 'like_video', 'comment_video', 'share_video'],
  facebook: ['follow_page', 'like_post', 'comment_post', 'share_post'],
  commerce: ['previous_purchase'],
  custom: ['manual_requirement'],
} as const;

export type EntryPlatform = keyof typeof entryPlatformActions;
export type EntryAction = (typeof entryPlatformActions)[EntryPlatform][number];
export type EntryEvidenceField =
  'platform_username' | 'profile_url' | 'order_reference' | 'screenshot' | 'note';
export type EntryEvidenceRequirement = 'required' | 'optional' | 'not_applicable';

export interface EntryPolicyDefinition {
  readonly policyVersion: 'entry-policy-v1';
  readonly platform: EntryPlatform;
  readonly action: EntryAction;
  readonly verificationStrategy: 'manual_evidence';
  readonly title: string;
  readonly instructions: string;
  readonly targetReference: string | null;
  readonly openingsGranted: string;
  readonly perUserClaimLimit: string;
  readonly evidenceRequirements: Readonly<Record<EntryEvidenceField, EntryEvidenceRequirement>>;
}

export interface EntryPolicySnapshot {
  readonly id: string;
  readonly methodId: string;
  readonly creatorId: string;
  readonly boxId: string;
  readonly boxVersionId: string;
  readonly versionNumber: number;
  readonly publishedAt: string;
  readonly definition: EntryPolicyDefinition;
}

export interface EntryMethodContract {
  readonly id: string;
  readonly creatorId: string;
  readonly boxId: string;
  readonly revision: number;
  readonly enabled: boolean;
  readonly draft: EntryPolicyDefinition;
  readonly published: EntryPolicySnapshot | null;
}

/** Private input/output; never part of a public policy or realtime payload. */
export interface EntryEvidence {
  readonly platform_username?: string;
  readonly profile_url?: string;
  readonly order_reference?: string;
  readonly screenshot?: string;
  readonly note?: string;
}

export interface EntryClaimContract {
  readonly policy: EntryPolicySnapshot;
  readonly id: string;
  readonly creatorId: string;
  readonly boxId: string;
  readonly policyId: string;
  readonly methodId: string;
  readonly status: 'pending' | 'approved' | 'rejected';
  readonly evidence: EntryEvidence;
  readonly createdAt: string;
  readonly reviewedAt: string | null;
}

/** Own-claim discovery without submitted evidence or private review/grant metadata. */
export interface EntryClaimSummary {
  readonly id: string;
  readonly policyId: string;
  readonly status: EntryClaimContract['status'];
  readonly createdAt: string;
  readonly reviewedAt: string | null;
  readonly openingsGranted: string;
}

export interface EntryMethodState {
  readonly policy: EntryPolicySnapshot;
  readonly claimLimit: string;
  readonly reservedSlots: string;
  readonly consumedSlots: string;
  readonly remainingSlots: string;
  readonly canSubmit: boolean;
  readonly claimCount: string;
  /** Latest 100 claims, newest first; counts always cover the complete stable-method history. */
  readonly claims: readonly EntryClaimSummary[];
}

export interface EntryStateResponse {
  readonly boxId: string;
  readonly methods: readonly EntryMethodState[];
}

export interface EntryClaimPage {
  readonly claims: readonly EntryClaimContract[];
  readonly nextCursor: string | null;
}
