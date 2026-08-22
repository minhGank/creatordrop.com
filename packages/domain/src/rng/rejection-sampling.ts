import { maximumSignedBigint, unsigned256Range } from './constants.js';
import { digestToHex, digestToUnsignedBigint } from './crypto.js';
import { RngError } from './errors.js';
import type { DigestSource, RejectionSample } from './types.js';

export const sampleWithRejection = (
  totalWeight: bigint,
  digestSource: DigestSource,
): RejectionSample => {
  if (typeof totalWeight !== 'bigint' || totalWeight <= 0n) {
    throw new RngError('INVALID_WEIGHT');
  }
  if (totalWeight > maximumSignedBigint) throw new RngError('WEIGHT_OVERFLOW');

  const limit = (unsigned256Range / totalWeight) * totalWeight;
  let round = 0n;
  for (;;) {
    const digest = digestSource(round);
    const candidate = digestToUnsignedBigint(digest);
    if (candidate < limit) {
      return {
        acceptedDigest: Uint8Array.from(digest),
        acceptedDigestHex: digestToHex(digest),
        acceptedRound: round,
        selectionValue: candidate % totalWeight,
      };
    }
    round += 1n;
  }
};
