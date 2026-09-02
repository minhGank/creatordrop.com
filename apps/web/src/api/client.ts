import { z } from 'zod';

import type {
  ApiErrorResponse,
  AuthSessionResponse,
  PublicCreatorBoxResponse,
  PublicCreatorBoxesResponse,
  PublicCreatorResponse,
  PublicCreatorsResponse,
} from '@creatordrop/contracts';

const nullableHttpsUrlSchema = z.union([z.url({ protocol: /^https:$/u }), z.null()]);
const canonicalDecimalSchema = z.string().regex(/^(?:0|[1-9][0-9]*)$/u);
const uuidSchema = z.uuid();

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

const publicBoxSummarySchema = z
  .object({
    availability: z.enum(['legacy', 'openable']),
    configurationHash: z.string().regex(/^[0-9a-f]{64}$/u),
    currency: z.string().regex(/^[A-Z]{3}$/u),
    currentPublishedVersionId: uuidSchema,
    description: z.string().max(5000),
    id: uuidSchema,
    imageUrl: nullableHttpsUrlSchema,
    name: z.string().min(1).max(120),
    openingCompatibilityVersion: z.union([z.literal('opening-v1'), z.null()]),
    priceMinor: canonicalDecimalSchema,
    publishedAt: z.iso.datetime({ offset: true }),
    versionNumber: z.number().int().positive(),
  })
  .strict();

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

const boxVersionSchema = z
  .object({
    configurationHash: z.union([z.string(), z.null()]),
    createdAt: z.iso.datetime({ offset: true }),
    currency: z.string().regex(/^[A-Z]{3}$/u),
    description: z.string().max(5000),
    id: uuidSchema,
    imageUrl: nullableHttpsUrlSchema,
    name: z.string().min(1).max(120),
    openingCompatibilityVersion: z.union([z.literal('opening-v1'), z.null()]),
    priceMinor: canonicalDecimalSchema,
    publishedAt: z.union([z.iso.datetime({ offset: true }), z.null()]),
    rngAlgorithmVersion: z.union([z.string(), z.null()]),
    state: z.enum(['draft', 'published', 'retired']),
    totalWeight: z.union([canonicalDecimalSchema, z.null()]),
    updatedAt: z.iso.datetime({ offset: true }),
    versionNumber: z.number().int().positive(),
  })
  .strict();

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
    rewardType: z.enum(['digital', 'experience', 'physical']),
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
    rewardVersion: rewardVersionSchema,
    weight: canonicalDecimalSchema,
  })
  .strict();

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

const publishedBoxSchema = z
  .object({
    configurationHash: z.string().regex(/^[0-9a-f]{64}$/u),
    entries: z.array(publishedEntrySchema),
    manifest: publishedManifestSchema,
    version: boxVersionSchema,
  })
  .strict();

const publicCreatorBoxResponseSchema = z
  .object({ box: publishedBoxSchema, creator: publicCreatorSchema })
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

export interface CreatorDropApiClient {
  exchangeSession(accessToken: string): Promise<AuthSessionResponse>;
  getCreator(customSlug: string, signal?: AbortSignal): Promise<PublicCreatorResponse>;
  getCreatorBox(
    customSlug: string,
    boxId: string,
    signal?: AbortSignal,
  ): Promise<PublicCreatorBoxResponse>;
  listCreatorBoxes(
    customSlug: string,
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<PublicCreatorBoxesResponse>;
  listCreators(cursor?: string, signal?: AbortSignal): Promise<PublicCreatorsResponse>;
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
    options: {
      readonly accessToken?: string;
      readonly body?: Readonly<Record<string, unknown>>;
      readonly method?: 'GET' | 'POST';
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<T> => {
    try {
      const accessToken = options.accessToken ?? (await getAccessToken?.()) ?? null;
      const response = await fetcher(new URL(path, baseUrl).toString(), {
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        headers: {
          Accept: 'application/json',
          ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(accessToken === null ? {} : { Authorization: `Bearer ${accessToken}` }),
        },
        method: options.method ?? 'GET',
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      const payload = parseJson(await response.text());
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
    exchangeSession: (accessToken) =>
      request('/v1/auth/session/exchange', authSessionSchema, {
        accessToken,
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
  };
};
