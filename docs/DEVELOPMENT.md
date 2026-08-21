# Local Development

## Prerequisites

- Node.js 24 and npm 11 (see `.nvmrc`);
- Docker Desktop running;
- dependencies installed with `npm ci` or `npm install`.

The Supabase CLI is a lockfile-pinned development dependency. No global CLI installation, Supabase login, hosted project, or `supabase link` is required.

## Local PostgreSQL and Auth workflow

Start the minimal Supabase stack required by Phase 3:

```bash
npm run db:start
```

This starts PostgreSQL, Supabase Auth, and the local API gateway. Realtime, storage, PostgREST, Studio, Edge Runtime, analytics, the pooler, and mail services remain excluded. This project is local-only: no Supabase login, hosted project, link, or cloud mutation is used.

Copy `.env.example` to `.env` if local overrides are needed. The default integration-test URLs connect to PostgreSQL on port `54322`; Auth/JWKS are exposed through the local gateway on port `54321`. The application URL assumes the restricted `creatordrop_app` role through a local `postgres` connection. Production must use separately provisioned credentials and must never reuse these local values.

Reset from empty, apply all migrations, and lint the resulting schemas:

```bash
npm run db:migrations:validate
```

This command destroys local database data. Stop and remove the local stack without a backup:

```bash
npm run db:stop
```

## SQL-first migrations

Create a timestamped migration:

```bash
npm run db:migration:new -- descriptive_name
```

Migration files live in `infra/supabase/migrations` and must match `YYYYMMDDHHMMSS_descriptive_name.sql`. Versions are unique and applied lexically/chronologically by Supabase. Migrations are forward-only and immutable after leaving an ephemeral local environment.

Extensions and role administration run before reducing privileges. Normal application objects should use:

```sql
set role creatordrop_migrator;

-- Explicit application schema changes here.

reset role;
```

Phase 2 creates only `app` and `app_private`, restricted roles, default privileges, and foundational extensions. It creates no application tables.

## Database package

`@creatordrop/database` wraps a bounded `pg` pool. Callers provide validated configuration and an unexpected-pool-error handler. Queries accept SQL text plus positional values and return typed `pg` results.

Use `database.transaction(callback, options)` for atomic work. It checks out one client, begins with an explicit isolation/read policy, passes a transaction-scoped query executor to the callback, commits only after callback success, rolls back on failure, and always releases the client. Do not retain the executor after the callback or perform external network operations inside it.

## Integration tests and isolation

With local PostgreSQL running and migrations validated:

```bash
npm run test:integration
```

Tests connect to real PostgreSQL. Foundation transaction tests use dedicated PostgreSQL sessions and session-private temporary tables. Identity tests create unique synthetic users through the local Supabase Auth HTTP API, obtain real issued access tokens, verify those tokens through the live local JWKS endpoint, and remove their `auth.users` and `app.users` rows after every test. The test runner reads the local publishable key from `supabase status` in memory and does not print or commit it.

`npm test` excludes `*.integration.test.ts`; unit tests never silently require PostgreSQL.

## Run the API locally

Start Supabase, export the example environment, and run the API watcher:

```bash
npm run db:start
cp .env.example .env
set -a
source .env
set +a
npm run dev:api
```

Supabase Auth performs sign-up/sign-in. Send its access token as `Authorization: Bearer <token>` to `POST /v1/auth/session/exchange` with `{}` to create or retrieve the local user. The API needs only the public JWKS URL for verification; never add a Supabase service-role/secret key to browser code.

The Phase 3 bootstrap rate limiter is intentionally in memory and per API process. Before horizontally scaled production deployment, choose a shared limiter store and define the trusted reverse-proxy/IP policy.

## Full validation

With the local stack running:

```bash
npm run ci
```

This matches the repository CI quality sequence, including a destructive migration reset and real PostgreSQL integration tests.
