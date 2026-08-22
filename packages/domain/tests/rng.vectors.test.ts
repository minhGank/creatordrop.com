import { describe, expect, it } from 'vitest';

import vectors from '../../../test-vectors/rng/hmac-sha256-rejection-v1.json' with { type: 'json' };
import {
  createHmacSha256DigestSource,
  hashServerSeed,
  RngError,
  selectReward,
} from '../src/index.js';

const serverSeed = (hex: string): Uint8Array => Uint8Array.from(Buffer.from(hex, 'hex'));

const rngError = (operation: () => unknown): RngError => {
  try {
    operation();
  } catch (error) {
    if (error instanceof RngError) return error;
    throw error;
  }
  throw new Error('Expected an RNG error.');
};

describe('production selector normative vectors', () => {
  it('checks in at least ten synthetic vectors', () => {
    expect(vectors.vectors).toHaveLength(10);
  });

  for (const vector of vectors.vectors) {
    it(`matches ${vector.name}`, () => {
      const result = selectReward({
        algorithmVersion: vectors.algorithmVersion,
        clientSeed: vector.clientSeed,
        expectedManifestHash: vector.manifestHash,
        manifest: vector.manifest,
        nonce: vector.nonce,
        seedSetId: vector.seedSetId,
        serverSeed: serverSeed(vector.serverSeedHex),
      });
      expect({
        acceptedDigestHex: result.acceptedDigestHex,
        acceptedRound: result.acceptedRound.toString(),
        boxVersionRewardId: result.boxVersionRewardId,
        manifestHash: result.manifestHash,
        position: result.position,
        rewardVersionId: result.rewardVersionId,
        selectionValue: result.selectionValue.toString(),
        totalWeight: result.totalWeight.toString(),
      }).toEqual({
        acceptedDigestHex: vector.acceptedDigestHex,
        acceptedRound: vector.acceptedRound,
        boxVersionRewardId: vector.winningEntry.boxVersionRewardId,
        manifestHash: vector.manifestHash,
        position: vector.winningEntry.position,
        rewardVersionId: vector.winningEntry.rewardVersionId,
        selectionValue: vector.selectionValue,
        totalWeight: vector.manifest.totalWeight,
      });
      expect(hashServerSeed(serverSeed(vector.serverSeedHex))).toBe(vector.serverSeedCommitment);

      const source = createHmacSha256DigestSource({
        clientSeed: vector.clientSeed,
        nonce: vector.nonce,
        seedSetId: vector.seedSetId,
        serverSeed: serverSeed(vector.serverSeedHex),
      });
      expect(
        vector.roundDigests.map(({ round }) => Buffer.from(source(BigInt(round))).toString('hex')),
      ).toEqual(vector.roundDigests.map(({ digestHex }) => digestHex));
    });
  }

  it('is exactly deterministic and responds to every HMAC input', () => {
    const vector = vectors.vectors[1];
    if (vector === undefined) throw new Error('Expected a vector.');
    const input = {
      algorithmVersion: vectors.algorithmVersion,
      clientSeed: vector.clientSeed,
      expectedManifestHash: vector.manifestHash,
      manifest: vector.manifest,
      nonce: vector.nonce,
      seedSetId: vector.seedSetId,
      serverSeed: serverSeed(vector.serverSeedHex),
    };
    expect(selectReward(input)).toEqual(selectReward(input));
    const baseline = selectReward(input).acceptedDigestHex;
    const changedServerSeed = Uint8Array.from(input.serverSeed);
    changedServerSeed[0] = (changedServerSeed[0] ?? 0) ^ 1;
    expect(selectReward({ ...input, serverSeed: changedServerSeed }).acceptedDigestHex).not.toBe(
      baseline,
    );
    expect(
      selectReward({ ...input, clientSeed: `${'00'.repeat(31)}01` }).acceptedDigestHex,
    ).not.toBe(baseline);
    expect(selectReward({ ...input, nonce: '2' }).acceptedDigestHex).not.toBe(baseline);
    expect(
      selectReward({ ...input, seedSetId: '0000000b-0001-7000-8000-000000000000' })
        .acceptedDigestHex,
    ).not.toBe(baseline);
  });

  it('changes the verified manifest result for valid weight and order changes', () => {
    const vector = vectors.vectors[1];
    if (vector === undefined) throw new Error('Expected a vector.');
    const first = vector.manifest.entries[0];
    const second = vector.manifest.entries[1];
    const third = vector.manifest.entries[2];
    if (first === undefined || second === undefined || third === undefined) {
      throw new Error('Expected three entries.');
    }
    const reweighted = {
      ...vector.manifest,
      entries: [{ ...first, weight: '6' }, { ...second, weight: '19' }, third],
    };
    const reordered = {
      ...vector.manifest,
      entries: [{ ...second, position: 0 }, { ...first, position: 1 }, third],
    };
    const select = (manifest: unknown) =>
      selectReward({
        algorithmVersion: vectors.algorithmVersion,
        clientSeed: vector.clientSeed,
        manifest,
        nonce: vector.nonce,
        seedSetId: vector.seedSetId,
        serverSeed: serverSeed(vector.serverSeedHex),
      });
    expect(select(reweighted).manifestHash).not.toBe(vector.manifestHash);
    expect(select(reordered).manifestHash).not.toBe(vector.manifestHash);
  });

  it('rejects unsupported algorithms and altered expected hashes', () => {
    const vector = vectors.vectors[0];
    if (vector === undefined) throw new Error('Expected a vector.');
    const input = {
      algorithmVersion: vectors.algorithmVersion,
      clientSeed: vector.clientSeed,
      expectedManifestHash: vector.manifestHash,
      manifest: vector.manifest,
      nonce: vector.nonce,
      seedSetId: vector.seedSetId,
      serverSeed: serverSeed(vector.serverSeedHex),
    };
    expect(rngError(() => selectReward({ ...input, algorithmVersion: 'other' })).code).toBe(
      'UNSUPPORTED_ALGORITHM',
    );
    expect(
      rngError(() => selectReward({ ...input, expectedManifestHash: '00'.repeat(32) })).code,
    ).toBe('MANIFEST_HASH_MISMATCH');
  });
});
