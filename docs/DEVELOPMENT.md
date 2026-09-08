# Local Development

## Prerequisites

- Node.js 24 and npm 11 (see `.nvmrc`);
- Docker Desktop running;
- dependencies installed with `npm ci` or `npm install`.

The Supabase CLI is a lockfile-pinned development dependency. No global CLI installation, Supabase login, hosted project, or `supabase link` is required.

## Local PostgreSQL and Auth workflow

Start the minimal Supabase stack required by the active product:

```bash
npm run db:start
```

This starts PostgreSQL, Supabase Auth, private Storage (R2A), and the local API gateway. Realtime,
image transformation, PostgREST, Studio, Edge Runtime, analytics, the pooler, and mail services
remain excluded. This project is local-only: no Supabase login, hosted project, link, or cloud
mutation is used. If an older minimal stack is already running without Storage, stop with
`npx supabase stop --workdir infra` (keeps a local backup), then run `npm run db:start` again.

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
PostgreSQL seasons/champion achievements. R1A–R1C add the free-entry `opening-v2` model and atomic
entitlements, then retire active fan wallet/funding routes and UI while preserving the Phase 8–11
schema and code for historical v1 audit/regression needs. R2A adds manual entry claims, private
evidence and exactly-once approval grants. XP, creator SaaS billing, payout,
carrier integration, automatic restock/box resume, currency conversion, and leaderboard UI remain
absent.

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

## R2A private entry evidence and API testing

Configure `ENTRY_STORAGE_URL` (local `http://127.0.0.1:54321/storage/v1`) and
`ENTRY_STORAGE_PUBLISHABLE_KEY` from the local Supabase publishable/anon key. Never use a secret
or service-role key. Storage must use the same origin as `AUTH_JWT_ISSUER`, path `/storage/v1`,
HTTPS except local loopback, with no embedded credentials/query/fragment. This integration uses
Supabase Auth identities (`AUTH_PROVIDER=supabase`), and forwards the verified caller JWT to
Storage; there is no server-side service-role bypass. Production must provision the matching
Storage bucket/policies and existing actor-binding signing key lifecycle before enabling the API.
The entry command signer reuses `FULFILLMENT_ACTOR_BINDING_KEY` and its version under a distinct
message domain; the signing secret is never sent to Storage, browser or logs.

The pinned local Storage API supports operation-aware RLS helpers. The private bucket permits
only registered PNG/JPEG objects up to 5 MiB and authenticated downloads. No signed URLs,
listings, overwrite or deletion are enabled. The API does not decode/transform images, scan
malware, compare screenshots, or perform provider verification. Abandoned objects and synthetic
test evidence require a later retention/cleanup policy before production operation; do not turn
the bucket public to inspect them.

Run the focused real-provider tests with:

```bash
npm run test:integration -- apps/api/tests/entry.integration.test.ts
```

The integration runner obtains the local public key in memory. Entry tests create isolated UUID
fixtures and synthetic Auth users, use production migrations and the restricted runtime role,
and retain synthetic rows/objects until the next local reset. They prove independent-connection
concurrency using PostgreSQL lock-graph barriers, failed-grant rollback, immutable snapshots,
private Storage and a full Instagram username/screenshot HTTP approval flow. They also consume an
approved grant through unchanged R1 opening-v2. Run `npm run ci` for the full suite; it resets local
database data before integration testing. No hosted resource or real evidence is needed.

See [API.md](./API.md#r2a-entry-methods-and-manual-claims) for request shapes and authorization.
The fan/configuration/review UI is intentionally deferred to R2B; no debug UI is required.

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

Start Supabase, create the local environment file, and run the API watcher. The development
script loads the repository-root `.env` automatically; no shell export or `source` step is
required:

```bash
npm run db:start
cp .env.example .env
npm run dev:api
```

Supabase Auth performs sign-up/sign-in. Send its access token as `Authorization: Bearer <token>` to
`POST /v1/auth/session/exchange` with `{}` to create or retrieve the local user. The same token can
use the creator, catalog, fairness, v2 entitlement-state, and opening APIs. Fan wallet reads,
test-credit grants, funding intents, and the Stripe funding webhook are not mounted by the active
application. Inventory quantities, weights, and entitlement counts are JSON decimal strings. The
API needs only the public JWKS URL for verification; never add a Supabase service-role/secret key
to browser code.

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
text path, display v2 probabilities as percentages without raw weight fractions, omit financial
fields from v2 pages, provide explicit loading/error/empty states, and respect reduced motion.
Legacy v1 response parsing remains exact for compatibility, but the web app does not present v1
as an actionable Drop.

Phase 11 integration tests remain as historical regression coverage: they mock only Stripe
transport/event normalization, while intents, provider-event idempotency, ledger postings, wallet
projections, refunds/disputes, deficits, rollback, and reconciliation assertions use real local
PostgreSQL. `npm run test:integration` also applies the Phase 8 → current forward-upgrade harness.
These modules are not wired into active API startup. The application never stored raw webhook
payloads or card data; retained history contains only allowlisted identities/state and an exact
raw-payload SHA-256 hash.

The bootstrap, creator, fairness, and opening-mutation limiters are intentionally in memory and per
API process. Configure opening limits with `OPENING_MUTATION_RATE_LIMIT_MAX` and
`OPENING_MUTATION_RATE_LIMIT_WINDOW_MS`. Before horizontally scaled production deployment, choose
a shared limiter store and define the trusted reverse-proxy/IP policy.

Retained financial mutation primitives accept only the branded transaction executor. The v1 Phase 9 opening
composition acquires the idempotency claim, wallet, fairness profile, seed, and inventory locks
in the documented order, then inserts ledger/business/outbox rows before one final commit.
Ledger history is authoritative; `reconcileWallet` compares the cached wallet projection with
the signed-entry sum and never repairs history. Active v2 openings use the separate entitlement
lock order and perform no wallet or ledger operation.

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

## R1C local free-entry rarity demo

The demo catalog command is deliberately restricted to explicit `development`/`test` mode, the
local Supabase PostgreSQL port, and the restricted `creatordrop_app` role. It loads `.env`
automatically, uses the normal creator/catalog services, and publishes through the production
publication path so `rarity-v1` is derived and snapshotted by the backend. It never supplies a
rarity value. Run it after the local database is available:

```bash
cp .env.example .env
npm run db:start
npm run seed:demo
```

The command is idempotent. It validates and reuses its fixed synthetic identities instead of
creating another creator, reward, box, version, or configuration entry. If those identities were
manually changed, it fails closed and asks for a local reset rather than rewriting published
history. `npm run db:reset` and `npm run db:migrations:validate` erase demo data, so rerun
`npm run seed:demo` afterward.

The public creator is **CreatorDrop Test Creator** (`@creatordrop_test`) at slug
`creatordrop-test`. Its **Every Rarity Test Box** is an `opening-v2` Drop with a personal maximum
of 10 openings and unlimited digital test rewards:

| Reward                | Displayed probability | Published rarity |
| --------------------- | --------------------: | ---------------- |
| Common Test Reward    |                   72% | common           |
| Uncommon Test Reward  |                   19% | uncommon         |
| Rare Test Reward      |                    7% | rare             |
| Epic Test Reward      |                  1.6% | epic             |
| Legendary Test Reward |                  0.4% | legendary        |

With the API and web development servers running, open the URL printed by the seed command, or:

```text
http://localhost:5173/creators/creatordrop-test/boxes/019f1500-0000-7000-8000-000000000200
```

The public box page shows every rarity label/color without requiring a win. Actual openings always
use the normal backend RNG; there is no force-winner query, request field, API, or browser override.
The probabilities above mean repeated local openings can naturally exercise result states, but a
particular tier is never guaranteed. For deterministic presentation coverage of every tier, use
the controlled web-test fixtures instead of weakening selection:

```bash
npx vitest run apps/web/tests/app.test.tsx -t "renders all v2 rarity percentages" --reporter=verbose
```

To open the Drop, create/sign in to a local web account first. Find the resulting local user,
creator, and box IDs through operator-only PostgreSQL inspection, then grant that user a synthetic
development entitlement:

```bash
npm run grant:entitlement:dev -- \
  <userId> 019f1500-0000-7000-8000-000000000010 \
  019f1500-0000-7000-8000-000000000200 3 development_manual \
  r1c-local-grant-001 "Local R1C opening entitlement"
```

The operator command is local-only, source-idempotent, and not an HTTP endpoint. Reusing the same
source identity and semantics replays the same grant rather than adding quantity. The authenticated
web page then displays the server-returned remaining count and enables `Open Drop` without a wallet,
credits, price, or Stripe. On first use, the browser still initializes and binds the fairness
profile before submitting, but the normal confirmation does not expose raw seed or hash details.

A normal opening initially demonstrates `pending_reveal` without exposing its active seed. Rotate
the user's active seed through `POST /v1/me/fairness/rotate` to exercise the retired
`pending_reveal` state. There is intentionally no public force-reveal or compromise endpoint.
Deterministic safe coverage for active, retired, revealed/`ready`, compromised/`unverifiable`, and
browser verification/tampering lives in the existing test-only fixtures:

```bash
npx vitest run apps/api/tests/opening-proof.service.test.ts packages/rng-verifier/tests/browser.test.ts --reporter=verbose
```

Never read/decrypt an active seed or alter seed status directly to manufacture a local result.

## R1 free-entry opening-v2 entitlements

R1A preserved the paid `opening-v1` runtime while adding publishable `opening-v2` catalog data and
operator-only non-financial entitlement records. An `opening-v2` version has no price/currency or
base reward; it has a positive immutable `maxOpeningsPerUser`. R1B made that model openable: one
successful opening atomically consumes one entitlement and performs no wallet, ledger, earnings,
or points operation. R1C makes it the active fan flow and unregisters wallet/funding routes and UI.
Do not use wallet/test-credit terminology for entitlement grants.

The repeatable development grant command loads the root `.env`, requires raw
`NODE_ENV=development|test`, rejects non-local PostgreSQL, and uses `DATABASE_MIGRATION_URL` so the
shared application role never gains grant authority:

```bash
npm run grant:entitlement:dev -- \
  <userId> <creatorId> <boxId> 3 development_manual \
  r1-local-grant-001 "Local opening entitlement"
```

The command prints the immutable grant ID/replay flag and exact aggregate `granted`, `consumed`, and
`remaining` quantities. Repeating the exact source identity and semantics returns the original
grant without adding quantity; reuse with different scope or quantity fails. Obtain IDs from local
test fixtures or PostgreSQL operator inspection. There is intentionally no HTTP mint route and no
fan can grant itself entries. Once granted, the signed-in fan can visit the active v2 box and use
`Open Drop`; the UI reads only that user's availability from
`GET /v1/boxes/:boxId/opening-entitlement`. The backend chooses the grant and consumes it inside the
opening transaction. The active web uses this state directly; no client-calculated availability is
authoritative.

## Full validation

With the local stack running:

```bash
npm run ci
```

This matches the repository CI quality sequence, including a destructive migration reset and real PostgreSQL integration tests.
