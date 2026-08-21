import { createHash } from 'node:crypto';

import { CatalogPublicationError } from './catalog.errors.js';
import type {
  BoxId,
  BoxVersionId,
  BoxVersionRewardId,
  MoneyMinor,
  ProbabilityWeight,
  PublishedManifest,
  RewardVersionId,
} from './catalog.js';

export const rngAlgorithmVersion = 'hmac-sha256-rejection-v1' as const;
const maximumSignedBigint = 9_223_372_036_854_775_807n;

export interface ManifestEntryInput {
  readonly id: BoxVersionRewardId;
  readonly position: number;
  readonly rewardVersionId: RewardVersionId;
  readonly weight: ProbabilityWeight;
}

export interface ManifestInput {
  readonly boxId: BoxId;
  readonly boxVersionId: BoxVersionId;
  readonly currency: string;
  readonly entries: readonly ManifestEntryInput[];
  readonly priceMinor: MoneyMinor;
}

const quoted = (value: string): string => JSON.stringify(value);

export const totalProbabilityWeight = (
  entries: readonly ManifestEntryInput[],
): ProbabilityWeight => {
  let total = 0n;
  for (const entry of entries) {
    total += entry.weight;
    if (total > maximumSignedBigint) {
      throw new CatalogPublicationError(
        'WEIGHT_OVERFLOW',
        'The total probability weight exceeds signed 64-bit storage.',
      );
    }
  }

  if (total <= 0n) {
    throw new CatalogPublicationError(
      'EMPTY_CONFIGURATION',
      'A published box requires at least one positively weighted reward.',
    );
  }

  return total as ProbabilityWeight;
};

export const createPublishedManifest = (input: ManifestInput): PublishedManifest => {
  const entries = [...input.entries].sort((left, right) => left.position - right.position);
  const totalWeight = totalProbabilityWeight(entries).toString();

  return {
    algorithmVersion: rngAlgorithmVersion,
    boxId: input.boxId,
    boxVersionId: input.boxVersionId,
    currency: input.currency,
    entries: entries.map((entry) => ({
      boxVersionRewardId: entry.id,
      position: entry.position,
      rewardVersionId: entry.rewardVersionId,
      weight: entry.weight.toString(),
    })),
    priceMinor: input.priceMinor.toString(),
    totalWeight,
  };
};

// This fixed-schema serializer follows RFC 8785 key ordering and JSON scalar encoding.
export const canonicalizePublishedManifest = (manifest: PublishedManifest): string => {
  const entries = manifest.entries
    .map(
      (entry) =>
        `{"boxVersionRewardId":${quoted(entry.boxVersionRewardId)},"position":${entry.position.toString()},"rewardVersionId":${quoted(entry.rewardVersionId)},"weight":${quoted(entry.weight)}}`,
    )
    .join(',');

  return `{"algorithmVersion":${quoted(manifest.algorithmVersion)},"boxId":${quoted(manifest.boxId)},"boxVersionId":${quoted(manifest.boxVersionId)},"currency":${quoted(manifest.currency)},"entries":[${entries}],"priceMinor":${quoted(manifest.priceMinor)},"totalWeight":${quoted(manifest.totalWeight)}}`;
};

export const hashPublishedManifest = (manifest: PublishedManifest): string =>
  createHash('sha256').update(canonicalizePublishedManifest(manifest), 'utf8').digest('hex');
