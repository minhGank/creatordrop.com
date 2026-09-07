import { assertTransactionExecutor } from '@creatordrop/database';
import type { QueryExecutor, TransactionExecutor } from '@creatordrop/database';

import type { CreatorId, CreatorRole, UserId } from '../creators/creator.js';
import {
  boxStatuses,
  boxVersionStates,
  inventoryModes,
  rarityPolicyVersions,
  rewardRarities,
  rewardStatuses,
  rewardTypes,
  rewardVersionStates,
  type Box,
  type BoxId,
  type BoxVersion,
  type BoxVersionId,
  type BoxVersionRewardId,
  type DraftRewardEntry,
  type InventoryPoolId,
  type ProbabilityWeight,
  type RarityPolicyVersion,
  type Reward,
  type RewardId,
  type RewardStatus,
  type RewardRarity,
  type RewardVersion,
  type RewardVersionId,
} from './catalog.js';
import type { BoxDraftInput, RewardDraftInput } from './catalog.schema.js';

interface BoxRow {
  readonly boxCreatedAt: unknown;
  readonly boxUpdatedAt: unknown;
  readonly creatorId: unknown;
  readonly currentPublishedVersionId: unknown;
  readonly draftConfigurationHash: unknown;
  readonly draftCreatedAt: unknown;
  readonly draftCurrency: unknown;
  readonly draftDescription: unknown;
  readonly draftId: unknown;
  readonly draftImageUrl: unknown;
  readonly draftMaxOpeningsPerUser: unknown;
  readonly draftName: unknown;
  readonly draftOpeningCompatibilityVersion: unknown;
  readonly draftPriceMinor: unknown;
  readonly draftPublishedAt: unknown;
  readonly draftRngAlgorithmVersion: unknown;
  readonly draftState: unknown;
  readonly draftTotalWeight: unknown;
  readonly draftUpdatedAt: unknown;
  readonly draftVersionNumber: unknown;
  readonly id: unknown;
  readonly revision: unknown;
  readonly role: unknown;
  readonly status: unknown;
}

interface RewardRow {
  readonly creatorId: unknown;
  readonly draftCreatedAt: unknown;
  readonly draftDeclaredValueCurrency: unknown;
  readonly draftDeclaredValueMinor: unknown;
  readonly draftDescription: unknown;
  readonly draftId: unknown;
  readonly draftImageUrl: unknown;
  readonly draftInventoryMode: unknown;
  readonly draftInventoryQuantity: unknown;
  readonly draftInventoryStockoutPolicy: unknown;
  readonly draftName: unknown;
  readonly draftPublishedAt: unknown;
  readonly draftRewardType: unknown;
  readonly draftState: unknown;
  readonly draftUpdatedAt: unknown;
  readonly draftVersionNumber: unknown;
  readonly id: unknown;
  readonly revision: unknown;
  readonly rewardCreatedAt: unknown;
  readonly rewardUpdatedAt: unknown;
  readonly role: unknown;
  readonly status: unknown;
}

interface BoxVersionRow {
  readonly configurationHash: unknown;
  readonly createdAt: unknown;
  readonly currency: unknown;
  readonly description: unknown;
  readonly id: unknown;
  readonly imageUrl: unknown;
  readonly maxOpeningsPerUser: unknown;
  readonly name: unknown;
  readonly openingCompatibilityVersion: unknown;
  readonly priceMinor: unknown;
  readonly publishedAt: unknown;
  readonly rngAlgorithmVersion: unknown;
  readonly state: unknown;
  readonly totalWeight: unknown;
  readonly updatedAt: unknown;
  readonly versionNumber: unknown;
}

interface PublicBoxVersionRow extends BoxVersionRow {
  readonly boxId: unknown;
}

interface RewardVersionRow {
  readonly createdAt: unknown;
  readonly declaredValueCurrency: unknown;
  readonly declaredValueMinor: unknown;
  readonly description: unknown;
  readonly id: unknown;
  readonly imageUrl: unknown;
  readonly inventoryMode: unknown;
  readonly inventoryQuantity: unknown;
  readonly inventoryStockoutPolicy: unknown;
  readonly name: unknown;
  readonly publishedAt: unknown;
  readonly rewardType: unknown;
  readonly state: unknown;
  readonly updatedAt: unknown;
  readonly versionNumber: unknown;
}

interface ConfigurationRow extends RewardVersionRow {
  readonly entryId: unknown;
  readonly isBaseReward: unknown;
  readonly position: unknown;
  readonly rarity: unknown;
  readonly rarityPolicyVersion: unknown;
  readonly rewardId: unknown;
  readonly rewardStatus: unknown;
  readonly weight: unknown;
}

export interface ConfigurationEntryRecord {
  readonly entry: DraftRewardEntry;
  readonly rewardId: RewardId;
  readonly rewardStatus: RewardStatus;
}

export interface RewardVersionRecord {
  readonly rewardId: RewardId;
  readonly rewardStatus: RewardStatus;
  readonly version: RewardVersion;
}

export interface PublicBoxVersionRecord {
  readonly boxId: BoxId;
  readonly version: BoxVersion;
}

export interface LockedPublicationInventoryPool {
  readonly availableQuantity: bigint;
  readonly creatorId: CreatorId;
  readonly id: InventoryPoolId;
  readonly stockoutPolicy: 'pause_box';
}

const isOneOf = <T extends string>(value: unknown, values: readonly T[]): value is T =>
  typeof value === 'string' && values.includes(value as T);

const requiredString = (value: unknown, name: string): string => {
  if (typeof value !== 'string') throw new Error(`Database returned invalid ${name}.`);
  return value;
};

const nullableString = (value: unknown, name: string): string | null => {
  if (value === null) return null;
  return requiredString(value, name);
};

const requiredNumber = (value: unknown, name: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`Database returned invalid ${name}.`);
  }
  return value;
};

const nullableRarity = (value: unknown): RewardRarity | null => {
  if (value === null) return null;
  if (!isOneOf(value, rewardRarities)) throw new Error('Database returned invalid rarity.');
  return value;
};

const nullableRarityPolicyVersion = (value: unknown): RarityPolicyVersion | null => {
  if (value === null) return null;
  if (!isOneOf(value, rarityPolicyVersions)) {
    throw new Error('Database returned invalid rarity policy version.');
  }
  return value;
};

const raritySnapshot = (
  row: Pick<ConfigurationRow, 'rarity' | 'rarityPolicyVersion'>,
): {
  readonly rarity: RewardRarity | null;
  readonly rarityPolicyVersion: RarityPolicyVersion | null;
} => {
  const rarity = nullableRarity(row.rarity);
  const rarityPolicyVersion = nullableRarityPolicyVersion(row.rarityPolicyVersion);
  if ((rarity === null) !== (rarityPolicyVersion === null)) {
    throw new Error('Database returned an incomplete rarity snapshot.');
  }
  return { rarity, rarityPolicyVersion };
};

const timestamp = (value: unknown, name: string): string => {
  const date = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null;
  if (date === null || Number.isNaN(date.valueOf())) {
    throw new Error(`Database returned invalid ${name}.`);
  }
  return date.toISOString();
};

const nullableTimestamp = (value: unknown, name: string): string | null =>
  value === null ? null : timestamp(value, name);

const role = (value: unknown): CreatorRole => {
  if (!isOneOf(value, ['owner', 'manager', 'editor', 'viewer'] as const)) {
    throw new Error('Database returned invalid creator role.');
  }
  return value;
};

const parseBoxVersion = (row: BoxVersionRow): BoxVersion => {
  if (!isOneOf(row.state, boxVersionStates)) {
    throw new Error('Database returned invalid box version state.');
  }
  const openingCompatibilityVersion = row.openingCompatibilityVersion;
  if (
    openingCompatibilityVersion !== null &&
    openingCompatibilityVersion !== 'opening-v1' &&
    openingCompatibilityVersion !== 'opening-v2'
  ) {
    throw new Error('Database returned invalid opening compatibility version.');
  }
  const common = {
    configurationHash: nullableString(row.configurationHash, 'configuration hash'),
    createdAt: timestamp(row.createdAt, 'box version created timestamp'),
    description: requiredString(row.description, 'box description'),
    id: requiredString(row.id, 'box version ID') as BoxVersionId,
    imageUrl: nullableString(row.imageUrl, 'box image URL'),
    name: requiredString(row.name, 'box name'),
    publishedAt: nullableTimestamp(row.publishedAt, 'box publication timestamp'),
    rngAlgorithmVersion: nullableString(row.rngAlgorithmVersion, 'RNG algorithm version'),
    state: row.state,
    totalWeight: nullableString(row.totalWeight, 'total weight'),
    updatedAt: timestamp(row.updatedAt, 'box version updated timestamp'),
    versionNumber: requiredNumber(row.versionNumber, 'box version number'),
  };
  if (openingCompatibilityVersion === 'opening-v2') {
    return {
      ...common,
      currency:
        row.currency === null
          ? null
          : (() => {
              throw new Error('opening-v2 currency must be null.');
            })(),
      maxOpeningsPerUser: requiredString(row.maxOpeningsPerUser, 'maximum openings per user'),
      openingCompatibilityVersion,
      priceMinor:
        row.priceMinor === null
          ? null
          : (() => {
              throw new Error('opening-v2 price must be null.');
            })(),
    };
  }
  if (row.maxOpeningsPerUser !== null) {
    throw new Error('Legacy box version returned a maximum openings value.');
  }
  return {
    ...common,
    currency: requiredString(row.currency, 'box currency'),
    maxOpeningsPerUser: null,
    openingCompatibilityVersion,
    priceMinor: requiredString(row.priceMinor, 'box price'),
  };
};

const parsePublicBoxVersion = (row: PublicBoxVersionRow): PublicBoxVersionRecord => ({
  boxId: requiredString(row.boxId, 'box ID') as BoxId,
  version: parseBoxVersion(row),
});

const boxVersionFromJoinedRow = (row: BoxRow): BoxVersion | null => {
  if (row.draftId === null) return null;
  return parseBoxVersion({
    configurationHash: row.draftConfigurationHash,
    createdAt: row.draftCreatedAt,
    currency: row.draftCurrency,
    description: row.draftDescription,
    id: row.draftId,
    imageUrl: row.draftImageUrl,
    maxOpeningsPerUser: row.draftMaxOpeningsPerUser,
    name: row.draftName,
    openingCompatibilityVersion: row.draftOpeningCompatibilityVersion,
    priceMinor: row.draftPriceMinor,
    publishedAt: row.draftPublishedAt,
    rngAlgorithmVersion: row.draftRngAlgorithmVersion,
    state: row.draftState,
    totalWeight: row.draftTotalWeight,
    updatedAt: row.draftUpdatedAt,
    versionNumber: row.draftVersionNumber,
  });
};

const parseBox = (row: BoxRow): Box => {
  if (!isOneOf(row.status, boxStatuses)) throw new Error('Database returned invalid box status.');
  return {
    createdAt: timestamp(row.boxCreatedAt, 'box created timestamp'),
    creatorId: requiredString(row.creatorId, 'creator ID') as CreatorId,
    currentPublishedVersionId:
      row.currentPublishedVersionId === null
        ? null
        : (requiredString(row.currentPublishedVersionId, 'published version ID') as BoxVersionId),
    draft: boxVersionFromJoinedRow(row),
    id: requiredString(row.id, 'box ID') as BoxId,
    revision: requiredNumber(row.revision, 'box revision'),
    role: role(row.role),
    status: row.status,
    updatedAt: timestamp(row.boxUpdatedAt, 'box updated timestamp'),
  };
};

const parseRewardVersion = (row: RewardVersionRow): RewardVersion => {
  if (!isOneOf(row.state, rewardVersionStates)) {
    throw new Error('Database returned invalid reward version state.');
  }
  if (!isOneOf(row.inventoryMode, inventoryModes)) {
    throw new Error('Database returned invalid inventory mode.');
  }
  if (
    row.inventoryStockoutPolicy !== null &&
    !isOneOf(row.inventoryStockoutPolicy, ['pause_box', 'backorder'] as const)
  ) {
    throw new Error('Database returned invalid inventory stockout policy.');
  }
  if (!isOneOf(row.rewardType, rewardTypes)) {
    throw new Error('Database returned invalid reward type.');
  }
  return {
    createdAt: timestamp(row.createdAt, 'reward version created timestamp'),
    declaredValueCurrency: nullableString(row.declaredValueCurrency, 'declared value currency'),
    declaredValueMinor: nullableString(row.declaredValueMinor, 'declared value'),
    description: requiredString(row.description, 'reward description'),
    id: requiredString(row.id, 'reward version ID') as RewardVersionId,
    imageUrl: nullableString(row.imageUrl, 'reward image URL'),
    inventoryMode: row.inventoryMode,
    inventoryQuantity: nullableString(row.inventoryQuantity, 'inventory quantity'),
    inventoryStockoutPolicy: row.inventoryStockoutPolicy,
    name: requiredString(row.name, 'reward name'),
    publishedAt: nullableTimestamp(row.publishedAt, 'reward publication timestamp'),
    rewardType: row.rewardType,
    state: row.state,
    updatedAt: timestamp(row.updatedAt, 'reward version updated timestamp'),
    versionNumber: requiredNumber(row.versionNumber, 'reward version number'),
  };
};

const rewardVersionFromJoinedRow = (row: RewardRow): RewardVersion | null => {
  if (row.draftId === null) return null;
  return parseRewardVersion({
    createdAt: row.draftCreatedAt,
    declaredValueCurrency: row.draftDeclaredValueCurrency,
    declaredValueMinor: row.draftDeclaredValueMinor,
    description: row.draftDescription,
    id: row.draftId,
    imageUrl: row.draftImageUrl,
    inventoryMode: row.draftInventoryMode,
    inventoryQuantity: row.draftInventoryQuantity,
    inventoryStockoutPolicy: row.draftInventoryStockoutPolicy,
    name: row.draftName,
    publishedAt: row.draftPublishedAt,
    rewardType: row.draftRewardType,
    state: row.draftState,
    updatedAt: row.draftUpdatedAt,
    versionNumber: row.draftVersionNumber,
  });
};

const parseReward = (row: RewardRow): Reward => {
  if (!isOneOf(row.status, rewardStatuses)) {
    throw new Error('Database returned invalid reward status.');
  }
  return {
    createdAt: timestamp(row.rewardCreatedAt, 'reward created timestamp'),
    creatorId: requiredString(row.creatorId, 'creator ID') as CreatorId,
    draft: rewardVersionFromJoinedRow(row),
    id: requiredString(row.id, 'reward ID') as RewardId,
    revision: requiredNumber(row.revision, 'reward revision'),
    role: role(row.role),
    status: row.status,
    updatedAt: timestamp(row.rewardUpdatedAt, 'reward updated timestamp'),
  };
};

const boxColumns = `
  b.id::text as id,
  b.creator_id::text as "creatorId",
  b.current_published_version_id::text as "currentPublishedVersionId",
  b.status,
  b.revision,
  b.created_at as "boxCreatedAt",
  b.updated_at as "boxUpdatedAt",
  membership.role,
  draft.id::text as "draftId",
  draft.version_number as "draftVersionNumber",
  draft.state as "draftState",
  draft.name as "draftName",
  draft.opening_compatibility_version as "draftOpeningCompatibilityVersion",
  draft.description as "draftDescription",
  draft.image_url as "draftImageUrl",
  draft.max_openings_per_user::text as "draftMaxOpeningsPerUser",
  draft.price_minor::text as "draftPriceMinor",
  draft.currency as "draftCurrency",
  encode(draft.configuration_hash, 'hex') as "draftConfigurationHash",
  draft.total_weight::text as "draftTotalWeight",
  draft.rng_algorithm_version as "draftRngAlgorithmVersion",
  draft.published_at as "draftPublishedAt",
  draft.created_at as "draftCreatedAt",
  draft.updated_at as "draftUpdatedAt"`;

const rewardColumns = `
  r.id::text as id,
  r.creator_id::text as "creatorId",
  r.status,
  r.revision,
  r.created_at as "rewardCreatedAt",
  r.updated_at as "rewardUpdatedAt",
  membership.role,
  draft.id::text as "draftId",
  draft.version_number as "draftVersionNumber",
  draft.state as "draftState",
  draft.name as "draftName",
  draft.description as "draftDescription",
  draft.image_url as "draftImageUrl",
  draft.reward_type as "draftRewardType",
  draft.inventory_mode as "draftInventoryMode",
  draft.inventory_quantity::text as "draftInventoryQuantity",
  draft.inventory_stockout_policy as "draftInventoryStockoutPolicy",
  draft.declared_value_minor::text as "draftDeclaredValueMinor",
  draft.declared_value_currency as "draftDeclaredValueCurrency",
  draft.published_at as "draftPublishedAt",
  draft.created_at as "draftCreatedAt",
  draft.updated_at as "draftUpdatedAt"`;

const boxVersionColumns = `
  bv.id::text as id,
  bv.version_number as "versionNumber",
  bv.state,
  bv.name,
  bv.opening_compatibility_version as "openingCompatibilityVersion",
  bv.description,
  bv.image_url as "imageUrl",
  bv.max_openings_per_user::text as "maxOpeningsPerUser",
  bv.price_minor::text as "priceMinor",
  bv.currency,
  bv.total_weight::text as "totalWeight",
  encode(bv.configuration_hash, 'hex') as "configurationHash",
  bv.rng_algorithm_version as "rngAlgorithmVersion",
  bv.published_at as "publishedAt",
  bv.created_at as "createdAt",
  bv.updated_at as "updatedAt"`;

const rewardVersionColumns = `
  rv.id::text as id,
  rv.version_number as "versionNumber",
  rv.state,
  rv.name,
  rv.description,
  rv.image_url as "imageUrl",
  rv.reward_type as "rewardType",
  rv.inventory_mode as "inventoryMode",
  rv.inventory_quantity::text as "inventoryQuantity",
  rv.inventory_stockout_policy as "inventoryStockoutPolicy",
  rv.declared_value_minor::text as "declaredValueMinor",
  rv.declared_value_currency as "declaredValueCurrency",
  rv.published_at as "publishedAt",
  rv.created_at as "createdAt",
  rv.updated_at as "updatedAt"`;

export const findCreatorCatalogRole = async (
  executor: QueryExecutor,
  creatorId: CreatorId,
  userId: UserId,
  lock: boolean,
): Promise<CreatorRole | undefined> => {
  const result = await executor.query<{ readonly role: unknown }>(
    `select membership.role
       from app.creators c
       join app.creator_memberships membership
         on membership.creator_id = c.id and membership.user_id = $2
      where c.id = $1
      ${lock ? 'for update of c' : ''}`,
    [creatorId, userId],
  );
  return result.rows[0] === undefined ? undefined : role(result.rows[0].role);
};

export const insertBoxAndDraft = async (
  executor: QueryExecutor,
  identifiers: { readonly boxId: BoxId; readonly versionId: BoxVersionId },
  creatorId: CreatorId,
  actorUserId: UserId,
  input: BoxDraftInput,
): Promise<void> => {
  await executor.query(`insert into app.boxes (id, creator_id) values ($1, $2)`, [
    identifiers.boxId,
    creatorId,
  ]);
  await executor.query(
    `insert into app.box_versions (
       id, box_id, version_number, name, description, image_url,
       price_minor, currency, max_openings_per_user,
       opening_compatibility_version, created_by_user_id
     ) values ($1, $2, 1, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      identifiers.versionId,
      identifiers.boxId,
      input.name,
      input.description,
      input.imageUrl,
      input.priceMinor?.toString() ?? null,
      input.currency,
      'maxOpeningsPerUser' in input ? input.maxOpeningsPerUser.toString() : null,
      'openingCompatibilityVersion' in input ? input.openingCompatibilityVersion : null,
      actorUserId,
    ],
  );
};

export const insertRewardAndDraft = async (
  executor: QueryExecutor,
  identifiers: { readonly rewardId: RewardId; readonly versionId: RewardVersionId },
  creatorId: CreatorId,
  actorUserId: UserId,
  input: RewardDraftInput,
): Promise<void> => {
  await executor.query(`insert into app.rewards (id, creator_id) values ($1, $2)`, [
    identifiers.rewardId,
    creatorId,
  ]);
  await executor.query(
    `insert into app.reward_versions (
       id, reward_id, version_number, name, description, image_url, reward_type,
       inventory_mode, inventory_quantity, declared_value_minor, declared_value_currency,
       inventory_stockout_policy, created_by_user_id
     ) values ($1, $2, 1, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      identifiers.versionId,
      identifiers.rewardId,
      input.name,
      input.description,
      input.imageUrl,
      input.rewardType,
      input.inventoryMode,
      input.inventoryQuantity?.toString() ?? null,
      input.declaredValueMinor?.toString() ?? null,
      input.declaredValueCurrency,
      input.inventoryStockoutPolicy,
      actorUserId,
    ],
  );
};

export const findBoxScoped = async (
  executor: QueryExecutor,
  creatorId: CreatorId,
  actorUserId: UserId,
  boxId: BoxId,
  lock = false,
): Promise<Box | undefined> => {
  const result = await executor.query<BoxRow>(
    `select ${boxColumns}
       from app.boxes b
       join app.creator_memberships membership
         on membership.creator_id = b.creator_id and membership.user_id = $2
       left join app.box_versions draft on draft.box_id = b.id and draft.state = 'draft'
      where b.creator_id = $1 and b.id = $3
      ${lock ? 'for update of b' : ''}`,
    [creatorId, actorUserId, boxId],
  );
  return result.rows[0] === undefined ? undefined : parseBox(result.rows[0]);
};

export const listBoxesScoped = async (
  executor: QueryExecutor,
  creatorId: CreatorId,
  actorUserId: UserId,
): Promise<readonly Box[]> => {
  const result = await executor.query<BoxRow>(
    `select ${boxColumns}
       from app.boxes b
       join app.creator_memberships membership
         on membership.creator_id = b.creator_id and membership.user_id = $2
       left join app.box_versions draft on draft.box_id = b.id and draft.state = 'draft'
      where b.creator_id = $1
      order by b.created_at asc, b.id asc`,
    [creatorId, actorUserId],
  );
  return result.rows.map(parseBox);
};

export const findRewardScoped = async (
  executor: QueryExecutor,
  creatorId: CreatorId,
  actorUserId: UserId,
  rewardId: RewardId,
  lock = false,
): Promise<Reward | undefined> => {
  const result = await executor.query<RewardRow>(
    `select ${rewardColumns}
       from app.rewards r
       join app.creator_memberships membership
         on membership.creator_id = r.creator_id and membership.user_id = $2
       left join app.reward_versions draft on draft.reward_id = r.id and draft.state = 'draft'
      where r.creator_id = $1 and r.id = $3
      ${lock ? 'for update of r' : ''}`,
    [creatorId, actorUserId, rewardId],
  );
  return result.rows[0] === undefined ? undefined : parseReward(result.rows[0]);
};

export const listRewardsScoped = async (
  executor: QueryExecutor,
  creatorId: CreatorId,
  actorUserId: UserId,
): Promise<readonly Reward[]> => {
  const result = await executor.query<RewardRow>(
    `select ${rewardColumns}
       from app.rewards r
       join app.creator_memberships membership
         on membership.creator_id = r.creator_id and membership.user_id = $2
       left join app.reward_versions draft on draft.reward_id = r.id and draft.state = 'draft'
      where r.creator_id = $1
      order by r.created_at asc, r.id asc`,
    [creatorId, actorUserId],
  );
  return result.rows.map(parseReward);
};

export const updateBoxDraft = async (
  executor: QueryExecutor,
  creatorId: CreatorId,
  boxId: BoxId,
  input: BoxDraftInput,
): Promise<void> => {
  const result = await executor.query(
    `update app.box_versions bv
        set name = $3, description = $4, image_url = $5,
            price_minor = $6, currency = $7, max_openings_per_user = $8,
            opening_compatibility_version = case
              when $9::text = 'opening-v2' then 'opening-v2'
              when bv.opening_compatibility_version = 'opening-v2' then null
              else bv.opening_compatibility_version
            end,
            updated_at = statement_timestamp()
       from app.boxes b
      where bv.box_id = b.id and bv.state = 'draft'
        and b.creator_id = $1 and b.id = $2`,
    [
      creatorId,
      boxId,
      input.name,
      input.description,
      input.imageUrl,
      input.priceMinor?.toString() ?? null,
      input.currency,
      'maxOpeningsPerUser' in input ? input.maxOpeningsPerUser.toString() : null,
      'openingCompatibilityVersion' in input ? input.openingCompatibilityVersion : null,
    ],
  );
  if (result.rowCount !== 1) throw new Error('Expected one scoped box draft update.');
  if ('openingCompatibilityVersion' in input) {
    await executor.query(
      `delete from app.box_version_base_rewards
        where box_version_id in (
          select bv.id
          from app.box_versions bv
          join app.boxes b on b.id = bv.box_id
          where b.creator_id = $1 and b.id = $2 and bv.state = 'draft'
        )`,
      [creatorId, boxId],
    );
  }
};

export const updateRewardDraft = async (
  executor: QueryExecutor,
  creatorId: CreatorId,
  rewardId: RewardId,
  input: RewardDraftInput,
): Promise<void> => {
  const result = await executor.query(
    `update app.reward_versions rv
        set name = $3, description = $4, image_url = $5, reward_type = $6,
            inventory_mode = $7, inventory_quantity = $8,
            declared_value_minor = $9, declared_value_currency = $10,
            inventory_stockout_policy = $11,
            updated_at = statement_timestamp()
       from app.rewards r
      where rv.reward_id = r.id and rv.state = 'draft'
        and r.creator_id = $1 and r.id = $2`,
    [
      creatorId,
      rewardId,
      input.name,
      input.description,
      input.imageUrl,
      input.rewardType,
      input.inventoryMode,
      input.inventoryQuantity?.toString() ?? null,
      input.declaredValueMinor?.toString() ?? null,
      input.declaredValueCurrency,
      input.inventoryStockoutPolicy,
    ],
  );
  if (result.rowCount !== 1) throw new Error('Expected one scoped reward draft update.');
};

export const incrementBoxRevision = async (
  executor: QueryExecutor,
  creatorId: CreatorId,
  boxId: BoxId,
): Promise<void> => {
  const result = await executor.query(
    `update app.boxes
        set revision = revision + 1, updated_at = statement_timestamp()
      where creator_id = $1 and id = $2`,
    [creatorId, boxId],
  );
  if (result.rowCount !== 1) throw new Error('Expected one scoped box revision update.');
};

export const incrementRewardRevision = async (
  executor: QueryExecutor,
  creatorId: CreatorId,
  rewardId: RewardId,
): Promise<void> => {
  const result = await executor.query(
    `update app.rewards
        set revision = revision + 1, updated_at = statement_timestamp()
      where creator_id = $1 and id = $2`,
    [creatorId, rewardId],
  );
  if (result.rowCount !== 1) throw new Error('Expected one scoped reward revision update.');
};

export const listBoxVersionsScoped = async (
  executor: QueryExecutor,
  creatorId: CreatorId,
  actorUserId: UserId,
  boxId: BoxId,
): Promise<readonly BoxVersion[]> => {
  const result = await executor.query<BoxVersionRow>(
    `select ${boxVersionColumns}
       from app.box_versions bv
       join app.boxes b on b.id = bv.box_id
       join app.creator_memberships membership
         on membership.creator_id = b.creator_id and membership.user_id = $2
      where b.creator_id = $1 and b.id = $3
      order by bv.version_number desc`,
    [creatorId, actorUserId, boxId],
  );
  return result.rows.map(parseBoxVersion);
};

export const listRewardVersionsScoped = async (
  executor: QueryExecutor,
  creatorId: CreatorId,
  actorUserId: UserId,
  rewardId: RewardId,
): Promise<readonly RewardVersion[]> => {
  const result = await executor.query<RewardVersionRow>(
    `select ${rewardVersionColumns}
       from app.reward_versions rv
       join app.rewards r on r.id = rv.reward_id
       join app.creator_memberships membership
         on membership.creator_id = r.creator_id and membership.user_id = $2
      where r.creator_id = $1 and r.id = $3
      order by rv.version_number desc`,
    [creatorId, actorUserId, rewardId],
  );
  return result.rows.map(parseRewardVersion);
};

export const listDraftConfiguration = async (
  executor: QueryExecutor,
  creatorId: CreatorId,
  boxId: BoxId,
): Promise<readonly ConfigurationEntryRecord[]> => {
  const result = await executor.query<ConfigurationRow>(
    `select
       bvr.id::text as "entryId", bvr.position, bvr.weight::text as weight,
       bvr.rarity, bvr.rarity_policy_version as "rarityPolicyVersion",
       (base.id is not null) as "isBaseReward",
       r.id::text as "rewardId", r.status as "rewardStatus",
       ${rewardVersionColumns}
       from app.boxes b
       join app.box_versions bv on bv.box_id = b.id and bv.state = 'draft'
       join app.box_version_rewards bvr on bvr.box_version_id = bv.id
       left join app.box_version_base_rewards base
         on base.box_version_id = bv.id and base.box_version_reward_id = bvr.id
       join app.reward_versions rv on rv.id = bvr.reward_version_id
       join app.rewards r on r.id = rv.reward_id
      where b.creator_id = $1 and b.id = $2
      order by bvr.position asc`,
    [creatorId, boxId],
  );
  return result.rows.map((row) => {
    if (!isOneOf(row.rewardStatus, rewardStatuses)) {
      throw new Error('Database returned invalid reward status.');
    }
    return {
      entry: {
        id: requiredString(row.entryId, 'configuration entry ID') as BoxVersionRewardId,
        isBaseReward: row.isBaseReward === true,
        position: requiredNumber(row.position, 'configuration position'),
        ...raritySnapshot(row),
        rewardVersion: parseRewardVersion(row),
        weight: requiredString(row.weight, 'configuration weight'),
      },
      rewardId: requiredString(row.rewardId, 'reward ID') as RewardId,
      rewardStatus: row.rewardStatus,
    };
  });
};

export const findRewardVersionsForCreator = async (
  executor: QueryExecutor,
  creatorId: CreatorId,
  versionIds: readonly RewardVersionId[],
): Promise<readonly RewardVersionRecord[]> => {
  if (versionIds.length === 0) return [];
  const result = await executor.query<
    RewardVersionRow & { readonly rewardId: unknown; readonly rewardStatus: unknown }
  >(
    `select r.id::text as "rewardId", r.status as "rewardStatus", ${rewardVersionColumns}
       from app.reward_versions rv
       join app.rewards r on r.id = rv.reward_id
      where r.creator_id = $1 and rv.id = any($2::uuid[])
      order by rv.id asc`,
    [creatorId, versionIds],
  );
  return result.rows.map((row) => {
    if (!isOneOf(row.rewardStatus, rewardStatuses)) {
      throw new Error('Database returned invalid reward status.');
    }
    return {
      rewardId: requiredString(row.rewardId, 'reward ID') as RewardId,
      rewardStatus: row.rewardStatus,
      version: parseRewardVersion(row),
    };
  });
};

export const replaceDraftConfiguration = async (
  executor: QueryExecutor,
  creatorId: CreatorId,
  boxId: BoxId,
  entries: readonly {
    readonly id: BoxVersionRewardId;
    readonly isBaseReward?: boolean;
    readonly rewardVersionId: RewardVersionId;
    readonly weight: ProbabilityWeight;
  }[],
  openingCompatibilityVersion: 'opening-v1' | 'opening-v2',
): Promise<void> => {
  const draft = await executor.query<{ readonly id: string }>(
    `select bv.id::text as id
       from app.box_versions bv
       join app.boxes b on b.id = bv.box_id
      where b.creator_id = $1 and b.id = $2 and bv.state = 'draft'`,
    [creatorId, boxId],
  );
  const draftId = draft.rows[0]?.id;
  if (draftId === undefined) throw new Error('Expected a scoped box draft.');
  await executor.query(`delete from app.box_version_base_rewards where box_version_id = $1`, [
    draftId,
  ]);
  await executor.query(`delete from app.box_version_rewards where box_version_id = $1`, [draftId]);
  for (const [position, entry] of entries.entries()) {
    await executor.query(
      `insert into app.box_version_rewards (
         id, box_version_id, reward_version_id, position, weight
       ) values ($1, $2, $3, $4, $5)`,
      [entry.id, draftId, entry.rewardVersionId, position, entry.weight.toString()],
    );
    if (entry.isBaseReward === true) {
      await executor.query(
        `insert into app.box_version_base_rewards (
           id, box_version_id, box_version_reward_id
         ) values ($1, $2, $1)`,
        [entry.id, draftId],
      );
    }
  }
  await executor.query(
    `update app.box_versions
        set opening_compatibility_version = $2,
            updated_at = statement_timestamp()
      where id = $1 and state = 'draft'`,
    [draftId, openingCompatibilityVersion],
  );
};

export const insertBoxDraftClone = async (
  executor: QueryExecutor,
  boxId: BoxId,
  versionId: BoxVersionId,
  actorUserId: UserId,
): Promise<void> => {
  const result = await executor.query(
    `insert into app.box_versions (
       id, box_id, version_number, name, description, image_url,
       price_minor, currency, max_openings_per_user,
       opening_compatibility_version, created_by_user_id
     )
     select $2, b.id, source.version_number + 1, source.name, source.description,
            source.image_url, source.price_minor, source.currency,
            source.max_openings_per_user, source.opening_compatibility_version, $3
       from app.boxes b
       join app.box_versions source on source.id = b.current_published_version_id
      where b.id = $1 and source.state = 'published'`,
    [boxId, versionId, actorUserId],
  );
  if (result.rowCount !== 1) throw new Error('Expected one published box version to clone.');
};

export const cloneBoxConfiguration = async (
  executor: QueryExecutor,
  sourceVersionId: BoxVersionId,
  targetVersionId: BoxVersionId,
  createEntryId: () => BoxVersionRewardId,
): Promise<void> => {
  const source = await executor.query<{
    readonly isBaseReward: boolean;
    readonly rewardVersionId: string;
    readonly weight: string;
  }>(
    `select entry.reward_version_id::text as "rewardVersionId", entry.weight::text as weight,
            (base.id is not null) as "isBaseReward"
       from app.box_version_rewards entry
       left join app.box_version_base_rewards base
         on base.box_version_id = entry.box_version_id
        and base.box_version_reward_id = entry.id
      where entry.box_version_id = $1
      order by entry.position asc`,
    [sourceVersionId],
  );
  for (const [position, entry] of source.rows.entries()) {
    const targetEntryId = createEntryId();
    await executor.query(
      `insert into app.box_version_rewards (
         id, box_version_id, reward_version_id, position, weight
       ) values ($1, $2, $3, $4, $5)`,
      [targetEntryId, targetVersionId, entry.rewardVersionId, position, entry.weight],
    );
    if (entry.isBaseReward) {
      await executor.query(
        `insert into app.box_version_base_rewards (
           id, box_version_id, box_version_reward_id
         ) values ($1, $2, $1)`,
        [targetEntryId, targetVersionId],
      );
    }
  }
};

export const insertRewardDraftClone = async (
  executor: QueryExecutor,
  rewardId: RewardId,
  versionId: RewardVersionId,
  actorUserId: UserId,
): Promise<void> => {
  const result = await executor.query(
    `insert into app.reward_versions (
       id, reward_id, version_number, name, description, image_url, reward_type,
       inventory_mode, inventory_quantity, declared_value_minor, declared_value_currency,
       inventory_stockout_policy, inventory_pool_id, fulfillment_definition, created_by_user_id
     )
     select $2, r.id, source.version_number + 1, source.name, source.description,
            source.image_url, source.reward_type, source.inventory_mode,
            source.inventory_quantity, source.declared_value_minor,
            source.declared_value_currency, source.inventory_stockout_policy,
            source.inventory_pool_id, source.fulfillment_definition, $3
       from app.rewards r
       join app.reward_versions source on source.reward_id = r.id
      where r.id = $1 and source.state = 'published'
      order by source.version_number desc
      limit 1`,
    [rewardId, versionId, actorUserId],
  );
  if (result.rowCount !== 1) throw new Error('Expected one published reward version to clone.');
};

export const lockBoxPublicationInventoryPools = async (
  transaction: TransactionExecutor,
  boxVersionId: BoxVersionId,
  creatorId: CreatorId,
): Promise<readonly LockedPublicationInventoryPool[]> => {
  assertTransactionExecutor(transaction);
  const result = await transaction.query<{
    readonly availableQuantity: unknown;
    readonly creatorId: unknown;
    readonly id: unknown;
    readonly stockoutPolicy: unknown;
  }>(
    `select id::text as id, creator_id::text as "creatorId",
            stockout_policy as "stockoutPolicy",
            available_quantity::text as "availableQuantity"
       from app.lock_box_publication_inventory_pools($1, $2)`,
    [boxVersionId, creatorId],
  );
  return result.rows.map((row) => {
    const stockoutPolicy = requiredString(row.stockoutPolicy, 'inventory stockout policy');
    const availableQuantity = BigInt(requiredString(row.availableQuantity, 'available inventory'));
    if (stockoutPolicy !== 'pause_box' || availableQuantity < 0n) {
      throw new Error('Database returned invalid publication inventory.');
    }
    return {
      availableQuantity,
      creatorId: requiredString(row.creatorId, 'inventory creator ID') as CreatorId,
      id: requiredString(row.id, 'inventory pool ID') as InventoryPoolId,
      stockoutPolicy,
    };
  });
};

export const markConfigurationRewardsPublished = async (
  executor: QueryExecutor,
  boxVersionId: BoxVersionId,
): Promise<void> => {
  await executor.query(
    `update app.reward_versions rv
        set state = 'published', published_at = statement_timestamp(),
            updated_at = statement_timestamp()
       from app.box_version_rewards bvr
      where bvr.box_version_id = $1 and bvr.reward_version_id = rv.id
        and rv.state = 'draft'`,
    [boxVersionId],
  );
};

export const snapshotConfigurationRarities = async (
  executor: QueryExecutor,
  boxVersionId: BoxVersionId,
  snapshots: readonly {
    readonly entryId: BoxVersionRewardId;
    readonly rarity: RewardRarity;
  }[],
): Promise<void> => {
  for (const snapshot of snapshots) {
    const result = await executor.query(
      `update app.box_version_rewards
          set rarity = $3, rarity_policy_version = 'rarity-v1'
        where id = $1 and box_version_id = $2
          and rarity is null and rarity_policy_version is null`,
      [snapshot.entryId, boxVersionId, snapshot.rarity],
    );
    if (result.rowCount !== 1) throw new Error('Expected one draft rarity snapshot update.');
  }
};

export const publishBoxVersion = async (
  executor: QueryExecutor,
  creatorId: CreatorId,
  boxId: BoxId,
  boxVersionId: BoxVersionId,
  totalWeight: ProbabilityWeight,
  configurationHash: string,
  algorithmVersion: string,
): Promise<void> => {
  const versionResult = await executor.query(
    `update app.box_versions bv
        set state = 'published', total_weight = $4,
            configuration_hash = decode($5, 'hex'), rng_algorithm_version = $6,
            published_at = statement_timestamp(), updated_at = statement_timestamp()
       from app.boxes b
      where bv.id = $3 and bv.box_id = b.id and bv.state = 'draft'
        and b.creator_id = $1 and b.id = $2`,
    [creatorId, boxId, boxVersionId, totalWeight.toString(), configurationHash, algorithmVersion],
  );
  if (versionResult.rowCount !== 1) throw new Error('Expected one scoped box publication.');

  const boxResult = await executor.query(
    `update app.boxes
        set current_published_version_id = $3, status = 'active',
            revision = revision + 1, updated_at = statement_timestamp()
      where creator_id = $1 and id = $2`,
    [creatorId, boxId, boxVersionId],
  );
  if (boxResult.rowCount !== 1) throw new Error('Expected one published box pointer update.');
};

export const archiveBoxScoped = async (
  executor: QueryExecutor,
  creatorId: CreatorId,
  boxId: BoxId,
): Promise<void> => {
  const result = await executor.query(
    `update app.boxes
        set status = 'archived', revision = revision + 1,
            updated_at = statement_timestamp()
      where creator_id = $1 and id = $2`,
    [creatorId, boxId],
  );
  if (result.rowCount !== 1) throw new Error('Expected one scoped box archive.');
};

export const archiveRewardScoped = async (
  executor: QueryExecutor,
  creatorId: CreatorId,
  rewardId: RewardId,
): Promise<void> => {
  const result = await executor.query(
    `update app.rewards
        set status = 'archived', revision = revision + 1,
            updated_at = statement_timestamp()
      where creator_id = $1 and id = $2`,
    [creatorId, rewardId],
  );
  if (result.rowCount !== 1) throw new Error('Expected one scoped reward archive.');
};

export const findPublicCurrentVersion = async (
  executor: QueryExecutor,
  boxId: BoxId,
): Promise<PublicBoxVersionRecord | undefined> => {
  const result = await executor.query<PublicBoxVersionRow>(
    `select bv.box_id::text as "boxId", ${boxVersionColumns}
       from app.boxes b
       join app.box_versions bv on bv.id = b.current_published_version_id
      where b.id = $1 and b.status = 'active' and bv.state = 'published'`,
    [boxId],
  );
  return result.rows[0] === undefined ? undefined : parsePublicBoxVersion(result.rows[0]);
};

export const findPublicPublishedVersion = async (
  executor: QueryExecutor,
  boxId: BoxId,
  versionId: BoxVersionId,
): Promise<PublicBoxVersionRecord | undefined> => {
  const result = await executor.query<PublicBoxVersionRow>(
    `select bv.box_id::text as "boxId", ${boxVersionColumns}
       from app.box_versions bv
      where bv.box_id = $1 and bv.id = $2 and bv.state = 'published'`,
    [boxId, versionId],
  );
  return result.rows[0] === undefined ? undefined : parsePublicBoxVersion(result.rows[0]);
};

export const listPublishedConfiguration = async (
  executor: QueryExecutor,
  boxVersionId: BoxVersionId,
): Promise<readonly ConfigurationEntryRecord[]> => {
  const result = await executor.query<ConfigurationRow>(
    `select
       bvr.id::text as "entryId", bvr.position, bvr.weight::text as weight,
       bvr.rarity, bvr.rarity_policy_version as "rarityPolicyVersion",
       (base.id is not null) as "isBaseReward",
       r.id::text as "rewardId", r.status as "rewardStatus",
       ${rewardVersionColumns}
       from app.box_version_rewards bvr
       join app.reward_versions rv on rv.id = bvr.reward_version_id
       join app.rewards r on r.id = rv.reward_id
       left join app.box_version_base_rewards base
         on base.box_version_id = bvr.box_version_id and base.box_version_reward_id = bvr.id
      where bvr.box_version_id = $1
      order by bvr.position asc`,
    [boxVersionId],
  );
  return result.rows.map((row) => ({
    entry: {
      id: requiredString(row.entryId, 'configuration entry ID') as BoxVersionRewardId,
      isBaseReward: row.isBaseReward === true,
      position: requiredNumber(row.position, 'configuration position'),
      ...raritySnapshot(row),
      rewardVersion: parseRewardVersion(row),
      weight: requiredString(row.weight, 'configuration weight'),
    },
    rewardId: requiredString(row.rewardId, 'reward ID') as RewardId,
    rewardStatus: isOneOf(row.rewardStatus, rewardStatuses)
      ? row.rewardStatus
      : (() => {
          throw new Error('Database returned invalid reward status.');
        })(),
  }));
};
