import { Router, raw, type RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import { ApiError } from '../../http/errors.js';
import { createEntryControllers } from './entry.controller.js';
import type { EntryService } from './entry.service.js';
import { entryEvidenceMaxBytes } from './entry.storage.js';

export const createEntryRouter = (options: {
  readonly authenticate: RequestHandler;
  readonly service: EntryService;
}): Router => {
  const router = Router();
  const controls = createEntryControllers(options.service);
  const handler = (name: string): RequestHandler => {
    const value = controls[name];
    if (value === undefined) throw new Error('Unknown entry controller.');
    return value;
  };
  const limit = (max: number, actor = false) =>
    rateLimit({
      limit: max,
      windowMs: 60_000,
      legacyHeaders: false,
      standardHeaders: 'draft-8',
      ...(actor
        ? {
            keyGenerator: (r) => {
              if (r.actor === undefined) throw new Error('Missing entry actor.');
              return r.actor.user.id;
            },
          }
        : {}),
      handler: (_r, _s, next) =>
        next(new ApiError(429, 'RATE_LIMITED', 'Too many entry requests.')),
    });
  const gate = limit(200);
  const writes = limit(30, true);
  const reads = limit(120, true);
  router.get('/entry-platforms', gate, handler('registry'));
  router.get('/boxes/:boxId/entry-methods', gate, handler('published'));
  const auth = [gate, options.authenticate] as const;
  router.get('/boxes/:boxId/me/entry-state', ...auth, reads, handler('state'));
  const creator = '/creators/:creatorId/boxes/:boxId/entry-methods';
  router.get(creator, ...auth, reads, handler('list'));
  router.post(creator, ...auth, writes, handler('create'));
  router.put(`${creator}/:methodId/draft`, ...auth, writes, handler('update'));
  router.post(`${creator}/:methodId/publish`, ...auth, writes, handler('publish'));
  router.patch(`${creator}/:methodId/availability`, ...auth, writes, handler('enable'));
  router.post('/boxes/:boxId/entry-claims', ...auth, writes, handler('submit'));
  router.get('/me/entry-claims/:claimId', ...auth, reads, handler('own'));
  router.get('/creators/:creatorId/entry-claims', ...auth, reads, handler('pending'));
  router.get('/creators/:creatorId/entry-claims/:claimId', ...auth, reads, handler('reviewRead'));
  router.post(
    '/creators/:creatorId/entry-claims/:claimId/review',
    ...auth,
    writes,
    handler('review'),
  );
  router.post('/boxes/:boxId/entry-evidence', ...auth, writes, handler('evidenceCreate'));
  router.post(
    '/me/entry-evidence/:evidenceId/content',
    ...auth,
    writes,
    raw({ type: ['image/png', 'image/jpeg'], limit: entryEvidenceMaxBytes }),
    handler('evidenceUpload'),
  );
  router.get('/me/entry-evidence/:evidenceId/content', ...auth, reads, handler('evidenceOwn'));
  router.get(
    '/creators/:creatorId/entry-evidence/:evidenceId/content',
    ...auth,
    reads,
    handler('evidenceReviewer'),
  );
  return router;
};
