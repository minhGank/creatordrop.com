import { Router } from 'express';

import { createPublicCatalogControllers } from './public-catalog.controller.js';
import type { PublicCatalogService } from './public-catalog.service.js';

export const createPublicCatalogRouter = (service: PublicCatalogService): Router => {
  const router = Router();
  const controllers = createPublicCatalogControllers(service);

  router.get('/catalog/creators', controllers.listCreators);
  router.get('/catalog/creators/:customSlug', controllers.getCreator);
  router.get('/catalog/creators/:customSlug/boxes', controllers.listCreatorBoxes);
  router.get('/catalog/creators/:customSlug/boxes/:boxId', controllers.getCreatorBox);

  return router;
};
