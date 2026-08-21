# CreatorDrop Architecture

## Status and scope

This document defines the technical foundation for the first production release. It does not authorize feature implementation. The source brief is intentionally small; product decisions that affect legality, money, inventory, and fairness are called out under **Open decisions** rather than silently assumed.

## Architectural decisions

### Use a TypeScript monorepo

Use npm workspaces for the web app, API, background worker, and shared packages. A monorepo gives one versioned API contract, shared validation schemas, atomic changes, and one CI pipeline. Separate deployable applications remain independently scalable. Separate repositories would improve organizational isolation, but add contract/version drift before the team is large enough to benefit.

### Use a modular monolith first

The API is one deployable Express application organized into strict domain modules. A separate worker handles outbox events, seed retirement/reveal, payment webhooks that need retry, fulfillment, and projections. This preserves transactional boundaries for openings and the ledger while leaving extraction seams. Do not split wallet, RNG, or opening into network services until measured scaling or team ownership requires it.

### PostgreSQL is authoritative

PostgreSQL owns users, configuration versions, openings, balances, ledger entries, fulfillment state, RNG commitments, idempotency, and the event outbox. Redis contains disposable cache/projection data only. Socket.io receives committed events through the outbox worker; request handlers never publish transaction-dependent events directly.

### Immutable published configuration

`boxes` and `rewards` are stable identities. Every publish creates immutable `box_versions`, `reward_versions`, and ordered weighted entries. An opening references exactly one published box version. Edits create drafts/new versions and cannot rewrite history.

### One currency per wallet and integer amounts

All monetary amounts are signed 64-bit integer minor units plus an ISO 4217 currency code. No floating point is permitted. A wallet is unique by owner and currency. The ledger uses balanced postings, and the wallet balance is an atomically maintained projection guarded by a non-negative constraint.

## System context

```text
Browser
  | HTTPS / Socket.io (JWT)
  v
Web app -----> API modular monolith -----> PostgreSQL (source of truth)
                  |       |                    |
                  |       +----> Redis         +---- event_outbox
                  |             (cache only)             |
                  |                                      v
                  +<------------------------------- Worker(s)
                                                          |
                            payment provider / email / fulfillment adapters
```

External calls do not occur inside the box-opening database transaction. They are represented by committed work records and processed asynchronously.

## Backend boundaries

Each domain module follows the same dependency direction:

```text
route -> middleware -> controller -> application service -> repository -> PostgreSQL
                                          |                   |
                                          +-> domain/RNG      +-> transaction
                                          +-> outbox record
```

- **Routes** bind URLs, middleware, and controllers.
- **Controllers** translate HTTP input/output only; they contain no pricing, odds, wallet, or authorization decisions.
- **Validation** parses all params, query strings, and bodies with shared schemas and rejects unknown fields for security-sensitive commands.
- **Application services** coordinate use cases and transaction boundaries.
- **Domain code** contains pure policy and deterministic algorithms, including weighted selection.
- **Repositories** contain SQL/data mapping. A transaction-scoped unit of work is passed explicitly.
- **Authentication middleware** verifies the access token and constructs an actor. It never accepts an actor ID from the body.
- **Authorization policy functions** answer resource-specific questions using ownership or roles loaded from PostgreSQL.
- **Wallet/ledger** is the sole writer of monetary state. Other modules request a typed posting operation.
- **RNG** owns seed generation, commitment, rotation, nonce allocation, deterministic derivation, and verification.
- **Realtime** writes transactional outbox rows and publishes only from a worker after commit.
- **Caching** uses cache-aside reads and post-commit invalidation. Cache failure cannot change a financial outcome.

Modules must not import another module's repository directly. They call its application interface or pure public domain types. In particular, opening coordinates published boxes, RNG, wallet, fulfillment, idempotency, and outbox through explicit interfaces.

## Authentication and authorization

Use Supabase Auth as the initial identity provider. The API verifies JWT signature, issuer, audience, expiry, and not-before against trusted configuration/JWKS, then maps `(auth_provider, auth_subject)` to a local user. Never trust client-supplied user, creator, role, price, weight, balance, or reward IDs as authority.

Authorization uses a hybrid RBAC/resource-ownership model:

- `fan`: read public boxes, open boxes, see own wallet/openings/fulfillments, manage own fairness client seed.
- `creator`: fan rights plus manage resources where `creator_memberships.user_id` matches and the role permits the operation.
- `creator_owner`: manage membership and payout settings for that creator.
- `support`: narrowly scoped read workflows; no direct ledger edits.
- `admin`: explicit audited administrative operations, protected with MFA in the identity provider.
- `worker`: service identity restricted to claimed jobs/outbox/payment operations.

Creator authorization always scopes database access by both resource ID and creator ID/member actor. Avoid “load by ID, then hope the controller checks ownership.” PostgreSQL row-level security can protect direct Supabase access, but the browser must not directly write core application tables. The server uses a restricted database role; migrations use a separate owner role. Administrative actions require a reason and an `audit_log` entry.

## Box-opening consistency model

The opening endpoint is a short PostgreSQL transaction at `READ COMMITTED` with explicit row locks. Lock order is fixed to reduce deadlocks:

1. idempotency key claim;
2. wallet row;
3. active RNG seed-set row (allocates nonce);
4. any inventory/reservation rows, in UUID order;
5. immutable box version reads;
6. ledger/open/fulfillment/outbox inserts.

The wallet update is conditional (`balance >= cost`) and checked by affected-row count. A unique idempotency record and unique `box_opens.idempotency_record_id` prevent double charge. Deadlocks and serialization failures may be retried a small bounded number of times using the same idempotency key.

Detailed flow:

1. Require authenticated actor, `Idempotency-Key`, and a request body containing only `clientSeed` (or use the user's precommitted current client seed). Canonicalize and hash method, route, actor, box, and body as the request fingerprint.
2. Begin a database transaction. Insert the user-scoped idempotency row. A unique conflict waits for the first transaction; replay the stored response if the fingerprint matches, otherwise return `409 IDEMPOTENCY_KEY_REUSED`.
3. Load the active published version by box ID. Validate visibility, sales state, currency, price, opening limits, and eligibility on the server.
4. Lock the user's currency wallet. Reject insufficient funds without consuming a nonce or leaving an idempotency record committed.
5. Lock the user's active RNG seed-set, validate the client seed, allocate its next nonce, and increment the counter.
6. Read the immutable ordered reward table, verify its stored total weight/checksum, compute HMAC-SHA256, and select the reward deterministically. The client never supplies or influences authoritative weights beyond choosing its client seed before the opening.
7. If finite inventory is enabled by a later product decision, reserve it here with a conditional update. No external fulfillment call occurs here.
8. Insert the opening with price, currency, version, seed-set, commitment, client seed, nonce, algorithm version, HMAC digest, selection value, and winning reward-version entry.
9. Post one balanced ledger transaction, atomically update the wallet balance projection, and link it to the opening. The unique business reference prevents a second debit.
10. Insert the reward win and a pending fulfillment record.
11. Insert outbox events for the private opening result and sanitized public live drop. Do not expose unrevealed server seed material.
12. Store the exact successful response in the idempotency row and commit.
13. Return the decided outcome. Best-effort cache invalidation may be signaled; the durable worker consumes the outbox, updates Redis projections, and then emits Socket.io events. The reel animates the returned result only.

Failures before commit leave no charge, nonce, opening, fulfillment, or event. If commit succeeds but the HTTP response is lost, retry returns the stored result.

## Realtime and cache architecture

Socket rooms are `creator:{publicCreatorId}`, `user:{userId}`, and optionally public global feeds. User rooms require authenticated socket handshakes and server-derived room membership. Public events contain a public opening ID, creator/box/reward display snapshot, timestamp, and safe display identity—not balances, addresses, provider references, seed secrets, or private fulfillment data.

The outbox worker claims rows with `FOR UPDATE SKIP LOCKED`, publishes using an event ID, and marks them delivered. Delivery is at least once; consumers deduplicate by event ID. Redis leaderboards are projections rebuilt from PostgreSQL ledger/open data. Define a reconciliation job and TTLs; never read a Redis leaderboard to make a financial or eligibility decision.

## Payment and fulfillment architecture

Wallet funding and creator payouts are asynchronous state machines driven by signed, idempotent provider webhooks. Browser redirects are informational only. A provider event ID is unique, raw payload hashes are retained, signatures are checked before processing, and ledger credit occurs only at the designated settled state. Refunds and chargebacks are new compensating ledger transactions—never mutation or deletion of old entries.

Box proceeds initially credit a platform escrow/payable ledger account. Revenue share, fees, taxes, payout availability, reserves, and chargeback allocation must be decided before real-money launch. Creator earnings are not calculated from cached leaderboards.

Fulfillment is also a state machine. A reward win is immutable; retries update fulfillment attempts/status, not the win. Physical address and provider secrets require field-level encryption or tokenization, restricted access, retention limits, and audit logging.

## Repository structure

```text
creatordrop.com/
├── AGENTS.md
├── PROJECT_BRIEF.md
├── package.json                 # private npm workspace root
├── package-lock.json
├── tsconfig.base.json
├── eslint.config.js
├── .prettierrc
├── .env.example
├── apps/
│   ├── web/
│   │   ├── src/{app,components,features,hooks,lib,routes,styles}/
│   │   └── tests/
│   ├── api/
│   │   ├── src/
│   │   │   ├── config/
│   │   │   ├── http/{middleware,routes}/
│   │   │   ├── modules/{auth,users,creators,catalog,openings,wallet,fairness,fulfillment,payments}/
│   │   │   ├── platform/{db,redis,realtime,logging,telemetry}/
│   │   │   ├── app.ts
│   │   │   └── server.ts
│   │   └── tests/{integration,contract}/
│   └── worker/
│       ├── src/{jobs,consumers,adapters}/
│       └── tests/
├── packages/
│   ├── contracts/               # schemas and generated API types, no business logic
│   ├── domain/                  # pure money/RNG/policy primitives
│   ├── database/                # SQL migrations, typed client, test helpers
│   │   ├── migrations/
│   │   └── src/
│   ├── observability/
│   ├── test-support/
│   └── config/                  # shared TS/lint configuration
├── docs/
│   ├── ARCHITECTURE.md
│   ├── DATABASE.md
│   ├── RNG.md
│   ├── API.md
│   ├── DEVELOPMENT.md
│   └── ROADMAP.md
└── infra/
    ├── docker/
    └── supabase/
```

Feature folders inside API modules use `*.route.ts`, `*.controller.ts`, `*.service.ts`, `*.repository.ts`, `*.policy.ts`, `*.schema.ts`, and colocated unit tests. Do not add a generic `utils` dumping ground.

## Security, operational, and compliance requirements

- TLS everywhere; secrets come from a managed secret store. Server seeds are encrypted with versioned envelope encryption and never logged.
- Rate-limit login, seed rotation, opening, funding, and creator mutation endpoints by actor and network. Add bot/abuse signals without using them to silently alter odds.
- Use secure headers, strict CORS allowlists, request size limits, structured redacted logs, dependency scanning, and regular key rotation.
- Audit creator publishing, probability changes, seed lifecycle, support access, fulfillment address access, payouts, and ledger adjustments.
- Back up PostgreSQL with point-in-time recovery and regularly test restore. Define RPO/RTO before launch.
- Metrics include open success/failure by reason, transaction latency/retries, outbox lag, webhook lag, seed rotation state, ledger reconciliation, and cache drift. Never put high-cardinality secrets or personal data in metrics.
- Run a daily reconciliation between wallet projections and ledger entries and between provider settlements and ledger transactions. Alert and halt affected financial operations on mismatch.
- Establish data retention/deletion behavior. Financial/audit records may need legally required retention and should be pseudonymized rather than erased.
- Complete jurisdiction-specific legal review for paid chance-based rewards: gambling/sweepstakes classification, age/geography controls, odds disclosure, no-purchase route if applicable, consumer protection, tax, AML/KYC, sanctions, creator onboarding, and prohibited prizes.

## Missing requirements and open decisions

These must be resolved before their affected phase:

1. Launch jurisdictions, minimum age, free-entry rules, and whether cash/cash-equivalent rewards are prohibited.
2. Supported currencies and whether conversion is disallowed (recommended for v1) or provider-managed.
3. Funding provider, custody model, refunds, chargebacks, creator revenue share, platform fees, tax, payout delay/reserve, KYC, and negative-balance policy.
4. Reward inventory semantics. Recommended v1: only rewards whose promised fulfillment capacity is guaranteed for the life of a published version; do not dynamically remove sold-out rewards. Finite-stock weighted selection requires a separately specified, publicly verifiable policy.
5. Whether odds are arbitrary weights or displayed exact percentages, rounding rules, minimum/maximum reward probability, box value/disclosure rules, and creator approval/moderation.
6. Client-seed UX and seed rotation cadence. Recommended: per-user seed-set, user-editable client seed before opening, automatic server-seed rotation after a bounded opening count/time, then reveal.
7. Opening limits, cancellation policy, fulfillment deadlines, substitutions, digital entitlement delivery, shipping regions/cost, and privacy retention.
8. Public live-feed identity/amount disclosure and opt-out policy.
9. Availability, throughput, latency, RPO/RTO, retention, and moderation/support service-level targets.
10. Exact Supabase plan/topology, deployment platform, secret manager, email/object storage providers, and observability vendor.

## Alternatives rejected for now

- **Microservices:** distributed transactions would make the core open/charge path harder to reason about with no demonstrated scaling need.
- **Redis balance/locks:** Redis durability and split-brain behavior are unsuitable as monetary authority; PostgreSQL row locks are sufficient initially.
- **Mutable reward rows on openings:** this destroys reproducibility when creators edit boxes.
- **Storing a server seed on each opening in plaintext:** it either leaks active secrets or creates unnecessary secret sprawl. Openings reference a protected seed-set and retain its commitment; the plaintext is published only after retirement.
- **Provider payment during opening:** network calls inside the atomic path create uncertain outcomes and duplicate-charge risk. Users open only against settled wallet funds.
