import { maximumSignedBigint } from './constants.js';
import { RngError } from './errors.js';
import type { PublishedManifestEntry } from './types.js';

const positiveIntegerPattern = /^[1-9][0-9]*$/u;

export const selectWeightedEntry = (
  entries: readonly PublishedManifestEntry[],
  totalWeight: bigint,
  selectionValue: bigint,
): PublishedManifestEntry => {
  if (entries.length === 0) throw new RngError('NO_SELECTABLE_REWARD');
  if (totalWeight <= 0n || totalWeight > maximumSignedBigint) {
    throw new RngError(totalWeight > maximumSignedBigint ? 'WEIGHT_OVERFLOW' : 'INVALID_WEIGHT');
  }
  if (selectionValue < 0n || selectionValue >= totalWeight) {
    throw new RngError('NO_SELECTABLE_REWARD');
  }

  const intervals: {
    readonly end: bigint;
    readonly entry: PublishedManifestEntry;
    readonly start: bigint;
  }[] = [];
  let total = 0n;
  for (const [expectedPosition, entry] of entries.entries()) {
    if (entry.position !== expectedPosition || !positiveIntegerPattern.test(entry.weight)) {
      throw new RngError(
        entry.position !== expectedPosition ? 'MALFORMED_MANIFEST' : 'INVALID_WEIGHT',
      );
    }
    const weight = BigInt(entry.weight);
    if (weight > maximumSignedBigint || total > maximumSignedBigint - weight) {
      throw new RngError('WEIGHT_OVERFLOW');
    }
    const end = total + weight;
    intervals.push({ end, entry, start: total });
    total = end;
  }
  if (total !== totalWeight) throw new RngError('TOTAL_WEIGHT_MISMATCH');
  const selected = intervals.find(
    ({ end, start }) => selectionValue >= start && selectionValue < end,
  );
  if (selected !== undefined) return selected.entry;
  throw new RngError('NO_SELECTABLE_REWARD');
};
