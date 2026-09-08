# CreatorDrop Product Brief

CreatorDrop is a creator-led, free-entry reward platform. Creators publish Drops with explicit
reward chances; eligible fans use earned opening entitlements to reveal a backend-selected reward
through a provably fair reel experience.

The active fan journey is:

```text
opening entitlement → opening-v2 → free atomic opening → reward
```

Fans do not fund a CreatorDrop wallet, buy credits, pay a Drop price, or create a financial
transaction. Entitlement availability and personal opening limits are PostgreSQL-authoritative.
The backend consumes exactly one entitlement in the same transaction as the nonce, deterministic
selection, opening, reward win, fulfillment obligation, idempotency result, and outbox records.

Published Drop versions and reward odds are immutable. The versioned HMAC-SHA256 rejection
sampling protocol remains independently verifiable, while the primary consumer experience shows
percentage odds and keeps raw proof details optional.

The retired paid `opening-v1` model, wallet/ledger records, funding history, migrations, and proof
parsers remain immutable compatibility and audit history. They are not active fan product
surfaces. R2A adds Platform → Action → creator entry methods, separately versioned immutable
eligibility policies, private submitted proof, and owner/manager manual review. Only an approved
claim atomically grants R1 opening entitlements; submitted evidence is not automatic verification.
The polished entry configuration/claim/review UI (R2B), provider automation, XP/levels, Universal
Entries, creator SaaS billing, and the creator management redesign remain future roadmap work.
