# AGENTS.md

These rules apply to the entire repository. Read `PROJECT_BRIEF.md` and the relevant document in `docs/` before changing behavior. Architecture documentation is the current source of intended behavior; if code and docs disagree, stop and surface the discrepancy rather than silently choosing one.

## Scope and change discipline

- Keep each change focused on the requested responsibility and its tests. Do not refactor, rename, reformat, upgrade, or delete unrelated code.
- Preserve user changes and dirty-worktree content. Inspect the diff before and after editing.
- Do not scaffold future roadmap phases as part of an earlier phase.
- Do not add a dependency without explaining why platform/shared code is insufficient, checking its maintenance/security posture, and committing the lockfile change.
- Database schema changes require a forward migration, integration tests, and corresponding documentation. Never edit an already-applied migration.
- Public API, Socket.io event, persisted manifest, ledger, and RNG algorithm changes require explicit version/compatibility review.
- Never commit secrets, real personal/payment data, production identifiers, or real server seeds. Examples and fixtures must be obviously synthetic.

## TypeScript conventions

- TypeScript is strict. Do not weaken compiler/lint rules to make a change pass. Avoid `any`; use `unknown` at trust boundaries and narrow with runtime validation.
- Validate every external input: HTTP params/query/body/headers, JWT claims, environment variables, webhooks, database JSON, Redis values, and provider responses.
- Use branded/domain types for identifiers, `MoneyMinor`, currency, weights, nonces, and lifecycle states where it prevents accidental mixing.
- Monetary minor units and weights use `bigint` internally and decimal strings in JSON. Never use floating point for money or probability selection.
- Prefer pure functions and explicit dependencies. Do not read global environment state outside the configuration module.
- Controllers translate transport concerns only. Put use-case coordination in services, deterministic policy in domain modules, and SQL in repositories.
- Pass a transaction-scoped database interface explicitly. Do not hide transaction boundaries in helpers or make network/Redis/Socket.io calls inside a database transaction.
- Use typed domain errors mapped centrally to stable API error codes. Do not leak stack traces or dependency errors to clients.
- Treat all time as UTC and inject a clock where behavior depends on time. Inject cryptographic/random sources in tests; production RNG must use Node `crypto`/OS CSPRNG.
- Prefer named exports, small cohesive modules, and colocated tests. Do not create a generic `utils` dumping ground or circular module imports.

## Security and authorization invariants

- The client is never authoritative for user/creator identity, roles, ownership, prices, currency, weights, probabilities, balance, nonce, seed commitment, or reward result.
- Verify JWT signature, issuer, audience, time claims, and local user status. Derive the actor from the verified token.
- Creator reads/writes must be scoped by both resource and creator membership/role. Test access by a member of a different creator.
- Use allowlisted response/event/log DTOs. Never serialize database rows directly to public APIs, events, logs, or analytics.
- Active server seeds, ciphertext, keys, payment tokens, webhook secrets, full addresses, and credentials must never enter logs, traces, Redis, errors, or Socket.io.
- Use least-privilege database/service roles. Application code must not bypass ledger, immutable-version, or seed lifecycle protections.
- Sensitive administrative/support actions require explicit authorization, reason, and append-only audit entry.
- New endpoints need runtime validation, authentication decision, authorization policy, rate-limit decision, and negative tests.

## Financial and transaction rules

- PostgreSQL is authoritative for all financial state. Redis and Socket.io are never part of a financial correctness decision.
- Store money only as integer minor units plus ISO 4217 currency. Do not combine currencies or perform implicit conversion.
- Only the wallet/ledger module may mutate monetary state. Every mutation is a balanced, immutable ledger transaction with a unique business reference.
- Never update/delete posted ledger entries. Refunds, chargebacks, reversals, and corrections are new compensating transactions.
- The wallet balance is an atomically maintained projection of its ledger account, constrained non-negative and updated in the same transaction as ledger entries.
- Financial commands and box openings require user-scoped idempotency. Same key plus same fingerprint replays; same key plus different fingerprint conflicts. Preserve durable uniqueness after cached response expiry.
- A successful opening has exactly one wallet debit, opening, reward win, fulfillment record, and relevant outbox records. A failed/rolled-back opening has none of them and consumes no nonce.
- Follow the global database lock order in `docs/ARCHITECTURE.md`. Bound retries for deadlocks/serialization failures and retain the same idempotency identity.
- Never call a payment provider, Redis, Socket.io, email, or fulfillment provider inside the atomic opening/ledger transaction.
- Provider browser redirects never credit wallets. Verify and deduplicate signed provider webhooks, and reconcile provider settlements to ledger transactions.

## RNG and box rules

- Never use `Math.random()` for outcomes, seeds, tokens, IDs requiring unpredictability, or fairness logic.
- Implement the exact versioned algorithm in `docs/RNG.md`: CSPRNG server seed, SHA-256 commitment, HMAC-SHA256, canonical message, unsigned 256-bit `BigInt`, rejection sampling, and half-open weighted intervals.
- Server seeds remain encrypted/unrevealed while active. Never reveal, return, log, cache, or emit an active seed. Retire before reveal and verify the reveal hashes to the commitment.
- Allocate nonces under a PostgreSQL row lock in the same transaction as the opening. Enforce unique `(seed_set, nonce)`. Idempotency replay does not allocate another nonce.
- Published box/reward versions and probability manifests are immutable. Edits create a new version. Each opening references the exact manifest/version and commitment used.
- The backend selects and persists the outcome before responding. Frontend animation only visualizes the committed reward and must never calculate or substitute it.
- RNG changes require a new algorithm version, new deterministic vectors, an independent verifier update, and preservation of verification for old openings.

## Testing requirements

- Add the lowest-level meaningful tests and integration tests for cross-row/transaction behavior. Do not rely only on mocked repository tests for financial, authorization, RNG lifecycle, or idempotency correctness.
- Database tests use real PostgreSQL with production migrations, constraints, triggers, roles, and multiple independent connections for concurrency.
- Concurrency tests use barriers/coordination, not flaky sleeps. Assert persisted state, ledger balance, nonce uniqueness, and event presence—not only response codes.
- Every authorization change includes allowed and denied actors, including an actor from another creator.
- Every financial command includes success, insufficient funds/policy failure, duplicate retry, same-key/different-request, concurrent request, rollback, and invariant assertions where applicable.
- RNG tests consume checked-in normative vectors and cover interval boundaries, rejection sampling, malformed inputs, rotation/reveal, rollback, and concurrency. The verifier must not import the production selector.
- Socket/outbox tests prove no event for rolled-back data, delivery only after commit, duplicate-event handling, payload redaction, and room authorization.
- Keep tests deterministic. Use synthetic secrets/data and fixed clocks; never weaken assertions to suppress nondeterminism.

## Commands before completion

Run these workspace scripts from the repository root before declaring an implementation task complete:

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run test:integration
npm run build
npm run db:migrations:validate
```

Run `npm run check:workspaces` and `npm run secrets:scan` as additional quality gates. Database work requires local Docker plus `npm run db:start`; `db:migrations:validate` resets the local database from empty and is destructive to local development data. Integration tests must use this real PostgreSQL instance. Run focused tests while iterating, then the full applicable suite. For documentation-only changes, inspect links/content and run the repository's Markdown formatter/linter when one exists.

## PostgreSQL and migration rules

- Use only forward, explicitly named SQL files under `infra/supabase/migrations`. Never use ORM schema auto-sync or edit a migration that has left an ephemeral local environment.
- Create a migration with `npm run db:migration:new -- descriptive_name`, then review every generated statement before applying it.
- Keep application objects in `app` and intentionally private objects in `app_private`; never place CreatorDrop domain tables in `public`.
- Run privileged extension/role statements as the Supabase migration runner, then use `set role creatordrop_migrator` while creating normal application schemas, tables, functions, triggers, and constraints. End with `reset role`.
- Grant application access deliberately. Functions are not executable by the application role unless a migration explicitly grants that privilege.
- Runtime database connections use the restricted application role. Migration/test-admin credentials must not be used by request handlers or workers.
- All SQL values from application data use parameters. Identifiers cannot be parameterized and must come from fixed allowlists or narrowly validated infrastructure-only helpers.
- The shared transaction helper owns `BEGIN`, `COMMIT`, `ROLLBACK`, and client release. Repositories receive its transaction-scoped `QueryExecutor`; they do not open hidden transactions.
- Integration tests isolate state with a dedicated PostgreSQL session and temporary objects or another documented database-level mechanism. Do not replace PostgreSQL with an in-memory imitation.

## Completion report

Before handing off:

1. inspect `git diff --check` and the complete scoped diff;
2. confirm no unrelated files, secrets, active seed material, or generated junk changed;
3. report files changed, behavior/invariants affected, tests/commands run, and any command not run;
4. identify migrations, operational actions, compatibility concerns, or unresolved product decisions.
