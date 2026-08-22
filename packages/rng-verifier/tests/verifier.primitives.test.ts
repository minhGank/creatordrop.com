import { describe, expect, it } from 'vitest';

import primitiveVectors from '../../../test-vectors/rng/hmac-sha256-rejection-v1-primitives.json' with { type: 'json' };
import { buildVerifierHmacMessage, createVerifierHmacDigestSource } from '../src/crypto.js';
import { sampleVerifierDigests } from '../src/rejection-sampling.js';

const digest = (hex: string): Uint8Array => Uint8Array.from(Buffer.from(hex, 'hex'));

describe('independent verifier cryptographic primitives', () => {
  for (const fixture of primitiveVectors.hmacCases) {
    it(`matches independently checked HMAC fixture ${fixture.name}`, () => {
      const serverSeed = digest(fixture.serverSeedHex);
      const message = buildVerifierHmacMessage(
        fixture.seedSetId,
        fixture.clientSeed,
        fixture.nonce,
        BigInt(fixture.round),
      );
      const source = createVerifierHmacDigestSource({
        clientSeed: fixture.clientSeed,
        nonce: fixture.nonce,
        seedSetId: fixture.seedSetId,
        serverSeed,
      });

      expect(message).toBe(fixture.message);
      expect(Buffer.from(source(BigInt(fixture.round))).toString('hex')).toBe(fixture.digestHex);
    });
  }

  for (const fixture of primitiveVectors.rejectionCases) {
    it(`matches crafted rejection fixture ${fixture.name}`, () => {
      const observedRounds: string[] = [];
      const sample = sampleVerifierDigests(BigInt(fixture.totalWeight), (round) => {
        observedRounds.push(round.toString());
        const roundFixture = fixture.digests.find((item) => item.round === round.toString());
        if (roundFixture === undefined) throw new Error('Missing scripted verifier digest.');
        return digest(roundFixture.digestHex);
      });

      expect(((1n << 256n) / BigInt(fixture.totalWeight)) * BigInt(fixture.totalWeight)).toBe(
        BigInt(fixture.limit),
      );
      expect(observedRounds).toEqual(fixture.digests.map(({ round }) => round));
      expect(sample).toEqual({
        acceptedDigestHex: fixture.acceptedDigestHex,
        acceptedRound: BigInt(fixture.acceptedRound),
        roundDigests: fixture.digests,
        selectionValue: BigInt(fixture.selectionValue),
      });
    });
  }
});
