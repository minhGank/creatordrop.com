import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { parseCurrency, toMoneyMinor } from '@creatordrop/domain';

import {
  IdempotencyKeyReusedError,
  WalletCurrencyNotEnabledError,
} from '../src/modules/wallet/wallet.errors.js';
import type { WalletService } from '../src/modules/wallet/wallet.service.js';
import type { LedgerAccountId, Wallet, WalletId } from '../src/modules/wallet/wallet.js';
import type { UserId } from '../src/modules/creators/creator.js';
import {
  createTestApp,
  createTestAppOptions,
  createUnhandledWalletService,
} from './support/test-app.js';

const actorUserId = '019c0000-0000-7000-8000-000000000001' as UserId;
const wallet: Wallet = {
  availableBalanceMinor: toMoneyMinor(2000n),
  createdAt: '2026-08-24T12:00:00.000Z',
  currency: parseCurrency('USD'),
  id: '019c0000-0000-7000-8000-000000000101' as WalletId,
  ledgerAccountId: '019c0000-0000-7000-8000-000000000102' as LedgerAccountId,
  revision: 2n,
  updatedAt: '2026-08-24T12:00:01.000Z',
  userId: actorUserId,
};

const serviceWith = (overrides: Partial<WalletService>): WalletService => ({
  ...createUnhandledWalletService(),
  ...overrides,
});

describe('wallet API', () => {
  it('returns only the authenticated actor wallet allowlist and supports multiple currencies', async () => {
    const second = { ...wallet, currency: parseCurrency('CAD') };
    const listWallets = vi.fn<WalletService['listWallets']>().mockResolvedValue([wallet, second]);
    const response = await request(
      createTestApp({ walletService: serviceWith({ listWallets }) }),
    ).get('/v1/me/wallets');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      wallets: [
        { balanceMinor: '2000', currency: 'USD', id: wallet.id, revision: '2' },
        { balanceMinor: '2000', currency: 'CAD', id: wallet.id, revision: '2' },
      ],
    });
    expect(JSON.stringify(response.body)).not.toMatch(/ledgerAccount|userId|createdAt|updatedAt/u);
    expect(listWallets).toHaveBeenCalledWith(actorUserId);
  });

  it('grants test credits using actor identity, canonical input, and the idempotency header', async () => {
    const grantTestCredits = vi.fn<WalletService['grantTestCredits']>().mockResolvedValue({
      body: {
        wallet: { balanceMinor: '2000', currency: 'USD', id: wallet.id, revision: '2' },
      },
      replayed: false,
      statusCode: 201,
    });
    const response = await request(
      createTestApp({ walletService: serviceWith({ grantTestCredits }) }),
    )
      .post('/v1/me/wallets/USD/test-credits')
      .set('Idempotency-Key', 'grant_test_001')
      .send({ amountMinor: '2000' });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      wallet: { balanceMinor: '2000', currency: 'USD', id: wallet.id, revision: '2' },
    });
    expect(grantTestCredits).toHaveBeenCalledWith(
      expect.objectContaining({
        amountMinor: 2000n,
        currency: 'USD',
        idempotencyKey: 'grant_test_001',
        userId: actorUserId,
      }),
    );
  });

  it('validates content type, fields, currency, key, and query before the service', async () => {
    const grantTestCredits = vi.fn<WalletService['grantTestCredits']>();
    const app = createTestApp({ walletService: serviceWith({ grantTestCredits }) });

    expect(
      (
        await request(app)
          .post('/v1/me/wallets/USD/test-credits')
          .set('Idempotency-Key', 'grant_test_002')
          .set('Content-Type', 'text/plain')
          .send('2000')
      ).status,
    ).toBe(415);
    expect(
      (
        await request(app)
          .post('/v1/me/wallets/usd/test-credits')
          .set('Idempotency-Key', 'grant_test_003')
          .send({ amountMinor: '2000' })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .post('/v1/me/wallets/USD/test-credits?unexpected=true')
          .set('Idempotency-Key', 'grant_test_004')
          .send({ amountMinor: '2000' })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .post('/v1/me/wallets/USD/test-credits')
          .set('Idempotency-Key', 'grant_test_005')
          .send({ amountMinor: '2000', unexpected: true })
      ).status,
    ).toBe(400);
    expect(
      (await request(app).post('/v1/me/wallets/USD/test-credits').send({ amountMinor: '2000' }))
        .status,
    ).toBe(400);
    expect(grantTestCredits).not.toHaveBeenCalled();
  });

  it('keeps the test-credit route absent when the runtime disables it', async () => {
    const grantTestCredits = vi.fn<WalletService['grantTestCredits']>();
    const response = await request(
      createTestApp({
        runtime: { testCreditsEnabled: false },
        walletService: serviceWith({ grantTestCredits }),
      }),
    )
      .post('/v1/me/wallets/USD/test-credits')
      .set('Idempotency-Key', 'grant_test_006')
      .send({ amountMinor: '2000' });

    expect(response.status).toBe(404);
    expect(grantTestCredits).not.toHaveBeenCalled();
  });

  it.each([
    [new IdempotencyKeyReusedError(), 409, 'IDEMPOTENCY_KEY_REUSED'],
    [new WalletCurrencyNotEnabledError(), 422, 'WALLET_CURRENCY_NOT_ENABLED'],
  ] as const)('maps stable domain errors', async (error, status, code) => {
    const grantTestCredits = vi.fn<WalletService['grantTestCredits']>().mockRejectedValue(error);
    const response = await request(
      createTestApp({ walletService: serviceWith({ grantTestCredits }) }),
    )
      .post('/v1/me/wallets/USD/test-credits')
      .set('Idempotency-Key', 'grant_test_007')
      .send({ amountMinor: '2000' });

    expect(response.status).toBe(status);
    expect(response.body).toMatchObject({ error: { code } });
  });

  it('rate-limits wallet mutations by authenticated actor', async () => {
    const grantTestCredits = vi.fn<WalletService['grantTestCredits']>().mockResolvedValue({
      body: {
        wallet: { balanceMinor: '2000', currency: 'USD', id: wallet.id, revision: '2' },
      },
      replayed: false,
      statusCode: 201,
    });
    const options = createTestAppOptions({
      walletService: serviceWith({ grantTestCredits }),
    });
    const app = createTestApp({
      ...options,
      security: { ...options.security, walletMutationRateLimitMax: 1 },
    });
    const sendGrant = (key: string) =>
      request(app)
        .post('/v1/me/wallets/USD/test-credits')
        .set('Idempotency-Key', key)
        .send({ amountMinor: '2000' });

    expect((await sendGrant('grant_limit_001')).status).toBe(201);
    const limited = await sendGrant('grant_limit_002');
    expect(limited.status).toBe(429);
    expect(limited.body).toMatchObject({ error: { code: 'RATE_LIMITED' } });
    expect(grantTestCredits).toHaveBeenCalledTimes(1);
  });
});
