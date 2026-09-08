import { describe, expect, it } from 'vitest';

import { formatMinorUnits } from '../src/formatting/money.js';
import { formatProbability } from '../src/formatting/probability.js';

describe('catalog display formatting', () => {
  it('formats integer minor units without floating-point money arithmetic', () => {
    expect(formatMinorUnits('999', 'USD')).toBe('$9.99');
    expect(formatMinorUnits('123456789012345678901', 'USD')).toBe('$1,234,567,890,123,456,789.01');
    expect(formatMinorUnits('999', 'JPY')).toBe('¥999');
  });

  it('formats exact and repeating integer weights without hiding a positive probability', () => {
    expect(formatProbability('1', '100')).toBe('1%');
    expect(formatProbability('720', '1000')).toBe('72%');
    expect(formatProbability('190', '1000')).toBe('19%');
    expect(formatProbability('70', '1000')).toBe('7%');
    expect(formatProbability('16', '1000')).toBe('1.6%');
    expect(formatProbability('4', '1000')).toBe('0.4%');
    expect(formatProbability('1', '3')).toBe('≈33.333333%');
    expect(formatProbability('1', '100000000000')).toBe('<0.000001%');
  });

  it('rejects malformed display inputs', () => {
    expect(() => formatMinorUnits('9.99', 'USD')).toThrow();
    expect(() => formatProbability('0', '100')).toThrow();
    expect(() => formatProbability('101', '100')).toThrow();
  });
});
