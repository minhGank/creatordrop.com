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

  it('sends one opening idempotency key and parses the public proof lifecycle', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(boxOpeningFixture))
      .mockResolvedValueOnce(jsonResponse(pendingOpeningProofFixture))
      .mockResolvedValueOnce(jsonResponse(publishedBoxFixture))
      .mockResolvedValueOnce(jsonResponse(currentFairnessFixture));
    const client = createApiClient({ baseUrl: 'https://api.example.test', fetcher });

    await expect(
      client.openBox(
        publishedBoxFixture.manifest.boxId,
        currentFairnessFixture.fairness.clientSeed,
        'opening_stable-key',
        publishedBoxFixture.version.id,
        publishedBoxFixture.configurationHash,
      ),
    ).resolves.toEqual(boxOpeningFixture);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({
        clientSeed: currentFairnessFixture.fairness.clientSeed,
        expectedBoxVersionId: publishedBoxFixture.version.id,
        expectedConfigurationHash: publishedBoxFixture.configurationHash,
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
      client.updateCurrentClientSeed(currentFairnessFixture.fairness.clientSeed, 1),
    ).resolves.toEqual(currentFairnessFixture);
    expect(fetcher.mock.calls[3]?.[1]).toMatchObject({
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
