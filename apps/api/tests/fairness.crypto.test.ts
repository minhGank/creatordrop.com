import { describe, expect, it } from 'vitest';

import {
  buildSeedEncryptionAad,
  commitServerSeed,
  decryptServerSeed,
  encryptServerSeed,
  generateServerSeed,
  serverSeedMatchesCommitment,
} from '../src/modules/fairness/fairness.crypto.js';
import {
  SeedCryptographyError,
  SeedEncryptionKeyUnavailableError,
} from '../src/modules/fairness/fairness.errors.js';
import {
  createEnvironmentSeedEncryptionKeyProvider,
  deriveSeedEncryptionKeyIdentity,
} from '../src/modules/fairness/fairness.key-provider.js';

const bytes = (value: number, size: number): Uint8Array => new Uint8Array(size).fill(value);
const fromHex = (value: string): Uint8Array => Uint8Array.from(Buffer.from(value, 'hex'));

const aad = buildSeedEncryptionAad({
  algorithmVersion: 'hmac-sha256-rejection-v1',
  keyVersion: 'synthetic-v1',
  seedSetId: '019c0000-0000-7000-8000-000000000020',
  userId: '019c0000-0000-7000-8000-000000000001',
});

describe('server seed authenticated encryption', () => {
  it('generates exactly 32 bytes and commits to the raw bytes', () => {
    const sourceBytes = bytes(7, 32);
    const generated = generateServerSeed((size) => {
      expect(size).toBe(32);
      return sourceBytes;
    });
    expect(generated).toEqual(bytes(7, 32));
    expect(sourceBytes).toEqual(bytes(0, 32));
    const commitment = commitServerSeed(generated);
    expect(commitment).toBe('4bb06f8e4e3a7715d201d573d0aa423762e55dabd61a2c02278fa56cc6d294e0');
    expect(serverSeedMatchesCommitment(generated, commitment)).toBe(true);
    expect(serverSeedMatchesCommitment(bytes(8, 32), commitment)).toBe(false);
  });

  it('wipes owned random-source buffers on validation and encryption failures', () => {
    const malformedSeed = bytes(7, 31);
    expect(() => generateServerSeed(() => malformedSeed)).toThrow(SeedCryptographyError);
    expect(malformedSeed).toEqual(bytes(0, 31));

    const malformedIv = bytes(8, 11);
    expect(() =>
      encryptServerSeed({
        aad,
        ivSource: () => malformedIv,
        key: bytes(2, 32),
        serverSeed: bytes(3, 32),
      }),
    ).toThrow(SeedCryptographyError);
    expect(malformedIv).toEqual(bytes(0, 11));
  });

  it('locks the exact versioned AAD bytes and an independent AES-GCM known answer', () => {
    const expectedAad =
      'creatordrop:rng-seed:v1|019c0000-0000-7000-8000-000000000001|' +
      '019c0000-0000-7000-8000-000000000020|hmac-sha256-rejection-v1|synthetic-v1';
    expect(Buffer.from(aad).toString('utf8')).toBe(expectedAad);
    expect(Buffer.from(aad).toString('hex')).toBe(
      '63726561746f7264726f703a726e672d736565643a76317c30313963303030302d303030302d' +
        '373030302d383030302d3030303030303030303030317c30313963303030302d303030302d37' +
        '3030302d383030302d3030303030303030303032307c686d61632d7368613235362d72656a65' +
        '6374696f6e2d76317c73796e7468657469632d7631',
    );

    const encrypted = encryptServerSeed({
      aad,
      ivSource: () => fromHex('a0a1a2a3a4a5a6a7a8a9aaab'),
      key: fromHex('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f'),
      serverSeed: fromHex('202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f'),
    });
    expect(Buffer.from(encrypted.ciphertext).toString('hex')).toBe(
      'c6395e0e61ee24984a4cadf82b57eef1409d6b23a682745ba4371cbd43964b3e',
    );
    expect(Buffer.from(encrypted.authenticationTag).toString('hex')).toBe(
      'f69b9695b6345c62927f9856f9d5610b',
    );
    expect(
      Buffer.from(
        decryptServerSeed({
          aad,
          authenticationTag: fromHex('f69b9695b6345c62927f9856f9d5610b'),
          ciphertext: fromHex('c6395e0e61ee24984a4cadf82b57eef1409d6b23a682745ba4371cbd43964b3e'),
          iv: fromHex('a0a1a2a3a4a5a6a7a8a9aaab'),
          key: fromHex('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f'),
        }),
      ).toString('hex'),
    ).toBe('202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f');
  });

  it('round-trips a 32-byte seed with AES-256-GCM', () => {
    const serverSeed = bytes(3, 32);
    const encrypted = encryptServerSeed({
      aad,
      ivSource: () => bytes(4, 12),
      key: bytes(2, 32),
      serverSeed,
    });
    expect(encrypted.authenticationTag).toBeInstanceOf(Uint8Array);
    expect(encrypted.ciphertext).toBeInstanceOf(Uint8Array);
    expect(encrypted.iv).toEqual(bytes(4, 12));
    expect(encrypted.ciphertext).not.toEqual(serverSeed);
    expect(
      decryptServerSeed({
        aad,
        authenticationTag: encrypted.authenticationTag,
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        key: bytes(2, 32),
      }),
    ).toEqual(serverSeed);
  });

  it('produces different ciphertext and tags with fresh IVs', () => {
    const encrypt = (ivByte: number) =>
      encryptServerSeed({
        aad,
        ivSource: () => bytes(ivByte, 12),
        key: bytes(2, 32),
        serverSeed: bytes(3, 32),
      });
    const first = encrypt(4);
    const second = encrypt(5);
    expect(first.ciphertext).not.toEqual(second.ciphertext);
    expect(first.authenticationTag).not.toEqual(second.authenticationTag);
  });

  it.each([
    ['wrong key', 'key'],
    ['modified ciphertext', 'ciphertext'],
    ['modified authentication tag', 'tag'],
    ['modified IV', 'iv'],
  ] as const)('fails closed for %s', (_name, change) => {
    const encrypted = encryptServerSeed({
      aad,
      ivSource: () => bytes(4, 12),
      key: bytes(2, 32),
      serverSeed: bytes(3, 32),
    });
    const modified = (source: Uint8Array): Uint8Array => {
      const result = Uint8Array.from(source);
      result[0] = (result[0] ?? 0) ^ 1;
      return result;
    };
    expect(() =>
      decryptServerSeed({
        aad,
        authenticationTag:
          change === 'tag' ? modified(encrypted.authenticationTag) : encrypted.authenticationTag,
        ciphertext: change === 'ciphertext' ? modified(encrypted.ciphertext) : encrypted.ciphertext,
        iv: change === 'iv' ? modified(encrypted.iv) : encrypted.iv,
        key: change === 'key' ? bytes(9, 32) : bytes(2, 32),
      }),
    ).toThrow(SeedCryptographyError);
  });

  it.each([
    ['user ID', { userId: '019c0000-0000-7000-8000-000000000002' }],
    ['seed-set ID', { seedSetId: '019c0000-0000-7000-8000-000000000021' }],
    ['algorithm version', { algorithmVersion: 'different-algorithm' }],
    ['key version', { keyVersion: 'synthetic-v2' }],
  ] as const)('authenticates the AAD %s', (_name, changed) => {
    const encrypted = encryptServerSeed({
      aad,
      ivSource: () => bytes(4, 12),
      key: bytes(2, 32),
      serverSeed: bytes(3, 32),
    });
    const changedAad = buildSeedEncryptionAad({
      algorithmVersion: 'hmac-sha256-rejection-v1',
      keyVersion: 'synthetic-v1',
      seedSetId: '019c0000-0000-7000-8000-000000000020',
      userId: '019c0000-0000-7000-8000-000000000001',
      ...changed,
    });
    expect(() =>
      decryptServerSeed({
        aad: changedAad,
        authenticationTag: encrypted.authenticationTag,
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        key: bytes(2, 32),
      }),
    ).toThrow(SeedCryptographyError);
  });

  it('rejects malformed seed, key, IV, tag, and ciphertext lengths without values in errors', () => {
    const malformedOperations = [
      () => generateServerSeed(() => bytes(1, 31)),
      () => commitServerSeed(bytes(1, 31)),
      () =>
        encryptServerSeed({
          aad,
          ivSource: () => bytes(1, 11),
          key: bytes(2, 32),
          serverSeed: bytes(3, 32),
        }),
      () =>
        encryptServerSeed({
          aad,
          key: bytes(2, 31),
          serverSeed: bytes(3, 32),
        }),
      () =>
        decryptServerSeed({
          aad,
          authenticationTag: bytes(1, 15),
          ciphertext: bytes(1, 32),
          iv: bytes(1, 12),
          key: bytes(1, 32),
        }),
      () =>
        decryptServerSeed({
          aad,
          authenticationTag: bytes(1, 16),
          ciphertext: bytes(1, 31),
          iv: bytes(1, 12),
          key: bytes(1, 32),
        }),
      () =>
        decryptServerSeed({
          aad,
          authenticationTag: bytes(1, 16),
          ciphertext: bytes(1, 32),
          iv: bytes(1, 11),
          key: bytes(1, 32),
        }),
      () =>
        decryptServerSeed({
          aad,
          authenticationTag: bytes(1, 16),
          ciphertext: bytes(1, 32),
          iv: bytes(1, 12),
          key: bytes(1, 31),
        }),
    ];
    for (const operation of malformedOperations) {
      expect(operation).toThrow(SeedCryptographyError);
      try {
        operation();
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        if (error instanceof Error) {
          expect(error.message).toBe('RNG seed cryptography operation failed.');
        }
      }
    }
  });
});

describe('environment seed encryption key provider', () => {
  it('derives a stable non-secret SHA-256 key identity', () => {
    expect(deriveSeedEncryptionKeyIdentity(bytes(10, 32))).toBe(
      'b9b07dd4e7718454476f04edeb935022ae4f4d90934ab7ce913ff20c8baeb399',
    );
    expect(deriveSeedEncryptionKeyIdentity(bytes(10, 32))).not.toBe(
      deriveSeedEncryptionKeyIdentity(bytes(11, 32)),
    );
    expect(() => deriveSeedEncryptionKeyIdentity(bytes(10, 31))).toThrow(SeedCryptographyError);
  });

  it('returns defensive key copies only for the configured key version', async () => {
    const provider = createEnvironmentSeedEncryptionKeyProvider({
      keyHex: '0a'.repeat(32),
      version: 'synthetic-v1',
    });
    const first = await provider.getActiveEncryptionKey();
    first.key.fill(0);
    const second = await provider.getEncryptionKey('synthetic-v1');
    expect(second.key).toEqual(bytes(10, 32));
    await expect(provider.getEncryptionKey('unknown-v2')).rejects.toThrow(
      SeedEncryptionKeyUnavailableError,
    );
  });

  it('retains versioned decrypt-only keys without making them active', async () => {
    const provider = createEnvironmentSeedEncryptionKeyProvider({
      historicalKeys: { 'synthetic-v1': '0a'.repeat(32) },
      keyHex: '0b'.repeat(32),
      version: 'synthetic-v2',
    });
    expect(await provider.getActiveEncryptionKey()).toEqual({
      key: bytes(11, 32),
      version: 'synthetic-v2',
    });
    expect(await provider.getEncryptionKey('synthetic-v1')).toEqual({
      key: bytes(10, 32),
      version: 'synthetic-v1',
    });
  });

  it('rejects relabeling the active key material as a different version', () => {
    expect(() =>
      createEnvironmentSeedEncryptionKeyProvider({
        historicalKeys: { 'synthetic-v1': '0b'.repeat(32) },
        keyHex: '0b'.repeat(32),
        version: 'synthetic-v2',
      }),
    ).toThrow(SeedCryptographyError);
  });

  it.each([
    { keyHex: '0a'.repeat(31), version: 'synthetic-v1' },
    { keyHex: 'AA'.repeat(32), version: 'synthetic-v1' },
    { keyHex: '0a'.repeat(32), version: '' },
  ])('rejects malformed environment key material: %o', (input) => {
    expect(() => createEnvironmentSeedEncryptionKeyProvider(input)).toThrow(SeedCryptographyError);
  });
});
