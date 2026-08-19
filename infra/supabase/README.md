# Local Supabase PostgreSQL

This directory is a local-only Supabase CLI project. It is not linked to a hosted Supabase project.

The Phase 2 workflow starts only the PostgreSQL container. Other Supabase services remain excluded until a roadmap phase requires them.

From the repository root:

```bash
npm run db:start
npm run db:migrations:validate
npm run test:integration
npm run db:stop
```

`db:migrations:validate` is intentionally destructive to the local development database: it resets it from empty, applies every committed migration in order, and runs `plpgsql_check` through `supabase db lint`. Do not point these commands at a hosted or shared database.

Create a migration with:

```bash
npm run db:migration:new -- descriptive_name
```

Review the generated SQL and keep migrations forward-only. Never edit a migration after it has been applied outside an ephemeral local environment.
