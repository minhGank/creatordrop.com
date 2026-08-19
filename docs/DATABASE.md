# PostgreSQL Data Model

## Conventions

- PostgreSQL is the system of record. Use SQL migrations checked into `packages/database/migrations`; never use schema auto-sync in production.
- Primary keys are UUIDv7 (application-generated) unless a table explicitly uses a monotonic identity. Public IDs may be separate opaque strings if enumeration becomes a concern.
- Timestamps are `timestamptz`, stored in UTC, with `created_at` and `updated_at` where mutation is allowed.
- Money is `bigint` minor units with a `char(3)` ISO 4217 currency. Application types brand `MoneyMinor` and serialize it as a decimal string in JSON to avoid JavaScript precision loss.
- Probability weights are positive `bigint`; totals must fit signed 64-bit storage. They have no currency meaning and must not use floating point.
- Mutable rows use optimistic `revision integer` where administrator/creator edits can race. Published version rows are immutable by permissions and triggers.
- Enumerations are check constraints or lookup values with forward-compatible application parsing; PostgreSQL enums are avoided where deployments need online extension.
- Foreign keys are explicit. Financial, opening, RNG, version, and audit history uses `ON DELETE RESTRICT`; user-facing deletion is soft deletion/pseudonymization.
- Lowercase handles/slugs are stored as `citext` or normalized text with unique indexes.

## Identity and creator ownership

### `users`

| Column                     | Type        | Rules                           |
| -------------------------- | ----------- | ------------------------------- |
| `id`                       | uuid        | PK                              |
| `auth_provider`            | text        | not null                        |
| `auth_subject`             | text        | not null                        |
| `username`                 | citext      | not null                        |
| `status`                   | text        | `active`, `suspended`, `closed` |
| `created_at`, `updated_at` | timestamptz | not null                        |
| `closed_at`                | timestamptz | nullable                        |

Unique: `(auth_provider, auth_subject)`, `username`. Authentication identity is never accepted from request data.

### `creators`

`id` PK, `handle citext` unique, `custom_slug citext` unique, `display_name`, `status`, `revision`, timestamps. Do not model creator ownership only as `creators.user_id`; membership supports teams without a later migration.

### `creator_memberships`

`creator_id` FK, `user_id` FK, `role` (`owner`, `manager`, `editor`, `viewer`), timestamps. PK `(creator_id, user_id)`. A partial/trigger-enforced rule must preserve at least one owner for an active creator. Index `(user_id, creator_id)` supports authorization.

## Boxes, rewards, and immutable versions

### `boxes`

Stable identity: `id`, `creator_id` FK, `current_published_version_id` nullable FK (added after version table), `status` (`draft`, `active`, `paused`, `archived`), timestamps, `revision`. Index `(creator_id, status, created_at desc)`.

### `box_versions`

Versioned publication record, immutable once published:

- `id` PK, `box_id` FK, `version_number integer`, unique `(box_id, version_number)`;
- `name`, `description`, `image_url` and other presentation snapshot fields;
- `price_minor bigint CHECK (price_minor > 0)`, `currency char(3)`;
- `total_weight bigint CHECK (total_weight > 0)`;
- `configuration_hash bytea` (SHA-256 of canonical selection manifest), `rng_algorithm_version text`;
- `state` (`draft`, `published`, `retired`), `published_at`, `created_by_user_id`, timestamps.

Only drafts may be changed. Publishing validates the complete graph, computes the canonical manifest/hash and total, makes the rows immutable, and atomically switches `boxes.current_published_version_id`. Partial unique index: one draft per box if that is the chosen editing UX. Index `(box_id, state, version_number desc)`.

### `rewards`

Stable identity: `id`, `creator_id`, `status` (`active`, `archived`), timestamps, revision. Keeping `creator_id` on the row makes ownership scope enforceable without traversing a mutable box relation.

### `reward_versions`

Versioned content snapshot: `id`, `reward_id`, `version_number`, `state` (`draft`, `published`, `retired`), `name`, `description`, `image_url`, `reward_type` (`digital`, `physical`, `experience`), `declared_value_minor` nullable, `declared_value_currency` nullable, `fulfillment_definition jsonb`, timestamps, `created_by_user_id`. Unique `(reward_id, version_number)`. Drafts may change; publication makes the row immutable. JSON is schema-validated at publication; secrets and physical addresses never belong here.

### `box_version_rewards`

The exact ordered probability table: `id`, `box_version_id`, `reward_version_id`, `position integer CHECK (position >= 0)`, `weight bigint CHECK (weight > 0)`, optional immutable public label metadata. Unique `(box_version_id, position)` and `(box_version_id, reward_version_id)`. Index `(box_version_id, position)`. The canonical selection order is `position`, then ID as a corruption-detection tie breaker.

A deferred validation trigger or publish transaction verifies `sum(weight) = box_versions.total_weight`, all reward versions belong to the same creator, positions are contiguous, currencies/value rules hold, and the canonical manifest matches `configuration_hash`.

## Fairness state

### `fairness_profiles`

One per user: `user_id` PK/FK, `current_client_seed_hash bytea`, optional encrypted/current seed storage only if server-side recovery is a product requirement, timestamps/revision. The opening stores the actual client seed used. A seed must be 32 random bytes encoded as 64 lowercase hex characters; the UI may generate it, but the user can replace it before opening.

### `rng_seed_sets`

| Column                                    | Type        | Rules                                               |
| ----------------------------------------- | ----------- | --------------------------------------------------- |
| `id`                                      | uuid        | PK and part of RNG message                          |
| `user_id`                                 | uuid        | FK; initial per-user scope                          |
| `commitment`                              | bytea       | unique, SHA-256 of raw seed                         |
| `server_seed_ciphertext`                  | bytea       | not null until retention policy permits destruction |
| `encryption_key_version`                  | text        | not null                                            |
| `revealed_server_seed`                    | bytea       | nullable; set only after retirement                 |
| `status`                                  | text        | `active`, `retired`, `revealed`, `compromised`      |
| `next_nonce`                              | bigint      | `>= 0`, allocated under row lock                    |
| `max_nonce_exclusive`                     | bigint      | rotation boundary                                   |
| `created_at`, `retired_at`, `revealed_at` | timestamptz | lifecycle times                                     |

Partial unique index `(user_id) WHERE status = 'active'`; unique `commitment`; index `(status, retired_at)` for reveal jobs. A trigger rejects setting `revealed_server_seed` on an active row and verifies its hash equals the commitment. Server seed plaintext never appears in general query views or logs.

## Opening, wins, and fulfillment

### `idempotency_records`

`id`, `actor_user_id`, `scope` (for example `box.open`), `key`, `request_fingerprint bytea`, `status` (`completed`; a row is transaction-local while processing), `http_status`, `response_body jsonb`, `resource_type`, `resource_id`, `created_at`, `expires_at`.

Unique `(actor_user_id, scope, key)`. Index `expires_at` for cleanup. Financial records retain the key/reference even after replay bodies expire; deletion must not remove the unique business reference on the ledger/opening. Keys are opaque, 8–255 characters, and never logged in full.

### `box_opens`

- identity: `id`, `public_id` unique, `user_id`, `box_id`, `box_version_id`, `box_version_reward_id`;
- money snapshot: `cost_minor bigint CHECK (cost_minor > 0)`, `currency`;
- fairness proof: `rng_seed_set_id`, `server_seed_commitment bytea`, `client_seed text`, `nonce bigint CHECK (nonce >= 0)`, `rng_algorithm_version`, `rng_digest bytea`, `selection_value numeric(78,0)`, `selection_round integer`, `configuration_hash bytea`;
- references: `idempotency_record_id` unique, `ledger_transaction_id` unique, `created_at`.

Unique `(rng_seed_set_id, nonce)` guarantees no nonce reuse. Indexes `(user_id, created_at desc, id)`, `(box_id, created_at desc, id)`, `(box_version_id)`, and `(box_version_reward_id)`. The proof columns and all references are immutable. `selection_value` is the unbiased integer in `[0,total_weight)`, not a floating-point roll.

### `reward_wins`

`id`, `box_open_id` unique FK, `user_id`, `reward_version_id`, `status` (`awarded`, `voided` only through an audited compensating process), `awarded_at`, presentation snapshot if required for legally durable receipts. Index `(user_id, awarded_at desc)`.

### `fulfillments`

`id`, `reward_win_id` unique FK, `type`, `status` (`pending`, `action_required`, `processing`, `fulfilled`, `failed`, `cancelled`), encrypted/tokenized `delivery_details`, `provider`, `provider_reference`, `attempt_count`, `last_error_code`, `next_attempt_at`, timestamps. Unique `(provider, provider_reference)` when not null. Index `(status, next_attempt_at)` for workers. Status changes are recorded in `fulfillment_events(id, fulfillment_id, from_status, to_status, actor_type, actor_id, reason, created_at)`.

Finite inventory is deliberately not finalized. If approved, add `reward_inventory` with an immutable publication policy and conditional reservations in the opening transaction; see the open decision in `ARCHITECTURE.md`.

## Wallet and double-entry ledger

### `wallets`

`id`, `user_id`, `currency`, `ledger_account_id` unique FK, `available_balance_minor bigint CHECK (available_balance_minor >= 0)`, `version bigint`, timestamps. Unique `(user_id, currency)`. The linked account must be the matching user's `user_wallet` ledger account in the same currency. The row is locked on debit. Balance is a transactionally maintained projection, not a substitute for the ledger.

### `ledger_accounts`

`id`, `account_type` (`user_wallet`, `platform_cash`, `creator_payable`, `platform_revenue`, `provider_clearing`, `refund_reserve`), `owner_user_id` nullable, `owner_creator_id` nullable, `currency`, `status`, timestamps. Constraints enforce the owner shape for each type. Unique user-wallet account `(owner_user_id, currency) WHERE account_type='user_wallet'`; corresponding controlled-account uniqueness is defined by type/currency/owner.

### `ledger_transactions`

Immutable header: `id`, `kind` (`wallet_funding`, `box_open`, `refund`, `chargeback`, `creator_accrual`, `payout`, `adjustment`), `business_reference_type`, `business_reference_id`, `idempotency_key`, `status='posted'`, `description`, `metadata jsonb` (non-secret), `created_by_type`, `created_by_id`, `created_at`.

Unique `(kind, business_reference_type, business_reference_id)` is the final duplicate-posting defense. Adjustments require a distinct reference to the transaction they compensate and an audit reason; posted rows are never updated/deleted.

### `ledger_entries`

`id`, `ledger_transaction_id`, `account_id`, `amount_minor bigint CHECK (amount_minor <> 0)`, `currency`, `sequence smallint`, `created_at`; unique `(ledger_transaction_id, sequence)`. Index `(account_id, created_at, id)`.

Use one sign convention: positive increases the account's balance, negative decreases it. Every transaction must sum to zero separately per currency. A deferred constraint trigger verifies balance and currency agreement at commit. The application role can post only through a narrow database function/repository transaction that inserts the header/entries and updates the applicable wallet projection. Direct `UPDATE wallets` and direct ledger mutation are revoked.

Example box open in USD:

```text
user wallet liability/account   -1000
platform escrow/payable account +1000
sum                                 0
```

Creator allocation/platform fee can be a separate balanced transaction once policy is defined, or additional entries in the same transaction if immutable at purchase time.

### Payment tables

`payment_intents` tracks user, provider, provider intent ID, amount/currency, state, and timestamps; unique provider intent ID and unique client idempotency reference. `payment_events` stores unique `(provider, provider_event_id)`, signature verification result, payload hash/encrypted raw reference, processing status, attempts, and timestamps. A settled provider event creates exactly one ledger transaction. Equivalent tables/state machines apply to `payouts` before creator payouts launch.

## Reliable events and auditing

### `event_outbox`

`id` (also event ID), `aggregate_type`, `aggregate_id`, `event_type`, `schema_version`, `payload jsonb`, `occurred_at`, `available_at`, `attempt_count`, `claimed_at`, `delivered_at`, `last_error_code`. Index `(delivered_at, available_at, occurred_at)` with a partial index for undelivered rows. Payloads are explicit allowlisted DTOs, not serialized database rows.

### `audit_log`

Append-only `id`, actor type/ID, action, resource type/ID, creator scope, reason, request/correlation ID, before/after hashes or redacted changes, IP/user-agent policy fields, `created_at`. Indexes on `(resource_type, resource_id, created_at)` and `(actor_id, created_at)`. Never store credentials, seeds, payment tokens, or full addresses.

## Constraints that need database enforcement

1. Published box/reward/version graph and completed openings are immutable.
2. One active RNG seed-set per user; no reveal while active; revealed seed hashes to its commitment.
3. One opening per idempotency record and one opening per `(seed_set, nonce)`.
4. One ledger posting per business reference; entries balance to zero per currency.
5. Wallet balance never becomes negative and changes only with a posted ledger transaction in the same transaction.
6. Box version reward ownership matches the box creator and summed weights equal the recorded total.
7. `boxes.current_published_version_id` belongs to that box and is published.
8. Creator resources cannot be reassigned across creators after publication.

Cross-row rules require deferred constraint triggers or narrowly permissioned database functions plus integration tests. Application checks alone are insufficient.

## Transaction isolation and lock policy

Use `READ COMMITTED` plus explicit `SELECT ... FOR UPDATE`/conditional updates for opening and payment posting. Keep transactions free of HTTP, Redis, Socket.io, and file operations. Maintain the global lock order documented in `ARCHITECTURE.md`. Retry PostgreSQL deadlocks/serialization failures with bounded jitter using the same command/idempotency identity. Use advisory locks only for singleton maintenance jobs, not wallet correctness.

## Retention and deletion

Idempotency response bodies may expire after a policy-defined window (recommended minimum 24 hours, longer than all client retry windows), but opening and ledger uniqueness references persist. Seed ciphertext/reveals, opening proofs, configuration versions, ledger, provider event identifiers, and audit records follow financial/legal retention. Account deletion pseudonymizes public/profile data while retaining minimally required financial/fairness records. Exact periods require legal approval.
