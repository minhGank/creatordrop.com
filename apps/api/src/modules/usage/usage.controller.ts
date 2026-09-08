import { creatorUsageQuerySchema } from '@creatordrop/contracts';
import type { RequestHandler } from 'express';
import { ApiError, authenticationRequired } from '../../http/errors.js';
import { parseCreatorId, trustedUserId } from '../creators/creator.schema.js';
import type { CreatorUsageService } from './usage.service.js';

export const createUsageController =
  (service: CreatorUsageService): RequestHandler =>
  (request, response, next) => {
    const run = async (): Promise<void> => {
      if (request.actor === undefined) throw authenticationRequired();
      const creatorId = parseCreatorId(
        typeof request.params.creatorId === 'string' ? request.params.creatorId : undefined,
      );
      const query = creatorUsageQuerySchema.safeParse(request.query);
      if (!query.success)
        throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid usage range or pagination.');
      const result = await service.read(
        { actorUserId: trustedUserId(request.actor.user.id), creatorId },
        query.data,
      );
      response.setHeader('Cache-Control', 'private, no-store');
      response.json(result);
    };
    void run().catch(next);
  };
