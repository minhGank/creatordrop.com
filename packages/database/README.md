# Database package

This package is the only shared PostgreSQL access foundation. It intentionally contains no application-domain schema or repositories in Phase 2.

It provides:

- a bounded `pg` connection pool;
- typed, parameterized query execution;
- an explicit transaction helper;
- real-PostgreSQL integration-test support.

Migrations live in `infra/supabase/migrations` and are applied by the pinned Supabase CLI. Runtime code must never use ORM schema synchronization.
