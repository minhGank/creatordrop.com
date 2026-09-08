import type { Request, RequestHandler } from 'express';
import { entryPlatformActions } from '@creatordrop/contracts';
import { ApiError } from '../../http/errors.js';
import {
  entryId,
  entryInteger,
  entryRecord,
  entryText,
  invalidEntryInput,
} from './entry.schema.js';
import type { EntryService } from './entry.service.js';

const actor = (request: Request): string => {
  if (request.actor === undefined) throw new Error('Authenticated entry actor is missing.');
  return request.actor.user.id;
};
const scope = (r: Request) => ({
  actorId: actor(r),
  creatorId: entryId(r.params.creatorId),
  boxId: entryId(r.params.boxId),
});
const revision = (r: Request): number => {
  const value = r.get('if-match');
  if (value === undefined)
    throw new ApiError(428, 'PRECONDITION_REQUIRED', 'If-Match is required.');
  if (!/^"[1-9][0-9]*"$/u.test(value)) return invalidEntryInput();
  return entryInteger(Number(value.slice(1, -1)));
};
const method = (r: Request) => ({
  ...scope(r),
  methodId: entryId(r.params.methodId),
  expectedRevision: revision(r),
});
const body = (r: Request, keys: readonly string[]) => {
  if (!r.is('application/json'))
    throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Use application/json.');
  return entryRecord(r.body, keys);
};
const token = (r: Request): string => {
  const header = r.get('authorization');
  if (!header?.startsWith('Bearer ')) return invalidEntryInput();
  return header.slice(7);
};
export const createEntryControllers = (service: EntryService): Record<string, RequestHandler> => {
  const json =
    (action: (r: Request) => Promise<unknown>, status = 200): RequestHandler =>
    (r, s, n) => {
      if (Object.keys(r.query).length !== 0) {
        n(new ApiError(400, 'ENTRY_INVALID_INPUT', 'Unsupported query.'));
        return;
      }
      void action(r)
        .then((value) => {
          s.setHeader('Cache-Control', 'private, no-store');
          s.status(status).json(value);
        })
        .catch(n);
    };
  const download =
    (creator: boolean): RequestHandler =>
    (r, s, n) => {
      if (Object.keys(r.query).length !== 0) {
        n(new ApiError(400, 'ENTRY_INVALID_INPUT', 'Unsupported query.'));
        return;
      }
      void service
        .downloadEvidence({
          actorId: actor(r),
          creatorId: creator ? entryId(r.params.creatorId) : null,
          evidenceId: entryId(r.params.evidenceId),
          accessToken: token(r),
        })
        .then(({ bytes, mediaType }) => {
          s.set({
            'Content-Type': mediaType,
            'Content-Disposition': 'attachment; filename="evidence"',
            'Cache-Control': 'private, no-store',
            'X-Content-Type-Options': 'nosniff',
          }).send(Buffer.from(bytes));
        })
        .catch(n);
    };
  return {
    registry: json(() => Promise.resolve({ platforms: entryPlatformActions })),
    create: json(
      async (r) => ({
        method: await service.createMethod({
          ...scope(r),
          definition: body(r, ['definition']).definition,
        }),
      }),
      201,
    ),
    update: json(async (r) => ({
      method: await service.updateMethod({
        ...method(r),
        definition: body(r, ['definition']).definition,
      }),
    })),
    enable: json(async (r) => {
      const input = body(r, ['enabled']);
      if (typeof input.enabled !== 'boolean') return invalidEntryInput();
      return { method: await service.setMethodEnabled({ ...method(r), enabled: input.enabled }) };
    }),
    publish: json(async (r) => ({
      method: await service.publishMethod({
        ...method(r),
        boxVersionId: entryId(body(r, ['boxVersionId']).boxVersionId),
      }),
    })),
    list: json(async (r) => ({ methods: await service.listMethods(scope(r)) })),
    published: json(async (r) => ({
      methods: await service.listPublishedMethods(entryId(r.params.boxId)),
    })),
    submit: json(async (r) => {
      const input = body(r, ['policyId', 'evidence']);
      return {
        claim: await service.submitClaim({
          actorId: actor(r),
          boxId: entryId(r.params.boxId),
          policyId: entryId(input.policyId),
          evidence: input.evidence,
          idempotencyKey: entryText(r.get('idempotency-key'), 128),
        }),
      };
    }, 201),
    own: json(async (r) => ({
      claim: await service.getOwnClaim(actor(r), entryId(r.params.claimId)),
    })),
    pending: json(async (r) => ({
      claims: await service.listPendingClaims(actor(r), entryId(r.params.creatorId)),
    })),
    reviewRead: json(async (r) => ({
      claim: await service.getReviewClaim(
        actor(r),
        entryId(r.params.creatorId),
        entryId(r.params.claimId),
      ),
    })),
    review: json(async (r) => {
      const input = body(r, ['decision', 'note']);
      if (input.decision !== 'approved' && input.decision !== 'rejected')
        return invalidEntryInput();
      return {
        claim: await service.reviewClaim({
          actorId: actor(r),
          creatorId: entryId(r.params.creatorId),
          claimId: entryId(r.params.claimId),
          decision: input.decision,
          note:
            input.note === undefined || input.note === null ? null : entryText(input.note, 2000),
        }),
      };
    }),
    evidenceCreate: json(async (r) => {
      const input = body(r, ['policyId', 'mediaType', 'byteLength']);
      if (input.mediaType !== 'image/png' && input.mediaType !== 'image/jpeg')
        return invalidEntryInput();
      const evidence = await service.createEvidence({
        actorId: actor(r),
        boxId: entryId(r.params.boxId),
        policyId: entryId(input.policyId),
        mediaType: input.mediaType,
        byteLength: entryInteger(input.byteLength),
      });
      return {
        evidence: {
          id: evidence.id,
          mediaType: evidence.mediaType,
          byteLength: evidence.byteLength,
          uploaded: evidence.uploaded,
        },
      };
    }, 201),
    evidenceUpload: json(async (r) => {
      if (!Buffer.isBuffer(r.body)) return invalidEntryInput();
      const evidence = await service.uploadEvidence({
        actorId: actor(r),
        evidenceId: entryId(r.params.evidenceId),
        accessToken: token(r),
        mediaType: r.get('content-type') ?? '',
        bytes: r.body,
      });
      return {
        evidence: {
          id: evidence.id,
          mediaType: evidence.mediaType,
          byteLength: evidence.byteLength,
          uploaded: evidence.uploaded,
        },
      };
    }),
    evidenceOwn: download(false),
    evidenceReviewer: download(true),
  };
};
