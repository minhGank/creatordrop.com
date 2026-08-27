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

Completed: the application service and REST command perform one atomic open across idempotency, sufficient-funds validation, nonce/RNG, stable shared inventory, balanced financial postings, immutable opening/win/obligation/earnings/points history, and two durable outbox rows. Database retries stop at the RNG boundary, so a post-selection deadlock rolls back and returns a retryable failure without rerolling. Deferred PostgreSQL checks enforce opening-linked inventory movements and bidirectional non-reversible sale/allocation linkage. Phase 10 delivery remains absent.

Compatibility decision: Phase 5–8 published versions are grandfathered immutable history and are never guessed/backfilled. Only a newly published `opening-v1` version with exactly one explicit base reward is openable. Phase 9 adds stable creator-owned finite pools shared across reward versions/boxes, live `pause_box` publication checks, `pause_box`/`backorder`, immutable opening-linked consumption, two-posting sale allocation, 20% default fee, 14-day pending creator earnings, immutable 5/20 point snapshots, and two transactional outbox records; no delivery worker or projection is included.

## Phase 10 — Durable outbox and realtime delivery

Depends on: Phase 9.

Implement outbox claiming/retry/dead-letter policy, Socket.io authentication/rooms, sanitized versioned events, and post-commit publication. Tests prove no event before/after rolled-back transaction, at-least-once deduplication, worker crash recovery, room authorization, payload redaction, reconnect/refetch behavior, and outbox lag metrics.

## Phase 11 — Wallet funding provider adapter

Depends on: Phases 8 and 10; provider/custody/refund/chargeback decisions and legal approval.

Implement funding intents, signed webhook ingestion, unique provider events, settled credits, refunds/chargebacks as compensating postings, and provider reconciliation. Use provider sandbox. Tests cover forged/reordered/duplicate events, amount/currency mismatch, redirect without webhook, webhook retry/crash, one ledger credit, refund/chargeback, and reconciliation drift.

## Phase 12 — Fulfillment state machine

Depends on: Phases 9 and 10; fulfillment and inventory/privacy policy.

Implement typed reward-specific fulfillment transitions, worker retries, creator/user views, encrypted/tokenized delivery data, access audit, and retention. Tests cover invalid transitions, duplicate action keys, cross-creator access, provider retry, address redaction/encryption, expired data, and immutable reward wins.

## Phase 13 — Redis projections and leaderboards

Depends on: Phases 9 and 10; leaderboard definition/privacy policy.

Build idempotent consumers for creator spend/drop projections, cache-aside public catalog reads, TTL/invalidation, PostgreSQL rebuild and drift reconciliation. Tests run with Redis unavailable/evicted, replay duplicate events, rebuild from PostgreSQL, verify ordering/tie rules, isolate creators/currencies, and prove no financial command depends on cache.

## Phase 14 — Web authentication and catalog shell

Depends on: Phases 3 and 5.

Implement typed API client, auth/session UI, public creator/box catalog, exact odds display, accessibility baseline, and error/retry primitives. Tests cover token handling, XSS-safe rendering, loading/error states, currency formatting from integer strings, keyboard/screen-reader behavior, and contract fixtures.

## Phase 15 — Opening UX and fairness verifier UI

Depends on: Phases 9, 10, and 14.

Build confirmation, client-seed controls, idempotent submission, result-driven Framer Motion reel, reconnect/replay behavior, and verifier UI. Tests prove the animation cannot choose/change reward, duplicate clicks reuse one key, retry shows the committed result, reduced-motion support, boundary proof rendering, and verification before/after reveal.

## Phase 16 — Creator management UI

Depends on: Phases 4, 5, 12, and 14.

Implement role-aware creator settings, box/reward drafts, probability preview/publication confirmation, and fulfillment workflow. Tests cover client-side ergonomics plus authoritative server failures, stale revisions, permission changes mid-session, exact weight display, and inaccessible cross-creator navigation.

## Phase 17 — Dashboard and live community UI

Depends on: Phases 10, 13, and 14.

Implement live drop feed, leaderboards with freshness indicators, creator aggregates, reconnect/deduplication, privacy controls, and currency separation. Tests cover duplicate/out-of-order events, stale projections, Redis fallback, identity opt-out, and high-volume rendering.

## Phase 18 — Operational hardening and launch gate

Depends on: all launch-scope phases.

Perform load/concurrency tests, external security review, fairness implementation review, restore/disaster exercise, ledger/provider reconciliation rehearsal, seed/key rotation drill, abuse/rate-limit tuning, accessibility review, data retention jobs, dashboards/alerts/runbooks, and legal/product sign-off. Tests include fault injection (database/Redis/worker/provider), sustained open load, backup restore, key compromise, webhook backlog, and incident rollback/feature-stop controls.

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
