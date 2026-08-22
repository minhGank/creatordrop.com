import { RngError, type RngErrorCode } from './errors.js';

const canonicalUuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const canonicalNonnegativeIntegerPattern = /^(0|[1-9][0-9]*)$/u;
const lowercaseHex256Pattern = /^[0-9a-f]{64}$/u;

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const requireExactFields = (
  record: Readonly<Record<string, unknown>>,
  fields: readonly string[],
): void => {
  const actual = Object.keys(record).sort();
  const expected = [...fields].sort();
  if (
    actual.length !== expected.length ||
    actual.some((field, index) => field !== expected[index])
  ) {
    throw new RngError('MALFORMED_MANIFEST');
  }
};

export const parseCanonicalNonnegativeInteger = (value: unknown, code: RngErrorCode): bigint => {
  if (typeof value !== 'string' || !canonicalNonnegativeIntegerPattern.test(value)) {
    throw new RngError(code);
  }
  return BigInt(value);
};

export const isCanonicalUuid = (value: unknown): value is string =>
  typeof value === 'string' && canonicalUuidPattern.test(value);

export const requireCanonicalUuid = (value: unknown, code: RngErrorCode): string => {
  if (!isCanonicalUuid(value)) throw new RngError(code);
  return value;
};

export const requireLowercaseHex256 = (value: unknown, code: RngErrorCode): string => {
  if (typeof value !== 'string' || !lowercaseHex256Pattern.test(value)) {
    throw new RngError(code);
  }
  return value;
};
