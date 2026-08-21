# Database package

This package is the shared PostgreSQL access foundation. Application-domain schemas live in SQL migrations, while domain-specific repositories remain inside their owning API modules.

It provides:

- a bounded `pg` connection pool;
- typed, parameterized query execution;
- an explicit transaction helper;
- real-PostgreSQL integration-test support.

Migrations live in `infra/supabase/migrations` and are applied by the pinned Supabase CLI. Runtime code must never use ORM schema synchronization.
