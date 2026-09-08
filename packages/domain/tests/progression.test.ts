import { describe, expect, it } from 'vitest';
import { cumulativeXpForLevel, maximumLifetimeXp, progressionForXp } from '../src/progression.js';

describe('global XP progression', () => {
  it.each([
    [0n, 1n],
    [99n, 1n],
    [100n, 2n],
    [299n, 2n],
    [300n, 3n],
    [599n, 3n],
    [600n, 4n],
    [1000n, 5n],
    [1500n, 6n],
    [640n, 4n],
  ])('derives %s XP as level %s', (xp, level) => {
    expect(progressionForXp(xp)).toEqual({
      lifetimeXp: xp,
      level,
      xpInLevel: xp - cumulativeXpForLevel(level),
      xpForNextLevel: level * 100n,
    });
  });
  it('preserves every exact boundary through high supported levels', () => {
    for (const level of [2n, 9n, 100n, 1_000_000n, 100_000_000n]) {
      const threshold = cumulativeXpForLevel(level);
      expect(progressionForXp(threshold).level).toBe(level);
      expect(progressionForXp(threshold - 1n).level).toBe(level - 1n);
      expect(cumulativeXpForLevel(level + 1n) - threshold).toBe(100n * level);
    }
    const state = progressionForXp(maximumLifetimeXp);
    expect(cumulativeXpForLevel(state.level)).toBeLessThanOrEqual(maximumLifetimeXp);
    expect(cumulativeXpForLevel(state.level + 1n)).toBeGreaterThan(maximumLifetimeXp);
    expect(state.xpInLevel).toBeLessThan(state.xpForNextLevel);
  });
  it('counts multiple crossed levels and rejects unsupported totals', () => {
    expect(progressionForXp(640n).level - progressionForXp(290n).level).toBe(2n);
    expect(() => progressionForXp(-1n)).toThrow(RangeError);
    expect(() => progressionForXp(maximumLifetimeXp + 1n)).toThrow(RangeError);
  });
});
