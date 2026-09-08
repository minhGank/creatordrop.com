import {
  openingProgressionSchema,
  xpRewardSchema,
  type ProgressionResponse,
} from '@creatordrop/contracts';
import { createHash } from 'node:crypto';

import { validate as isUuid, v7 as uuidv7 } from 'uuid';

import type { Database, TransactionExecutor } from '@creatordrop/database';
import type { OpeningV2EntitlementStateResponse } from '@creatordrop/contracts';
import { parseCurrency, parsePositiveMoneyMinor, toMoneyMinor } from '@creatordrop/domain';
import type { Currency, MoneyMinor } from '@creatordrop/domain';
import type { Logger } from '@creatordrop/observability';

import {
  createOpeningV2PublishedManifest,
  createPublishedManifest,
} from '../catalog/catalog.manifest.js';
import {
  rarityPolicyVersions,
  rewardRarities,
  type BoxId,
  type BoxVersionId,
  type MoneyMinor as CatalogMoneyMinor,
  type ProbabilityWeight,
} from '../catalog/catalog.js';
import type { UserId } from '../creators/creator.js';
import type { FairnessService } from '../fairness/fairness.service.js';
import type { ClientSeed, RngSeedSetId } from '../fairness/fairness.js';
import {
  unrestrictedCreatorOpeningCapacity,
  type CreatorOpeningCapacity,
} from '../usage/creator-opening-capacity.js';
import { IdempotencyKeyReusedError } from '../wallet/wallet.errors.js';
import {
  claimBoxOpeningIdempotency,
  completeBoxOpeningIdempotency,
  lockBoxOpeningWallet,
  postBoxOpeningFinancials,
} from '../wallet/wallet.service.js';
import { toPublicWallet, type IdempotencyRecordId } from '../wallet/wallet.js';
import {
  BoxNotOpenableError,
  InventoryUnavailableError,
  OpeningConfirmationStaleError,
  OpeningCurrencyUnavailableError,
  OpeningEntitlementRequiredError,
  OpeningLimitReachedError,
  OpeningRetryableError,
} from './opening.errors.js';
import {
  consumeOpeningInventoryPool,
  consumeOpeningV2Entitlement,
  findOpeningCatalog,
  insertOpeningHistory,
  insertOpeningV2History,
  lockLeaderboardSeasonForOpening,
  lockCurrentBoxForOpening,
  lockOpeningInventoryPool,
  pauseBoxesForInventoryPool,
  readOpeningDatabaseTimestamp,
  readOpeningV2EntitlementState,
  readProgression,
  readOpeningProgression,
  type OpeningCatalog,
  type OpeningCatalogEntry,
} from './opening.repository.js';
import type { BoxOpeningBody, FulfillmentStatus, OpeningId } from './opening.js';

const openingOperation = 'box.open';
const openingStatusCode = 201;
const defaultPlatformFeeBps = 2000;
const defaultEarningsHoldMs = 14 * 24 * 60 * 60 * 1000;

export interface OpenBoxCommand {
  readonly boxId: BoxId;
  readonly clientSeed: ClientSeed;
  readonly expectedBoxVersionId: BoxVersionId;
  readonly expectedConfigurationHash: string;
  readonly expectedSeedSetId: RngSeedSetId;
  readonly expectedServerSeedCommitment: string;
  readonly idempotencyKey: string;
  readonly requestId: string;
  readonly userId: UserId;
}

export interface OpenBoxResult {
  readonly body: BoxOpeningBody;
  readonly replayed: boolean;
  readonly statusCode: number;
}

export interface OpeningService {
  getProgression(userId: UserId): Promise<ProgressionResponse>;
  getEntitlementState(command: {
    readonly boxId: BoxId;
    readonly userId: UserId;
  }): Promise<OpeningV2EntitlementStateResponse>;
  openBox(command: OpenBoxCommand): Promise<OpenBoxResult>;
}

export interface OpeningServiceOptions {
  /** Explicit opt-in for legacy regression tooling, never configured by active startup. */
  readonly allowLegacyPaidOpenings?: boolean;
  readonly createId?: () => string;
  readonly creatorOpeningCapacity?: CreatorOpeningCapacity;
  readonly database: Database;
  readonly earningsHoldMs?: number;
  readonly enabledCurrencies?: readonly Currency[];
  readonly fairnessService: Pick<FairnessService, 'selectForOpening'>;
  readonly logger: Logger;
  readonly platformFeeBps?: number;
}

const databaseCode = (error: unknown): string | undefined =>
  typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;

const exactKeys = (value: Record<string, unknown>, expected: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
};

const record = (
  value: unknown,
  expected: readonly string[],
  label: string,
): Record<string, unknown> => {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    !exactKeys(value as Record<string, unknown>, expected)
  ) {
    throw new Error(`Stored ${label} has an invalid shape.`);
  }
  return value as Record<string, unknown>;
};

const stringValue = (value: unknown, label: string): string => {
  if (typeof value !== 'string') throw new Error(`Stored ${label} is invalid.`);
  return value;
};

const uuidValue = (value: unknown, label: string): string => {
  const parsed = stringValue(value, label);
  if (!isUuid(parsed) || parsed !== parsed.toLowerCase()) {
    throw new Error(`Stored ${label} is invalid.`);
  }
  return parsed;
};

const decimalValue = (value: unknown, label: string): string => {
  const parsed = stringValue(value, label);
  if (!/^(0|[1-9][0-9]*)$/u.test(parsed)) throw new Error(`Stored ${label} is invalid.`);
  return parsed;
};

const storedOpeningBody = (value: unknown): BoxOpeningBody => {
  const root = record(value, ['opening'], 'opening response');
  if (
    typeof root.opening === 'object' &&
    root.opening !== null &&
    !Array.isArray(root.opening) &&
    (root.opening as Record<string, unknown>).openingCompatibilityVersion === 'opening-v2'
  ) {
    const opening = record(
      root.opening,
      [
        'boxId',
        'boxVersionId',
        'entitlement',
        'fairness',
        'fulfillmentStatus',
        'id',
        'openingCompatibilityVersion',
        'reward',
        ...('progression' in root.opening ? ['progression'] : []),
      ],
      'opening-v2',
    );
    const entitlement = record(
      opening.entitlement,
      [
        'maxOpeningsPerUser',
        'remaining',
        'successfulOpenings',
        ...(typeof opening.entitlement === 'object' &&
        opening.entitlement !== null &&
        'source' in opening.entitlement
          ? ['source', 'universalEntriesRemaining']
          : []),
      ],
      'opening entitlement',
    );
    const fairness = record(
      opening.fairness,
      ['clientSeed', 'commitment', 'configurationHash', 'nonce', 'seedSetId'],
      'opening fairness proof',
    );
    const reward = record(
      opening.reward,
      [
        'id',
        'imageUrl',
        'name',
        'rarity',
        'rarityPolicyVersion',
        'rewardVersionId',
        ...(typeof opening.reward === 'object' &&
        opening.reward !== null &&
        'xpReward' in opening.reward
          ? ['xpReward']
          : []),
      ],
      'opening reward',
    );
    const fulfillmentStatus = opening.fulfillmentStatus;
    const rarity = reward.rarity;
    const rarityPolicyVersion = reward.rarityPolicyVersion;
    const clientSeed = stringValue(fairness.clientSeed, 'opening client seed');
    const commitment = stringValue(fairness.commitment, 'opening commitment');
    const configurationHash = stringValue(fairness.configurationHash, 'configuration hash');
    if (
      (fulfillmentStatus !== 'pending_fulfillment' &&
        fulfillmentStatus !== 'awaiting_restock' &&
        fulfillmentStatus !== 'not_required') ||
      (reward.imageUrl !== null && typeof reward.imageUrl !== 'string') ||
      !rewardRarities.includes(rarity as (typeof rewardRarities)[number]) ||
      rarityPolicyVersion !== 'rarity-v1' ||
      !/^[0-9a-f]{64}$/u.test(clientSeed) ||
      !/^[0-9a-f]{64}$/u.test(commitment) ||
      !/^[0-9a-f]{64}$/u.test(configurationHash)
    ) {
      throw new Error('Stored opening-v2 response contains invalid values.');
    }
    return {
      opening: {
        boxId: uuidValue(opening.boxId, 'opening box ID'),
        boxVersionId: uuidValue(opening.boxVersionId, 'opening box version ID'),
        entitlement: {
          ...(entitlement.source === undefined
            ? {}
            : {
                source: (() => {
                  if (entitlement.source !== 'creator' && entitlement.source !== 'universal')
                    throw new Error('Stored entitlement source invalid.');
                  return entitlement.source;
                })(),
                universalEntriesRemaining: decimalValue(
                  entitlement.universalEntriesRemaining,
                  'Universal Entries',
                ),
              }),
          maxOpeningsPerUser: decimalValue(
            entitlement.maxOpeningsPerUser,
            'maximum openings per user',
          ),
          remaining: decimalValue(entitlement.remaining, 'remaining entitlements'),
          successfulOpenings: decimalValue(entitlement.successfulOpenings, 'successful openings'),
        },
        fairness: {
          clientSeed,
          commitment,
          configurationHash,
          nonce: decimalValue(fairness.nonce, 'opening nonce'),
          seedSetId: uuidValue(fairness.seedSetId, 'opening seed-set ID'),
        },
        fulfillmentStatus,
        id: uuidValue(opening.id, 'public opening ID'),
        openingCompatibilityVersion: 'opening-v2',
        ...(opening.progression === undefined
          ? {}
          : { progression: openingProgressionSchema.parse(opening.progression) }),
        reward: {
          ...(reward.xpReward === undefined
            ? {}
            : { xpReward: xpRewardSchema.parse(reward.xpReward) }),
          id: uuidValue(reward.id, 'opening reward ID'),
          imageUrl: reward.imageUrl,
          name: stringValue(reward.name, 'opening reward name'),
          rarity: rarity as (typeof rewardRarities)[number],
          rarityPolicyVersion: 'rarity-v1',
          rewardVersionId: uuidValue(reward.rewardVersionId, 'opening reward version ID'),
        },
      },
    };
  }
  const opening = record(
    root.opening,
    [
      'boxId',
      'boxVersionId',
      'cost',
      'fairness',
      'fulfillmentStatus',
      'id',
      'pointsAwarded',
      'reward',
      'wallet',
    ],
    'opening',
  );
  const cost = record(opening.cost, ['currency', 'priceMinor'], 'opening cost');
  const fairness = record(
    opening.fairness,
    ['clientSeed', 'commitment', 'configurationHash', 'nonce', 'seedSetId'],
    'opening fairness proof',
  );
  const rewardValue = opening.reward;
  if (typeof rewardValue !== 'object' || rewardValue === null || Array.isArray(rewardValue)) {
    throw new Error('Stored opening reward has an invalid shape.');
  }
  const reward = rewardValue as Record<string, unknown>;
  const currentRewardShape = exactKeys(reward, [
    'id',
    'imageUrl',
    'name',
    'rarity',
    'rarityPolicyVersion',
    'rewardVersionId',
  ]);
  const legacyRewardShape = exactKeys(reward, ['id', 'imageUrl', 'name', 'rewardVersionId']);
  if (!currentRewardShape && !legacyRewardShape) {
    throw new Error('Stored opening reward has an invalid shape.');
  }
  const wallet = record(
    opening.wallet,
    ['balanceMinor', 'currency', 'id', 'revision'],
    'opening wallet',
  );
  const fulfillmentStatus = opening.fulfillmentStatus;
  const pointsAwarded = opening.pointsAwarded;
  const rarity = legacyRewardShape ? null : reward.rarity;
  const rarityPolicyVersion = legacyRewardShape ? null : reward.rarityPolicyVersion;
  if (
    (fulfillmentStatus !== 'pending_fulfillment' && fulfillmentStatus !== 'awaiting_restock') ||
    (pointsAwarded !== 5 && pointsAwarded !== 20) ||
    (reward.imageUrl !== null && typeof reward.imageUrl !== 'string') ||
    (rarity !== null && !rewardRarities.includes(rarity as (typeof rewardRarities)[number])) ||
    (rarityPolicyVersion !== null &&
      !rarityPolicyVersions.includes(
        rarityPolicyVersion as (typeof rarityPolicyVersions)[number],
      )) ||
    (rarity === null) !== (rarityPolicyVersion === null)
  ) {
    throw new Error('Stored opening response contains invalid values.');
  }
  const clientSeed = stringValue(fairness.clientSeed, 'opening client seed');
  const commitment = stringValue(fairness.commitment, 'opening commitment');
  const configurationHash = stringValue(fairness.configurationHash, 'configuration hash');
  if (
    !/^[0-9a-f]{64}$/u.test(clientSeed) ||
    !/^[0-9a-f]{64}$/u.test(commitment) ||
    !/^[0-9a-f]{64}$/u.test(configurationHash)
  ) {
    throw new Error('Stored opening fairness proof contains invalid values.');
  }
  return {
    opening: {
      boxId: uuidValue(opening.boxId, 'opening box ID'),
      boxVersionId: uuidValue(opening.boxVersionId, 'opening box version ID'),
      cost: {
        currency: parseCurrency(cost.currency),
        priceMinor: decimalValue(cost.priceMinor, 'opening price'),
      },
      fairness: {
        clientSeed,
        commitment,
        configurationHash,
        nonce: decimalValue(fairness.nonce, 'opening nonce'),
        seedSetId: uuidValue(fairness.seedSetId, 'opening seed-set ID'),
      },
      fulfillmentStatus,
      id: uuidValue(opening.id, 'public opening ID'),
      pointsAwarded,
      reward: {
        id: uuidValue(reward.id, 'opening reward ID'),
        imageUrl: reward.imageUrl,
        name: stringValue(reward.name, 'opening reward name'),
        rarity: rarity as BoxOpeningBody['opening']['reward']['rarity'],
        rarityPolicyVersion:
          rarityPolicyVersion as BoxOpeningBody['opening']['reward']['rarityPolicyVersion'],
        rewardVersionId: uuidValue(reward.rewardVersionId, 'opening reward version ID'),
      },
      wallet: {
        balanceMinor: decimalValue(wallet.balanceMinor, 'wallet balance'),
        currency: parseCurrency(wallet.currency),
        id: uuidValue(wallet.id, 'wallet ID'),
        revision: decimalValue(wallet.revision, 'wallet revision'),
      },
    },
  };
};

export const calculateOpeningFinancialSplit = (
  grossPriceMinor: bigint,
  platformFeeBps: number,
): { readonly creatorShareMinor: MoneyMinor; readonly platformFeeMinor: MoneyMinor } => {
  if (
    grossPriceMinor <= 0n ||
    !Number.isSafeInteger(platformFeeBps) ||
    platformFeeBps < 0 ||
    platformFeeBps >= 10_000
  ) {
    throw new Error('The opening financial policy is invalid.');
  }
  const platformFeeMinor = (grossPriceMinor * BigInt(platformFeeBps)) / 10_000n;
  return {
    creatorShareMinor: toMoneyMinor(grossPriceMinor - platformFeeMinor),
    platformFeeMinor: toMoneyMinor(platformFeeMinor),
  };
};

export const calculateOpeningPoints = (isBaseReward: boolean): 5 | 20 => (isBaseReward ? 20 : 5);

export const buildOpeningFingerprint = (input: {
  readonly boxId: BoxId;
  readonly clientSeed: ClientSeed;
  readonly expectedBoxVersionId: BoxVersionId;
  readonly expectedConfigurationHash: string;
  readonly expectedSeedSetId: RngSeedSetId;
  readonly expectedServerSeedCommitment: string;
  readonly userId: UserId;
}): string =>
  createHash('sha256')
    .update(
      `creatordrop:idempotency:v3|${openingOperation}|${input.userId}|${input.boxId}|${input.clientSeed}|${input.expectedBoxVersionId}|${input.expectedConfigurationHash}|${input.expectedSeedSetId}|${input.expectedServerSeedCommitment}`,
      'utf8',
    )
    .digest('hex');

const buildVersionTwoOpeningFingerprint = (input: {
  readonly boxId: BoxId;
  readonly clientSeed: ClientSeed;
  readonly expectedBoxVersionId: BoxVersionId;
  readonly expectedConfigurationHash: string;
  readonly userId: UserId;
}): string =>
  createHash('sha256')
    .update(
      `creatordrop:idempotency:v2|${openingOperation}|${input.userId}|${input.boxId}|${input.clientSeed}|${input.expectedBoxVersionId}|${input.expectedConfigurationHash}`,
      'utf8',
    )
    .digest('hex');

const buildLegacyOpeningFingerprint = (input: {
  readonly boxId: BoxId;
  readonly clientSeed: ClientSeed;
  readonly userId: UserId;
}): string =>
  createHash('sha256')
    .update(
      `creatordrop:idempotency:v1|${openingOperation}|${input.userId}|${input.boxId}|${input.clientSeed}`,
      'utf8',
    )
    .digest('hex');

const generatedUuid = (createId: () => string, label: string): string => {
  const value = createId();
  if (!isUuid(value) || value !== value.toLowerCase()) {
    throw new Error(`${label} generator returned a noncanonical UUID.`);
  }
  return value;
};

type OpeningV1Catalog = Omit<
  OpeningCatalog,
  'currency' | 'maxOpeningsPerUser' | 'openingCompatibilityVersion' | 'priceMinor'
> & {
  readonly currency: Currency;
  readonly maxOpeningsPerUser: null;
  readonly openingCompatibilityVersion: 'opening-v1';
  readonly priceMinor: MoneyMinor;
};

type OpeningV2Catalog = Omit<
  OpeningCatalog,
  'currency' | 'entries' | 'maxOpeningsPerUser' | 'openingCompatibilityVersion' | 'priceMinor'
> & {
  readonly currency: null;
  readonly entries: readonly (OpeningCatalogEntry & {
    readonly isBaseReward: false;
    readonly rarity: (typeof rewardRarities)[number];
    readonly rarityPolicyVersion: 'rarity-v1';
  })[];
  readonly maxOpeningsPerUser: string;
  readonly openingCompatibilityVersion: 'opening-v2';
  readonly priceMinor: null;
};

const requireOpeningCatalog = (
  catalog: OpeningCatalog | undefined,
): OpeningV1Catalog | OpeningV2Catalog => {
  if (catalog?.boxStatus !== 'active' || catalog.entries.length === 0) {
    throw new BoxNotOpenableError();
  }
  if (
    catalog.openingCompatibilityVersion === 'opening-v1' &&
    catalog.currency !== null &&
    catalog.priceMinor !== null &&
    catalog.maxOpeningsPerUser === null &&
    catalog.entries.filter(({ isBaseReward }) => isBaseReward).length === 1
  ) {
    return catalog as OpeningV1Catalog;
  }
  if (
    catalog.openingCompatibilityVersion === 'opening-v2' &&
    catalog.currency === null &&
    catalog.priceMinor === null &&
    catalog.maxOpeningsPerUser !== null &&
    catalog.entries.every(
      ({ isBaseReward, rarity, rarityPolicyVersion }) =>
        !isBaseReward && rarity !== null && rarityPolicyVersion === 'rarity-v1',
    )
  ) {
    return catalog as OpeningV2Catalog;
  }
  throw new BoxNotOpenableError();
};

const openingManifest = (catalog: OpeningV1Catalog | OpeningV2Catalog) =>
  catalog.openingCompatibilityVersion === 'opening-v2'
    ? createOpeningV2PublishedManifest({
        boxId: catalog.boxId,
        boxVersionId: catalog.boxVersionId,
        entries: catalog.entries.map((entry) => ({
          id: entry.id,
          position: entry.position,
          rarity: entry.rarity,
          ...(entry.xpReward === undefined ? {} : { xpReward: entry.xpReward }),
          rewardVersionId: entry.rewardVersionId,
          weight: BigInt(entry.weight) as ProbabilityWeight,
        })),
        maxOpeningsPerUser: BigInt(catalog.maxOpeningsPerUser),
      })
    : createPublishedManifest({
        boxId: catalog.boxId,
        boxVersionId: catalog.boxVersionId,
        currency: catalog.currency,
        entries: catalog.entries.map((entry) => ({
          id: entry.id,
          position: entry.position,
          rewardVersionId: entry.rewardVersionId,
          weight: BigInt(entry.weight) as ProbabilityWeight,
        })),
        priceMinor: BigInt(catalog.priceMinor.toString()) as CatalogMoneyMinor,
      });

const retryableTransaction = async <Result>(
  database: Database,
  operation: (
    transaction: TransactionExecutor,
    markSelectionStarted: () => void,
  ) => Promise<Result>,
): Promise<Result> => {
  let attempt = 0;
  for (;;) {
    const attemptState: { selectionStarted: boolean } = { selectionStarted: false };
    try {
      return await database.transaction((transaction) =>
        operation(transaction, () => {
          attemptState.selectionStarted = true;
        }),
      );
    } catch (error) {
      if (!['40001', '40P01'].includes(databaseCode(error) ?? '')) throw error;
      if (attemptState.selectionStarted || attempt >= 2) throw new OpeningRetryableError();
      attempt += 1;
    }
  }
};

export const createOpeningService = ({
  allowLegacyPaidOpenings = false,
  createId = uuidv7,
  creatorOpeningCapacity = unrestrictedCreatorOpeningCapacity,
  database,
  earningsHoldMs = defaultEarningsHoldMs,
  enabledCurrencies = [parseCurrency('USD')],
  fairnessService,
  logger,
  platformFeeBps = defaultPlatformFeeBps,
}: OpeningServiceOptions): OpeningService => {
  if (!Number.isSafeInteger(earningsHoldMs) || earningsHoldMs < 0) {
    throw new Error('The creator earnings hold policy is invalid.');
  }
  calculateOpeningFinancialSplit(1n, platformFeeBps);

  return {
    getProgression: async (userId) => ({ progression: await readProgression(database, userId) }),
    getEntitlementState: async ({ boxId, userId }) => {
      const entitlement = await readOpeningV2EntitlementState(database, userId, boxId);
      if (entitlement === undefined) throw new BoxNotOpenableError();
      return { entitlement };
    },
    openBox: async (command) => {
      const fingerprint = buildOpeningFingerprint(command);
      const identifiers = {
        creatorEarningId: generatedUuid(createId, 'Creator earning ID'),
        entitlementConsumptionId: generatedUuid(createId, 'Entitlement consumption ID'),
        fulfillmentId: generatedUuid(createId, 'Fulfillment obligation ID'),
        idempotencyRecordId: generatedUuid(
          createId,
          'Idempotency record ID',
        ) as IdempotencyRecordId,
        openingId: generatedUuid(createId, 'Opening ID') as OpeningId,
        outboxPrivateId: generatedUuid(createId, 'Private outbox event ID'),
        outboxPublicId: generatedUuid(createId, 'Public outbox event ID'),
        publicId: generatedUuid(createId, 'Public opening ID'),
        rewardWinId: generatedUuid(createId, 'Reward win ID'),
      };
      const result = await retryableTransaction(
        database,
        async (transaction, markSelectionStarted) => {
          const claim = await claimBoxOpeningIdempotency(transaction, {
            actorUserId: command.userId,
            fingerprint,
            id: identifiers.idempotencyRecordId,
            idempotencyKey: command.idempotencyKey,
          });
          if (!claim.created) {
            if (
              claim.record.status !== 'completed' ||
              claim.record.httpStatus !== openingStatusCode ||
              claim.record.resourceType !== 'box_open'
            ) {
              throw new Error('Committed opening idempotency replay is incomplete.');
            }
            const storedBody = storedOpeningBody(claim.record.responseBody);
            const exactFingerprint = claim.record.fingerprint === fingerprint;
            const storedFairnessMatchesExpectation =
              storedBody.opening.fairness.seedSetId === command.expectedSeedSetId &&
              storedBody.opening.fairness.commitment === command.expectedServerSeedCommitment;
            const compatibleVersionTwoFingerprint =
              claim.record.fingerprint === buildVersionTwoOpeningFingerprint(command) &&
              storedFairnessMatchesExpectation;
            const compatibleLegacyFingerprint =
              claim.record.fingerprint === buildLegacyOpeningFingerprint(command) &&
              storedBody.opening.boxId === command.boxId &&
              storedBody.opening.boxVersionId === command.expectedBoxVersionId &&
              storedBody.opening.fairness.configurationHash === command.expectedConfigurationHash &&
              storedFairnessMatchesExpectation;
            if (
              !exactFingerprint &&
              !compatibleVersionTwoFingerprint &&
              !compatibleLegacyFingerprint
            ) {
              throw new IdempotencyKeyReusedError();
            }
            return { body: storedBody, replayed: true };
          }

          const catalog = requireOpeningCatalog(
            await findOpeningCatalog(transaction, command.boxId),
          );
          // Completed v1 commands may replay above, but new fan commands cannot spend a wallet.
          if (!allowLegacyPaidOpenings && catalog.openingCompatibilityVersion !== 'opening-v2') {
            throw new BoxNotOpenableError();
          }
          if (
            catalog.boxVersionId !== command.expectedBoxVersionId ||
            catalog.configurationHash !== command.expectedConfigurationHash
          ) {
            throw new OpeningConfirmationStaleError();
          }
          if (catalog.openingCompatibilityVersion === 'opening-v2') {
            const entitlement = await consumeOpeningV2Entitlement(transaction, {
              boxId: catalog.boxId,
              boxVersionId: catalog.boxVersionId,
              configurationHash: catalog.configurationHash,
              consumptionId: identifiers.entitlementConsumptionId,
              creatorId: catalog.creatorId,
              openingId: identifiers.openingId,
              userId: command.userId,
            });
            if (entitlement.outcome === 'max_reached') throw new OpeningLimitReachedError();
            if (entitlement.outcome === 'entitlement_required') {
              throw new OpeningEntitlementRequiredError();
            }

            const timestamp = await readOpeningDatabaseTimestamp(transaction);
            await creatorOpeningCapacity.check(transaction, {
              creatorId: catalog.creatorId,
              boxId: catalog.boxId,
              boxVersionId: catalog.boxVersionId,
              openingId: identifiers.openingId,
              occurredAt: timestamp,
            });
            markSelectionStarted();
            const selection = await fairnessService.selectForOpening(transaction, {
              clientSeed: command.clientSeed,
              expectedSeedSetId: command.expectedSeedSetId,
              expectedServerSeedCommitment: command.expectedServerSeedCommitment,
              expectedManifestHash: catalog.configurationHash,
              manifest: openingManifest(catalog),
              userId: command.userId,
            });
            const selectedEntry = catalog.entries.find(
              (entry) =>
                entry.id === selection.boxVersionRewardId &&
                entry.rewardVersionId === selection.rewardVersionId,
            );
            if (selectedEntry === undefined) {
              throw new Error('RNG selected an unknown catalog entry.');
            }

            let fulfillmentStatus: FulfillmentStatus =
              selectedEntry.xpReward === undefined ? 'pending_fulfillment' : 'not_required';
            let inventoryPoolId: OpeningCatalogEntry['inventoryPoolId'] = null;
            if (selectedEntry.inventoryMode === 'finite') {
              if (selectedEntry.inventoryPoolId === null) throw new BoxNotOpenableError();
              const pool = await lockOpeningInventoryPool(
                transaction,
                selectedEntry.inventoryPoolId,
              );
              if (
                pool?.creatorId !== catalog.creatorId ||
                pool.id !== selectedEntry.inventoryPoolId ||
                pool.stockoutPolicy !== selectedEntry.stockoutPolicy
              ) {
                throw new BoxNotOpenableError();
              }
              inventoryPoolId = pool.id;
              if (
                !(await lockCurrentBoxForOpening(transaction, catalog.boxId, catalog.boxVersionId))
              ) {
                throw new BoxNotOpenableError();
              }
              if (pool.availableQuantity === 0n) {
                if (pool.stockoutPolicy === 'pause_box') throw new InventoryUnavailableError();
                fulfillmentStatus = 'awaiting_restock';
              } else {
                const consumed = await consumeOpeningInventoryPool(
                  transaction,
                  pool.id,
                  identifiers.openingId,
                );
                if (consumed === undefined) throw new InventoryUnavailableError();
                if (consumed.availableQuantity === 0n && pool.stockoutPolicy === 'pause_box') {
                  await pauseBoxesForInventoryPool(transaction, pool.id);
                }
              }
            } else if (
              !(await lockCurrentBoxForOpening(transaction, catalog.boxId, catalog.boxVersionId))
            ) {
              throw new BoxNotOpenableError();
            }

            await insertOpeningV2History(transaction, {
              catalog,
              createdAt: timestamp,
              fulfillmentId: identifiers.fulfillmentId,
              fulfillmentStatus,
              idempotencyRecordId: claim.record.id,
              inventoryPoolId,
              openingId: identifiers.openingId,
              outboxPrivateId: identifiers.outboxPrivateId,
              outboxPublicId: identifiers.outboxPublicId,
              publicId: identifiers.publicId,
              rewardWinId: identifiers.rewardWinId,
              selectedEntry,
              selection,
              userId: command.userId,
            });
            const progression = await readOpeningProgression(
              transaction,
              command.userId,
              identifiers.openingId,
            );
            const body: BoxOpeningBody = {
              opening: {
                boxId: catalog.boxId,
                boxVersionId: catalog.boxVersionId,
                progression,
                entitlement: {
                  source: entitlement.source === 'universal' ? 'universal' : 'creator',
                  universalEntriesRemaining: progression.universalEntriesAvailable,
                  maxOpeningsPerUser: entitlement.maxOpeningsPerUser,
                  remaining: entitlement.remainingEntitlements,
                  successfulOpenings: entitlement.successfulOpenings,
                },
                fairness: {
                  clientSeed: selection.clientSeed,
                  commitment: selection.serverSeedCommitment,
                  configurationHash: selection.manifestHash,
                  nonce: selection.nonce.toString(),
                  seedSetId: selection.seedSetId,
                },
                fulfillmentStatus,
                id: identifiers.publicId,
                openingCompatibilityVersion: 'opening-v2',
                reward: {
                  ...(selectedEntry.xpReward === undefined
                    ? {}
                    : { xpReward: selectedEntry.xpReward }),
                  id: selectedEntry.rewardId,
                  imageUrl: selectedEntry.imageUrl,
                  name: selectedEntry.name,
                  rarity: selectedEntry.rarity,
                  rarityPolicyVersion: 'rarity-v1',
                  rewardVersionId: selectedEntry.rewardVersionId,
                },
              },
            };
            await completeBoxOpeningIdempotency(transaction, {
              openingId: identifiers.openingId,
              recordId: claim.record.id,
              responseBody: body,
            });
            return { body, replayed: false };
          }
          if (!enabledCurrencies.includes(catalog.currency)) {
            throw new OpeningCurrencyUnavailableError();
          }
          const price = parsePositiveMoneyMinor(catalog.priceMinor.toString());
          const timestamp = await readOpeningDatabaseTimestamp(transaction);
          await lockLeaderboardSeasonForOpening(transaction, timestamp);
          const wallet = await lockBoxOpeningWallet(
            transaction,
            command.userId,
            catalog.currency,
            price,
          );
          markSelectionStarted();
          const selection = await fairnessService.selectForOpening(transaction, {
            clientSeed: command.clientSeed,
            expectedSeedSetId: command.expectedSeedSetId,
            expectedServerSeedCommitment: command.expectedServerSeedCommitment,
            expectedManifestHash: catalog.configurationHash,
            manifest: openingManifest(catalog),
            userId: command.userId,
          });
          const selectedEntry = catalog.entries.find(
            (entry) =>
              entry.id === selection.boxVersionRewardId &&
              entry.rewardVersionId === selection.rewardVersionId,
          );
          if (selectedEntry === undefined)
            throw new Error('RNG selected an unknown catalog entry.');

          let fulfillmentStatus: FulfillmentStatus = 'pending_fulfillment';
          let inventoryPoolId: OpeningCatalogEntry['inventoryPoolId'] = null;
          if (selectedEntry.inventoryMode === 'finite') {
            if (selectedEntry.inventoryPoolId === null) throw new BoxNotOpenableError();
            const pool = await lockOpeningInventoryPool(transaction, selectedEntry.inventoryPoolId);
            if (
              pool?.creatorId !== catalog.creatorId ||
              pool.id !== selectedEntry.inventoryPoolId ||
              pool.stockoutPolicy !== selectedEntry.stockoutPolicy
            ) {
              throw new BoxNotOpenableError();
            }
            inventoryPoolId = pool.id;
            if (
              !(await lockCurrentBoxForOpening(transaction, catalog.boxId, catalog.boxVersionId))
            ) {
              throw new BoxNotOpenableError();
            }
            if (pool.availableQuantity === 0n) {
              if (pool.stockoutPolicy === 'pause_box') throw new InventoryUnavailableError();
              fulfillmentStatus = 'awaiting_restock';
            } else {
              const consumed = await consumeOpeningInventoryPool(
                transaction,
                pool.id,
                identifiers.openingId,
              );
              if (consumed === undefined) throw new InventoryUnavailableError();
              if (consumed.availableQuantity === 0n && pool.stockoutPolicy === 'pause_box') {
                await pauseBoxesForInventoryPool(transaction, pool.id);
              }
            }
          } else if (
            !(await lockCurrentBoxForOpening(transaction, catalog.boxId, catalog.boxVersionId))
          ) {
            throw new BoxNotOpenableError();
          }

          const { creatorShareMinor, platformFeeMinor } = calculateOpeningFinancialSplit(
            price,
            platformFeeBps,
          );
          const earningsAvailableAt = new Date(
            new Date(timestamp).valueOf() + earningsHoldMs,
          ).toISOString();
          const financials = await postBoxOpeningFinancials(transaction, {
            actorUserId: command.userId,
            creatorId: catalog.creatorId,
            creatorShareMinor,
            currency: catalog.currency,
            grossPriceMinor: price,
            openingId: identifiers.openingId,
            platformFeeMinor,
            wallet,
          });
          const body: BoxOpeningBody = {
            opening: {
              boxId: catalog.boxId,
              boxVersionId: catalog.boxVersionId,
              cost: { currency: catalog.currency, priceMinor: catalog.priceMinor.toString() },
              fairness: {
                clientSeed: selection.clientSeed,
                commitment: selection.serverSeedCommitment,
                configurationHash: selection.manifestHash,
                nonce: selection.nonce.toString(),
                seedSetId: selection.seedSetId,
              },
              fulfillmentStatus,
              id: identifiers.publicId,
              pointsAwarded: calculateOpeningPoints(selectedEntry.isBaseReward),
              reward: {
                id: selectedEntry.rewardId,
                imageUrl: selectedEntry.imageUrl,
                name: selectedEntry.name,
                rarity: selectedEntry.rarity,
                rarityPolicyVersion: selectedEntry.rarityPolicyVersion,
                rewardVersionId: selectedEntry.rewardVersionId,
              },
              wallet: toPublicWallet(financials.wallet),
            },
          };
          await insertOpeningHistory(transaction, {
            allocationLedgerTransactionId: financials.allocationLedgerTransactionId,
            catalog,
            creatorEarningId: identifiers.creatorEarningId,
            creatorShareMinor,
            createdAt: timestamp,
            earningsAvailableAt,
            fulfillmentId: identifiers.fulfillmentId,
            fulfillmentStatus,
            idempotencyRecordId: claim.record.id,
            inventoryPoolId,
            openingId: identifiers.openingId,
            outboxPrivateId: identifiers.outboxPrivateId,
            outboxPublicId: identifiers.outboxPublicId,
            platformFeeBps,
            platformFeeMinor,
            publicId: identifiers.publicId,
            rewardWinId: identifiers.rewardWinId,
            saleLedgerTransactionId: financials.saleLedgerTransactionId,
            selectedEntry,
            selection,
            userId: command.userId,
          });
          await completeBoxOpeningIdempotency(transaction, {
            openingId: identifiers.openingId,
            recordId: claim.record.id,
            responseBody: body,
          });
          return { body, replayed: false };
        },
      );

      if (!result.replayed) {
        logger.info('opening.audit', {
          action: 'box.opened',
          actorUserId: command.userId,
          boxId: command.boxId,
          openingId: result.body.opening.id,
          requestId: command.requestId,
        });
      }
      return { ...result, statusCode: openingStatusCode };
    },
  };
};
