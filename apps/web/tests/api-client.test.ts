import { describe, expect, it, vi } from 'vitest';

import {
  CreatorDropApiError,
  CreatorDropProtocolError,
  createApiClient,
} from '../src/api/client.js';
import {
  authSessionResponseFixture,
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
