import type { NextFunction, Request, RequestHandler, Response } from 'express';

import type {
  PublicCreatorBoxResponse,
  PublicCreatorBoxesResponse,
  PublicCreatorResponse,
  PublicCreatorsResponse,
} from '@creatordrop/contracts';

import { parseBoxId } from './catalog.schema.js';
import { parsePublicCatalogPage, parsePublicCatalogSlug } from './public-catalog.schema.js';
import type { PublicCatalogService } from './public-catalog.service.js';

const run = (operation: () => Promise<void>, next: NextFunction): void => {
  void operation().catch(next);
};

const parameter = (value: string | string[] | undefined): string | undefined =>
  typeof value === 'string' ? value : undefined;

export interface PublicCatalogControllers {
  readonly getCreator: RequestHandler;
  readonly getCreatorBox: RequestHandler;
  readonly listCreatorBoxes: RequestHandler;
  readonly listCreators: RequestHandler;
}

export const createPublicCatalogControllers = (
  service: PublicCatalogService,
): PublicCatalogControllers => ({
  getCreator: (request: Request, response: Response<PublicCreatorResponse>, next) => {
    run(async () => {
      const creator = await service.getCreator(
        parsePublicCatalogSlug(parameter(request.params.customSlug)),
      );
      response.status(200).json({ creator });
    }, next);
  },
  getCreatorBox: (request: Request, response: Response<PublicCreatorBoxResponse>, next) => {
    run(async () => {
      const result = await service.getCreatorBox(
        parsePublicCatalogSlug(parameter(request.params.customSlug)),
        parseBoxId(parameter(request.params.boxId)),
      );
      response.status(200).json(result);
    }, next);
  },
  listCreatorBoxes: (request: Request, response: Response<PublicCreatorBoxesResponse>, next) => {
    run(async () => {
      const result = await service.listCreatorBoxes(
        parsePublicCatalogSlug(parameter(request.params.customSlug)),
        parsePublicCatalogPage(request.query),
      );
      response.status(200).json({ boxes: result.items, nextCursor: result.nextCursor });
    }, next);
  },
  listCreators: (request: Request, response: Response<PublicCreatorsResponse>, next) => {
    run(async () => {
      const result = await service.listCreators(parsePublicCatalogPage(request.query));
      response.status(200).json({ creators: result.items, nextCursor: result.nextCursor });
    }, next);
  },
});
