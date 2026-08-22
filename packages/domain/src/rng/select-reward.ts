import { rngAlgorithmVersion } from './constants.js';
import { createHmacSha256DigestSource } from './crypto.js';
import { RngError } from './errors.js';
import {
  hashPublishedManifest,
  parsePublishedManifest,
  verifyPublishedManifestHash,
} from './manifest.js';
import { sampleWithRejection } from './rejection-sampling.js';
import type { RewardSelectionInput, RewardSelectionResult } from './types.js';
import { selectWeightedEntry } from './weighted-selection.js';

export const selectReward = (input: RewardSelectionInput): RewardSelectionResult => {
  if (input.algorithmVersion !== rngAlgorithmVersion) {
    throw new RngError('UNSUPPORTED_ALGORITHM');
  }
  const manifest = parsePublishedManifest(input.manifest);
  const manifestHash =
    input.expectedManifestHash === undefined
      ? hashPublishedManifest(manifest)
      : verifyPublishedManifestHash(manifest, input.expectedManifestHash);
  const totalWeight = BigInt(manifest.totalWeight);
  const sample = sampleWithRejection(
    totalWeight,
    createHmacSha256DigestSource({
      clientSeed: input.clientSeed,
      nonce: input.nonce,
      seedSetId: input.seedSetId,
      serverSeed: input.serverSeed,
    }),
  );
  const winner = selectWeightedEntry(manifest.entries, totalWeight, sample.selectionValue);
  return {
    ...sample,
    algorithmVersion: rngAlgorithmVersion,
    boxVersionRewardId: winner.boxVersionRewardId,
    manifestHash,
    position: winner.position,
    rewardVersionId: winner.rewardVersionId,
    totalWeight,
  };
};
