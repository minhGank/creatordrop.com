import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { parseDatabaseEnvironment, parseMigrationEnvironment } from '@creatordrop/config';
import { createDatabasePool, type Database } from '@creatordrop/database';
import type { LogAttributes, Logger } from '@creatordrop/observability';

import { createApp } from '../src/app.js';
import { createAuthenticationMiddleware } from '../src/modules/auth/authentication.middleware.js';
import { createJwtVerifier } from '../src/modules/auth/jwt-verifier.js';
import { createCatalogService } from '../src/modules/catalog/catalog.service.js';
import { createCreatorService } from '../src/modules/creators/creator.service.js';
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

  const createCreator = async (owner: TestActor): Promise<TestCreator> => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const handle = `p5_${suffix}`;
    const response = await request(app)
      .post('/v1/creators')
      .set(authorization(owner))
      .send({ customSlug: `p5-${suffix}`, displayName: 'Phase 5 Creator', handle });
    expect(response.status).toBe(201);
    const persisted = await applicationDatabase.query<TestCreator>(
      `select id::text as id from app.creators where handle = $1`,
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
      .send({ entries });

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
    app = createApp({
      authenticate: createAuthenticationMiddleware({
        bootstrapUsers: createUserBootstrapService({ database: applicationDatabase }),
        verifyAccessToken,
      }),
      catalogService: createCatalogService({ database: applicationDatabase, logger }),
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
    await createReward(editor, creator.id, rewardBody('Finite zero draft', 'finite', '0'));
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
