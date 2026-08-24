import { describe, expect, it } from 'vitest';

import {
  addMoneyMinor,
  maximumMoneyMinor,
  minimumMoneyMinor,
  MoneyValueError,
  negateMoneyMinor,
  parseCurrency,
  parsePositiveMoneyMinor,
  toMoneyMinor,
} from '../src/index.js';

describe('money primitives', () => {
  it('accepts canonical currencies and positive signed-64 minor amounts', () => {
    expect(parseCurrency('USD')).toBe('USD');
    expect(parsePositiveMoneyMinor('1')).toBe(1n);
    expect(parsePositiveMoneyMinor(maximumMoneyMinor.toString())).toBe(maximumMoneyMinor);
  });

  it.each(['usd', 'US', 'USDD', 'U1D', '', 123])('rejects noncanonical currency %j', (value) => {
    expect(() => parseCurrency(value)).toThrow(MoneyValueError);
  });

  it.each(['0', '-1', '+1', '01', '1.0', '', 1])(
    'rejects noncanonical positive amount %j',
    (value) => {
      expect(() => parsePositiveMoneyMinor(value)).toThrow(MoneyValueError);
    },
  );

  it('rejects signed-64 overflow without Number coercion', () => {
    expect(() => parsePositiveMoneyMinor('9223372036854775808')).toThrow(MoneyValueError);
    expect(() => toMoneyMinor(maximumMoneyMinor + 1n)).toThrow(MoneyValueError);
    expect(() => toMoneyMinor(minimumMoneyMinor - 1n)).toThrow(MoneyValueError);
  });

  it('performs checked bigint addition and negation', () => {
    expect(addMoneyMinor(toMoneyMinor(500n), toMoneyMinor(-125n))).toBe(375n);
    expect(negateMoneyMinor(toMoneyMinor(500n))).toBe(-500n);
    expect(() => addMoneyMinor(toMoneyMinor(maximumMoneyMinor), toMoneyMinor(1n))).toThrow(
      MoneyValueError,
    );
    expect(() => negateMoneyMinor(toMoneyMinor(minimumMoneyMinor))).toThrow(MoneyValueError);
  });
});
