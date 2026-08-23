import { validate as isUuid } from 'uuid';

import { ApiError } from '../../http/errors.js';
import type { ClientSeed, RngSeedSetId } from './fairness.js';

const clientSeedPattern = /^[0-9a-f]{64}$/u;
const idempotencyKeyPattern = /^[A-Za-z0-9._~-]{8,128}$/u;
const ifMatchPattern = /^"(?<revision>[1-9][0-9]*)"$/u;
const maximumPostgresInteger = 2_147_483_647;

const record = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'The request body must be a JSON object.');
  }
  return value as Record<string, unknown>;
};

const exactFields = (value: Record<string, unknown>, fields: readonly string[]): void => {
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (
    actual.length !== expected.length ||
    expected.some((field, index) => field !== actual[index] || !Object.hasOwn(value, field))
  ) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'The request body contains invalid fields.');
  }
};

export const parseClientSeedInput = (value: unknown): { readonly clientSeed: ClientSeed } => {
  const input = record(value);
  exactFields(input, ['clientSeed']);
  if (typeof input.clientSeed !== 'string' || !clientSeedPattern.test(input.clientSeed)) {
    throw new ApiError(
      400,
      'VALIDATION_ERROR',
      'clientSeed must be exactly 64 lowercase hexadecimal characters.',
      { field: 'clientSeed' },
    );
  }
  return { clientSeed: input.clientSeed as ClientSeed };
};

export const parseFairnessRevision = (value: string | undefined): number => {
  const revision = value === undefined ? undefined : ifMatchPattern.exec(value)?.groups?.revision;
  const parsed = revision === undefined ? Number.NaN : Number(revision);
  if (!Number.isSafeInteger(parsed) || parsed > maximumPostgresInteger) {
    throw new ApiError(
      428,
      'FAIRNESS_REVISION_REQUIRED',
      'If-Match must contain the quoted current fairness revision.',
    );
  }
  return parsed;
};

export const parseEmptyRotationInput = (body: unknown, query: unknown): void => {
  const parsedQuery = record(query);
  exactFields(parsedQuery, []);
  if (body === undefined) return;
  const parsedBody = record(body);
  exactFields(parsedBody, []);
};

export const parseRotationIdempotencyKey = (value: string | undefined): string => {
  if (value === undefined || !idempotencyKeyPattern.test(value)) {
    throw new ApiError(
      400,
      'INVALID_IDEMPOTENCY_KEY',
      'Idempotency-Key must contain 8 to 128 allowlisted characters.',
    );
  }
  return value;
};

export const parseSeedSetId = (value: string | undefined): RngSeedSetId => {
  if (value === undefined || !isUuid(value)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'seedSetId must be a UUID.', {
      field: 'seedSetId',
    });
  }
  return value.toLowerCase() as RngSeedSetId;
};
