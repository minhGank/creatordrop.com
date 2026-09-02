import { validate as isUuid } from 'uuid';

import type { RedisJsonCache } from '@creatordrop/redis-projections';

import { hashPublishedManifest } from './catalog.manifest.js';
import type {
  BoxVersion,
  BoxVersionRewardId,
  DraftRewardEntry,
  PublishedManifest,
  RewardVersion,
  RewardVersionId,
} from './catalog.js';
import type { PublishedCatalogVersion } from './catalog.service.js';

export interface CatalogCache {
  readonly redis: RedisJsonCache;
  readonly ttlSeconds: number;
}

export interface CatalogCacheIdentity {
  readonly boxId: string;
  readonly versionId?: string;
}

const decimalPattern = /^(?:0|[1-9][0-9]{0,18})$/u;
const currencyPattern = /^[A-Z]{3}$/u;
const hashPattern = /^[0-9a-f]{64}$/u;

const record = (
  value: unknown,
  keys: readonly string[],
  label: string,
): Readonly<Record<string, unknown>> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Redis returned invalid ${label}.`);
  }
  const result = value as Readonly<Record<string, unknown>>;
  const actual = Object.keys(result).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`Redis returned invalid ${label} fields.`);
  }
  return result;
};

const string = (value: unknown, label: string): string => {
  if (typeof value !== 'string') throw new Error(`Redis returned invalid ${label}.`);
  return value;
};
const nullableString = (value: unknown, label: string): string | null =>
  value === null ? null : string(value, label);
const integer = (value: unknown, label: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`Redis returned invalid ${label}.`);
  }
  return value;
};
const uuid = (value: unknown, label: string): string => {
  const result = string(value, label);
  if (!isUuid(result) || result !== result.toLowerCase()) {
    throw new Error(`Redis returned noncanonical ${label}.`);
  }
  return result;
};
const canonicalRequestedUuid = (value: string, label: string): string => {
  if (!isUuid(value)) throw new Error(`Invalid requested ${label}.`);
  return value.toLowerCase();
};
const timestamp = (value: unknown, label: string): string => {
  const result = string(value, label);
  const parsed = new Date(result);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== result) {
    throw new Error(`Redis returned invalid ${label}.`);
  }
  return result;
};
const nullableTimestamp = (value: unknown, label: string): string | null =>
  value === null ? null : timestamp(value, label);
const decimal = (value: unknown, label: string): string => {
  const result = string(value, label);
  if (!decimalPattern.test(result)) throw new Error(`Redis returned invalid ${label}.`);
  return result;
};
const currency = (value: unknown, label: string): string => {
  const result = string(value, label);
  if (!currencyPattern.test(result)) throw new Error(`Redis returned invalid ${label}.`);
  return result;
};
const nullableDecimal = (value: unknown, label: string): string | null =>
  value === null ? null : decimal(value, label);
const oneOf = <T extends string>(value: unknown, values: readonly T[], label: string): T => {
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw new Error(`Redis returned invalid ${label}.`);
  }
  return value as T;
};

const boxVersion = (value: unknown): BoxVersion => {
  const row = record(
    value,
    [
      'configurationHash',
      'createdAt',
      'currency',
      'description',
      'id',
      'imageUrl',
      'name',
      'openingCompatibilityVersion',
      'priceMinor',
      'publishedAt',
      'rngAlgorithmVersion',
      'state',
      'totalWeight',
      'updatedAt',
      'versionNumber',
    ],
    'box version',
  );
  return {
    configurationHash: nullableString(row.configurationHash, 'configuration hash'),
    createdAt: timestamp(row.createdAt, 'box version created timestamp'),
    currency: currency(row.currency, 'box currency'),
    description: string(row.description, 'box description'),
    id: uuid(row.id, 'box version ID') as BoxVersion['id'],
    imageUrl: nullableString(row.imageUrl, 'box image URL'),
    name: string(row.name, 'box name'),
    openingCompatibilityVersion:
      row.openingCompatibilityVersion === null
        ? null
        : oneOf(row.openingCompatibilityVersion, ['opening-v1'] as const, 'compatibility version'),
    priceMinor: decimal(row.priceMinor, 'box price'),
    publishedAt: nullableTimestamp(row.publishedAt, 'publication timestamp'),
    rngAlgorithmVersion: nullableString(row.rngAlgorithmVersion, 'RNG version'),
    state: oneOf(row.state, ['draft', 'published', 'retired'] as const, 'box version state'),
    totalWeight: nullableDecimal(row.totalWeight, 'total weight'),
    updatedAt: timestamp(row.updatedAt, 'box version updated timestamp'),
    versionNumber: integer(row.versionNumber, 'box version number'),
  };
};

const rewardVersion = (value: unknown): RewardVersion => {
  const row = record(
    value,
    [
      'createdAt',
      'declaredValueCurrency',
      'declaredValueMinor',
      'description',
      'id',
      'imageUrl',
      'inventoryMode',
      'inventoryQuantity',
      'inventoryStockoutPolicy',
      'name',
      'publishedAt',
      'rewardType',
      'state',
      'updatedAt',
      'versionNumber',
    ],
    'reward version',
  );
  const inventoryMode = oneOf(
    row.inventoryMode,
    ['finite', 'unlimited'] as const,
    'inventory mode',
  );
  return {
    createdAt: timestamp(row.createdAt, 'reward version created timestamp'),
    declaredValueCurrency:
      row.declaredValueCurrency === null
        ? null
        : currency(row.declaredValueCurrency, 'declared value currency'),
    declaredValueMinor: nullableDecimal(row.declaredValueMinor, 'declared value'),
    description: string(row.description, 'reward description'),
    id: uuid(row.id, 'reward version ID') as RewardVersionId,
    imageUrl: nullableString(row.imageUrl, 'reward image URL'),
    inventoryMode,
    inventoryQuantity: nullableDecimal(row.inventoryQuantity, 'inventory quantity'),
    inventoryStockoutPolicy:
      row.inventoryStockoutPolicy === null
        ? null
        : oneOf(
            row.inventoryStockoutPolicy,
            ['backorder', 'pause_box'] as const,
            'inventory stockout policy',
          ),
    name: string(row.name, 'reward name'),
    publishedAt: nullableTimestamp(row.publishedAt, 'reward publication timestamp'),
    rewardType: oneOf(
      row.rewardType,
      ['digital', 'experience', 'physical'] as const,
      'reward type',
    ),
    state: oneOf(row.state, ['draft', 'published', 'retired'] as const, 'reward state'),
    updatedAt: timestamp(row.updatedAt, 'reward version updated timestamp'),
    versionNumber: integer(row.versionNumber, 'reward version number'),
  };
};

const draftEntry = (value: unknown): DraftRewardEntry => {
  const row = record(
    value,
    ['id', 'isBaseReward', 'position', 'rewardVersion', 'weight'],
    'catalog entry',
  );
  if (typeof row.isBaseReward !== 'boolean') throw new Error('Redis returned invalid base flag.');
  return {
    id: uuid(row.id, 'entry ID') as BoxVersionRewardId,
    isBaseReward: row.isBaseReward,
    position: integer(row.position, 'entry position'),
    rewardVersion: rewardVersion(row.rewardVersion),
    weight: decimal(row.weight, 'entry weight'),
  };
};

const manifest = (value: unknown): PublishedManifest => {
  const row = record(
    value,
    [
      'algorithmVersion',
      'boxId',
      'boxVersionId',
      'currency',
      'entries',
      'priceMinor',
      'totalWeight',
    ],
    'published manifest',
  );
  if (!Array.isArray(row.entries)) throw new Error('Redis returned invalid manifest entries.');
  return {
    algorithmVersion: oneOf(
      row.algorithmVersion,
      ['hmac-sha256-rejection-v1'] as const,
      'RNG algorithm version',
    ),
    boxId: uuid(row.boxId, 'box ID'),
    boxVersionId: uuid(row.boxVersionId, 'box version ID'),
    currency: currency(row.currency, 'manifest currency'),
    entries: row.entries.map((item) => {
      const entry = record(
        item,
        ['boxVersionRewardId', 'position', 'rewardVersionId', 'weight'],
        'manifest entry',
      );
      return {
        boxVersionRewardId: uuid(entry.boxVersionRewardId, 'manifest entry ID'),
        position: integer(entry.position, 'manifest position'),
        rewardVersionId: uuid(entry.rewardVersionId, 'manifest reward version ID'),
        weight: decimal(entry.weight, 'manifest weight'),
      };
    }),
    priceMinor: decimal(row.priceMinor, 'manifest price'),
    totalWeight: decimal(row.totalWeight, 'manifest total weight'),
  };
};

export const parseCachedPublishedCatalog = (
  value: unknown,
  identity: CatalogCacheIdentity,
): PublishedCatalogVersion => {
  const row = record(value, ['configurationHash', 'entries', 'manifest', 'version'], 'catalog');
  if (!Array.isArray(row.entries)) throw new Error('Redis returned invalid catalog entries.');
  const result = {
    configurationHash: string(row.configurationHash, 'catalog configuration hash'),
    entries: row.entries.map(draftEntry),
    manifest: manifest(row.manifest),
    version: boxVersion(row.version),
  };
  const expectedBoxId = canonicalRequestedUuid(identity.boxId, 'box ID');
  const expectedVersionId =
    identity.versionId === undefined
      ? undefined
      : canonicalRequestedUuid(identity.versionId, 'box version ID');
  if (
    !hashPattern.test(result.configurationHash) ||
    result.version.state !== 'published' ||
    result.version.configurationHash !== result.configurationHash ||
    result.version.id !== result.manifest.boxVersionId ||
    result.version.priceMinor !== result.manifest.priceMinor ||
    result.version.totalWeight !== result.manifest.totalWeight ||
    result.version.rngAlgorithmVersion !== result.manifest.algorithmVersion ||
    result.manifest.boxId !== expectedBoxId ||
    (expectedVersionId !== undefined && result.version.id !== expectedVersionId) ||
    hashPublishedManifest(result.manifest) !== result.configurationHash ||
    result.entries.length !== result.manifest.entries.length ||
    result.entries.some((item, index) => {
      const canonical = result.manifest.entries[index];
      return (
        item.id !== canonical?.boxVersionRewardId ||
        item.position !== canonical.position ||
        item.rewardVersion.id !== canonical.rewardVersionId ||
        item.weight !== canonical.weight
      );
    })
  ) {
    throw new Error('Redis catalog does not match its immutable manifest.');
  }
  return result;
};
