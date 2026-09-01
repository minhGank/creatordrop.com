# HTTP and Realtime API Design

## Conventions

- Base path: `/v1`. JSON over HTTPS only. OpenAPI is the contract source; shared TypeScript types are generated from or checked against runtime schemas, never trusted without validation.
- Access tokens use `Authorization: Bearer <token>`. The API derives the actor from the verified token.
- Public resource IDs are opaque. UUIDs are shown below as an implementation detail and must not be treated as authorization.
- Monetary minor units and probability weights are decimal strings in JSON (`"1000"`), with an uppercase ISO 4217 currency.
- Timestamps are RFC 3339 UTC. List endpoints use opaque cursor pagination with stable `(created_at, id)` ordering.
- Mutating creation/command endpoints reject unknown fields. Creator edits require `If-Match`/revision to prevent lost updates.
- Every response carries `X-Request-Id`; clients may supply a valid `X-Request-Id`, but the server sanitizes it.
- `POST` commands that can cause a financial operation require `Idempotency-Key`. A key is scoped to actor and operation. Same key/same fingerprint replays the original status/body; same key/different fingerprint returns `409`.
- Do not return active server seeds, wallet internals, ledger account IDs, encrypted data, provider payloads, or stack traces.

Success uses the resource/command response directly. Errors use:

```json
{
  "error": {
    "code": "INSUFFICIENT_BALANCE",
    "message": "The wallet has insufficient settled funds.",
    "requestId": "opaque",
    "details": {}
  }
}
```

Stable codes, not messages, drive clients. Expected statuses include `400` validation, `401` unauthenticated, `403` unauthorized, `404` absent or deliberately concealed cross-tenant resource, `409` state/idempotency conflict, `422` policy failure, `429` rate limit, and `503` transient dependency/unavailable operation.

## Authentication

Authentication ceremony is initially provided by Supabase Auth; password/OAuth tokens do not transit custom endpoints unless a future requirement changes that. The application API exposes:

| Method   | Path                        | Purpose                                                                                |
| -------- | --------------------------- | -------------------------------------------------------------------------------------- |
| `POST`   | `/v1/auth/session/exchange` | Optional exchange/bootstrap after provider sign-in; create/map local user idempotently |
| `GET`    | `/v1/auth/session`          | Return current local actor, roles/scopes, and creator memberships                      |
| `DELETE` | `/v1/auth/session`          | Revoke/close the relevant session where provider support permits                       |

Sensitive identity operations such as MFA and password reset remain provider-hosted. CSRF protection is required if credentials ever move to cookies; the initial API uses bearer tokens and strict CORS.

Phase 3 implements only `POST /v1/auth/session/exchange`; the `GET` and `DELETE` session operations remain contract direction for later phases. The exchange accepts an empty JSON object (or no body), rejects unknown fields, verifies the bearer JWT signature and `iss`/`aud`/`exp`/`nbf`/`sub` claims against trusted configuration and JWKS, and idempotently maps the verified subject to a local user. It returns only the allowlisted local user identity:

```json
{
  "user": {
    "id": "uuid-v7",
    "username": "user_bootstrap-name",
    "status": "active"
  }
}
```

Missing, malformed, unverifiable, expired, or claim-invalid tokens return `401 AUTHENTICATION_REQUIRED`. A valid provider token mapped to a suspended or closed local user returns `403 ACCOUNT_NOT_ACTIVE`. The response and logs do not disclose token verification or account-state internals.

Every request receives `X-Request-Id`. A caller value is retained only when it matches the strict 8–64 character request-ID format; otherwise the API generates a cryptographically random UUID. API request/error logs use allowlisted metadata and redact credential-like and RNG-secret attribute names. Fairness mutations use a generous per-process pre-authentication IP limiter followed by a per-process actor-keyed limiter; public seed-history reads have a separate generous IP limit. Production horizontal scaling will require a shared limiter store and an explicitly configured trusted-proxy policy.

## Users and fairness preferences

| Method  | Path                          | Auth               | Purpose                                                                  |
| ------- | ----------------------------- | ------------------ | ------------------------------------------------------------------------ |
| `GET`   | `/v1/me`                      | user               | Own profile                                                              |
| `PATCH` | `/v1/me`                      | user               | Update allowlisted profile fields                                        |
| `GET`   | `/v1/me/openings`             | user               | Paginated private opening history                                        |
| `GET`   | `/v1/me/rewards`              | user               | Reward wins and fulfillment summaries                                    |
| `GET`   | `/v1/me/fairness`             | user               | Active seed-set ID/commitment, client seed, nonce count, rotation policy |
| `POST`  | `/v1/me/fairness`             | user               | Initialize client seed and encrypted active server-seed commitment       |
| `PUT`   | `/v1/me/fairness/client-seed` | user               | Set future client seed with revision check                               |
| `POST`  | `/v1/me/fairness/rotate`      | user + idempotency | Retire old seed and establish a newly committed active seed              |

Initialization requires an explicit canonical 64-character lowercase-hex client seed; the server does not silently choose one. Repeating initialization with the same seed is safe, while a different seed returns `409 FAIRNESS_ALREADY_INITIALIZED`. Current-state and client-seed responses carry an `ETag`; client-seed updates require the quoted current revision in `If-Match`. Changing a client seed never mutates existing lifecycle history or historical opening proofs.

Rotation requires an 8–128 character allowlisted `Idempotency-Key` and an empty body/query. It locks the user's fairness/active-seed state, retires the old row, activates a fresh commitment at nonce `0`, and records the operation type/reason fingerprint and old/new relationship atomically. Same-key/same-intent retries replay; reuse for a different transition conflicts. Phase 7 exposes the authenticated lifecycle service primitive for eligible retirement reveal; automatic scheduling remains deferred. Active ciphertext, IV, authentication tag, key material, and raw server seed are never response fields.

## Creators

Phase 4 implements this private workspace surface:

| Method   | Path                                      | Auth          | Purpose                                                  |
| -------- | ----------------------------------------- | ------------- | -------------------------------------------------------- |
| `GET`    | `/v1/me/creator-memberships`              | active user   | List the actor's workspaces and role in each             |
| `POST`   | `/v1/creators`                            | active user   | Atomically create a workspace and actor owner membership |
| `GET`    | `/v1/creators/:creatorId`                 | member        | Get a private creator workspace                          |
| `PATCH`  | `/v1/creators/:creatorId`                 | owner/manager | Update `displayName` with a revision precondition        |
| `GET`    | `/v1/creators/:creatorId/members`         | member        | List direct members                                      |
| `POST`   | `/v1/creators/:creatorId/members`         | owner         | Add an existing active local user directly               |
| `PATCH`  | `/v1/creators/:creatorId/members/:userId` | owner         | Change a member role                                     |
| `DELETE` | `/v1/creators/:creatorId/members/:userId` | owner         | Remove a member; cannot remove the final active owner    |

Creation accepts exactly `handle`, `customSlug`, and `displayName`; ownership always comes from the authenticated local actor. Handles use 3–32 lowercase letters, digits, or underscores. Custom slugs use 3–63 lowercase letters, digits, or hyphens. Both identities are case-insensitively unique.

Creator updates accept only `displayName` and require a quoted positive revision such as `If-Match: "1"`. A successful response returns the new revision in both the resource and `ETag`; a stale update returns `409 CREATOR_REVISION_CONFLICT` with `details.currentRevision`, while a missing precondition returns `428 PRECONDITION_REQUIRED`.

The centralized Phase 4 role policy is:

| Action                 | owner | manager | editor | viewer |
| ---------------------- | :---: | :-----: | :----: | :----: |
| View workspace         |  yes  |   yes   |  yes   |  yes   |
| List members           |  yes  |   yes   |  yes   |  yes   |
| Update normal settings |  yes  |   yes   |   no   |   no   |
| Write future drafts    |  yes  |   yes   |  yes   |   no   |
| Publish future content |  yes  |   yes   |   no   |   no   |
| Manage memberships     |  yes  |   no    |   no   |   no   |
| Manage ownership       |  yes  |   no    |   no   |   no   |

Authentication first resolves an active local user. Every private creator operation then scopes repository access by `creatorId`, actor user ID, and—on mutations—the allowed roles. A nonmember or different-creator member receives a concealed `404`; a same-creator member with an insufficient role receives `403`. Creator IDs are never authority by themselves.

Membership bodies contain a local `userId` and an allowlisted role. The target must already be an active CreatorDrop user. This is intentionally direct membership management for local/API workflows; invitations, email delivery, and acceptance state are deferred. Successful creator creation and membership changes emit allowlisted `creator.audit` structured logs with IDs, action, roles/revision, and request ID only. A durable production audit subsystem remains a later concern.

The future public creator profile by slug is not implemented in Phase 4; it belongs with the public catalog work after private tenancy is established.

## Public boxes and rewards

Phase 5 implements only immutable box reads, not discovery or a marketplace:

| Method | Path                                   | Purpose                                                                                  |
| ------ | -------------------------------------- | ---------------------------------------------------------------------------------------- |
| `GET`  | `/v1/boxes/:boxId`                     | Current active published box, exact ordered entries, reward snapshots, and manifest/hash |
| `GET`  | `/v1/boxes/:boxId/versions/:versionId` | A specific immutable published version belonging to that box                             |

`GET /v1/boxes`, public creator listings, and standalone public reward reads remain future catalog work. Cache headers/ETags may be added later for immutable versions. Eligibility, price, and availability returned by reads remain advisory until an opening transaction validates them again.

Public responses contain the published version snapshot, its ordered reward-version snapshots, the canonical manifest, and a lowercase hexadecimal SHA-256 `configurationHash`. Price, quantity, weight, and total fields are decimal strings. No floating-point odds are returned or accepted.

## Creator box/reward management

Phase 5 implements:

| Method  | Path                                                 | Auth     | Purpose                                           |
| ------- | ---------------------------------------------------- | -------- | ------------------------------------------------- |
| `GET`   | `/v1/creators/:creatorId/boxes`                      | viewer+  | List creator-scoped boxes and current drafts      |
| `POST`  | `/v1/creators/:creatorId/boxes`                      | editor+  | Create stable identity and version 1 draft        |
| `GET`   | `/v1/creators/:creatorId/boxes/:boxId`               | viewer+  | Get creator-scoped box/current draft              |
| `PATCH` | `/v1/creators/:creatorId/boxes/:boxId/draft`         | editor+  | Edit or lazily create the next box draft          |
| `GET`   | `/v1/creators/:creatorId/boxes/:boxId/draft/rewards` | viewer+  | Read ordered draft configuration                  |
| `PUT`   | `/v1/creators/:creatorId/boxes/:boxId/draft/rewards` | editor+  | Atomically replace ordered weighted draft entries |
| `GET`   | `/v1/creators/:creatorId/boxes/:boxId/versions`      | viewer+  | List box-version history                          |
| `POST`  | `/v1/creators/:creatorId/boxes/:boxId/publish`       | manager+ | Validate and atomically publish the current draft |
| `POST`  | `/v1/creators/:creatorId/boxes/:boxId/archive`       | manager+ | Archive the stable box identity                   |
| `GET`   | `/v1/creators/:creatorId/rewards`                    | viewer+  | List creator-scoped rewards and current drafts    |
| `POST`  | `/v1/creators/:creatorId/rewards`                    | editor+  | Create stable identity and version 1 draft        |
| `GET`   | `/v1/creators/:creatorId/rewards/:rewardId`          | viewer+  | Get creator-scoped reward/current draft           |
| `PATCH` | `/v1/creators/:creatorId/rewards/:rewardId/draft`    | editor+  | Edit or lazily create the next reward draft       |
| `GET`   | `/v1/creators/:creatorId/rewards/:rewardId/versions` | viewer+  | List reward-version history                       |
| `POST`  | `/v1/creators/:creatorId/rewards/:rewardId/archive`  | manager+ | Archive the stable reward identity                |

All Phase 5 draft configuration, publication, and archive commands require a quoted positive revision in `If-Match`; missing preconditions return `428 PRECONDITION_REQUIRED`, and stale revisions return `409 CATALOG_REVISION_CONFLICT`. Creation derives ownership from the authenticated creator membership and accepts no creator ID in the body. The API rejects unknown fields and accepts monetary amounts, inventory quantities, and weights only as canonical decimal strings within signed 64-bit storage.

`PUT .../draft/rewards` accepts `{ "entries": [{ "rewardVersionId": "uuid", "weight": "5", "isBaseReward": true }] }`. Array order is the canonical position. An empty array and zero/multiple base designations are valid intermediate drafts, but every new publication rejects them unless exactly one entry is explicitly designated. A version may occur only once and every referenced reward must belong to the authenticated creator. Saving this configuration marks the draft `opening-v1`; grandfathered published versions retain a null compatibility marker and no inferred base reward.

The publish response returns the immutable version, reward snapshots, exact ordered weights, calculated `totalWeight`, canonical manifest, and `configurationHash`. The server calculates totals/hashes; client totals are never authoritative. Publication failures use stable codes including `CATALOG_PUBLICATION_EMPTY_CONFIGURATION`, `CATALOG_PUBLICATION_BASE_REWARD_INVALID`, `CATALOG_PUBLICATION_INELIGIBLE_REWARD`, `CATALOG_PUBLICATION_INVALID_INVENTORY`, and `CATALOG_PUBLICATION_WEIGHT_OVERFLOW`. Pause behavior and durable command idempotency are not introduced in Phase 5; optimistic revision and row locking serialize publication against edits.

The shared creator policy—not controllers—allows owner/manager/editor draft writes, owner/manager publication and archival actions, and viewer reads. Same-creator insufficient roles receive `403`; nonmembers, cross-creator actors, or mismatched resources receive concealed `404`. Catalog mutations emit allowlisted `catalog.audit` records for creation, publication, and archival without tokens, headers, secrets, or profile data.

## Box opening

### `POST /v1/boxes/:boxId/open`

Requires user authentication and `Idempotency-Key`. Request:

```json
{
  "clientSeed": "64-lowercase-hex-characters"
}
```

The seed must match the chosen/current seed policy. There is intentionally no price, currency, weight, probability, balance, reward, nonce, or server commitment field in the request.

Successful `201` (or replayed original response):

```json
{
  "opening": {
    "id": "public-opening-id",
    "boxId": "uuid",
    "boxVersionId": "uuid",
    "cost": { "priceMinor": "1000", "currency": "USD" },
    "reward": {
      "id": "uuid",
      "rewardVersionId": "uuid",
      "name": "Signed poster",
      "imageUrl": "https://..."
    },
    "fairness": {
      "seedSetId": "uuid",
      "commitment": "64-hex",
      "clientSeed": "64-hex",
      "nonce": "7",
      "configurationHash": "64-hex"
    },
    "fulfillmentStatus": "pending_fulfillment",
    "pointsAwarded": 20,
    "wallet": {
      "id": "uuid",
      "balanceMinor": "2400",
      "currency": "USD",
      "revision": "18"
    }
  }
}
```

The server has already decided and committed the reward when this response is generated. The frontend reel must land on that reward. Grandfathered versions without `opening-v1` and exactly one base designation return `BOX_NOT_OPENABLE`. Other stable errors include `CLIENT_SEED_MISMATCH`, `INVENTORY_UNAVAILABLE`, `INSUFFICIENT_BALANCE`, `OPENING_CURRENCY_NOT_ENABLED`, `SEED_ROTATION_REQUIRED`, `OPENING_RETRY_REQUIRED`, and `IDEMPOTENCY_KEY_REUSED`. `OPENING_RETRY_REQUIRED` means PostgreSQL aborted the transaction after RNG may have run; all state rolled back and the client may retry with the same idempotency key.

Opening-receipt reads and private fulfillment-list endpoints remain deferred. Phase 9 adds only the authenticated opening command; it does not add public wallet, fulfillment, or delivery-data reads.

## Fairness verification

Phase 7 implements the public seed-set lifecycle route below. Opening proof and machine-readable algorithm routes remain future HTTP contract direction. No route accepts a server seed through the production API.

| Method | Path                                               | Auth   | Purpose                                                           |
| ------ | -------------------------------------------------- | ------ | ----------------------------------------------------------------- |
| `GET`  | `/v1/fairness/openings/:publicOpeningId`           | public | Proof inputs, manifest, computed fields, and reveal state         |
| `GET`  | `/v1/fairness/seed-sets/:seedSetId`                | public | Commitment, lifecycle dates, reveal if retired, algorithm version |
| `GET`  | `/v1/fairness/algorithms/hmac-sha256-rejection-v1` | public | Versioned machine-readable specification/test-vector link         |

`GET /v1/fairness/seed-sets/:seedSetId` returns only the commitment, algorithm, nonce/rotation metadata, lifecycle timestamps/status, and `revealedServerSeed`. That field is a lowercase seed only for `revealed` status and is `null` for active, retired, or compromised state; encryption metadata is never returned. If an opening's seed is active, the future proof endpoint returns `verificationStatus: "pending_reveal"` and omits `serverSeed`. Old algorithms and manifests remain accessible for the full required retention period.

## Wallet, funding, and ledger receipts

Phase 8 implements only:

| Method | Path                                    | Auth               | Purpose                                                     |
| ------ | --------------------------------------- | ------------------ | ----------------------------------------------------------- |
| `GET`  | `/v1/me/wallets`                        | active user        | Actor-owned settled wallet projections, ordered by currency |
| `POST` | `/v1/me/wallets/:currency/test-credits` | user + idempotency | Synthetic credit grant; route absent in production          |
| `POST` | `/v1/me/wallets/USD/funding-intents`    | user + idempotency | Create local + Stripe test-mode funding intent              |
| `POST` | `/v1/webhooks/stripe`                   | Stripe signature   | Exact-raw-body authoritative provider event ingestion       |

`GET` returns `{ "wallets": [{ "id", "currency", "balanceMinor", "revision" }] }`. Decimal strings preserve bigint precision. It never creates wallets and never exposes the linked ledger account, system accounts, entries, or idempotency metadata.

The test-credit command accepts exactly `{ "amountMinor": "2000" }` plus an 8–128 character `Idempotency-Key`. Only `USD` is enabled in Phase 8. The deterministic fingerprint covers its version, operation, actor, currency, and canonical amount. Same-key/same-request replay returns the original `201` body; material reuse returns `409 IDEMPOTENCY_KEY_REUSED`. `WALLET_CURRENCY_NOT_ENABLED`, `WALLET_AMOUNT_OVERFLOW`, and validation errors fail without a committed claim or movement. Both route registration and the service require the explicit `WALLET_TEST_CREDITS_ENABLED=true` opt-in, and configuration rejects that opt-in in production.

Funding-intent input is exactly `{ "amountMinor": "2000" }`; 500 and 50000 are the inclusive USD limits. The response is `{ "fundingIntent": { "fundingIntentId", "amountMinor", "currency": "USD", "clientSecret" } }`. User/wallet/provider/settlement identity comes from the actor and server. No provider object, ledger account, event, payment-method, or secret-key field is exposed. The same actor/idempotency key replays one local/Stripe intent; conflicting input returns `IDEMPOTENCY_KEY_REUSED`.

`POST /v1/webhooks/stripe` is mounted before JSON parsing and accepts `application/json` bytes plus `Stripe-Signature`. Invalid signatures return `STRIPE_SIGNATURE_INVALID` and create no trusted database state. Browser redirect/client success cannot credit a wallet. A verified, matched `payment_intent.succeeded` event atomically records the provider event, balanced wallet credit, and settlement. Duplicate/different events for the same payment cannot create another settlement; a distinct success after refund/dispute is retained as a harmless audited duplicate without changing the terminal state. A verified refund/dispute delivered before settlement returns `STRIPE_EVENT_RETRY_REQUIRED`. Amount/currency/linkage mismatches are retained for reconciliation without credit even when the local intent was not successfully bound; the provider event preserves the external object identity while the local intent remains explicitly reconciliation-required.

Funding is absent unless `STRIPE_FUNDING_ENABLED=true` with an explicit development/test runtime, a Stripe test API key, and webhook secret. It is unavailable in production. `ACCOUNT_FUNDING_RESTRICTED` blocks funding and spending while an unresolved provider shortfall exists. Reconciliation is an internal read-only service operation, not a public repair endpoint.

There is no self-service refund, wallet withdrawal, creator payout, production charge, currency conversion, generic balance setter, or public adjustment endpoint. Stripe-driven refunds/disputes preserve original funding/opening history and use unique compensating postings. Any unrecoverable amount becomes a separate immutable unresolved deficit; spendable wallet balance never becomes negative.

## Fulfillment

All fulfillment routes require an active authenticated user. Lists and ordinary detail responses
contain the reward display snapshot, creator/opening IDs, typed state, revision/timestamps,
non-sensitive delivery availability, and immutable transition history. They never contain wallet,
payment, RNG, ciphertext/key metadata, another user's identity, or raw delivery data.

| Method | Path                                                                                 | Authorization              | Purpose                                              |
| ------ | ------------------------------------------------------------------------------------ | -------------------------- | ---------------------------------------------------- |
| `GET`  | `/v1/me/fulfillments`                                                                | winning user               | List own fulfillment records                         |
| `GET`  | `/v1/me/fulfillments/:fulfillmentId`                                                 | winning user               | Read own state/history                               |
| `GET`  | `/v1/me/fulfillments/:fulfillmentId/delivery-data`                                   | winning user               | Read own unexpired protected address/entitlement     |
| `POST` | `/v1/me/fulfillments/:fulfillmentId/address`                                         | winning user + action key  | Encrypt/update address while eligible                |
| `POST` | `/v1/me/fulfillments/:fulfillmentId/delivery-data/redact`                            | winning user + action key  | Explicitly redact terminal delivery data             |
| `GET`  | `/v1/creators/:creatorId/dashboard/fulfillments`                                     | viewer+                    | Creator-scoped non-sensitive queue                   |
| `GET`  | `/v1/creators/:creatorId/dashboard/fulfillments/:fulfillmentId`                      | viewer+                    | Creator-scoped non-sensitive detail/history          |
| `POST` | `/v1/creators/:creatorId/dashboard/fulfillments/:fulfillmentId/actions`              | owner/manager + action key | Typed backorder/shipping/digital/experience action   |
| `POST` | `/v1/creators/:creatorId/dashboard/fulfillments/:fulfillmentId/delivery-data/access` | owner/manager              | Audited minimum-necessary decrypt with exact purpose |
| `POST` | `/v1/creators/:creatorId/dashboard/fulfillments/:fulfillmentId/delivery-data/redact` | owner/manager + action key | Explicit terminal redaction                          |
| `POST` | `/v1/creators/:creatorId/dashboard/inventory-pools/:poolId/restocks`                 | owner/manager + action key | Append manual positive restock event                 |

Mutation commands require `Idempotency-Key`; fulfillment transitions/redaction/address updates
also require `If-Match`. The only creator action bodies are `resolve_backorder`, `mark_shipped`,
`mark_delivered`, `fulfill_experience`, or `deliver_digital` with its secret. Restock accepts only
`{ "quantity": "<positive canonical bigint>" }`. Same key/same semantic command replays without a
second history row; conflicting reuse returns `IDEMPOTENCY_KEY_REUSED`. Stable failures include
`FULFILLMENT_NOT_FOUND`, `FULFILLMENT_FORBIDDEN`, `FULFILLMENT_REVISION_CONFLICT`,
`FULFILLMENT_TRANSITION_INVALID`, `FULFILLMENT_DATA_UNAVAILABLE`,
`FULFILLMENT_KEY_UNAVAILABLE`, and `INVENTORY_RESTOCK_INVALID`.

Address input is exactly recipient name, address lines, city, region, postal code, and ISO alpha-2
country; phone is not collected. Creator owner/manager delivery-data access requires
`{ "purpose": "fulfillment_execution" }` and creates an immutable audit event only after a valid
payload is decrypted and returned. Route UUIDs are canonicalized before cryptographic or
idempotency use, so equivalent UUID casing cannot alter AAD or command identity. Editor/viewer
roles cannot decrypt. Restock accepts only a published/shared pool and changes only its availability
and history; it does not resolve an
obligation or resume a box automatically.

## Creator dashboard

| Method | Path                                                         | Auth                         | Purpose                                                              |
| ------ | ------------------------------------------------------------ | ---------------------------- | -------------------------------------------------------------------- |
| `GET`  | `/v1/creators/:creatorId/dashboard/summary`                  | viewer+                      | PostgreSQL-derived/cached aggregate summary with freshness timestamp |
| `GET`  | `/v1/creators/:creatorId/dashboard/openings`                 | viewer+                      | Paginated scoped openings without private fan data                   |
| `GET`  | `/v1/creators/:creatorId/dashboard/rewards`                  | viewer+                      | Reward win/fulfillment aggregate                                     |
| `GET`  | `/v1/creators/:creatorId/dashboard/leaderboard`              | viewer+                      | Redis projection plus `asOf`; fallback/rebuild semantics explicit    |
| `GET`  | `/v1/creators/:creatorId/dashboard/fulfillments`             | permitted role               | Scoped fulfillment queue                                             |
| `POST` | `/v1/creators/:creatorId/dashboard/fulfillments/:id/actions` | permitted role + idempotency | Typed transition, never arbitrary status overwrite                   |

Metrics must define timezone, currency, settled/voided behavior, and freshness. Never sum different currencies into one monetary total without an approved conversion model.

## Realtime contract

Socket.io authenticates at connection with the same verified access-token and active-local-user
rules as HTTP. The server derives and joins `user:{userId}`; a client cannot request another
user's room. Authenticated clients may make only validated, read-only `drops.subscribe.v1` /
`drops.unsubscribe.v1` requests for `{ "scope": "global" }` or
`{ "scope": "creator", "creatorId": "<canonical UUID>" }`. Initial Phase 10 server events:

- `drop.created.v1`: sanitized committed public opening for creator/global rooms;
- `opening.completed.v1`: private result notification, deduplicated by `eventId`/`openingId`;
- `realtime.ready.v1`: connection control event with `delivery: "at-least-once"` and
  `refetchRequired: true` on every connect/reconnect.

Every event has `{ eventId, type, version, occurredAt, data }`. Durable events retain the
PostgreSQL outbox UUID as `eventId` across retries. `opening.completed.v1` is sent only to the
event user's room and contains public opening/catalog identifiers, not its routing `userId`.
`drop.created.v1` contains only public opening, creator, box, and immutable reward-display data;
it excludes user identity, balance, price/ledger/earnings data, fulfillment data, and all RNG
seed/encryption material. Delivery is at least once; clients deduplicate and refetch
authoritative HTTP state after reconnect (or replay the original idempotent opening command if
its response was lost). Socket delivery is never proof of a financial or opening commit.

The separate `/worker` namespace accepts only an exact `outbox.publish.v1` envelope from the
token-authenticated outbox worker. It is not a browser API. The server never accepts client
Socket.io events to perform openings, wallet mutations, odds changes, or fulfillment
transitions. `wallet.updated.v1`, fulfillment realtime, leaderboard events/projections, and live
feed UI remain later phases.

## API security and evolution

- Apply per-IP and per-actor limits; opening limits do not substitute for transactional business limits.
- Validate content type/size, URLs, Unicode lengths, image host policy, and all query parameters.
- Document response schemas and negative authorization cases in OpenAPI contract tests.
- Add fields compatibly within `/v1`; breaking semantics require a new API/algorithm/event version.
- Deprecation never makes historical fairness verification unavailable.
- Use field allowlists for logs, outbox, analytics, and public responses. Treat usernames, IPs, shipping data, and payment metadata according to the privacy classification policy.
