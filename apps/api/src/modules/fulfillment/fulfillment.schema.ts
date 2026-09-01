import { validate as isUuid } from 'uuid';

import { ApiError } from '../../http/errors.js';
import type { FulfillmentAddressContract } from './fulfillment.js';

const positiveDecimal = /^[1-9][0-9]*$/u;
const actionKeyPattern = /^[A-Za-z0-9._:-]{8,128}$/u;
const maximumSignedBigint = 9_223_372_036_854_775_807n;

const invalid = (message: string, details: Readonly<Record<string, unknown>> = {}): ApiError =>
  new ApiError(400, 'VALIDATION_ERROR', message, details);

const record = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid('The request body must be a JSON object.');
  }
  return value as Record<string, unknown>;
};

const exact = (value: Record<string, unknown>, fields: readonly string[]): void => {
  const unknownFields = Object.keys(value).filter((field) => !fields.includes(field));
  if (unknownFields.length > 0)
    throw invalid('The request contains unknown fields.', { unknownFields });
};

const text = (value: Record<string, unknown>, field: string, maximum: number): string => {
  const candidate = value[field];
  if (typeof candidate !== 'string') throw invalid(`${field} must be a string.`, { field });
  const trimmed = candidate.trim();
  let hasControlCharacter = false;
  for (let index = 0; index < trimmed.length; index += 1) {
    const codeUnit = trimmed.charCodeAt(index);
    if (codeUnit <= 31 || codeUnit === 127) {
      hasControlCharacter = true;
      break;
    }
  }
  if (trimmed.length < 1 || trimmed.length > maximum || hasControlCharacter) {
    throw invalid(`${field} has an invalid length or contains control characters.`, { field });
  }
  return trimmed;
};

export const parseFulfillmentId = (value: string | undefined): string => {
  if (value === undefined || !isUuid(value)) throw invalid('fulfillmentId must be a UUID.');
  return value.toLowerCase();
};

export const parseInventoryPoolId = (value: string | undefined): string => {
  if (value === undefined || !isUuid(value)) throw invalid('poolId must be a UUID.');
  return value.toLowerCase();
};

export const parseActionKey = (value: string | undefined): string => {
  if (value === undefined || !actionKeyPattern.test(value)) {
    throw invalid('Idempotency-Key must contain 8-128 safe characters.');
  }
  return value;
};

export const parseExpectedRevision = (value: string | undefined): number => {
  const match = value?.match(/^"?([1-9][0-9]*)"?$/u);
  if (match?.[1] === undefined) throw invalid('If-Match must contain a positive revision.');
  const revision = Number(match[1]);
  if (!Number.isSafeInteger(revision)) throw invalid('If-Match revision is too large.');
  return revision;
};

export const parseAddress = (body: unknown): FulfillmentAddressContract => {
  const value = record(body);
  exact(value, [
    'recipientName',
    'addressLine1',
    'addressLine2',
    'city',
    'region',
    'postalCode',
    'country',
  ]);
  const line2 = value.addressLine2;
  if (line2 !== undefined && line2 !== null && typeof line2 !== 'string') {
    throw invalid('addressLine2 must be a string or null.', { field: 'addressLine2' });
  }
  const normalizedLine2 = typeof line2 === 'string' ? line2.trim() : null;
  if (normalizedLine2 !== null && normalizedLine2.length > 200) {
    throw invalid('addressLine2 is too long.', { field: 'addressLine2' });
  }
  const country = text(value, 'country', 2).toUpperCase();
  if (!/^[A-Z]{2}$/u.test(country)) throw invalid('country must be an ISO alpha-2 code.');
  return {
    addressLine1: text(value, 'addressLine1', 200),
    addressLine2: normalizedLine2 === '' ? null : normalizedLine2,
    city: text(value, 'city', 120),
    country,
    postalCode: text(value, 'postalCode', 32),
    recipientName: text(value, 'recipientName', 160),
    region: text(value, 'region', 120),
  };
};

export type CreatorFulfillmentAction =
  | {
      readonly action:
        'fulfill_experience' | 'mark_delivered' | 'mark_shipped' | 'resolve_backorder';
    }
  | { readonly action: 'deliver_digital'; readonly secret: string };

export const parseCreatorAction = (body: unknown): CreatorFulfillmentAction => {
  const value = record(body);
  if (value.action === 'deliver_digital') {
    exact(value, ['action', 'secret']);
    return { action: 'deliver_digital', secret: text(value, 'secret', 4096) };
  }
  exact(value, ['action']);
  if (
    value.action !== 'resolve_backorder' &&
    value.action !== 'mark_shipped' &&
    value.action !== 'mark_delivered' &&
    value.action !== 'fulfill_experience'
  ) {
    throw invalid('action is not supported.');
  }
  return { action: value.action };
};

export const parseRestock = (body: unknown): { readonly quantity: bigint } => {
  const value = record(body);
  exact(value, ['quantity']);
  if (typeof value.quantity !== 'string' || !positiveDecimal.test(value.quantity)) {
    throw invalid('quantity must be a canonical positive integer string.');
  }
  const quantity = BigInt(value.quantity);
  if (quantity > maximumSignedBigint) throw invalid('quantity exceeds signed 64-bit storage.');
  return { quantity };
};

export const parseAccessPurpose = (body: unknown): 'fulfillment_execution' => {
  const value = record(body);
  exact(value, ['purpose']);
  if (value.purpose !== 'fulfillment_execution') throw invalid('purpose is invalid.');
  return value.purpose;
};

export const parseEmptyBody = (body: unknown): void => {
  const value = record(body);
  exact(value, []);
};
