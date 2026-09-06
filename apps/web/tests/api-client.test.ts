import { describe, expect, it, vi } from 'vitest';

import {
  CreatorDropApiError,
  CreatorDropProtocolError,
  createApiClient,
} from '../src/api/client.js';
import {
  authSessionResponseFixture,
  boxOpeningFixture,
  currentFairnessFixture,
  pendingOpeningProofFixture,
  publicCreatorResponseFixture,
  publicCreatorsResponseFixture,
  publishedBoxFixture,
} from './fixtures.js';

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    status,
  });

describe('CreatorDrop API client', () => {
  it('uses one typed public boundary and adds bearer tokens only when available', async () => {
    const fetcher = vi.fn<typeof fetch>(() =>
      Promise.resolve(jsonResponse(publicCreatorsResponseFixture)),
    );
    const client = createApiClient({
      baseUrl: 'https://api.example.test',
      fetcher,
      getAccessToken: () => Promise.resolve('session-token'),
    });

    await expect(client.listCreators()).resolves.toEqual(publicCreatorsResponseFixture);
    expect(fetcher).toHaveBeenCalledOnce();
    const request = fetcher.mock.calls[0];
    expect(request?.[0]).toBe('https://api.example.test/v1/catalog/creators');
    expect(request?.[1]?.headers).toMatchObject({ Authorization: 'Bearer session-token' });
  });

  it('bootstraps the backend session with an explicit token and never retries the mutation', async () => {
    const fetcher = vi.fn<typeof fetch>(() =>
      Promise.resolve(jsonResponse(authSessionResponseFixture)),
    );
    const client = createApiClient({ baseUrl: 'https://api.example.test', fetcher });

    await expect(client.exchangeSession('exchange-token')).resolves.toEqual(
      authSessionResponseFixture,
    );
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      body: '{}',
      headers: { Authorization: 'Bearer exchange-token', 'Content-Type': 'application/json' },
      method: 'POST',
    });
  });

  it('reads wallets and posts the fixed USD test-credit grant with caller idempotency', async () => {
    const wallet = {
      balanceMinor: '100000',
      currency: 'USD',
      id: '00000000-0000-4000-8000-000000000501',
      revision: '1',
    } as const;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ wallets: [wallet] }))
      .mockResolvedValueOnce(jsonResponse({ wallet }, 201));
    const client = createApiClient({
      baseUrl: 'https://api.example.test',
      fetcher,
      getAccessToken: () => Promise.resolve('session-token'),
    });

    await expect(client.listWallets()).resolves.toEqual({ wallets: [wallet] });
    await expect(client.grantUsdTestCredits('wallet_test_credit_click-one')).resolves.toEqual({
      wallet,
    });
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://api.example.test/v1/me/wallets');
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      headers: { Authorization: 'Bearer session-token' },
      method: 'GET',
    });
    expect(fetcher.mock.calls[1]?.[0]).toBe(
      'https://api.example.test/v1/me/wallets/USD/test-credits',
    );
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({
      body: JSON.stringify({ amountMinor: '100000' }),
      headers: {
        Authorization: 'Bearer session-token',
        'Idempotency-Key': 'wallet_test_credit_click-one',
      },
      method: 'POST',
    });
  });

  it('uses the creator-scoped public box-detail route', async () => {
    const response = { box: publishedBoxFixture, creator: publicCreatorResponseFixture.creator };
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse(response)));
    const client = createApiClient({ baseUrl: 'https://api.example.test', fetcher });

    await expect(
      client.getCreatorBox('creator-one', publishedBoxFixture.manifest.boxId),
    ).resolves.toEqual(response);
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      `https://api.example.test/v1/catalog/creators/creator-one/boxes/${publishedBoxFixture.manifest.boxId}`,
    );
  });

  it('initializes the server commitment without supplying an opening client seed', async () => {
    const unconfigured = {
      fairness: { ...currentFairnessFixture.fairness, clientSeed: null },
    };
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse(unconfigured, 201)));
    const client = createApiClient({ baseUrl: 'https://api.example.test', fetcher });

    await expect(client.initializeFairness()).resolves.toEqual(unconfigured);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://api.example.test/v1/me/fairness');
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({}),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
  });

  it('sends one opening idempotency key and parses the public proof lifecycle', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(boxOpeningFixture))
      .mockResolvedValueOnce(jsonResponse(pendingOpeningProofFixture))
      .mockResolvedValueOnce(jsonResponse(publishedBoxFixture))
      .mockResolvedValueOnce(jsonResponse(currentFairnessFixture));
    const client = createApiClient({ baseUrl: 'https://api.example.test', fetcher });
    const clientSeed = currentFairnessFixture.fairness.clientSeed;
    if (clientSeed === null) throw new Error('Expected configured fairness fixture.');

    await expect(
      client.openBox(
        publishedBoxFixture.manifest.boxId,
        clientSeed,
        'opening_stable-key',
        publishedBoxFixture.version.id,
        publishedBoxFixture.configurationHash,
        currentFairnessFixture.fairness.activeSeedSet.id,
        currentFairnessFixture.fairness.activeSeedSet.commitment,
      ),
    ).resolves.toEqual(boxOpeningFixture);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({
        clientSeed,
        expectedBoxVersionId: publishedBoxFixture.version.id,
        expectedConfigurationHash: publishedBoxFixture.configurationHash,
        expectedSeedSetId: currentFairnessFixture.fairness.activeSeedSet.id,
        expectedServerSeedCommitment: currentFairnessFixture.fairness.activeSeedSet.commitment,
      }),
      headers: { 'Idempotency-Key': 'opening_stable-key' },
      method: 'POST',
    });
    await expect(client.getOpeningFairnessProof(boxOpeningFixture.opening.id)).resolves.toEqual(
      pendingOpeningProofFixture,
    );
    expect(fetcher.mock.calls[1]?.[0]).toBe(
      `https://api.example.test/v1/fairness/openings/${boxOpeningFixture.opening.id}`,
    );
    await expect(
      client.getPublishedBoxVersion(
        publishedBoxFixture.manifest.boxId,
        publishedBoxFixture.manifest.boxVersionId,
      ),
    ).resolves.toEqual(publishedBoxFixture);
    expect(fetcher.mock.calls[2]?.[0]).toBe(
      `https://api.example.test/v1/boxes/${publishedBoxFixture.manifest.boxId}/versions/${publishedBoxFixture.manifest.boxVersionId}`,
    );
    await expect(
      client.updateCurrentClientSeed(
        clientSeed,
        1,
        currentFairnessFixture.fairness.activeSeedSet.id,
        currentFairnessFixture.fairness.activeSeedSet.commitment,
      ),
    ).resolves.toEqual(currentFairnessFixture);
    expect(fetcher.mock.calls[3]?.[1]).toMatchObject({
      body: JSON.stringify({
        clientSeed,
        expectedSeedSetId: currentFairnessFixture.fairness.activeSeedSet.id,
        expectedServerSeedCommitment: currentFairnessFixture.fairness.activeSeedSet.commitment,
      }),
      headers: { 'If-Match': '"1"' },
      method: 'PUT',
    });
  });

  it('parses stable API errors, handles 401 cleanup, and rejects malformed success data', async () => {
    const unauthorized = vi.fn();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: {
              code: 'AUTHENTICATION_REQUIRED',
              details: {},
              message: 'Authentication is required.',
              requestId: 'request-one',
            },
          },
          401,
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ creators: 'not-an-array', nextCursor: null }));
    const client = createApiClient({
      baseUrl: 'https://api.example.test',
      fetcher,
      onUnauthorized: unauthorized,
    });

    const first = client.listCreators();
    await expect(first).rejects.toBeInstanceOf(CreatorDropApiError);
    expect(unauthorized).toHaveBeenCalledOnce();
    await expect(client.listCreators()).rejects.toBeInstanceOf(CreatorDropProtocolError);
  });
});
