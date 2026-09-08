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

`boxes` and `rewards` are stable identities. Every publish creates immutable `box_versions`, `reward_versions`, and ordered weighted entries. Phase 9 adds an explicit `opening-v1` compatibility marker and exactly one explicit base-reward designation to newly published paid/openable versions. Earlier published versions are grandfathered unchanged with a null marker: they remain readable fairness history but cannot be opened. R1A adds the distinct `opening-v2` free-entry publication model: it has no price, currency, or base reward and instead snapshots a positive `maxOpeningsPerUser`. Republishing always creates a new version; no historical version is inferred, backfilled, or rehashed. An opening references exactly one compatible published box version. Edits create drafts/new versions and cannot rewrite history.

### Dual opening model during the product rebase

`opening-v1` retains the completed paid-opening contract, including its historical financial manifest and Phase 9 transaction. `opening-v2` is the target free-entry contract. Its canonical manifest contains the model marker, box/version identity, ordered rewards and weights, immutable rarity snapshots, total weight, and `maxOpeningsPerUser`; it deliberately contains no financial field. Both formats use the unchanged `hmac-sha256-rejection-v1` selector and separate exact parsers/canonicalizers.

R1B makes both models explicit at the production opening boundary. `opening-v1` follows the
unchanged paid wallet/ledger path. `opening-v2` requires one available stable-box entitlement,
atomically enforces the published per-user maximum, and performs the same fairness, inventory,
win, fulfillment, idempotency, and outbox work without any wallet, ledger, earnings, currency,
price, or legacy-points operation. R1C remains responsible for retiring active fan financial
surfaces across the wider product; R1B does not remove historical or still-supported v1 code.

### One currency per wallet and integer amounts

All monetary amounts are signed 64-bit integer minor units plus an ISO 4217 currency code. No floating point is permitted. A wallet is unique by owner and currency. The ledger uses balanced postings, and the wallet balance is an atomically maintained projection guarded by a non-negative constraint.

Phase 8 makes the schema currency-independent. Phase 11 enables only `USD` for Stripe test-mode funding and retains development/test-only synthetic grants. Currency is explicit on funding intents, wallets, ledger accounts, transaction headers, and entries; a posting cannot mix currencies, and no conversion exists. Adding an enabled currency later requires policy/configuration and matching controlled accounts, not a wallet/ledger redesign.

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

## Phase 14 web boundary

The React/Vite application uses one typed CreatorDrop HTTP client. Components never scatter raw
`fetch` calls or duplicate package contract types. The client adds a bearer token when a Supabase
session exists, validates success and stable error envelopes at the network boundary, supports
request cancellation, and never automatically retries mutations. A backend `401` initiates local
provider-session cleanup; React visibility is never treated as authorization.

Supabase Auth remains the only credential ceremony. The browser client persists its refreshable
session in per-tab `sessionStorage`, not long-lived `localStorage`; reload restoration completes
the idempotent `/v1/auth/session/exchange` before protected content renders. Browser configuration
contains only the Supabase URL and publishable key. Service-role keys and application/database
secrets never enter the web build. Vite configuration rejects modern Supabase secret keys and
legacy service-role JWTs before emitting browser assets; runtime parsing repeats the browser-key
classification as defense in depth.

Phase 14 routes are `/`, `/auth`, `/account`, `/creators`, `/creators/:customSlug`, and
`/creators/:customSlug/boxes/:boxId`. Public pages use allowlisted catalog APIs without
authentication. The protected account shell demonstrates session gating and may expose the
existing Phase 8 synthetic-credit command only through a clearly labeled development-server
control. Vite derives one boolean from `WALLET_TEST_CREDITS_ENABLED` only when both its mode and the
declared app environment are development/test; builds force the boolean off, and the backend route
and service remain the authoritative gates. The account shell adds no creator dashboard or product
mutation. React text escaping is the catalog XSS boundary; no catalog field is rendered as raw
HTML. Creator box-detail routes use one creator-scoped backend lookup rather than composing a slug
with a globally addressed box. Money formatting starts from integer minor-unit strings, and probability
display starts from immutable integer weights using `BigInt`, always retaining the exact
`weight / totalWeight` pair. Shared loading/error/empty states, semantic headings/forms, visible
focus, skip navigation, responsive layouts, and `prefers-reduced-motion` support form the
accessibility baseline for later phases.

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

The opening endpoint dispatches to one of two explicit models. R1B does not alter the
`opening-v1` paid lock order, accounting, RNG, inventory, or idempotency behavior.

The paid `opening-v1` endpoint is a short PostgreSQL transaction at `READ COMMITTED` with explicit row locks. Its lock order remains:

1. idempotency key claim;
2. matching active leaderboard-season row in shared mode, when the database timestamp is in a season;
3. wallet row;
4. fairness-profile row;
5. active RNG seed-set row (allocates nonce);
6. the selected shared inventory pool, if finite;
7. affected box identity rows in UUID order (shared availability check, upgraded for atomic pause);
8. ledger/open/fulfillment/outbox inserts.

The non-financial `opening-v2` order is idempotency claim → per-user/stable-box guard → oldest
eligible grant row → `fairness_profiles` → active `rng_seed_sets` → selected inventory pool →
affected box rows → opening/win/fulfillment/entitlement/outbox inserts. The guard is keyed by
`(user_id, box_id)`, so every version of one stable Drop shares its personal-limit and entitlement
serialization boundary while different users or boxes remain concurrent. After taking the guard,
PostgreSQL counts committed v2 openings for the stable box, checks the immutable maximum, chooses
the oldest still-available grant ordered by `(created_at, id)`, locks it, and appends one deferred
opening-linked consumption. The maximum is checked before entitlement availability, so unused
grants cannot bypass a reached limit.

Season finalization takes the same season row exclusively before deriving permanent results. An
opening therefore commits into the authoritative season history before finalization can observe
and freeze it, or waits for finalization and fails before wallet locking, nonce allocation, and
RNG. The `box_opens` insert trigger enforces the same barrier for restricted-role writes.

The `fairness_profiles` row is the authoritative per-user RNG-lifecycle lock. Every transaction
that can create or activate a seed, change seed lifecycle state, allocate a nonce, or create or
complete a rotation acquires that row before the user's seed rows and then any rotation row.
Database guards apply the same serialization to restricted-role seed/rotation writes; a raw
update that arrives in reverse order fails retryably instead of waiting while holding its target
row. Different users lock different profile rows and remain independent.

The wallet is locked and sufficient funds are checked before nonce allocation or RNG, then the debit update remains conditional (`balance >= cost`) and checked by affected-row count. A unique idempotency record and unique `box_opens.idempotency_record_id` prevent double charge. Deadlocks and serialization failures may be retried a small bounded number of times only before the selector boundary. Once nonce allocation/RNG may have run, the whole transaction rolls back and a retryable error is returned without invoking the selector again; a client retry uses the same idempotency key.

Phase 8 establishes the financial composition boundary for v1. A paid command first claims `(actor, operation, idempotency key)`, then locks the actor's currency wallet through a narrow security-definer lock function. `creditWallet`, `debitWallet`, reversal posting, and Phase 9 opening postings require the branded caller-owned `TransactionExecutor`; they never commit internally. Different wallets, v2 user/box guards, and selected inventory pools do not share locks across unrelated scopes.

Paid `opening-v1` detailed flow:

1. Require authenticated actor, `Idempotency-Key`, and a request body containing `clientSeed`, the exact active seed-set ID and commitment shown to the user, plus the immutable box-version ID and configuration hash explicitly confirmed by the user. Canonicalize and hash method, route, actor, box, and the complete body as the request fingerprint. Price, currency, and the active fairness state remain PostgreSQL-authoritative rather than client inputs.
2. Begin a database transaction. Insert the user-scoped idempotency row. A unique conflict waits for the first transaction; replay the stored response if the fingerprint matches, otherwise return `409 IDEMPOTENCY_KEY_REUSED`.
3. Load the active published version by box ID. Validate visibility, sales state, currency, price, opening limits, and eligibility on the server, then require its immutable version ID and configuration hash to equal the user's confirmed expectation. A mismatch rolls back with `OPENING_CONFIRMATION_STALE` before wallet, nonce, RNG, or inventory work. Read the transaction's authoritative database timestamp and acquire the matching leaderboard-season shared barrier before any selector work.
4. Lock the user's currency wallet. Reject insufficient funds without consuming a nonce or leaving an idempotency record committed.
5. Lock the user's active RNG seed-set, require its ID and commitment to match the confirmed expectation, validate the client seed, allocate its next nonce, and increment the counter. A changed seed-set rolls back with `FAIRNESS_CONFIRMATION_STALE` before nonce allocation or any financial mutation and requires fresh confirmation.
6. Read the immutable ordered reward table, verify its stored total weight/checksum, compute HMAC-SHA256, and select the reward deterministically. The client never supplies or influences authoritative weights beyond choosing its client seed before the opening.
7. For a finite winner, lock only its stable creator-owned inventory pool after RNG. Multiple immutable reward versions and boxes may reference that same physical stock. Consume one unit with an immutable opening-linked consumption row if available. `pause_box` rejects at zero and atomically pauses all active boxes using the exhausted pool after the last winner; `backorder` preserves the exact winner at zero with an `awaiting_restock` obligation and no consumption row. Never reroll or substitute.
8. Revalidate the same current compatible version under the box availability lock. Insert the immutable opening with price/fee/points snapshots, version, seed-set, commitment, client seed, nonce, algorithm version, HMAC digest, selection value, and winning reward-version entry.
9. Post two balanced ledger transactions: fan wallet to box-sales clearing, then clearing to creator pending earnings plus the platform fee. Atomically update the wallet projection. Unique business references prevent duplicate postings.
10. Insert the immutable reward win, fulfillment obligation, and creator earning held for 14 days.
11. Insert `opening.completed.v1` private and sanitized `drop.created.v1` public outbox rows in the same transaction. Phase 9 stores but does not deliver them and never exposes unrevealed server seed material.
12. Store the exact successful response in the idempotency row and commit.
13. Return the decided outcome. The Phase 10 worker consumes the outbox only after commit and
    emits the two versioned realtime events. The independent Phase 13 projection queue consumes
    only eligible v1 `opening.completed.v1` history after commit. The reel animates the returned
    result only.

For `opening-v2`, steps 1–3 retain the same actor, idempotency, immutable-version, and fairness
confirmation inputs. The model-specific branch then locks the user/stable-box guard, enforces
`maxOpeningsPerUser`, and consumes the deterministic eligible entitlement before crossing the RNG
boundary. It skips the season, wallet, financial, earnings, and points steps entirely; the same
nonce/RNG, inventory, box revalidation, reward-win, fulfillment, and two outbox-event operations
then commit with the consumption. Any failure rolls all of them back. A committed replay returns
the stored historical model-specific response before current catalog or seed state is consulted.

Failures before commit leave no charge, nonce, opening, fulfillment, or event. If commit succeeds but the HTTP response is lost, retry returns the stored result.

Phase 15 stores a server-derived `rarity-v1` tier on each immutable published box/reward association using exact weight/total comparisons; it does not change the RNG manifest or selection semantics. On first use, the browser first sends the empty `POST /v1/me/fairness` command so the backend creates the encrypted server seed and public commitment without receiving an opening client seed. Only after that commitment exists does the browser generate a fresh canonical client seed with Web Crypto and save it through the revision-checked client-seed command. The resulting authoritative seed-set ID, commitment, and client seed are displayed before the user can explicitly confirm an opening. The opening command binds all three values, and PostgreSQL rejects a rotated/substituted seed-set with `FAIRNESS_CONFIRMATION_STALE`; initialization is never combined with opening. Before confirmation, the web opening experience refreshes the current authoritative catalog and binds the command to its immutable version/configuration identity; a later mismatch cannot silently switch versions and instead requires the refreshed price and configuration to be explicitly confirmed. It persists one user-intended idempotency key and that complete expectation in session storage and retries only the same command. Only an ambiguous transport outcome is recovered automatically; a definitive server rejection clears recovery, while `OPENING_RETRY_REQUIRED` preserves the command for an explicit user retry. The result UI binds the committed box-version/configuration identity to the exact immutable published snapshot before deriving reel content, price, currency, or odds, and the reel measures the already committed winner's rendered geometry rather than assuming a pixel size. The independent browser verifier consumes the public proof endpoint after reveal and never imports the production selector. A ready proof is not described as verified until that independent recomputation succeeds.

## Realtime and cache architecture

Socket rooms are `creator:{publicCreatorId}`, `user:{userId}`, and optionally public global feeds. User rooms require authenticated socket handshakes and server-derived room membership. Public events contain a public opening ID, creator/box/reward display snapshot, timestamp, and safe display identity—not balances, addresses, provider references, seed secrets, or private fulfillment data.

The Phase 10 outbox worker claims rows with `FOR UPDATE SKIP LOCKED` through a restricted
worker-only database function. A persisted claim token and lease let another worker recover a
row after a crash without allowing the stale worker to acknowledge it. The worker performs no
network work in a PostgreSQL transaction. It publishes the immutable event ID to the API's
token-authenticated `/worker` Socket.io namespace, waits for an acknowledgement that the API
gateway accepted the broadcast, and only then marks the row delivered. Failures use bounded
exponential backoff; exhausted or permanently invalid events remain as `dead` history for
operator inspection.

Delivery from the outbox to the realtime gateway is at least once. A worker can publish and
crash before recording completion, so clients deduplicate by `eventId`. The API automatically
joins an authenticated active user to only `user:{userId}` and accepts validated, read-only
subscriptions for `creator:{publicCreatorId}` or the public global drop room. It never accepts a
client-supplied user room. Every connection/reconnection receives `realtime.ready.v1` with
`refetchRequired: true`; Socket.io is notification transport, not missed-event history. A lost
opening response remains recoverable through the original idempotent opening command, and
clients refetch available authoritative HTTP resources after reconnect.

Phase 10 uses process-local Socket.io rooms and an acknowledged worker-to-API connection; a
horizontally scaled Socket.io deployment will need an approved cross-node adapter and sticky
connection policy before production scaling.

### Redis projections and leaderboards

Phase 13 projects immutable `box_opens.points_awarded` into disposable Redis leaderboards. The
private `opening.completed.v1` outbox UUID is the sole event identity/source; the public drop
event never awards points. A separate PostgreSQL projection queue uses worker-only
`FOR UPDATE SKIP LOCKED` claims, expiring claim tokens, and bounded retries so realtime delivery
and leaderboard delivery remain independent. Redis Lua applies an event atomically to global,
creator, and matching-season scopes and records the event UUID in the same operation. A crash
after Redis mutation but before PostgreSQL acknowledgement therefore replays without incrementing
again. No Redis call occurs in the opening transaction.

Redis stores absolute PostgreSQL aggregates rather than authoritative deltas: points, opening
count, base-reward-win count, username, and the committed timestamp/microsecond ordering point at
which the score was reached. Rank is points descending, then earliest reach time, then canonical
user UUID internally. Public responses expose the authoritative `users.username`, not that UUID
as the user-facing identity. Participation is automatic for every eligible opening and public
leaderboard reads require no authentication; Phase 13 has no opt-out. Future privacy controls may
change presentation only and cannot rewrite finalized results or achievements.

Explicit, non-overlapping PostgreSQL seasons have at most one active window. Season membership is
derived from the committed opening timestamp and `[starts_at, ends_at)` boundaries. Before a
season is finalized, the worker reconciles Redis against PostgreSQL and rebuilds on drift; the
winner is then independently selected from PostgreSQL using the same ordering. Immutable global
and per-creator results and permanent champion achievements are inserted atomically and
idempotently. Redis loss cannot lose a champion.

Rebuild writes a new Redis generation from all PostgreSQL opening history while live events are
dual-written, then atomically swaps the active generation. Reconciliation never mutates
PostgreSQL. Public reads prefer a ready Redis generation and fall back to PostgreSQL when Redis is
missing, stale, evicted, or unavailable. Public catalog reads use a validated cache-aside value
whose manifest box/version UUIDs must match the canonical requested identity, with bounded TTL
and post-commit publish/archive invalidation. Any parse, hash, or identity mismatch is evicted and
falls back to PostgreSQL; cache failure never blocks a catalog write or changes opening
eligibility.

## Payment and fulfillment architecture

Wallet funding is an asynchronous state machine driven by signed, idempotent Stripe webhooks. The API creates the local intent before the test-mode Stripe PaymentIntent; Stripe network work stays outside PostgreSQL transactions. Browser redirects and client state are informational only. The webhook verifies the signature over exact raw bytes before any event is trusted, stores a unique provider event ID plus SHA-256 payload hash, validates the bound local intent/user/wallet/amount/currency, and credits the wallet only from `payment_intent.succeeded`.

The settlement transaction discovers the intent without locking, then follows the authoritative payment order `wallet → funding_intent → provider_event → ledger/history inserts`; it revalidates the intent after locks and atomically inserts a balanced provider-clearing-to-wallet posting plus its immutable settlement linkage. Duplicate events and different events for one PaymentIntent converge on the unique settlement; a distinct success delivered after refund/dispute is retained as an audited no-op and cannot regress state or credit again. Reordered adjustments remain retryable until the original settlement exists, then derive monotonic reversal state from cumulative immutable adjustment history rather than provider timestamp order. Provider refunds and disputes create new compensating postings—never mutation/deletion of funding or opening history. Recoverable value reduces the nonnegative wallet through a posting-scoped database primitive; any shortfall posts to a distinct user funding-deficit account and creates exactly one immutable unresolved deficit with matching user/currency/amount lineage. The same wallet lock serializes adjustment and spending, while unresolved deficits block further funding and ordinary negative wallet movements. There is no withdrawal or self-service refund path.

Stripe remains authoritative only for external payment state; PostgreSQL ledger history remains authoritative internally. Reconciliation retrieves the provider object outside a database transaction, reports amount/currency/linkage/state drift, and never repairs financial history implicitly. Phase 11 is test-mode only and fails closed unless the raw runtime is explicitly development/test with a test secret and webhook secret.

Box proceeds initially credit a platform escrow/payable ledger account. Revenue share, fees, taxes, payout availability, reserves, and chargeback allocation must be decided before real-money launch. Creator earnings are not calculated from cached leaderboards.

Fulfillment is a typed state machine layered on the immutable Phase 9 reward win and origin
obligation. Physical rewards move `awaiting_address → ready_to_ship → shipped → delivered`,
digital rewards move `ready_for_delivery → delivered`, and experiences move
`coordination_required → fulfilled`. A backordered obligation remains tied to the selected
reward version and moves out of `awaiting_restock` only when an owner/manager command locks its
shared inventory pool, consumes one available unit for the original opening, and commits the
transition and immutable history together. There is no reroll or substitution.

Addresses are collected only after a physical win. Address ciphertext and digital-secret
ciphertext use separate versioned AES-256-GCM key domains, fresh 12-byte IVs, 16-byte tags, and
AAD bound to the fulfillment, creator, user, purpose, and key version. Key material stays out of
PostgreSQL; immutable non-secret SHA-256 identities in one cross-domain registry prevent
RNG/address/digital/actor-binding version-material drift or reuse. UUIDs are canonical lowercase before AAD,
fingerprint scope, and persistence comparison. Creator owner/manager decryption is
minimum-disclosure and creates an immutable access event only after key lookup, identity
verification, authenticated decryption, UTF-8 decoding, and payload validation succeed; editor and
viewer roles can read non-sensitive status/history only. Expiry is nullable until legal policy
chooses a duration, and explicit terminal-state redaction removes ciphertext while retaining
fulfillment and access history. Phase 12 has no carrier/digital provider, so no new asynchronous
provider job is needed; the existing Phase 10 worker remains unchanged.

Every sensitive Phase 12 database command additionally verifies a short-lived HMAC capability
over the JWT-authenticated actor and exact immutable command scope. Its verifier key lives in
`app_private` and is unavailable to `creatordrop_app`; legacy actor-ID-only functions are not
executable by that role. The database permits exactly one active signer identity, verifies only
that version, and appends an immutable record whenever an operator atomically retires it and
activates a globally distinct replacement. Creator membership remains the authorization source
after capability verification, so direct membership-table privileges cannot manufacture Phase 12
authority.

Idempotency fingerprints for address and digital-secret commands are HMAC-derived with a
purpose/domain-separated subkey instead of storing dictionary-testable hashes of sensitive input.
The immutable event snapshots its fingerprint key domain/version for replay across key rotation.

Manual inventory restock is an owner/manager-only, creator-scoped command. It appends an
immutable `inventory_restock_events` row and increases only `available_quantity`; it never
rewrites the pool's historical initial quantity. Deferred reconciliation enforces
`initial + restocks - consumptions = available`. Restocking does not automatically resolve
backorders or resume paused boxes.

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
│   ├── domain/                  # pure production money/RNG/policy primitives
│   ├── database/                # SQL migrations, typed client, test helpers
│   │   ├── migrations/
│   │   └── src/
│   ├── observability/
│   ├── rng-verifier/            # independent fairness proof implementation
│   ├── test-support/
│   └── config/                  # shared TS/lint configuration
├── test-vectors/rng/            # language-neutral normative RNG fixtures
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

- TLS everywhere; secrets come from a managed secret store. Phase 7 server seeds use versioned authenticated AES-256-GCM encryption under an environment-supplied key and are never logged; true per-record DEK/KMS envelope encryption remains production hardening.
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
6. Server-seed rotation cadence. Recommended: automatic rotation after a bounded opening count/time, then reveal; each successor commitment remains visible before use.
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
