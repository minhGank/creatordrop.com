# Local Development

## Prerequisites

- Node.js 24 and npm 11 (see `.nvmrc`);
- Docker Desktop running;
- dependencies installed with `npm ci` or `npm install`.

The Supabase CLI is a lockfile-pinned development dependency. No global CLI installation, Supabase login, hosted project, or `supabase link` is required.

## Local PostgreSQL and Auth workflow

Start the minimal Supabase stack required by Phases 3–5:

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

Phase 2 creates `app` and `app_private`, restricted roles, default privileges, and foundational extensions. Phase 3 adds local users; Phase 4 adds creator workspaces, memberships, and their ownership invariants. Phase 5 adds only box/reward identities, immutable version snapshots, and ordered weighted associations. Opening, RNG state, wallet, ledger, fulfillment, outbox, payment, Redis, and realtime tables remain absent.

## Database package

`@creatordrop/database` wraps a bounded `pg` pool. Callers provide validated configuration and an unexpected-pool-error handler. Queries accept SQL text plus positional values and return typed `pg` results.

Use `database.transaction(callback, options)` for atomic work. It checks out one client, begins with an explicit isolation/read policy, passes a transaction-scoped query executor to the callback, commits only after callback success, rolls back on failure, and always releases the client. Do not retain the executor after the callback or perform external network operations inside it.

## Integration tests and isolation

With local PostgreSQL running and migrations validated:

```bash
npm run test:integration
```

Tests connect to real PostgreSQL. Foundation transaction tests use dedicated PostgreSQL sessions and session-private temporary tables. Identity, creator-tenancy, and catalog tests create unique synthetic users through the local Supabase Auth HTTP API, obtain real issued access tokens, verify those tokens through the live local JWKS endpoint, and clean up their synthetic state after every test. Creator integration tests exercise the full role matrix, tenant-scoped queries, final-owner races, and optimistic-update races. Catalog integration tests use the restricted application role and production migrations to exercise box/reward drafts, publication rollback, tenant ownership, optimistic concurrency, canonical history, and database immutability/constraint triggers. The test runner reads the local publishable key from `supabase status` in memory and does not print or commit it.

`npm test` excludes `*.integration.test.ts`; unit tests never silently require PostgreSQL.

## Deterministic RNG and verifier

Phase 6 has two deliberately separate workspaces:

- `@creatordrop/domain` contains strict manifest verification, production HMAC construction, rejection sampling, weighted selection, and `selectReward`;
- `@creatordrop/rng-verifier` independently recomputes revealed proofs and has no dependency on the production domain package.

The checked-in JSON vectors are public synthetic fixtures, not active seed material. The primitive corpus includes crafted rejection-boundary sequences and an independently checked round-10 HMAC known answer. Verify that the standalone reference generator reproduces both vector documents exactly with:

```bash
npm run check:rng-vectors
```

Use `node scripts/generate-rng-test-vectors.mjs --primitives` to print the primitive corpus for review. The check command and source-level verifier/generator independence check are part of local and GitHub CI. RNG tests run under ordinary `npm test` and require no Supabase, database, network, clock, or environment configuration.

## RNG seed lifecycle configuration

The API requires the Phase 7 variables shown in `.env.example`:

- `RNG_MASTER_KEY`: exactly 32 bytes encoded as 64 lowercase hexadecimal characters; no runtime default;
- `RNG_MASTER_KEY_VERSION`: the persisted key-version identifier;
- `RNG_HISTORICAL_MASTER_KEYS`: strict JSON array of retained decrypt-only entries such as `[{"version":"production-v1","key":"<64 lowercase hex>"}]`;
- `RNG_MAX_OPENINGS_PER_SEED`: positive signed-64 policy value, normally `1000`;
- `RNG_MAX_SEED_AGE_MS`: age policy, normally `86400000` (24 hours);
- fairness mutation rate-limit window/count.

The example key is deliberately synthetic and local-only. It and local-development version sentinels are accepted only when raw configuration explicitly sets `NODE_ENV=development` or `NODE_ENV=test`; omitted or production mode rejects them. Generate independent secret material for every deployed environment and inject it through the deployment secret store; never copy the example into production. Historical entries are strict, duplicate-free, decrypt-only entries. When changing the active key/version, retain each old key in `RNG_HISTORICAL_MASTER_KEYS` until all seed sets encrypted by that version have been revealed.

The key registry stores only `SHA-256(raw 32-byte key)` for equality and never stores key material. The migration pre-registers only the documented `local-dev-v1` all-zero example fingerprint. Before deploying any other active or historical version, derive the fingerprint inside the secured secret environment and insert `(version, decode('<64 lowercase hex fingerprint>', 'hex'))` into `app.rng_encryption_key_versions` using migration/operator credentials. Verify the stored version and fingerprint before enabling the application configuration. Version and fingerprint are both unique, mappings are immutable, and the application role is read-only, so key bytes cannot silently change under a version or be relabeled after compromise.

The migrations cannot infer a pre-hardening row's encryption key from ciphertext. They therefore preserve an unregistered or null-identity row as unresolved and fail nonce use, reveal, rotation, and compromise replacement closed until its exact registry mapping is established. Provision the authoritative mappings first, then use migration credentials in one transaction to update only null identities for the exact versions, and verify every affected row count and fingerprint before commit. The null-to-populated history update must equal the protected mapping; a mismatch is rejected and requires incident review rather than correction in place. A completed legacy `key_compromise` replacement using one version or an already-established equal identity makes the forward migration fail. A different-version replacement stays explicitly unresolved until both mappings are operator-verified, at which point deferred constraints revalidate it. Never log a key or silently rewrite invalid lifecycle history: retain the database, investigate/quarantine any rejected history, and resolve it through an audited forward migration or incident procedure before retrying.

Phase 7 integration tests exercise encrypted storage, real PostgreSQL row locks, rollback, rotation/reveal, corruption, key unavailability/recovery, original-schema upgrades, and Supabase Auth through `npm run test:integration`.

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

Supabase Auth performs sign-up/sign-in. Send its access token as `Authorization: Bearer <token>` to `POST /v1/auth/session/exchange` with `{}` to create or retrieve the local user. The same bearer token can then create a creator workspace, list the actor's workspaces, and use the creator-scoped box/reward draft and publication endpoints documented in `API.md`. Monetary amounts, inventory quantities, and weights are JSON decimal strings. Mutations after creation require the current quoted revision in `If-Match`. Adding a member currently uses that existing local user's CreatorDrop UUID directly; invitation/email workflows are intentionally deferred. The API needs only the public JWKS URL for verification; never add a Supabase service-role/secret key to browser code.

The bootstrap, creator-mutation, and fairness limiters are intentionally in memory and per API process. Fairness mutations use a generous pre-authentication IP gate followed by an actor-keyed authenticated budget; public seed-history reads use a separate generous IP budget. Before horizontally scaled production deployment, choose a shared limiter store and define the trusted reverse-proxy/IP policy. Redis was intentionally not introduced for this Phase 7 hardening pass.

## Full validation

With the local stack running:

```bash
npm run ci
```

This matches the repository CI quality sequence, including a destructive migration reset and real PostgreSQL integration tests.
