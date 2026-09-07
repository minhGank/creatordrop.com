import { createHash, timingSafeEqual } from 'node:crypto';

import { maximumSignedBigint, rngAlgorithmVersion } from './constants.js';
import { RngError } from './errors.js';
import type {
  OpeningV2PublishedManifest,
  OpeningV2PublishedManifestEntry,
  PublishedManifest,
  PublishedManifestEntry,
  VersionedPublishedManifest,
} from './types.js';
import {
  isRecord,
  requireCanonicalUuid,
  requireExactFields,
  requireLowercaseHex256,
} from './validation.js';

const canonicalPositiveIntegerPattern = /^[1-9][0-9]*$/u;
const currencyPattern = /^[A-Z]{3}$/u;
const manifestFields = [
  'algorithmVersion',
  'boxId',
  'boxVersionId',
  'currency',
  'entries',
  'priceMinor',
  'totalWeight',
] as const;
const entryFields = ['boxVersionRewardId', 'position', 'rewardVersionId', 'weight'] as const;
const openingV2ManifestFields = [
  'algorithmVersion',
  'boxId',
  'boxVersionId',
  'entries',
  'maxOpeningsPerUser',
  'openingCompatibilityVersion',
  'totalWeight',
] as const;
const openingV2EntryFields = [
  'boxVersionRewardId',
  'position',
  'rarity',
  'rarityPolicyVersion',
  'rewardVersionId',
  'weight',
] as const;
const rarities = ['common', 'uncommon', 'rare', 'epic', 'legendary'] as const;

const parsePositiveSignedBigint = (
  value: unknown,
  errorCode: 'INVALID_WEIGHT' | 'MALFORMED_MANIFEST',
): bigint => {
  if (typeof value !== 'string' || !canonicalPositiveIntegerPattern.test(value)) {
    throw new RngError(errorCode);
  }
  const parsed = BigInt(value);
  if (parsed > maximumSignedBigint) {
    throw new RngError(errorCode === 'INVALID_WEIGHT' ? 'WEIGHT_OVERFLOW' : errorCode);
  }
  return parsed;
};

const parseEntry = (value: unknown, expectedPosition: number): PublishedManifestEntry => {
  if (!isRecord(value)) throw new RngError('MALFORMED_MANIFEST');
  requireExactFields(value, entryFields);
  if (
    typeof value.position !== 'number' ||
    !Number.isSafeInteger(value.position) ||
    value.position !== expectedPosition
  ) {
    throw new RngError('MALFORMED_MANIFEST');
  }
  const weight = parsePositiveSignedBigint(value.weight, 'INVALID_WEIGHT');
  return {
    boxVersionRewardId: requireCanonicalUuid(value.boxVersionRewardId, 'MALFORMED_MANIFEST'),
    position: expectedPosition,
    rewardVersionId: requireCanonicalUuid(value.rewardVersionId, 'MALFORMED_MANIFEST'),
    weight: weight.toString(),
  };
};

const parseOpeningV2Entry = (
  value: unknown,
  expectedPosition: number,
): OpeningV2PublishedManifestEntry => {
  if (!isRecord(value)) throw new RngError('MALFORMED_MANIFEST');
  requireExactFields(value, openingV2EntryFields);
  if (
    typeof value.position !== 'number' ||
    !Number.isSafeInteger(value.position) ||
    value.position !== expectedPosition ||
    typeof value.rarity !== 'string' ||
    !rarities.includes(value.rarity as (typeof rarities)[number]) ||
    value.rarityPolicyVersion !== 'rarity-v1'
  ) {
    throw new RngError('MALFORMED_MANIFEST');
  }
  const weight = parsePositiveSignedBigint(value.weight, 'INVALID_WEIGHT');
  return {
    boxVersionRewardId: requireCanonicalUuid(value.boxVersionRewardId, 'MALFORMED_MANIFEST'),
    position: expectedPosition,
    rarity: value.rarity as OpeningV2PublishedManifestEntry['rarity'],
    rarityPolicyVersion: 'rarity-v1',
    rewardVersionId: requireCanonicalUuid(value.rewardVersionId, 'MALFORMED_MANIFEST'),
    weight: weight.toString(),
  };
};

const validateEntries = (entries: readonly PublishedManifestEntry[], totalWeight: bigint): void => {
  if (
    new Set(entries.map(({ boxVersionRewardId }) => boxVersionRewardId)).size !== entries.length ||
    new Set(entries.map(({ rewardVersionId }) => rewardVersionId)).size !== entries.length
  ) {
    throw new RngError('MALFORMED_MANIFEST');
  }
  let computedTotal = 0n;
  for (const entry of entries) {
    computedTotal += BigInt(entry.weight);
    if (computedTotal > maximumSignedBigint) throw new RngError('WEIGHT_OVERFLOW');
  }
  if (computedTotal !== totalWeight) throw new RngError('TOTAL_WEIGHT_MISMATCH');
};

export const parsePublishedManifest = (value: unknown): PublishedManifest => {
  if (!isRecord(value)) throw new RngError('MALFORMED_MANIFEST');
  requireExactFields(value, manifestFields);
  if (value.algorithmVersion !== rngAlgorithmVersion) {
    throw new RngError('UNSUPPORTED_ALGORITHM');
  }
  if (typeof value.currency !== 'string' || !currencyPattern.test(value.currency)) {
    throw new RngError('MALFORMED_MANIFEST');
  }
  if (!Array.isArray(value.entries)) throw new RngError('MALFORMED_MANIFEST');
  if (value.entries.length === 0) throw new RngError('NO_SELECTABLE_REWARD');

  const priceMinor = parsePositiveSignedBigint(value.priceMinor, 'MALFORMED_MANIFEST');
  const totalWeight = parsePositiveSignedBigint(value.totalWeight, 'INVALID_WEIGHT');
  const entries = Array.from(value.entries, (entry, position) => parseEntry(entry, position));
  validateEntries(entries, totalWeight);

  return {
    algorithmVersion: rngAlgorithmVersion,
    boxId: requireCanonicalUuid(value.boxId, 'MALFORMED_MANIFEST'),
    boxVersionId: requireCanonicalUuid(value.boxVersionId, 'MALFORMED_MANIFEST'),
    currency: value.currency,
    entries,
    priceMinor: priceMinor.toString(),
    totalWeight: totalWeight.toString(),
  };
};

export const parseOpeningV2PublishedManifest = (value: unknown): OpeningV2PublishedManifest => {
  if (!isRecord(value)) throw new RngError('MALFORMED_MANIFEST');
  requireExactFields(value, openingV2ManifestFields);
  if (value.algorithmVersion !== rngAlgorithmVersion) {
    throw new RngError('UNSUPPORTED_ALGORITHM');
  }
  if (value.openingCompatibilityVersion !== 'opening-v2') {
    throw new RngError('MALFORMED_MANIFEST');
  }
  if (!Array.isArray(value.entries)) throw new RngError('MALFORMED_MANIFEST');
  if (value.entries.length === 0) throw new RngError('NO_SELECTABLE_REWARD');
  const maxOpeningsPerUser = parsePositiveSignedBigint(
    value.maxOpeningsPerUser,
    'MALFORMED_MANIFEST',
  );
  const totalWeight = parsePositiveSignedBigint(value.totalWeight, 'INVALID_WEIGHT');
  const entries = Array.from(value.entries, (entry, position) =>
    parseOpeningV2Entry(entry, position),
  );
  validateEntries(entries, totalWeight);
  return {
    algorithmVersion: rngAlgorithmVersion,
    boxId: requireCanonicalUuid(value.boxId, 'MALFORMED_MANIFEST'),
    boxVersionId: requireCanonicalUuid(value.boxVersionId, 'MALFORMED_MANIFEST'),
    entries,
    maxOpeningsPerUser: maxOpeningsPerUser.toString(),
    openingCompatibilityVersion: 'opening-v2',
    totalWeight: totalWeight.toString(),
  };
};

export const parseVersionedPublishedManifest = (value: unknown): VersionedPublishedManifest =>
  isRecord(value) && value.openingCompatibilityVersion === 'opening-v2'
    ? parseOpeningV2PublishedManifest(value)
    : parsePublishedManifest(value);

const quoted = (value: string): string => JSON.stringify(value);

const canonicalizeValidatedManifest = (manifest: PublishedManifest): string => {
  const entries = manifest.entries
    .map(
      (entry) =>
        `{"boxVersionRewardId":${quoted(entry.boxVersionRewardId)},"position":${entry.position.toString()},"rewardVersionId":${quoted(entry.rewardVersionId)},"weight":${quoted(entry.weight)}}`,
    )
    .join(',');
  return `{"algorithmVersion":${quoted(manifest.algorithmVersion)},"boxId":${quoted(manifest.boxId)},"boxVersionId":${quoted(manifest.boxVersionId)},"currency":${quoted(manifest.currency)},"entries":[${entries}],"priceMinor":${quoted(manifest.priceMinor)},"totalWeight":${quoted(manifest.totalWeight)}}`;
};

const canonicalizeOpeningV2Manifest = (manifest: OpeningV2PublishedManifest): string => {
  const entries = manifest.entries
    .map(
      (entry) =>
        `{"boxVersionRewardId":${quoted(entry.boxVersionRewardId)},"position":${entry.position.toString()},"rarity":${quoted(entry.rarity)},"rarityPolicyVersion":${quoted(entry.rarityPolicyVersion)},"rewardVersionId":${quoted(entry.rewardVersionId)},"weight":${quoted(entry.weight)}}`,
    )
    .join(',');
  return `{"algorithmVersion":${quoted(manifest.algorithmVersion)},"boxId":${quoted(manifest.boxId)},"boxVersionId":${quoted(manifest.boxVersionId)},"entries":[${entries}],"maxOpeningsPerUser":${quoted(manifest.maxOpeningsPerUser)},"openingCompatibilityVersion":${quoted(manifest.openingCompatibilityVersion)},"totalWeight":${quoted(manifest.totalWeight)}}`;
};

export const canonicalizePublishedManifest = (manifest: unknown): string =>
  (() => {
    const parsed = parseVersionedPublishedManifest(manifest);
    return 'openingCompatibilityVersion' in parsed
      ? canonicalizeOpeningV2Manifest(parsed)
      : canonicalizeValidatedManifest(parsed);
  })();

export const hashPublishedManifest = (manifest: unknown): string =>
  createHash('sha256').update(canonicalizePublishedManifest(manifest), 'utf8').digest('hex');

export const verifyPublishedManifestHash = (manifest: unknown, expectedHash: unknown): string => {
  const expected = requireLowercaseHex256(expectedHash, 'MANIFEST_HASH_MISMATCH');
  const actual = hashPublishedManifest(manifest);
  if (!timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'))) {
    throw new RngError('MANIFEST_HASH_MISMATCH');
  }
  return actual;
};
