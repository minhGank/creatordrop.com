import {
  xpRewardSchema,
  progressionSchema,
  openingProgressionSchema,
  type XpReward,
} from '@creatordrop/contracts';
import { validate as isUuid } from 'uuid';

import { assertTransactionExecutor } from '@creatordrop/database';
import type { QueryExecutor, TransactionExecutor } from '@creatordrop/database';
import { parseCurrency, toMoneyMinor, progressionForXp } from '@creatordrop/domain';
import type { Currency, MoneyMinor } from '@creatordrop/domain';

import type {
  BoxId,
  BoxVersionId,
  BoxVersionRewardId,
  InventoryPoolId,
  RewardVersionId,
} from '../catalog/catalog.js';
import { rarityPolicyVersions, rewardRarities } from '../catalog/catalog.js';
import type { CreatorId, UserId } from '../creators/creator.js';
import type { OpeningFairnessSelection } from '../fairness/fairness.service.js';
import type { IdempotencyRecordId, LedgerTransactionId } from '../wallet/wallet.js';
import type { FulfillmentStatus, OpeningId } from './opening.js';

interface CatalogHeaderRow {
  readonly boxId: unknown;
  readonly boxStatus: unknown;
  readonly boxVersionId: unknown;
  readonly configurationHash: unknown;
  readonly creatorId: unknown;
  readonly currency: unknown;
  readonly maxOpeningsPerUser: unknown;
  readonly openingCompatibilityVersion: unknown;
  readonly priceMinor: unknown;
  readonly rngAlgorithmVersion: unknown;
  readonly totalWeight: unknown;
}

interface CatalogEntryRow {
  readonly xpAmount: unknown;
  readonly xpPolicyVersion: unknown;
  readonly entryId: unknown;
  readonly imageUrl: unknown;
  readonly inventoryMode: unknown;
  readonly inventoryPoolId: unknown;
  readonly isBaseReward: unknown;
  readonly name: unknown;
  readonly position: unknown;
  readonly rarity: unknown;
  readonly rarityPolicyVersion: unknown;
  readonly rewardId: unknown;
  readonly rewardVersionId: unknown;
  readonly stockoutPolicy: unknown;
  readonly weight: unknown;
}

interface InventoryPoolRow {
  readonly availableQuantity: unknown;
  readonly creatorId: unknown;
  readonly id: unknown;
  readonly stockoutPolicy: unknown;
}

export interface OpeningCatalogEntry {
  readonly xpReward?: XpReward;
  readonly id: BoxVersionRewardId;
  readonly imageUrl: string | null;
  readonly inventoryMode: 'finite' | 'unlimited';
  readonly inventoryPoolId: InventoryPoolId | null;
  readonly isBaseReward: boolean;
  readonly name: string;
  readonly position: number;
  readonly rarity: (typeof rewardRarities)[number] | null;
  readonly rarityPolicyVersion: (typeof rarityPolicyVersions)[number] | null;
  readonly rewardId: string;
  readonly rewardVersionId: RewardVersionId;
  readonly stockoutPolicy: 'backorder' | 'pause_box' | null;
  readonly weight: string;
}

export interface OpeningCatalog {
  readonly boxId: BoxId;
  readonly boxStatus: 'active' | 'archived' | 'draft' | 'paused';
  readonly boxVersionId: BoxVersionId;
  readonly configurationHash: string;
  readonly creatorId: CreatorId;
  readonly currency: Currency | null;
  readonly entries: readonly OpeningCatalogEntry[];
  readonly maxOpeningsPerUser: string | null;
  readonly openingCompatibilityVersion: 'opening-v1' | 'opening-v2' | null;
  readonly priceMinor: MoneyMinor | null;
  readonly rngAlgorithmVersion: string;
  readonly totalWeight: string;
}

export interface LockedInventoryPool {
  readonly availableQuantity: bigint;
  readonly creatorId: CreatorId;
  readonly id: InventoryPoolId;
  readonly stockoutPolicy: 'backorder' | 'pause_box';
}

export interface OpeningHistoryInsert {
  readonly allocationLedgerTransactionId: LedgerTransactionId;
  readonly catalog: OpeningCatalog & {
    readonly currency: Currency;
    readonly maxOpeningsPerUser: null;
    readonly openingCompatibilityVersion: 'opening-v1';
    readonly priceMinor: MoneyMinor;
  };
  readonly creatorShareMinor: MoneyMinor;
  readonly earningsAvailableAt: string;
  readonly fulfillmentId: string;
  readonly fulfillmentStatus: FulfillmentStatus;
  readonly idempotencyRecordId: IdempotencyRecordId;
  readonly inventoryPoolId: InventoryPoolId | null;
  readonly openingId: OpeningId;
  readonly outboxPrivateId: string;
  readonly outboxPublicId: string;
  readonly platformFeeBps: number;
  readonly platformFeeMinor: MoneyMinor;
  readonly publicId: string;
  readonly rewardWinId: string;
  readonly saleLedgerTransactionId: LedgerTransactionId;
  readonly selection: OpeningFairnessSelection;
  readonly selectedEntry: OpeningCatalogEntry;
  readonly userId: UserId;
  readonly creatorEarningId: string;
  readonly createdAt: string;
}

export interface OpeningV2HistoryInsert {
  readonly catalog: OpeningCatalog & {
    readonly currency: null;
    readonly maxOpeningsPerUser: string;
    readonly openingCompatibilityVersion: 'opening-v2';
    readonly priceMinor: null;
  };
  readonly createdAt: string;
  readonly fulfillmentId: string;
  readonly fulfillmentStatus: FulfillmentStatus;
  readonly idempotencyRecordId: IdempotencyRecordId;
  readonly inventoryPoolId: InventoryPoolId | null;
  readonly openingId: OpeningId;
  readonly outboxPrivateId: string;
  readonly outboxPublicId: string;
  readonly publicId: string;
  readonly rewardWinId: string;
  readonly selectedEntry: OpeningCatalogEntry;
  readonly selection: OpeningFairnessSelection;
  readonly userId: UserId;
}

interface EntitlementConsumptionRow {
  readonly source: unknown;
  readonly universalEntriesAvailable: unknown;
  readonly maxOpeningsPerUser: unknown;
  readonly outcome: unknown;
  readonly remainingEntitlements: unknown;
  readonly successfulOpenings: unknown;
}

export interface OpeningV2EntitlementConsumption {
  readonly source: 'creator' | 'universal' | null;
  readonly universalEntriesAvailable: string;
  readonly maxOpeningsPerUser: string;
  readonly outcome: 'consumed' | 'entitlement_required' | 'max_reached';
  readonly remainingEntitlements: string;
  readonly successfulOpenings: string;
}

interface EntitlementStateRow {
  readonly source: unknown;
  readonly universalEntriesAvailable: unknown;
  readonly available: unknown;
  readonly boxId: unknown;
  readonly consumed: unknown;
  readonly granted: unknown;
  readonly limitReached: unknown;
  readonly maxOpeningsPerUser: unknown;
  readonly remaining: unknown;
  readonly successfulOpenings: unknown;
}

export interface OpeningV2EntitlementState {
  readonly source: 'creator' | 'universal' | null;
  readonly universalEntriesAvailable: string;
  readonly available: boolean;
  readonly boxId: BoxId;
  readonly consumed: string;
  readonly granted: string;
  readonly limitReached: boolean;
  readonly maxOpeningsPerUser: string;
  readonly remaining: string;
  readonly successfulOpenings: string;
}

const requiredString = (value: unknown, label: string): string => {
  if (typeof value !== 'string') throw new Error(`Database returned an invalid ${label}.`);
  return value;
};

const requiredUuid = (value: unknown, label: string): string => {
  const parsed = requiredString(value, label);
  if (!isUuid(parsed) || parsed !== parsed.toLowerCase()) {
    throw new Error(`Database returned a noncanonical ${label}.`);
  }
  return parsed;
};

const requiredBigint = (value: unknown, label: string): bigint => {
  const parsed = requiredString(value, label);
  if (!/^(0|[1-9][0-9]*)$/u.test(parsed)) {
    throw new Error(`Database returned a noncanonical ${label}.`);
  }
  return BigInt(parsed);
};

const requiredNumber = (value: unknown, label: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Database returned an invalid ${label}.`);
  }
  return value;
};

const requiredBoolean = (value: unknown, label: string): boolean => {
  if (typeof value !== 'boolean') throw new Error(`Database returned an invalid ${label}.`);
  return value;
};

const requiredHex256 = (value: unknown, label: string): string => {
  const parsed = requiredString(value, label);
  if (!/^[0-9a-f]{64}$/u.test(parsed)) throw new Error(`Database returned an invalid ${label}.`);
  return parsed;
};

const nullableOneOf = <T extends string>(
  value: unknown,
  values: readonly T[],
  label: string,
): T | null => {
  if (value === null) return null;
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw new Error(`Database returned an invalid ${label}.`);
  }
  return value as T;
};

export const findOpeningCatalog = async (
  executor: QueryExecutor,
  boxId: BoxId,
): Promise<OpeningCatalog | undefined> => {
  const headerResult = await executor.query<CatalogHeaderRow>(
    `select box.id::text as "boxId", box.status as "boxStatus",
            box.creator_id::text as "creatorId", version.id::text as "boxVersionId",
            version.opening_compatibility_version as "openingCompatibilityVersion",
            version.price_minor::text as "priceMinor", version.currency::text as currency,
            version.max_openings_per_user::text as "maxOpeningsPerUser",
            version.total_weight::text as "totalWeight",
            encode(version.configuration_hash, 'hex') as "configurationHash",
            version.rng_algorithm_version as "rngAlgorithmVersion"
       from app.boxes as box
       join app.box_versions as version on version.id = box.current_published_version_id
      where box.id = $1 and version.state = 'published'
        and exists(select 1 from app.creators c where c.id=box.creator_id and c.status='active')`,
    [boxId],
  );
  const header = headerResult.rows[0];
  if (header === undefined) return undefined;
  const boxStatus = requiredString(header.boxStatus, 'box status');
  if (!['active', 'archived', 'draft', 'paused'].includes(boxStatus)) {
    throw new Error('Database returned an invalid box status.');
  }
  const boxVersionId = requiredUuid(header.boxVersionId, 'box version ID') as BoxVersionId;
  const entryResult = await executor.query<CatalogEntryRow>(
    `select entry.id::text as "entryId", entry.position,
            entry.weight::text as weight, entry.reward_version_id::text as "rewardVersionId",
            entry.rarity, entry.rarity_policy_version as "rarityPolicyVersion",
            reward.id::text as "rewardId", reward_version.name,
            reward_version.image_url as "imageUrl",
            reward_version.xp_amount::text as "xpAmount", reward_version.xp_policy_version as "xpPolicyVersion",
            reward_version.inventory_mode as "inventoryMode",
            pool.id::text as "inventoryPoolId", pool.stockout_policy as "stockoutPolicy",
            (base.id is not null) as "isBaseReward"
       from app.box_version_rewards as entry
       join app.reward_versions as reward_version on reward_version.id = entry.reward_version_id
       join app.rewards as reward on reward.id = reward_version.reward_id
       left join app.inventory_pools as pool on pool.id = reward_version.inventory_pool_id
       left join app.box_version_base_rewards as base
         on base.box_version_id = entry.box_version_id
        and base.box_version_reward_id = entry.id
      where entry.box_version_id = $1
      order by entry.position`,
    [boxVersionId],
  );
  const entries = entryResult.rows.map((row): OpeningCatalogEntry => {
    const inventoryMode = requiredString(row.inventoryMode, 'inventory mode');
    if (inventoryMode !== 'finite' && inventoryMode !== 'unlimited') {
      throw new Error('Database returned an invalid inventory mode.');
    }
    const stockoutPolicy =
      row.stockoutPolicy === null ? null : requiredString(row.stockoutPolicy, 'stockout policy');
    if (
      stockoutPolicy !== null &&
      stockoutPolicy !== 'pause_box' &&
      stockoutPolicy !== 'backorder'
    ) {
      throw new Error('Database returned an invalid stockout policy.');
    }
    const rarity = nullableOneOf(row.rarity, rewardRarities, 'reward rarity');
    const rarityPolicyVersion = nullableOneOf(
      row.rarityPolicyVersion,
      rarityPolicyVersions,
      'rarity policy version',
    );
    if ((rarity === null) !== (rarityPolicyVersion === null)) {
      throw new Error('Database returned an incomplete rarity snapshot.');
    }
    return {
      id: requiredUuid(row.entryId, 'box reward entry ID') as BoxVersionRewardId,
      imageUrl: row.imageUrl === null ? null : requiredString(row.imageUrl, 'reward image URL'),
      inventoryMode,
      inventoryPoolId:
        row.inventoryPoolId === null
          ? null
          : (requiredUuid(row.inventoryPoolId, 'inventory pool ID') as InventoryPoolId),
      isBaseReward: row.isBaseReward === true,
      name: requiredString(row.name, 'reward name'),
      ...(row.xpAmount == null
        ? {}
        : {
            xpReward: xpRewardSchema.parse({
              amount: row.xpAmount,
              policyVersion: row.xpPolicyVersion,
            }),
          }),
      position: requiredNumber(row.position, 'reward position'),
      rarity,
      rarityPolicyVersion,
      rewardId: requiredUuid(row.rewardId, 'reward ID'),
      rewardVersionId: requiredUuid(row.rewardVersionId, 'reward version ID') as RewardVersionId,
      stockoutPolicy,
      weight: requiredBigint(row.weight, 'reward weight').toString(),
    };
  });
  const openingCompatibilityVersion = nullableOneOf(
    header.openingCompatibilityVersion,
    ['opening-v1', 'opening-v2'] as const,
    'opening compatibility version',
  );
  const isVersionTwo = openingCompatibilityVersion === 'opening-v2';
  if (
    isVersionTwo
      ? header.currency !== null || header.priceMinor !== null || header.maxOpeningsPerUser === null
      : header.currency === null || header.priceMinor === null || header.maxOpeningsPerUser !== null
  ) {
    throw new Error('Database returned an invalid opening model shape.');
  }
  return {
    boxId: requiredUuid(header.boxId, 'box ID') as BoxId,
    boxStatus: boxStatus as OpeningCatalog['boxStatus'],
    boxVersionId,
    configurationHash: requiredHex256(header.configurationHash, 'configuration hash'),
    creatorId: requiredUuid(header.creatorId, 'creator ID') as CreatorId,
    currency: isVersionTwo ? null : parseCurrency(header.currency),
    entries,
    maxOpeningsPerUser: isVersionTwo
      ? requiredBigint(header.maxOpeningsPerUser, 'maximum openings per user').toString()
      : null,
    openingCompatibilityVersion,
    priceMinor: isVersionTwo ? null : toMoneyMinor(requiredBigint(header.priceMinor, 'box price')),
    rngAlgorithmVersion: requiredString(header.rngAlgorithmVersion, 'RNG algorithm version'),
    totalWeight: requiredBigint(header.totalWeight, 'total weight').toString(),
  };
};

const parseInventoryPool = (row: InventoryPoolRow): LockedInventoryPool => {
  const stockoutPolicy = requiredString(row.stockoutPolicy, 'stockout policy');
  if (stockoutPolicy !== 'pause_box' && stockoutPolicy !== 'backorder') {
    throw new Error('Database returned an invalid stockout policy.');
  }
  return {
    availableQuantity: requiredBigint(row.availableQuantity, 'available inventory'),
    creatorId: requiredUuid(row.creatorId, 'inventory creator ID') as CreatorId,
    id: requiredUuid(row.id, 'inventory pool ID') as InventoryPoolId,
    stockoutPolicy,
  };
};

const inventoryColumns = `
  id::text as id,
  creator_id::text as "creatorId",
  stockout_policy as "stockoutPolicy",
  available_quantity::text as "availableQuantity"`;

export const lockOpeningInventoryPool = async (
  transaction: TransactionExecutor,
  poolId: InventoryPoolId,
): Promise<LockedInventoryPool | undefined> => {
  assertTransactionExecutor(transaction);
  const result = await transaction.query<InventoryPoolRow>(
    `select ${inventoryColumns} from app.lock_inventory_pool($1)`,
    [poolId],
  );
  return result.rows[0] === undefined ? undefined : parseInventoryPool(result.rows[0]);
};

export const consumeOpeningInventoryPool = async (
  transaction: TransactionExecutor,
  poolId: InventoryPoolId,
  openingId: OpeningId,
): Promise<LockedInventoryPool | undefined> => {
  assertTransactionExecutor(transaction);
  const result = await transaction.query<InventoryPoolRow>(
    `select ${inventoryColumns} from app.consume_inventory_pool($1, $2)`,
    [poolId, openingId],
  );
  return result.rows[0] === undefined ? undefined : parseInventoryPool(result.rows[0]);
};

export const lockCurrentBoxForOpening = async (
  transaction: TransactionExecutor,
  boxId: BoxId,
  boxVersionId: BoxVersionId,
): Promise<boolean> => {
  assertTransactionExecutor(transaction);
  const result = await transaction.query(`select id from app.lock_current_box_for_open($1, $2)`, [
    boxId,
    boxVersionId,
  ]);
  return result.rowCount === 1;
};

export const pauseBoxesForInventoryPool = async (
  transaction: TransactionExecutor,
  poolId: InventoryPoolId,
): Promise<number> => {
  assertTransactionExecutor(transaction);
  const result = await transaction.query(`select id from app.pause_boxes_for_inventory_pool($1)`, [
    poolId,
  ]);
  return result.rowCount ?? 0;
};

export const readOpeningDatabaseTimestamp = async (
  transaction: TransactionExecutor,
): Promise<string> => {
  const result = await transaction.query<{ readonly value: unknown }>(
    `select clock_timestamp() as value`,
  );
  const value = result.rows[0]?.value;
  if (!(value instanceof Date) || !Number.isFinite(value.valueOf())) {
    throw new Error('Database returned an invalid opening timestamp.');
  }
  return value.toISOString();
};

export const lockLeaderboardSeasonForOpening = async (
  transaction: TransactionExecutor,
  openedAt: string,
): Promise<string | null> => {
  assertTransactionExecutor(transaction);
  const result = await transaction.query<{ readonly seasonId: unknown }>(
    `select app.lock_leaderboard_season_for_opening($1) as "seasonId"`,
    [openedAt],
  );
  const seasonId = result.rows[0]?.seasonId;
  if (seasonId === null) return null;
  return requiredUuid(seasonId, 'leaderboard season ID');
};

export const consumeOpeningV2Entitlement = async (
  transaction: TransactionExecutor,
  input: {
    readonly boxId: BoxId;
    readonly boxVersionId: BoxVersionId;
    readonly configurationHash: string;
    readonly consumptionId: string;
    readonly creatorId: CreatorId;
    readonly openingId: OpeningId;
    readonly userId: UserId;
  },
): Promise<OpeningV2EntitlementConsumption> => {
  assertTransactionExecutor(transaction);
  const result = await transaction.query<EntitlementConsumptionRow>(
    `select outcome,
            max_openings_per_user as "maxOpeningsPerUser",
            successful_openings as "successfulOpenings",
            remaining_entitlements as "remainingEntitlements", source, universal_entries_remaining as "universalEntriesAvailable"
       from app.consume_opening_v2_entitlement(
         $1, $2, $3, $4, $5, $6, decode($7, 'hex')
       )`,
    [
      input.consumptionId,
      input.openingId,
      input.userId,
      input.creatorId,
      input.boxId,
      input.boxVersionId,
      input.configurationHash,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('Database did not return an entitlement outcome.');
  const outcome = requiredString(row.outcome, 'entitlement outcome');
  if (!['consumed', 'entitlement_required', 'max_reached'].includes(outcome)) {
    throw new Error('Database returned an invalid entitlement outcome.');
  }
  return {
    maxOpeningsPerUser: requiredBigint(
      row.maxOpeningsPerUser,
      'maximum openings per user',
    ).toString(),
    outcome: outcome as OpeningV2EntitlementConsumption['outcome'],
    remainingEntitlements: requiredBigint(
      row.remainingEntitlements,
      'remaining entitlements',
    ).toString(),
    successfulOpenings: requiredBigint(row.successfulOpenings, 'successful openings').toString(),
    source: nullableOneOf(row.source, ['creator', 'universal'] as const, 'entitlement source'),
    universalEntriesAvailable: requiredBigint(
      row.universalEntriesAvailable,
      'Universal Entries',
    ).toString(),
  };
};

export const readOpeningV2EntitlementState = async (
  executor: QueryExecutor,
  userId: UserId,
  boxId: BoxId,
): Promise<OpeningV2EntitlementState | undefined> => {
  const result = await executor.query<EntitlementStateRow>(
    `select box_id::text as "boxId",
            max_openings_per_user as "maxOpeningsPerUser",
            successful_openings as "successfulOpenings",
            granted, consumed, remaining, available, limit_reached as "limitReached", source, universal_entries_available as "universalEntriesAvailable"
       from app.read_opening_v2_entitlement_state($1, $2)`,
    [userId, boxId],
  );
  const row = result.rows[0];
  if (row === undefined) return undefined;
  return {
    available: requiredBoolean(row.available, 'entitlement availability'),
    boxId: requiredUuid(row.boxId, 'entitlement box ID') as BoxId,
    consumed: requiredBigint(row.consumed, 'consumed entitlements').toString(),
    granted: requiredBigint(row.granted, 'granted entitlements').toString(),
    limitReached: requiredBoolean(row.limitReached, 'opening limit state'),
    maxOpeningsPerUser: requiredBigint(
      row.maxOpeningsPerUser,
      'maximum openings per user',
    ).toString(),
    remaining: requiredBigint(row.remaining, 'remaining entitlements').toString(),
    successfulOpenings: requiredBigint(row.successfulOpenings, 'successful openings').toString(),
    source: nullableOneOf(row.source, ['creator', 'universal'] as const, 'entitlement source'),
    universalEntriesAvailable: requiredBigint(
      row.universalEntriesAvailable,
      'Universal Entries',
    ).toString(),
  };
};

export const insertOpeningHistory = async (
  transaction: TransactionExecutor,
  input: OpeningHistoryInsert,
): Promise<void> => {
  assertTransactionExecutor(transaction);
  const bonusPoints = input.selectedEntry.isBaseReward ? 15 : 0;
  await transaction.query(
    `insert into app.box_opens (
       id, public_id, user_id, creator_id, box_id, box_version_id,
       selected_box_version_reward_id, reward_version_id, inventory_pool_id,
       rng_seed_set_id, nonce, client_seed, server_seed_commitment,
       rng_algorithm_version, rng_digest, rng_selection, rng_selection_round,
       configuration_hash, gross_price_minor, currency, platform_fee_bps,
       platform_fee_minor, creator_share_minor, earnings_available_at,
       points_policy_version, base_points, bonus_points, points_awarded,
       sale_ledger_transaction_id, allocation_ledger_transaction_id,
       idempotency_record_id, created_at
     ) values (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
       decode($13, 'hex'), $14, decode($15, 'hex'), $16, $17,
       decode($18, 'hex'), $19, $20, $21, $22, $23, $24,
       'leaderboard-v1', 5, $25, $26, $27, $28, $29, $30
     )`,
    [
      input.openingId,
      input.publicId,
      input.userId,
      input.catalog.creatorId,
      input.catalog.boxId,
      input.catalog.boxVersionId,
      input.selectedEntry.id,
      input.selectedEntry.rewardVersionId,
      input.inventoryPoolId,
      input.selection.seedSetId,
      input.selection.nonce.toString(),
      input.selection.clientSeed,
      input.selection.serverSeedCommitment,
      input.selection.algorithmVersion,
      input.selection.acceptedDigestHex,
      input.selection.selectionValue.toString(),
      input.selection.acceptedRound.toString(),
      input.catalog.configurationHash,
      input.catalog.priceMinor.toString(),
      input.catalog.currency,
      input.platformFeeBps,
      input.platformFeeMinor.toString(),
      input.creatorShareMinor.toString(),
      input.earningsAvailableAt,
      bonusPoints,
      5 + bonusPoints,
      input.saleLedgerTransactionId,
      input.allocationLedgerTransactionId,
      input.idempotencyRecordId,
      input.createdAt,
    ],
  );
  await transaction.query(
    `insert into app.reward_wins (
       id, opening_id, user_id, creator_id, reward_version_id, created_at
     ) values ($1, $2, $3, $4, $5, $6)`,
    [
      input.rewardWinId,
      input.openingId,
      input.userId,
      input.catalog.creatorId,
      input.selectedEntry.rewardVersionId,
      input.createdAt,
    ],
  );
  await transaction.query(
    `insert into app.fulfillment_obligations (
       id, opening_id, reward_win_id, status, created_at
     ) values ($1, $2, $3, $4, $5)`,
    [
      input.fulfillmentId,
      input.openingId,
      input.rewardWinId,
      input.fulfillmentStatus,
      input.createdAt,
    ],
  );
  await transaction.query(
    `insert into app.creator_earnings (
       id, opening_id, creator_id, ledger_transaction_id,
       amount_minor, currency, available_at, created_at
     ) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      input.creatorEarningId,
      input.openingId,
      input.catalog.creatorId,
      input.allocationLedgerTransactionId,
      input.creatorShareMinor.toString(),
      input.catalog.currency,
      input.earningsAvailableAt,
      input.createdAt,
    ],
  );
  await transaction.query(
    `insert into app.event_outbox (
       id, aggregate_type, aggregate_id, event_type, audience, payload, occurred_at, created_at
     ) values ($1, 'box_open', $2, 'opening.completed.v1', 'private', $3::jsonb, $4, $4)`,
    [
      input.outboxPrivateId,
      input.openingId,
      JSON.stringify({
        boxId: input.catalog.boxId,
        boxVersionId: input.catalog.boxVersionId,
        creatorId: input.catalog.creatorId,
        openingId: input.openingId,
        rewardVersionId: input.selectedEntry.rewardVersionId,
        userId: input.userId,
      }),
      input.createdAt,
    ],
  );
  await transaction.query(
    `insert into app.event_outbox (
       id, aggregate_type, aggregate_id, event_type, audience, payload, occurred_at, created_at
     ) values ($1, 'box_open', $2, 'drop.created.v1', 'public', $3::jsonb, $4, $4)`,
    [
      input.outboxPublicId,
      input.openingId,
      JSON.stringify({
        boxId: input.catalog.boxId,
        creatorId: input.catalog.creatorId,
        openingId: input.publicId,
        reward: {
          imageUrl: input.selectedEntry.imageUrl,
          name: input.selectedEntry.name,
          rewardId: input.selectedEntry.rewardId,
        },
      }),
      input.createdAt,
    ],
  );
};

export const insertOpeningV2History = async (
  transaction: TransactionExecutor,
  input: OpeningV2HistoryInsert,
): Promise<void> => {
  assertTransactionExecutor(transaction);
  await transaction.query(
    `insert into app.box_opens (
       id, public_id, user_id, creator_id, box_id, box_version_id,
       selected_box_version_reward_id, reward_version_id, inventory_pool_id,
       rng_seed_set_id, nonce, client_seed, server_seed_commitment,
       rng_algorithm_version, rng_digest, rng_selection, rng_selection_round,
       configuration_hash, idempotency_record_id, opening_compatibility_version, created_at
     ) values (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
       decode($13, 'hex'), $14, decode($15, 'hex'), $16, $17,
       decode($18, 'hex'), $19, 'opening-v2', $20
     )`,
    [
      input.openingId,
      input.publicId,
      input.userId,
      input.catalog.creatorId,
      input.catalog.boxId,
      input.catalog.boxVersionId,
      input.selectedEntry.id,
      input.selectedEntry.rewardVersionId,
      input.inventoryPoolId,
      input.selection.seedSetId,
      input.selection.nonce.toString(),
      input.selection.clientSeed,
      input.selection.serverSeedCommitment,
      input.selection.algorithmVersion,
      input.selection.acceptedDigestHex,
      input.selection.selectionValue.toString(),
      input.selection.acceptedRound.toString(),
      input.catalog.configurationHash,
      input.idempotencyRecordId,
      input.createdAt,
    ],
  );
  await transaction.query(
    `insert into app.reward_wins (
       id, opening_id, user_id, creator_id, reward_version_id, created_at
     ) values ($1, $2, $3, $4, $5, $6)`,
    [
      input.rewardWinId,
      input.openingId,
      input.userId,
      input.catalog.creatorId,
      input.selectedEntry.rewardVersionId,
      input.createdAt,
    ],
  );
  if (input.selectedEntry.xpReward === undefined) {
    await transaction.query(
      `insert into app.fulfillment_obligations (
       id, opening_id, reward_win_id, status, created_at
     ) values ($1, $2, $3, $4, $5)`,
      [
        input.fulfillmentId,
        input.openingId,
        input.rewardWinId,
        input.fulfillmentStatus,
        input.createdAt,
      ],
    );
  }
  await transaction.query(
    `insert into app.event_outbox (
       id, aggregate_type, aggregate_id, event_type, audience, payload, occurred_at, created_at
     ) values ($1, 'box_open', $2, 'opening.completed.v1', 'private', $3::jsonb, $4, $4)`,
    [
      input.outboxPrivateId,
      input.openingId,
      JSON.stringify({
        boxId: input.catalog.boxId,
        boxVersionId: input.catalog.boxVersionId,
        creatorId: input.catalog.creatorId,
        openingId: input.openingId,
        rewardVersionId: input.selectedEntry.rewardVersionId,
        userId: input.userId,
      }),
      input.createdAt,
    ],
  );
  await transaction.query(
    `insert into app.event_outbox (
       id, aggregate_type, aggregate_id, event_type, audience, payload, occurred_at, created_at
     ) values ($1, 'box_open', $2, 'drop.created.v1', 'public', $3::jsonb, $4, $4)`,
    [
      input.outboxPublicId,
      input.openingId,
      JSON.stringify({
        boxId: input.catalog.boxId,
        creatorId: input.catalog.creatorId,
        openingId: input.publicId,
        reward: {
          imageUrl: input.selectedEntry.imageUrl,
          name: input.selectedEntry.name,
          rewardId: input.selectedEntry.rewardId,
        },
      }),
      input.createdAt,
    ],
  );
};

export const readProgression = async (executor: QueryExecutor, userId: UserId) => {
  const result = await executor.query<{ state: unknown }>(
    'select app.read_progression($1) as state',
    [userId],
  );
  const state = progressionSchema.parse(result.rows[0]?.state);
  validateProgressionMath(state);
  return state;
};
export const readOpeningProgression = async (
  executor: TransactionExecutor,
  userId: UserId,
  openingId: OpeningId,
) => {
  const result = await executor.query<{ state: unknown }>(
    'select app.read_opening_progression($1,$2) as state',
    [userId, openingId],
  );
  const state = openingProgressionSchema.parse(result.rows[0]?.state);
  validateProgressionMath(state);
  return state;
};

const validateProgressionMath = (state: ReturnType<typeof progressionSchema.parse>): void => {
  const derived = progressionForXp(BigInt(state.lifetimeXp));
  if (
    derived.level.toString() !== state.level ||
    derived.xpInLevel.toString() !== state.xpInLevel ||
    derived.xpForNextLevel.toString() !== state.xpForNextLevel ||
    (derived.level - 1n).toString() !== state.universalEntriesEarned ||
    BigInt(state.universalEntriesAvailable) > BigInt(state.universalEntriesEarned)
  ) {
    throw new Error('Database progression state is inconsistent.');
  }
};
