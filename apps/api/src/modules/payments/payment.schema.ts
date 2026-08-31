import type { PositiveMoneyMinor } from '@creatordrop/domain';
import { MoneyValueError, parsePositiveMoneyMinor } from '@creatordrop/domain';

import { ApiError } from '../../http/errors.js';
import { parseWalletIdempotencyKey } from '../wallet/wallet.schema.js';

const validationError = (
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): ApiError => new ApiError(400, 'VALIDATION_ERROR', message, details);

export const parseFundingAmount = (body: unknown): PositiveMoneyMinor => {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw validationError('The request body must be a JSON object.');
  }
  const record = body as Record<string, unknown>;
  const unknownFields = Object.keys(record).filter((field) => field !== 'amountMinor');
  if (unknownFields.length > 0) {
    throw validationError('The request contains unknown fields.', { unknownFields });
  }
  try {
    return parsePositiveMoneyMinor(record.amountMinor);
  } catch (error) {
    if (!(error instanceof MoneyValueError)) throw error;
    throw validationError('amountMinor must be a positive canonical decimal string.', {
      field: 'amountMinor',
    });
  }
};

export const parseFundingIdempotencyKey = parseWalletIdempotencyKey;

export const parseStripeSignature = (value: string | undefined): string => {
  if (value === undefined || value.length < 8 || value.length > 4096) {
    throw new ApiError(400, 'STRIPE_SIGNATURE_INVALID', 'The Stripe signature is invalid.');
  }
  return value;
};
