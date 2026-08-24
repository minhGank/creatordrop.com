import type { Currency, PositiveMoneyMinor } from '@creatordrop/domain';
import { MoneyValueError, parseCurrency, parsePositiveMoneyMinor } from '@creatordrop/domain';

import { ApiError } from '../../http/errors.js';

export interface TestCreditInput {
  readonly amountMinor: PositiveMoneyMinor;
}

const validationError = (
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): ApiError => new ApiError(400, 'VALIDATION_ERROR', message, details);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const rejectUnknownFields = (record: Record<string, unknown>, allowed: readonly string[]): void => {
  const unknownFields = Object.keys(record).filter((field) => !allowed.includes(field));
  if (unknownFields.length > 0) {
    throw validationError('The request contains unknown fields.', { unknownFields });
  }
};

export const parseWalletCurrency = (value: string | undefined): Currency => {
  try {
    return parseCurrency(value);
  } catch (error) {
    if (!(error instanceof MoneyValueError)) throw error;
    throw validationError('currency must be three uppercase letters.', { field: 'currency' });
  }
};

export const parseTestCreditInput = (body: unknown): TestCreditInput => {
  if (!isRecord(body)) throw validationError('The request body must be a JSON object.');
  rejectUnknownFields(body, ['amountMinor']);
  try {
    return { amountMinor: parsePositiveMoneyMinor(body.amountMinor) };
  } catch (error) {
    if (!(error instanceof MoneyValueError)) throw error;
    throw validationError(
      'amountMinor must be a positive canonical decimal string within signed 64-bit storage.',
      { field: 'amountMinor' },
    );
  }
};

export const parseWalletIdempotencyKey = (value: string | undefined): string => {
  if (
    value === undefined ||
    value.length < 8 ||
    value.length > 128 ||
    !/^[A-Za-z0-9._:-]+$/u.test(value)
  ) {
    throw validationError('Idempotency-Key must contain 8 to 128 allowlisted characters.', {
      field: 'Idempotency-Key',
    });
  }
  return value;
};

export const parseEmptyWalletQuery = (query: Readonly<Record<string, unknown>>): void => {
  const unknownFields = Object.keys(query);
  if (unknownFields.length > 0) {
    throw validationError('The request contains unknown query parameters.', { unknownFields });
  }
};
