import { describe, expect, it } from 'vitest';

import primitiveVectors from '../../../test-vectors/rng/hmac-sha256-rejection-v1-primitives.json' with { type: 'json' };
import {
  maximumSignedBigint,
  RngError,
  sampleWithRejection,
  selectWeightedEntry,
  unsigned256Range,
  type PublishedManifestEntry,
} from '../src/index.js';

const digest = (value: bigint): Uint8Array =>
  Uint8Array.from(Buffer.from(value.toString(16).padStart(64, '0'), 'hex'));

const entries: readonly PublishedManifestEntry[] = [
  {
    boxVersionRewardId: '00000001-0004-7000-8000-000000000001',
    position: 0,
    rewardVersionId: '00000001-0005-7000-8000-000000000001',
    weight: '5',
  },
  {
    boxVersionRewardId: '00000001-0004-7000-8000-000000000002',
    position: 1,
    rewardVersionId: '00000001-0005-7000-8000-000000000002',
    weight: '20',
  },
  {
    boxVersionRewardId: '00000001-0004-7000-8000-000000000003',
    position: 2,
    rewardVersionId: '00000001-0005-7000-8000-000000000003',
    weight: '75',
  },
];

const rngError = (operation: () => unknown): RngError => {
  try {
    operation();
  } catch (error) {
    if (error instanceof RngError) return error;
    throw error;
  }
  throw new Error('Expected an RNG error.');
};

describe('unbiased rejection sampling', () => {
  it('accepts W=1 and always produces a value below W', () => {
    const sample = sampleWithRejection(1n, () => digest(unsigned256Range - 1n));
    expect(sample).toMatchObject({ acceptedRound: 0n, selectionValue: 0n });
  });

  it('supports the largest signed 64-bit weight', () => {
    const sample = sampleWithRejection(maximumSignedBigint, () => digest(123_456_789n));
    expect(sample.selectionValue).toBeLessThan(maximumSignedBigint);
  });

  it('accepts x=limit-1 and rejects x=limit or greater', () => {
    const weight = 10n;
    const limit = (unsigned256Range / weight) * weight;
    expect(sampleWithRejection(weight, () => digest(limit - 1n))).toMatchObject({
      acceptedRound: 0n,
      selectionValue: 9n,
    });

    const rounds: bigint[] = [];
    const sample = sampleWithRejection(weight, (round) => {
      rounds.push(round);
      return digest(round === 0n ? limit : round === 1n ? limit + 1n : 7n);
    });
    expect(rounds).toEqual([0n, 1n, 2n]);
    expect(sample).toMatchObject({
      acceptedDigest: digest(7n),
      acceptedDigestHex: '00'.repeat(31) + '07',
      acceptedRound: 2n,
      selectionValue: 7n,
    });
  });

  for (const fixture of primitiveVectors.rejectionCases) {
    it(`matches language-neutral rejection fixture ${fixture.name}`, () => {
      const observedRounds: string[] = [];
      const sample = sampleWithRejection(BigInt(fixture.totalWeight), (round) => {
        observedRounds.push(round.toString());
        const roundFixture = fixture.digests.find((item) => item.round === round.toString());
        if (roundFixture === undefined) throw new Error('Missing scripted digest fixture.');
        return Uint8Array.from(Buffer.from(roundFixture.digestHex, 'hex'));
      });
      expect(observedRounds).toEqual(fixture.digests.map(({ round }) => round));
      expect(sample).toMatchObject({
        acceptedDigestHex: fixture.acceptedDigestHex,
        acceptedRound: BigInt(fixture.acceptedRound),
        selectionValue: BigInt(fixture.selectionValue),
      });
      expect(Buffer.from(sample.acceptedDigest).toString('hex')).toBe(fixture.acceptedDigestHex);
    });
  }

  it('rejects invalid totals and digest sizes', () => {
    expect(rngError(() => sampleWithRejection(0n, () => digest(0n))).code).toBe('INVALID_WEIGHT');
    expect(
      rngError(() => sampleWithRejection(maximumSignedBigint + 1n, () => digest(0n))).code,
    ).toBe('WEIGHT_OVERFLOW');
    expect(rngError(() => sampleWithRejection(1n, () => new Uint8Array(31))).code).toBe(
      'INVALID_DIGEST',
    );
  });
});

describe('half-open weighted selection', () => {
  it.each([
    [0n, 0],
    [4n, 0],
    [5n, 1],
    [24n, 1],
    [25n, 2],
    [99n, 2],
  ])('maps selection %s to position %s', (selectionValue, position) => {
    expect(selectWeightedEntry(entries, 100n, selectionValue).position).toBe(position);
  });

  it('validates the complete table before returning a winner', () => {
    const firstEntry = entries[0];
    if (firstEntry === undefined) throw new Error('Expected a weighted entry.');
    expect(rngError(() => selectWeightedEntry(entries, 101n, 0n)).code).toBe(
      'TOTAL_WEIGHT_MISMATCH',
    );
    expect(rngError(() => selectWeightedEntry([{ ...firstEntry, position: 1 }], 5n, 0n)).code).toBe(
      'MALFORMED_MANIFEST',
    );
    expect(rngError(() => selectWeightedEntry([{ ...firstEntry, weight: '0' }], 5n, 0n)).code).toBe(
      'INVALID_WEIGHT',
    );
    expect(rngError(() => selectWeightedEntry([], 1n, 0n)).code).toBe('NO_SELECTABLE_REWARD');
    expect(rngError(() => selectWeightedEntry(entries, 100n, 100n)).code).toBe(
      'NO_SELECTABLE_REWARD',
    );
  });
});
