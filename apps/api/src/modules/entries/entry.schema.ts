import { validate as isUuid } from 'uuid';
import {
  entryPlatformActions,
  type EntryAction,
  type EntryPlatform,
  type EntryEvidence,
  type EntryEvidenceField,
  type EntryEvidenceRequirement,
  type EntryPolicyDefinition,
  type EntryPolicySnapshot,
  type EntryMethodContract,
  type EntryClaimContract,
  type EntryClaimSummary,
  type EntryStateResponse,
} from '@creatordrop/contracts';
import { EntryError } from './entry.errors.js';

export const invalidEntryInput = (): never => {
  throw new EntryError('ENTRY_INVALID_INPUT');
};
export const entryRecord = (input: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    return invalidEntryInput();
  const record = input as Record<string, unknown>;
  if (Object.keys(record).some((key) => !keys.includes(key))) return invalidEntryInput();
  return record;
};
export const entryText = (input: unknown, max: number): string => {
  if (
    typeof input !== 'string' ||
    input.trim() !== input ||
    input.length === 0 ||
    input.length > max ||
    Array.from(input).some((character) => {
      const code = character.charCodeAt(0);
      return (code < 32 && ![9, 10, 13].includes(code)) || code === 127;
    })
  )
    return invalidEntryInput();
  return input;
};
export const entryId = (input: unknown): string => {
  const id = entryText(input, 36);
  if (!isUuid(id) || id !== id.toLowerCase()) return invalidEntryInput();
  return id;
};
export const entryPositiveCount = (input: unknown): string => {
  const count = entryText(input, 19);
  if (!/^[1-9][0-9]*$/u.test(count) || BigInt(count) > 9_223_372_036_854_775_807n)
    return invalidEntryInput();
  return count;
};
export const entryInteger = (input: unknown): number => {
  if (
    typeof input !== 'number' ||
    !Number.isSafeInteger(input) ||
    input < 1 ||
    input > 2_147_483_647
  )
    return invalidEntryInput();
  return input;
};
const httpsUrl = (input: unknown): string => {
  const text = entryText(input, 2048);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return invalidEntryInput();
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '')
    return invalidEntryInput();
  return text;
};
const targetHosts: Partial<Record<EntryPlatform, readonly string[]>> = {
  instagram: ['instagram.com'],
  youtube: ['youtube.com', 'youtu.be'],
  twitch: ['twitch.tv'],
  tiktok: ['tiktok.com'],
  facebook: ['facebook.com', 'fb.com'],
};
export const entryEvidenceFields = [
  'platform_username',
  'profile_url',
  'order_reference',
  'screenshot',
  'note',
] as const;
export const parseEntryPolicy = (input: unknown): EntryPolicyDefinition => {
  const value = entryRecord(input, [
    'policyVersion',
    'platform',
    'action',
    'verificationStrategy',
    'title',
    'instructions',
    'targetReference',
    'openingsGranted',
    'perUserClaimLimit',
    'evidenceRequirements',
  ]);
  if (value.policyVersion !== 'entry-policy-v1' || value.verificationStrategy !== 'manual_evidence')
    return invalidEntryInput();
  const platformText = entryText(value.platform, 32);
  if (!Object.hasOwn(entryPlatformActions, platformText)) return invalidEntryInput();
  const platform = platformText as EntryPlatform;
  const action = entryText(value.action, 64);
  const actions: readonly string[] = entryPlatformActions[platform];
  if (!actions.includes(action)) return invalidEntryInput();
  const requirements = entryRecord(value.evidenceRequirements, entryEvidenceFields);
  if (
    entryEvidenceFields.some(
      (key) => !['required', 'optional', 'not_applicable'].includes(String(requirements[key])),
    ) ||
    !Object.values(requirements).includes('required')
  )
    return invalidEntryInput();
  const targetReference =
    value.targetReference === null ? null : entryText(value.targetReference, 2048);
  const hosts = targetHosts[platform];
  if (hosts !== undefined) {
    const url = new URL(httpsUrl(targetReference));
    if (!hosts.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`)))
      return invalidEntryInput();
    if (
      [...url.searchParams.keys()].some((key) => platform !== 'youtube' || key !== 'v') ||
      url.hash !== ''
    )
      return invalidEntryInput();
  }
  return {
    policyVersion: 'entry-policy-v1',
    platform,
    action: action as EntryAction,
    verificationStrategy: 'manual_evidence',
    title: entryText(value.title, 120),
    instructions: entryText(value.instructions, 2000),
    targetReference,
    openingsGranted: entryPositiveCount(value.openingsGranted),
    perUserClaimLimit: entryPositiveCount(value.perUserClaimLimit),
    evidenceRequirements: requirements as Record<EntryEvidenceField, EntryEvidenceRequirement>,
  };
};
export const parseEntryEvidence = (input: unknown): EntryEvidence => {
  const value = entryRecord(input, entryEvidenceFields);
  const result: Partial<Record<EntryEvidenceField, string>> = {};
  for (const field of entryEvidenceFields) {
    if (!Object.hasOwn(value, field)) continue;
    result[field] =
      field === 'screenshot'
        ? entryId(value[field])
        : field === 'profile_url'
          ? httpsUrl(value[field])
          : entryText(
              value[field],
              field === 'note' ? 2000 : field === 'order_reference' ? 160 : 120,
            );
  }
  return result;
};
export const validateEntryEvidence = (
  policy: EntryPolicyDefinition,
  input: unknown,
): EntryEvidence => {
  const evidence = parseEntryEvidence(input);
  for (const field of entryEvidenceFields) {
    const rule = policy.evidenceRequirements[field];
    const present = Object.hasOwn(evidence, field);
    if ((rule === 'required' && !present) || (rule === 'not_applicable' && present))
      return invalidEntryInput();
  }
  return evidence;
};
const timestamp = (input: unknown): string => {
  const value = entryText(input, 64);
  if (!/^\d{4}-\d{2}-\d{2}T/u.test(value) || !Number.isFinite(Date.parse(value)))
    return invalidEntryInput();
  return new Date(value).toISOString();
};
export const parseEntryPolicySnapshot = (input: unknown): EntryPolicySnapshot => {
  const p = entryRecord(input, [
    'id',
    'methodId',
    'creatorId',
    'boxId',
    'boxVersionId',
    'versionNumber',
    'publishedAt',
    'definition',
  ]);
  return {
    id: entryId(p.id),
    methodId: entryId(p.methodId),
    creatorId: entryId(p.creatorId),
    boxId: entryId(p.boxId),
    boxVersionId: entryId(p.boxVersionId),
    versionNumber: entryInteger(p.versionNumber),
    publishedAt: timestamp(p.publishedAt),
    definition: parseEntryPolicy(p.definition),
  };
};
export const parseEntryMethod = (input: unknown): EntryMethodContract => {
  const m = entryRecord(input, [
    'id',
    'creatorId',
    'boxId',
    'revision',
    'enabled',
    'draft',
    'published',
  ]);
  if (typeof m.enabled !== 'boolean') return invalidEntryInput();
  return {
    id: entryId(m.id),
    creatorId: entryId(m.creatorId),
    boxId: entryId(m.boxId),
    revision: entryInteger(m.revision),
    enabled: m.enabled,
    draft: parseEntryPolicy(m.draft),
    published: m.published === null ? null : parseEntryPolicySnapshot(m.published),
  };
};
export const parseEntryClaim = (input: unknown): EntryClaimContract => {
  const c = entryRecord(input, [
    'id',
    'creatorId',
    'boxId',
    'policyId',
    'methodId',
    'status',
    'evidence',
    'createdAt',
    'reviewedAt',
    'policy',
  ]);
  if (c.status !== 'pending' && c.status !== 'approved' && c.status !== 'rejected')
    return invalidEntryInput();
  return {
    id: entryId(c.id),
    creatorId: entryId(c.creatorId),
    boxId: entryId(c.boxId),
    policyId: entryId(c.policyId),
    methodId: entryId(c.methodId),
    status: c.status,
    evidence: parseEntryEvidence(c.evidence),
    policy: parseEntryPolicySnapshot(c.policy),
    createdAt: timestamp(c.createdAt),
    reviewedAt: c.reviewedAt === null ? null : timestamp(c.reviewedAt),
  };
};

const entryCount = (input: unknown): string => (input === '0' ? '0' : entryPositiveCount(input));

const parseClaimSummary = (input: unknown): EntryClaimSummary => {
  const c = entryRecord(input, [
    'id',
    'policyId',
    'status',
    'createdAt',
    'reviewedAt',
    'openingsGranted',
  ]);
  if (c.status !== 'pending' && c.status !== 'approved' && c.status !== 'rejected')
    return invalidEntryInput();
  const openingsGranted = entryCount(c.openingsGranted);
  if (
    (c.status === 'approved') !== (openingsGranted !== '0') ||
    (c.status === 'pending') !== (c.reviewedAt === null)
  )
    return invalidEntryInput();
  return {
    id: entryId(c.id),
    policyId: entryId(c.policyId),
    status: c.status,
    createdAt: timestamp(c.createdAt),
    reviewedAt: c.reviewedAt === null ? null : timestamp(c.reviewedAt),
    openingsGranted,
  };
};

export const parseEntryState = (input: unknown): EntryStateResponse => {
  const state = entryRecord(input, ['boxId', 'methods']);
  const boxId = entryId(state.boxId);
  if (!Array.isArray(state.methods)) return invalidEntryInput();
  const methods = state.methods.map((value: unknown) => {
    const m = entryRecord(value, [
      'policy',
      'claimLimit',
      'reservedSlots',
      'consumedSlots',
      'remainingSlots',
      'canSubmit',
      'claimCount',
      'claims',
    ]);
    const policy = parseEntryPolicySnapshot(m.policy);
    const claimLimit = entryPositiveCount(m.claimLimit);
    const reservedSlots = entryCount(m.reservedSlots);
    const consumedSlots = entryCount(m.consumedSlots);
    const remainingSlots = entryCount(m.remainingSlots);
    const claimCount = entryCount(m.claimCount);
    const used = BigInt(reservedSlots) + BigInt(consumedSlots);
    const remaining = BigInt(claimLimit) > used ? BigInt(claimLimit) - used : 0n;
    if (
      policy.boxId !== boxId ||
      policy.definition.perUserClaimLimit !== claimLimit ||
      remaining.toString() !== remainingSlots ||
      m.canSubmit !== remaining > 0n ||
      used > BigInt(claimCount) ||
      !Array.isArray(m.claims) ||
      BigInt(m.claims.length) !== (BigInt(claimCount) > 100n ? 100n : BigInt(claimCount))
    )
      return invalidEntryInput();
    return {
      policy,
      claimLimit,
      reservedSlots,
      consumedSlots,
      remainingSlots,
      canSubmit: remaining > 0n,
      claimCount,
      claims: m.claims.map(parseClaimSummary),
    };
  });
  return { boxId, methods };
};
