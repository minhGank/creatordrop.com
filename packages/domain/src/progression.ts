// Lifetime XP is authoritative. All threshold arithmetic remains integral.
export const maximumLifetimeXp = 9_223_372_036_854_775_807n;

export const cumulativeXpForLevel = (level: bigint): bigint => {
  if (level < 1n) throw new RangeError('Level must be positive.');
  return 50n * level * (level - 1n);
};

export const progressionForXp = (lifetimeXp: bigint) => {
  if (lifetimeXp < 0n || lifetimeXp > maximumLifetimeXp) {
    throw new RangeError('Lifetime XP is outside supported storage.');
  }
  let low = 1n;
  let high = 1n;
  while (cumulativeXpForLevel(high) <= lifetimeXp) high *= 2n;
  while (high - low > 1n) {
    const middle = (low + high) / 2n;
    if (cumulativeXpForLevel(middle) <= lifetimeXp) low = middle;
    else high = middle;
  }
  return {
    lifetimeXp,
    level: low,
    xpInLevel: lifetimeXp - cumulativeXpForLevel(low),
    xpForNextLevel: low * 100n,
  };
};
