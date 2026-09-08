import { Router, type RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import { ApiError } from '../../http/errors.js';
import { createUsageController } from './usage.controller.js';
import type { CreatorUsageService } from './usage.service.js';

export const createUsageRouter = ({
  authenticate,
  service,
}: {
  readonly authenticate: RequestHandler;
  readonly service: CreatorUsageService;
}): Router => {
  const router = Router();
  const limited: RequestHandler = (_request, _response, next) =>
    next(new ApiError(429, 'RATE_LIMITED', 'Too many usage requests.'));
  const gate = rateLimit({
    limit: 200,
    windowMs: 60_000,
    legacyHeaders: false,
    standardHeaders: 'draft-8',
    handler: limited,
  });
  const reads = rateLimit({
    limit: 120,
    windowMs: 60_000,
    legacyHeaders: false,
    standardHeaders: 'draft-8',
    handler: limited,
    keyGenerator: (request) => {
      if (request.actor === undefined) throw new Error('Missing authenticated usage actor.');
      return request.actor.user.id;
    },
  });
  router.get(
    '/creators/:creatorId/usage',
    gate,
    authenticate,
    reads,
    createUsageController(service),
  );
  return router;
};
