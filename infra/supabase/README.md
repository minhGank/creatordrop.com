# Local Supabase PostgreSQL and Auth

This directory is a local-only Supabase CLI project. It is not linked to a hosted Supabase project.

The Phase 5 workflow starts PostgreSQL, Supabase Auth, and the local API gateway. Realtime, storage, PostgREST, Studio, Edge Runtime, analytics, the pooler, and mail services remain excluded. Auth is local-only and this project must not be linked to Supabase Cloud.

From the repository root:

```bash
npm run db:start
npm run db:migrations:validate
npm run test:integration
npm run db:stop
```

`db:migrations:validate` is intentionally destructive to the local development database: it resets it from empty, applies every committed migration in order, and runs `plpgsql_check` through `supabase db lint`. Do not point these commands at a hosted or shared database.

`npm run test:integration` reads local Auth connection details from the CLI without printing credentials, creates synthetic Auth users, creator workspaces, and catalog records, and cleans them up after each test. It exercises the restricted application role, creator tenancy, authorization, owner invariants, optimistic concurrency, publication transactions, historical immutability, and catalog constraints against real PostgreSQL. No service-role key or checked-in JWT fixture is required.

Create a migration with:

```bash
npm run db:migration:new -- descriptive_name
```

Review the generated SQL and keep migrations forward-only. Never edit a migration after it has been applied outside an ephemeral local environment.
