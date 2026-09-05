import { maximumSignedBigint } from './rng/constants.js';

export const rarityPolicyVersion = 'rarity-v1' as const;
export const rarityTiers = ['common', 'uncommon', 'rare', 'epic', 'legendary'] as const;

export type RarityTier = (typeof rarityTiers)[number];

export const deriveRarityV1 = (weight: bigint, totalWeight: bigint): RarityTier => {
  if (
    weight <= 0n ||
    totalWeight <= 0n ||
    weight > totalWeight ||
    totalWeight > maximumSignedBigint
  ) {
    throw new RangeError('Rarity requires a positive weight within a signed-64 total weight.');
  }

  if (weight * 5n >= totalWeight) return 'common';
  if (weight * 25n >= totalWeight * 2n) return 'uncommon';
  if (weight * 50n >= totalWeight) return 'rare';
  if (weight * 200n >= totalWeight) return 'epic';
  return 'legendary';
};
