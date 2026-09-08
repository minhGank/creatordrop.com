import {
  creatorUsageResponseSchema,
  type CreatorUsageQuery,
  type CreatorUsageResponse,
  xpRewardSchema,
  progressionResponseSchema,
  openingProgressionSchema,
  type ProgressionResponse,
} from '@creatordrop/contracts';
import { z } from 'zod';
import { createEntryApi, type EntryApiClient, type RequestOptions } from './entry-client.js';

import type {
  ApiErrorResponse,
  AuthSessionResponse,
  BoxOpeningResponse,
  CurrentFairnessResponse,
  OpeningFairnessProofResponse,
  OpeningV2EntitlementStateResponse,
  PublishedBoxVersionResponse,
  PublicCreatorBoxResponse,
  PublicCreatorBoxesResponse,
  PublicCreatorResponse,
  PublicCreatorsResponse,
  CreatorWorkspaceMembershipsResponse,
  BoxesResponse,
} from '@creatordrop/contracts';

const nullableHttpsUrlSchema = z.union([z.url({ protocol: /^https:$/u }), z.null()]);
const canonicalDecimalSchema = z.string().regex(/^(?:0|[1-9][0-9]*)$/u);
const positiveDecimalSchema = z.string().regex(/^[1-9][0-9]*$/u);
const hex256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const uuidSchema = z.uuid();
const raritySchema = z.enum(['common', 'uncommon', 'rare', 'epic', 'legendary']);

const authSessionSchema = z
  .object({
    user: z
      .object({
        id: uuidSchema,
        status: z.enum(['active', 'suspended', 'closed']),
        username: z.string().min(1),
      })
      .strict(),
  })
  .strict();

const publicCreatorSchema = z
  .object({
    customSlug: z.string().regex(/^[a-z0-9][a-z0-9-]{2,62}$/u),
    displayName: z.string().min(1).max(100),
    handle: z.string().regex(/^[a-z0-9][a-z0-9_]{2,31}$/u),
  })
  .strict();

const publicBoxSummaryBase = {
  configurationHash: z.string().regex(/^[0-9a-f]{64}$/u),
  currentPublishedVersionId: uuidSchema,
  description: z.string().max(5000),
  id: uuidSchema,
  imageUrl: nullableHttpsUrlSchema,
  name: z.string().min(1).max(120),
  publishedAt: z.iso.datetime({ offset: true }),
  versionNumber: z.number().int().positive(),
};
const publicBoxSummarySchema = z.union([
  z
    .object({
      ...publicBoxSummaryBase,
      availability: z.enum(['legacy', 'openable']),
      currency: z.string().regex(/^[A-Z]{3}$/u),
      maxOpeningsPerUser: z.null(),
      openingCompatibilityVersion: z.union([z.literal('opening-v1'), z.null()]),
      priceMinor: canonicalDecimalSchema,
    })
    .strict(),
  z
    .object({
      ...publicBoxSummaryBase,
      availability: z.literal('opening-v2'),
      currency: z.null(),
      maxOpeningsPerUser: positiveDecimalSchema,
      openingCompatibilityVersion: z.literal('opening-v2'),
      priceMinor: z.null(),
    })
    .strict(),
]);

const publicCreatorsSchema = z
  .object({
    creators: z.array(publicCreatorSchema),
    nextCursor: z.union([z.string().min(1), z.null()]),
  })
  .strict();

const publicCreatorResponseSchema = z.object({ creator: publicCreatorSchema }).strict();
const publicCreatorBoxesSchema = z
  .object({
    boxes: z.array(publicBoxSummarySchema),
    nextCursor: z.union([z.string().min(1), z.null()]),
  })
  .strict();

const boxVersionBase = {
  configurationHash: z.union([z.string(), z.null()]),
  createdAt: z.iso.datetime({ offset: true }),
  description: z.string().max(5000),
  id: uuidSchema,
  imageUrl: nullableHttpsUrlSchema,
  name: z.string().min(1).max(120),
  publishedAt: z.union([z.iso.datetime({ offset: true }), z.null()]),
  rngAlgorithmVersion: z.union([z.string(), z.null()]),
  state: z.enum(['draft', 'published', 'retired']),
  totalWeight: z.union([canonicalDecimalSchema, z.null()]),
  updatedAt: z.iso.datetime({ offset: true }),
  versionNumber: z.number().int().positive(),
};
const boxVersionSchema = z.union([
  z
    .object({
      ...boxVersionBase,
      currency: z.string().regex(/^[A-Z]{3}$/u),
      maxOpeningsPerUser: z.null(),
      openingCompatibilityVersion: z.union([z.literal('opening-v1'), z.null()]),
      priceMinor: canonicalDecimalSchema,
    })
    .strict(),
  z
    .object({
      ...boxVersionBase,
      currency: z.null(),
      maxOpeningsPerUser: positiveDecimalSchema,
      openingCompatibilityVersion: z.literal('opening-v2'),
      priceMinor: z.null(),
    })
    .strict(),
]);

const rewardVersionSchema = z
  .object({
    createdAt: z.iso.datetime({ offset: true }),
    declaredValueCurrency: z.union([z.string().regex(/^[A-Z]{3}$/u), z.null()]),
    declaredValueMinor: z.union([canonicalDecimalSchema, z.null()]),
    description: z.string().max(5000),
    id: uuidSchema,
    imageUrl: nullableHttpsUrlSchema,
    inventoryMode: z.enum(['finite', 'unlimited']),
    inventoryQuantity: z.union([canonicalDecimalSchema, z.null()]),
    inventoryStockoutPolicy: z.union([z.enum(['backorder', 'pause_box']), z.null()]),
    name: z.string().min(1).max(120),
    publishedAt: z.union([z.iso.datetime({ offset: true }), z.null()]),
    rewardType: z.enum(['digital', 'experience', 'physical', 'xp']),
    xpReward: xpRewardSchema.optional(),
    state: z.enum(['draft', 'published', 'retired']),
    updatedAt: z.iso.datetime({ offset: true }),
    versionNumber: z.number().int().positive(),
  })
  .strict();

const publishedEntrySchema = z
  .object({
    id: uuidSchema,
    isBaseReward: z.boolean(),
    position: z.number().int().nonnegative(),
    rarity: z.union([raritySchema, z.null()]),
    rarityPolicyVersion: z.union([z.literal('rarity-v1'), z.null()]),
    rewardVersion: rewardVersionSchema,
    weight: canonicalDecimalSchema,
  })
  .strict()
  .refine((entry) => (entry.rarity === null) === (entry.rarityPolicyVersion === null));

const publishedManifestSchema = z
  .object({
    algorithmVersion: z.literal('hmac-sha256-rejection-v1'),
    boxId: uuidSchema,
    boxVersionId: uuidSchema,
    currency: z.string().regex(/^[A-Z]{3}$/u),
    entries: z.array(
      z
        .object({
          boxVersionRewardId: uuidSchema,
          position: z.number().int().nonnegative(),
          rewardVersionId: uuidSchema,
          weight: canonicalDecimalSchema,
        })
        .strict(),
    ),
    priceMinor: canonicalDecimalSchema,
    totalWeight: canonicalDecimalSchema,
  })
  .strict();

const openingV2PublishedManifestSchema = z
  .object({
    algorithmVersion: z.literal('hmac-sha256-rejection-v1'),
    boxId: uuidSchema,
    boxVersionId: uuidSchema,
    entries: z.array(
      z
        .object({
          boxVersionRewardId: uuidSchema,
          position: z.number().int().nonnegative(),
          rarity: raritySchema,
          rarityPolicyVersion: z.literal('rarity-v1'),
          xpReward: xpRewardSchema.optional(),
          rewardVersionId: uuidSchema,
          weight: positiveDecimalSchema,
        })
        .strict(),
    ),
    maxOpeningsPerUser: positiveDecimalSchema,
    openingCompatibilityVersion: z.literal('opening-v2'),
    totalWeight: positiveDecimalSchema,
  })
  .strict();

const publishedBoxSchema = z
  .object({
    configurationHash: z.string().regex(/^[0-9a-f]{64}$/u),
    entries: z.array(publishedEntrySchema),
    manifest: z.union([publishedManifestSchema, openingV2PublishedManifestSchema]),
    version: boxVersionSchema,
  })
  .strict();

const publicCreatorBoxResponseSchema = z
  .object({ box: publishedBoxSchema, creator: publicCreatorSchema })
  .strict();

const openingFairnessSchema = z
  .object({
    clientSeed: hex256Schema,
    commitment: hex256Schema,
    configurationHash: hex256Schema,
    nonce: canonicalDecimalSchema,
    seedSetId: uuidSchema,
  })
  .strict();

const openingRewardSchema = z
  .object({
    id: uuidSchema,
    imageUrl: nullableHttpsUrlSchema,
    name: z.string().min(1).max(120),
    rarity: z.union([raritySchema, z.null()]),
    rarityPolicyVersion: z.union([z.literal('rarity-v1'), z.null()]),
    rewardVersionId: uuidSchema,
  })
  .strict()
  .refine((reward) => (reward.rarity === null) === (reward.rarityPolicyVersion === null));

const openingV2RewardSchema = z
  .object({
    id: uuidSchema,
    imageUrl: nullableHttpsUrlSchema,
    name: z.string().min(1).max(120),
    rarity: raritySchema,
    rarityPolicyVersion: z.literal('rarity-v1'),
    xpReward: xpRewardSchema.optional(),
    rewardVersionId: uuidSchema,
  })
  .strict();

const paidBoxOpeningSchema = z
  .object({
    boxId: uuidSchema,
    boxVersionId: uuidSchema,
    cost: z
      .object({ currency: z.string().regex(/^[A-Z]{3}$/u), priceMinor: positiveDecimalSchema })
      .strict(),
    fairness: openingFairnessSchema,
    fulfillmentStatus: z.enum(['awaiting_restock', 'pending_fulfillment']),
    id: uuidSchema,
    pointsAwarded: z.union([z.literal(5), z.literal(20)]),
    reward: openingRewardSchema,
    wallet: z
      .object({
        balanceMinor: canonicalDecimalSchema,
        currency: z.string().regex(/^[A-Z]{3}$/u),
        id: uuidSchema,
        revision: canonicalDecimalSchema,
      })
      .strict(),
  })
  .strict();

const entitlementBoxOpeningSchema = z
  .object({
    boxId: uuidSchema,
    boxVersionId: uuidSchema,
    progression: openingProgressionSchema.optional(),
    entitlement: z
      .object({
        source: z.enum(['creator', 'universal']).optional(),
        universalEntriesRemaining: canonicalDecimalSchema.optional(),
        maxOpeningsPerUser: positiveDecimalSchema,
        remaining: canonicalDecimalSchema,
        successfulOpenings: positiveDecimalSchema,
      })
      .strict(),
    fairness: openingFairnessSchema,
    fulfillmentStatus: z.enum(['awaiting_restock', 'pending_fulfillment', 'not_required']),
    id: uuidSchema,
    openingCompatibilityVersion: z.literal('opening-v2'),
    reward: openingV2RewardSchema,
  })
  .strict();

const boxOpeningResponseSchema = z
  .object({ opening: z.union([paidBoxOpeningSchema, entitlementBoxOpeningSchema]) })
  .strict();

const openingV2EntitlementStateResponseSchema = z
  .object({
    entitlement: z
      .object({
        source: z.enum(['creator', 'universal']).nullable().optional(),
        universalEntriesAvailable: canonicalDecimalSchema.optional(),
        available: z.boolean(),
        boxId: uuidSchema,
        consumed: canonicalDecimalSchema,
        granted: canonicalDecimalSchema,
        limitReached: z.boolean(),
        maxOpeningsPerUser: positiveDecimalSchema,
        remaining: canonicalDecimalSchema,
        successfulOpenings: canonicalDecimalSchema,
      })
      .strict(),
  })
  .strict();

const currentFairnessResponseSchema = z
  .object({
    fairness: z
      .object({
        activeSeedSet: z
          .object({
            algorithmVersion: z.literal('hmac-sha256-rejection-v1'),
            commitment: hex256Schema,
            compromisedAt: z.union([z.iso.datetime({ offset: true }), z.null()]),
            createdAt: z.iso.datetime({ offset: true }),
            id: uuidSchema,
            maxNonceExclusive: positiveDecimalSchema,
            nextNonce: canonicalDecimalSchema,
            retiredAt: z.union([z.iso.datetime({ offset: true }), z.null()]),
            revealedAt: z.union([z.iso.datetime({ offset: true }), z.null()]),
            revealedServerSeed: z.union([hex256Schema, z.null()]),
            rotateAfter: z.iso.datetime({ offset: true }),
            status: z.enum(['active', 'retired', 'revealed', 'compromised']),
          })
          .strict(),
        clientSeed: z.union([hex256Schema, z.null()]),
        revision: z.number().int().positive(),
        rotationPolicy: z
          .object({ maxAgeMs: z.number().int().positive(), maxOpenings: positiveDecimalSchema })
          .strict(),
      })
      .strict(),
  })
  .strict();

const openingFairnessProofResponseSchema = z
  .object({
    proof: z
      .object({
        algorithmVersion: z.literal('hmac-sha256-rejection-v1'),
        clientSeed: hex256Schema,
        configurationHash: hex256Schema,
        manifest: z.union([publishedManifestSchema, openingV2PublishedManifestSchema]),
        nonce: canonicalDecimalSchema,
        openedAt: z.iso.datetime({ offset: true }),
        openingId: uuidSchema,
        recorded: z
          .object({
            acceptedDigestHex: hex256Schema,
            acceptedRound: canonicalDecimalSchema,
            boxVersionRewardId: uuidSchema,
            position: z.number().int().nonnegative(),
            rewardVersionId: uuidSchema,
            selectionValue: canonicalDecimalSchema,
          })
          .strict(),
        seedSetId: uuidSchema,
        serverSeedCommitment: hex256Schema,
        serverSeedHex: hex256Schema.optional(),
        specificationId: z.literal('creatordrop-rng-hmac-sha256-rejection-v1'),
        verificationStatus: z.enum(['pending_reveal', 'ready', 'unverifiable']),
      })
      .strict()
      .superRefine((proof, context) => {
        if ((proof.verificationStatus === 'ready') !== (proof.serverSeedHex !== undefined)) {
          context.addIssue({ code: 'custom', message: 'The proof reveal state is inconsistent.' });
        }
      }),
  })
  .strict();

const errorEnvelopeSchema = z
  .object({
    error: z
      .object({
        code: z.string().min(1),
        details: z.record(z.string(), z.unknown()),
        message: z.string().min(1),
        requestId: z.string().min(1),
      })
      .strict(),
  })
  .strict();

export class CreatorDropApiError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly requestId: string;
  readonly status: number;

  constructor(status: number, response: ApiErrorResponse) {
    super(response.error.message);
    this.name = 'CreatorDropApiError';
    this.code = response.error.code;
    this.details = response.error.details;
    this.requestId = response.error.requestId;
    this.status = status;
  }
}

export class CreatorDropNetworkError extends Error {
  constructor() {
    super('CreatorDrop could not be reached. Check your connection and try again.');
    this.name = 'CreatorDropNetworkError';
  }
}

export class CreatorDropProtocolError extends Error {
  constructor() {
    super('CreatorDrop returned an unexpected response. Please try again.');
    this.name = 'CreatorDropProtocolError';
  }
}

export interface CreatorDropApiClient extends EntryApiClient {
  listMyWorkspaces(signal?: AbortSignal): Promise<CreatorWorkspaceMembershipsResponse>;
  listWorkspaceBoxes(creatorId: string, signal?: AbortSignal): Promise<BoxesResponse>;
  exchangeSession(accessToken: string): Promise<AuthSessionResponse>;
  getCurrentFairness(signal?: AbortSignal): Promise<CurrentFairnessResponse>;
  initializeFairness(): Promise<CurrentFairnessResponse>;
  getCreator(customSlug: string, signal?: AbortSignal): Promise<PublicCreatorResponse>;
  getCreatorBox(
    customSlug: string,
    boxId: string,
    signal?: AbortSignal,
  ): Promise<PublicCreatorBoxResponse>;
  getOpeningFairnessProof(
    publicOpeningId: string,
    signal?: AbortSignal,
  ): Promise<OpeningFairnessProofResponse>;
  getCreatorUsage(
    creatorId: string,
    query: CreatorUsageQuery,
    signal?: AbortSignal,
  ): Promise<CreatorUsageResponse>;
  getProgression(signal?: AbortSignal): Promise<ProgressionResponse>;
  getOpeningEntitlementState(
    boxId: string,
    signal?: AbortSignal,
  ): Promise<OpeningV2EntitlementStateResponse>;
  getPublishedBoxVersion(
    boxId: string,
    versionId: string,
    signal?: AbortSignal,
  ): Promise<PublishedBoxVersionResponse>;
  listCreatorBoxes(
    customSlug: string,
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<PublicCreatorBoxesResponse>;
  listCreators(cursor?: string, signal?: AbortSignal): Promise<PublicCreatorsResponse>;
  openBox(
    boxId: string,
    clientSeed: string,
    idempotencyKey: string,
    expectedBoxVersionId: string,
    expectedConfigurationHash: string,
    expectedSeedSetId: string,
    expectedServerSeedCommitment: string,
  ): Promise<BoxOpeningResponse>;
  updateCurrentClientSeed(
    clientSeed: string,
    expectedRevision: number,
    expectedSeedSetId: string,
    expectedServerSeedCommitment: string,
  ): Promise<CurrentFairnessResponse>;
}

export interface ApiClientOptions {
  readonly baseUrl: string;
  readonly fetcher?: typeof fetch;
  readonly getAccessToken?: () => Promise<string | null>;
  readonly onUnauthorized?: () => void;
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new CreatorDropProtocolError();
  }
};

const query = (cursor: string | undefined): string => {
  if (cursor === undefined) return '';
  const parameters = new URLSearchParams({ cursor });
  return `?${parameters.toString()}`;
};

export const createApiClient = ({
  baseUrl,
  fetcher = fetch,
  getAccessToken,
  onUnauthorized,
}: ApiClientOptions): CreatorDropApiClient => {
  const request = async <T>(
    path: string,
    schema: z.ZodType<T>,
    options: RequestOptions = {},
  ): Promise<T> => {
    try {
      const accessToken = options.accessToken ?? (await getAccessToken?.()) ?? null;
      const response = await fetcher(new URL(path, baseUrl).toString(), {
        ...(options.body === undefined
          ? {}
          : { body: options.body instanceof Blob ? options.body : JSON.stringify(options.body) }),
        headers: {
          Accept: 'application/json',
          ...(options.body === undefined
            ? {}
            : {
                'Content-Type':
                  options.body instanceof Blob ? options.body.type : 'application/json',
              }),
          ...(accessToken === null ? {} : { Authorization: `Bearer ${accessToken}` }),
          ...(options.idempotencyKey === undefined
            ? {}
            : { 'Idempotency-Key': options.idempotencyKey }),
          ...(options.ifMatch === undefined
            ? {}
            : { 'If-Match': `"${options.ifMatch.toString()}"` }),
        },
        method: options.method ?? 'GET',
        cache: 'no-store',
        redirect: 'error',
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      const payload: unknown =
        response.ok && options.responseType === 'image'
          ? await response.blob()
          : parseJson(await response.text());
      if (!response.ok) {
        const parsed = errorEnvelopeSchema.safeParse(payload);
        if (!parsed.success) throw new CreatorDropProtocolError();
        if (response.status === 401) onUnauthorized?.();
        throw new CreatorDropApiError(response.status, parsed.data);
      }
      const parsed = schema.safeParse(payload);
      if (!parsed.success) throw new CreatorDropProtocolError();
      return parsed.data;
    } catch (error) {
      if (
        error instanceof CreatorDropApiError ||
        error instanceof CreatorDropProtocolError ||
        (error instanceof DOMException && error.name === 'AbortError')
      ) {
        throw error;
      }
      throw new CreatorDropNetworkError();
    }
  };

  return {
    ...createEntryApi(request),
    listMyWorkspaces: (signal) =>
      request(
        '/v1/me/creator-memberships',
        z
          .object({
            memberships: z.array(
              z
                .object({
                  creator: z
                    .object({
                      id: uuidSchema,
                      createdAt: z.iso.datetime({ offset: true }),
                      updatedAt: z.iso.datetime({ offset: true }),
                      customSlug: z.string(),
                      displayName: z.string(),
                      handle: z.string(),
                      revision: z.number().int().positive(),
                      status: z.enum(['active', 'suspended', 'closed']),
                    })
                    .strict(),
                  joinedAt: z.iso.datetime({ offset: true }),
                  role: z.enum(['owner', 'manager', 'editor', 'viewer']),
                })
                .strict(),
            ),
          })
          .strict(),
        signal ? { signal } : {},
      ),
    listWorkspaceBoxes: (creatorId, signal) =>
      request(
        `/v1/creators/${encodeURIComponent(creatorId)}/boxes`,
        z
          .object({
            boxes: z.array(
              z
                .object({
                  id: uuidSchema,
                  creatorId: uuidSchema,
                  createdAt: z.iso.datetime({ offset: true }),
                  updatedAt: z.iso.datetime({ offset: true }),
                  revision: z.number().int().positive(),
                  role: z.enum(['owner', 'manager', 'editor', 'viewer']),
                  status: z.enum(['draft', 'active', 'paused', 'archived']),
                  currentPublishedVersionId: uuidSchema.nullable(),
                  draft: boxVersionSchema.nullable(),
                })
                .strict(),
            ),
          })
          .strict(),
        signal ? { signal } : {},
      ),
    exchangeSession: (accessToken) =>
      request('/v1/auth/session/exchange', authSessionSchema, {
        accessToken,
        body: {},
        method: 'POST',
      }),
    getCurrentFairness: (signal) =>
      request(
        '/v1/me/fairness',
        currentFairnessResponseSchema,
        signal === undefined ? {} : { signal },
      ),
    initializeFairness: () =>
      request('/v1/me/fairness', currentFairnessResponseSchema, {
        body: {},
        method: 'POST',
      }),
    getCreator: (customSlug, signal) =>
      request(
        `/v1/catalog/creators/${encodeURIComponent(customSlug)}`,
        publicCreatorResponseSchema,
        signal === undefined ? {} : { signal },
      ),
    getCreatorBox: (customSlug, boxId, signal) =>
      request(
        `/v1/catalog/creators/${encodeURIComponent(customSlug)}/boxes/${encodeURIComponent(boxId)}`,
        publicCreatorBoxResponseSchema,
        signal === undefined ? {} : { signal },
      ),
    getCreatorUsage: (creatorId, query, signal) => {
      const parameters = new URLSearchParams();
      for (const [key, value] of Object.entries(query))
        if (value !== undefined) parameters.set(key, value);
      return request(
        `/v1/creators/${encodeURIComponent(creatorId)}/usage?${parameters.toString()}`,
        creatorUsageResponseSchema,
        signal === undefined ? {} : { signal },
      );
    },
    getProgression: (signal) =>
      request(
        '/v1/me/progression',
        progressionResponseSchema,
        signal === undefined ? {} : { signal },
      ),
    getOpeningEntitlementState: (boxId, signal) =>
      request(
        `/v1/boxes/${encodeURIComponent(boxId)}/opening-entitlement`,
        openingV2EntitlementStateResponseSchema,
        signal === undefined ? {} : { signal },
      ),
    getOpeningFairnessProof: (publicOpeningId, signal) =>
      request(
        `/v1/fairness/openings/${encodeURIComponent(publicOpeningId)}`,
        openingFairnessProofResponseSchema,
        signal === undefined ? {} : { signal },
      ) as Promise<OpeningFairnessProofResponse>,
    getPublishedBoxVersion: (boxId, versionId, signal) =>
      request(
        `/v1/boxes/${encodeURIComponent(boxId)}/versions/${encodeURIComponent(versionId)}`,
        publishedBoxSchema,
        signal === undefined ? {} : { signal },
      ),
    listCreatorBoxes: (customSlug, cursor, signal) =>
      request(
        `/v1/catalog/creators/${encodeURIComponent(customSlug)}/boxes${query(cursor)}`,
        publicCreatorBoxesSchema,
        signal === undefined ? {} : { signal },
      ),
    listCreators: (cursor, signal) =>
      request(
        `/v1/catalog/creators${query(cursor)}`,
        publicCreatorsSchema,
        signal === undefined ? {} : { signal },
      ),
    openBox: (
      boxId,
      clientSeed,
      idempotencyKey,
      expectedBoxVersionId,
      expectedConfigurationHash,
      expectedSeedSetId,
      expectedServerSeedCommitment,
    ) =>
      request(`/v1/boxes/${encodeURIComponent(boxId)}/open`, boxOpeningResponseSchema, {
        body: {
          clientSeed,
          expectedBoxVersionId,
          expectedConfigurationHash,
          expectedSeedSetId,
          expectedServerSeedCommitment,
        },
        idempotencyKey,
        method: 'POST',
      }),
    updateCurrentClientSeed: (
      clientSeed,
      expectedRevision,
      expectedSeedSetId,
      expectedServerSeedCommitment,
    ) =>
      request('/v1/me/fairness/client-seed', currentFairnessResponseSchema, {
        body: { clientSeed, expectedSeedSetId, expectedServerSeedCommitment },
        ifMatch: expectedRevision,
        method: 'PUT',
      }),
  };
};
