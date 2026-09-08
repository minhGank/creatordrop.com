# Dependency-Ordered Implementation Roadmap

Each phase is intended to be one focused pull request with its own tests and documentation updates. A phase starts only when its dependencies and relevant product decisions are complete. Real-money production launch is not implied by completing software phases; legal, security, and operational launch gates still apply.

## Phase 0 — Resolve launch-critical product policy

Primary responsibility: decide v1 jurisdiction/age model, currencies, custody/payment provider, fees/payout ownership, odds disclosure, reward inventory semantics, prohibited prizes, refund/chargeback policy, and fulfillment obligations.

Deliver an approved decision record and threat/compliance checklist. Test/review: architecture and legal/security review; no application code.

## Phase 1 — Monorepo and quality gates

Depends on: architecture approval.

Create npm workspaces for `web`, `api`, `worker`, and shared packages; strict TypeScript, lint/format/typecheck, unit-test runner, build, environment validation, secret scanning, and CI. Add minimal health/readiness processes only—no product endpoint. Tests prove workspace boundaries, configuration validation, and CI commands.

## Phase 2 — PostgreSQL migration and test harness

Depends on: Phase 1.

Add migration tooling, local PostgreSQL/Supabase workflow, transaction helper, restricted application/migration roles, and isolated integration-test databases. Implement only foundational extensions/types/helpers. Tests apply all migrations from empty, roll forward deterministically, and prove rollback/test isolation policy.

## Phase 3 — Identity bootstrap and request security

Depends on: Phase 2.

Verify Supabase JWTs, map identities to local `users`, implement request IDs, structured redaction, validation/error envelopes, CORS/headers/body limits, and authentication rate limiting. Tests cover invalid signature/issuer/audience/expiry, suspended users, unknown fields, log redaction, and authenticated bootstrap idempotency.

## Phase 4 — Creator tenancy and authorization

Depends on: Phase 3.

Implement creators, memberships, role policies, scoped repositories, and audit events for membership changes. Tests exhaust a role/action matrix, cross-creator ID attempts, final-owner protection, optimistic revision conflicts, and direct database permission boundaries.

## Phase 5 — Immutable box and reward drafts/publication

Depends on: Phase 4; policy decisions for odds/value/inventory.

Implement box/reward identities, draft versions, ordered weights, publication validation, canonical manifest/hash, and public reads. Tests cover ownership, positive/overflow weights, sum/checksum consistency, deterministic canonicalization, immutability after publish, concurrent publish/edit, and public disclosure output.

## Phase 6 — Pure RNG library and independent verifier

Depends on: Phase 1 and approved `RNG.md`; can be merged after Phase 5 manifest format is stable.

Implement `hmac-sha256-rejection-v1` as pure domain code, publish language-neutral fixed vectors, and build an independent verification path that does not call the production selector. Tests cover every vector, boundary/rejection cases, malformed inputs, BigInt behavior, and manifest verification.

## Phase 7 — RNG seed lifecycle

Depends on: Phases 2, 3, and 6; encryption/key-management decision.

Implement protected per-user seed generation, commitments, client-seed preference, nonce allocation, rotate/retire/reveal lifecycle primitives, audit records, and compromise stop path. Automatic reveal scheduling/outbox delivery remains deferred to the worker/outbox phase. Tests cover ciphertext/log secrecy, one active seed, concurrent nonce allocation, rollback, rotate/allocation race, reveal prohibition, hash mismatch, and public lifecycle response.

## Phase 8 — Double-entry ledger core

Depends on: Phases 2 and 3; currency policy.

Completed: multi-currency-capable ledger accounts/transactions/entries, one user wallet per currency, cached balance projection, reusable transaction-owned credit/debit/reversal primitives, actor/operation-scoped idempotency, and a development/test-only USD credit grant. PostgreSQL deferred checks enforce per-currency zero sum, minimum non-zero entries, immutable history, exact reversals, and wallet reconciliation. Real-database tests cover unique business references, non-negative and overflow behavior, same-wallet serialization, different-wallet concurrency, concurrent replay, rollback, role permissions, and Phase 7 upgrade compatibility. Provider funding and currency conversion remain absent.

## Phase 9 — Idempotent atomic box opening

Depends on: Phases 5, 7, and 8; opening eligibility/limit and inventory policy.

Completed: the application service and REST command perform one atomic open across idempotency, sufficient-funds validation, nonce/RNG, stable shared inventory, balanced financial postings, immutable opening/win/obligation/earnings/points history, and two durable outbox rows. Database retries stop at the RNG boundary, so a post-selection deadlock rolls back and returns a retryable failure without rerolling. Deferred PostgreSQL checks enforce opening-linked inventory movements and bidirectional non-reversible sale/allocation linkage. Phase 9 itself does not publish; the subsequently completed Phase 10 worker consumes these committed rows.

Compatibility decision: Phase 5–8 published versions are grandfathered immutable history and are never guessed/backfilled. Only a newly published `opening-v1` version with exactly one explicit base reward is openable. Phase 9 adds stable creator-owned finite pools shared across reward versions/boxes, live `pause_box` publication checks, `pause_box`/`backorder`, immutable opening-linked consumption, two-posting sale allocation, 20% default fee, 14-day pending creator earnings, immutable 5/20 point snapshots, and two transactional outbox records; no delivery worker or projection is included.

## Phase 10 — Durable outbox and realtime delivery

Depends on: Phase 9.

Completed: immutable Phase 9 events now have worker-only `SKIP LOCKED` claims, persisted
claim-token leases, bounded deterministic backoff, terminal dead history, crash recovery, and lag
snapshots. The separate worker publishes only `opening.completed.v1` and `drop.created.v1` after
commit through an acknowledged, token-authenticated API Socket.io namespace. Active users get
server-derived private rooms plus validated public creator/global subscriptions; public/private
wire DTOs are exact allowlists, duplicate attempts retain one event ID, and reconnect emits an
explicit refetch requirement. Tests cover rollback absence, two-worker claiming, stale leases,
retry/dead behavior, room authorization, payload redaction, duplicates, and reconnect/refetch.

No Redis projection or leaderboard is part of Phase 10. Those remain Phase 13 exactly as
documented below.

## Phase 11 — Wallet funding provider adapter

Depends on: Phases 8 and 10; provider/custody/refund/chargeback decisions and legal approval.

Completed: Stripe test-mode USD funding intents, exact-raw-body signed webhook ingestion, unique/retryable provider events, one-to-one settled wallet credits, provider-driven refund/dispute compensation, immutable unresolved funding deficits, account restrictions, and read-only provider reconciliation. Browser state is non-authoritative; PostgreSQL uniqueness/deferred checks enforce financial linkage and real-database tests cover forged/reordered/duplicate events, amount/currency and limit enforcement, redirect without webhook, rollback/retry, one ledger credit, refund/dispute shortfalls, reconciliation drift, and the Phase 8 → current upgrade path. Production/live charging, withdrawals, self-service refunds, payouts, conversion, and Phase 12+ remain absent.

## Phase 12 — Fulfillment state machine

Depends on: Phases 9 and 10; fulfillment and inventory/privacy policy.

Completed: typed physical, digital, and experience fulfillment transitions; immutable transition
history; creator/user views; dedicated versioned address/digital AES-256-GCM encryption domains;
audited owner/manager sensitive access; nullable retention metadata and explicit redaction; and
creator-scoped idempotent manual inventory restock/backorder resolution. No external fulfillment
provider is present, so no new provider job was invented; existing Phase 10 outbox/worker behavior
remains unchanged. Tests cover invalid transitions, duplicate action/restock keys, role and tenant
scope, encryption/AAD failure, redaction, pool-authoritative backorders, immutable reward wins, and
authenticated database actor binding, audit rollback on failed decrypt/validation, cross-domain
key separation, canonical UUID AAD, and Phase 9–11 regressions. Automatic restocking/box resume,
carriers, scheduling, and production
retention policy remain deferred.

## Phase 13 — Redis projections and leaderboards

Depends on: Phases 9 and 10; leaderboard definition/privacy policy.

Completed: an independent durable consumer projects immutable opening point snapshots into
rebuildable Redis global/creator all-time and seasonal boards; cache-aside public catalog reads use
TTL/invalidation; PostgreSQL rebuild and drift reconciliation remain authoritative; and ended
seasons finalize immutable global/creator champion results plus permanent achievements. Ranking is
points, earliest score-reach time, then stable UUID internally. Participation and champion
eligibility are automatic for every eligible user, with no Phase 13 opt-out. Public unauthenticated
responses expose only the explicit authoritative username as user identity. Tests cover Redis
loss/unavailability, replay/crash windows, multi-worker claims, ties, creator/season isolation,
rebuild/drift, finalization/idempotency, public fallback, and financial independence.

## Phase 14 — Web authentication and catalog shell

Depends on: Phases 3 and 5.

Completed: a separate PostgreSQL-authoritative public creator catalog API, typed web API client,
Supabase auth/session UI, public creator/box catalog, exact integer-weight odds display,
minor-unit money formatting, responsive routing shell, accessibility/reduced-motion baseline, and
standard loading/error/empty primitives. Tests cover token/session handling, protected-route
gating, XSS-safe rendering, catalog visibility/pagination, currency and tiny-probability
formatting, keyboard/screen-reader semantics, cache fallback, and real contract fixtures.

## Phase 15 — Opening UX and fairness verifier UI

Depends on: Phases 9, 10, and 14.

Build confirmation, client-seed controls, idempotent submission, result-driven Framer Motion reel, reconnect/replay behavior, and verifier UI. Tests prove the animation cannot choose/change reward, duplicate clicks reuse one key, retry shows the committed result, reduced-motion support, boundary proof rendering, and verification before/after reveal.

Completed: immutable server-derived per-entry `rarity-v1` snapshots with legacy-null preservation, the public PostgreSQL-authoritative opening-proof endpoint, a separate Web Crypto independent verifier, and the authenticated opening confirmation/reel/result flow. Confirmation refreshes and binds the exact current version/configuration while PostgreSQL retains price authority; a changed version fails before debit/RNG and requires fresh confirmation. One session-stored command key and expectation automatically recover only ambiguous lost responses; definitive failures clear them and retry-required responses wait for explicit user action. Reel/result data is bound to the committed immutable version, measured reel geometry centers that winner across font and viewport changes, and skip/reduced-motion paths reveal the same committed outcome.

## Product Model Rebase — Free-entry CreatorDrop

Completed historical phases remain accurate: `opening-v1` is the paid wallet/ledger opening model
implemented in Phases 8–15. The target product removes fan payment from newly published Drops
without rewriting that immutable financial or fairness history.

### R1A — opening-v2 + entitlement foundation

Completed: explicit non-financial `opening-v2` catalog versions, a separate deterministic manifest,
positive immutable `maxOpeningsPerUser`, zero legacy base rewards, version-aware domain/verifier
parsing, and immutable PostgreSQL entitlement grant/consumption preparation scoped to stable box
identities. Local operator grants are source-idempotent and application-role inaccessible.
Historical `opening-v1` bytes, hashes, proofs, and paid opening behavior remain unchanged. R1A
prepared but did not itself consume entitlements.

### R1B — Atomic free opening

Completed: the opening endpoint dispatches explicitly by compatibility model. `opening-v2`
serializes each user/stable-box scope, enforces the published successful-opening maximum, selects
the oldest eligible grant with canonical-ID tie-breaking, and consumes exactly one immutable
entitlement in the same caller-owned PostgreSQL transaction as nonce/RNG, inventory,
opening/win/fulfillment, idempotency completion, and outbox. It performs no wallet lookup/debit,
sale/allocation ledger posting, fee/share calculation, creator earning, or legacy points award.
The response and UI are correspondingly non-financial. `opening-v1` keeps its paid Phase 9 path
unchanged.

### R1C — Runtime/product switch

Planned: switch active API/frontend product surfaces to free-entry Drops, disable fan wallet and
funding surfaces, provide the minimum new consumer flow, and complete the rebased normative docs.
Historical financial records and their audit/read requirements remain preserved.

### R2 — Entry claims & manual verification

Planned: screenshot evidence, authoritative usernames/handles, proof-review records, and creator
approval/rejection workflows. Provider-specific Twitch, YouTube, Instagram, or Shopify integration
requires its own approved design rather than being inferred by R1A.

### R3 — XP, levels & Universal Entries

Planned: retire active points/leaderboards, introduce global XP and levels, and define Universal
Entries. Finalized historical rankings/achievements remain immutable history.

### R4 — Creator SaaS plans & hosted-opening quotas

Planned: creator hosting plans, monthly usage limits, and later Stripe Billing. No creator billing
or hosted-opening quota is introduced by R1A.

## Phase 16 — Creator management UI

Depends on: Phases 4, 5, 12, 14, and the R1 runtime/product switch.

Implement role-aware creator settings, free-entry Drop/reward drafts, eligibility configuration from
R2, probability preview/publication confirmation, and fulfillment workflow. Do not restore a paid
fan-opening prerequisite. Tests cover client-side ergonomics plus authoritative server failures,
stale revisions, permission changes mid-session, exact weight display, and inaccessible
cross-creator navigation.

## Phase 17 — Dashboard and live community UI

Depends on: Phases 10, 13, 14, and R3.

Implement the live Drop/community feed, XP/level progress, Universal Entry presentation, creator
aggregates, and reconnect/deduplication. Historical Phase 13 leaderboard results and achievements
remain readable immutable history, not the active progression system. Tests cover
duplicate/out-of-order events, stale projections, Redis fallback, safe identity presentation, and
high-volume rendering.

## Phase 18 — Operational hardening and launch gate

Depends on: all launch-scope phases and completed R1–R4 product decisions.

Perform load/concurrency tests, external security review, fairness implementation review,
restore/disaster exercise, legacy ledger/provider reconciliation rehearsal, entitlement/claim
reconciliation, seed/key rotation drill, abuse/rate-limit tuning, accessibility review, data
retention jobs, dashboards/alerts/runbooks, and legal/product sign-off. Tests include fault
injection (database/Redis/worker/provider), sustained free-opening load, backup restore, key
compromise, claim/entitlement races, webhook backlog for retained integrations, and incident
rollback/feature-stop controls.

No production money is accepted until the launch checklist has named owners and evidence for every gate.

## Testing strategy across phases

### Unit tests

Test pure domain behavior: money arithmetic, permissions, publication validation, state transitions, canonicalization, RNG derivation/selection, event DTO allowlists, and retry classification. Avoid mocking pure collaborators unnecessarily.

### Integration and database transaction tests

Run against real PostgreSQL, not an in-memory imitation. Apply actual migrations. Verify constraints/permissions/triggers, commit and rollback behavior, immutable rows, lock order, ledger balance, projection consistency, seed lifecycle, and outbox atomicity. Use real Redis only for projection/worker tests; financial tests must pass with Redis absent.

### Concurrency tests

Use multiple independent database connections and synchronization barriers rather than timing sleeps. Required scenarios:

- same idempotency key simultaneously (one opening/debit, identical replay);
- different keys with balance sufficient for only one opening;
- several valid opens by one user (unique sequential nonces and exact final balance);
- creator publish/edit races;
- seed rotate/open races;
- duplicate and reordered payment webhooks;
- two outbox workers claiming the same queue.

Assert database state and ledger entries, not only HTTP responses.

### RNG tests

Keep normative JSON vectors in the repository and consume them from production code tests plus an independent verifier. Test half-open probability boundaries and injected rejection rounds. Statistical distribution smoke tests are supplementary and fixed/non-flaky.

### Authorization and security tests

Maintain a table-driven actor/resource/action matrix, including unauthenticated, suspended, fan, each creator role, other-creator member, support, worker, and admin. Test mass assignment, ID enumeration, malformed JWTs, oversized inputs, rate limiting, output/log/event redaction, and direct database-role permissions.

### Contract and end-to-end tests

Validate implementation against OpenAPI and versioned Socket.io schemas. E2E tests cover sign-in, funding sandbox flow, one opening and animation, lost-response replay, proof after seed reveal, creator publish, and fulfillment. Keep a small deterministic E2E suite; lower layers cover permutations.

### Financial invariant/property tests

Generate command sequences and assert: ledger sums zero per currency, posted entries never change, wallet equals its ledger projection, wallet never goes negative, every successful opening has exactly one debit/win/fulfillment, failed openings have none, and every provider settlement maps at most once.

## Definition of done for every implementation phase

- Scope and architecture decision records are updated when behavior changes.
- Runtime validation, authorization, error behavior, observability/redaction, and migration impact are considered.
- Unit/integration/contract tests appropriate to the risk are added and pass.
- Formatter, linter, strict typecheck, tests, build, and migration validation pass using the commands in `AGENTS.md`.
- No unrelated files are changed; generated changes are reviewed; no secrets or active seeds appear in fixtures/logs.
