import { describe, expect, it } from 'vitest';

import {
  canonicalizePublishedManifest,
  hashPublishedManifest,
  maximumSignedBigint,
  parsePublishedManifest,
  RngError,
  verifyPublishedManifestHash,
  type PublishedManifest,
} from '../src/index.js';

const baseManifest: PublishedManifest = {
  algorithmVersion: 'hmac-sha256-rejection-v1',
  boxId: '019c0000-0000-7000-8000-000000000010',
  boxVersionId: '019c0000-0000-7000-8000-000000000020',
  currency: 'USD',
  entries: [
    {
      boxVersionRewardId: '019c0000-0000-7000-8000-000000000030',
      position: 0,
      rewardVersionId: '019c0000-0000-7000-8000-000000000040',
      weight: '5',
    },
  ],
  priceMinor: '1000',
  totalWeight: '5',
};

const rngError = (operation: () => unknown): RngError => {
  try {
    operation();
  } catch (error) {
    if (error instanceof RngError) return error;
    throw error;
  }
  throw new Error('Expected an RNG error.');
};

describe('published manifest verification', () => {
  it('preserves the exact Phase 5 canonical bytes and hash', () => {
    expect(canonicalizePublishedManifest(baseManifest)).toBe(
      '{"algorithmVersion":"hmac-sha256-rejection-v1","boxId":"019c0000-0000-7000-8000-000000000010","boxVersionId":"019c0000-0000-7000-8000-000000000020","currency":"USD","entries":[{"boxVersionRewardId":"019c0000-0000-7000-8000-000000000030","position":0,"rewardVersionId":"019c0000-0000-7000-8000-000000000040","weight":"5"}],"priceMinor":"1000","totalWeight":"5"}',
    );
    expect(hashPublishedManifest(baseManifest)).toBe(
      'cfad026a524004200ee9a3b63e7cb8f1b5da563421e9ea7e1dd7d4cac92e8a97',
    );
    expect(
      verifyPublishedManifestHash(
        baseManifest,
        'cfad026a524004200ee9a3b63e7cb8f1b5da563421e9ea7e1dd7d4cac92e8a97',
      ),
    ).toBe('cfad026a524004200ee9a3b63e7cb8f1b5da563421e9ea7e1dd7d4cac92e8a97');
  });

  it('canonicalizes independently of object insertion order', () => {
    const reverseInsertionOrder = {
      totalWeight: '5',
      priceMinor: '1000',
      entries: [
        {
          weight: '5',
          rewardVersionId: '019c0000-0000-7000-8000-000000000040',
          position: 0,
          boxVersionRewardId: '019c0000-0000-7000-8000-000000000030',
        },
      ],
      currency: 'USD',
      boxVersionId: '019c0000-0000-7000-8000-000000000020',
      boxId: '019c0000-0000-7000-8000-000000000010',
      algorithmVersion: 'hmac-sha256-rejection-v1',
    };
    expect(canonicalizePublishedManifest(reverseInsertionOrder)).toBe(
      canonicalizePublishedManifest(baseManifest),
    );
  });

  it('changes the hash when selection-relevant content changes', () => {
    const firstEntry = baseManifest.entries[0];
    if (firstEntry === undefined) throw new Error('Expected a manifest entry.');
    const secondEntry = {
      boxVersionRewardId: '019c0000-0000-7000-8000-000000000031',
      position: 1,
      rewardVersionId: '019c0000-0000-7000-8000-000000000041',
      weight: '10',
    };
    const twoEntries: PublishedManifest = {
      ...baseManifest,
      entries: [{ ...firstEntry, weight: '5' }, secondEntry],
      totalWeight: '15',
    };
    const logicalOrderChanged: PublishedManifest = {
      ...twoEntries,
      entries: [
        { ...secondEntry, position: 0 },
        { ...firstEntry, position: 1 },
      ],
    };
    const hashes = [
      hashPublishedManifest(twoEntries),
      hashPublishedManifest({ ...twoEntries, priceMinor: '1001' }),
      hashPublishedManifest({
        ...twoEntries,
        entries: [
          { ...firstEntry, weight: '6' },
          { ...secondEntry, weight: '9' },
        ],
      }),
      hashPublishedManifest({
        ...twoEntries,
        entries: [
          {
            ...firstEntry,
            rewardVersionId: '019c0000-0000-7000-8000-000000000042',
          },
          secondEntry,
        ],
      }),
      hashPublishedManifest(logicalOrderChanged),
    ];
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it('rejects malformed ordering, weights, totals, algorithms, and unknown fields', () => {
    const entry = baseManifest.entries[0];
    if (entry === undefined) throw new Error('Expected a manifest entry.');
    const invalidCases: readonly [unknown, RngError['code']][] = [
      [{ ...baseManifest, algorithmVersion: 'other' }, 'UNSUPPORTED_ALGORITHM'],
      [{ ...baseManifest, entries: [] }, 'NO_SELECTABLE_REWARD'],
      [{ ...baseManifest, entries: [{ ...entry, position: 1 }] }, 'MALFORMED_MANIFEST'],
      [{ ...baseManifest, entries: [entry, { ...entry, position: 0 }] }, 'MALFORMED_MANIFEST'],
      [
        {
          ...baseManifest,
          entries: [
            { ...entry, weight: '2' },
            {
              ...entry,
              boxVersionRewardId: '019c0000-0000-7000-8000-000000000031',
              position: 1,
              weight: '3',
            },
          ],
        },
        'MALFORMED_MANIFEST',
      ],
      [{ ...baseManifest, entries: [{ ...entry, weight: '0' }] }, 'INVALID_WEIGHT'],
      [{ ...baseManifest, entries: [{ ...entry, weight: '-1' }] }, 'INVALID_WEIGHT'],
      [{ ...baseManifest, totalWeight: '6' }, 'TOTAL_WEIGHT_MISMATCH'],
      [{ ...baseManifest, totalWeight: (maximumSignedBigint + 1n).toString() }, 'WEIGHT_OVERFLOW'],
      [
        {
          ...baseManifest,
          entries: [
            { ...entry, weight: maximumSignedBigint.toString() },
            {
              ...entry,
              boxVersionRewardId: '019c0000-0000-7000-8000-000000000031',
              position: 1,
              rewardVersionId: '019c0000-0000-7000-8000-000000000041',
              weight: '1',
            },
          ],
          totalWeight: maximumSignedBigint.toString(),
        },
        'WEIGHT_OVERFLOW',
      ],
      [{ ...baseManifest, unexpected: true }, 'MALFORMED_MANIFEST'],
      [{ ...baseManifest, boxId: baseManifest.boxId.toUpperCase() }, 'MALFORMED_MANIFEST'],
    ];
    for (const [manifest, code] of invalidCases) {
      expect(rngError(() => parsePublishedManifest(manifest)).code).toBe(code);
    }
  });

  it('rejects fully and partially sparse entry arrays with stable domain errors', () => {
    const firstEntry = baseManifest.entries[0];
    if (firstEntry === undefined) throw new Error('Expected a manifest entry.');
    const fullySparse = new Array<unknown>(1);
    const partiallySparse = new Array<unknown>(2);
    partiallySparse[0] = firstEntry;

    for (const entries of [fullySparse, partiallySparse]) {
      expect(rngError(() => parsePublishedManifest({ ...baseManifest, entries })).code).toBe(
        'MALFORMED_MANIFEST',
      );
    }
  });

  it('uses a stable manifest-hash mismatch error without exposing values', () => {
    const error = rngError(() => verifyPublishedManifestHash(baseManifest, '00'.repeat(32)));
    expect(error.code).toBe('MANIFEST_HASH_MISMATCH');
    expect(error.message).not.toContain('00'.repeat(32));
  });
});
