import type {
  PublicBoxSummaryContract,
  PublicCreatorBoxResponse,
  PublicCreatorSummaryContract,
} from '@creatordrop/contracts';
import type { Database } from '@creatordrop/database';

import { ApiError } from '../../http/errors.js';
import { buildPublishedCatalog, type PublishedCatalogVersion } from './catalog.service.js';
import {
  findPublicCreatorBySlug,
  findPublicCreatorBox,
  listPublicCreatorBoxes,
  listPublicCreators,
} from './public-catalog.repository.js';
import { findPublicPublishedVersion } from './catalog.repository.js';
import { encodePublicCatalogCursor } from './public-catalog.schema.js';
import type { BoxId } from './catalog.js';

export interface PublicCatalogPageRequest {
  readonly cursorId: string | null;
  readonly limit: number;
}

export interface PublicCatalogPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

export interface PublicCatalogService {
  getCreator(customSlug: string): Promise<PublicCreatorSummaryContract>;
  getCreatorBox(customSlug: string, boxId: BoxId): Promise<PublicCreatorBoxResponse>;
  listCreatorBoxes(
    customSlug: string,
    page: PublicCatalogPageRequest,
  ): Promise<PublicCatalogPage<PublicBoxSummaryContract>>;
  listCreators(
    page: PublicCatalogPageRequest,
  ): Promise<PublicCatalogPage<PublicCreatorSummaryContract>>;
}

const notFound = (): ApiError =>
  new ApiError(404, 'PUBLIC_CREATOR_NOT_FOUND', 'The public creator was not found.');

const catalogNotFound = (): ApiError =>
  new ApiError(404, 'PUBLIC_CATALOG_RESOURCE_NOT_FOUND', 'The public catalog item was not found.');

const page = <Record extends { readonly id: string }, Contract>(
  records: readonly Record[],
  limit: number,
  select: (record: Record) => Contract,
): PublicCatalogPage<Contract> => {
  const hasNextPage = records.length > limit;
  const visible = hasNextPage ? records.slice(0, limit) : records;
  const last = visible.at(-1);
  return {
    items: visible.map(select),
    nextCursor: hasNextPage && last !== undefined ? encodePublicCatalogCursor(last.id) : null,
  };
};

export const createPublicCatalogService = ({
  database,
}: {
  readonly database: Database;
}): PublicCatalogService => ({
  getCreator: async (customSlug) => {
    const creator = await findPublicCreatorBySlug(database, customSlug);
    if (creator === undefined) throw notFound();
    return creator.summary;
  },
  getCreatorBox: (customSlug, boxId) =>
    database.transaction(
      async (transaction) => {
        const record = await findPublicCreatorBox(transaction, customSlug, boxId);
        if (record === undefined) throw catalogNotFound();
        const published = await findPublicPublishedVersion(
          transaction,
          record.boxId,
          record.versionId,
        );
        if (published === undefined) throw catalogNotFound();
        const box: PublishedCatalogVersion = await buildPublishedCatalog(
          transaction,
          published.boxId,
          published.version,
        );
        return { box, creator: record.creator.summary };
      },
      { isolationLevel: 'repeatable-read', readOnly: true },
    ),
  listCreatorBoxes: async (customSlug, request) => {
    const creator = await findPublicCreatorBySlug(database, customSlug);
    if (creator === undefined) throw notFound();
    const records = await listPublicCreatorBoxes(
      database,
      customSlug,
      request.cursorId,
      request.limit + 1,
    );
    return page(records, request.limit, (record) => record.summary);
  },
  listCreators: async (request) => {
    const records = await listPublicCreators(database, request.cursorId, request.limit + 1);
    return page(records, request.limit, (record) => record.summary);
  },
});
