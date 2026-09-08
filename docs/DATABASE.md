# PostgreSQL Data Model

## Conventions

- PostgreSQL is the system of record. Use SQL migrations checked into `infra/supabase/migrations`; never use schema auto-sync in production.
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

Phase 3 creates this table in the `app` schema. Bootstrap IDs are application-generated UUIDv7 values. Until profile editing is implemented, the API derives a collision-resistant placeholder username from that new local ID; it does not derive a username from email, token metadata, or request data. Bootstrap uses `INSERT ... ON CONFLICT DO NOTHING` followed by a transaction-scoped identity lookup, so retries and concurrent requests map to one row without changing an existing profile. `closed_at` is present exactly when status is `closed`.

### `creators`

Phase 4 creates `app.creators` with an application-generated UUIDv7 `id` primary key; case-insensitively unique, format-constrained `handle citext` and `custom_slug citext`; a length-constrained `display_name`; checked `status` (`active`, `suspended`, `closed`); positive optimistic `revision`; and timestamps. Creator settings increment `revision` with a conditional update. Ownership is not stored as `creators.user_id`; membership supports teams without a later migration.

### `creator_memberships`

Phase 4 creates `app.creator_memberships` with `creator_id` and `user_id` restrictive foreign keys, checked role (`owner`, `manager`, `editor`, `viewer`), and timestamps. The composite primary key `(creator_id, user_id)` rejects duplicates. Index `(user_id, creator_id)` supports actor workspace lookup; a partial owner index supports the invariant check.

Membership identity columns are immutable. Every membership insert, update, or delete locks its parent creator row, serializing ownership changes for that tenant. Deferred constraint triggers on both tables reject creator insertion without an owner and any transaction that leaves an active creator ownerless. This permits atomic creator-plus-owner creation while protecting final-owner demotion/removal, including concurrent attempts. Creator deletion and user deletion are `ON DELETE RESTRICT` in this phase.

## Boxes, rewards, and immutable versions

### `boxes`

Phase 5 creates this stable identity in `app`: `id`, `creator_id` FK, `current_published_version_id` nullable FK (added after the version table), `status` (`draft`, `active`, `paused`, `archived`), timestamps, and optimistic `revision`. Creator ownership is immutable. Index `(creator_id, status, created_at desc, id)` supports scoped listing.

### `box_versions`

Versioned publication record, immutable once published:

- `id` PK, `box_id` FK, `version_number integer`, unique `(box_id, version_number)`;
- `name`, `description`, `image_url` and other presentation snapshot fields;
- legacy `price_minor bigint` and `currency char(3)`, both null only for `opening-v2`;
- `max_openings_per_user bigint`, positive only for `opening-v2` and null for legacy history;
- `total_weight bigint CHECK (total_weight > 0)`;
- `configuration_hash bytea` (SHA-256 of canonical selection manifest), `rng_algorithm_version text`;
- nullable `opening_compatibility_version`; `opening-v1` is legacy paid and `opening-v2` is free-entry;
- `state` (`draft`, `published`, `retired`), `published_at`, `created_by_user_id`, timestamps.

Only drafts may be changed. Phase 5 enforces one draft per box with a partial unique index. Publishing locks the box, validates the complete graph, computes the canonical manifest/hash and total, changes the draft to `published`, marks referenced reward versions published, and atomically switches `boxes.current_published_version_id` while incrementing its revision. The box identity becomes `active` on its first publication. Later edits lazily clone the latest version into a new numbered draft; history is never overwritten.

Phase 9 grandfathering is explicit. Published versions that predate its migration retain a null compatibility marker and receive no inferred `box_version_base_rewards` row. They remain immutable/readable but are not eligible for `POST /v1/boxes/:boxId/open`. An `opening-v1` draft requires positive price/currency, no maximum, and exactly one base designation at publication. An `opening-v2` draft requires null price/currency, a positive maximum, and zero base designations. A legacy box changes model only by publishing a normal new immutable version.

Manifest parsing is explicitly versioned. Historical/`opening-v1` RFC 8785-compatible bytes contain algorithm version, box/version IDs, currency, price, total weight, and ordered association ID/reward-version ID/position/weight entries. `opening-v2` bytes instead contain the model marker, box/version IDs, ordered entries including immutable rarity/policy snapshots, total weight, and `maxOpeningsPerUser`; no financial field is permitted. Integer values that can exceed JavaScript's safe range are decimal strings. `configuration_hash` is SHA-256 over the exact version-specific UTF-8 bytes. The RNG algorithm remains `hmac-sha256-rejection-v1` for both.

### `rewards`

Phase 5 creates the stable identity with `id`, `creator_id`, `status` (`active`, `archived`), timestamps, and optimistic revision. Keeping `creator_id` on the row makes ownership scope enforceable without traversing a mutable box relation, and a trigger prevents reassignment.

### `reward_versions`

Versioned content snapshot: `id`, `reward_id`, `version_number`, `state` (`draft`, `published`, `retired`), `name`, `description`, `image_url`, `reward_type` (`digital`, `physical`, `experience`), inventory configuration, optional declared value, an empty Phase 5 `fulfillment_definition` object, timestamps, and `created_by_user_id`. Unique `(reward_id, version_number)` with one draft per reward. Drafts may change. A reward version becomes published when a box publication first references it; a trigger then prevents updates/deletes, including through another box draft. Later edits lazily create a new reward version.

Inventory configuration is either `unlimited` with a null quantity/policy/pool or `finite` with a nonnegative `bigint` quantity, `pause_box` (default) or `backorder`, and an immutable `inventory_pool_id` reference. A zero finite quantity is allowed while drafting but cannot be newly published. Inventory-pool identity is independent of reward-version identity: a new finite reward creates a distinct pool, while a later immutable metadata/catalog version retains the same pool and cannot replenish consumed stock. Multiple versions and boxes can therefore reference one physical stock resource without rewriting historical snapshots. Openings lock and consume only the selected pool after RNG. Existing finite versions are mapped to their original Phase 9 pool during the forward migration, while legacy box versions remain non-openable.

### `inventory_pools` and `inventory_consumptions`

`inventory_pools` stores a stable UUID, immutable creator owner, protected stockout policy and
historical initial quantity, plus mutable nonnegative available quantity. Reward-version
references must stay within the same creator. Publication locks every referenced finite
`pause_box` pool in UUID order and verifies its live `available_quantity > 0` before
locking/activating the box; configured quantity is not an availability signal. Phase 12 manual
restock never rewrites initial quantity: owner/manager commands on a published/shared pool append an immutable,
creator-scoped `inventory_restock_events` row with `(pool, actor, positive quantity, action key,
fingerprint)` and increase availability in the same transaction. Duplicate semantic commands
replay; key reuse with different quantity fails. Automatic restock and box resume do not exist.

Each successful in-stock finite opening has exactly one immutable `inventory_consumptions` row keyed by `opening_id`, with its pool, quantity one, and timestamp. Pool decrement and movement insertion occur through one transaction-owned function. A zero-stock `backorder` opening initially has no consumption; owner/manager resolution later locks the same pool and appends its one opening-linked consumption before advancing the existing obligation. Deferred checks require the movement to match the selected reward version and opening pool and reconcile `initial_quantity + sum(restocks) - available_quantity = sum(consumptions)`. Unlimited openings never receive a consumption row.

### `box_version_rewards`

The exact ordered probability table: `id`, `box_version_id`, `reward_version_id`, `position integer CHECK (position >= 0)`, `weight bigint CHECK (weight > 0)`, plus nullable immutable `rarity` and `rarity_policy_version` snapshots. Unique `(box_version_id, position)` and `(box_version_id, reward_version_id)`. Index `(box_version_id, position)`. The canonical selection order is `position`, then ID as a corruption-detection tie breaker.

For publications created after the Phase 15 migration, the server and a database publication guard derive every entry's tier using exact integer comparisons under `rarity-v1`: common at 20% or above, uncommon at 8% through below 20%, rare at 2% through below 8%, epic at 0.5% through below 2%, and legendary above zero through below 0.5%. Rarity is specific to the immutable box/reward association, not the reward version. Pre-rarity published history is not backfilled and retains both fields as null.

The Phase 5 publish transaction verifies at least one association, positive weights, a nonoverflowing total, contiguous positions, same-creator ownership, active reward identities, and valid publication inventory. Database triggers repeat the cross-row ownership/publication checks and require `sum(weight) = box_versions.total_weight`. Triggers also prevent inserting, updating, or deleting associations after publication and prevent mutation of any referenced published reward version. The application reconstructs public output and verifies the stored total and canonical hash before returning it.

### `box_version_base_rewards`

Draft-only mutable designations link a generated ID, box version, and one of that version's reward associations. Multiple/zero designations may exist during legacy editing, but the forward publication trigger requires exactly one for `opening-v1` and zero for `opening-v2`. Designations become immutable with the published version and are deliberately absent for grandfathered history.

### `opening_entitlement_grants` and `opening_entitlement_consumptions`

Grants are immutable non-financial authority scoped to `(user_id, creator_id, box_id)`, where the composite box/creator foreign key proves stable Drop ownership. Each row records positive `quantity_granted`, a generic source type/identity, globally unique SHA-256 semantic fingerprint, optional granting actor, reason, and timestamp. The unique source and fingerprint constraints plus the private grant primitive make exact retry idempotent and reject semantic reuse across a different user, creator, box, quantity, actor, or reason.

R1B consumption rows repeat the exact grant scope, carry the `opening-v2` model marker, and have a
globally unique `opening_id`. A deferred composite foreign key requires that ID to be one immutable
v2 opening with the same user, creator, and stable box. The converse deferred opening guard requires
exactly one consumption for v2 and zero for v1. A before-insert grant guard locks the grant and
prevents over-consumption. The opening path first locks a private `(user_id, box_id)` guard shared
by all versions of one stable Drop, checks the successful v2 count against the current version's
maximum, and then chooses the oldest available grant by `(created_at, id)` under lock. This makes
multi-grant use and the stable-box maximum concurrency-safe without serializing unrelated users.
Grant/consumption updates and deletes are prohibited. Application and worker roles have no table
access or operator grant/read access; the app receives only the constrained consumption function
and authenticated aggregate-state read. Aggregate sums use exact `numeric`, so multiple maximum
signed-bigint grants cannot overflow authorization or read state.

## Fairness state

### `rng_encryption_key_versions`

Immutable operator-provisioned registry with `version` as the primary key and a unique 32-byte `key_identity` equal to `SHA-256(raw 32-byte key material)`. A version can identify only one key and the same key material cannot be relabeled under another version. The restricted application role has `SELECT` only; inserts require the migration/operator role, and updates/deletes are trigger-prohibited. The raw key is never stored. The documented `local-dev-v1` all-zero example fingerprint is provisioned by migration; every non-local version requires an explicit deployment operation.

### `fairness_profiles`

One per user: `user_id` PK/FK, nullable canonical `current_client_seed text`, generated `current_client_seed_hash bytea`, timestamps, and optimistic `revision`. Null is permitted only for the short bootstrap interval after the backend has committed the initial encrypted server seed but before the user chooses a client seed; once non-null, the update guard prevents returning it to null. A configured value must be exactly 32 bytes represented by 64 lowercase hexadecimal characters. It is stored because the authenticated API returns it and a later opening may use the precommitted preference; a client seed is public fairness input, not equivalent to the protected server seed. Each future opening stores its exact client seed, so profile updates do not alter history. This row is also the authoritative per-user RNG-lifecycle mutex: seed and rotation writes acquire it with `SELECT ... FOR UPDATE` before seed rows and then rotation rows.

### `rng_seed_sets`

| Column                       | Type        | Rules                                          |
| ---------------------------- | ----------- | ---------------------------------------------- |
| `id`                         | uuid        | PK and part of RNG message                     |
| `user_id`                    | uuid        | FK; initial per-user scope                     |
| `commitment`                 | bytea       | unique, SHA-256 of raw seed                    |
| `server_seed_ciphertext`     | bytea       | 32-byte AES-GCM ciphertext                     |
| `encryption_iv`              | bytea       | fresh 12-byte GCM IV                           |
| `encryption_auth_tag`        | bytea       | 16-byte GCM authentication tag                 |
| `encryption_key_identity`    | bytea       | nullable legacy / 32-byte SHA-256 key identity |
| `encryption_key_version`     | text        | versioned external key reference               |
| `rng_algorithm_version`      | text        | versioned deterministic selection algorithm    |
| `revealed_server_seed`       | bytea       | nullable; set only after retirement            |
| `status`                     | text        | `active`, `retired`, `revealed`, `compromised` |
| `next_nonce`                 | bigint      | `>= 0`, allocated under row lock               |
| `max_nonce_exclusive`        | bigint      | rotation boundary                              |
| `rotate_after`               | timestamptz | age-policy boundary fixed at creation          |
| `rotated_from_seed_set_id`   | uuid        | nullable immutable predecessor                 |
| lifecycle reasons/timestamps | text/time   | retirement, reveal, and compromise evidence    |

Partial unique index `(user_id) WHERE status = 'active'`; unique `commitment`, predecessor, `(encryption_key_version, encryption_iv)`, and populated `(encryption_key_identity, encryption_iv)`; index `(status, retired_at)` for future reveal scheduling. The key identity is used only for equality, never decryption, and new rows derive it from `rng_encryption_key_versions` rather than trusting an application-supplied fingerprint. A not-yet-validated composite foreign key preserves pre-registry rows while enforcing the exact registered `(version, identity)` pair on new writes. A profile foreign key and composite predecessor key keep seed history within an initialized user. Checks enforce exact cryptographic byte lengths, nonnegative bounded nonces, allowlisted lifecycle reasons, and status/timestamp shape and ordering. Insert/update triggers require a canonical active initial row with an authoritative key identity, allow only `active -> retired -> revealed` or `active/retired -> compromised`, require nonce increments of exactly one while active, preserve retirement and cryptographic history, block deletion, reject null/active/mismatched reveals, and verify the revealed SHA-256 value against the commitment.

`rng_seed_rotations` records a user-scoped allowlisted idempotency key, a SHA-256 operation fingerprint, transition type/reason, and immutable previous/new seed-set IDs. A compromise-remediation row may temporarily have a null successor while the compromised predecessor safely leaves the user with zero active seeds; the only permitted update completes that row once. Early seed/rotation write guards serialize each user's lifecycle through the matching `fairness_profiles` row before deferred checks inspect cross-row state. Inserts wait for the profile lock; an unordered raw update that already holds its target row uses a non-waiting profile lock and fails with retryable SQLSTATE `40001` on contention, avoiding a reverse-order deadlock with application paths. Deferred constraints on both rotation and seed writes prohibit any standalone active seed while remediation is pending and verify the compromised predecessor/reason and active same-user lineage successor at commit, including different registered key identity and version after `key_compromise`. Unique constraints prevent one request or predecessor from producing multiple successors. The restricted application role may read/insert/update lifecycle rows as required but cannot delete them. PostgreSQL stores ciphertext while a seed is unrevealed and deliberately stores plaintext only after the row reaches `revealed`; active and historical master keys remain solely in the application secret source.

## Opening, wins, and fulfillment

### `idempotency_records`

`id`, `actor_user_id`, `operation` (for example `wallet.test_credit`), `idempotency_key`, `request_fingerprint bytea`, `status` (`processing`, `completed`), `http_status`, `response_body jsonb`, `resource_type`, `resource_id`, `created_at`, `completed_at`.

Unique `(actor_user_id, operation, idempotency_key)`. Keys are opaque allowlisted 8–128 character values and never logged. The fingerprint is exactly 32 SHA-256 bytes over canonical operation fields. Processing rows are transaction-local: a deferred trigger rejects commit until the row and matching posting are complete. Completed rows and replay bodies are immutable. Same key/same fingerprint returns the stored status/body; different fingerprints return `IDEMPOTENCY_KEY_REUSED`.

### `box_opens`

- identity: `id`, `public_id` unique, `user_id`, `creator_id`, `box_id`, `box_version_id`, immutable `opening_compatibility_version`, selected association/reward version, optional selected inventory pool;
- v1-only money snapshot: gross price/currency, platform fee basis points/amount, creator share, earnings availability timestamp, and unique sale/allocation ledger references;
- v1-only points snapshot: `leaderboard-v1`, base 5, bonus 0/15, total 5/20, and creator scope;
- v2 shape: every money, ledger, earnings-hold, and legacy-points column is null and exactly one scoped entitlement consumption is required;
- fairness proof: `rng_seed_set_id`, commitment, client seed, nonce, algorithm version, HMAC digest, unbiased `numeric(78,0)` selection, rejection round, and configuration hash;
- references: unique idempotency record, immutable completed status, and timestamp.

Unique `(rng_seed_set_id, nonce)` guarantees no nonce reuse. Indexes `(user_id, created_at desc, id)`, `(box_id, created_at desc, id)`, `(box_version_id)`, and `(box_version_reward_id)`. The proof columns and all references are immutable. `selection_value` is the unbiased integer in `[0,total_weight)`, not a floating-point roll. Both models require one win, one fulfillment obligation, matching inventory history, completed idempotency, and exactly the private/public outbox pair. Only v1 may have a creator earning or enter `leaderboard-v1`; v2 has neither.

### `reward_wins`, `fulfillment_obligations`, and `creator_earnings`

Every opening has exactly one immutable awarded win and one Phase 9 origin obligation. The origin
`status` remains immutable (`pending_fulfillment` or `awaiting_restock`) for historical opening
verification. Phase 12 adds immutable winner/creator/reward-version scope, typed
`fulfillment_type`, optimistic `revision`, `current_state`, update and terminal timestamps. A
trigger derives that scope from the reward win; callers cannot choose or change the winner,
creator, opening, or selected reward.

Physical state is `awaiting_address → ready_to_ship → shipped → delivered`; digital state is
`ready_for_delivery → delivered`; experience state is `coordination_required → fulfilled`.
Each may begin at `awaiting_restock` and advance only through the pool-authoritative resolution
operation. Database transition guards reject skipped/backward/cross-type transitions and require
one immutable `fulfillment_events` row with the matching prior state, new state, result revision,
actor kind, action key, command fingerprint, and safe metadata. `(fulfillment, action_key)` and
`(fulfillment, result_revision)` are unique. Address and digital-secret action fingerprints are
HMAC-derived with a domain-separated subkey; their immutable event rows snapshot the registered
fingerprint key domain/version so low-entropy delivery values are not exposed to offline hash
guessing and retries remain comparable after active-key rotation.

`fulfillment_delivery_data` stores one address or digital-secret ciphertext record per eligible
fulfillment. AES-256-GCM IV/tag sizes, encrypted/redacted shape, actor scope, and the exact
registered `(domain, version, key identity)` are constrained. `fulfillment_encryption_key_versions`
contains only immutable SHA-256 identities; raw encryption keys remain external. A private central
identity registry gives RNG/address/digital/actor-binding key material one authoritative domain.
The private actor-binding registry derives that identity from its raw HMAC verifier key, permits
exactly one active version, retains retired identities for permanent collision prevention, and
records explicit rotations immutably. Retired versions cannot verify capabilities; request-scoped
capabilities safely retry under the new active key. Narrow Phase 12 functions first verify a
short-lived operation/resource-bound actor capability whose verifier secret is inaccessible to
`creatordrop_app`, then enforce winner or creator membership scope.
Creator decrypted reads insert immutable `fulfillment_data_access_events` only as the final step
of the same transaction after authenticated decryption and payload validation succeed.
The app role can read only non-secret delivery metadata columns and cannot directly read
ciphertext or mutate delivery/history tables. Nullable `expires_at` and explicit terminal-state
redaction preserve non-sensitive history while making the protected value unreadable.

A matching creator earning continues to snapshot the creator share/currency, allocation posting,
`pending` state, and 14-day `available_at`; fulfillment does not alter financial history and no
release or payout exists yet.

## R2A entry policies, claims, and private evidence

Forward migrations `20260908052313_r2a_entry_methods_claims_private_evidence.sql`,
`20260908054241_r2a_entry_runtime_guards.sql`,
`20260908055206_r2a_evidence_operation_scope.sql`, and
`20260908060309_r2a_explicit_function_privileges.sql` add the R2A schema and runtime surface.
Forward migration `20260908132507_r2a_reviewer_claimant_separation.sql` adds the database-enforced
claimant/reviewer separation invariant:

| Relation                              | Responsibility                                                                                                          |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `app.entry_methods`                   | Stable creator/box identity, draft JSON, revision, enabled flag, current-policy pointer                                 |
| `app.entry_policy_versions`           | Immutable `entry-policy-v1` definitions, box-version binding, positive bigint quantities/limits, publisher/time         |
| `app.entry_evidence_objects`          | Generated opaque object ID and exact actor/creator/box/policy scope; MIME, byte length, immutable completion hash/time  |
| `app.entry_claims`                    | Frozen evidence and policy, pending/approved/rejected state, durable actor/key uniqueness and normalized order identity |
| `app.entry_claim_reviews`             | One immutable terminal decision, reviewer, private note/time, unique optional R1 grant link                             |
| `app.entry_audit_events`              | Append-only configuration/review/evidence-read authorization actions, without submitted evidence or notes               |
| `app_private.entry_submission_guards` | Per-user claim idempotency serialization                                                                                |
| `app_private.entry_claim_guards`      | Per-user/stable-method slot and review serialization                                                                    |

Forward migration `20260908140916_r2a_fan_entry_state.sql` adds the signed `state.own` read through
`app.entry_fan_state` and its private implementation. Both use a stable statement snapshot;
only the application wrapper is executable by `creatordrop_app`, with PUBLIC/anon/authenticated
execution explicitly revoked. It grants no table access and changes no claim/grant mutations.
Counts cover all own stable-method claims; the evidence-free summaries are limited to the latest
100 per current method. See [the API contract](./API.md#authenticated-fan-entry-state).

Composite foreign keys bind method/policy/claim lineage to the same creator and stable box.
Publication functions enforce the current compatible box version. Stable method identity cannot
change and each update increments revision. Policies, reviews, and audit records reject updates
and deletes; claims permit only pending → approved/rejected with all other fields frozen.
Review inserts reject a reviewer who is also the claim's claimant. Evidence metadata permits only
one completion. No application-role table privileges are granted.
The public-schema name is not used: callable wrappers are in `app`, implementation and signing-key
verification remain in `app_private`, with empty function search paths and explicit grants.

Entry commands require an active-actor HMAC capability generated by the authenticated API; an
arbitrary actor UUID or null/forged/expired signature cannot authorize restricted SQL access.
The existing `app_private.fulfillment_actor_binding_keys` lifecycle is reused under a distinct
entry command signing domain. Only the public-policy wrapper omits actor authentication and it
returns an allowlisted definition snapshot, never a database row or evidence.

Submission counts pending plus approved claims under the stable-method guard; rejected releases
the slot. The partial unique `(creator_id, order_reference_key)` index covers non-rejected claims,
so obvious same-reference reuse cannot race across users. Idempotency uniqueness is permanent;
matching replays use the original claim and never allocate another grant or claim slot.

Approval invokes the existing R1 `grant_opening_entitlement` primitive in the same transaction,
using `source_type = 'entry_claim'` and `source_identity = 'entry_claim:<claimId>'`. Deferred
bidirectional constraints check terminal decision, actor/creator/box, exact frozen quantity,
reviewer and grant source. Failed grants roll back the claim, review and audit. An orphan
`entry_claim` grant cannot commit. Other historical/operator grant types remain unchanged.
The global entry lock ordering is specified in [ARCHITECTURE.md](./ARCHITECTURE.md).

Supabase migration-runner privileges configure the provider-owned private `storage.buckets` row
and `storage.objects` policies, not application tables under `public`. The Storage `authenticated`
role receives only EXECUTE on a boolean RLS authorization helper, already resolved in the stored
policy expression; it receives no `app_private` schema usage, entry table reads, or command
capabilities. All R2A functions explicitly revoke PUBLIC execution: schema-scoped default
privileges cannot subtract PostgreSQL's global PUBLIC function default. Policy operation checks require
`storage.allow_only_operation` and a Storage API that sets the operation context. They fail closed
without that context. Registered uploads expire after one hour while incomplete; completed
evidence is immutable. No DELETE/UPDATE, listing or signing policy is granted. Applying these
migrations requires Supabase Storage schema support, not a bare PostgreSQL-only deployment.

R2B migration `20260908145157_r2b_creator_claim_history.sql` adds only the signed
`app.entry_review_list` wrapper and its private implementation. It reuses active creator
owner/manager authorization and the existing claim DTO for status-filtered, creator-scoped
cursor pages. Only the restricted application role receives wrapper execution. It adds no
tables, claim/review mutations, grants, storage policies or lock-order changes. The older pending
list remains available for API compatibility.

## Wallet and double-entry ledger

### `wallets`

`id`, `user_id`, `currency char(3)`, `ledger_account_id` unique FK, `available_balance_minor bigint CHECK (available_balance_minor >= 0)`, `revision bigint`, timestamps. Unique `(user_id, currency)`. A composite FK proves that the linked account is the matching user's `user_wallet` account in the same currency. Inserts begin at zero/revision one; revisions advance by exactly one with each non-zero balance movement. The application role locks rows and updates balances only through narrow explicitly granted functions. Balance is a transactionally maintained projection, not a substitute for the ledger.

### `ledger_accounts`

`id`, `account_type`, nullable `owner_user_id`/`owner_creator_id`, `currency char(3)`, status, timestamps. In addition to Phase 8 `user_wallet` and `system_test_funding`, Phase 9 adds per-currency `box_sales_clearing` and `platform_fee` accounts plus one `creator_pending_earnings` account per creator/currency. Phase 11 adds one `provider_funding_clearing` per currency and one `user_funding_deficit` per user/currency. Owner-shape checks and partial unique indexes enforce those scopes. Accounts are immutable.

### `ledger_transactions`

Immutable header: `id`, `kind` (`test_credit_grant`, `wallet_credit`, `wallet_debit`, `reversal`, `box_open_sale`, `box_open_allocation`, `provider_funding_credit`, `provider_funding_refund`, `provider_funding_dispute`), actor/currency/business reference, optional unique idempotency/reversal references, status, description, and timestamps.

Unique `(business_reference_type, business_reference_id)` is the final duplicate-posting defense. A header exists as `pending` only inside its caller-owned transaction, transitions once to `posted`, and cannot commit pending. Posted rows are never updated/deleted. Deferred checks enforce both directions of the Phase 9 relationship: every opening references exactly one sale and allocation posting, and every `box_open_sale`/`box_open_allocation` posting references exactly one matching opening. Those two opening legs cannot be reversed independently until a future atomic refund/compensation design exists. Other permitted reversals are new unique transactions linked to their original, and PostgreSQL verifies that their account/amount set is the exact opposite.

### `ledger_entries`

`id`, `ledger_transaction_id`, `ledger_account_id`, `amount_minor bigint CHECK (amount_minor <> 0)`, `currency char(3)`, `sequence smallint`, `created_at`; unique `(ledger_transaction_id, sequence)` and `(ledger_transaction_id, ledger_account_id)`. Index `(ledger_account_id, created_at, id)`.

Use one sign convention: positive increases the account's balance, negative decreases it. Every committed transaction has at least two non-zero entries and sums to zero using `numeric` during validation so the check itself cannot overflow. Deferred triggers verify balance, same-currency header/entry/account agreement, movement shape, test-credit idempotency, and exact reversals at commit. Separate deferred reconciliation triggers require each wallet projection to equal the sum of all entries for its account. Direct wallet updates and ledger/idempotency history mutation are revoked from the application role; narrow security-definer functions lock/update/finalize while the caller still owns the surrounding transaction.

The tables and API are multi-currency capable. Phase 8 application policy enables only USD synthetic credits, creates no exchange-rate/conversion records, and never nets balances across currencies.

Phase 9 box open in USD:

```text
sale:       user wallet             -1000
            box-sales clearing      +1000
allocation: box-sales clearing      -1000
            creator pending earning  +800
            platform fee             +200
```

### Payment tables

### `funding_intents`

Provider-independent local commands: internal/public IDs, user/wallet, provider, unique Stripe PaymentIntent ID, actor-scoped client idempotency key/fingerprint, requested integer amount/currency, monotonic status, last provider-event time, and timestamps. Phase 11 enforces USD and 500–50000 minor units. The wallet/user/currency composite scope is checked at insert; provider identity may bind once and history cannot be rewritten. `reconciliation_required` may intentionally retain a null binding when a verified mismatching event arrived before binding; its immutable provider-event row retains the external object identity without treating it as a valid payment binding.

### `provider_events`

One row per unique `(provider, provider_event_id)`: exact event/object identity, linked funding intent when known, SHA-256 of the verified raw payload, provider/receipt/signature timestamps, processing/retryable/processed state, bounded attempt history, and allowlisted result code. Raw Stripe payload/card data is not retained. Signature verification occurs before insert. Retryable reordered events may return to processing with exactly one attempt increment; completed event identity/content is immutable.

### `funding_settlements`, `funding_adjustments`, and `funding_deficits`

`funding_settlements` is an immutable one-to-one link from local intent and Stripe PaymentIntent to the exact processed success event and one balanced `provider_funding_credit` ledger transaction. Deferred checks enforce the relationship in both directions and validate actor, amount, currency, business reference, wallet entry, and provider-clearing entry.

`funding_adjustments` records one unique Stripe refund/dispute object and its controlled `provider_funding_refund`/`provider_funding_dispute` posting. The original credit is never reversed or edited. The posting credits provider clearing and recovers at most the currently spendable wallet balance through a function scoped to the exact pending provider-adjustment header, business reference, wallet entry, actor, and currency; an ordinary debit cannot invoke that exemption. Any remainder posts to the user's distinct deficit ledger account. Cumulative adjustments cannot exceed the settlement, and aggregate state is derived from their immutable total independently of delivery order. Provider funding postings cannot use the generic reversal primitive.

`funding_deficits` immutably records the unrecovered user/currency shortfall and originating adjustment. Bidirectional deferred checks require exactly one matching deficit when the adjustment has an unrecovered amount and none otherwise; user, currency, amount, account, ledger entry, settlement, and intent lineage must all match. Phase 11 creates only `unresolved` rows; resolution/collections commands remain deferred and require new auditable history. Wallet balance remains nonnegative, and the payment lock order `wallet → funding_intent → provider_event → ledger/history inserts` serializes provider adjustments against spending without conflicting with opening's wallet-first order. An unresolved deficit blocks new funding plus ordinary debits/openings.

## Leaderboard authority and projections

### `leaderboard_seasons`

Authoritative UUID/ordinal/name plus explicit UTC `starts_at`/`ends_at`, lifecycle status, creation,
and finalization timestamps. Boundaries are non-overlapping half-open ranges and a partial unique
index permits at most one active season. Windows are operator-provisioned (normally about three
months), not inferred from worker time. Boundaries/history are immutable after activation and a
finalized season cannot reopen.

### `leaderboard_season_results` and `user_achievements`

Finalization locks one ended active season, derives points/count/base-win/reach-time aggregates
from immutable `box_opens`, and inserts at most one global winner plus one winner for each creator
with qualifying openings. Winner order is points descending, reach time ascending, then stable
user UUID. Deferred checks require every finalized scope to have exactly one matching permanent
achievement and prohibit fabricated/duplicate results. Both tables are immutable; the application
role cannot write them. Public display resolves the winner's explicit `users.username`; email,
legal name, and other private fields are never username sources.

Every season-bound opening first acquires the matching `leaderboard_seasons` row in shared mode;
finalization takes that same row `FOR UPDATE`. This serializes the finalization boundary in both
commit orderings. A database trigger applies the barrier to every `box_opens` insert, while the
opening service acquires it before wallet, nonce, and RNG work so a finalized season fails early.

### `leaderboard_projection_events`

One independent delivery row per committed `opening.completed.v1` outbox UUID. Mutable claim state
uses pending/processing/applied/dead, attempt/backoff, worker, token, and lease fields while the
outbox/opening remain immutable authority. Worker-only functions claim with `SKIP LOCKED`, read an
absolute PostgreSQL snapshot, and complete/fail only the matching active claim token. Redis is not
a database invariant and these rows do not participate in opening, wallet, RNG, inventory,
fulfillment, or payment transactions. An expired lease at the configured final attempt is moved
to retained `dead` state by the next claim operation; attempts below the limit remain reclaimable.
The application role has no direct CRUD privilege on the season, result, achievement, or
projection-delivery tables.

`app_private.leaderboard_authoritative_rows` is the common PostgreSQL aggregate used for rebuild,
drift reconciliation, public fallback reads, and champion validation. It sums the snapshotted
`points_awarded` and counts `bonus_points > 0`; it never recalculates the 5/20 policy from current
configuration. Redis keys contain no financial, RNG, fulfillment, or payment state.

## Reliable events and auditing

### `event_outbox`

Phase 9 stores immutable `id`, opening aggregate identity, allowlisted type/audience, JSON
payload, and occurrence/creation timestamps. Every successful opening has private
`opening.completed.v1` and sanitized public `drop.created.v1` rows in the same transaction;
rollback removes both. Payload checks prohibit seed/encryption fields.

Phase 10 adds mutable delivery metadata only: `status`, `attempt_count`, `available_at`,
claim/lease/token fields, `processed_at`, and an allowlisted `last_error_code`. Event identity,
aggregate, type, audience, payload, and occurrence timestamps remain immutable. New rows must
start `pending`; the application role can insert but cannot claim or update delivery state. The
separate `creatordrop_worker` role has no table-write grant and can execute only the
`claim_outbox_events`, `complete_outbox_event`, `fail_outbox_event`, and `read_outbox_lag`
interfaces.

Claims are committed short statements using ordered `FOR UPDATE SKIP LOCKED`. A fresh UUID
claim token prevents a worker whose lease was replaced from completing/failing the new claim.
Expired leases are reclaimable; an expired final attempt becomes retained `dead` history.
Delivery success is recorded only after the Socket.io gateway acknowledgement. Retry scheduling
uses `available_at`; no external network call occurs while a row lock or database transaction is
held. The lag function reports pending/processing/dead counts and the age of the oldest ready or
expired event without exposing event payloads.

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
9. Every newly published `opening-v1` version has exactly one explicit base reward; grandfathered null-marker versions stay valid history but cannot be opened.
10. Every successful opening has matching balanced sale/allocation postings, one win/obligation/creator earning, one completed idempotency record, and both required outbox events at commit; every opening-kind posting links back to exactly one opening and cannot be reversed independently.
11. Every in-stock finite opening has exactly one immutable one-unit consumption linked to its stable creator-owned pool, and each pool reconciles initial minus available quantity to those movements. Unlimited and zero-stock backorder openings have none.
12. Finalized seasons have complete immutable PostgreSQL-derived global/creator results and exactly matching permanent champion achievements; application-role writes cannot forge either.

Cross-row rules require deferred constraint triggers or narrowly permissioned database functions plus integration tests. Application checks alone are insufficient.

## Transaction isolation and lock policy

Use `READ COMMITTED` plus explicit `SELECT ... FOR UPDATE`/conditional updates for opening and payment posting. Keep transactions free of HTTP, Redis, Socket.io, and file operations. Maintain the global lock order documented in `ARCHITECTURE.md`; within fairness lifecycle work it is the per-user `fairness_profiles` row, relevant seed-set rows, then a rotation row. Publication locks all finite `pause_box` pools in UUID order before the box row. Opening transaction retries are bounded to failures known to occur before nonce/RNG selection; a deadlock or serialization failure after that boundary rolls back and is returned as retryable without rerunning RNG. Use advisory locks only for singleton maintenance jobs, not wallet correctness.

## Retention and deletion

Idempotency response bodies may expire after a policy-defined window (recommended minimum 24 hours, longer than all client retry windows), but opening and ledger uniqueness references persist. Seed ciphertext/reveals, opening proofs, configuration versions, ledger, provider event identifiers, and audit records follow financial/legal retention. Account deletion pseudonymizes public/profile data while retaining minimally required financial/fairness records. Exact periods require legal approval.
