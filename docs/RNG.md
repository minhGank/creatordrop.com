# Provably Fair RNG Specification

## Goals and limits

The system lets a user verify that an opening was derived from a server seed committed before play, their chosen client seed, a unique nonce, and the exact published reward table. It prevents the server from choosing a new seed after seeing the client seed and prevents the client from computing future outcomes before the seed is retired.

Provable fairness does not by itself prove that displayed prize descriptions are truthful, that fulfillment occurs, or that configured odds satisfy law. Immutable versions, audit controls, fulfillment records, and external/legal review address those concerns.

## Algorithm version `hmac-sha256-rejection-v1`

All byte/text rules are normative:

- `serverSeed`: exactly 32 cryptographically random bytes, generated with Node `crypto.randomBytes(32)` or an equivalent operating-system CSPRNG. Never use `Math.random()`.
- `serverSeedCommitment`: lowercase hex of `SHA-256(serverSeed)`, 64 characters.
- `clientSeed`: exactly 32 bytes represented by 64 lowercase hexadecimal characters. The user can provide it before an opening; the web app may generate a default with Web Crypto.
- `seedSetId`: lowercase canonical UUID string recorded before opening.
- `nonce`: non-negative base-10 integer with no leading zero except `0`, allocated once under a PostgreSQL row lock.
- `round`: non-negative base-10 integer used only for rejection sampling, starting at `0`.
- String encoding: UTF-8; literals and separators are ASCII.

For each round, form this exact message with no newline:

```text
creatordrop:rng:v1|<seedSetId>|<clientSeed>|<nonce>|<round>
```

Compute:

```text
digest = HMAC-SHA256(key = raw serverSeed bytes, message = UTF-8 message)
x = unsigned 256-bit big-endian integer represented by digest
```

Implement `x` with `BigInt`, never `Number`. Given published `totalWeight = W`, require `0 < W <= 9223372036854775807` and compute:

```text
N = 2^256
limit = floor(N / W) * W
```

If `x >= limit`, increment `round` and recompute. Otherwise:

```text
selectionValue = x mod W   // integer in [0, W)
```

This rejection step removes modulo bias. Persist the accepted digest, round, and selection value for audit/debugging; they are derivable after reveal.

## Deterministic weighted selection

The published box version contains ordered entries `(position, boxVersionRewardId, rewardVersionId, weight)`. Validate positions are contiguous from zero, every weight is positive, and their exact integer sum equals `W`.

Walk entries in ascending `position`, maintaining half-open cumulative intervals:

```text
start = 0
for entry in orderedEntries:
  end = start + entry.weight
  if start <= selectionValue < end: select entry
  start = end
```

Boundary behavior is therefore unambiguous: value `0` selects the first entry; value exactly equal to an interval's upper bound selects the next entry. The result must exist because `selectionValue < W` and the weights sum to `W`.

## Canonical box manifest

Every published box version stores a SHA-256 configuration hash over a canonical UTF-8 JSON byte sequence. Use RFC 8785 JSON Canonicalization Scheme in the implementation rather than runtime property order. The logical manifest is:

```json
{
  "algorithmVersion": "hmac-sha256-rejection-v1",
  "boxId": "uuid",
  "boxVersionId": "uuid",
  "currency": "USD",
  "entries": [
    {
      "boxVersionRewardId": "uuid",
      "position": 0,
      "rewardVersionId": "uuid",
      "weight": "1"
    }
  ],
  "priceMinor": "1000",
  "totalWeight": "1"
}
```

All 64-bit integers are decimal strings in the manifest and public JSON. Entry order is ascending `position`. The publish operation calculates the manifest and hash once inside its database transaction. The verification API returns the manifest; opening records retain its hash.

## Seed lifecycle

### 1. Generate and commit

For each user, generate a seed on a trusted backend/worker, calculate its commitment, encrypt the raw seed with authenticated encryption, and persist the seed-set with status `active` and `next_nonce = 0`. Return the commitment, seed-set ID, algorithm version, and rotation policy to the user before the first opening. The Phase 7 local/environment-key implementation is not true envelope encryption; a per-record data-encryption key wrapped by a managed KMS remains production hardening.

The commitment is public; the ciphertext and plaintext are not. Application logs, traces, error reports, analytics, Redis, and Socket.io payloads must exclude server seeds and ciphertext.

### 2. Choose client seed

The user sees the active server commitment and chooses/accepts a client seed before opening. Updating the client seed is authenticated and revision-checked. Each opening records the exact client seed, so changing it affects only future openings. The server must not silently substitute it.

### 3. Allocate nonce and open

Inside the same atomic transaction as the wallet debit and opening:

1. lock the user's fairness-profile row;
2. lock the active seed-set row;
3. read `next_nonce` and validate it is below the rotation limit;
4. increment `next_nonce` exactly once;
5. compute the result from the immutable box manifest;
6. store seed-set ID, commitment, client seed, nonce, algorithm version, accepted round/digest/selection, manifest hash, and selected entry.

Rollback also rolls back nonce allocation. Unique `(rng_seed_set_id, nonce)` is a final defense. Idempotency replay returns the existing opening and must not allocate a new nonce. Automatic database retries are permitted only before nonce allocation/RNG can execute. A deadlock or serialization failure after that boundary rolls back and returns a retryable opening error; the server never invokes the selector twice during one request attempt.

### 4. Retire

Rotate after a published maximum opening count, maximum age, user request, key compromise, or operational policy. Under a row lock, mark the current seed `retired`, create/activate a freshly committed seed, and make the new commitment visible. No opening may reference a retired seed. Seed status and active-row constraints make concurrent rotate/open operations serialize safely.

### 5. Reveal

Only after retirement and after all transactions using it have completed, decrypt the old seed, verify its hash, store the raw seed in `revealed_server_seed`, and mark it `revealed`. The reveal worker emits a durable outbox event. Never reveal an active seed: doing so lets users calculate future outcomes and choose whether to open.

If decrypt/hash validation fails, mark it `compromised`, stop affected openings, alert operators, preserve evidence, and follow an incident policy. Do not fabricate or replace a historical seed.

### 6. Verify independently

The verification response provides:

- algorithm/version and normative specification identifier;
- seed-set ID, revealed server seed, and original commitment;
- client seed and nonce;
- accepted round, digest, selection value;
- canonical box manifest/configuration hash;
- selected reward entry and opening timestamp.

A verifier then:

1. hashes the revealed raw seed and compares it to the pre-opening commitment;
2. canonicalizes/hashes the manifest and compares the configuration hash;
3. recomputes HMAC rounds and rejection sampling;
4. performs weighted interval selection;
5. compares the computed entry with the recorded win.

Before reveal, the endpoint returns proof inputs and status `pending_reveal`, but not the seed; verification is intentionally incomplete.

## Rotation and concurrency details

Per-user seed-sets are chosen for v1. They naturally pair a public commitment with the user's openings, avoid revealing a global seed while another user's opening is in flight, and limit blast radius. The tradeoff is more key material and seed lifecycle rows. Wallet locking already serializes a user's paid opens, so the additional profile/seed row locks are not a material throughput constraint.

The `fairness_profiles` row is the authoritative per-user lifecycle lock. Initialization owns or locks it before inserting the initial seed. Nonce allocation, activation, retirement, reveal, compromise, normal rotation, pending compromise-remediation creation, and remediation completion acquire it before seed rows and then rotation rows. Restricted-role seed/rotation insert and update guards enforce the same per-user serialization; contended raw updates in reverse order fail retryably rather than creating a deadlock. Different users use different profile rows and can progress concurrently.

Rotation uses this profile/seed lock order. If the current seed hits its nonce/age boundary during an open request, the transaction may retire it and activate a pre-generated committed successor, but the successor commitment must be returned/visible before it is used. The simpler recommended behavior is `409 SEED_ROTATION_REQUIRED`, rotate, show the commitment, and require an explicit retry with the same client seed and a new idempotency key because no financial mutation committed.

## Failure and threat analysis

- **Seed substitution:** blocked by storing/publishing a SHA-256 commitment before openings and auditing lifecycle changes.
- **Future-outcome prediction:** blocked by keeping active seeds encrypted and unrevealed. Database read access must not imply decryption access.
- **Nonce reuse:** prevented by row-lock allocation and unique constraint.
- **Box edit after opening:** prevented by immutable box/reward versions and manifest hash.
- **Modulo bias:** prevented by rejection sampling.
- **Weight/order ambiguity:** prevented by integer weights, half-open intervals, ordered entries, and canonical manifest.
- **Client shopping for outcomes:** users may choose client seeds, but without the unrevealed server seed they cannot calculate the outcome. Rate limits still mitigate abuse.
- **Selective request cancellation by server:** durable idempotency/audit/opening metrics help detect it, but public commitment alone cannot prove the server did not refuse unfavorable opens. Monitor rejection rates and publish clear error behavior.
- **Seed compromise:** immediately pause openings for the affected scope, retire without pretending fairness, record an incident, and define refund/remediation policy before launch.
- **Cryptographic agility:** each opening and box version stores an algorithm version. A new algorithm requires new box versions/seed-sets and preserved verifier code; never reinterpret old records.

## Required test vectors and tests

Before implementation is accepted, check in language-neutral JSON test vectors containing raw server seed, commitment, seed-set ID, client seed, nonce, each round digest, total weight, selection value, manifest/hash, and winning entry. Generate expected values with an independently reviewed script and validate both production selector and public verifier.

Tests must cover:

- known SHA-256/HMAC vectors and at least ten fixed CreatorDrop vectors;
- leading zero bytes and maximum unsigned 256-bit parsing;
- `W = 1`, large signed-64-bit `W`, and values on every interval boundary;
- a crafted rejected digest path (inject the digest source in unit tests);
- deterministic repeatability and changes to client seed/nonce/server seed;
- malformed hex, non-canonical UUID/integers, zero/negative/overflowing weights, gaps/duplicates in position;
- manifest canonicalization independent of object insertion order;
- concurrent nonce allocation, rollback reuse behavior, idempotent replay, rotation/open races;
- reveal prohibited while active and commitment mismatch incident behavior;
- a separate verifier package/tool with no imports from the production selection function.

Statistical tests may detect gross implementation mistakes but cannot replace deterministic vectors or prove fairness. Keep them non-flaky with fixed seeds and generous, reviewed thresholds.

## Phase 6 implementation

The pure production engine lives in `@creatordrop/domain`. Its public `selectReward` operation accepts an explicit 32-byte server seed, canonical client seed, seed-set ID, nonce, algorithm version, immutable manifest, and optional expected manifest hash. It returns the accepted digest bytes/hex, accepted round, unbiased `BigInt` selection value, exact selected association/reward-version IDs, manifest hash, and total weight. It has no HTTP, PostgreSQL, Supabase, environment, filesystem, clock, or seed-lifecycle dependency.

The engine exposes its rejection sampler separately with an injected digest source. Production `selectReward` always constructs that source with Node's HMAC-SHA256 implementation; injection exists only at the pure sampler boundary so deterministic tests can exercise otherwise vanishingly rare rejected rounds.

`@creatordrop/rng-verifier` is an independent implementation. It does not import or depend on `@creatordrop/domain`; it separately validates and canonicalizes the manifest, verifies the revealed seed commitment, reconstructs each HMAC message, performs rejection sampling and weighted selection, and compares all recorded proof fields. Well-formed disagreements return explicit mismatch codes. Malformed inputs throw stable, secret-free verifier errors.

Language-neutral fixtures are checked in at `test-vectors/rng/hmac-sha256-rejection-v1.json`. They contain ten obviously synthetic server/client seeds, commitments, manifests/hashes, per-round digests, nonces (including values beyond JavaScript's safe integer range), selections, and winners. The companion `hmac-sha256-rejection-v1-primitives.json` contains an independently checked nonzero-round HMAC answer and crafted `limit`, `limit + 1`, and accepted-digest sequences so rejection behavior is executable without waiting for an infeasibly rare natural HMAC rejection. `scripts/generate-rng-test-vectors.mjs` is a standalone reference implementation that imports neither production nor verifier code. Reproducibility is a CI gate:

```bash
npm run check:rng-vectors
```

The workspace-boundary gate also scans verifier and generator source imports, including deep, dynamic, undeclared-hoisted, and relative cross-workspace imports, so their independence is enforced in addition to being documented.

Phase 6 adds no endpoint, seed persistence, nonce allocation, opening record, or database migration.

## Phase 7 lifecycle implementation

Phase 7 persists one canonical client-seed preference and at most one active encrypted server-seed set per user. The API requires an explicit client seed for initialization, publishes the active commitment before use, permits optimistic client-seed changes, performs idempotent user rotation, and exposes sanitized public seed history. It never returns active plaintext or encryption metadata.

Active server seeds are generated with Node `randomBytes(32)`, committed with SHA-256, and encrypted directly using AES-256-GCM under an environment-supplied 32-byte master key, with a fresh 12-byte IV and 16-byte tag. This is authenticated encryption at rest, not envelope encryption: Phase 7 does not create a per-record data-encryption key or wrap one with KMS. Managed KMS/envelope encryption remains required production hardening.

The exact UTF-8 additional-authenticated-data bytes are the following ASCII-compatible string, with no trailing delimiter, whitespace, or line ending:

```text
creatordrop:rng-seed:v1|<canonical-user-uuid>|<canonical-seed-set-uuid>|<rng-algorithm-version>|<encryption-key-version>
```

The AAD binds ciphertext to the user ID, seed-set ID, RNG algorithm version, and encryption key version. `RNG_MASTER_KEY` is exactly 64 lowercase hexadecimal characters and has no runtime default. `RNG_MASTER_KEY_VERSION` identifies the active write key; `RNG_HISTORICAL_MASTER_KEYS` is a strict, duplicate-free JSON array of versioned decrypt-only keys so retired history remains revealable across key rotation. The documented all-zero example key and local-development version sentinels are accepted only with an explicit development/test runtime and reject when production or `NODE_ENV` is omitted. The environment provider returns defensive key copies through a narrow version-aware interface; PostgreSQL stores no master key. Before a non-local key can protect a seed, an operator must register its version and non-secret SHA-256 key-material identity in `app.rng_encryption_key_versions`. The application can read but cannot create, alter, or delete this mapping.

Owned in-process key, server-seed, plaintext, and temporary cryptographic buffers are overwritten on success and failure where practical. This is defense in depth only: JavaScript runtimes, native crypto implementations, database drivers, and garbage collectors cannot guarantee perfect memory erasure.

`allocateNextNonce` is intentionally transaction-scoped: its opaque executor is valid only during a shared database transaction callback. Runtime state is checked before each query, caller transaction-control/multi-statement SQL is rejected, escaped executors are inactive after commit or rollback, and callback completion with outstanding executor work rolls the transaction back. It locks the fairness profile before the active seed row, lets PostgreSQL evaluate the stored count/age boundaries using database time, returns the current nonce, and increments exactly once. A rollback restores the counter. Phase 9 first locks and validates sufficient wallet funds, then calls this primitive from the fairness application interface inside the larger atomic wallet/opening transaction, resolves/decrypts the already locked active seed, runs the unchanged Phase 6 selector once, and wipes plaintext/key copies before returning an allowlisted proof. Allocating or committing a nonce beforehand is prohibited, and the opening coordinator never automatically retries once selector execution may have begun. `box_opens` adds unique `(rng_seed_set_id, nonce)` defense alongside the serialized counter.

Normal rotation takes the same profile-then-seed locks, records an allowlisted user, operational, or policy-change reason, creates a separately encrypted commitment at nonce `0`, and records an operation-fingerprinted idempotent predecessor/successor relationship in one transaction. Compromise remediation first disables the active seed and may intentionally leave zero active seeds until safe replacement provisioning succeeds. Seed and rotation write guards acquire the same profile lock before the deferred cross-row checks, so a pending remediation and standalone active seed cannot both commit from separate `READ COMMITTED` snapshots. Every new seed row derives its non-secret SHA-256 key identity from the protected registry. A `key_compromise` successor must use both a different active key version and different registered key identity; remediation fails closed when a legacy predecessor identity cannot be established from a retained historical key. Deferred PostgreSQL checks on rotations and seed rows enforce the same predecessor, reason, lineage, zero-active pending state, active-successor, and registered-key invariants at commit.

Reveal is an authenticated internal lifecycle primitive: it locks an eligible retired row, authenticates/decrypts it, timing-safely verifies the commitment, and stores plaintext only with `revealed` status. Missing or temporarily unavailable historical key material leaves the row retired and retryable. Only authenticated-decryption/integrity or commitment failure commits `compromised` and emits a secret-free security audit record. Automatic worker scheduling and outbox publication remain deferred; production incident alerting/remediation policy is still required.
