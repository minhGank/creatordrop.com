import { parseClientSeed, RngError } from '@creatordrop/domain';

import { ApiError } from '../../http/errors.js';
import { parseBoxId, parseBoxVersionId } from '../catalog/catalog.schema.js';
import type { BoxId, BoxVersionId } from '../catalog/catalog.js';
import { parseSeedSetId } from '../fairness/fairness.schema.js';
import type { ClientSeed, RngSeedSetId } from '../fairness/fairness.js';
import { parseWalletIdempotencyKey } from '../wallet/wallet.schema.js';

const validationError = (message: string, field: string): ApiError =>
  new ApiError(400, 'VALIDATION_ERROR', message, { field });

export const parseOpeningBody = (
  body: unknown,
): {
  readonly clientSeed: ClientSeed;
  readonly expectedBoxVersionId: BoxVersionId;
  readonly expectedConfigurationHash: string;
  readonly expectedSeedSetId: RngSeedSetId;
  readonly expectedServerSeedCommitment: string;
} => {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw validationError('The request body must be a JSON object.', 'body');
  }
  const record = body as Record<string, unknown>;
  const unknownFields = Object.keys(record).filter(
    (key) =>
      ![
        'clientSeed',
        'expectedBoxVersionId',
        'expectedConfigurationHash',
        'expectedSeedSetId',
        'expectedServerSeedCommitment',
      ].includes(key),
  );
  if (unknownFields.length > 0) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'The request contains unknown fields.', {
      unknownFields,
    });
  }
  try {
    const expectedConfigurationHash = record.expectedConfigurationHash;
    if (
      typeof expectedConfigurationHash !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(expectedConfigurationHash)
    ) {
      throw validationError(
        'expectedConfigurationHash must be exactly 32 lowercase hexadecimal bytes.',
        'expectedConfigurationHash',
      );
    }
    const expectedServerSeedCommitment = record.expectedServerSeedCommitment;
    if (
      typeof expectedServerSeedCommitment !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(expectedServerSeedCommitment)
    ) {
      throw validationError(
        'expectedServerSeedCommitment must be exactly 32 lowercase hexadecimal bytes.',
        'expectedServerSeedCommitment',
      );
    }
    return {
      clientSeed: parseClientSeed(record.clientSeed) as ClientSeed,
      expectedBoxVersionId: parseBoxVersionId(
        typeof record.expectedBoxVersionId === 'string' ? record.expectedBoxVersionId : undefined,
      ),
      expectedConfigurationHash,
      expectedSeedSetId: parseSeedSetId(
        typeof record.expectedSeedSetId === 'string' ? record.expectedSeedSetId : undefined,
      ),
      expectedServerSeedCommitment,
    };
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
