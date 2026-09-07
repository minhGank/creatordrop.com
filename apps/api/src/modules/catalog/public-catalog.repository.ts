import type {
  PublicBoxSummaryContract,
  PublicCreatorSummaryContract,
} from '@creatordrop/contracts';
import type { QueryExecutor } from '@creatordrop/database';

import type { BoxId, BoxVersionId } from './catalog.js';

interface PublicCreatorRow {
  readonly customSlug: unknown;
  readonly displayName: unknown;
  readonly handle: unknown;
  readonly id: unknown;
}

interface PublicBoxRow {
  readonly configurationHash: unknown;
  readonly currency: unknown;
  readonly currentPublishedVersionId: unknown;
  readonly description: unknown;
  readonly id: unknown;
  readonly imageUrl: unknown;
  readonly maxOpeningsPerUser: unknown;
  readonly name: unknown;
  readonly openingCompatibilityVersion: unknown;
  readonly priceMinor: unknown;
  readonly publishedAt: unknown;
  readonly versionNumber: unknown;
}

interface PublicCreatorBoxRow extends PublicCreatorRow {
  readonly boxId: unknown;
  readonly versionId: unknown;
}

export interface PublicCreatorRecord {
  readonly id: string;
  readonly summary: PublicCreatorSummaryContract;
}

export interface PublicBoxRecord {
  readonly id: string;
  readonly summary: PublicBoxSummaryContract;
}

export interface PublicCreatorBoxRecord {
  readonly boxId: BoxId;
  readonly creator: PublicCreatorRecord;
  readonly versionId: BoxVersionId;
}

const requiredString = (value: unknown, field: string): string => {
  if (typeof value !== 'string') throw new Error(`Database returned invalid ${field}.`);
  return value;
};

const nullableString = (value: unknown, field: string): string | null =>
  value === null ? null : requiredString(value, field);

const requiredInteger = (value: unknown, field: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`Database returned invalid ${field}.`);
  }
  return value;
};

const requiredTimestamp = (value: unknown, field: string): string => {
  const parsed = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null;
  if (parsed === null || Number.isNaN(parsed.valueOf())) {
    throw new Error(`Database returned invalid ${field}.`);
  }
  return parsed.toISOString();
};

const parseCreator = (row: PublicCreatorRow): PublicCreatorRecord => ({
  id: requiredString(row.id, 'creator ID'),
  summary: {
    customSlug: requiredString(row.customSlug, 'creator custom slug'),
    displayName: requiredString(row.displayName, 'creator display name'),
    handle: requiredString(row.handle, 'creator handle'),
  },
});

const parseBox = (row: PublicBoxRow): PublicBoxRecord => {
  const id = requiredString(row.id, 'box ID');
  const openingCompatibilityVersion = nullableString(
    row.openingCompatibilityVersion,
    'opening compatibility version',
  );
  if (openingCompatibilityVersion !== null && openingCompatibilityVersion !== 'opening-v1') {
    if (openingCompatibilityVersion !== 'opening-v2') {
      throw new Error('Database returned invalid opening compatibility version.');
    }
  }
  const common = {
    configurationHash: requiredString(row.configurationHash, 'configuration hash'),
    currentPublishedVersionId: requiredString(
      row.currentPublishedVersionId,
      'current published version ID',
    ),
    description: requiredString(row.description, 'box description'),
    id,
    imageUrl: nullableString(row.imageUrl, 'box image URL'),
    name: requiredString(row.name, 'box name'),
    publishedAt: requiredTimestamp(row.publishedAt, 'box publication timestamp'),
    versionNumber: requiredInteger(row.versionNumber, 'box version number'),
  };
  if (openingCompatibilityVersion === 'opening-v2') {
    if (row.currency !== null || row.priceMinor !== null) {
      throw new Error('Database returned financial fields for opening-v2.');
    }
    return {
      id,
      summary: {
        ...common,
        availability: 'opening-v2',
        currency: null,
        maxOpeningsPerUser: requiredString(row.maxOpeningsPerUser, 'maximum openings per user'),
        openingCompatibilityVersion,
        priceMinor: null,
      },
    };
  }
  if (row.maxOpeningsPerUser !== null) {
    throw new Error('Database returned a legacy box with maximum openings.');
  }
  return {
    id,
    summary: {
      ...common,
      availability: openingCompatibilityVersion === 'opening-v1' ? 'openable' : 'legacy',
      currency: requiredString(row.currency, 'box currency'),
      maxOpeningsPerUser: null,
      openingCompatibilityVersion,
      priceMinor: requiredString(row.priceMinor, 'box price'),
    },
  };
};

const creatorColumns = `
  c.id::text as id,
  c.handle::text as handle,
  c.custom_slug::text as "customSlug",
  c.display_name as "displayName"`;

export const listPublicCreators = async (
  executor: QueryExecutor,
  cursorCreatorId: string | null,
  limit: number,
): Promise<readonly PublicCreatorRecord[]> => {
  const result = await executor.query<PublicCreatorRow>(
    `select ${creatorColumns}
       from app.creators c
      where c.status = 'active'
        and (
          $1::uuid is null
          or (c.created_at, c.id) > (
            select cursor_creator.created_at, cursor_creator.id
              from app.creators cursor_creator
             where cursor_creator.id = $1::uuid
          )
        )
      order by c.created_at asc, c.id asc
      limit $2`,
    [cursorCreatorId, limit],
  );
  return result.rows.map(parseCreator);
};

export const findPublicCreatorBySlug = async (
  executor: QueryExecutor,
  customSlug: string,
): Promise<PublicCreatorRecord | undefined> => {
  const result = await executor.query<PublicCreatorRow>(
    `select ${creatorColumns}
       from app.creators c
      where c.custom_slug = $1 and c.status = 'active'`,
    [customSlug],
  );
  return result.rows[0] === undefined ? undefined : parseCreator(result.rows[0]);
};

export const findPublicCreatorBox = async (
  executor: QueryExecutor,
  customSlug: string,
  boxId: BoxId,
): Promise<PublicCreatorBoxRecord | undefined> => {
  const result = await executor.query<PublicCreatorBoxRow>(
    `select ${creatorColumns},
            b.id::text as "boxId", bv.id::text as "versionId"
       from app.creators c
       join app.boxes b on b.creator_id = c.id
       join app.box_versions bv on bv.id = b.current_published_version_id
      where c.custom_slug = $1
        and c.status = 'active'
        and b.id = $2
        and b.status = 'active'
        and bv.state = 'published'`,
    [customSlug, boxId],
  );
  const row = result.rows[0];
  return row === undefined
    ? undefined
    : {
        boxId: requiredString(row.boxId, 'box ID') as BoxId,
        creator: parseCreator(row),
        versionId: requiredString(row.versionId, 'box version ID') as BoxVersionId,
      };
};

export const listPublicCreatorBoxes = async (
  executor: QueryExecutor,
  customSlug: string,
  cursorBoxId: string | null,
  limit: number,
): Promise<readonly PublicBoxRecord[]> => {
  const result = await executor.query<PublicBoxRow>(
    `select
       b.id::text as id,
       b.current_published_version_id::text as "currentPublishedVersionId",
       bv.name,
       bv.description,
       bv.image_url as "imageUrl",
       bv.max_openings_per_user::text as "maxOpeningsPerUser",
       bv.price_minor::text as "priceMinor",
       bv.currency,
       bv.version_number as "versionNumber",
       bv.opening_compatibility_version as "openingCompatibilityVersion",
       encode(bv.configuration_hash, 'hex') as "configurationHash",
       bv.published_at as "publishedAt"
       from app.creators c
       join app.boxes b on b.creator_id = c.id
       join app.box_versions bv on bv.id = b.current_published_version_id
      where c.custom_slug = $1
        and c.status = 'active'
        and b.status = 'active'
        and bv.state = 'published'
        and (
          $2::uuid is null
          or (b.created_at, b.id) > (
            select cursor_box.created_at, cursor_box.id
              from app.boxes cursor_box
             where cursor_box.id = $2::uuid and cursor_box.creator_id = c.id
          )
        )
      order by b.created_at asc, b.id asc
      limit $3`,
    [customSlug, cursorBoxId, limit],
  );
  return result.rows.map(parseBox);
};
