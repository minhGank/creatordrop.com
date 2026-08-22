import type { rngAlgorithmVersion } from './constants.js';

export interface PublishedManifestEntry {
  readonly boxVersionRewardId: string;
  readonly position: number;
  readonly rewardVersionId: string;
  readonly weight: string;
}

export interface PublishedManifest {
  readonly algorithmVersion: typeof rngAlgorithmVersion;
  readonly boxId: string;
  readonly boxVersionId: string;
  readonly currency: string;
  readonly entries: readonly PublishedManifestEntry[];
  readonly priceMinor: string;
  readonly totalWeight: string;
}

export type DigestSource = (round: bigint) => Uint8Array;

export interface RejectionSample {
  readonly acceptedDigest: Uint8Array;
  readonly acceptedDigestHex: string;
  readonly acceptedRound: bigint;
  readonly selectionValue: bigint;
}

export interface RewardSelectionInput {
  readonly algorithmVersion: string;
  readonly clientSeed: string;
  readonly expectedManifestHash?: string;
  readonly manifest: unknown;
  readonly nonce: string;
  readonly seedSetId: string;
  readonly serverSeed: Uint8Array;
}

export interface RewardSelectionResult extends RejectionSample {
  readonly algorithmVersion: typeof rngAlgorithmVersion;
  readonly boxVersionRewardId: string;
  readonly manifestHash: string;
  readonly position: number;
  readonly rewardVersionId: string;
  readonly totalWeight: bigint;
}
