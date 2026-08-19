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

For each user, generate a seed on a trusted backend/worker, calculate its commitment, encrypt the raw seed with authenticated envelope encryption, and persist the seed-set with status `active` and `next_nonce = 0`. Return the commitment, seed-set ID, algorithm version, and rotation policy to the user before the first opening.

The commitment is public; the ciphertext and plaintext are not. Application logs, traces, error reports, analytics, Redis, and Socket.io payloads must exclude server seeds and ciphertext.

### 2. Choose client seed

The user sees the active server commitment and chooses/accepts a client seed before opening. Updating the client seed is authenticated and revision-checked. Each opening records the exact client seed, so changing it affects only future openings. The server must not silently substitute it.

### 3. Allocate nonce and open

Inside the same atomic transaction as the wallet debit and opening:

1. lock the active seed-set row;
2. read `next_nonce` and validate it is below the rotation limit;
3. increment `next_nonce` exactly once;
4. compute the result from the immutable box manifest;
5. store seed-set ID, commitment, client seed, nonce, algorithm version, accepted round/digest/selection, manifest hash, and selected entry.

Rollback also rolls back nonce allocation. Unique `(rng_seed_set_id, nonce)` is a final defense. Idempotency replay returns the existing opening and must not allocate a new nonce.

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

Per-user seed-sets are chosen for v1. They naturally pair a public commitment with the user's openings, avoid revealing a global seed while another user's opening is in flight, and limit blast radius. The tradeoff is more key material and seed lifecycle rows. Wallet locking already serializes a user's paid opens, so the additional seed row lock is not a material throughput constraint.

Rotation uses the same user/seed lock. If the current seed hits its nonce/age boundary during an open request, the transaction may retire it and activate a pre-generated committed successor, but the successor commitment must be returned/visible before it is used. The simpler recommended behavior is `409 SEED_ROTATION_REQUIRED`, rotate, show the commitment, and require an explicit retry with the same client seed and a new idempotency key because no financial mutation committed.

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
