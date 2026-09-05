import { describe, expect, it } from 'vitest';

import vectors from '../../../test-vectors/rng/hmac-sha256-rejection-v1.json' with { type: 'json' };
import { verifyPersistedRewardSelectionProof } from '../src/browser.js';

const proofFor = (vector: (typeof vectors.vectors)[number]) => ({
  algorithmVersion: vectors.algorithmVersion,
  clientSeed: vector.clientSeed,
  configurationHash: vector.manifestHash,
  manifest: vector.manifest,
  nonce: vector.nonce,
  openedAt: '2026-09-05T00:00:00.000Z',
  openingId: '019c0000-0000-7000-8000-000000000001',
  recorded: {
    acceptedDigestHex: vector.acceptedDigestHex,
    acceptedRound: vector.acceptedRound,
    boxVersionRewardId: vector.winningEntry.boxVersionRewardId,
    position: vector.winningEntry.position,
    rewardVersionId: vector.winningEntry.rewardVersionId,
    selectionValue: vector.selectionValue,
  },
  seedSetId: vector.seedSetId,
  serverSeedCommitment: vector.serverSeedCommitment,
  serverSeedHex: vector.serverSeedHex,
  specificationId: 'creatordrop-rng-hmac-sha256-rejection-v1',
  verificationStatus: 'ready',
});

describe('browser persisted-opening verifier', () => {
  for (const vector of vectors.vectors) {
    it(`independently verifies persisted ${vector.name}`, async () => {
      await expect(verifyPersistedRewardSelectionProof(proofFor(vector))).resolves.toMatchObject({
        computed: {
          acceptedDigestHex: vector.acceptedDigestHex,
          acceptedRound: vector.acceptedRound,
          boxVersionRewardId: vector.winningEntry.boxVersionRewardId,
          manifestHash: vector.manifestHash,
          position: vector.winningEntry.position,
          rewardVersionId: vector.winningEntry.rewardVersionId,
          selectionValue: vector.selectionValue,
        },
        mismatches: [],
        valid: true,
      });
    });
  }

  it('detects recorded digest, round, selection, and winner tampering', async () => {
    const vector = vectors.vectors[1];
    if (vector === undefined) throw new Error('Expected a vector.');
    const proof = proofFor(vector);
    const result = await verifyPersistedRewardSelectionProof({
      ...proof,
      recorded: {
        ...proof.recorded,
        acceptedDigestHex: `${proof.recorded.acceptedDigestHex.slice(0, -1)}0`,
        acceptedRound: '1',
        boxVersionRewardId: vector.manifest.entries[0]?.boxVersionRewardId,
        position: 0,
        rewardVersionId: vector.manifest.entries[0]?.rewardVersionId,
        selectionValue: '0',
      },
    });
    expect(result.valid).toBe(false);
    expect(result.mismatches).toEqual(
      expect.arrayContaining([
        'ACCEPTED_ROUND',
        'ACCEPTED_DIGEST',
        'SELECTION_VALUE',
        'BOX_VERSION_REWARD',
        'REWARD_VERSION',
        'POSITION',
      ]),
    );
  });
});
