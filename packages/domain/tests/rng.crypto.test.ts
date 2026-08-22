import { describe, expect, it } from 'vitest';

import {
  buildHmacMessage,
  createHmacSha256DigestSource,
  digestToUnsignedBigint,
  hmacSha256,
  parseClientSeed,
  parseNonce,
  parseSeedSetId,
  parseServerSeed,
  RngError,
  sha256Hex,
} from '../src/index.js';

const seedSetId = '00000001-0001-7000-8000-000000000000';
const clientSeed = '00'.repeat(32);

const rngError = (operation: () => unknown): RngError => {
  try {
    operation();
  } catch (error) {
    if (error instanceof RngError) return error;
    throw error;
  }
  throw new Error('Expected an RNG error.');
};

describe('RNG cryptographic primitives', () => {
  it('matches known SHA-256 and RFC 4231 HMAC-SHA256 vectors', () => {
    expect(sha256Hex(Buffer.from('abc', 'utf8'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(
      Buffer.from(
        hmacSha256(
          Uint8Array.from({ length: 20 }, () => 0x0b),
          'Hi There',
        ),
      ).toString('hex'),
    ).toBe('b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7');
  });

  it('constructs the exact UTF-8 HMAC message without a newline', () => {
    expect(buildHmacMessage(seedSetId, clientSeed, '9007199254740993', 7n)).toBe(
      `creatordrop:rng:v1|${seedSetId}|${clientSeed}|9007199254740993|7`,
    );
  });

  it('requires exact and canonical server seed, client seed, UUID, and nonce inputs', () => {
    expect(parseServerSeed(new Uint8Array(32))).toHaveLength(32);
    expect(rngError(() => parseServerSeed(new Uint8Array(31))).code).toBe('INVALID_SERVER_SEED');
    expect(rngError(() => parseServerSeed('00'.repeat(32))).code).toBe('INVALID_SERVER_SEED');
    expect(parseClientSeed(clientSeed)).toBe(clientSeed);
    expect(rngError(() => parseClientSeed('AA'.repeat(32))).code).toBe('INVALID_CLIENT_SEED');
    expect(rngError(() => parseClientSeed('00')).code).toBe('INVALID_CLIENT_SEED');
    expect(parseSeedSetId(seedSetId)).toBe(seedSetId);
    expect(rngError(() => parseSeedSetId('ABCDEF01-0001-7000-8000-000000000000')).code).toBe(
      'INVALID_SEED_SET_ID',
    );
    expect(parseNonce('9007199254740993')).toBe(9_007_199_254_740_993n);
    for (const invalid of ['-1', '01', '+1', '1.0', 1]) {
      expect(rngError(() => parseNonce(invalid)).code).toBe('INVALID_NONCE');
    }
  });

  it('interprets digests as unsigned 256-bit big-endian integers', () => {
    const leadingZeros = new Uint8Array(32);
    leadingZeros[31] = 1;
    expect(digestToUnsignedBigint(leadingZeros)).toBe(1n);
    expect(digestToUnsignedBigint(Uint8Array.from({ length: 32 }, () => 0xff))).toBe(
      (1n << 256n) - 1n,
    );
    expect(rngError(() => digestToUnsignedBigint(new Uint8Array(31))).code).toBe('INVALID_DIGEST');
  });

  it('changes the HMAC when each message/key input changes', () => {
    const base = {
      clientSeed,
      nonce: '0',
      seedSetId,
      serverSeed: new Uint8Array(32),
    };
    const digest = (input: typeof base): string =>
      Buffer.from(createHmacSha256DigestSource(input)(0n)).toString('hex');
    const baseline = digest(base);
    expect(digest({ ...base, serverSeed: Uint8Array.from({ length: 32 }, () => 1) })).not.toBe(
      baseline,
    );
    expect(digest({ ...base, clientSeed: `${'00'.repeat(31)}01` })).not.toBe(baseline);
    expect(digest({ ...base, nonce: '1' })).not.toBe(baseline);
    expect(digest({ ...base, seedSetId: '00000002-0001-7000-8000-000000000000' })).not.toBe(
      baseline,
    );
    expect(Buffer.from(createHmacSha256DigestSource(base)(1n)).toString('hex')).not.toBe(baseline);
  });
});
