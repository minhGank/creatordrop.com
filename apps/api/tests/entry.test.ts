import { describe, expect, it } from 'vitest';
import { entryPlatformActions, type EntryPolicyDefinition } from '@creatordrop/contracts';
import {
  entryInteger,
  parseEntryPolicy,
  parseEntryState,
  validateEntryEvidence,
} from '../src/modules/entries/entry.schema.js';
import {
  validateEvidenceImage,
  entryEvidenceMaxBytes,
} from '../src/modules/entries/entry.storage.js';

export const manualEntryDefinition: EntryPolicyDefinition = {
  policyVersion: 'entry-policy-v1',
  platform: 'custom',
  action: 'manual_requirement',
  verificationStrategy: 'manual_evidence',
  title: 'Synthetic manual task',
  instructions: 'Submit synthetic proof for manual review.',
  targetReference: null,
  openingsGranted: '1',
  perUserClaimLimit: '1',
  evidenceRequirements: {
    platform_username: 'not_applicable',
    profile_url: 'not_applicable',
    order_reference: 'not_applicable',
    screenshot: 'not_applicable',
    note: 'required',
  },
};
describe('R2A entry policy and typed evidence', () => {
  it('bounds revision and metadata integers before PostgreSQL casts', () => {
    expect(entryInteger(2_147_483_647)).toBe(2_147_483_647);
    for (const invalid of [0, -1, 1.5, 2_147_483_648, Number.NaN, '1']) {
      expect(() => entryInteger(invalid)).toThrow();
    }
  });
  const targets = {
    instagram: 'https://instagram.com/p/synthetic',
    youtube: 'https://youtube.com/watch?v=synthetic',
    twitch: 'https://twitch.tv/synthetic',
    tiktok: 'https://tiktok.com/@synthetic/video/1',
    facebook: 'https://facebook.com/synthetic',
    commerce: null,
    custom: null,
  };
  for (const [platform, actions] of Object.entries(entryPlatformActions)) {
    for (const action of actions) {
      it(`accepts ${platform}/${action}`, () => {
        expect(
          parseEntryPolicy({
            ...manualEntryDefinition,
            platform,
            action,
            targetReference: targets[platform as keyof typeof targets],
          }),
        ).toMatchObject({ platform, action });
      });
    }
  }
  it.each([
    { platform: 'twitch', action: 'like_post' },
    { platform: 'unknown' },
    { action: 'execute_code' },
    { verificationStrategy: 'provider_api' },
    { oauthToken: 'synthetic' },
    { openingsGranted: '1.5' },
    { perUserClaimLimit: '0' },
    { openingsGranted: '9223372036854775808' },
    {
      platform: 'instagram',
      action: 'like_post',
      targetReference: 'https://instagram.com.attacker.test/post',
    },
    {
      platform: 'instagram',
      action: 'like_post',
      targetReference: 'https://user:password@instagram.com/post',
    },
    {
      platform: 'instagram',
      action: 'like_post',
      targetReference: 'https://instagram.com/post?access_token=synthetic',
    },
  ])('rejects invalid policy %j', (change) =>
    expect(() => parseEntryPolicy({ ...manualEntryDefinition, ...change })).toThrow(),
  );
  it('enforces required, optional, and not-applicable fields without arbitrary JSON', () => {
    expect(
      validateEntryEvidence(manualEntryDefinition, { note: 'Submitted, not verified.' }),
    ).toEqual({ note: 'Submitted, not verified.' });
    for (const value of [
      {},
      { note: 'ok', username: 'unknown' },
      { note: 'ok', screenshot: '00000000-0000-4000-8000-000000000001' },
      { note: { code: 'executable' } },
    ]) {
      expect(() => validateEntryEvidence(manualEntryDefinition, value)).toThrow();
    }
  });
  it('rejects unsupported, mislabeled, and oversized screenshot bytes', () => {
    const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(validateEvidenceImage('image/png', png)).toBe('image/png');
    expect(() => validateEvidenceImage('image/svg+xml', png)).toThrow();
    expect(() => validateEvidenceImage('image/jpeg', png)).toThrow();
    expect(() =>
      validateEvidenceImage('image/png', Buffer.from('<script>bad()</script>')),
    ).toThrow();
    expect(() =>
      validateEvidenceImage('image/png', new Uint8Array(entryEvidenceMaxBytes + 1)),
    ).toThrow();
  });
});

describe('own entry-state database response validation', () => {
  const id = '00000000-0000-4000-8000-000000000001';
  const policy = {
    id,
    methodId: id,
    creatorId: id,
    boxId: id,
    boxVersionId: id,
    versionNumber: 1,
    publishedAt: '2026-09-08T00:00:00.000Z',
    definition: { ...manualEntryDefinition, perUserClaimLimit: '9223372036854775807' },
  };
  const method = {
    policy,
    claimLimit: '9223372036854775807',
    reservedSlots: '0',
    consumedSlots: '0',
    remainingSlots: '9223372036854775807',
    canSubmit: true,
    claimCount: '0',
    claims: [],
  };
  it('preserves signed-64 decimal precision without floating point', () => {
    expect(parseEntryState({ boxId: id, methods: [method] })).toEqual({
      boxId: id,
      methods: [method],
    });
  });
  it.each([
    { canSubmit: false },
    { remainingSlots: '0' },
    { claimLimit: '1' },
    { reservedSlots: '-1' },
    { consumedSlots: 0 },
    { claimCount: '01' },
    { claims: [{}] },
    { evidence: { screenshot: id } },
    { policy: { ...policy, boxId: '00000000-0000-4000-8000-000000000002' } },
  ])('fails closed on malformed or inconsistent state %j', (change) => {
    expect(() => parseEntryState({ boxId: id, methods: [{ ...method, ...change }] })).toThrow();
  });
  it('rejects grant/review metadata and terminal-state inconsistencies in summaries', () => {
    const claim = {
      id,
      policyId: id,
      status: 'pending',
      createdAt: policy.publishedAt,
      reviewedAt: null,
      openingsGranted: '0',
    };
    for (const change of [
      { evidence: { screenshot: id } },
      { reviewerId: id },
      { openingsGranted: '1' },
      { status: 'approved' },
      { reviewedAt: policy.publishedAt },
    ]) {
      expect(() =>
        parseEntryState({
          boxId: id,
          methods: [
            {
              ...method,
              claimCount: '1',
              reservedSlots: '1',
              remainingSlots: '9223372036854775806',
              claims: [{ ...claim, ...change }],
            },
          ],
        }),
      ).toThrow();
    }
  });
});
