import type {
  EntryAction,
  EntryEvidenceField,
  EntryPlatform,
  EntryPolicyDefinition,
} from '@creatordrop/contracts';
import { CreatorDropApiError } from '../api/client.js';

export const platformNames: Record<EntryPlatform, string> = {
  instagram: 'Instagram',
  youtube: 'YouTube',
  twitch: 'Twitch',
  tiktok: 'TikTok',
  facebook: 'Facebook',
  commerce: 'Purchase',
  custom: 'Custom',
};
export const platformMarks: Record<EntryPlatform, string> = {
  instagram: '◎',
  youtube: '▶',
  twitch: '▣',
  tiktok: '♪',
  facebook: 'f',
  commerce: '↗',
  custom: '✦',
};
export const actionNames: Record<EntryAction, string> = {
  follow_account: 'Follow account',
  like_post: 'Like post',
  comment_post: 'Comment on post',
  share_post: 'Share post',
  subscribe_channel: 'Subscribe to channel',
  like_video: 'Like video',
  comment_video: 'Comment on video',
  paid_channel_member: 'Paid channel member',
  follow_channel: 'Follow channel',
  paid_subscription: 'Paid subscription',
  share_video: 'Share video',
  follow_page: 'Follow page',
  previous_purchase: 'Previous purchase',
  manual_requirement: 'Manual requirement',
};
export const evidenceFields: readonly EntryEvidenceField[] = [
  'platform_username',
  'profile_url',
  'order_reference',
  'screenshot',
  'note',
];
export const evidenceLabel = (field: EntryEvidenceField, platform: EntryPlatform): string =>
  ({
    platform_username: platform === 'custom' ? 'Username' : `${platformNames[platform]} username`,
    profile_url: 'Profile URL',
    order_reference: 'Order/reference number',
    screenshot: 'Screenshot proof',
    note: 'Note',
  })[field];
export const drops = (count: string) => `${count} ${count === '1' ? 'Drop' : 'Drops'}`;
export const defaults = (platform: EntryPlatform, action: EntryAction): EntryPolicyDefinition => ({
  policyVersion: 'entry-policy-v1',
  platform,
  action,
  verificationStrategy: 'manual_evidence',
  title: `${platformNames[platform]} · ${actionNames[action]}`,
  instructions: '',
  targetReference: null,
  openingsGranted: '1',
  perUserClaimLimit: '1',
  evidenceRequirements: {
    platform_username:
      platform === 'commerce' || platform === 'custom' ? 'not_applicable' : 'required',
    profile_url: 'not_applicable',
    order_reference: platform === 'commerce' ? 'required' : 'not_applicable',
    screenshot:
      platform === 'commerce' ? 'optional' : platform === 'custom' ? 'not_applicable' : 'required',
    note: platform === 'custom' ? 'required' : 'optional',
  },
});
export const safeExternalUrl = (value: string | null | undefined): string | null => {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
};
export const entryError = (error: unknown): string => {
  if (error instanceof CreatorDropApiError) {
    if (error.status === 401) return 'Your session expired. Sign in again to continue.';
    if (error.status === 403)
      return 'You do not have permission for this action. Another authorized team member may be needed.';
    if (error.status === 404) return 'This item is unavailable or you no longer have access.';
    if (error.code === 'ENTRY_REVISION_CONFLICT' || error.code === 'ENTRY_UNAVAILABLE')
      return 'This Drop or its rules changed. Refresh the page and review the latest rules before trying again.';
    if (error.code === 'ENTRY_CLAIM_LIMIT_REACHED')
      return 'You have used all claims for this requirement. Refresh your claim status.';
    if (error.code === 'ENTRY_CONFLICT')
      return 'This request conflicts with an existing submission or review. Refresh to see the latest status.';
    if (error.status === 400)
      return 'Check the requirement, target link and proof fields, then try again.';
    if (error.status === 429) return 'Too many requests. Please wait a moment before trying again.';
  }
  return 'The request could not be confirmed. Check your connection and try again.';
};

export const proofSummary = (definition: EntryPolicyDefinition) =>
  evidenceFields
    .filter((f) => definition.evidenceRequirements[f] === 'required')
    .map((f) => evidenceLabel(f, definition.platform))
    .join(' + ');
