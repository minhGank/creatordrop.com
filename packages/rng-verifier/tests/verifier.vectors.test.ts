import { describe, expect, it } from 'vitest';

import vectors from '../../../test-vectors/rng/hmac-sha256-rejection-v1.json' with { type: 'json' };
import { VerifierError, verifyRewardSelectionProof } from '../src/index.js';

const proofFor = (vector: (typeof vectors.vectors)[number]) => ({
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
});

const flipHex = (value: string): string => `${value.startsWith('0') ? '1' : '0'}${value.slice(1)}`;

const verifierError = (operation: () => unknown): VerifierError => {
  try {
    operation();
  } catch (error) {
    if (error instanceof VerifierError) return error;
    throw error;
  }
  throw new Error('Expected a verifier error.');
};

describe('independent RNG verifier', () => {
  for (const vector of vectors.vectors) {
    it(`independently verifies ${vector.name}`, () => {
      const result = verifyRewardSelectionProof(proofFor(vector));
      expect(result).toMatchObject({
        computed: {
          acceptedDigestHex: vector.acceptedDigestHex,
          acceptedRound: vector.acceptedRound,
          boxVersionRewardId: vector.winningEntry.boxVersionRewardId,
          manifestHash: vector.manifestHash,
          position: vector.winningEntry.position,
          rewardVersionId: vector.winningEntry.rewardVersionId,
          selectionValue: vector.selectionValue,
          serverSeedCommitment: vector.serverSeedCommitment,
          totalWeight: vector.manifest.totalWeight,
        },
        mismatches: [],
        valid: true,
      });
      expect(result.computed.roundDigests).toEqual(vector.roundDigests);
    });
  }

  it('detects every altered recorded proof field', () => {
    const vector = vectors.vectors[1];
    if (vector === undefined) throw new Error('Expected a vector.');
    const proof = proofFor(vector);
    const alterations = [
      {
        code: 'SERVER_SEED_COMMITMENT',
        proof: { ...proof, serverSeedCommitment: flipHex(proof.serverSeedCommitment) },
      },
      {
        code: 'MANIFEST_HASH',
        proof: { ...proof, configurationHash: flipHex(proof.configurationHash) },
      },
      {
        code: 'ROUND_DIGESTS',
        proof: {
          ...proof,
          recorded: {
            ...proof.recorded,
            roundDigests: proof.recorded.roundDigests.map((item) => ({
              ...item,
              digestHex: flipHex(item.digestHex),
            })),
          },
        },
      },
      {
        code: 'ACCEPTED_ROUND',
        proof: { ...proof, recorded: { ...proof.recorded, acceptedRound: '1' } },
      },
      {
        code: 'ACCEPTED_DIGEST',
        proof: {
          ...proof,
          recorded: {
            ...proof.recorded,
            acceptedDigestHex: flipHex(proof.recorded.acceptedDigestHex),
          },
        },
      },
      {
        code: 'SELECTION_VALUE',
        proof: { ...proof, recorded: { ...proof.recorded, selectionValue: '0' } },
      },
      {
        code: 'BOX_VERSION_REWARD',
        proof: {
          ...proof,
          recorded: {
            ...proof.recorded,
            boxVersionRewardId: vector.manifest.entries[0]?.boxVersionRewardId,
          },
        },
      },
      {
        code: 'REWARD_VERSION',
        proof: {
          ...proof,
          recorded: {
            ...proof.recorded,
            rewardVersionId: vector.manifest.entries[0]?.rewardVersionId,
          },
        },
      },
      {
        code: 'POSITION',
        proof: { ...proof, recorded: { ...proof.recorded, position: 0 } },
      },
    ] as const;
    for (const alteration of alterations) {
      const result = verifyRewardSelectionProof(alteration.proof);
      expect(result.valid).toBe(false);
      expect(result.mismatches).toContain(alteration.code);
    }
  });

  it('detects altered manifest content rather than normalizing it', () => {
    const vector = vectors.vectors[1];
    if (vector === undefined) throw new Error('Expected a vector.');
    const first = vector.manifest.entries[0];
    const second = vector.manifest.entries[1];
    const third = vector.manifest.entries[2];
    if (first === undefined || second === undefined || third === undefined) {
      throw new Error('Expected three entries.');
    }
    const proof = proofFor(vector);
    const result = verifyRewardSelectionProof({
      ...proof,
      manifest: {
        ...vector.manifest,
        entries: [{ ...first, weight: '6' }, { ...second, weight: '19' }, third],
      },
    });
    expect(result.valid).toBe(false);
    expect(result.mismatches).toContain('MANIFEST_HASH');
  });

  it('rejects malformed proof and canonical inputs with stable secret-free errors', () => {
    const vector = vectors.vectors[0];
    if (vector === undefined) throw new Error('Expected a vector.');
    const proof = proofFor(vector);
    expect(
      verifierError(() =>
        verifyRewardSelectionProof({ ...proof, clientSeed: proof.clientSeed.toUpperCase() }),
      ).code,
    ).toBe('INVALID_CLIENT_SEED');
    expect(
      verifierError(() =>
        verifyRewardSelectionProof({
          ...proof,
          seedSetId: 'ABCDEF01-0001-7000-8000-000000000000',
        }),
      ).code,
    ).toBe('INVALID_SEED_SET_ID');
    const error = verifierError(() =>
      verifyRewardSelectionProof({ ...proof, serverSeedHex: '00' }),
    );
    expect(error.code).toBe('INVALID_SERVER_SEED');
    expect(error.message).not.toContain(proof.serverSeedHex);
  });
});
