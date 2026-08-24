import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { parseDatabaseEnvironment, parseMigrationEnvironment } from '@creatordrop/config';
import { createDatabasePool, type Database } from '@creatordrop/database';

import { createApp } from '../src/app.js';
import { createAuthenticationMiddleware } from '../src/modules/auth/authentication.middleware.js';
import { createJwtVerifier } from '../src/modules/auth/jwt-verifier.js';
import { createUserBootstrapService } from '../src/modules/users/bootstrap-user.service.js';
import {
  createNoopLogger,
  createUnhandledCatalogService,
  createUnhandledCreatorService,
  createUnhandledFairnessService,
  createUnhandledWalletService,
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

interface LocalAuthSession {
  readonly accessToken: string;
  readonly subject: string;
}

const parseLocalAuthSession = (body: unknown): LocalAuthSession => {
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

describe('local Supabase identity bootstrap', { concurrent: false }, () => {
  const apiUrl = requireEnvironment('LOCAL_SUPABASE_API_URL').replace(/\/$/u, '');
  const publishableKey = requireEnvironment('LOCAL_SUPABASE_PUBLISHABLE_KEY');
  const authIssuer = `${apiUrl}/auth/v1`;
  const applicationEnvironment = parseDatabaseEnvironment({
    DATABASE_APPLICATION_NAME: 'creatordrop-auth-integration-test',
    DATABASE_CONNECTION_TIMEOUT_MS: '5000',
    DATABASE_IDLE_TIMEOUT_MS: '1000',
    DATABASE_POOL_MAX: '10',
    DATABASE_URL: process.env.DATABASE_URL ?? localApplicationUrl,
  });
  const migrationEnvironment = parseMigrationEnvironment({
    DATABASE_MIGRATION_URL: process.env.DATABASE_MIGRATION_URL ?? localMigrationUrl,
  });
  const logger = createNoopLogger();
  let applicationDatabase: Database;
  let migrationDatabase: Database;

  const removeSyntheticUsers = async (): Promise<void> => {
    await migrationDatabase.query(`
      delete from app.users
       where auth_provider = 'supabase'
         and auth_subject in (
           select id::text from auth.users where email like 'phase3-%@example.test'
         )
    `);
    await migrationDatabase.query(`
      delete from auth.users where email like 'phase3-%@example.test'
    `);
  };

  const createLocalAuthSession = async (): Promise<LocalAuthSession> => {
    const response = await fetch(`${authIssuer}/signup`, {
      body: JSON.stringify({
        email: `phase3-${randomUUID()}@example.test`,
        password: `Local-only-${randomUUID()}-Aa1!`,
      }),
      headers: {
        apikey: publishableKey,
        'content-type': 'application/json',
      },
      method: 'POST',
    });

    if (!response.ok) {
      throw new Error(
        `Local Supabase Auth sign-up failed with status ${response.status.toString()}.`,
      );
    }

    return parseLocalAuthSession(await response.json());
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
      applicationName: 'creatordrop-auth-integration-admin',
      connectionString: migrationEnvironment.connectionString,
      onUnexpectedPoolError: (error) => {
        throw error;
      },
    });
    await removeSyntheticUsers();
  });

  afterEach(removeSyntheticUsers);

  afterAll(async () => {
    await removeSyntheticUsers();
    await Promise.all([applicationDatabase.close(), migrationDatabase.close()]);
  });

  const createIntegratedApp = () => {
    const verifyAccessToken = createJwtVerifier({
      audience: 'authenticated',
      issuer: authIssuer,
      jwksUrl: `${authIssuer}/.well-known/jwks.json`,
      provider: 'supabase',
    });

    return createApp({
      authenticate: createAuthenticationMiddleware({
        bootstrapUsers: createUserBootstrapService({ database: applicationDatabase }),
        verifyAccessToken,
      }),
      catalogService: createUnhandledCatalogService(),
      creatorService: createUnhandledCreatorService(),
      fairnessService: createUnhandledFairnessService(),
      logger,
      runtime: { testCreditsEnabled: false },
      security: {
        allowedOrigins: ['http://localhost:5173'],
        authRateLimitMax: 100,
        authRateLimitWindowMs: 60_000,
        creatorMutationRateLimitMax: 100,
        creatorMutationRateLimitWindowMs: 60_000,
        fairnessMutationRateLimitMax: 100,
        fairnessMutationRateLimitWindowMs: 60_000,
        requestBodyLimitBytes: 32_768,
        walletMutationRateLimitMax: 100,
        walletMutationRateLimitWindowMs: 60_000,
      },
      walletService: createUnhandledWalletService(),
    });
  };

  it('verifies a real issued token and bootstraps exactly one UUIDv7 user concurrently', async () => {
    const session = await createLocalAuthSession();
    const app = createIntegratedApp();
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(app)
          .post('/v1/auth/session/exchange')
          .set('Authorization', `Bearer ${session.accessToken}`)
          .send({}),
      ),
    );
    const persisted = await applicationDatabase.query<{
      id: string;
      status: string;
      username: string;
    }>(
      `select id::text as id, status, username::text as username
         from app.users
        where auth_provider = $1 and auth_subject = $2`,
      ['supabase', session.subject],
    );

    expect(persisted.rows).toHaveLength(1);
    expect(persisted.rows[0]?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );

    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ user: persisted.rows[0] });
    }
  });

  it('rejects request-supplied identity fields before creating a local user', async () => {
    const session = await createLocalAuthSession();
    const response = await request(createIntegratedApp())
      .post('/v1/auth/session/exchange')
      .set('Authorization', `Bearer ${session.accessToken}`)
      .send({ authSubject: randomUUID(), userId: randomUUID() });
    const persisted = await applicationDatabase.query<{ count: string }>(
      `select count(*)::text as count
         from app.users
        where auth_provider = $1 and auth_subject = $2`,
      ['supabase', session.subject],
    );

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    expect(persisted.rows).toEqual([{ count: '0' }]);
  });

  it.each(['suspended', 'closed'] as const)('denies a real token for a %s user', async (status) => {
    const session = await createLocalAuthSession();
    const app = createIntegratedApp();
    const initial = await request(app)
      .post('/v1/auth/session/exchange')
      .set('Authorization', `Bearer ${session.accessToken}`)
      .send({});

    expect(initial.status).toBe(200);

    await applicationDatabase.query(
      `update app.users
          set status = $1,
              closed_at = case when $1 = 'closed' then statement_timestamp() else null end,
              updated_at = statement_timestamp()
        where auth_provider = $2 and auth_subject = $3`,
      [status, 'supabase', session.subject],
    );

    const denied = await request(app)
      .post('/v1/auth/session/exchange')
      .set('Authorization', `Bearer ${session.accessToken}`)
      .send({});

    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ error: { code: 'ACCOUNT_NOT_ACTIVE' } });
  });
});
