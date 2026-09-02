import { v7 as uuidv7 } from 'uuid';

import type { Database, QueryExecutor } from '@creatordrop/database';
import type { Logger } from '@creatordrop/observability';
import { publicCatalogCacheKeys } from '@creatordrop/redis-projections';

import { canPerformCreatorAction, type CreatorAction } from '../creators/creator.policy.js';
import type { CreatorId, CreatorRole, UserId } from '../creators/creator.js';
import {
  CatalogDraftConflictError,
  CatalogPermissionDeniedError,
  CatalogPublicationError,
  CatalogResourceNotFoundError,
  CatalogRevisionConflictError,
} from './catalog.errors.js';
import {
  parseCachedPublishedCatalog,
  type CatalogCache,
  type CatalogCacheIdentity,
} from './catalog.cache.js';
import {
  createPublishedManifest,
  hashPublishedManifest,
  rngAlgorithmVersion,
  totalProbabilityWeight,
} from './catalog.manifest.js';
import {
  archiveBoxScoped,
  archiveRewardScoped,
  cloneBoxConfiguration,
  findBoxScoped,
  findCreatorCatalogRole,
  findPublicCurrentVersion,
  findPublicPublishedVersion,
  findRewardScoped,
  findRewardVersionsForCreator,
  incrementBoxRevision,
  incrementRewardRevision,
  insertBoxAndDraft,
  insertBoxDraftClone,
  insertRewardAndDraft,
  insertRewardDraftClone,
  listBoxesScoped,
  listBoxVersionsScoped,
  listDraftConfiguration,
  listPublishedConfiguration,
  listRewardsScoped,
  listRewardVersionsScoped,
  lockBoxPublicationInventoryPools,
  markConfigurationRewardsPublished,
  publishBoxVersion,
  replaceDraftConfiguration,
  updateBoxDraft,
  updateRewardDraft,
  type ConfigurationEntryRecord,
} from './catalog.repository.js';
import type { BoxDraftInput, RewardDraftInput } from './catalog.schema.js';
import type {
  Box,
  BoxId,
  BoxVersion,
  BoxVersionId,
  BoxVersionRewardId,
  DraftRewardEntry,
  MoneyMinor,
  ProbabilityWeight,
  PublishedManifest,
  Reward,
  RewardId,
  RewardVersion,
  RewardVersionId,
} from './catalog.js';

interface AuditContext {
  readonly actorUserId: UserId;
  readonly requestId: string;
}

interface CreatorCommand extends AuditContext {
  readonly creatorId: CreatorId;
}

export interface CreateBoxCommand extends CreatorCommand, BoxDraftInput {}
export interface CreateRewardCommand extends CreatorCommand, RewardDraftInput {}

export interface BoxCommand extends CreatorCommand {
  readonly boxId: BoxId;
}

export interface RewardCommand extends CreatorCommand {
  readonly rewardId: RewardId;
}

export interface UpdateBoxCommand extends BoxCommand, BoxDraftInput {
  readonly expectedRevision: number;
}

export interface UpdateRewardCommand extends RewardCommand, RewardDraftInput {
  readonly expectedRevision: number;
}

export interface ReplaceConfigurationCommand extends BoxCommand {
  readonly entries: readonly {
    readonly isBaseReward: boolean;
    readonly rewardVersionId: RewardVersionId;
    readonly weight: ProbabilityWeight;
  }[];
  readonly expectedRevision: number;
}

export interface RevisionedBoxCommand extends BoxCommand {
  readonly expectedRevision: number;
}

export interface RevisionedRewardCommand extends RewardCommand {
  readonly expectedRevision: number;
}

export interface CatalogReadScope {
  readonly actorUserId: UserId;
  readonly creatorId: CreatorId;
}

export interface PublishedCatalogVersion {
  readonly configurationHash: string;
  readonly entries: readonly DraftRewardEntry[];
  readonly manifest: PublishedManifest;
  readonly version: BoxVersion;
}

export interface CatalogService {
  archiveBox(command: RevisionedBoxCommand): Promise<Box>;
  archiveReward(command: RevisionedRewardCommand): Promise<Reward>;
  createBox(command: CreateBoxCommand): Promise<Box>;
  createReward(command: CreateRewardCommand): Promise<Reward>;
  getBox(scope: CatalogReadScope, boxId: BoxId): Promise<Box>;
  getDraftConfiguration(
    scope: CatalogReadScope,
    boxId: BoxId,
  ): Promise<readonly DraftRewardEntry[]>;
  getPublicBox(boxId: BoxId): Promise<PublishedCatalogVersion>;
  getPublicBoxVersion(boxId: BoxId, versionId: BoxVersionId): Promise<PublishedCatalogVersion>;
  getReward(scope: CatalogReadScope, rewardId: RewardId): Promise<Reward>;
  listBoxes(scope: CatalogReadScope): Promise<readonly Box[]>;
  listBoxVersions(scope: CatalogReadScope, boxId: BoxId): Promise<readonly BoxVersion[]>;
  listRewards(scope: CatalogReadScope): Promise<readonly Reward[]>;
  listRewardVersions(
    scope: CatalogReadScope,
    rewardId: RewardId,
  ): Promise<readonly RewardVersion[]>;
  publishBox(command: RevisionedBoxCommand): Promise<PublishedCatalogVersion>;
  replaceDraftConfiguration(
    command: ReplaceConfigurationCommand,
  ): Promise<readonly DraftRewardEntry[]>;
  updateBox(command: UpdateBoxCommand): Promise<Box>;
  updateReward(command: UpdateRewardCommand): Promise<Reward>;
}

export interface CatalogServiceOptions {
  readonly cache?: CatalogCache;
  readonly createId?: () => string;
  readonly database: Database;
  readonly logger: Logger;
}

const asBoxId = (value: string): BoxId => value as BoxId;
const asBoxVersionId = (value: string): BoxVersionId => value as BoxVersionId;
const asEntryId = (value: string): BoxVersionRewardId => value as BoxVersionRewardId;
const asRewardId = (value: string): RewardId => value as RewardId;
const asRewardVersionId = (value: string): RewardVersionId => value as RewardVersionId;
const asWeight = (value: string): ProbabilityWeight => BigInt(value) as ProbabilityWeight;
const asMoney = (value: string): MoneyMinor => BigInt(value) as MoneyMinor;

const requireCreatorPermission = async (
  executor: QueryExecutor,
  creatorId: CreatorId,
  actorUserId: UserId,
  action: CreatorAction,
  lock: boolean,
): Promise<CreatorRole> => {
  const role = await findCreatorCatalogRole(executor, creatorId, actorUserId, lock);
  if (role === undefined) throw new CatalogResourceNotFoundError();
  if (!canPerformCreatorAction(role, action)) throw new CatalogPermissionDeniedError();
  return role;
};

const requireBox = async (
  executor: QueryExecutor,
  scope: CatalogReadScope,
  boxId: BoxId,
  action: CreatorAction,
  lock: boolean,
): Promise<Box> => {
  const box = await findBoxScoped(executor, scope.creatorId, scope.actorUserId, boxId, lock);
  if (box === undefined) throw new CatalogResourceNotFoundError();
  if (!canPerformCreatorAction(box.role, action)) throw new CatalogPermissionDeniedError();
  return box;
};

const requireReward = async (
  executor: QueryExecutor,
  scope: CatalogReadScope,
  rewardId: RewardId,
  action: CreatorAction,
  lock: boolean,
): Promise<Reward> => {
  const reward = await findRewardScoped(
    executor,
    scope.creatorId,
    scope.actorUserId,
    rewardId,
    lock,
  );
  if (reward === undefined) throw new CatalogResourceNotFoundError();
  if (!canPerformCreatorAction(reward.role, action)) throw new CatalogPermissionDeniedError();
  return reward;
};

const requireRevision = (actual: number, expected: number): void => {
  if (actual !== expected) throw new CatalogRevisionConflictError(actual);
};

const ensureEditableBox = (box: Box): void => {
  if (box.status === 'archived') {
    throw new CatalogDraftConflictError('Archived boxes cannot be edited or published.');
  }
};

const ensureEditableReward = (reward: Reward): void => {
  if (reward.status === 'archived') {
    throw new CatalogDraftConflictError('Archived rewards cannot be edited.');
  }
};

const createBoxDraftIfMissing = async (
  transaction: QueryExecutor,
  box: Box,
  actorUserId: UserId,
  createId: () => string,
): Promise<BoxVersionId> => {
  if (box.draft !== null) return box.draft.id;
  if (box.currentPublishedVersionId === null) {
    throw new CatalogDraftConflictError('The box has no draft or published version to edit.');
  }
  const versionId = asBoxVersionId(createId());
  await insertBoxDraftClone(transaction, box.id, versionId, actorUserId);
  await cloneBoxConfiguration(transaction, box.currentPublishedVersionId, versionId, () =>
    asEntryId(createId()),
  );
  return versionId;
};

const createRewardDraftIfMissing = async (
  transaction: QueryExecutor,
  reward: Reward,
  actorUserId: UserId,
  createId: () => string,
): Promise<RewardVersionId> => {
  if (reward.draft !== null) return reward.draft.id;
  const versionId = asRewardVersionId(createId());
  await insertRewardDraftClone(transaction, reward.id, versionId, actorUserId);
  return versionId;
};

const buildPublishedCatalog = async (
  executor: QueryExecutor,
  boxId: BoxId,
  version: BoxVersion,
): Promise<PublishedCatalogVersion> => {
  if (
    version.state !== 'published' ||
    version.configurationHash === null ||
    version.totalWeight === null ||
    version.rngAlgorithmVersion !== rngAlgorithmVersion
  ) {
    throw new Error('Published box version is internally inconsistent.');
  }
  const records = await listPublishedConfiguration(executor, version.id);
  const manifest = createPublishedManifest({
    boxId,
    boxVersionId: version.id,
    currency: version.currency,
    entries: records.map(({ entry }) => ({
      id: entry.id,
      position: entry.position,
      rewardVersionId: entry.rewardVersion.id,
      weight: asWeight(entry.weight),
    })),
    priceMinor: asMoney(version.priceMinor),
  });
  const hash = hashPublishedManifest(manifest);
  if (manifest.totalWeight !== version.totalWeight || hash !== version.configurationHash) {
    throw new Error('Published manifest does not match its stored integrity metadata.');
  }
  return {
    configurationHash: hash,
    entries: records.map(({ entry }) => entry),
    manifest,
    version,
  };
};

const validatePublicationEntries = (records: readonly ConfigurationEntryRecord[]): void => {
  if (records.length === 0) {
    throw new CatalogPublicationError(
      'EMPTY_CONFIGURATION',
      'A box draft requires at least one reward before publication.',
    );
  }
  if (records.filter(({ entry }) => entry.isBaseReward).length !== 1) {
    throw new CatalogPublicationError(
      'BASE_REWARD_INVALID',
      'An opening-v1 box draft requires exactly one explicitly designated base reward.',
    );
  }
  for (const { entry, rewardStatus } of records) {
    if (rewardStatus !== 'active' || !['draft', 'published'].includes(entry.rewardVersion.state)) {
      throw new CatalogPublicationError(
        'INELIGIBLE_REWARD',
        'Every configured reward must be active and publishable.',
      );
    }
    if (
      entry.rewardVersion.inventoryMode === 'finite' &&
      (entry.rewardVersion.inventoryQuantity === null ||
        BigInt(entry.rewardVersion.inventoryQuantity) <= 0n)
    ) {
      throw new CatalogPublicationError(
        'INVALID_INVENTORY',
        'Finite rewards included in a published box require positive configured inventory.',
      );
    }
  }
};

export const createCatalogService = ({
  cache,
  createId = uuidv7,
  database,
  logger,
}: CatalogServiceOptions): CatalogService => {
  const readCache = async (
    key: string,
    identity: CatalogCacheIdentity,
  ): Promise<PublishedCatalogVersion | undefined> => {
    if (cache === undefined) return undefined;
    try {
      const value = await cache.redis.get(key);
      return value === undefined ? undefined : parseCachedPublishedCatalog(value, identity);
    } catch (error) {
      logger.info('catalog.cache.read_failed', {
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
      try {
        await cache.redis.delete(key);
      } catch {
        // Redis is disposable; PostgreSQL remains the read authority.
      }
      return undefined;
    }
  };
  const writeCache = async (
    keys: readonly string[],
    value: PublishedCatalogVersion,
  ): Promise<void> => {
    if (cache === undefined) return;
    try {
      await Promise.all(keys.map((key) => cache.redis.set(key, value, cache.ttlSeconds)));
    } catch (error) {
      logger.info('catalog.cache.write_failed', {
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
    }
  };
  const invalidateCurrent = async (boxId: BoxId): Promise<void> => {
    if (cache === undefined) return;
    try {
      await cache.redis.delete(publicCatalogCacheKeys.currentBox(boxId));
    } catch (error) {
      logger.info('catalog.cache.invalidation_failed', {
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
    }
  };

  return {
    createBox: async (command) => {
      const boxId = asBoxId(createId());
      const versionId = asBoxVersionId(createId());
      await database.transaction(async (transaction) => {
        await requireCreatorPermission(
          transaction,
          command.creatorId,
          command.actorUserId,
          'catalog.draft.write',
          true,
        );
        await insertBoxAndDraft(
          transaction,
          { boxId, versionId },
          command.creatorId,
          command.actorUserId,
          command,
        );
      });
      const box = await findBoxScoped(database, command.creatorId, command.actorUserId, boxId);
      if (box === undefined) throw new Error('Created box was not found.');
      logger.info('catalog.audit', {
        action: 'box.created',
        actorUserId: command.actorUserId,
        boxId,
        creatorId: command.creatorId,
        requestId: command.requestId,
        revision: box.revision,
      });
      return box;
    },

    listBoxes: async (scope) => {
      await requireCreatorPermission(
        database,
        scope.creatorId,
        scope.actorUserId,
        'catalog.view',
        false,
      );
      return listBoxesScoped(database, scope.creatorId, scope.actorUserId);
    },

    getBox: (scope, boxId) => requireBox(database, scope, boxId, 'catalog.view', false),

    updateBox: async (command) => {
      await database.transaction(async (transaction) => {
        await requireCreatorPermission(
          transaction,
          command.creatorId,
          command.actorUserId,
          'catalog.draft.write',
          true,
        );
        const box = await requireBox(
          transaction,
          command,
          command.boxId,
          'catalog.draft.write',
          true,
        );
        requireRevision(box.revision, command.expectedRevision);
        ensureEditableBox(box);
        await createBoxDraftIfMissing(transaction, box, command.actorUserId, createId);
        await updateBoxDraft(transaction, command.creatorId, command.boxId, command);
        await incrementBoxRevision(transaction, command.creatorId, command.boxId);
      });
      const box = await findBoxScoped(
        database,
        command.creatorId,
        command.actorUserId,
        command.boxId,
      );
      if (box === undefined) throw new Error('Updated box was not found.');
      return box;
    },

    createReward: async (command) => {
      const rewardId = asRewardId(createId());
      const versionId = asRewardVersionId(createId());
      await database.transaction(async (transaction) => {
        await requireCreatorPermission(
          transaction,
          command.creatorId,
          command.actorUserId,
          'catalog.draft.write',
          true,
        );
        await insertRewardAndDraft(
          transaction,
          { rewardId, versionId },
          command.creatorId,
          command.actorUserId,
          command,
        );
      });
      const reward = await findRewardScoped(
        database,
        command.creatorId,
        command.actorUserId,
        rewardId,
      );
      if (reward === undefined) throw new Error('Created reward was not found.');
      logger.info('catalog.audit', {
        action: 'reward.created',
        actorUserId: command.actorUserId,
        creatorId: command.creatorId,
        requestId: command.requestId,
        rewardId,
        revision: reward.revision,
      });
      return reward;
    },

    listRewards: async (scope) => {
      await requireCreatorPermission(
        database,
        scope.creatorId,
        scope.actorUserId,
        'catalog.view',
        false,
      );
      return listRewardsScoped(database, scope.creatorId, scope.actorUserId);
    },

    getReward: (scope, rewardId) => requireReward(database, scope, rewardId, 'catalog.view', false),

    updateReward: async (command) => {
      await database.transaction(async (transaction) => {
        await requireCreatorPermission(
          transaction,
          command.creatorId,
          command.actorUserId,
          'catalog.draft.write',
          true,
        );
        const reward = await requireReward(
          transaction,
          command,
          command.rewardId,
          'catalog.draft.write',
          true,
        );
        requireRevision(reward.revision, command.expectedRevision);
        ensureEditableReward(reward);
        await createRewardDraftIfMissing(transaction, reward, command.actorUserId, createId);
        await updateRewardDraft(transaction, command.creatorId, command.rewardId, command);
        await incrementRewardRevision(transaction, command.creatorId, command.rewardId);
      });
      const reward = await findRewardScoped(
        database,
        command.creatorId,
        command.actorUserId,
        command.rewardId,
      );
      if (reward === undefined) throw new Error('Updated reward was not found.');
      return reward;
    },

    getDraftConfiguration: async (scope, boxId) => {
      await requireBox(database, scope, boxId, 'catalog.view', false);
      return (await listDraftConfiguration(database, scope.creatorId, boxId)).map(
        ({ entry }) => entry,
      );
    },

    replaceDraftConfiguration: async (command) => {
      await database.transaction(async (transaction) => {
        await requireCreatorPermission(
          transaction,
          command.creatorId,
          command.actorUserId,
          'catalog.draft.write',
          true,
        );
        const box = await requireBox(
          transaction,
          command,
          command.boxId,
          'catalog.draft.write',
          true,
        );
        requireRevision(box.revision, command.expectedRevision);
        ensureEditableBox(box);
        await createBoxDraftIfMissing(transaction, box, command.actorUserId, createId);
        const requestedIds = command.entries.map(({ rewardVersionId }) => rewardVersionId);
        const versions = await findRewardVersionsForCreator(
          transaction,
          command.creatorId,
          requestedIds,
        );
        if (
          versions.length !== requestedIds.length ||
          versions.some(
            ({ rewardStatus, version }) =>
              rewardStatus !== 'active' || !['draft', 'published'].includes(version.state),
          )
        ) {
          throw new CatalogDraftConflictError(
            'Every configured reward version must be active and belong to this creator.',
          );
        }
        await replaceDraftConfiguration(
          transaction,
          command.creatorId,
          command.boxId,
          command.entries.map((entry) => ({ ...entry, id: asEntryId(createId()) })),
        );
        await incrementBoxRevision(transaction, command.creatorId, command.boxId);
      });
      logger.info('catalog.audit', {
        action: 'box.draft_configuration_replaced',
        actorUserId: command.actorUserId,
        boxId: command.boxId,
        creatorId: command.creatorId,
        entryCount: command.entries.length,
        requestId: command.requestId,
      });
      return (await listDraftConfiguration(database, command.creatorId, command.boxId)).map(
        ({ entry }) => entry,
      );
    },

    publishBox: async (command) => {
      const publishedVersion = await database.transaction(async (transaction) => {
        await requireCreatorPermission(
          transaction,
          command.creatorId,
          command.actorUserId,
          'catalog.publish',
          true,
        );
        const preflightBox = await requireBox(
          transaction,
          command,
          command.boxId,
          'catalog.publish',
          false,
        );
        requireRevision(preflightBox.revision, command.expectedRevision);
        ensureEditableBox(preflightBox);
        if (preflightBox.draft === null)
          throw new CatalogDraftConflictError('The box has no draft to publish.');
        const preflightRecords = await listDraftConfiguration(
          transaction,
          command.creatorId,
          command.boxId,
        );
        validatePublicationEntries(preflightRecords);
        const lockedInventory = await lockBoxPublicationInventoryPools(
          transaction,
          preflightBox.draft.id,
          command.creatorId,
        );
        if (lockedInventory.some(({ availableQuantity }) => availableQuantity <= 0n)) {
          throw new CatalogPublicationError(
            'INVALID_INVENTORY',
            'Finite pause-box inventory must be currently available before publication.',
          );
        }

        const box = await requireBox(transaction, command, command.boxId, 'catalog.publish', true);
        requireRevision(box.revision, command.expectedRevision);
        ensureEditableBox(box);
        const lockedDraft = box.draft;
        if (lockedDraft?.id !== preflightBox.draft.id) {
          throw new CatalogRevisionConflictError(box.revision);
        }
        const records = await listDraftConfiguration(transaction, command.creatorId, command.boxId);
        validatePublicationEntries(records);
        if (lockedDraft.openingCompatibilityVersion !== 'opening-v1') {
          throw new CatalogPublicationError(
            'BASE_REWARD_INVALID',
            'Legacy drafts must be explicitly reconfigured before they can be published for opening.',
          );
        }
        const manifest = createPublishedManifest({
          boxId: box.id,
          boxVersionId: lockedDraft.id,
          currency: lockedDraft.currency,
          entries: records.map(({ entry }) => ({
            id: entry.id,
            position: entry.position,
            rewardVersionId: entry.rewardVersion.id,
            weight: asWeight(entry.weight),
          })),
          priceMinor: asMoney(lockedDraft.priceMinor),
        });
        const totalWeight = totalProbabilityWeight(
          records.map(({ entry }) => ({
            id: entry.id,
            position: entry.position,
            rewardVersionId: entry.rewardVersion.id,
            weight: asWeight(entry.weight),
          })),
        );
        const configurationHash = hashPublishedManifest(manifest);
        await markConfigurationRewardsPublished(transaction, lockedDraft.id);
        await publishBoxVersion(
          transaction,
          command.creatorId,
          command.boxId,
          lockedDraft.id,
          totalWeight,
          configurationHash,
          rngAlgorithmVersion,
        );
        return lockedDraft;
      });

      const published = await findPublicPublishedVersion(
        database,
        command.boxId,
        publishedVersion.id,
      );
      if (published === undefined) throw new Error('Published version was not found.');
      const catalog = await buildPublishedCatalog(database, published.boxId, published.version);
      logger.info('catalog.audit', {
        action: 'box.published',
        actorUserId: command.actorUserId,
        boxId: command.boxId,
        boxVersionId: published.version.id,
        configurationHash: catalog.configurationHash,
        creatorId: command.creatorId,
        requestId: command.requestId,
        totalWeight: catalog.manifest.totalWeight,
      });
      await invalidateCurrent(command.boxId);
      await writeCache(
        [
          publicCatalogCacheKeys.currentBox(command.boxId),
          publicCatalogCacheKeys.version(command.boxId, published.version.id),
        ],
        catalog,
      );
      return catalog;
    },

    listBoxVersions: async (scope, boxId) => {
      await requireBox(database, scope, boxId, 'catalog.view', false);
      return listBoxVersionsScoped(database, scope.creatorId, scope.actorUserId, boxId);
    },

    listRewardVersions: async (scope, rewardId) => {
      await requireReward(database, scope, rewardId, 'catalog.view', false);
      return listRewardVersionsScoped(database, scope.creatorId, scope.actorUserId, rewardId);
    },

    getPublicBox: async (boxId) => {
      const key = publicCatalogCacheKeys.currentBox(boxId);
      const cached = await readCache(key, { boxId });
      if (cached !== undefined) return cached;
      const published = await findPublicCurrentVersion(database, boxId);
      if (published === undefined) throw new CatalogResourceNotFoundError();
      const catalog = await buildPublishedCatalog(database, published.boxId, published.version);
      await writeCache(
        [key, publicCatalogCacheKeys.version(published.boxId, published.version.id)],
        catalog,
      );
      return catalog;
    },

    getPublicBoxVersion: async (boxId, versionId) => {
      const key = publicCatalogCacheKeys.version(boxId, versionId);
      const cached = await readCache(key, { boxId, versionId });
      if (cached !== undefined) return cached;
      const published = await findPublicPublishedVersion(database, boxId, versionId);
      if (published === undefined) throw new CatalogResourceNotFoundError();
      const catalog = await buildPublishedCatalog(database, published.boxId, published.version);
      await writeCache([key], catalog);
      return catalog;
    },

    archiveBox: async (command) => {
      await database.transaction(async (transaction) => {
        await requireCreatorPermission(
          transaction,
          command.creatorId,
          command.actorUserId,
          'catalog.archive',
          true,
        );
        const box = await requireBox(transaction, command, command.boxId, 'catalog.archive', true);
        requireRevision(box.revision, command.expectedRevision);
        await archiveBoxScoped(transaction, command.creatorId, command.boxId);
      });
      const box = await findBoxScoped(
        database,
        command.creatorId,
        command.actorUserId,
        command.boxId,
      );
      if (box === undefined) throw new Error('Archived box was not found.');
      logger.info('catalog.audit', {
        action: 'box.archived',
        actorUserId: command.actorUserId,
        boxId: command.boxId,
        creatorId: command.creatorId,
        requestId: command.requestId,
        revision: box.revision,
      });
      await invalidateCurrent(command.boxId);
      return box;
    },

    archiveReward: async (command) => {
      await database.transaction(async (transaction) => {
        await requireCreatorPermission(
          transaction,
          command.creatorId,
          command.actorUserId,
          'catalog.archive',
          true,
        );
        const reward = await requireReward(
          transaction,
          command,
          command.rewardId,
          'catalog.archive',
          true,
        );
        requireRevision(reward.revision, command.expectedRevision);
        await archiveRewardScoped(transaction, command.creatorId, command.rewardId);
      });
      const reward = await findRewardScoped(
        database,
        command.creatorId,
        command.actorUserId,
        command.rewardId,
      );
      if (reward === undefined) throw new Error('Archived reward was not found.');
      logger.info('catalog.audit', {
        action: 'reward.archived',
        actorUserId: command.actorUserId,
        creatorId: command.creatorId,
        requestId: command.requestId,
        rewardId: command.rewardId,
        revision: reward.revision,
      });
      return reward;
    },
  };
};
