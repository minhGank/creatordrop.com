import { parseClientSeed, RngError } from '@creatordrop/domain';

import { ApiError } from '../../http/errors.js';
import { parseBoxId } from '../catalog/catalog.schema.js';
import type { BoxId } from '../catalog/catalog.js';
import type { ClientSeed } from '../fairness/fairness.js';
import { parseWalletIdempotencyKey } from '../wallet/wallet.schema.js';

const validationError = (message: string, field: string): ApiError =>
  new ApiError(400, 'VALIDATION_ERROR', message, { field });

export const parseOpeningBody = (body: unknown): { readonly clientSeed: ClientSeed } => {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw validationError('The request body must be a JSON object.', 'body');
  }
  const record = body as Record<string, unknown>;
  const unknownFields = Object.keys(record).filter((key) => key !== 'clientSeed');
  if (unknownFields.length > 0) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'The request contains unknown fields.', {
      unknownFields,
    });
  }
  try {
    return { clientSeed: parseClientSeed(record.clientSeed) as ClientSeed };
  } catch (error) {
    if (!(error instanceof RngError)) throw error;
    throw validationError(
      'clientSeed must be exactly 32 lowercase hexadecimal bytes.',
      'clientSeed',
    );
  }
};

export const parseOpeningBoxId = (value: string | undefined): BoxId => parseBoxId(value);
export const parseOpeningIdempotencyKey = (value: string | undefined): string =>
  parseWalletIdempotencyKey(value);

export const parseEmptyOpeningQuery = (query: Readonly<Record<string, unknown>>): void => {
  const unknownFields = Object.keys(query);
  if (unknownFields.length > 0) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'The request contains unknown query parameters.', {
      unknownFields,
    });
  }
};
