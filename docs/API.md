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

Every request receives `X-Request-Id`. A caller value is retained only when it matches the strict 8–64 character request-ID format; otherwise the API generates a cryptographically random UUID. API request/error logs use allowlisted metadata and redact credential-like attribute names. The bootstrap endpoint currently uses a per-process, in-memory IP limiter. Production horizontal scaling will require a shared limiter store and an explicitly configured trusted-proxy policy.

## Users and fairness preferences

| Method  | Path                          | Auth               | Purpose                                                                  |
| ------- | ----------------------------- | ------------------ | ------------------------------------------------------------------------ |
| `GET`   | `/v1/me`                      | user               | Own profile                                                              |
| `PATCH` | `/v1/me`                      | user               | Update allowlisted profile fields                                        |
| `GET`   | `/v1/me/openings`             | user               | Paginated private opening history                                        |
| `GET`   | `/v1/me/rewards`              | user               | Reward wins and fulfillment summaries                                    |
| `GET`   | `/v1/me/fairness`             | user               | Active seed-set ID/commitment, client seed, nonce count, rotation policy |
| `PUT`   | `/v1/me/fairness/client-seed` | user               | Set future client seed with revision check                               |
| `POST`  | `/v1/me/fairness/rotate`      | user + idempotency | Retire/reveal old seed and establish a newly committed seed              |

Changing a client seed never mutates existing opening proofs.

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

`PUT .../draft/rewards` accepts `{ "entries": [{ "rewardVersionId": "uuid", "weight": "5" }] }`. Array order is the canonical position. An empty array is a valid draft, but publication rejects it. A version may occur only once and every referenced reward must belong to the authenticated creator.

The publish response returns the immutable version, reward snapshots, exact ordered weights, calculated `totalWeight`, canonical manifest, and `configurationHash`. The server calculates totals/hashes; client totals are never authoritative. Publication failures use stable codes including `CATALOG_PUBLICATION_EMPTY_CONFIGURATION`, `CATALOG_PUBLICATION_INELIGIBLE_REWARD`, `CATALOG_PUBLICATION_INVALID_INVENTORY`, and `CATALOG_PUBLICATION_WEIGHT_OVERFLOW`. Pause behavior and durable command idempotency are not introduced in Phase 5; optimistic revision and row locking serialize publication against edits.

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
    "cost": { "minor": "1000", "currency": "USD" },
    "reward": {
      "rewardId": "uuid",
      "rewardVersionId": "uuid",
      "name": "Signed poster",
      "imageUrl": "https://..."
    },
    "fairness": {
      "algorithmVersion": "hmac-sha256-rejection-v1",
      "seedSetId": "uuid",
      "serverSeedCommitment": "64-hex",
      "clientSeed": "64-hex",
      "nonce": "7",
      "configurationHash": "64-hex",
      "revealStatus": "pending_reveal"
    },
    "createdAt": "2026-01-01T00:00:00Z"
  },
  "wallet": {
    "availableBalance": { "minor": "2400", "currency": "USD" },
    "version": "18"
  }
}
```

The server has already decided and committed the reward when this response is generated. The frontend reel must land on that reward. Expected domain errors include `BOX_NOT_ACTIVE`, `BOX_VERSION_CHANGED` (if a future expected-version option is added), `INSUFFICIENT_BALANCE`, `ELIGIBILITY_DENIED`, `OPEN_LIMIT_REACHED`, `SEED_ROTATION_REQUIRED`, and `IDEMPOTENCY_KEY_REUSED`.

`GET /v1/openings/:publicOpeningId` returns a sanitized public receipt. Owners receive private fulfillment state through `/v1/me/rewards`; public routes never expose wallet balance or delivery data.

## Fairness verification

| Method | Path                                               | Auth   | Purpose                                                           |
| ------ | -------------------------------------------------- | ------ | ----------------------------------------------------------------- |
| `GET`  | `/v1/fairness/openings/:publicOpeningId`           | public | Proof inputs, manifest, computed fields, and reveal state         |
| `GET`  | `/v1/fairness/seed-sets/:seedSetId`                | public | Commitment, lifecycle dates, reveal if retired, algorithm version |
| `GET`  | `/v1/fairness/algorithms/hmac-sha256-rejection-v1` | public | Versioned machine-readable specification/test-vector link         |

If the seed is active, the proof endpoint returns `verificationStatus: "pending_reveal"` and omits `serverSeed`. Once revealed it returns all inputs described in `RNG.md`. Old algorithms and manifests remain accessible for the full required retention period.

## Wallet, funding, and ledger receipts

| Method | Path                                           | Auth               | Purpose                                                    |
| ------ | ---------------------------------------------- | ------------------ | ---------------------------------------------------------- |
| `GET`  | `/v1/me/wallets`                               | user               | Settled balances by currency                               |
| `GET`  | `/v1/me/wallets/:currency/transactions`        | user               | Paginated user-facing ledger receipts                      |
| `POST` | `/v1/me/wallets/:currency/funding-intents`     | user + idempotency | Create provider funding intent after policy/provider phase |
| `GET`  | `/v1/me/wallets/:currency/funding-intents/:id` | owner              | Provider-independent funding status                        |
| `POST` | `/v1/payments/webhooks/:provider`              | signed provider    | Idempotent provider event ingestion; no user bearer token  |

The client cannot credit a wallet or mark an intent settled. Webhook acknowledgment occurs only after durable event recording; processing can be asynchronous. Ledger APIs expose safe receipt descriptions and signed amounts, not internal balancing accounts.

Refunds, withdrawals, creator payouts, promo credit, and administrator adjustments are omitted until policies are approved. They must be explicit commands with independent permissions/idempotency, not generic “set balance” endpoints.

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

Socket.io authenticates at connection and reauthorizes private subscriptions. Initial server events:

- `drop.created.v1`: sanitized committed public opening for creator/global rooms;
- `opening.completed.v1`: private result notification, deduplicated by `eventId`/`openingId`;
- `wallet.updated.v1`: private balance projection after a committed ledger operation;
- `fulfillment.updated.v1`: private or creator-scoped allowlisted status;
- `leaderboard.updated.v1`: disposable projection with `asOf`.

Every event has `{ eventId, type, version, occurredAt, data }`. Delivery is at least once; clients deduplicate and refetch authoritative HTTP state after reconnect. The server never accepts client Socket.io events to perform openings, wallet mutations, odds changes, or fulfillment transitions.

## API security and evolution

- Apply per-IP and per-actor limits; opening limits do not substitute for transactional business limits.
- Validate content type/size, URLs, Unicode lengths, image host policy, and all query parameters.
- Document response schemas and negative authorization cases in OpenAPI contract tests.
- Add fields compatibly within `/v1`; breaking semantics require a new API/algorithm/event version.
- Deprecation never makes historical fairness verification unavailable.
- Use field allowlists for logs, outbox, analytics, and public responses. Treat usernames, IPs, shipping data, and payment metadata according to the privacy classification policy.
