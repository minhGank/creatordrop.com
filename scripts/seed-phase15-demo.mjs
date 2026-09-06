import { parseDatabaseEnvironment } from '@creatordrop/config';
import { createDatabasePool } from '@creatordrop/database';
import { deriveRarityV1 } from '@creatordrop/domain';

import {
  parseBoxDraftInput,
  parseRewardDraftInput,
} from '../apps/api/dist/modules/catalog/catalog.schema.js';
import { createCatalogService } from '../apps/api/dist/modules/catalog/catalog.service.js';
import { parseCreateCreatorInput } from '../apps/api/dist/modules/creators/creator.schema.js';
import { createCreatorService } from '../apps/api/dist/modules/creators/creator.service.js';
import { findOrCreateUser } from '../apps/api/dist/modules/users/user.repository.js';

const demo = Object.freeze({
  box: Object.freeze({
    description: 'Development-only Phase 15 box with every rarity-v1 presentation tier.',
    id: '019f1500-0000-7000-8000-000000000200',
    name: 'Every Rarity Test Box',
    priceMinor: '100',
    versionId: '019f1500-0000-7000-8000-000000000201',
  }),
  creator: Object.freeze({
    customSlug: 'creatordrop-test',
    displayName: 'CreatorDrop Test Creator',
    handle: 'creatordrop_test',
    id: '019f1500-0000-7000-8000-000000000010',
  }),
  owner: Object.freeze({
    authProvider: 'local-demo',
    authSubject: 'phase15-rarity-owner',
    id: '019f1500-0000-7000-8000-000000000001',
    username: 'creatordrop_test_owner',
  }),
});

const rewards = Object.freeze([
  Object.freeze({
    base: true,
    description: 'Development-only common rarity presentation fixture.',
    entryId: '019f1500-0000-7000-8000-000000000301',
    id: '019f1500-0000-7000-8000-000000000101',
    name: 'Common Test Reward',
    probability: '72%',
    rarity: 'common',
    versionId: '019f1500-0000-7000-8000-000000000102',
    weight: 720n,
  }),
  Object.freeze({
    base: false,
    description: 'Development-only uncommon rarity presentation fixture.',
    entryId: '019f1500-0000-7000-8000-000000000302',
    id: '019f1500-0000-7000-8000-000000000111',
    name: 'Uncommon Test Reward',
    probability: '19%',
    rarity: 'uncommon',
    versionId: '019f1500-0000-7000-8000-000000000112',
    weight: 190n,
  }),
  Object.freeze({
    base: false,
    description: 'Development-only rare rarity presentation fixture.',
    entryId: '019f1500-0000-7000-8000-000000000303',
    id: '019f1500-0000-7000-8000-000000000121',
    name: 'Rare Test Reward',
    probability: '7%',
    rarity: 'rare',
    versionId: '019f1500-0000-7000-8000-000000000122',
    weight: 70n,
  }),
  Object.freeze({
    base: false,
    description: 'Development-only epic rarity presentation fixture.',
    entryId: '019f1500-0000-7000-8000-000000000304',
    id: '019f1500-0000-7000-8000-000000000131',
    name: 'Epic Test Reward',
    probability: '1.6%',
    rarity: 'epic',
    versionId: '019f1500-0000-7000-8000-000000000132',
    weight: 16n,
  }),
  Object.freeze({
    base: false,
    description: 'Development-only legendary rarity presentation fixture.',
    entryId: '019f1500-0000-7000-8000-000000000305',
    id: '019f1500-0000-7000-8000-000000000141',
    name: 'Legendary Test Reward',
    probability: '0.4%',
    rarity: 'legendary',
    versionId: '019f1500-0000-7000-8000-000000000142',
    weight: 4n,
  }),
]);

const totalWeight = rewards.reduce((total, reward) => total + reward.weight, 0n);
const logger = Object.freeze({ error: () => undefined, info: () => undefined });

const requireCondition = (condition, message) => {
  if (!condition) throw new Error(message);
};

const deterministicIds = (...values) => {
  let index = 0;
  return () => {
    const value = values[index];
    if (value === undefined) throw new Error('The demo seed requested an unexpected identifier.');
    index += 1;
    return value;
  };
};

const requireLocalSeedEnvironment = () => {
  if (process.env.NODE_ENV !== 'development' && process.env.NODE_ENV !== 'test') {
    throw new Error('Phase 15 demo seeding requires explicit NODE_ENV=development or test.');
  }
  const connectionString = process.env.DATABASE_URL;
  if (connectionString === undefined) {
    throw new Error('DATABASE_URL is required. Copy .env.example to .env before demo seeding.');
  }
  const url = new URL(connectionString);
  const localHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);
  requireCondition(
    localHosts.has(url.hostname) && url.port === '54322' && url.pathname === '/postgres',
    'Phase 15 demo seeding is restricted to the local Supabase PostgreSQL endpoint.',
  );
  requireCondition(
    url.searchParams.get('options') === '-c role=creatordrop_app',
    'Phase 15 demo seeding requires the restricted creatordrop_app database role.',
  );
};

const ensureOwner = async (database) => {
  const user = await database.transaction((transaction) =>
    findOrCreateUser(transaction, {
      id: demo.owner.id,
      identity: {
        provider: demo.owner.authProvider,
        subject: demo.owner.authSubject,
      },
      username: demo.owner.username,
    }),
  );
  requireCondition(
    user.id === demo.owner.id && user.username === demo.owner.username && user.status === 'active',
    'The local demo owner identity exists with unexpected data.',
  );
  return user.id;
};

const readCreator = async (database) =>
  database.query(
    `select id::text as id, handle::text as handle, custom_slug::text as "customSlug",
            display_name as "displayName", status
       from app.creators
      where id = $1 or custom_slug = $2::extensions.citext or handle = $3::extensions.citext
      order by id`,
    [demo.creator.id, demo.creator.customSlug, demo.creator.handle],
  );

const ensureCreator = async (database, ownerId) => {
  let result = await readCreator(database);
  if (result.rows.length === 0) {
    const service = createCreatorService({
      createCreatorId: () => demo.creator.id,
      database,
      logger,
    });
    await service.createCreator({
      actorUserId: ownerId,
      ...parseCreateCreatorInput({
        customSlug: demo.creator.customSlug,
        displayName: demo.creator.displayName,
        handle: demo.creator.handle,
      }),
      requestId: 'phase15-demo-seed-creator',
    });
    result = await readCreator(database);
  }
  requireCondition(result.rows.length === 1, 'The local demo creator identity is ambiguous.');
  const creator = result.rows[0];
  requireCondition(
    creator?.id === demo.creator.id &&
      creator.handle === demo.creator.handle &&
      creator.customSlug === demo.creator.customSlug &&
      creator.displayName === demo.creator.displayName &&
      creator.status === 'active',
    'The local demo creator exists with unexpected data.',
  );
  const membership = await database.query(
    `select role from app.creator_memberships where creator_id = $1 and user_id = $2`,
    [demo.creator.id, ownerId],
  );
  requireCondition(
    membership.rows.length === 1 && membership.rows[0]?.role === 'owner',
    'The local demo creator does not have its expected owner.',
  );
  return demo.creator.id;
};

const readReward = async (database, reward) =>
  database.query(
    `select reward.id::text as id, reward.creator_id::text as "creatorId",
            reward.status, version.id::text as "versionId", version.version_number as "versionNumber",
            version.state, version.name, version.description, version.image_url as "imageUrl",
            version.reward_type as "rewardType", version.inventory_mode as "inventoryMode",
            version.inventory_quantity::text as "inventoryQuantity",
            version.declared_value_minor::text as "declaredValueMinor",
            version.declared_value_currency::text as "declaredValueCurrency"
       from app.rewards as reward
       join app.reward_versions as version on version.reward_id = reward.id
      where reward.id = $1 or version.id = $2
      order by reward.id, version.version_number`,
    [reward.id, reward.versionId],
  );

const validateReward = (row, reward) => {
  requireCondition(
    row?.id === reward.id &&
      row.creatorId === demo.creator.id &&
      row.status === 'active' &&
      row.versionId === reward.versionId &&
      row.versionNumber === 1 &&
      (row.state === 'draft' || row.state === 'published') &&
      row.name === reward.name &&
      row.description === reward.description &&
      row.imageUrl === null &&
      row.rewardType === 'digital' &&
      row.inventoryMode === 'unlimited' &&
      row.inventoryQuantity === null &&
      row.declaredValueMinor === null &&
      row.declaredValueCurrency === null,
    `${reward.name} exists with unexpected data. Reset the local database before reseeding.`,
  );
};

const ensureReward = async (database, ownerId, reward) => {
  let result = await readReward(database, reward);
  if (result.rows.length === 0) {
    const service = createCatalogService({
      createId: deterministicIds(reward.id, reward.versionId),
      database,
      logger,
    });
    await service.createReward({
      actorUserId: ownerId,
      creatorId: demo.creator.id,
      ...parseRewardDraftInput({
        declaredValueCurrency: null,
        declaredValueMinor: null,
        description: reward.description,
        imageUrl: null,
        inventoryMode: 'unlimited',
        inventoryQuantity: null,
        inventoryStockoutPolicy: null,
        name: reward.name,
        rewardType: 'digital',
      }),
      requestId: `phase15-demo-seed-${reward.rarity}`,
    });
    result = await readReward(database, reward);
  }
  requireCondition(result.rows.length === 1, `${reward.name} identity is ambiguous.`);
  validateReward(result.rows[0], reward);
};

const readBoxIdentity = async (database) =>
  database.query(
    `select box.id::text as id, version.id::text as "versionId"
       from app.boxes as box
       join app.box_versions as version on version.box_id = box.id
      where box.id = $1 or version.id = $2
      order by box.id, version.version_number`,
    [demo.box.id, demo.box.versionId],
  );

const validateDraftEntries = (entries) => {
  requireCondition(entries.length === rewards.length, 'The demo box configuration is incomplete.');
  for (const [index, reward] of rewards.entries()) {
    const entry = entries[index];
    requireCondition(
      entry?.id === reward.entryId &&
        entry.position === index &&
        entry.rewardVersion.id === reward.versionId &&
        entry.weight === reward.weight.toString() &&
        entry.isBaseReward === reward.base,
      'The demo box draft configuration differs from the deterministic fixture.',
    );
  }
};

const ensureBox = async (database, ownerId) => {
  let identity = await readBoxIdentity(database);
  if (identity.rows.length === 0) {
    const service = createCatalogService({
      createId: deterministicIds(demo.box.id, demo.box.versionId),
      database,
      logger,
    });
    await service.createBox({
      actorUserId: ownerId,
      creatorId: demo.creator.id,
      ...parseBoxDraftInput({
        currency: 'USD',
        description: demo.box.description,
        imageUrl: null,
        name: demo.box.name,
        priceMinor: demo.box.priceMinor,
      }),
      requestId: 'phase15-demo-seed-box',
    });
    identity = await readBoxIdentity(database);
  }
  requireCondition(
    identity.rows.length === 1 &&
      identity.rows[0]?.id === demo.box.id &&
      identity.rows[0]?.versionId === demo.box.versionId,
    'The local demo box identity exists with unexpected version history.',
  );

  const readService = createCatalogService({ database, logger });
  let box = await readService.getBox(
    { actorUserId: ownerId, creatorId: demo.creator.id },
    demo.box.id,
  );
  requireCondition(box.creatorId === demo.creator.id, 'The demo box belongs to another creator.');
  if (box.currentPublishedVersionId === null) {
    requireCondition(
      box.status === 'draft' && box.draft?.id === demo.box.versionId,
      'The unpublished demo box has an unexpected lifecycle state.',
    );
    const existingEntries = await readService.getDraftConfiguration(
      { actorUserId: ownerId, creatorId: demo.creator.id },
      demo.box.id,
    );
    if (existingEntries.length === 0) {
      const configurationService = createCatalogService({
        createId: deterministicIds(...rewards.map(({ entryId }) => entryId)),
        database,
        logger,
      });
      const configured = await configurationService.replaceDraftConfiguration({
        actorUserId: ownerId,
        boxId: demo.box.id,
        creatorId: demo.creator.id,
        entries: rewards.map((reward) => ({
          isBaseReward: reward.base,
          rewardVersionId: reward.versionId,
          weight: reward.weight,
        })),
        expectedRevision: box.revision,
        requestId: 'phase15-demo-seed-configuration',
      });
      validateDraftEntries(configured);
      box = await readService.getBox(
        { actorUserId: ownerId, creatorId: demo.creator.id },
        demo.box.id,
      );
    } else {
      validateDraftEntries(existingEntries);
    }
    await readService.publishBox({
      actorUserId: ownerId,
      boxId: demo.box.id,
      creatorId: demo.creator.id,
      expectedRevision: box.revision,
      requestId: 'phase15-demo-seed-publication',
    });
  } else {
    requireCondition(
      box.status === 'active' &&
        box.currentPublishedVersionId === demo.box.versionId &&
        box.draft === null,
      'The published demo box has unexpected current or draft state.',
    );
  }
};

const validatePublishedDemo = async (database, ownerId) => {
  const service = createCatalogService({ database, logger });
  const box = await service.getBox(
    { actorUserId: ownerId, creatorId: demo.creator.id },
    demo.box.id,
  );
  requireCondition(
    box.status === 'active' && box.currentPublishedVersionId === demo.box.versionId,
    'The demo box is not active with its expected published version.',
  );
  const published = await service.getPublicBox(demo.box.id);
  requireCondition(
    published.version.id === demo.box.versionId &&
      published.version.state === 'published' &&
      published.version.openingCompatibilityVersion === 'opening-v1' &&
      published.version.name === demo.box.name &&
      published.version.description === demo.box.description &&
      published.version.priceMinor === demo.box.priceMinor &&
      published.version.currency === 'USD' &&
      published.manifest.totalWeight === totalWeight.toString() &&
      published.entries.length === rewards.length,
    'The published demo box does not match the Phase 15 fixture.',
  );
  for (const [index, reward] of rewards.entries()) {
    const entry = published.entries[index];
    requireCondition(
      deriveRarityV1(reward.weight, totalWeight) === reward.rarity &&
        entry?.id === reward.entryId &&
        entry.position === index &&
        entry.rewardVersion.id === reward.versionId &&
        entry.rewardVersion.name === reward.name &&
        entry.rewardVersion.inventoryMode === 'unlimited' &&
        entry.weight === reward.weight.toString() &&
        entry.isBaseReward === reward.base &&
        entry.rarity === reward.rarity &&
        entry.rarityPolicyVersion === 'rarity-v1',
      `${reward.name} did not receive its expected server-derived rarity snapshot.`,
    );
  }
  return published;
};

const printSummary = (published) => {
  const lines = [
    'Phase 15 demo catalog is ready.',
    `Owner username: ${demo.owner.username}`,
    `Creator: ${demo.creator.displayName}`,
    `Creator handle: ${demo.creator.handle}`,
    `Creator slug: ${demo.creator.customSlug}`,
    `Box: ${demo.box.name}`,
    `Box ID: ${demo.box.id}`,
    `Published version: ${published.version.id}`,
    `Configuration hash: ${published.configurationHash}`,
    'Rewards:',
    ...rewards.map(
      (reward) =>
        `- ${reward.name}: weight ${reward.weight.toString()}/${totalWeight.toString()} (${reward.probability}), ${reward.rarity}${reward.base ? ', base reward' : ''}`,
    ),
    `Open: http://localhost:5173/creators/${demo.creator.customSlug}/boxes/${demo.box.id}`,
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
};

const main = async () => {
  requireLocalSeedEnvironment();
  const databaseEnvironment = parseDatabaseEnvironment(process.env);
  const database = createDatabasePool({
    ...databaseEnvironment,
    applicationName: 'creatordrop-phase15-demo-seed',
    maxConnections: 2,
    onUnexpectedPoolError: (error) => {
      process.stderr.write(`Demo seed database pool error: ${error.name}\n`);
    },
  });
  try {
    const ownerId = await ensureOwner(database);
    await ensureCreator(database, ownerId);
    for (const reward of rewards) await ensureReward(database, ownerId, reward);
    await ensureBox(database, ownerId);
    printSummary(await validatePublishedDemo(database, ownerId));
  } finally {
    await database.close();
  }
};

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : 'Unknown demo seed failure.';
  process.stderr.write(`Phase 15 demo seed failed: ${message}\n`);
  process.exitCode = 1;
}
