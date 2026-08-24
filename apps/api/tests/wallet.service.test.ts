import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { parseCurrency, parsePositiveMoneyMinor } from '@creatordrop/domain';

import type { UserId } from '../src/modules/creators/creator.js';
import { buildTestCreditFingerprint } from '../src/modules/wallet/wallet.service.js';

const userId = '019c0000-0000-7000-8000-000000000001' as UserId;

describe('wallet service primitives', () => {
  it('uses the documented deterministic semantic request fingerprint', () => {
    const fingerprint = buildTestCreditFingerprint({
      actorUserId: userId,
      amountMinor: parsePositiveMoneyMinor('2000'),
      currency: parseCurrency('USD'),
    });
    const expected = createHash('sha256')
      .update(`creatordrop:idempotency:v1|wallet.test_credit|${userId}|USD|2000`, 'utf8')
      .digest('hex');

    expect(fingerprint).toBe(expected);
    expect(
      buildTestCreditFingerprint({
        actorUserId: userId,
        amountMinor: parsePositiveMoneyMinor('2000'),
        currency: parseCurrency('USD'),
      }),
    ).toBe(fingerprint);
  });

  it('changes the fingerprint for material actor, amount, and currency changes', () => {
    const baseline = buildTestCreditFingerprint({
      actorUserId: userId,
      amountMinor: parsePositiveMoneyMinor('2000'),
      currency: parseCurrency('USD'),
    });
    const variants = [
      buildTestCreditFingerprint({
        actorUserId: '019c0000-0000-7000-8000-000000000002' as UserId,
        amountMinor: parsePositiveMoneyMinor('2000'),
        currency: parseCurrency('USD'),
      }),
      buildTestCreditFingerprint({
        actorUserId: userId,
        amountMinor: parsePositiveMoneyMinor('2001'),
        currency: parseCurrency('USD'),
      }),
      buildTestCreditFingerprint({
        actorUserId: userId,
        amountMinor: parsePositiveMoneyMinor('2000'),
        currency: parseCurrency('CAD'),
      }),
    ];

    expect(new Set([baseline, ...variants])).toHaveLength(4);
  });
});
