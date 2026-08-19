# Local Development

## Prerequisites

- Node.js 24 and npm 11 (see `.nvmrc`);
- Docker Desktop running;
- dependencies installed with `npm ci` or `npm install`.

The Supabase CLI is a lockfile-pinned development dependency. No global CLI installation, Supabase login, hosted project, or `supabase link` is required.

## Local PostgreSQL workflow

Start the database-only Supabase stack:

```bash
npm run db:start
```

Copy `.env.example` to `.env` if local overrides are needed. The default integration-test URLs connect to port `54322`; the application URL assumes the restricted `creatordrop_app` role through a local `postgres` connection. Production must use separately provisioned credentials and must never reuse these local values.

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

Tests connect to real PostgreSQL. Each stateful test uses a pool limited to one dedicated session and a PostgreSQL temporary table. Temporary schemas/tables are session-private and disappear when the pool closes, so tests cannot observe one another's state. The migration inspection uses the separate local migration connection.

`npm test` excludes `*.integration.test.ts`; unit tests never silently require PostgreSQL.

## Full validation

With the local stack running:

```bash
npm run ci
```

This matches the repository CI quality sequence, including a destructive migration reset and real PostgreSQL integration tests.
