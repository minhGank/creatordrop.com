import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { parseDatabaseEnvironment, parseMigrationEnvironment } from '@creatordrop/config';
import type { PublishedBoxVersionResponse } from '@creatordrop/contracts';
import { createDatabasePool, type Database } from '@creatordrop/database';
import type { LogAttributes, Logger } from '@creatordrop/observability';
import { publicCatalogCacheKeys, type RedisJsonCache } from '@creatordrop/redis-projections';

import { createApp } from '../src/app.js';
import { createAuthenticationMiddleware } from '../src/modules/auth/authentication.middleware.js';
import { createJwtVerifier } from '../src/modules/auth/jwt-verifier.js';
import { createCatalogService } from '../src/modules/catalog/catalog.service.js';
import { hashPublishedManifest } from '../src/modules/catalog/catalog.manifest.js';
import { createPublicCatalogService } from '../src/modules/catalog/public-catalog.service.js';
import { createCreatorService } from '../src/modules/creators/creator.service.js';
import { createOpeningEntitlementOperatorService } from '../src/modules/entitlements/opening-entitlement.service.js';
import { createUserBootstrapService } from '../src/modules/users/bootstrap-user.service.js';
import { createUnhandledFairnessService } from './support/test-app.js';

const localApplicationUrl =
  'postgresql://postgres:postgres@127.0.0.1:54322/postgres?options=-c%20role%3Dcreatordrop_app';
const localMigrationUrl = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

const requireEnvironment = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Required integration environment ${name} is missing.`);
  }
  return value;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

interface LocalAuthIdentity {
  readonly accessToken: string;
  readonly subject: string;
}

interface TestActor extends LocalAuthIdentity {
  readonly userId: string;
}

interface TestCreator {
  readonly customSlug: string;
  readonly handle: string;
  readonly id: string;
}

interface TestBox {
  readonly draftId: string;
  readonly id: string;
  readonly revision: number;
}

interface TestReward {
  readonly draftId: string;
  readonly id: string;
  readonly revision: number;
}

interface AuditRecord {
  readonly attributes: LogAttributes | undefined;
  readonly message: string;
}

const parseLocalAuthIdentity = (body: unknown): LocalAuthIdentity => {
  if (
    !isRecord(body) ||
    typeof body.access_token !== 'string' ||
    !isRecord(body.user) ||
    typeof body.user.id !== 'string'
  ) {
    throw new Error('Local Supabase Auth returned an unexpected sign-up response.');
  }
  return { accessToken: body.access_token, subject: body.user.id };
};

describe('box and reward catalog publication', { concurrent: false }, () => {
  const apiUrl = requireEnvironment('LOCAL_SUPABASE_API_URL').replace(/\/$/u, '');
  const publishableKey = requireEnvironment('LOCAL_SUPABASE_PUBLISHABLE_KEY');
  const authIssuer = `${apiUrl}/auth/v1`;
  const applicationEnvironment = parseDatabaseEnvironment({
    DATABASE_APPLICATION_NAME: 'creatordrop-catalog-integration-test',
    DATABASE_CONNECTION_TIMEOUT_MS: '5000',
    DATABASE_IDLE_TIMEOUT_MS: '1000',
    DATABASE_POOL_MAX: '20',
    DATABASE_URL: process.env.DATABASE_URL ?? localApplicationUrl,
  });
  const migrationEnvironment = parseMigrationEnvironment({
    DATABASE_MIGRATION_URL: process.env.DATABASE_MIGRATION_URL ?? localMigrationUrl,
  });
  const auditRecords: AuditRecord[] = [];
  const cacheRecords = new Map<string, unknown>();
  let cacheAvailable = true;
  const catalogCache: RedisJsonCache = {
    delete: (key) => {
      if (!cacheAvailable) throw new Error('Synthetic Redis unavailable.');
      cacheRecords.delete(key);
      return Promise.resolve();
    },
    get: (key) => {
      if (!cacheAvailable) throw new Error('Synthetic Redis unavailable.');
      return Promise.resolve(cacheRecords.get(key));
    },
    set: (key, value) => {
      if (!cacheAvailable) throw new Error('Synthetic Redis unavailable.');
      cacheRecords.set(key, JSON.parse(JSON.stringify(value)) as unknown);
      return Promise.resolve();
    },
  };
  const logger: Logger = {
    error: (message, attributes) => auditRecords.push({ attributes, message }),
    info: (message, attributes) => auditRecords.push({ attributes, message }),
  };
  let applicationDatabase: Database;
  let migrationDatabase: Database;
  let app: ReturnType<typeof createApp>;

  const authorization = (actor: TestActor): { readonly Authorization: string } => ({
    Authorization: `Bearer ${actor.accessToken}`,
  });

  const removeSyntheticState = async (): Promise<void> => {
    await migrationDatabase.transaction(async (transaction) => {
      await transaction.query(`set local session_replication_role = replica`);
      await transaction.query(`
        delete from app.opening_entitlement_consumptions as consumption
         where exists (
           select 1 from app.creators as creator
            where creator.id = consumption.creator_id and left(creator.handle::text, 3) = 'p5_'
         )
      `);
      await transaction.query(`
        delete from app.opening_entitlement_grants as grant_row
         where exists (
           select 1 from app.creators as creator
            where creator.id = grant_row.creator_id and left(creator.handle::text, 3) = 'p5_'
         )
      `);
      await transaction.query(`
        update app.boxes b
           set current_published_version_id = null
         where exists (
           select 1 from app.creators c
            where c.id = b.creator_id and left(c.handle::text, 3) = 'p5_'
         )
      `);
      await transaction.query(`
        delete from app.box_version_rewards bvr
         where exists (
           select 1
             from app.box_versions bv
             join app.boxes b on b.id = bv.box_id
             join app.creators c on c.id = b.creator_id
            where bv.id = bvr.box_version_id and left(c.handle::text, 3) = 'p5_'
         )
      `);
      await transaction.query(`
        delete from app.box_versions bv
         where exists (
           select 1
             from app.boxes b
             join app.creators c on c.id = b.creator_id
            where b.id = bv.box_id and left(c.handle::text, 3) = 'p5_'
         )
      `);
      await transaction.query(`
        delete from app.boxes b
         where exists (
           select 1 from app.creators c
            where c.id = b.creator_id and left(c.handle::text, 3) = 'p5_'
         )
      `);
      await transaction.query(`
        delete from app.reward_versions rv
         where exists (
           select 1
             from app.rewards r
             join app.creators c on c.id = r.creator_id
            where r.id = rv.reward_id and left(c.handle::text, 3) = 'p5_'
         )
      `);
      await transaction.query(`
        delete from app.rewards r
         where exists (
           select 1 from app.creators c
            where c.id = r.creator_id and left(c.handle::text, 3) = 'p5_'
         )
      `);
      await transaction.query(`
        delete from app.creator_memberships
         where creator_id in (
           select id from app.creators where left(handle::text, 3) = 'p5_'
         )
      `);
      await transaction.query(`delete from app.creators where left(handle::text, 3) = 'p5_'`);
    });
    await migrationDatabase.query(`
      delete from app.users
       where auth_provider = 'supabase'
         and auth_subject in (
           select id::text from auth.users where email like 'phase5-%@example.test'
         )
    `);
    await migrationDatabase.query(
      `delete from auth.users where email like 'phase5-%@example.test'`,
    );
    auditRecords.length = 0;
    cacheAvailable = true;
    cacheRecords.clear();
  };

  const createLocalAuthIdentity = async (): Promise<LocalAuthIdentity> => {
    const response = await fetch(`${authIssuer}/signup`, {
      body: JSON.stringify({
        email: `phase5-${randomUUID()}@example.test`,
        password: `Local-only-${randomUUID()}-Aa1!`,
      }),
      headers: { apikey: publishableKey, 'content-type': 'application/json' },
      method: 'POST',
    });
    if (!response.ok) {
      throw new Error(`Local Supabase Auth sign-up failed: ${response.status.toString()}.`);
    }
    return parseLocalAuthIdentity(await response.json());
  };

  const createActor = async (): Promise<TestActor> => {
    const identity = await createLocalAuthIdentity();
    const exchange = await request(app)
      .post('/v1/auth/session/exchange')
      .set(authorization({ ...identity, userId: '' }))
      .send({});
    expect(exchange.status).toBe(200);
    const persisted = await applicationDatabase.query<{ readonly id: string }>(
      `select id::text as id from app.users
        where auth_provider = 'supabase' and auth_subject = $1`,
      [identity.subject],
    );
    if (persisted.rows[0] === undefined) throw new Error('Local actor was not bootstrapped.');
    return { ...identity, userId: persisted.rows[0].id };
  };

  const createCreator = async (
    owner: TestActor,
    displayName = 'Phase 5 Creator',
  ): Promise<TestCreator> => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const handle = `p5_${suffix}`;
    const customSlug = `p5-${suffix}`;
    const response = await request(app)
      .post('/v1/creators')
      .set(authorization(owner))
      .send({ customSlug, displayName, handle });
    expect(response.status).toBe(201);
    const persisted = await applicationDatabase.query<TestCreator>(
      `select id::text as id, handle::text as handle, custom_slug::text as "customSlug"
         from app.creators where handle = $1`,
      [handle],
    );
    if (persisted.rows[0] === undefined) throw new Error('Creator was not persisted.');
    return persisted.rows[0];
  };

  const addMember = async (
    owner: TestActor,
    creatorId: string,
    actor: TestActor,
    role: 'editor' | 'manager' | 'viewer',
  ): Promise<void> => {
    const response = await request(app)
      .post(`/v1/creators/${creatorId}/members`)
      .set(authorization(owner))
      .send({ role, userId: actor.userId });
    expect(response.status).toBe(201);
  };

  const boxBody = (name = `Box ${randomUUID()}`) => ({
    currency: 'USD',
    description: 'Synthetic Phase 5 box',
    imageUrl: 'https://example.test/box.png',
    name,
    priceMinor: '1000',
  });

  const rewardBody = (
    name = `Reward ${randomUUID()}`,
    inventoryMode: 'finite' | 'unlimited' = 'unlimited',
    inventoryQuantity: string | null = null,
  ) => ({
    declaredValueCurrency: 'USD',
    declaredValueMinor: '2500',
    description: 'Synthetic Phase 5 reward',
    imageUrl: 'https://example.test/reward.png',
    inventoryMode,
    inventoryQuantity,
    name,
    rewardType: 'digital',
  });

  const createBox = async (
    actor: TestActor,
    creatorId: string,
    body = boxBody(),
  ): Promise<TestBox> => {
    const response = await request(app)
      .post(`/v1/creators/${creatorId}/boxes`)
      .set(authorization(actor))
      .send(body);
    expect(response.status).toBe(201);
    const persisted = await applicationDatabase.query<TestBox>(
      `select b.id::text as id, b.revision, bv.id::text as "draftId"
         from app.boxes b
         join app.box_versions bv on bv.box_id = b.id and bv.state = 'draft'
        where b.creator_id = $1 and bv.name = $2`,
      [creatorId, body.name],
    );
    if (persisted.rows[0] === undefined) throw new Error('Box was not persisted.');
    return persisted.rows[0];
  };

  const createReward = async (
    actor: TestActor,
    creatorId: string,
    body = rewardBody(),
  ): Promise<TestReward> => {
    const response = await request(app)
      .post(`/v1/creators/${creatorId}/rewards`)
      .set(authorization(actor))
      .send(body);
    expect(response.status).toBe(201);
    const persisted = await applicationDatabase.query<TestReward>(
      `select r.id::text as id, r.revision, rv.id::text as "draftId"
         from app.rewards r
         join app.reward_versions rv on rv.reward_id = r.id and rv.state = 'draft'
        where r.creator_id = $1 and rv.name = $2`,
      [creatorId, body.name],
    );
    if (persisted.rows[0] === undefined) throw new Error('Reward was not persisted.');
    return persisted.rows[0];
  };

  const configure = async (
    actor: TestActor,
    creatorId: string,
    box: TestBox,
    entries: readonly { readonly rewardVersionId: string; readonly weight: string }[],
    revision = box.revision,
  ) =>
    request(app)
      .put(`/v1/creators/${creatorId}/boxes/${box.id}/draft/rewards`)
      .set(authorization(actor))
      .set('If-Match', `"${revision.toString()}"`)
      .send({
        entries: entries.map((entry, index) => ({ ...entry, isBaseReward: index === 0 })),
      });

  beforeAll(async () => {
    applicationDatabase = createDatabasePool({
      ...applicationEnvironment,
      onUnexpectedPoolError: (error) => {
        throw error;
      },
    });
    migrationDatabase = createDatabasePool({
      ...applicationEnvironment,
      applicationName: 'creatordrop-catalog-integration-admin',
      connectionString: migrationEnvironment.connectionString,
      onUnexpectedPoolError: (error) => {
        throw error;
      },
    });
    const verifyAccessToken = createJwtVerifier({
      audience: 'authenticated',
      issuer: authIssuer,
      jwksUrl: `${authIssuer}/.well-known/jwks.json`,
      provider: 'supabase',
    });
    const catalogService = createCatalogService({
      cache: { redis: catalogCache, ttlSeconds: 300 },
      database: applicationDatabase,
      logger,
    });
    app = createApp({
      authenticate: createAuthenticationMiddleware({
        bootstrapUsers: createUserBootstrapService({ database: applicationDatabase }),
        verifyAccessToken,
      }),
      catalogService,
      publicCatalogService: createPublicCatalogService({ database: applicationDatabase }),
      creatorService: createCreatorService({ database: applicationDatabase, logger }),
      fairnessService: createUnhandledFairnessService(),
      logger,
      security: {
        allowedOrigins: ['http://localhost:5173'],
        authRateLimitMax: 10_000,
        authRateLimitWindowMs: 60_000,
        creatorMutationRateLimitMax: 10_000,
        creatorMutationRateLimitWindowMs: 60_000,
        fairnessMutationRateLimitMax: 10_000,
        fairnessMutationRateLimitWindowMs: 60_000,
        openingMutationRateLimitMax: 10_000,
        openingMutationRateLimitWindowMs: 60_000,
        requestBodyLimitBytes: 262_144,
      },
    });
    await removeSyntheticState();
  });

  afterEach(removeSyntheticState);

  afterAll(async () => {
    await removeSyntheticState();
    await Promise.all([applicationDatabase.close(), migrationDatabase.close()]);
  });

  it('enforces draft role behavior, integer prices, inventory, and tenant isolation', async () => {
    const owner = await createActor();
    const manager = await createActor();
    const editor = await createActor();
    const viewer = await createActor();
    const otherOwner = await createActor();
    const creator = await createCreator(owner);
    const otherCreator = await createCreator(otherOwner);
    await addMember(owner, creator.id, manager, 'manager');
    await addMember(owner, creator.id, editor, 'editor');
    await addMember(owner, creator.id, viewer, 'viewer');

    const ownerBox = await createBox(owner, creator.id);
    await createBox(manager, creator.id);
    const editorBox = await createBox(editor, creator.id);
    const editorUpdate = await request(app)
      .patch(`/v1/creators/${creator.id}/boxes/${editorBox.id}/draft`)
      .set(authorization(editor))
      .set('If-Match', '"1"')
      .send(boxBody('Editor update'));
    expect(editorUpdate.status).toBe(200);
    const viewerBox = await request(app)
      .post(`/v1/creators/${creator.id}/boxes`)
      .set(authorization(viewer))
      .send(boxBody());
    expect(viewerBox.status).toBe(403);
    const viewerRead = await request(app)
      .get(`/v1/creators/${creator.id}/boxes/${ownerBox.id}`)
      .set(authorization(viewer));
    const ownerList = await request(app)
      .get(`/v1/creators/${creator.id}/boxes`)
      .set(authorization(owner));
    expect([viewerRead.status, ownerList.status]).toEqual([200, 200]);
    for (const priceMinor of ['0', '-1', '10.5', 1000]) {
      const invalid = await request(app)
        .post(`/v1/creators/${creator.id}/boxes`)
        .set(authorization(owner))
        .send({ ...boxBody(), priceMinor });
      expect(invalid.status).toBe(400);
    }

    const unlimited = await createReward(owner, creator.id, rewardBody());
    await createReward(manager, creator.id, rewardBody());
    const finiteDraft = await createReward(
      editor,
      creator.id,
      rewardBody('Finite zero draft', 'finite', '0'),
    );
    const changedToUnlimited = await request(app)
      .patch(`/v1/creators/${creator.id}/rewards/${finiteDraft.id}/draft`)
      .set(authorization(editor))
      .set('If-Match', '"1"')
      .send(rewardBody('Changed to unlimited'));
    expect(changedToUnlimited.status).toBe(200);
    expect(
      (
        await applicationDatabase.query<{ readonly count: string }>(
          `select count(*)::text as count from app.inventory_pools where id = $1`,
          [finiteDraft.draftId],
        )
      ).rows,
    ).toEqual([{ count: '0' }]);
    const viewerReward = await request(app)
      .post(`/v1/creators/${creator.id}/rewards`)
      .set(authorization(viewer))
      .send(rewardBody());
    expect(viewerReward.status).toBe(403);
    const invalidFinite = await request(app)
      .post(`/v1/creators/${creator.id}/rewards`)
      .set(authorization(owner))
      .send(rewardBody('Invalid finite', 'finite', '-1'));
    const invalidUnlimited = await request(app)
      .post(`/v1/creators/${creator.id}/rewards`)
      .set(authorization(owner))
      .send(rewardBody('Invalid unlimited', 'unlimited', '1'));
    expect([invalidFinite.status, invalidUnlimited.status]).toEqual([400, 400]);

    const crossRead = await request(app)
      .get(`/v1/creators/${creator.id}/boxes/${ownerBox.id}`)
      .set(authorization(otherOwner));
    const crossBoxWrite = await request(app)
      .patch(`/v1/creators/${creator.id}/boxes/${ownerBox.id}/draft`)
      .set(authorization(otherOwner))
      .set('If-Match', '"1"')
      .send(boxBody('Cross tenant'));
    const crossRewardRead = await request(app)
      .get(`/v1/creators/${creator.id}/rewards/${unlimited.id}`)
      .set(authorization(otherOwner));
    expect([crossRead.status, crossBoxWrite.status, crossRewardRead.status]).toEqual([
      404, 404, 404,
    ]);

    const otherReward = await createReward(otherOwner, otherCreator.id);
    const crossConfiguration = await configure(owner, creator.id, ownerBox, [
      { rewardVersionId: otherReward.draftId, weight: '1' },
    ]);
    expect(crossConfiguration.status).toBe(409);

    const archivedBox = await request(app)
      .post(`/v1/creators/${creator.id}/boxes/${ownerBox.id}/archive`)
      .set(authorization(owner))
      .set('If-Match', '"1"');
    const archivedReward = await request(app)
      .post(`/v1/creators/${creator.id}/rewards/${unlimited.id}/archive`)
      .set(authorization(owner))
      .set('If-Match', '"1"');
    expect([archivedBox.status, archivedReward.status]).toEqual([200, 200]);
    expect(
      auditRecords
        .filter((record) => record.message === 'catalog.audit')
        .map((record) => record.attributes?.action),
    ).toEqual(expect.arrayContaining(['box.archived', 'reward.archived']));
  });

  it('publishes opening-v2 without financial/base fields and provides immutable idempotent entitlements', async () => {
    const owner = await createActor();
    const otherUser = await createActor();
    const creator = await createCreator(owner, 'R1A Creator');
    const reward = await createReward(owner, creator.id, rewardBody('R1A Reward'));
    const boxName = `R1A Free Drop ${randomUUID()}`;
    const create = await request(app)
      .post(`/v1/creators/${creator.id}/boxes`)
      .set(authorization(owner))
      .send({
        description: 'R1A free-entry catalog fixture',
        maxOpeningsPerUser: '3',
        name: boxName,
        openingCompatibilityVersion: 'opening-v2',
      });
    expect(create.status).toBe(201);
    const box = await applicationDatabase.query<TestBox>(
      `select b.id::text as id, b.revision, bv.id::text as "draftId"
         from app.boxes b
         join app.box_versions bv on bv.box_id = b.id and bv.state = 'draft'
        where b.creator_id = $1 and bv.name = $2`,
      [creator.id, boxName],
    );
    const draft = box.rows[0];
    if (draft === undefined) throw new Error('opening-v2 draft was not persisted.');
    await expect(
      applicationDatabase.query(
        `update app.box_versions set max_openings_per_user = null where id = $1`,
        [draft.draftId],
      ),
    ).rejects.toThrow(/box_versions_opening_model_shape/iu);
    await expect(
      applicationDatabase.query(
        `update app.box_versions
            set opening_compatibility_version = 'opening-v1',
                price_minor = null, currency = 'USD', max_openings_per_user = null
          where id = $1`,
        [draft.draftId],
      ),
    ).rejects.toThrow(/box_versions_opening_model_shape/iu);
    await expect(
      applicationDatabase.query(
        `update app.box_versions
            set opening_compatibility_version = 'opening-v1',
                price_minor = 100, currency = null, max_openings_per_user = null
          where id = $1`,
        [draft.draftId],
      ),
    ).rejects.toThrow(/box_versions_opening_model_shape/iu);
    await applicationDatabase.query(
      `update app.box_versions
          set opening_compatibility_version = null,
              price_minor = 100, currency = 'USD', max_openings_per_user = null
        where id = $1`,
      [draft.draftId],
    );
    await expect(
      applicationDatabase.query(`update app.box_versions set state = 'published' where id = $1`, [
        draft.draftId,
      ]),
    ).rejects.toThrow(/explicitly select an opening compatibility model/iu);
    await applicationDatabase.query(
      `update app.box_versions
          set opening_compatibility_version = 'opening-v2',
              price_minor = null, currency = null, max_openings_per_user = 3
        where id = $1`,
      [draft.draftId],
    );
    const configureV2 = await request(app)
      .put(`/v1/creators/${creator.id}/boxes/${draft.id}/draft/rewards`)
      .set(authorization(owner))
      .set('If-Match', '"1"')
      .send({
        entries: [{ rewardVersionId: reward.draftId, weight: '5' }],
        openingCompatibilityVersion: 'opening-v2',
      });
    expect(configureV2.status).toBe(200);
    const publish = await request(app)
      .post(`/v1/creators/${creator.id}/boxes/${draft.id}/publish`)
      .set(authorization(owner))
      .set('If-Match', '"2"');
    expect(publish.status).toBe(200);
    expect(publish.body).toMatchObject({
      entries: [{ isBaseReward: false, rarity: 'common', rarityPolicyVersion: 'rarity-v1' }],
      manifest: {
        maxOpeningsPerUser: '3',
        openingCompatibilityVersion: 'opening-v2',
        totalWeight: '5',
      },
      version: {
        currency: null,
        maxOpeningsPerUser: '3',
        openingCompatibilityVersion: 'opening-v2',
        priceMinor: null,
      },
    });
    const publishedBody = publish.body as PublishedBoxVersionResponse;
    expect(publishedBody.manifest).not.toHaveProperty('currency');
    expect(publishedBody.manifest).not.toHaveProperty('priceMinor');
    const publicList = await request(app).get(`/v1/catalog/creators/${creator.customSlug}/boxes`);
    expect(publicList.body).toMatchObject({
      boxes: [
        {
          availability: 'opening-v2',
          currency: null,
          id: draft.id,
          maxOpeningsPerUser: '3',
          priceMinor: null,
        },
      ],
    });
    await expect(
      migrationDatabase.query(
        `update app.box_versions set max_openings_per_user = 4 where id = $1`,
        [draft.draftId],
      ),
    ).rejects.toThrow(/Published catalog versions are immutable/iu);

    const sourceIdentity = `catalog-test-${randomUUID()}`;
    const firstGrantId = uuidv7();
    const entitlementOperator = createOpeningEntitlementOperatorService(migrationDatabase);
    const grantInput = {
      boxId: draft.id,
      creatorId: creator.id,
      grantedByUserId: owner.userId,
      quantity: 2n,
      reason: 'R1A test grant',
      sourceIdentity,
      sourceType: 'development_manual',
      userId: owner.userId,
    };
    const firstGrant = await entitlementOperator.grant({ ...grantInput, grantId: firstGrantId });
    const replay = await entitlementOperator.grant({ ...grantInput, grantId: uuidv7() });
    expect(firstGrant).toEqual({ id: firstGrantId, replayed: false });
    expect(replay).toEqual({ id: firstGrantId, replayed: true });
    await expect(
      migrationDatabase.query(
        `select *
           from app_private.grant_opening_entitlement($1,$2,$3,$4,2,'development_manual',$5,$2,'R1A test grant')`,
        [uuidv7(), otherUser.userId, creator.id, draft.id, sourceIdentity],
      ),
    ).rejects.toThrow(/source identity was reused/iu);
    await expect(
      migrationDatabase.query(
        `select *
           from app_private.grant_opening_entitlement($1,$2,$3,$4,0,'development_manual',$5,$2,'Invalid R1A grant')`,
        [uuidv7(), owner.userId, creator.id, draft.id, `${sourceIdentity}-zero`],
      ),
    ).rejects.toThrow(/quantity must be positive/iu);
    const concurrentSource = `${sourceIdentity}-concurrent`;
    const concurrentGrants = await Promise.all(
      [uuidv7(), uuidv7()].map((grantId) =>
        entitlementOperator.grant({
          ...grantInput,
          grantId,
          quantity: 1n,
          reason: 'Concurrent R1A grant',
          sourceIdentity: concurrentSource,
        }),
      ),
    );
    expect(concurrentGrants.map(({ replayed }) => replayed).sort()).toEqual([false, true]);

    const readEntitlementState = (userId: string) =>
      migrationDatabase.query<{
        readonly boxId: string;
        readonly consumed: string;
        readonly granted: string;
        readonly remaining: string;
      }>(
        `select box_id::text as "boxId", granted::text, consumed::text, remaining::text
           from app_private.read_opening_entitlement_state($1, $2)`,
        [userId, draft.id],
      );
    expect((await readEntitlementState(owner.userId)).rows).toEqual([
      { boxId: draft.id, consumed: '0', granted: '3', remaining: '3' },
    ]);
    expect((await readEntitlementState(otherUser.userId)).rows).toEqual([
      { boxId: draft.id, consumed: '0', granted: '0', remaining: '0' },
    ]);
    for (const suffix of ['one', 'two']) {
      await entitlementOperator.grant({
        ...grantInput,
        grantId: uuidv7(),
        grantedByUserId: null,
        quantity: 9_223_372_036_854_775_807n,
        reason: 'R1B numeric aggregate regression',
        sourceIdentity: `${sourceIdentity}-max-${suffix}`,
        userId: otherUser.userId,
      });
    }
    expect((await readEntitlementState(otherUser.userId)).rows).toEqual([
      {
        boxId: draft.id,
        consumed: '0',
        granted: '18446744073709551614',
        remaining: '18446744073709551614',
      },
    ]);

    await expect(
      applicationDatabase.query(
        `insert into app.opening_entitlement_grants (
           id,user_id,creator_id,box_id,quantity_granted,source_type,source_identity,
           source_fingerprint,grant_reason
         ) values ($1,$2,$3,$4,1,'forged','forged',decode(repeat('00',32),'hex'),'forged')`,
        [uuidv7(), owner.userId, creator.id, draft.id],
      ),
    ).rejects.toThrow(/permission denied/iu);
    await expect(
      applicationDatabase.query(
        `select quantity_granted from app.opening_entitlement_grants where user_id = $1`,
        [owner.userId],
      ),
    ).rejects.toThrow(/permission denied/iu);
    await expect(
      applicationDatabase.query(
        `insert into app.opening_entitlement_consumptions (
           id,grant_id,user_id,creator_id,box_id,opening_id
         ) values ($1,$2,$3,$4,$5,$6)`,
        [uuidv7(), firstGrantId, owner.userId, creator.id, draft.id, uuidv7()],
      ),
    ).rejects.toThrow(/permission denied/iu);
    await expect(
      applicationDatabase.query(
        `select * from app_private.read_opening_entitlement_state($1, $2)`,
        [owner.userId, draft.id],
      ),
    ).rejects.toThrow(/permission denied/iu);

    await expect(
      migrationDatabase.query(
        `insert into app.opening_entitlement_consumptions (
           id,grant_id,user_id,creator_id,box_id,opening_id
         ) values ($1,$2,$3,$4,$5,$6)`,
        [uuidv7(), firstGrantId, owner.userId, creator.id, draft.id, uuidv7()],
      ),
    ).rejects.toThrow(/opening_scope_fk/iu);
    expect((await readEntitlementState(owner.userId)).rows[0]).toMatchObject({
      consumed: '0',
      granted: '3',
      remaining: '3',
    });
    const secondGrant = await entitlementOperator.grant({
      ...grantInput,
      grantId: uuidv7(),
      quantity: 1n,
      reason: 'Second R1A test grant',
      sourceIdentity: `${sourceIdentity}-second`,
    });
    expect(secondGrant).toMatchObject({ replayed: false });
    expect((await readEntitlementState(owner.userId)).rows[0]).toMatchObject({
      consumed: '0',
      granted: '4',
      remaining: '4',
    });
    await expect(
      migrationDatabase.query(
        `update app.opening_entitlement_grants set quantity_granted = 3 where id = $1`,
        [firstGrantId],
      ),
    ).rejects.toThrow(/Opening entitlement history is immutable/iu);
    await expect(
      migrationDatabase.query(
        `insert into app.opening_entitlement_consumptions (
           id,grant_id,user_id,creator_id,box_id,opening_id
         ) values ($1,$2,$3,$4,$5,$6)`,
        [uuidv7(), firstGrantId, otherUser.userId, creator.id, draft.id, uuidv7()],
      ),
    ).rejects.toThrow();
  });

  it('replaces ordered draft rewards and rejects invalid associations and weights', async () => {
    const owner = await createActor();
    const creator = await createCreator(owner);
    const box = await createBox(owner, creator.id);
    const first = await createReward(owner, creator.id);
    const second = await createReward(owner, creator.id, rewardBody('Finite', 'finite', '10'));

    const configured = await configure(owner, creator.id, box, [
      { rewardVersionId: first.draftId, weight: '5' },
      { rewardVersionId: second.draftId, weight: '395' },
    ]);
    expect(configured.status).toBe(200);
    expect(configured.headers.etag).toBe('"2"');
    const rows = await applicationDatabase.query<{
      readonly position: number;
      readonly rewardVersionId: string;
      readonly weight: string;
    }>(
      `select position, reward_version_id::text as "rewardVersionId", weight::text as weight
         from app.box_version_rewards where box_version_id = $1 order by position`,
      [box.draftId],
    );
    expect(rows.rows).toEqual([
      { position: 0, rewardVersionId: first.draftId, weight: '5' },
      { position: 1, rewardVersionId: second.draftId, weight: '395' },
    ]);

    for (const weight of ['0', '-1']) {
      const invalid = await configure(
        owner,
        creator.id,
        box,
        [{ rewardVersionId: first.draftId, weight }],
        2,
      );
      expect(invalid.status).toBe(400);
    }
    const duplicate = await configure(
      owner,
      creator.id,
      box,
      [
        { rewardVersionId: first.draftId, weight: '1' },
        { rewardVersionId: first.draftId, weight: '2' },
      ],
      2,
    );
    expect(duplicate.status).toBe(400);

    const removed = await configure(
      owner,
      creator.id,
      box,
      [{ rewardVersionId: second.draftId, weight: '100' }],
      2,
    );
    expect(removed.status).toBe(200);
    const remaining = await applicationDatabase.query<{ readonly count: string }>(
      `select count(*)::text as count from app.box_version_rewards where box_version_id = $1`,
      [box.draftId],
    );
    expect(remaining.rows).toEqual([{ count: '1' }]);

    const clientRarity = await request(app)
      .put(`/v1/creators/${creator.id}/boxes/${box.id}/draft/rewards`)
      .set(authorization(owner))
      .set('If-Match', '"3"')
      .send({
        entries: [
          {
            isBaseReward: true,
            rarity: 'legendary',
            rewardVersionId: second.draftId,
            weight: '100',
          },
        ],
      });
    expect(clientRarity.status).toBe(400);
  });

  it('snapshots rarity per published box entry rather than per reward version', async () => {
    const owner = await createActor();
    const creator = await createCreator(owner);
    const shared = await createReward(owner, creator.id, rewardBody('Shared reward'));
    const filler = await createReward(owner, creator.id, rewardBody('Filler reward'));
    const first = await createBox(owner, creator.id, boxBody('Twenty percent box'));
    const second = await createBox(owner, creator.id, boxBody('Below twenty box'));

    await configure(owner, creator.id, first, [
      { rewardVersionId: shared.draftId, weight: '1' },
      { rewardVersionId: filler.draftId, weight: '4' },
    ]);
    await configure(owner, creator.id, second, [
      { rewardVersionId: shared.draftId, weight: '1' },
      { rewardVersionId: filler.draftId, weight: '5' },
    ]);
    for (const box of [first, second]) {
      expect(
        (
          await request(app)
            .post(`/v1/creators/${creator.id}/boxes/${box.id}/publish`)
            .set(authorization(owner))
            .set('If-Match', '"2"')
        ).status,
      ).toBe(200);
    }

    const snapshots = await applicationDatabase.query<{
      readonly boxId: string;
      readonly rarity: string;
      readonly rarityPolicyVersion: string;
    }>(
      `select version.box_id::text as "boxId", entry.rarity,
              entry.rarity_policy_version as "rarityPolicyVersion"
         from app.box_version_rewards as entry
         join app.box_versions as version on version.id = entry.box_version_id
        where version.box_id in ($1, $2) and entry.reward_version_id = $3
        order by version.box_id`,
      [first.id, second.id, shared.draftId],
    );
    expect(snapshots.rows.find((row) => row.boxId === first.id)).toEqual({
      boxId: first.id,
      rarity: 'common',
      rarityPolicyVersion: 'rarity-v1',
    });
    expect(snapshots.rows.find((row) => row.boxId === second.id)).toEqual({
      boxId: second.id,
      rarity: 'uncommon',
      rarityPolicyVersion: 'rarity-v1',
    });
  });

  it('publishes atomically with manager/owner permission and stable conflicts', async () => {
    const owner = await createActor();
    const manager = await createActor();
    const editor = await createActor();
    const creator = await createCreator(owner);
    await addMember(owner, creator.id, manager, 'manager');
    await addMember(owner, creator.id, editor, 'editor');
    const emptyBox = await createBox(owner, creator.id);

    const editorPublish = await request(app)
      .post(`/v1/creators/${creator.id}/boxes/${emptyBox.id}/publish`)
      .set(authorization(editor))
      .set('If-Match', '"1"');
    const emptyPublish = await request(app)
      .post(`/v1/creators/${creator.id}/boxes/${emptyBox.id}/publish`)
      .set(authorization(manager))
      .set('If-Match', '"1"');
    expect(editorPublish.status).toBe(403);
    expect(emptyPublish.status).toBe(422);
    expect(emptyPublish.body).toMatchObject({
      error: { code: 'CATALOG_PUBLICATION_EMPTY_CONFIGURATION' },
    });
    const emptyState = await applicationDatabase.query<{
      readonly currentVersion: string | null;
      readonly draftCount: string;
    }>(
      `select current_published_version_id::text as "currentVersion",
              (select count(*)::text from app.box_versions
                where box_id = b.id and state = 'draft') as "draftCount"
         from app.boxes b where id = $1`,
      [emptyBox.id],
    );
    expect(emptyState.rows).toEqual([{ currentVersion: null, draftCount: '1' }]);

    const zeroBaseBox = await createBox(owner, creator.id, boxBody('Zero base'));
    const zeroBaseReward = await createReward(owner, creator.id, rewardBody('Zero base reward'));
    expect(
      (
        await request(app)
          .put(`/v1/creators/${creator.id}/boxes/${zeroBaseBox.id}/draft/rewards`)
          .set(authorization(owner))
          .set('If-Match', '"1"')
          .send({
            entries: [
              { isBaseReward: false, rewardVersionId: zeroBaseReward.draftId, weight: '1' },
            ],
          })
      ).status,
    ).toBe(200);
    const zeroBasePublish = await request(app)
      .post(`/v1/creators/${creator.id}/boxes/${zeroBaseBox.id}/publish`)
      .set(authorization(owner))
      .set('If-Match', '"2"');
    expect(zeroBasePublish.status).toBe(422);
    expect(zeroBasePublish.body).toMatchObject({
      error: { code: 'CATALOG_PUBLICATION_BASE_REWARD_INVALID' },
    });

    const multipleBaseBox = await createBox(owner, creator.id, boxBody('Multiple bases'));
    const multipleBaseFirst = await createReward(owner, creator.id, rewardBody('Base one'));
    const multipleBaseSecond = await createReward(owner, creator.id, rewardBody('Base two'));
    expect(
      (
        await request(app)
          .put(`/v1/creators/${creator.id}/boxes/${multipleBaseBox.id}/draft/rewards`)
          .set(authorization(owner))
          .set('If-Match', '"1"')
          .send({
            entries: [
              { isBaseReward: true, rewardVersionId: multipleBaseFirst.draftId, weight: '1' },
              { isBaseReward: true, rewardVersionId: multipleBaseSecond.draftId, weight: '1' },
            ],
          })
      ).status,
    ).toBe(200);
    const multipleBasePublish = await request(app)
      .post(`/v1/creators/${creator.id}/boxes/${multipleBaseBox.id}/publish`)
      .set(authorization(owner))
      .set('If-Match', '"2"');
    expect(multipleBasePublish.status).toBe(422);
    expect(multipleBasePublish.body).toMatchObject({
      error: { code: 'CATALOG_PUBLICATION_BASE_REWARD_INVALID' },
    });

    const finite = await createReward(owner, creator.id, rewardBody('Finite zero', 'finite', '0'));
    expect(
      (
        await configure(owner, creator.id, emptyBox, [
          { rewardVersionId: finite.draftId, weight: '5' },
        ])
      ).status,
    ).toBe(200);
    const invalidInventory = await request(app)
      .post(`/v1/creators/${creator.id}/boxes/${emptyBox.id}/publish`)
      .set(authorization(owner))
      .set('If-Match', '"2"');
    expect(invalidInventory.status).toBe(422);
    expect(invalidInventory.body).toMatchObject({
      error: { code: 'CATALOG_PUBLICATION_INVALID_INVENTORY' },
    });

    const overflowBox = await createBox(owner, creator.id, boxBody('Overflow'));
    const overflowFirst = await createReward(owner, creator.id, rewardBody('Overflow one'));
    const overflowSecond = await createReward(owner, creator.id, rewardBody('Overflow two'));
    expect(
      (
        await configure(owner, creator.id, overflowBox, [
          { rewardVersionId: overflowFirst.draftId, weight: '9223372036854775807' },
          { rewardVersionId: overflowSecond.draftId, weight: '1' },
        ])
      ).status,
    ).toBe(200);
    const overflowPublish = await request(app)
      .post(`/v1/creators/${creator.id}/boxes/${overflowBox.id}/publish`)
      .set(authorization(owner))
      .set('If-Match', '"2"');
    expect(overflowPublish.status).toBe(422);
    expect(overflowPublish.body).toMatchObject({
      error: { code: 'CATALOG_PUBLICATION_WEIGHT_OVERFLOW' },
    });

    const inactiveBox = await createBox(owner, creator.id, boxBody('Inactive reward'));
    const inactiveReward = await createReward(owner, creator.id, rewardBody('Inactive reward'));
    await configure(owner, creator.id, inactiveBox, [
      { rewardVersionId: inactiveReward.draftId, weight: '1' },
    ]);
    expect(
      (
        await request(app)
          .post(`/v1/creators/${creator.id}/rewards/${inactiveReward.id}/archive`)
          .set(authorization(owner))
          .set('If-Match', '"1"')
      ).status,
    ).toBe(200);
    const inactivePublish = await request(app)
      .post(`/v1/creators/${creator.id}/boxes/${inactiveBox.id}/publish`)
      .set(authorization(manager))
      .set('If-Match', '"2"');
    expect(inactivePublish.status).toBe(422);
    expect(inactivePublish.body).toMatchObject({
      error: { code: 'CATALOG_PUBLICATION_INELIGIBLE_REWARD' },
    });

    const rewardUpdate = await request(app)
      .patch(`/v1/creators/${creator.id}/rewards/${finite.id}/draft`)
      .set(authorization(editor))
      .set('If-Match', '"1"')
      .send(rewardBody('Finite ready', 'finite', '10'));
    expect(rewardUpdate.status, JSON.stringify(auditRecords.slice(-5))).toBe(200);
    const published = await request(app)
      .post(`/v1/creators/${creator.id}/boxes/${emptyBox.id}/publish`)
      .set(authorization(manager))
      .set('If-Match', '"2"');
    expect(published.status).toBe(200);
    expect(published.headers.etag).toBe('"3"');
    expect(published.body).toMatchObject({
      entries: [{ rarity: 'common', rarityPolicyVersion: 'rarity-v1' }],
      manifest: { priceMinor: '1000', totalWeight: '5' },
      version: { state: 'published' },
    });
    const stale = await request(app)
      .post(`/v1/creators/${creator.id}/boxes/${emptyBox.id}/publish`)
      .set(authorization(owner))
      .set('If-Match', '"2"');
    expect(stale.status).toBe(409);

    const secondBox = await createBox(owner, creator.id);
    const unlimited = await createReward(owner, creator.id);
    await configure(owner, creator.id, secondBox, [
      { rewardVersionId: unlimited.draftId, weight: '1' },
    ]);
    const uppercaseBoxId = secondBox.id.toUpperCase();
    const uppercaseVersionId = secondBox.draftId.toUpperCase();
    const ownerPublish = await request(app)
      .post(`/v1/creators/${creator.id}/boxes/${uppercaseBoxId}/publish`)
      .set(authorization(owner))
      .set('If-Match', '"2"');
    expect(ownerPublish.status).toBe(200);
    expect(ownerPublish.body).toMatchObject({
      manifest: { boxId: secondBox.id, boxVersionId: secondBox.draftId },
    });
    const uppercaseCurrent = await request(app).get(`/v1/boxes/${uppercaseBoxId}`);
    const uppercaseHistorical = await request(app).get(
      `/v1/boxes/${uppercaseBoxId}/versions/${uppercaseVersionId}`,
    );
    expect([uppercaseCurrent.status, uppercaseHistorical.status]).toEqual([200, 200]);
    expect(uppercaseCurrent.body).toMatchObject({ manifest: { boxId: secondBox.id } });
    expect(uppercaseHistorical.body).toMatchObject({
      manifest: { boxId: secondBox.id, boxVersionId: secondBox.draftId },
    });
    const uppercasePublicationState = await applicationDatabase.query<{
      readonly currentVersionId: string | null;
    }>(
      `select current_published_version_id::text as "currentVersionId"
         from app.boxes where id = $1`,
      [secondBox.id],
    );
    expect(uppercasePublicationState.rows).toEqual([{ currentVersionId: secondBox.draftId }]);

    const auditActions = auditRecords
      .filter((record) => record.message === 'catalog.audit')
      .map((record) => record.attributes?.action);
    expect(auditActions).toContain('box.published');
    expect(JSON.stringify(auditRecords)).not.toContain(owner.accessToken);
  });

  it('serves a paginated allowlisted public creator catalog with explicit box visibility', async () => {
    const owner = await createActor();
    const otherOwner = await createActor();
    const hiddenOwner = await createActor();
    const creator = await createCreator(owner, 'Public Creator One');
    const otherCreator = await createCreator(otherOwner, 'Public Creator Two');
    const hiddenCreator = await createCreator(hiddenOwner, 'Suspended Creator');

    await migrationDatabase.transaction(async (transaction) => {
      await transaction.query(`set local session_replication_role = replica`);
      await transaction.query(
        `update app.creators
            set created_at = case id
              when $1 then '1900-01-01T00:00:00Z'::timestamptz
              when $2 then '1900-01-02T00:00:00Z'::timestamptz
              when $3 then '1900-01-03T00:00:00Z'::timestamptz
            end,
            status = case when id = $3 then 'suspended' else status end
          where id in ($1, $2, $3)`,
        [creator.id, otherCreator.id, hiddenCreator.id],
      );
    });

    const firstCreators = await request(app).get('/v1/catalog/creators?limit=1');
    expect(firstCreators.status).toBe(200);
    const firstCreatorsBody = firstCreators.body as unknown;
    if (!isRecord(firstCreatorsBody) || !Array.isArray(firstCreatorsBody.creators)) {
      throw new Error('Public creator list returned an unexpected response.');
    }
    const firstCreatorBody = firstCreatorsBody.creators[0] as unknown;
    if (!isRecord(firstCreatorBody) || typeof firstCreatorsBody.nextCursor !== 'string') {
      throw new Error('Public creator page returned an invalid cursor or creator.');
    }
    expect(firstCreatorsBody.creators).toEqual([
      {
        customSlug: creator.customSlug,
        displayName: 'Public Creator One',
        handle: creator.handle,
      },
    ]);
    expect(Object.keys(firstCreatorBody).sort()).toEqual(['customSlug', 'displayName', 'handle']);

    const secondCreators = await request(app).get('/v1/catalog/creators').query({
      cursor: firstCreatorsBody.nextCursor,
      limit: '1',
    });
    expect(secondCreators.status).toBe(200);
    expect(secondCreators.body as unknown).toMatchObject({
      creators: [
        {
          customSlug: otherCreator.customSlug,
          displayName: 'Public Creator Two',
          handle: otherCreator.handle,
        },
      ],
    });

    const creatorDetail = await request(app).get(
      `/v1/catalog/creators/${creator.customSlug.toUpperCase()}`,
    );
    expect(creatorDetail.status).toBe(200);
    expect(creatorDetail.body as unknown).toEqual({ creator: firstCreatorBody });
    expect(
      (await request(app).get(`/v1/catalog/creators/${hiddenCreator.customSlug}`)).status,
    ).toBe(404);
    expect((await request(app).get('/v1/catalog/creators?limit=01')).status).toBe(400);
    expect((await request(app).get('/v1/catalog/creators?role=owner')).status).toBe(400);

    const reward = await createReward(owner, creator.id, rewardBody('Public summary reward'));
    const activeBox = await createBox(owner, creator.id, boxBody('Active public box'));
    const legacyBox = await createBox(owner, creator.id, boxBody('Legacy public box'));
    const pausedBox = await createBox(owner, creator.id, boxBody('Paused public box'));
    const archivedBox = await createBox(owner, creator.id, boxBody('Archived public box'));
    const unpublishedBox = await createBox(owner, creator.id, boxBody('Unpublished private draft'));

    const publish = async (box: TestBox): Promise<void> => {
      expect(
        (
          await configure(owner, creator.id, box, [
            { rewardVersionId: reward.draftId, weight: '1' },
          ])
        ).status,
      ).toBe(200);
      expect(
        (
          await request(app)
            .post(`/v1/creators/${creator.id}/boxes/${box.id}/publish`)
            .set(authorization(owner))
            .set('If-Match', '"2"')
        ).status,
      ).toBe(200);
    };

    await publish(activeBox);
    await publish(legacyBox);
    await publish(pausedBox);
    await publish(archivedBox);
    expect(
      (
        await request(app)
          .post(`/v1/creators/${creator.id}/boxes/${archivedBox.id}/archive`)
          .set(authorization(owner))
          .set('If-Match', '"3"')
      ).status,
    ).toBe(200);

    await migrationDatabase.transaction(async (transaction) => {
      await transaction.query(`set local session_replication_role = replica`);
      await transaction.query(`update app.boxes set status = 'paused' where id = $1`, [
        pausedBox.id,
      ]);
      await transaction.query(
        `delete from app.box_version_base_rewards where box_version_id = $1`,
        [legacyBox.draftId],
      );
      await transaction.query(
        `update app.box_versions set opening_compatibility_version = null where id = $1`,
        [legacyBox.draftId],
      );
      await transaction.query(
        `update app.boxes
            set created_at = case id
              when $1 then '1900-01-01T00:00:00Z'::timestamptz
              when $2 then '1900-01-02T00:00:00Z'::timestamptz
              else created_at
            end
          where id in ($1, $2)`,
        [activeBox.id, legacyBox.id],
      );
    });

    const otherReward = await createReward(
      otherOwner,
      otherCreator.id,
      rewardBody('Cross-creator reward'),
    );
    const otherBox = await createBox(
      otherOwner,
      otherCreator.id,
      boxBody('Cross-creator public box'),
    );
    expect(
      (
        await configure(otherOwner, otherCreator.id, otherBox, [
          { rewardVersionId: otherReward.draftId, weight: '1' },
        ])
      ).status,
    ).toBe(200);
    expect(
      (
        await request(app)
          .post(`/v1/creators/${otherCreator.id}/boxes/${otherBox.id}/publish`)
          .set(authorization(otherOwner))
          .set('If-Match', '"2"')
      ).status,
    ).toBe(200);

    const scopedActive = await request(app).get(
      `/v1/catalog/creators/${creator.customSlug}/boxes/${activeBox.id}`,
    );
    expect(scopedActive.status).toBe(200);
    expect(scopedActive.body as unknown).toMatchObject({
      box: {
        manifest: { boxId: activeBox.id },
        version: { id: activeBox.draftId, openingCompatibilityVersion: 'opening-v1' },
      },
      creator: {
        customSlug: creator.customSlug,
        displayName: 'Public Creator One',
        handle: creator.handle,
      },
    });
    expect(Object.keys(scopedActive.body as Record<string, unknown>).sort()).toEqual([
      'box',
      'creator',
    ]);
    const crossCreatorDetail = await request(app).get(
      `/v1/catalog/creators/${creator.customSlug}/boxes/${otherBox.id}`,
    );
    expect(crossCreatorDetail.status).toBe(404);
    expect(crossCreatorDetail.body as unknown).toMatchObject({
      error: { code: 'PUBLIC_CATALOG_RESOURCE_NOT_FOUND' },
    });
    for (const hiddenBox of [pausedBox, archivedBox, unpublishedBox]) {
      expect(
        (await request(app).get(`/v1/catalog/creators/${creator.customSlug}/boxes/${hiddenBox.id}`))
          .status,
      ).toBe(404);
    }
    const scopedLegacy = await request(app).get(
      `/v1/catalog/creators/${creator.customSlug}/boxes/${legacyBox.id}`,
    );
    expect(scopedLegacy.status).toBe(200);
    expect(scopedLegacy.body as unknown).toMatchObject({
      box: { version: { openingCompatibilityVersion: null } },
    });
    await migrationDatabase.query(`update app.creators set status = 'suspended' where id = $1`, [
      otherCreator.id,
    ]);
    expect(
      (
        await request(app).get(
          `/v1/catalog/creators/${otherCreator.customSlug}/boxes/${otherBox.id}`,
        )
      ).status,
    ).toBe(404);

    const firstBoxes = await request(app).get(
      `/v1/catalog/creators/${creator.customSlug}/boxes?limit=1`,
    );
    expect(firstBoxes.status).toBe(200);
    const firstBoxesBody = firstBoxes.body as unknown;
    if (
      !isRecord(firstBoxesBody) ||
      !Array.isArray(firstBoxesBody.boxes) ||
      typeof firstBoxesBody.nextCursor !== 'string'
    ) {
      throw new Error('Public box list returned an unexpected response.');
    }
    const firstBoxBody = firstBoxesBody.boxes[0] as unknown;
    if (!isRecord(firstBoxBody)) throw new Error('Public box summary was invalid.');
    expect(firstBoxesBody.boxes).toHaveLength(1);
    expect(firstBoxBody).toMatchObject({
      availability: 'openable',
      id: activeBox.id,
      name: 'Active public box',
      openingCompatibilityVersion: 'opening-v1',
    });
    expect(Object.keys(firstBoxBody).sort()).toEqual([
      'availability',
      'configurationHash',
      'currency',
      'currentPublishedVersionId',
      'description',
      'id',
      'imageUrl',
      'maxOpeningsPerUser',
      'name',
      'openingCompatibilityVersion',
      'priceMinor',
      'publishedAt',
      'versionNumber',
    ]);

    const secondBoxes = await request(app)
      .get(`/v1/catalog/creators/${creator.customSlug}/boxes`)
      .query({ cursor: firstBoxesBody.nextCursor, limit: '1' });
    expect(secondBoxes.status).toBe(200);
    const secondBoxesBody = secondBoxes.body as unknown;
    expect(secondBoxesBody).toMatchObject({
      boxes: [
        {
          availability: 'legacy',
          id: legacyBox.id,
          name: 'Legacy public box',
          openingCompatibilityVersion: null,
        },
      ],
      nextCursor: null,
    });
    expect(JSON.stringify([firstBoxesBody, secondBoxesBody])).not.toMatch(
      /Archived public box|Paused public box|Unpublished private draft|Cross-creator public box|role|revision|membership|inventoryPool/iu,
    );
    cacheRecords.delete(publicCatalogCacheKeys.currentBox(pausedBox.id));
    expect((await request(app).get(`/v1/boxes/${pausedBox.id}`)).status).toBe(404);
    expect((await request(app).get(`/v1/boxes/${archivedBox.id}`)).status).toBe(404);
    expect((await request(app).get(`/v1/boxes/${legacyBox.id}`)).status).toBe(200);
    expect(
      (await request(app).get(`/v1/boxes/${archivedBox.id}/versions/${archivedBox.draftId}`))
        .status,
    ).toBe(200);
  });

  it('uses disposable cache-aside public reads without making catalog writes depend on Redis', async () => {
    const owner = await createActor();
    const creator = await createCreator(owner);
    const box = await createBox(owner, creator.id, boxBody('Cached public box'));
    const reward = await createReward(owner, creator.id, rewardBody('Cached public reward'));
    expect(
      (await configure(owner, creator.id, box, [{ rewardVersionId: reward.draftId, weight: '1' }]))
        .status,
    ).toBe(200);
    const publication = await request(app)
      .post(`/v1/creators/${creator.id}/boxes/${box.id}/publish`)
      .set(authorization(owner))
      .set('If-Match', '"2"');
    expect(publication.status).toBe(200);

    const currentKey = publicCatalogCacheKeys.currentBox(box.id);
    const versionKey = publicCatalogCacheKeys.version(box.id, box.draftId);
    expect(cacheRecords.has(currentKey)).toBe(true);
    expect(cacheRecords.has(versionKey)).toBe(true);

    const authoritative = publication.body as unknown as PublishedBoxVersionResponse;
    const forgedOddsManifest = {
      ...authoritative.manifest,
      entries: authoritative.manifest.entries.map((entry) => ({ ...entry, weight: '500' })),
      totalWeight: '500',
    };
    const forgedOddsHash = hashPublishedManifest(forgedOddsManifest);
    cacheRecords.set(currentKey, {
      ...authoritative,
      configurationHash: forgedOddsHash,
      entries: authoritative.entries.map((entry) => ({ ...entry, weight: '500' })),
      manifest: forgedOddsManifest,
      version: {
        ...authoritative.version,
        configurationHash: forgedOddsHash,
        totalWeight: '500',
      },
    });
    const forgedOddsFallback = await request(app).get(`/v1/boxes/${box.id}`);
    expect(forgedOddsFallback.status).toBe(200);
    expect(forgedOddsFallback.body).toEqual(publication.body);
    expect(cacheRecords.get(currentKey)).toEqual(publication.body);

    const forgedPriceManifest = { ...authoritative.manifest, priceMinor: '123456789' };
    const forgedPriceHash = hashPublishedManifest(forgedPriceManifest);
    cacheRecords.set(currentKey, {
      ...authoritative,
      configurationHash: forgedPriceHash,
      manifest: forgedPriceManifest,
      version: {
        ...authoritative.version,
        configurationHash: forgedPriceHash,
        priceMinor: '123456789',
      },
    });
    const forgedPriceFallback = await request(app).get(`/v1/boxes/${box.id}`);
    expect(forgedPriceFallback.status).toBe(200);
    expect(forgedPriceFallback.body).toEqual(publication.body);

    cacheRecords.set(versionKey, {
      ...authoritative,
      entries: authoritative.entries.map((entry, index) =>
        index === 0
          ? {
              ...entry,
              isBaseReward: false,
              rewardVersion: {
                ...entry.rewardVersion,
                description: 'Redis-forged reward description',
                imageUrl: 'https://attacker.invalid/forged.png',
                name: 'Redis-forged reward name',
              },
            }
          : entry,
      ),
    });
    const forgedPresentationFallback = await request(app).get(
      `/v1/boxes/${box.id}/versions/${box.draftId}`,
    );
    expect(forgedPresentationFallback.status).toBe(200);
    expect(forgedPresentationFallback.body).toEqual(publication.body);
    expect(cacheRecords.get(versionKey)).toEqual(publication.body);

    cacheRecords.set(currentKey, { forged: true });
    const corruptFallback = await request(app).get(`/v1/boxes/${box.id}`);
    expect(corruptFallback.status).toBe(200);
    expect(corruptFallback.body).toEqual(publication.body);
    expect(cacheRecords.get(currentKey)).toEqual(publication.body);

    cacheRecords.delete(currentKey);
    const missFallback = await request(app).get(`/v1/boxes/${box.id}`);
    expect(missFallback.status).toBe(200);
    expect(cacheRecords.has(currentKey)).toBe(true);

    const otherBox = await createBox(owner, creator.id, boxBody('Other cached public box'));
    const otherReward = await createReward(
      owner,
      creator.id,
      rewardBody('Other cached public reward'),
    );
    expect(
      (
        await configure(owner, creator.id, otherBox, [
          { rewardVersionId: otherReward.draftId, weight: '1' },
        ])
      ).status,
    ).toBe(200);
    const otherPublication = await request(app)
      .post(`/v1/creators/${creator.id}/boxes/${otherBox.id}/publish`)
      .set(authorization(owner))
      .set('If-Match', '"2"');
    expect(otherPublication.status).toBe(200);

    cacheRecords.set(currentKey, otherPublication.body as unknown);
    const wrongCurrentIdentity = await request(app).get(`/v1/boxes/${box.id.toUpperCase()}`);
    expect(wrongCurrentIdentity.status).toBe(200);
    expect(wrongCurrentIdentity.body).toEqual(publication.body);
    expect(cacheRecords.get(currentKey)).toEqual(publication.body);

    cacheRecords.set(versionKey, otherPublication.body as unknown);
    const wrongVersionIdentity = await request(app).get(
      `/v1/boxes/${box.id.toUpperCase()}/versions/${box.draftId.toUpperCase()}`,
    );
    expect(wrongVersionIdentity.status).toBe(200);
    expect(wrongVersionIdentity.body).toEqual(publication.body);
    expect(cacheRecords.get(versionKey)).toEqual(publication.body);

    cacheAvailable = false;
    const unavailableFallback = await request(app).get(
      `/v1/boxes/${box.id}/versions/${box.draftId}`,
    );
    expect(unavailableFallback.status).toBe(200);
    cacheAvailable = true;

    const archived = await request(app)
      .post(`/v1/creators/${creator.id}/boxes/${box.id}/archive`)
      .set(authorization(owner))
      .set('If-Match', '"3"');
    expect(archived.status).toBe(200);
    expect(cacheRecords.has(currentKey)).toBe(false);
    expect((await request(app).get(`/v1/boxes/${box.id}`)).status).toBe(404);
    expect((await request(app).get(`/v1/boxes/${box.id}/versions/${box.draftId}`)).status).toBe(
      200,
    );
  });

  it('preserves immutable historical versions while later edits create new drafts', async () => {
    const owner = await createActor();
    const creator = await createCreator(owner);
    const box = await createBox(owner, creator.id, boxBody('Historical Box'));
    const reward = await createReward(owner, creator.id, rewardBody('Historical Reward'));
    const alternateReward = await createReward(
      owner,
      creator.id,
      rewardBody('Alternate historical reward'),
    );
    await configure(owner, creator.id, box, [{ rewardVersionId: reward.draftId, weight: '5' }]);
    const firstPublish = await request(app)
      .post(`/v1/creators/${creator.id}/boxes/${box.id}/publish`)
      .set(authorization(owner))
      .set('If-Match', '"2"');
    expect(firstPublish.status, JSON.stringify(auditRecords.slice(-5))).toBe(200);

    await expect(
      applicationDatabase.query(`update app.box_versions set name = 'Tampered' where id = $1`, [
        box.draftId,
      ]),
    ).rejects.toThrow(/immutable/iu);
    await expect(
      applicationDatabase.query(
        `update app.box_version_rewards set weight = 999 where box_version_id = $1`,
        [box.draftId],
      ),
    ).rejects.toThrow(/immutable/iu);
    await expect(
      applicationDatabase.query(
        `update app.box_version_rewards set reward_version_id = $2 where box_version_id = $1`,
        [box.draftId, alternateReward.draftId],
      ),
    ).rejects.toThrow(/immutable/iu);
    await expect(
      applicationDatabase.query(
        `update app.box_version_rewards set rarity = 'legendary' where box_version_id = $1`,
        [box.draftId],
      ),
    ).rejects.toThrow(/immutable/iu);
    await expect(
      applicationDatabase.query(`update app.reward_versions set name = 'Tampered' where id = $1`, [
        reward.draftId,
      ]),
    ).rejects.toThrow(/immutable/iu);

    const rewardEdit = await request(app)
      .patch(`/v1/creators/${creator.id}/rewards/${reward.id}/draft`)
      .set(authorization(owner))
      .set('If-Match', '"1"')
      .send(rewardBody('Historical Reward v2'));
    const boxEdit = await request(app)
      .patch(`/v1/creators/${creator.id}/boxes/${box.id}/draft`)
      .set(authorization(owner))
      .set('If-Match', '"3"')
      .send({ ...boxBody('Historical Box v2'), priceMinor: '1500' });
    expect([rewardEdit.status, boxEdit.status]).toEqual([200, 200]);
    const newDrafts = await applicationDatabase.query<{
      readonly boxDraftId: string;
      readonly rewardDraftId: string;
    }>(
      `select
         (select id::text from app.box_versions where box_id = $1 and state = 'draft')
           as "boxDraftId",
         (select id::text from app.reward_versions where reward_id = $2 and state = 'draft')
           as "rewardDraftId"`,
      [box.id, reward.id],
    );
    const next = newDrafts.rows[0];
    if (next === undefined) throw new Error('New drafts were not created.');
    expect(next.boxDraftId).not.toBe(box.draftId);
    expect(next.rewardDraftId).not.toBe(reward.draftId);

    expect(
      (
        await configure(
          owner,
          creator.id,
          { ...box, draftId: next.boxDraftId, revision: 4 },
          [{ rewardVersionId: next.rewardDraftId, weight: '100' }],
          4,
        )
      ).status,
    ).toBe(200);
    const secondPublish = await request(app)
      .post(`/v1/creators/${creator.id}/boxes/${box.id}/publish`)
      .set(authorization(owner))
      .set('If-Match', '"5"');
    expect(secondPublish.status).toBe(200);

    const history = await applicationDatabase.query<{
      readonly name: string;
      readonly priceMinor: string;
      readonly rewardVersionId: string;
      readonly versionNumber: number;
      readonly weight: string;
    }>(
      `select bv.version_number as "versionNumber", bv.name,
              bv.price_minor::text as "priceMinor",
              bvr.reward_version_id::text as "rewardVersionId", bvr.weight::text as weight
         from app.box_versions bv
         join app.box_version_rewards bvr on bvr.box_version_id = bv.id
        where bv.box_id = $1 and bv.state = 'published'
        order by bv.version_number`,
      [box.id],
    );
    expect(history.rows).toEqual([
      {
        name: 'Historical Box',
        priceMinor: '1000',
        rewardVersionId: reward.draftId,
        versionNumber: 1,
        weight: '5',
      },
      {
        name: 'Historical Box v2',
        priceMinor: '1500',
        rewardVersionId: next.rewardDraftId,
        versionNumber: 2,
        weight: '100',
      },
    ]);
    const historicalPublic = await request(app).get(`/v1/boxes/${box.id}/versions/${box.draftId}`);
    const currentPublic = await request(app).get(`/v1/boxes/${box.id}`);
    const boxVersions = await request(app)
      .get(`/v1/creators/${creator.id}/boxes/${box.id}/versions`)
      .set(authorization(owner));
    const rewardVersions = await request(app)
      .get(`/v1/creators/${creator.id}/rewards/${reward.id}/versions`)
      .set(authorization(owner));
    expect([
      historicalPublic.status,
      currentPublic.status,
      boxVersions.status,
      rewardVersions.status,
    ]).toEqual([200, 200, 200, 200]);
    expect(historicalPublic.body).toMatchObject({ manifest: { totalWeight: '5' } });
    expect(currentPublic.body).toMatchObject({ manifest: { totalWeight: '100' } });
  });

  it('serializes concurrent publish/edit and enforces database ownership constraints', async () => {
    const owner = await createActor();
    const manager = await createActor();
    const editor = await createActor();
    const otherOwner = await createActor();
    const creator = await createCreator(owner);
    const otherCreator = await createCreator(otherOwner);
    await addMember(owner, creator.id, manager, 'manager');
    await addMember(owner, creator.id, editor, 'editor');
    const box = await createBox(owner, creator.id);
    const reward = await createReward(owner, creator.id);
    const otherReward = await createReward(otherOwner, otherCreator.id);
    await configure(owner, creator.id, box, [{ rewardVersionId: reward.draftId, weight: '1' }]);

    const [publish, edit] = await Promise.all([
      request(app)
        .post(`/v1/creators/${creator.id}/boxes/${box.id}/publish`)
        .set(authorization(manager))
        .set('If-Match', '"2"'),
      request(app)
        .patch(`/v1/creators/${creator.id}/boxes/${box.id}/draft`)
        .set(authorization(editor))
        .set('If-Match', '"2"')
        .send(boxBody('Concurrent edit')),
    ]);
    expect([publish.status, edit.status].sort()).toEqual([200, 409]);
    const state = await applicationDatabase.query<{
      readonly currentCount: string;
      readonly draftCount: string;
      readonly publishedCount: string;
    }>(
      `select
         count(*) filter (where state = 'draft')::text as "draftCount",
         count(*) filter (where state = 'published')::text as "publishedCount",
         (select count(*)::text from app.boxes
           where id = $1 and current_published_version_id is not null) as "currentCount"
         from app.box_versions where box_id = $1`,
      [box.id],
    );
    expect([
      { currentCount: '1', draftCount: '0', publishedCount: '1' },
      { currentCount: '0', draftCount: '1', publishedCount: '0' },
    ]).toContainEqual(state.rows[0]);

    const constraintBox = await createBox(owner, creator.id, boxBody('Constraint Box'));

    await applicationDatabase.query(
      `insert into app.box_version_rewards (
         id, box_version_id, reward_version_id, position, weight
       ) values ($1, $2, $3, 0, 1)`,
      [uuidv7(), constraintBox.draftId, reward.draftId],
    );
    await expect(
      applicationDatabase.query(
        `insert into app.box_version_rewards (
           id, box_version_id, reward_version_id, position, weight
         ) values ($1, $2, $3, 1, 1)`,
        [uuidv7(), constraintBox.draftId, reward.draftId],
      ),
    ).rejects.toThrow(/unique/iu);
    await expect(
      applicationDatabase.query(
        `insert into app.box_version_rewards (
           id, box_version_id, reward_version_id, position, weight
         ) values ($1, $2, $3, 1, 1)`,
        [uuidv7(), constraintBox.draftId, uuidv7()],
      ),
    ).rejects.toThrow(/same creator/iu);
    await expect(
      applicationDatabase.query(`insert into app.boxes (id, creator_id) values ($1, $2)`, [
        uuidv7(),
        uuidv7(),
      ]),
    ).rejects.toThrow(/foreign key/iu);

    await expect(
      applicationDatabase.query(
        `insert into app.box_version_rewards (
           id, box_version_id, reward_version_id, position, weight
         ) values ($1, $2, $3, 50, 1)`,
        [uuidv7(), constraintBox.draftId, otherReward.draftId],
      ),
    ).rejects.toThrow(/creator/iu);
    await expect(
      applicationDatabase.query(
        `insert into app.reward_versions (
           id, reward_id, version_number, name, description, reward_type,
           inventory_mode, inventory_quantity, created_by_user_id
         ) values ($1, $2, 99, 'Invalid', '', 'digital', 'finite', -1, $3)`,
        [uuidv7(), reward.id, owner.userId],
      ),
    ).rejects.toThrow(/inventory/iu);
    await expect(
      applicationDatabase.query(
        `insert into app.box_version_rewards (
           id, box_version_id, reward_version_id, position, weight
         ) values ($1, $2, $3, 51, 0)`,
        [uuidv7(), constraintBox.draftId, reward.draftId],
      ),
    ).rejects.toThrow(/weight/iu);
  });
});
