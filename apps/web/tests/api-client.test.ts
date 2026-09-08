import { describe, expect, it, vi } from 'vitest';
import { entryClaim, entryMethod, entryPolicy, entryState } from './entry-fixtures.js';

import {
  CreatorDropApiError,
  CreatorDropProtocolError,
  createApiClient,
} from '../src/api/client.js';
import {
  authSessionResponseFixture,
  boxOpeningFixture,
  currentFairnessFixture,
  openingV2ResponseFixture,
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
  it('uses validated fan state and creator status cursors without arbitrary user identity', async () => {
    const state = { boxId: entryPolicy.boxId, methods: [entryState('pending')] };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(state))
      .mockResolvedValueOnce(jsonResponse({ claims: [entryClaim], nextCursor: null }));
    const client = createApiClient({
      baseUrl: 'https://api.example.test',
      fetcher,
      getAccessToken: () => Promise.resolve('synthetic-session'),
    });
    expect(await client.getEntryState(entryPolicy.boxId)).toEqual(state);
    await client.listReviewClaims(entryPolicy.creatorId, 'approved', entryClaim.id);
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      `https://api.example.test/v1/boxes/${entryPolicy.boxId}/me/entry-state`,
    );
    expect(fetcher.mock.calls[1]?.[0]).toBe(
      `https://api.example.test/v1/creators/${entryPolicy.creatorId}/entry-claims?status=approved&cursor=${entryClaim.id}`,
    );
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({
      cache: 'no-store',
      redirect: 'error',
      headers: { Authorization: 'Bearer synthetic-session' },
    });
  });
  it('preserves revision/idempotency headers and uploads raw private screenshot bytes', async () => {
    const file = new File(['png'], 'synthetic.png', { type: 'image/png' });
    const metadata = {
      evidence: {
        id: entryClaim.evidence.screenshot,
        mediaType: 'image/png',
        byteLength: 3,
        uploaded: true,
      },
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ method: entryMethod }))
      .mockResolvedValueOnce(jsonResponse({ claim: entryClaim }))
      .mockResolvedValueOnce(jsonResponse(metadata))
      .mockResolvedValueOnce(new Response(file, { headers: { 'Content-Type': 'image/png' } }));
    const client = createApiClient({
      baseUrl: 'https://api.example.test',
      fetcher,
      getAccessToken: () => Promise.resolve('synthetic-session'),
    });
    await client.saveEntryMethod(
      entryPolicy.creatorId,
      entryPolicy.boxId,
      entryPolicy.definition,
      entryMethod,
    );
    await client.submitEntryClaim(
      entryPolicy.boxId,
      entryPolicy.id,
      entryClaim.evidence,
      'synthetic-stable-key',
    );
    await client.uploadEntryEvidence(entryClaim.evidence.screenshot ?? '', file);
    const image = await client.getReviewEvidence(
      entryPolicy.creatorId,
      entryClaim.evidence.screenshot ?? '',
    );
    expect(image.type).toBe('image/png');
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      method: 'PUT',
      headers: { 'If-Match': '"2"' },
    });
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({
      headers: { 'Idempotency-Key': 'synthetic-stable-key' },
    });
    expect(fetcher.mock.calls[2]?.[1]).toMatchObject({
      method: 'POST',
      body: file,
      headers: { 'Content-Type': 'image/png', Authorization: 'Bearer synthetic-session' },
    });
    expect(fetcher.mock.calls[3]?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer synthetic-session',
    });
  });
  it('rejects unsupported entry actions, extra private response fields and unsafe evidence MIME types', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          methods: [
            {
              ...entryPolicy,
              definition: { ...entryPolicy.definition, action: 'paid_subscription' },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ claim: { ...entryClaim, reviewerId: 'synthetic-private' } }),
      )
      .mockResolvedValueOnce(
        new Response('<svg/>', { headers: { 'Content-Type': 'image/svg+xml' } }),
      );
    const client = createApiClient({ baseUrl: 'https://api.example.test', fetcher });
    await expect(client.listEntryMethods(entryPolicy.boxId)).rejects.toBeInstanceOf(
      CreatorDropProtocolError,
    );
    await expect(client.getOwnEntryClaim(entryClaim.id)).rejects.toBeInstanceOf(
      CreatorDropProtocolError,
    );
    await expect(
      client.getReviewEvidence(entryPolicy.creatorId, entryClaim.evidence.screenshot ?? ''),
    ).rejects.toBeInstanceOf(CreatorDropProtocolError);
  });
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

  it('reads opening-v2 entitlement state and parses a non-financial opening response', async () => {
    const entitlement = {
      available: true,
      boxId: openingV2ResponseFixture.opening.boxId,
      consumed: '0',
      granted: '2',
      limitReached: false,
      maxOpeningsPerUser: '3',
      remaining: '2',
      successfulOpenings: '0',
    } as const;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ entitlement }))
      .mockResolvedValueOnce(jsonResponse(openingV2ResponseFixture, 201));
    const client = createApiClient({ baseUrl: 'https://api.example.test', fetcher });

    await expect(
      client.getOpeningEntitlementState(openingV2ResponseFixture.opening.boxId),
    ).resolves.toEqual({ entitlement });
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      `https://api.example.test/v1/boxes/${openingV2ResponseFixture.opening.boxId}/opening-entitlement`,
    );

    await expect(
      client.openBox(
        openingV2ResponseFixture.opening.boxId,
        openingV2ResponseFixture.opening.fairness.clientSeed,
        'opening_v2-stable-key',
        openingV2ResponseFixture.opening.boxVersionId,
        openingV2ResponseFixture.opening.fairness.configurationHash,
        openingV2ResponseFixture.opening.fairness.seedSetId,
        openingV2ResponseFixture.opening.fairness.commitment,
      ),
    ).resolves.toEqual(openingV2ResponseFixture);
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({
      headers: { 'Idempotency-Key': 'opening_v2-stable-key' },
      method: 'POST',
    });
    expect(openingV2ResponseFixture.opening).not.toHaveProperty('cost');
    expect(openingV2ResponseFixture.opening).not.toHaveProperty('wallet');
    expect(openingV2ResponseFixture.opening).not.toHaveProperty('pointsAwarded');
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
