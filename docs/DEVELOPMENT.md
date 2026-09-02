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

Phase 2 creates `app` and `app_private`, restricted roles, default privileges, and foundational
extensions. Phases 3–5 add users, creator tenancy, and versioned catalog configuration. Phases
6–7 add deterministic RNG and encrypted per-user seed lifecycle. Phase 8 adds
multi-currency-capable wallets, immutable double-entry history, and reusable idempotency; only
USD synthetic credits are enabled. Phase 9 adds atomic openings and transactional outbox rows.
Phase 10 adds durable outbox delivery and Socket.io only. Phase 11 adds Stripe test-mode USD
funding, signed webhooks, provider compensation/deficits, and read-only reconciliation. Phase 12
adds typed fulfillment, protected delivery data, audited creator access, and manual immutable
restock events. Phase 13 adds disposable Redis leaderboards/public catalog cache plus authoritative
PostgreSQL seasons/champion achievements. Payout, carrier integration, automatic restock/box
resume, currency conversion, and leaderboard UI remain absent.

## Database package

`@creatordrop/database` wraps a bounded `pg` pool. Callers provide validated configuration and an unexpected-pool-error handler. Queries accept SQL text plus positional values and return typed `pg` results.

Use `database.transaction(callback, options)` for atomic work. It checks out one client, begins with an explicit isolation/read policy, passes a transaction-scoped query executor to the callback, commits only after callback success, rolls back on failure, and always releases the client. Do not retain the executor after the callback or perform external network operations inside it.

## Integration tests and isolation

With local PostgreSQL running and migrations validated:

```bash
npm run test:integration
```

Tests connect to real PostgreSQL. Foundation transaction tests use dedicated PostgreSQL sessions and session-private temporary tables. Identity, creator-tenancy, and catalog tests use local Supabase Auth and production migrations. Wallet tests use unique synthetic users plus independent one-connection pools and PostgreSQL lock-graph barriers to prove same-wallet serialization, different-wallet concurrency, exact-once idempotency, rollback, balancing, immutability, and reconciliation. The upgrade harness applies Phase 8 over representative completed Phase 7 history in an isolated temporary database. The test runner reads the local publishable key from `supabase status` in memory and does not print or commit it.

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

## Fulfillment encryption and restock configuration

Phase 12 requires independent address and digital-delivery key domains:

- `FULFILLMENT_ACTOR_BINDING_KEY` / `_VERSION`, a distinct short-lived command-signing key whose
  matching verifier entry is readable only inside `app_private` security-definer code;
- `FULFILLMENT_ADDRESS_MASTER_KEY` / `_VERSION` and strict JSON
  `FULFILLMENT_ADDRESS_HISTORICAL_MASTER_KEYS`;
- `DIGITAL_DELIVERY_MASTER_KEY` / `_VERSION` and strict JSON
  `DIGITAL_DELIVERY_HISTORICAL_MASTER_KEYS`;
- optional `FULFILLMENT_DATA_RETENTION_MS`; omit it until legal/operations approves a period.

Every key is exactly 32 bytes as lowercase hex. All configured RNG, address, digital-secret, and
actor-binding keys use different material. Startup hashes the decoded bytes and rejects overlap
across active and historical configurations. The public `00…`/`11…`/`22…`/`33…` examples and local version names require explicit
development/test mode and are rejected otherwise. Before configuring another key, use protected
operator credentials to register only `SHA-256(raw key)` with its domain/version in
`app.fulfillment_encryption_key_versions`; the private cross-domain identity registry makes the
same fingerprint unusable in the RNG or actor-binding registry, including under concurrent
provisioning. Never store or log an RNG/address/digital encryption key. Retain old configured keys
while ciphertext references them. Missing/mismatched historical material fails closed and must
not be treated as corruption or silently rewritten.

Rotate the actor-binding verifier explicitly with
`app_private.rotate_fulfillment_actor_binding_key(new_version, new_key_material, reason)` under
migration/operator credentials, then inject the same active version/material into the API secret
environment. Rotation atomically retires the previous version, derives and reserves the new
SHA-256 identity in the shared domain registry, and appends immutable audit history. Exactly one
version remains active; retired versions immediately stop verifying capabilities, while existing
mutation idempotency makes an interrupted short-lived request safe to retry. The restricted
application role can read only the active non-secret version/fingerprint and cannot read or mutate
raw verifier keys or rotation history. The API confirms its configured identity is active before
signing a 30-second capability over the authenticated actor and exact
operation/creator/resource/event/revision/action/fingerprint/quantity scope. The checked-in `33…`
entry is local-only.

The same domain key provider derives a purpose-separated HMAC subkey for sensitive-command
idempotency fingerprints. Immutable events store only the opaque fingerprint and non-secret key
domain/version; address or redemption-code hashes are never stored directly.

Manual restock is `POST /v1/creators/:creatorId/dashboard/inventory-pools/:poolId/restocks` with
owner/manager authentication, `Idempotency-Key`, and a canonical positive decimal quantity.
Restock appends history and changes availability atomically for a published/shared pool. Backorders are separately resolved
through their typed fulfillment action; neither paused-box resume nor automatic resolution occurs.

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

Supabase Auth performs sign-up/sign-in. Send its access token as `Authorization: Bearer <token>` to `POST /v1/auth/session/exchange` with `{}` to create or retrieve the local user. The same token can use the creator/catalog/fairness APIs and `GET /v1/me/wallets`. With the explicit local `.env.example` opt-in `WALLET_TEST_CREDITS_ENABLED=true`, `POST /v1/me/wallets/USD/test-credits` accepts a canonical decimal-string `amountMinor` and `Idempotency-Key`. The flag defaults false and is rejected in production, where the route is absent and the service is disabled. Monetary amounts, inventory quantities, and weights are JSON decimal strings. The API needs only the public JWKS URL for verification; never add a Supabase service-role/secret key to browser code.

For the Phase 14 web app, copy the local `API_URL` and `PUBLISHABLE_KEY` reported by
`supabase status --workdir infra --output json` into `VITE_SUPABASE_URL` and
`VITE_SUPABASE_PUBLISHABLE_KEY`. These values are intentionally public; never substitute a secret
or service-role key. Start the API and web app in separate terminals:

```bash
npm run dev:api
npm run dev:web
```

The web app uses per-tab `sessionStorage` for Supabase session restoration. Public catalog routes
work without a session. All CreatorDrop requests flow through `apps/web/src/api/client.ts`, which
validates shared contracts and error envelopes. UI code must keep catalog text in React's escaped
text path, format money from decimal minor-unit strings, preserve exact integer odds alongside any
percentage display, provide explicit loading/error/empty states, and respect reduced motion.

For Stripe sandbox funding, set `STRIPE_FUNDING_ENABLED=true` only with explicit `NODE_ENV=development` or `test`, then supply a test-mode `STRIPE_SECRET_KEY` and the signing secret printed by `stripe listen --forward-to http://127.0.0.1:3000/v1/webhooks/stripe`. Never commit either value. Create a funding intent with `POST /v1/me/wallets/USD/funding-intents`, `{ "amountMinor": "2000" }`, and an `Idempotency-Key`; confirm the PaymentIntent using Stripe's client SDK/test payment methods. Only the signed webhook can credit the wallet. The configured limits are USD 500–50000 minor units. Local funding is closed-loop/nonwithdrawable, and no self-service refund route exists.

Phase 11 integration tests mock only Stripe transport/event normalization; all intents, provider-event idempotency, ledger postings, wallet projections, refunds/disputes, deficits, rollback, and reconciliation assertions use real local PostgreSQL. `npm run test:integration` also applies the Phase 8 → current forward-upgrade harness. The application never stores raw webhook payloads or card data; only allowlisted identities/state and an exact raw-payload SHA-256 hash are retained.

The bootstrap, creator, fairness, and wallet-mutation limiters are intentionally in memory and per API process. Wallet test-credit mutations use a pre-authentication IP gate followed by an actor-keyed budget. Before horizontally scaled production deployment, choose a shared limiter store and define the trusted reverse-proxy/IP policy. Redis is not introduced in Phase 8.

Financial mutation primitives accept only the branded transaction executor. The Phase 9 opening
composition acquires the idempotency claim, wallet, fairness profile, seed, and inventory locks
in the documented order, then inserts ledger/business/outbox rows before one final commit.
Ledger history is authoritative; `reconcileWallet` compares the cached wallet projection with
the signed-entry sum and never repairs history.

## Durable outbox and realtime worker

Phase 10 introduces a distinct `creatordrop_worker` PostgreSQL role. The local
`WORKER_DATABASE_URL` in `.env.example` selects that role; production must provision an
independent credential with only that role's privileges. `REALTIME_WORKER_TOKEN` authenticates
the worker to the API's internal `/worker` Socket.io namespace. The checked-in token is an
obvious local fixture and is rejected unless raw `NODE_ENV` explicitly says `development` or
`test`; generate and inject independent production secret material.

With Supabase and the API running, start the outbox worker:

```bash
npm run dev:worker
```

The worker immediately polls, then waits `WORKER_POLL_INTERVAL_MS` after each completed batch.
It claims at most `OUTBOX_BATCH_SIZE` committed rows for `OUTBOX_LEASE_MS`. Socket publication
must acknowledge within `REALTIME_PUBLISH_TIMEOUT_MS`, which configuration requires to be
shorter than the lease. Failures retry at deterministic exponential delays bounded by
`OUTBOX_RETRY_MAX_MS`; `OUTBOX_MAX_ATTEMPTS` exhaustion and permanently malformed versions
remain `dead` for operator inspection. Do not delete delivered/dead rows or edit event content.

The worker logs `outbox.lag.observed` with decimal-string pending, processing, dead, and oldest
ready-age values. It logs IDs/types and stable error codes, never complete payloads. A delivered
row means the realtime gateway acknowledged the broadcast, not that a browser was connected.
Clients deduplicate durable event IDs and refetch/replay authoritative HTTP commands after every
`realtime.ready.v1` reconnect signal. Current rooms are process-local; define a supported
cross-node Socket.io adapter and sticky-connection policy before horizontally scaling the API.
Phase 13 adds an independent leaderboard projection loop to this worker when `REDIS_URL` is set.
Realtime outbox delivery continues when Redis is absent; leaderboard reads fall back to
PostgreSQL, and no financial/opening/payment/fulfillment command uses Redis. Projection claims use
`LEADERBOARD_PROJECTION_BATCH_SIZE`, `LEADERBOARD_PROJECTION_LEASE_MS`, and
`LEADERBOARD_PROJECTION_MAX_ATTEMPTS`.

## Local Redis and leaderboard maintenance

Start/stop the disposable Redis 7.4 development container:

```bash
npm run redis:start
npm run redis:stop
```

The local endpoint is `redis://127.0.0.1:56379`. The integration runner starts it when needed and
uses real Redis; financial tests remain valid with Redis unavailable. `REDIS_URL` enables both the
API's leaderboard/catalog reads and the worker projection. `PUBLIC_CATALOG_CACHE_TTL_SECONDS`
defaults to 300. Cached catalog documents are accepted only when their canonical manifest box and
version UUIDs match the requested cache identity; mismatches are discarded and reloaded from
PostgreSQL.

Rebuild all generations from PostgreSQL or report drift without changing PostgreSQL:

```bash
npm run leaderboards:rebuild
npm run leaderboards:reconcile
```

Both commands require the restricted `WORKER_DATABASE_URL` plus `REDIS_URL`. Rebuild writes a new
generation, dual-writes live events during the operation, atomically swaps it active, and is safe
to repeat. Reconciliation reports missing/extra scopes, row/stat/tie drift, and freshness drift.
Season windows are explicit operator-managed PostgreSQL rows (normally about three months):
provision a scheduled row, activate it with the private migration/operator function, and let the
worker reconcile and finalize after `ends_at`. Do not insert champion results or achievements
manually.

## Full validation

With the local stack running:

```bash
npm run ci
```

This matches the repository CI quality sequence, including a destructive migration reset and real PostgreSQL integration tests.
