import { createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import type { Database } from '@creatordrop/database';
import type { EntryActorSigner } from './entry.actor-binding.js';
import { executeEntryCommand, readPublishedEntryPolicies } from './entry.repository.js';
import { EntryError } from './entry.errors.js';
import {
  entryId,
  entryInteger,
  entryRecord,
  entryText,
  invalidEntryInput,
  parseEntryClaim,
  parseEntryState,
  parseEntryEvidence,
  parseEntryMethod,
  parseEntryPolicy,
  parseEntryPolicySnapshot,
} from './entry.schema.js';
import {
  entryEvidenceMaxBytes,
  validateEvidenceImage,
  type EntryEvidenceStorage,
  type EvidenceMediaType,
} from './entry.storage.js';

interface EntryScope {
  readonly actorId: string;
  readonly creatorId: string;
  readonly boxId: string;
}
interface MethodScope extends EntryScope {
  readonly methodId: string;
  readonly expectedRevision: number;
}
const list = <T>(input: unknown, parse: (value: unknown) => T): T[] => {
  if (!Array.isArray(input)) return invalidEntryInput();
  return input.map(parse);
};
const evidenceMetadata = (input: unknown) => {
  const row = entryRecord(input, ['id', 'mediaType', 'byteLength', 'uploaded', 'contentHash']);
  if (
    (row.mediaType !== 'image/png' && row.mediaType !== 'image/jpeg') ||
    typeof row.uploaded !== 'boolean' ||
    (row.contentHash !== null &&
      (typeof row.contentHash !== 'string' || !/^[0-9a-f]{64}$/u.test(row.contentHash)))
  )
    return invalidEntryInput();
  const byteLength = entryInteger(row.byteLength);
  if (byteLength > entryEvidenceMaxBytes) return invalidEntryInput();
  return {
    id: entryId(row.id),
    mediaType: row.mediaType,
    byteLength,
    uploaded: row.uploaded,
    contentHash: row.contentHash,
  };
};
export const createEntryService = (options: {
  readonly database: Database;
  readonly signer: EntryActorSigner;
  readonly storage: EntryEvidenceStorage;
  readonly createId?: () => string;
}) => {
  const createId = options.createId ?? uuidv7;
  const command = async <T>(
    actor: string,
    operation: string,
    payload: Readonly<Record<string, unknown>>,
    parse: (value: unknown) => T,
  ): Promise<T> => {
    const family =
      operation === 'review.list'
        ? 'reviewList'
        : operation === 'state.own'
          ? 'state'
          : operation.startsWith('method.')
            ? 'method'
            : operation.startsWith('claim.')
              ? 'claim'
              : 'evidence';
    const binding = options.signer.bind(entryId(actor), operation, payload);
    return options.database.transaction(async (transaction) =>
      parse(await executeEntryCommand(transaction, family, binding)),
    );
  };
  const scope = (input: EntryScope) => ({
    creatorId: entryId(input.creatorId),
    boxId: entryId(input.boxId),
  });
  const methodScope = (input: MethodScope) => ({
    ...scope(input),
    methodId: entryId(input.methodId),
    expectedRevision: entryInteger(input.expectedRevision),
  });
  return {
    createMethod: (input: EntryScope & { readonly definition: unknown }) =>
      command(
        input.actorId,
        'method.create',
        {
          ...scope(input),
          id: entryId(createId()),
          definition: parseEntryPolicy(input.definition),
        },
        parseEntryMethod,
      ),
    updateMethod: (input: MethodScope & { readonly definition: unknown }) =>
      command(
        input.actorId,
        'method.update',
        { ...methodScope(input), definition: parseEntryPolicy(input.definition) },
        parseEntryMethod,
      ),
    setMethodEnabled: (input: MethodScope & { readonly enabled: boolean }) => {
      if (typeof input.enabled !== 'boolean') return invalidEntryInput();
      return command(
        input.actorId,
        'method.enable',
        { ...methodScope(input), enabled: input.enabled },
        parseEntryMethod,
      );
    },
    publishMethod: (input: MethodScope & { readonly boxVersionId: string }) =>
      command(
        input.actorId,
        'method.publish',
        {
          ...methodScope(input),
          id: entryId(createId()),
          boxVersionId: entryId(input.boxVersionId),
        },
        parseEntryMethod,
      ),
    listMethods: (input: EntryScope) =>
      command(input.actorId, 'method.list', scope(input), (value) => list(value, parseEntryMethod)),
    listPublishedMethods: async (boxId: string) =>
      list(
        await readPublishedEntryPolicies(options.database, entryId(boxId)),
        parseEntryPolicySnapshot,
      ),
    submitClaim: (input: {
      readonly actorId: string;
      readonly boxId: string;
      readonly policyId: string;
      readonly idempotencyKey: string;
      readonly evidence: unknown;
    }) => {
      const key = entryText(input.idempotencyKey, 128);
      if (!/^[A-Za-z0-9._:-]{8,128}$/u.test(key)) return invalidEntryInput();
      return command(
        input.actorId,
        'claim.submit',
        {
          id: entryId(createId()),
          boxId: entryId(input.boxId),
          policyId: entryId(input.policyId),
          idempotencyKey: key,
          evidence: parseEntryEvidence(input.evidence),
        },
        parseEntryClaim,
      );
    },
    getOwnClaim: (actorId: string, claimId: string) =>
      command(actorId, 'claim.own', { claimId: entryId(claimId) }, parseEntryClaim),
    getOwnEntryState: (actorId: string, boxId: string) =>
      command(actorId, 'state.own', { boxId: entryId(boxId) }, parseEntryState),
    listReviewClaims: (
      actorId: string,
      creatorId: string,
      status: unknown,
      cursor: unknown = null,
    ) => {
      if (status !== 'pending' && status !== 'approved' && status !== 'rejected')
        return invalidEntryInput();
      return command(
        actorId,
        'review.list',
        { creatorId: entryId(creatorId), status, cursor: cursor === null ? null : entryId(cursor) },
        (value) => {
          const page = entryRecord(value, ['claims', 'nextCursor']);
          return {
            claims: list(page.claims, parseEntryClaim),
            nextCursor: page.nextCursor === null ? null : entryId(page.nextCursor),
          };
        },
      );
    },
    listPendingClaims: (actorId: string, creatorId: string) =>
      command(actorId, 'claim.pending', { creatorId: entryId(creatorId) }, (value) =>
        list(value, parseEntryClaim),
      ),
    getReviewClaim: (actorId: string, creatorId: string, claimId: string) =>
      command(
        actorId,
        'claim.review_read',
        { creatorId: entryId(creatorId), claimId: entryId(claimId) },
        parseEntryClaim,
      ),
    reviewClaim: (input: {
      readonly actorId: string;
      readonly creatorId: string;
      readonly claimId: string;
      readonly decision: 'approved' | 'rejected';
      readonly note: string | null;
    }) => {
      const decision = entryText(input.decision, 8);
      if (decision !== 'approved' && decision !== 'rejected') return invalidEntryInput();
      return command(
        input.actorId,
        'claim.review',
        {
          creatorId: entryId(input.creatorId),
          claimId: entryId(input.claimId),
          grantId: entryId(createId()),
          decision: input.decision,
          note: input.note === null ? null : entryText(input.note, 2000),
        },
        parseEntryClaim,
      );
    },
    createEvidence: (input: {
      readonly actorId: string;
      readonly boxId: string;
      readonly policyId: string;
      readonly mediaType: EvidenceMediaType;
      readonly byteLength: number;
    }) => {
      if (
        !['image/png', 'image/jpeg'].includes(input.mediaType) ||
        entryInteger(input.byteLength) > entryEvidenceMaxBytes
      )
        return invalidEntryInput();
      return command(
        input.actorId,
        'evidence.create',
        {
          id: entryId(createId()),
          boxId: entryId(input.boxId),
          policyId: entryId(input.policyId),
          mediaType: input.mediaType,
          byteLength: input.byteLength,
        },
        evidenceMetadata,
      );
    },
    uploadEvidence: async (input: {
      readonly actorId: string;
      readonly evidenceId: string;
      readonly accessToken: string;
      readonly mediaType: string;
      readonly bytes: Uint8Array;
    }) => {
      const metadata = await command(
        input.actorId,
        'evidence.upload',
        { evidenceId: entryId(input.evidenceId) },
        evidenceMetadata,
      );
      const mediaType = validateEvidenceImage(input.mediaType, input.bytes);
      if (metadata.mediaType !== mediaType || metadata.byteLength !== input.bytes.length)
        return invalidEntryInput();
      const hash = createHash('sha256').update(input.bytes).digest('hex');
      if (metadata.uploaded) {
        if (metadata.contentHash !== hash) throw new EntryError('ENTRY_CONFLICT');
        return metadata;
      }
      // Object I/O is intentionally outside every PostgreSQL transaction.
      await options.storage.upload(metadata.id, input.accessToken, mediaType, input.bytes);
      const stored = await options.storage.download(metadata.id, input.accessToken);
      if (
        stored.mediaType !== mediaType ||
        stored.bytes.length !== metadata.byteLength ||
        createHash('sha256').update(stored.bytes).digest('hex') !== hash
      )
        throw new EntryError('ENTRY_CONFLICT');
      return command(
        input.actorId,
        'evidence.complete',
        { evidenceId: metadata.id, contentHash: hash },
        evidenceMetadata,
      );
    },
    downloadEvidence: async (input: {
      readonly actorId: string;
      readonly creatorId: string | null;
      readonly evidenceId: string;
      readonly accessToken: string;
    }) => {
      const metadata = await command(
        input.actorId,
        'evidence.read',
        {
          evidenceId: entryId(input.evidenceId),
          creatorId: input.creatorId === null ? null : entryId(input.creatorId),
        },
        evidenceMetadata,
      );
      const result = await options.storage.download(metadata.id, input.accessToken);
      if (
        result.mediaType !== metadata.mediaType ||
        result.bytes.length !== metadata.byteLength ||
        createHash('sha256').update(result.bytes).digest('hex') !== metadata.contentHash
      )
        throw new EntryError('ENTRY_STORAGE_UNAVAILABLE');
      return result;
    },
  };
};
export type EntryService = ReturnType<typeof createEntryService>;
