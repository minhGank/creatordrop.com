import { describe, expect, it } from 'vitest';

import { deriveRarityV1, maximumSignedBigint, rarityPolicyVersion } from '../src/index.js';

describe('rarity-v1', () => {
  it('classifies exact rational probabilities without floating-point arithmetic', () => {
    expect(deriveRarityV1(1n, 4n)).toBe('common');
    expect(deriveRarityV1(1n, 5n)).toBe('common');
    expect(deriveRarityV1(1_999n, 10_000n)).toBe('uncommon');
    expect(deriveRarityV1(2n, 25n)).toBe('uncommon');
    expect(deriveRarityV1(799n, 10_000n)).toBe('rare');
    expect(deriveRarityV1(1n, 50n)).toBe('rare');
    expect(deriveRarityV1(199n, 10_000n)).toBe('epic');
    expect(deriveRarityV1(1n, 200n)).toBe('epic');
    expect(deriveRarityV1(49n, 10_000n)).toBe('legendary');
    expect(deriveRarityV1(1n, maximumSignedBigint)).toBe('legendary');
    expect(rarityPolicyVersion).toBe('rarity-v1');
  });

  it.each([
    [0n, 1n],
    [-1n, 1n],
    [1n, 0n],
    [2n, 1n],
    [1n, maximumSignedBigint + 1n],
  ])('rejects invalid weight %s of %s', (weight, totalWeight) => {
    expect(() => deriveRarityV1(weight, totalWeight)).toThrow(RangeError);
  });
});
