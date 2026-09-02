import { validate as isUuid } from 'uuid';

import { ApiError } from '../../http/errors.js';

const customSlugPattern = /^[a-z0-9][a-z0-9-]{2,62}$/u;
const canonicalLimitPattern = /^[1-9][0-9]*$/u;
const cursorPrefix = 'v1.';
const defaultPageSize = 20;
const maximumPageSize = 50;

export interface PublicCatalogPageInput {
  readonly cursorId: string | null;
  readonly limit: number;
}

const validationError = (
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): ApiError => new ApiError(400, 'VALIDATION_ERROR', message, details);

const queryValue = (value: unknown, field: string): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw validationError(`${field} must be a single string value.`, { field });
  }
  return value;
};

const decodeCursor = (value: string): string => {
  if (!value.startsWith(cursorPrefix)) {
    throw validationError('cursor is invalid.', { field: 'cursor' });
  }
  const encoded = value.slice(cursorPrefix.length);
  let decoded: string;
  try {
    decoded = Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    throw validationError('cursor is invalid.', { field: 'cursor' });
  }
  if (
    Buffer.from(decoded, 'utf8').toString('base64url') !== encoded ||
    !isUuid(decoded) ||
    decoded !== decoded.toLowerCase()
  ) {
    throw validationError('cursor is invalid.', { field: 'cursor' });
  }
  return decoded;
};

export const encodePublicCatalogCursor = (id: string): string =>
  `${cursorPrefix}${Buffer.from(id, 'utf8').toString('base64url')}`;

export const parsePublicCatalogSlug = (value: string | undefined): string => {
  const normalized = value?.toLowerCase();
  if (normalized === undefined || !customSlugPattern.test(normalized)) {
    throw validationError('customSlug must be a valid public creator slug.', {
      field: 'customSlug',
    });
  }
  return normalized;
};

export const parsePublicCatalogPage = (
  query: Readonly<Record<string, unknown>>,
): PublicCatalogPageInput => {
  const unknownFields = Object.keys(query).filter(
    (field) => field !== 'cursor' && field !== 'limit',
  );
  if (unknownFields.length > 0) {
    throw validationError('The request contains unknown query fields.', { unknownFields });
  }

  const cursor = queryValue(query.cursor, 'cursor');
  const limitText = queryValue(query.limit, 'limit');
  const limit = limitText === undefined ? defaultPageSize : Number(limitText);
  if (
    limitText !== undefined &&
    (!canonicalLimitPattern.test(limitText) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > maximumPageSize)
  ) {
    throw validationError(
      `limit must be a canonical integer from 1 to ${maximumPageSize.toString()}.`,
      {
        field: 'limit',
      },
    );
  }

  return { cursorId: cursor === undefined ? null : decodeCursor(cursor), limit };
};
