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
selection, opening, reward win, applicable fulfillment, XP progression, idempotency result, and outbox records.

Published Drop versions and reward odds are immutable. The versioned HMAC-SHA256 rejection
sampling protocol remains independently verifiable, while the primary consumer experience shows
percentage odds and keeps raw proof details optional.

The retired paid `opening-v1` model, wallet/ledger records, funding history, migrations, and proof
parsers remain immutable compatibility and audit history. They are not active fan product
surfaces. R2A adds Platform → Action → creator entry methods, separately versioned immutable
eligibility policies, private submitted proof, and owner/manager manual review. Only an approved
claim atomically grants R1 opening entitlements; submitted evidence is not automatic verification.
R2B adds the platform/action configuration studio, private proof submission and authoritative fan
status, plus an owner/manager review inbox. R3 adds account-wide XP, levels, and earned Universal Entries. Creator-specific entitlements are
consumed first; Universal Entries satisfy entry requirements on otherwise eligible Drops while
all opening limits and fairness rules remain authoritative. XP rewards follow a bounded platform
policy and grant one Universal Entry per level gained. Legacy points/rankings are retired, with
history preserved and no conversion to XP. R4 measures each committed opening-v2 exactly once
for the destination creator, from immutable PostgreSQL opening history. Owner/manager Usage
shows UTC period, source and stable-Drop analytics. A permissive capacity boundary prepares for
future allowances without current commercial limits. Plans, pricing, quotas and Stripe remain
undecided and unimplemented. Provider automation, creator SaaS billing, and the
broader creator management redesign remain future roadmap work.
