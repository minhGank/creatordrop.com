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
import { createCreatorService } from '../src/modules/creators/creator.service.js';
import { trustedUserId } from '../src/modules/creators/creator.schema.js';
import { createUserBootstrapService } from '../src/modules/users/bootstrap-user.service.js';
import {
  createUnhandledCatalogService,
  createUnhandledFairnessService,
} from './support/test-app.js';

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

describe('creator tenancy and authorization', { concurrent: false }, () => {
  const apiUrl = requireEnvironment('LOCAL_SUPABASE_API_URL').replace(/\/$/u, '');
  const publishableKey = requireEnvironment('LOCAL_SUPABASE_PUBLISHABLE_KEY');
  const authIssuer = `${apiUrl}/auth/v1`;
  const applicationEnvironment = parseDatabaseEnvironment({
    DATABASE_APPLICATION_NAME: 'creatordrop-creator-integration-test',
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

  const removeSyntheticState = async (): Promise<void> => {
    await migrationDatabase.transaction(async (transaction) => {
      await transaction.query(`
        delete from app.creator_memberships
         where creator_id in (select id from app.creators where left(handle::text, 3) = 'p4_')
            or user_id in (
              select u.id
                from app.users u
                join auth.users a on a.id::text = u.auth_subject
               where a.email like 'phase4-%@example.test'
            )
      `);
      await transaction.query(`delete from app.creators where left(handle::text, 3) = 'p4_'`);
    });
    await migrationDatabase.query(`
      delete from app.users
       where auth_provider = 'supabase'
         and auth_subject in (
           select id::text from auth.users where email like 'phase4-%@example.test'
         )
    `);
    await migrationDatabase.query(`
      delete from auth.users where email like 'phase4-%@example.test'
    `);
    auditRecords.length = 0;
  };

  const createLocalAuthIdentity = async (): Promise<LocalAuthIdentity> => {
    const response = await fetch(`${authIssuer}/signup`, {
      body: JSON.stringify({
        email: `phase4-${randomUUID()}@example.test`,
        password: `Local-only-${randomUUID()}-Aa1!`,
      }),
      headers: { apikey: publishableKey, 'content-type': 'application/json' },
      method: 'POST',
    });

    if (!response.ok) {
      throw new Error(
        `Local Supabase Auth sign-up failed with status ${response.status.toString()}.`,
      );
    }

    return parseLocalAuthIdentity(await response.json());
  };

  const createActor = async (): Promise<TestActor> => {
    const identity = await createLocalAuthIdentity();
    const exchange = await request(app)
      .post('/v1/auth/session/exchange')
      .set('Authorization', `Bearer ${identity.accessToken}`)
      .send({});
    const persisted = await applicationDatabase.query<{ readonly id: string }>(
      `select id::text as id
         from app.users
        where auth_provider = 'supabase' and auth_subject = $1`,
      [identity.subject],
    );

    expect(exchange.status).toBe(200);
    if (persisted.rows[0] === undefined) {
      throw new Error('The local actor was not bootstrapped.');
    }

    return { ...identity, userId: persisted.rows[0].id };
  };

  const creatorIdentity = (): { customSlug: string; handle: string } => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    return { customSlug: `p4-${suffix}`, handle: `p4_${suffix}` };
  };

  const createCreator = async (actor: TestActor, displayName = 'Phase 4 Creator') => {
    const identity = creatorIdentity();
    const response = await request(app)
      .post('/v1/creators')
      .set('Authorization', `Bearer ${actor.accessToken}`)
      .send({ ...identity, displayName });
    const persisted = await applicationDatabase.query<TestCreator>(
      `select
         id::text as id,
         handle::text as handle,
         custom_slug::text as "customSlug",
         revision
         from app.creators
        where handle = $1`,
      [identity.handle],
    );

    expect(response.status).toBe(201);
    if (persisted.rows[0] === undefined) {
      throw new Error('The creator workspace was not persisted.');
    }

    return persisted.rows[0];
  };

  const addMember = async (
    owner: TestActor,
    creatorId: string,
    target: TestActor,
    role: 'editor' | 'manager' | 'owner' | 'viewer',
  ) =>
    request(app)
      .post(`/v1/creators/${creatorId}/members`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ role, userId: target.userId });

  const currentRevision = async (creatorId: string): Promise<number> => {
    const result = await applicationDatabase.query<{ readonly revision: number }>(
      'select revision from app.creators where id = $1',
      [creatorId],
    );
    if (result.rows[0] === undefined) {
      throw new Error('The creator revision was not found.');
    }
    return result.rows[0].revision;
  };

  beforeAll(async () => {
    applicationDatabase = createDatabasePool({
      ...applicationEnvironment,
      onUnexpectedPoolError: (error) => {
        throw error;
      },
    });
    migrationDatabase = createDatabasePool({
      ...applicationEnvironment,
      applicationName: 'creatordrop-creator-integration-admin',
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
      catalogService: createUnhandledCatalogService(),
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
        requestBodyLimitBytes: 32_768,
      },
    });
    await removeSyntheticState();
  });

  afterEach(removeSyntheticState);

  afterAll(async () => {
    await removeSyntheticState();
    await Promise.all([applicationDatabase.close(), migrationDatabase.close()]);
  });

  it('creates the workspace and authenticated owner atomically with unique identities', async () => {
    const owner = await createActor();
    const creator = await createCreator(owner);
    const rows = await applicationDatabase.query<{
      readonly creatorCount: string;
      readonly membershipCount: string;
      readonly ownerCount: string;
    }>(
      `select
         (select count(*)::text from app.creators where id = $1) as "creatorCount",
         (select count(*)::text from app.creator_memberships where creator_id = $1)
           as "membershipCount",
         (select count(*)::text from app.creator_memberships where creator_id = $1 and role = 'owner')
           as "ownerCount"`,
      [creator.id],
    );

    expect(rows.rows).toEqual([{ creatorCount: '1', membershipCount: '1', ownerCount: '1' }]);

    const memberships = await request(app)
      .get('/v1/me/creator-memberships')
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(memberships.status).toBe(200);
    expect(memberships.body).toMatchObject({
      memberships: [{ creator: { id: creator.id }, role: 'owner' }],
    });

    const secondOwner = await createActor();
    const duplicateHandle = await request(app)
      .post('/v1/creators')
      .set('Authorization', `Bearer ${secondOwner.accessToken}`)
      .send({
        customSlug: creatorIdentity().customSlug,
        displayName: 'Duplicate',
        handle: creator.handle,
      });
    expect(duplicateHandle.status).toBe(409);
    const duplicateSlug = await request(app)
      .post('/v1/creators')
      .set('Authorization', `Bearer ${secondOwner.accessToken}`)
      .send({
        customSlug: creator.customSlug,
        displayName: 'Duplicate',
        handle: creatorIdentity().handle,
      });
    expect(duplicateSlug.status).toBe(409);

    const orphanId = uuidv7();
    await expect(
      applicationDatabase.transaction(async (transaction) => {
        await transaction.query(
          `insert into app.creators (id, handle, custom_slug, display_name, status)
           values ($1, $2, $3, $4, 'closed')`,
          [orphanId, creatorIdentity().handle, creatorIdentity().customSlug, 'Ownerless'],
        );
      }),
    ).rejects.toThrow(/owner/iu);
    const orphan = await applicationDatabase.query<{ readonly count: string }>(
      'select count(*)::text as count from app.creators where id = $1',
      [orphanId],
    );
    expect(orphan.rows).toEqual([{ count: '0' }]);

    const failedAtomicId = uuidv7();
    const failedAtomicIdentity = creatorIdentity();
    const service = createCreatorService({
      createCreatorId: () => failedAtomicId,
      database: applicationDatabase,
      logger,
    });
    await expect(
      service.createCreator({
        actorUserId: trustedUserId(randomUUID()),
        ...failedAtomicIdentity,
        displayName: 'Must Roll Back',
        requestId: randomUUID(),
      }),
    ).rejects.toThrow();
    const failedAtomicCreator = await applicationDatabase.query<{ readonly count: string }>(
      'select count(*)::text as count from app.creators where id = $1',
      [failedAtomicId],
    );
    expect(failedAtomicCreator.rows).toEqual([{ count: '0' }]);

    const audit = auditRecords.filter((record) => record.message === 'creator.audit');
    expect(
      audit.some(
        (record) =>
          record.attributes?.action === 'creator.created' &&
          record.attributes.actorUserId === owner.userId &&
          record.attributes.creatorId === creator.id,
      ),
    ).toBe(true);
    expect(JSON.stringify(auditRecords)).not.toContain(owner.accessToken);
  });

  it('enforces the complete HTTP role and actor-state matrix', async () => {
    const owner = await createActor();
    const manager = await createActor();
    const editor = await createActor();
    const viewer = await createActor();
    const nonMember = await createActor();
    const otherCreatorMember = await createActor();
    const suspended = await createActor();
    const closed = await createActor();
    const membershipTarget = await createActor();
    const creator = await createCreator(owner);
    await addMember(owner, creator.id, manager, 'manager');
    await addMember(owner, creator.id, editor, 'editor');
    await addMember(owner, creator.id, viewer, 'viewer');
    await addMember(owner, creator.id, suspended, 'viewer');
    await addMember(owner, creator.id, closed, 'viewer');
    await createCreator(otherCreatorMember, 'Other Tenant');
    await applicationDatabase.query(
      `update app.users
          set status = case when id = $1 then 'suspended' else 'closed' end,
              closed_at = case when id = $2 then statement_timestamp() else null end,
              updated_at = statement_timestamp()
        where id in ($1, $2)`,
      [suspended.userId, closed.userId],
    );

    const cases = [
      { actor: owner, list: 200, manage: 201, update: 200, view: 200 },
      { actor: manager, list: 200, manage: 403, update: 200, view: 200 },
      { actor: editor, list: 200, manage: 403, update: 403, view: 200 },
      { actor: viewer, list: 200, manage: 403, update: 403, view: 200 },
      { actor: nonMember, list: 404, manage: 404, update: 404, view: 404 },
      { actor: otherCreatorMember, list: 404, manage: 404, update: 404, view: 404 },
      { actor: suspended, list: 403, manage: 403, update: 403, view: 403 },
      { actor: closed, list: 403, manage: 403, update: 403, view: 403 },
    ] as const;

    for (const testCase of cases) {
      const getResponse = await request(app)
        .get(`/v1/creators/${creator.id}`)
        .set('Authorization', `Bearer ${testCase.actor.accessToken}`);
      const listResponse = await request(app)
        .get(`/v1/creators/${creator.id}/members`)
        .set('Authorization', `Bearer ${testCase.actor.accessToken}`);
      const revision = await currentRevision(creator.id);
      const updateResponse = await request(app)
        .patch(`/v1/creators/${creator.id}`)
        .set('Authorization', `Bearer ${testCase.actor.accessToken}`)
        .set('If-Match', `"${revision.toString()}"`)
        .send({ displayName: `Updated ${randomUUID()}` });
      const manageResponse = await request(app)
        .post(`/v1/creators/${creator.id}/members`)
        .set('Authorization', `Bearer ${testCase.actor.accessToken}`)
        .send({ role: 'viewer', userId: membershipTarget.userId });

      expect(getResponse.status, `view ${testCase.actor.userId}`).toBe(testCase.view);
      expect(listResponse.status, `list ${testCase.actor.userId}`).toBe(testCase.list);
      expect(updateResponse.status, `update ${testCase.actor.userId}`).toBe(testCase.update);
      expect(manageResponse.status, `manage ${testCase.actor.userId}`).toBe(testCase.manage);

      if (testCase.manage === 201) {
        const remove = await request(app)
          .delete(`/v1/creators/${creator.id}/members/${membershipTarget.userId}`)
          .set('Authorization', `Bearer ${owner.accessToken}`);
        expect(remove.status).toBe(204);
      }
    }
  });

  it('conceals private data and mutations across creator tenants', async () => {
    const ownerA = await createActor();
    const ownerB = await createActor();
    const memberA = await createActor();
    const creatorA = await createCreator(ownerA, 'Tenant A');
    const creatorB = await createCreator(ownerB, 'Tenant B');
    await addMember(ownerA, creatorA.id, memberA, 'manager');

    const read = await request(app)
      .get(`/v1/creators/${creatorB.id}`)
      .set('Authorization', `Bearer ${memberA.accessToken}`);
    const update = await request(app)
      .patch(`/v1/creators/${creatorB.id}`)
      .set('Authorization', `Bearer ${memberA.accessToken}`)
      .set('If-Match', '"1"')
      .send({ displayName: 'Cross-tenant write' });
    const members = await request(app)
      .get(`/v1/creators/${creatorB.id}/members`)
      .set('Authorization', `Bearer ${memberA.accessToken}`);
    const roleChange = await request(app)
      .patch(`/v1/creators/${creatorB.id}/members/${ownerB.userId}`)
      .set('Authorization', `Bearer ${memberA.accessToken}`)
      .send({ role: 'viewer' });

    expect([read.status, update.status, members.status, roleChange.status]).toEqual([
      404, 404, 404, 404,
    ]);
    const persisted = await applicationDatabase.query<{ readonly displayName: string }>(
      'select display_name as "displayName" from app.creators where id = $1',
      [creatorB.id],
    );
    expect(persisted.rows).toEqual([{ displayName: 'Tenant B' }]);
  });

  it('protects memberships, the final owner, and concurrent ownership', async () => {
    const owner = await createActor();
    const secondOwner = await createActor();
    const manager = await createActor();
    const creator = await createCreator(owner);

    expect((await addMember(owner, creator.id, manager, 'manager')).status).toBe(201);
    expect((await addMember(owner, creator.id, manager, 'viewer')).status).toBe(409);

    const selfPromotion = await request(app)
      .patch(`/v1/creators/${creator.id}/members/${manager.userId}`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ role: 'owner' });
    expect(selfPromotion.status).toBe(403);

    const finalDemotion = await request(app)
      .patch(`/v1/creators/${creator.id}/members/${owner.userId}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ role: 'viewer' });
    const finalRemoval = await request(app)
      .delete(`/v1/creators/${creator.id}/members/${owner.userId}`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(finalDemotion.status).toBe(409);
    expect(finalRemoval.status).toBe(409);

    const roleChange = await request(app)
      .patch(`/v1/creators/${creator.id}/members/${manager.userId}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ role: 'editor' });
    const memberRemoval = await request(app)
      .delete(`/v1/creators/${creator.id}/members/${manager.userId}`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(roleChange.status).toBe(200);
    expect(memberRemoval.status).toBe(204);

    const membershipAuditActions = auditRecords
      .filter((record) => record.message === 'creator.audit')
      .map((record) => record.attributes?.action);
    expect(membershipAuditActions).toContain('creator.member_added');
    expect(membershipAuditActions).toContain('creator.member_role_changed');
    expect(membershipAuditActions).toContain('creator.member_removed');
    expect(JSON.stringify(auditRecords)).not.toContain(owner.accessToken);

    expect((await addMember(owner, creator.id, secondOwner, 'owner')).status).toBe(201);
    const concurrent = await Promise.all([
      request(app)
        .delete(`/v1/creators/${creator.id}/members/${secondOwner.userId}`)
        .set('Authorization', `Bearer ${owner.accessToken}`),
      request(app)
        .delete(`/v1/creators/${creator.id}/members/${owner.userId}`)
        .set('Authorization', `Bearer ${secondOwner.accessToken}`),
    ]);
    expect(concurrent.map((response) => response.status).sort()).toEqual([204, 404]);
    const ownerCount = await applicationDatabase.query<{ readonly count: string }>(
      `select count(*)::text as count
         from app.creator_memberships
        where creator_id = $1 and role = 'owner'`,
      [creator.id],
    );
    expect(ownerCount.rows).toEqual([{ count: '1' }]);

    const databaseCreator = await createCreator(await createActor(), 'Database Concurrency');
    const databaseOwnerA = await createActor();
    const databaseOwnerB = await createActor();
    await applicationDatabase.query(
      `insert into app.creator_memberships (creator_id, user_id, role)
       values ($1, $2, 'owner'), ($1, $3, 'owner')`,
      [databaseCreator.id, databaseOwnerA.userId, databaseOwnerB.userId],
    );
    await applicationDatabase.query(
      `delete from app.creator_memberships
        where creator_id = $1 and user_id not in ($2, $3)`,
      [databaseCreator.id, databaseOwnerA.userId, databaseOwnerB.userId],
    );
    const directResults = await Promise.allSettled([
      applicationDatabase.transaction((transaction) =>
        transaction.query(
          'delete from app.creator_memberships where creator_id = $1 and user_id = $2',
          [databaseCreator.id, databaseOwnerA.userId],
        ),
      ),
      applicationDatabase.transaction((transaction) =>
        transaction.query(
          'delete from app.creator_memberships where creator_id = $1 and user_id = $2',
          [databaseCreator.id, databaseOwnerB.userId],
        ),
      ),
    ]);
    expect(directResults.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    const directOwnerCount = await applicationDatabase.query<{ readonly count: string }>(
      `select count(*)::text as count
         from app.creator_memberships
        where creator_id = $1 and role = 'owner'`,
      [databaseCreator.id],
    );
    expect(directOwnerCount.rows).toEqual([{ count: '1' }]);
  });

  it('uses optimistic revisions so concurrent updates cannot silently overwrite', async () => {
    const owner = await createActor();
    const creator = await createCreator(owner);
    const responses = await Promise.all([
      request(app)
        .patch(`/v1/creators/${creator.id}`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .set('If-Match', '"1"')
        .send({ displayName: 'Concurrent A' }),
      request(app)
        .patch(`/v1/creators/${creator.id}`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .set('If-Match', '"1"')
        .send({ displayName: 'Concurrent B' }),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const persisted = await applicationDatabase.query<{
      readonly displayName: string;
      readonly revision: number;
    }>(`select display_name as "displayName", revision from app.creators where id = $1`, [
      creator.id,
    ]);
    expect(persisted.rows[0]?.revision).toBe(2);
    expect(['Concurrent A', 'Concurrent B']).toContain(persisted.rows[0]?.displayName);
  });
});
