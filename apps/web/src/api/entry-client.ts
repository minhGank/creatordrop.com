import { z } from 'zod';
import {
  entryPlatformActions,
  type EntryClaimContract,
  type EntryClaimPage,
  type EntryEvidence,
  type EntryMethodContract,
  type EntryPolicyDefinition,
  type EntryPolicySnapshot,
  type EntryStateResponse,
} from '@creatordrop/contracts';

const id = z.uuid();
const count = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/u)
  .refine((v) => BigInt(v) <= 9223372036854775807n);
const positive = count.refine((v) => v !== '0');
const time = z.iso.datetime({ offset: true });
const requirement = z.enum(['required', 'optional', 'not_applicable']);
const platform = z.enum([
  'instagram',
  'youtube',
  'twitch',
  'tiktok',
  'facebook',
  'commerce',
  'custom',
]);
const requirements = z
  .object({
    platform_username: requirement,
    profile_url: requirement,
    order_reference: requirement,
    screenshot: requirement,
    note: requirement,
  })
  .strict();
export const entryDefinitionSchema: z.ZodType<EntryPolicyDefinition> = z
  .object({
    policyVersion: z.literal('entry-policy-v1'),
    platform,
    action: z.string(),
    verificationStrategy: z.literal('manual_evidence'),
    title: z.string().min(1).max(120),
    instructions: z.string().min(1).max(2000),
    targetReference: z.string().max(2048).nullable(),
    openingsGranted: positive,
    perUserClaimLimit: positive,
    evidenceRequirements: requirements,
  })
  .strict()
  .refine((v) =>
    (entryPlatformActions[v.platform] as readonly string[]).includes(v.action),
  ) as z.ZodType<EntryPolicyDefinition>;
export const entryPolicySchema: z.ZodType<EntryPolicySnapshot> = z
  .object({
    id,
    methodId: id,
    creatorId: id,
    boxId: id,
    boxVersionId: id,
    versionNumber: z.number().int().positive(),
    publishedAt: time,
    definition: entryDefinitionSchema,
  })
  .strict();
const evidence = z
  .object({
    platform_username: z.string().max(120).optional(),
    profile_url: z.url({ protocol: /^https:$/u }).optional(),
    order_reference: z.string().max(160).optional(),
    screenshot: id.optional(),
    note: z.string().max(2000).optional(),
  })
  .strict()
  .transform((value): EntryEvidence =>
    Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)),
  );
export const entryClaimSchema: z.ZodType<EntryClaimContract> = z
  .object({
    id,
    creatorId: id,
    boxId: id,
    policyId: id,
    methodId: id,
    status: z.enum(['pending', 'approved', 'rejected']),
    evidence,
    createdAt: time,
    reviewedAt: time.nullable(),
    policy: entryPolicySchema,
  })
  .strict();
const method: z.ZodType<EntryMethodContract> = z
  .object({
    id,
    creatorId: id,
    boxId: id,
    revision: z.number().int().positive(),
    enabled: z.boolean(),
    draft: entryDefinitionSchema,
    published: entryPolicySchema.nullable(),
  })
  .strict();
const state: z.ZodType<EntryStateResponse> = z
  .object({
    boxId: id,
    methods: z.array(
      z
        .object({
          policy: entryPolicySchema,
          claimLimit: positive,
          reservedSlots: count,
          consumedSlots: count,
          remainingSlots: count,
          canSubmit: z.boolean(),
          claimCount: count,
          claims: z
            .array(
              z
                .object({
                  id,
                  policyId: id,
                  status: z.enum(['pending', 'approved', 'rejected']),
                  createdAt: time,
                  reviewedAt: time.nullable(),
                  openingsGranted: count,
                })
                .strict(),
            )
            .max(100),
        })
        .strict(),
    ),
  })
  .strict();
const metadata = z
  .object({
    evidence: z
      .object({
        id,
        mediaType: z.enum(['image/png', 'image/jpeg']),
        byteLength: z.number().int().positive().max(5242880),
        uploaded: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type EvidenceMetadata = z.infer<typeof metadata>['evidence'];
export interface RequestOptions {
  readonly accessToken?: string;
  readonly body?: Readonly<Record<string, unknown>> | Blob;
  readonly idempotencyKey?: string;
  readonly ifMatch?: number;
  readonly method?: 'GET' | 'POST' | 'PUT' | 'PATCH';
  readonly signal?: AbortSignal;
  readonly responseType?: 'image';
}
export type ApiRequest = <T>(
  path: string,
  schema: z.ZodType<T>,
  options?: RequestOptions,
) => Promise<T>;
const segment = encodeURIComponent;
const root = (creatorId: string, boxId: string) =>
  `/v1/creators/${segment(creatorId)}/boxes/${segment(boxId)}/entry-methods`;
export const createEntryApi = (request: ApiRequest) => ({
  listEntryMethods: (boxId: string, signal?: AbortSignal) =>
    request(
      `/v1/boxes/${segment(boxId)}/entry-methods`,
      z.object({ methods: z.array(entryPolicySchema) }).strict(),
      signal ? { signal } : {},
    ),
  getEntryState: (boxId: string, signal?: AbortSignal) =>
    request(`/v1/boxes/${segment(boxId)}/me/entry-state`, state, signal ? { signal } : {}),
  listDraftEntryMethods: (creatorId: string, boxId: string, signal?: AbortSignal) =>
    request(
      root(creatorId, boxId),
      z.object({ methods: z.array(method) }).strict(),
      signal ? { signal } : {},
    ),
  saveEntryMethod: (
    creatorId: string,
    boxId: string,
    definition: EntryPolicyDefinition,
    current?: EntryMethodContract,
  ) =>
    request(
      `${root(creatorId, boxId)}${current ? `/${segment(current.id)}/draft` : ''}`,
      z.object({ method }).strict(),
      {
        body: { definition },
        method: current ? 'PUT' : 'POST',
        ...(current ? { ifMatch: current.revision } : {}),
      },
    ),
  publishEntryMethod: (
    creatorId: string,
    boxId: string,
    current: EntryMethodContract,
    boxVersionId: string,
  ) =>
    request(
      `${root(creatorId, boxId)}/${segment(current.id)}/publish`,
      z.object({ method }).strict(),
      { body: { boxVersionId }, ifMatch: current.revision, method: 'POST' },
    ),
  setEntryMethodEnabled: (
    creatorId: string,
    boxId: string,
    current: EntryMethodContract,
    enabled: boolean,
  ) =>
    request(
      `${root(creatorId, boxId)}/${segment(current.id)}/availability`,
      z.object({ method }).strict(),
      { body: { enabled }, ifMatch: current.revision, method: 'PATCH' },
    ),
  submitEntryClaim: (
    boxId: string,
    policyId: string,
    evidence: EntryEvidence,
    idempotencyKey: string,
  ) =>
    request(
      `/v1/boxes/${segment(boxId)}/entry-claims`,
      z.object({ claim: entryClaimSchema }).strict(),
      { method: 'POST', body: { policyId, evidence }, idempotencyKey },
    ),
  getOwnEntryClaim: (claimId: string, signal?: AbortSignal) =>
    request(
      `/v1/me/entry-claims/${segment(claimId)}`,
      z.object({ claim: entryClaimSchema }).strict(),
      signal ? { signal } : {},
    ),
  listReviewClaims: (
    creatorId: string,
    status: EntryClaimContract['status'],
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<EntryClaimPage> =>
    request(
      `/v1/creators/${segment(creatorId)}/entry-claims?${new URLSearchParams({ status, ...(cursor ? { cursor } : {}) }).toString()}`,
      z.object({ claims: z.array(entryClaimSchema), nextCursor: id.nullable() }).strict(),
      signal ? { signal } : {},
    ),
  getReviewClaim: (creatorId: string, claimId: string, signal?: AbortSignal) =>
    request(
      `/v1/creators/${segment(creatorId)}/entry-claims/${segment(claimId)}`,
      z.object({ claim: entryClaimSchema }).strict(),
      signal ? { signal } : {},
    ),
  reviewEntryClaim: (
    creatorId: string,
    claimId: string,
    decision: 'approved' | 'rejected',
    note: string | null,
  ) =>
    request(
      `/v1/creators/${segment(creatorId)}/entry-claims/${segment(claimId)}/review`,
      z.object({ claim: entryClaimSchema }).strict(),
      { method: 'POST', body: { decision, note } },
    ),
  createEntryEvidence: (boxId: string, policyId: string, file: File) =>
    request(`/v1/boxes/${segment(boxId)}/entry-evidence`, metadata, {
      method: 'POST',
      body: { policyId, mediaType: file.type, byteLength: file.size },
    }),
  uploadEntryEvidence: (evidenceId: string, file: File) =>
    request(`/v1/me/entry-evidence/${segment(evidenceId)}/content`, metadata, {
      method: 'POST',
      body: file,
    }),
  getReviewEvidence: (creatorId: string, evidenceId: string, signal?: AbortSignal) =>
    request(
      `/v1/creators/${segment(creatorId)}/entry-evidence/${segment(evidenceId)}/content`,
      z.custom<Blob>(
        (v) =>
          v instanceof Blob &&
          ['image/png', 'image/jpeg'].includes(v.type) &&
          v.size > 0 &&
          v.size <= 5242880,
      ),
      { responseType: 'image', ...(signal ? { signal } : {}) },
    ),
});
export type EntryApiClient = ReturnType<typeof createEntryApi>;
