import type { VerifierDigestSource } from './crypto.js';
import { VerifierError } from './errors.js';

const maximumSignedBigint = 9_223_372_036_854_775_807n;
const unsigned256Range = 1n << 256n;

export interface VerifierRejectionSample {
  readonly acceptedDigestHex: string;
  readonly acceptedRound: bigint;
  readonly roundDigests: readonly {
    readonly digestHex: string;
    readonly round: string;
  }[];
  readonly selectionValue: bigint;
}

export const sampleVerifierDigests = (
  totalWeight: bigint,
  digestSource: VerifierDigestSource,
): VerifierRejectionSample => {
  if (totalWeight <= 0n) throw new VerifierError('INVALID_WEIGHT');
  if (totalWeight > maximumSignedBigint) throw new VerifierError('WEIGHT_OVERFLOW');

  const limit = (unsigned256Range / totalWeight) * totalWeight;
  const roundDigests: { digestHex: string; round: string }[] = [];
  let round = 0n;
  for (;;) {
    const sourceDigest = digestSource(round);
    if (!(sourceDigest instanceof Uint8Array) || sourceDigest.byteLength !== 32) {
      throw new VerifierError('INVALID_PROOF');
    }
    const digest = Uint8Array.from(sourceDigest);
    const digestHex = Buffer.from(digest).toString('hex');
    roundDigests.push({ digestHex, round: round.toString() });
    const candidate = BigInt(`0x${digestHex}`);
    if (candidate < limit) {
      return {
        acceptedDigestHex: digestHex,
        acceptedRound: round,
        roundDigests,
        selectionValue: candidate % totalWeight,
      };
    }
    round += 1n;
  }
};
