import { describe, expect, it } from 'vitest';

import { maximumMoneyMinor } from '@creatordrop/domain';

import {
  parseTestCreditInput,
  parseWalletCurrency,
  parseWalletIdempotencyKey,
} from '../src/modules/wallet/wallet.schema.js';

describe('wallet request schemas', () => {
  it('accepts canonical bigint minor units, currencies, and idempotency keys', () => {
    expect(parseTestCreditInput({ amountMinor: maximumMoneyMinor.toString() }).amountMinor).toBe(
      maximumMoneyMinor,
    );
    expect(parseWalletCurrency('USD')).toBe('USD');
    expect(parseWalletIdempotencyKey('grant_2026-08-24')).toBe('grant_2026-08-24');
  });

  it.each([
    { amountMinor: 1 },
    { amountMinor: '0' },
    { amountMinor: '-1' },
    { amountMinor: '01' },
    { amountMinor: '9223372036854775808' },
    { amountMinor: '1', unexpected: true },
    null,
  ])('rejects a noncanonical test-credit body: %o', (body) => {
    expect(() => parseTestCreditInput(body)).toThrow();
  });

  it.each(['usd', 'US', 'USDD', '12D', ' USD'])('rejects invalid currency %s', (currency) => {
    expect(() => parseWalletCurrency(currency)).toThrow();
  });

  it.each([undefined, 'short', 'contains space', 'x'.repeat(129)])(
    'rejects invalid idempotency key %s',
    (key) => {
      expect(() => parseWalletIdempotencyKey(key)).toThrow();
    },
  );
});
