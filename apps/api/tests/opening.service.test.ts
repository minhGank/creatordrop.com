import { describe, expect, it } from 'vitest';

import {
  calculateOpeningFinancialSplit,
  calculateOpeningPoints,
} from '../src/modules/openings/opening.service.js';

describe('opening financial policy', () => {
  it('floors a 20 percent fee in integer minor units', () => {
    expect(calculateOpeningFinancialSplit(999n, 2000)).toEqual({
      creatorShareMinor: 800n,
      platformFeeMinor: 199n,
    });
  });

  it('rejects fee policies that could eliminate the creator share', () => {
    expect(() => calculateOpeningFinancialSplit(1000n, 10_000)).toThrow();
    expect(() => calculateOpeningFinancialSplit(0n, 2000)).toThrow();
  });

  it('awards five normal points and twenty base-reward points', () => {
    expect(calculateOpeningPoints(false)).toBe(5);
    expect(calculateOpeningPoints(true)).toBe(20);
  });
});
