import {
  canonicalizePublishedManifest as canonicalizeDomainManifest,
  hashPublishedManifest as hashDomainManifest,
  rngAlgorithmVersion,
} from '@creatordrop/domain';

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

// The shared domain canonicalizer preserves the exact Phase 5 persisted byte format.
export const canonicalizePublishedManifest = (manifest: PublishedManifest): string =>
  canonicalizeDomainManifest(manifest);

export const hashPublishedManifest = (manifest: PublishedManifest): string =>
  hashDomainManifest(manifest);

export { rngAlgorithmVersion };
