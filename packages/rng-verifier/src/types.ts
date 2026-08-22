export const proofMismatchCodes = [
  'SERVER_SEED_COMMITMENT',
  'MANIFEST_HASH',
  'ROUND_DIGESTS',
  'ACCEPTED_ROUND',
  'ACCEPTED_DIGEST',
  'SELECTION_VALUE',
  'BOX_VERSION_REWARD',
  'REWARD_VERSION',
  'POSITION',
] as const;

export type ProofMismatchCode = (typeof proofMismatchCodes)[number];

export interface RecordedRewardSelection {
  readonly acceptedDigestHex: string;
  readonly acceptedRound: string;
  readonly boxVersionRewardId: string;
  readonly position: number;
  readonly rewardVersionId: string;
  readonly roundDigests: readonly {
    readonly digestHex: string;
    readonly round: string;
  }[];
  readonly selectionValue: string;
}

export interface RewardSelectionProofInput {
  readonly algorithmVersion: string;
  readonly clientSeed: string;
  readonly configurationHash: string;
  readonly manifest: unknown;
  readonly nonce: string;
  readonly recorded: RecordedRewardSelection;
  readonly seedSetId: string;
  readonly serverSeedCommitment: string;
  readonly serverSeedHex: string;
}

export interface VerifiedRewardSelection {
  readonly acceptedDigestHex: string;
  readonly acceptedRound: string;
  readonly boxVersionRewardId: string;
  readonly manifestHash: string;
  readonly position: number;
  readonly rewardVersionId: string;
  readonly roundDigests: readonly {
    readonly digestHex: string;
    readonly round: string;
  }[];
  readonly selectionValue: string;
  readonly serverSeedCommitment: string;
  readonly totalWeight: string;
}

export interface RewardSelectionVerification {
  readonly computed: VerifiedRewardSelection;
  readonly mismatches: readonly ProofMismatchCode[];
  readonly valid: boolean;
}
