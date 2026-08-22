# CreatorDrop RNG test vectors

`hmac-sha256-rejection-v1.json` contains public, obviously synthetic, language-neutral fixtures for the normative algorithm in `docs/RNG.md`. `hmac-sha256-rejection-v1-primitives.json` adds a nonzero-round HMAC known answer and crafted digest sequences for the rejection boundary that cannot feasibly be found through natural HMAC output under the signed-64 weight limit. Integer values that may exceed interoperable JSON number ranges are decimal strings; raw seeds and digests are lowercase hexadecimal.

The standalone reference generator uses only Node's built-in `crypto` primitives and its own manifest, rejection-sampling, and weighted-selection implementation. It does not import `@creatordrop/domain` or `@creatordrop/rng-verifier`.

Reproduce and compare the checked-in file with:

```bash
node scripts/generate-rng-test-vectors.mjs --check
```

Run without `--check` to print the canonical expected JSON for review. These are public test values, never production seed material.

Print the primitive fixture document with:

```bash
node scripts/generate-rng-test-vectors.mjs --primitives
```

The nonzero-round HMAC answer was cross-checked independently with OpenSSL and Python. Crafted rejection digests are explicit 256-bit big-endian values, not simulated HMAC outputs.
