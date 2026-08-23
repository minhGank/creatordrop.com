import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

import { SeedCryptographyError } from './fairness.errors.js';

export interface EncryptedServerSeed {
  readonly authenticationTag: Uint8Array;
  readonly ciphertext: Uint8Array;
  readonly iv: Uint8Array;
}

export type SecureRandomBytes = (size: number) => Uint8Array;

const requireSize: (value: unknown, size: number) => asserts value is Uint8Array = (
  value,
  size,
) => {
  if (!(value instanceof Uint8Array) || value.byteLength !== size) {
    throw new SeedCryptographyError();
  }
};

export const generateServerSeed = (source: SecureRandomBytes = randomBytes): Uint8Array => {
  const generated = source(32);
  try {
    requireSize(generated, 32);
    return Uint8Array.from(generated);
  } finally {
    if (generated instanceof Uint8Array) generated.fill(0);
  }
};

export const commitServerSeed = (serverSeed: Uint8Array): string => {
  requireSize(serverSeed, 32);
  return createHash('sha256').update(serverSeed).digest('hex');
};

export const buildSeedEncryptionAad = (input: {
  readonly algorithmVersion: string;
  readonly keyVersion: string;
  readonly seedSetId: string;
  readonly userId: string;
}): Uint8Array =>
  new TextEncoder().encode(
    `creatordrop:rng-seed:v1|${input.userId}|${input.seedSetId}|${input.algorithmVersion}|${input.keyVersion}`,
  );

export const encryptServerSeed = (input: {
  readonly aad: Uint8Array;
  readonly ivSource?: SecureRandomBytes;
  readonly key: Uint8Array;
  readonly serverSeed: Uint8Array;
}): EncryptedServerSeed => {
  requireSize(input.key, 32);
  requireSize(input.serverSeed, 32);
  const generatedIv = (input.ivSource ?? randomBytes)(12);
  let iv: Uint8Array | undefined;
  let ciphertext: Buffer | undefined;
  let authenticationTag: Buffer | undefined;

  try {
    requireSize(generatedIv, 12);
    iv = Uint8Array.from(generatedIv);
    const cipher = createCipheriv('aes-256-gcm', input.key, iv, { authTagLength: 16 });
    cipher.setAAD(input.aad);
    ciphertext = Buffer.concat([cipher.update(input.serverSeed), cipher.final()]);
    authenticationTag = cipher.getAuthTag();
    return {
      authenticationTag: Uint8Array.from(authenticationTag),
      ciphertext: Uint8Array.from(ciphertext),
      iv,
    };
  } catch {
    throw new SeedCryptographyError();
  } finally {
    if (generatedIv instanceof Uint8Array) generatedIv.fill(0);
    ciphertext?.fill(0);
    authenticationTag?.fill(0);
  }
};

export const decryptServerSeed = (input: {
  readonly aad: Uint8Array;
  readonly authenticationTag: Uint8Array;
  readonly ciphertext: Uint8Array;
  readonly iv: Uint8Array;
  readonly key: Uint8Array;
}): Uint8Array => {
  requireSize(input.key, 32);
  requireSize(input.iv, 12);
  requireSize(input.authenticationTag, 16);
  requireSize(input.ciphertext, 32);
  let plaintextChunk: Buffer | undefined;
  let finalChunk: Buffer | undefined;
  let plaintext: Buffer | undefined;

  try {
    const decipher = createDecipheriv('aes-256-gcm', input.key, input.iv, { authTagLength: 16 });
    decipher.setAAD(input.aad);
    decipher.setAuthTag(input.authenticationTag);
    plaintextChunk = decipher.update(input.ciphertext);
    finalChunk = decipher.final();
    plaintext = Buffer.concat([plaintextChunk, finalChunk]);
    requireSize(plaintext, 32);
    return Uint8Array.from(plaintext);
  } catch {
    throw new SeedCryptographyError();
  } finally {
    plaintextChunk?.fill(0);
    finalChunk?.fill(0);
    plaintext?.fill(0);
  }
};

export const serverSeedMatchesCommitment = (
  serverSeed: Uint8Array,
  commitmentHex: string,
): boolean => {
  if (!/^[0-9a-f]{64}$/u.test(commitmentHex)) return false;
  const actual = Buffer.from(commitServerSeed(serverSeed), 'hex');
  const expected = Buffer.from(commitmentHex, 'hex');
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
};
