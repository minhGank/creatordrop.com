import { describe, expect, it } from 'vitest';

import { parsePublishedManifest, RngError } from '@creatordrop/domain';
import { VerifierError, verifyRewardSelectionProof } from '@creatordrop/rng-verifier';

import vectors from '../test-vectors/rng/hmac-sha256-rejection-v1.json' with { type: 'json' };

const vector = vectors.vectors[0];
if (vector === undefined) throw new Error('Expected a validation parity vector.');

const oversizedPriceManifest = {
  ...vector.manifest,
  priceMinor: '9223372036854775808',
};

const proof = {
  algorithmVersion: vectors.algorithmVersion,
  clientSeed: vector.clientSeed,
  configurationHash: vector.manifestHash,
  manifest: oversizedPriceManifest,
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

describe('production and independent verifier validation parity', () => {
  it('classifies signed-64 price overflow as a malformed manifest in both paths', () => {
    const codes: string[] = [];
    try {
      parsePublishedManifest(oversizedPriceManifest);
    } catch (error) {
      if (!(error instanceof RngError)) throw error;
      codes.push(error.code);
    }
    try {
      verifyRewardSelectionProof(proof);
    } catch (error) {
      if (!(error instanceof VerifierError)) throw error;
      codes.push(error.code);
    }

    expect(codes).toEqual(['MALFORMED_MANIFEST', 'MALFORMED_MANIFEST']);
  });
});
