import { validate as isUuid } from 'uuid';

import { inventoryModes, rewardTypes } from '@creatordrop/contracts';

import { ApiError } from '../../http/errors.js';
import type { CreatorId } from '../creators/creator.js';
import { parseCreatorId } from '../creators/creator.schema.js';
import type {
  BoxId,
  BoxVersionId,
  BoxVersionRewardId,
  InventoryMode,
  InventoryQuantity,
  MoneyMinor,
  ProbabilityWeight,
  RewardId,
  RewardType,
  RewardVersionId,
} from './catalog.js';

export interface BoxDraftInput {
  readonly currency: string;
  readonly description: string;
  readonly imageUrl: string | null;
  readonly name: string;
  readonly priceMinor: MoneyMinor;
}

export interface RewardDraftInput {
  readonly declaredValueCurrency: string | null;
  readonly declaredValueMinor: MoneyMinor | null;
  readonly description: string;
  readonly imageUrl: string | null;
  readonly inventoryMode: InventoryMode;
  readonly inventoryQuantity: InventoryQuantity | null;
  readonly name: string;
  readonly rewardType: RewardType;
}

export interface DraftRewardConfigurationInput {
  readonly entries: readonly {
    readonly rewardVersionId: RewardVersionId;
    readonly weight: ProbabilityWeight;
  }[];
}

const positiveDecimalPattern = /^[1-9][0-9]*$/u;
const nonnegativeDecimalPattern = /^(0|[1-9][0-9]*)$/u;
const currencyPattern = /^[A-Z]{3}$/u;
const maximumSignedBigint = 9_223_372_036_854_775_807n;

const validationError = (
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): ApiError => new ApiError(400, 'VALIDATION_ERROR', message, details);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const requireRecord = (value: unknown): Record<string, unknown> => {
  if (!isRecord(value)) {
    throw validationError('The request body must be a JSON object.');
  }
  return value;
};

const rejectUnknownFields = (record: Record<string, unknown>, allowed: readonly string[]): void => {
  const unknownFields = Object.keys(record).filter((field) => !allowed.includes(field));
  if (unknownFields.length > 0) {
    throw validationError('The request contains unknown fields.', { unknownFields });
  }
};

const requireString = (record: Record<string, unknown>, field: string): string => {
  const value = record[field];
  if (typeof value !== 'string') {
    throw validationError(`${field} must be a string.`, { field });
  }
  return value;
};

const limitedString = (
  record: Record<string, unknown>,
  field: string,
  minimum: number,
  maximum: number,
): string => {
  const value = requireString(record, field).trim();
  if (value.length < minimum || value.length > maximum) {
    throw validationError(
      `${field} must contain between ${minimum.toString()} and ${maximum.toString()} characters.`,
      { field },
    );
  }
  return value;
};

const optionalHttpsUrl = (record: Record<string, unknown>): string | null => {
  const value = record.imageUrl;
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > 2048) {
    throw validationError('imageUrl must be null or an HTTPS URL.', { field: 'imageUrl' });
  }
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username.length > 0 || url.password.length > 0) {
      throw new Error('Invalid HTTPS URL.');
    }
    return url.toString();
  } catch {
    throw validationError('imageUrl must be null or an HTTPS URL.', { field: 'imageUrl' });
  }
};

const parseBigint = (value: unknown, field: string, pattern: RegExp): bigint => {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw validationError(`${field} must be a canonical decimal integer string.`, { field });
  }
  const parsed = BigInt(value);
  if (parsed > maximumSignedBigint) {
    throw validationError(`${field} exceeds signed 64-bit storage.`, { field });
  }
  return parsed;
};

const parseUuid = (value: string | undefined, field: string): string => {
  if (value === undefined || !isUuid(value)) {
    throw validationError(`${field} must be a UUID.`, { field });
  }
  return value;
};

export const parseBoxId = (value: string | undefined): BoxId => parseUuid(value, 'boxId') as BoxId;
export const parseBoxVersionId = (value: string | undefined): BoxVersionId =>
  parseUuid(value, 'versionId') as BoxVersionId;
export const parseBoxVersionRewardId = (value: string | undefined): BoxVersionRewardId =>
  parseUuid(value, 'boxVersionRewardId') as BoxVersionRewardId;
export const parseRewardId = (value: string | undefined): RewardId =>
  parseUuid(value, 'rewardId') as RewardId;
export const parseRewardVersionId = (value: string | undefined): RewardVersionId =>
  parseUuid(value, 'rewardVersionId') as RewardVersionId;
export const parseCatalogCreatorId = (value: string | undefined): CreatorId =>
  parseCreatorId(value);

export const parseBoxDraftInput = (body: unknown): BoxDraftInput => {
  const record = requireRecord(body);
  rejectUnknownFields(record, ['currency', 'description', 'imageUrl', 'name', 'priceMinor']);
  const currency = requireString(record, 'currency');
  if (!currencyPattern.test(currency)) {
    throw validationError('currency must be three uppercase letters.', { field: 'currency' });
  }
  return {
    currency,
    description: limitedString(record, 'description', 0, 5000),
    imageUrl: optionalHttpsUrl(record),
    name: limitedString(record, 'name', 1, 120),
    priceMinor: parseBigint(record.priceMinor, 'priceMinor', positiveDecimalPattern) as MoneyMinor,
  };
};

export const parseRewardDraftInput = (body: unknown): RewardDraftInput => {
  const record = requireRecord(body);
  rejectUnknownFields(record, [
    'declaredValueCurrency',
    'declaredValueMinor',
    'description',
    'imageUrl',
    'inventoryMode',
    'inventoryQuantity',
    'name',
    'rewardType',
  ]);
  const inventoryMode = record.inventoryMode;
  const rewardType = record.rewardType;
  if (
    typeof inventoryMode !== 'string' ||
    !inventoryModes.includes(inventoryMode as InventoryMode)
  ) {
    throw validationError('inventoryMode must be unlimited or finite.', {
      field: 'inventoryMode',
    });
  }
  if (typeof rewardType !== 'string' || !rewardTypes.includes(rewardType as RewardType)) {
    throw validationError('rewardType must be digital, physical, or experience.', {
      field: 'rewardType',
    });
  }

  const inventoryQuantity =
    inventoryMode === 'finite'
      ? (parseBigint(
          record.inventoryQuantity,
          'inventoryQuantity',
          nonnegativeDecimalPattern,
        ) as InventoryQuantity)
      : null;
  if (inventoryMode === 'unlimited' && record.inventoryQuantity != null) {
    throw validationError('Unlimited rewards must not specify inventoryQuantity.', {
      field: 'inventoryQuantity',
    });
  }

  const declaredValueMinor =
    record.declaredValueMinor == null
      ? null
      : (parseBigint(
          record.declaredValueMinor,
          'declaredValueMinor',
          nonnegativeDecimalPattern,
        ) as MoneyMinor);
  const declaredValueCurrency = record.declaredValueCurrency;
  if (
    (declaredValueMinor === null && declaredValueCurrency != null) ||
    (declaredValueMinor !== null &&
      (typeof declaredValueCurrency !== 'string' || !currencyPattern.test(declaredValueCurrency)))
  ) {
    throw validationError('Declared value requires both a decimal amount and uppercase currency.', {
      field: 'declaredValueCurrency',
    });
  }

  return {
    declaredValueCurrency: typeof declaredValueCurrency === 'string' ? declaredValueCurrency : null,
    declaredValueMinor,
    description: limitedString(record, 'description', 0, 5000),
    imageUrl: optionalHttpsUrl(record),
    inventoryMode: inventoryMode as InventoryMode,
    inventoryQuantity,
    name: limitedString(record, 'name', 1, 120),
    rewardType: rewardType as RewardType,
  };
};

export const parseDraftRewardConfiguration = (body: unknown): DraftRewardConfigurationInput => {
  const record = requireRecord(body);
  rejectUnknownFields(record, ['entries']);
  if (!Array.isArray(record.entries) || record.entries.length > 1000) {
    throw validationError('entries must be an array containing at most 1000 rewards.', {
      field: 'entries',
    });
  }
  const seen = new Set<string>();
  const entries = record.entries.map((value, position) => {
    const entry = requireRecord(value);
    rejectUnknownFields(entry, ['rewardVersionId', 'weight']);
    const rewardVersionId = parseRewardVersionId(
      typeof entry.rewardVersionId === 'string' ? entry.rewardVersionId : undefined,
    );
    if (seen.has(rewardVersionId)) {
      throw validationError('A reward version may appear only once in a box draft.', {
        field: `entries[${position.toString()}].rewardVersionId`,
      });
    }
    seen.add(rewardVersionId);
    return {
      rewardVersionId,
      weight: parseBigint(entry.weight, 'weight', positiveDecimalPattern) as ProbabilityWeight,
    };
  });
  return { entries };
};

export const parseExpectedCatalogRevision = (value: string | undefined): number => {
  if (value === undefined) {
    throw new ApiError(428, 'PRECONDITION_REQUIRED', 'A quoted If-Match revision is required.');
  }
  const match = /^"(?<revision>[1-9][0-9]*)"$/u.exec(value);
  const revision =
    match?.groups?.revision === undefined ? Number.NaN : Number(match.groups.revision);
  if (!Number.isSafeInteger(revision) || revision < 1 || revision > 2_147_483_647) {
    throw validationError('If-Match must contain one quoted positive revision.', {
      field: 'If-Match',
    });
  }
  return revision;
};
