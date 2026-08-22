import { describe, expect, it } from 'vitest';

import vectors from '../../../test-vectors/rng/hmac-sha256-rejection-v1.json' with { type: 'json' };
import { VerifierError, verifyRewardSelectionProof } from '../src/index.js';

const vector = vectors.vectors[1];
if (vector === undefined) throw new Error('Expected an independent manifest test vector.');

const proof = {
  algorithmVersion: vectors.algorithmVersion,
  clientSeed: vector.clientSeed,
  configurationHash: vector.manifestHash,
  manifest: vector.manifest,
  nonce: vector.nonce,
  recorded: {
    acceptedDigestHex: vector.acceptedDigestHex,
    acceptedRound: vector.acceptedRound,
    boxVersionRewardId: vector.winningEntry.boxVersionRewardId,
    position: vector.winningEntry.position,
    rewardVersionId: vector.winningEntry.rewardVersionId,
    roundDigests: vector.roundDigests,
    selectionValue: vector.selectionValue,
  },
  seedSetId: vector.seedSetId,
  serverSeedCommitment: vector.serverSeedCommitment,
  serverSeedHex: vector.serverSeedHex,
};

const verifierError = (input: unknown): VerifierError => {
  try {
    verifyRewardSelectionProof(input);
  } catch (error) {
    if (error instanceof VerifierError) return error;
    throw error;
  }
  throw new Error('Expected a verifier error.');
};

const first = vector.manifest.entries[0];
const second = vector.manifest.entries[1];
const third = vector.manifest.entries[2];
if (first === undefined || second === undefined || third === undefined) {
  throw new Error('Expected three independent manifest entries.');
}

describe('independent verifier manifest conformance', () => {
  it('canonicalizes root and entry properties independently of insertion order', () => {
    const reversedEntries = vector.manifest.entries.map((entry) => ({
      weight: entry.weight,
      rewardVersionId: entry.rewardVersionId,
      position: entry.position,
      boxVersionRewardId: entry.boxVersionRewardId,
    }));
    const reversedManifest = {
      totalWeight: vector.manifest.totalWeight,
      priceMinor: vector.manifest.priceMinor,
      entries: reversedEntries,
      currency: vector.manifest.currency,
      boxVersionId: vector.manifest.boxVersionId,
      boxId: vector.manifest.boxId,
      algorithmVersion: vector.manifest.algorithmVersion,
    };

    const result = verifyRewardSelectionProof({ ...proof, manifest: reversedManifest });
    expect(result.valid).toBe(true);
    expect(result.computed.manifestHash).toBe(vector.manifestHash);
  });

  it.each([
    [
      'position gap',
      { ...vector.manifest, entries: [{ ...first, position: 1 }] },
      'MALFORMED_MANIFEST',
    ],
    [
      'duplicate position',
      { ...vector.manifest, entries: [first, { ...second, position: 0 }, third] },
      'MALFORMED_MANIFEST',
    ],
    [
      'duplicate association ID',
      {
        ...vector.manifest,
        entries: [first, { ...second, boxVersionRewardId: first.boxVersionRewardId }, third],
      },
      'MALFORMED_MANIFEST',
    ],
    [
      'duplicate reward-version ID',
      {
        ...vector.manifest,
        entries: [first, { ...second, rewardVersionId: first.rewardVersionId }, third],
      },
      'MALFORMED_MANIFEST',
    ],
    ['numeric price', { ...vector.manifest, priceMinor: 1000 }, 'MALFORMED_MANIFEST'],
    [
      'numeric weight',
      { ...vector.manifest, entries: [{ ...first, weight: 5 }, second, third] },
      'INVALID_WEIGHT',
    ],
    ['numeric total', { ...vector.manifest, totalWeight: 100 }, 'INVALID_WEIGHT'],
    ['leading-zero price', { ...vector.manifest, priceMinor: '01000' }, 'MALFORMED_MANIFEST'],
    [
      'leading-zero weight',
      { ...vector.manifest, entries: [{ ...first, weight: '05' }, second, third] },
      'INVALID_WEIGHT',
    ],
    ['leading-zero total', { ...vector.manifest, totalWeight: '0100' }, 'INVALID_WEIGHT'],
    ['zero price', { ...vector.manifest, priceMinor: '0' }, 'MALFORMED_MANIFEST'],
    [
      'zero weight',
      { ...vector.manifest, entries: [{ ...first, weight: '0' }, second, third] },
      'INVALID_WEIGHT',
    ],
    ['zero total', { ...vector.manifest, totalWeight: '0' }, 'INVALID_WEIGHT'],
    ['negative price', { ...vector.manifest, priceMinor: '-1' }, 'MALFORMED_MANIFEST'],
    [
      'negative weight',
      { ...vector.manifest, entries: [{ ...first, weight: '-1' }, second, third] },
      'INVALID_WEIGHT',
    ],
    ['negative total', { ...vector.manifest, totalWeight: '-1' }, 'INVALID_WEIGHT'],
    [
      'weight overflow',
      {
        ...vector.manifest,
        entries: [{ ...first, weight: '9223372036854775808' }, second, third],
      },
      'WEIGHT_OVERFLOW',
    ],
    [
      'total overflow',
      { ...vector.manifest, totalWeight: '9223372036854775808' },
      'WEIGHT_OVERFLOW',
    ],
    [
      'price overflow',
      { ...vector.manifest, priceMinor: '9223372036854775808' },
      'MALFORMED_MANIFEST',
    ],
    ['total mismatch', { ...vector.manifest, totalWeight: '101' }, 'TOTAL_WEIGHT_MISMATCH'],
    ['unknown root field', { ...vector.manifest, unexpected: true }, 'MALFORMED_MANIFEST'],
    [
      'unknown entry field',
      { ...vector.manifest, entries: [{ ...first, unexpected: true }, second, third] },
      'MALFORMED_MANIFEST',
    ],
    [
      'noncanonical UUID',
      { ...vector.manifest, boxId: 'ABCDEF02-0002-7000-8000-000000000000' },
      'MALFORMED_MANIFEST',
    ],
    ['lowercase currency', { ...vector.manifest, currency: 'usd' }, 'MALFORMED_MANIFEST'],
    ['invalid currency', { ...vector.manifest, currency: 'US' }, 'MALFORMED_MANIFEST'],
  ] satisfies readonly (readonly [string, unknown, VerifierError['code']])[])(
    'rejects %s',
    (_name, manifest, code) => {
      expect(verifierError({ ...proof, manifest }).code).toBe(code);
    },
  );

  it('rejects fully and partially sparse manifest arrays with stable errors', () => {
    const fullySparse = new Array<unknown>(1);
    const partiallySparse = new Array<unknown>(3);
    partiallySparse[0] = first;
    partiallySparse[2] = third;

    for (const entries of [fullySparse, partiallySparse]) {
      expect(verifierError({ ...proof, manifest: { ...vector.manifest, entries } }).code).toBe(
        'MALFORMED_MANIFEST',
      );
    }
  });

  it('requires the exact proof fields to be own properties', () => {
    const expectedFields = [
      'algorithmVersion',
      'clientSeed',
      'configurationHash',
      'manifest',
      'nonce',
      'recorded',
      'seedSetId',
      'serverSeedCommitment',
      'serverSeedHex',
    ];
    const inheritedProof = Object.create(proof) as typeof proof;
    Object.defineProperty(inheritedProof, expectedFields.sort().join('\0'), {
      enumerable: true,
      value: true,
    });

    expect(verifierError(inheritedProof).code).toBe('INVALID_PROOF');
  });
});
