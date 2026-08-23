import { createHash } from 'node:crypto';

import { SeedCryptographyError, SeedEncryptionKeyUnavailableError } from './fairness.errors.js';

export interface SeedEncryptionKey {
  readonly key: Uint8Array;
  readonly version: string;
}

export interface SeedEncryptionKeyProvider {
  getActiveEncryptionKey(): Promise<SeedEncryptionKey>;
  getEncryptionKey(version: string): Promise<SeedEncryptionKey>;
}

const keyVersionPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const keyHexPattern = /^[0-9a-f]{64}$/u;

export const deriveSeedEncryptionKeyIdentity = (key: Uint8Array): string => {
  if (!(key instanceof Uint8Array) || key.byteLength !== 32) {
    throw new SeedCryptographyError();
  }
  return createHash('sha256').update(key).digest('hex');
};

export const createEnvironmentSeedEncryptionKeyProvider = (input: {
  readonly historicalKeys?: Readonly<Record<string, string>>;
  readonly keyHex: string;
  readonly version: string;
}): SeedEncryptionKeyProvider => {
  if (!keyHexPattern.test(input.keyHex) || !keyVersionPattern.test(input.version)) {
    throw new SeedCryptographyError();
  }
  const keys = new Map<string, Uint8Array>();
  const keyMaterials = new Set<string>();
  const addKey = (version: string, keyHex: string): void => {
    if (
      !keyHexPattern.test(keyHex) ||
      !keyVersionPattern.test(version) ||
      keys.has(version) ||
      keyMaterials.has(keyHex)
    ) {
      throw new SeedCryptographyError();
    }
    const key = Uint8Array.from(Buffer.from(keyHex, 'hex'));
    if (key.byteLength !== 32) throw new SeedCryptographyError();
    keys.set(version, key);
    keyMaterials.add(keyHex);
  };
  addKey(input.version, input.keyHex);
  for (const [version, keyHex] of Object.entries(input.historicalKeys ?? {})) {
    addKey(version, keyHex);
  }

  const material = (version: string): SeedEncryptionKey => {
    const key = keys.get(version);
    if (key === undefined) throw new SeedEncryptionKeyUnavailableError();
    return { key: Uint8Array.from(key), version };
  };

  return {
    getActiveEncryptionKey: () => Promise.resolve(material(input.version)),
    getEncryptionKey: (version) => {
      try {
        return Promise.resolve(material(version));
      } catch (error) {
        return Promise.reject(
          error instanceof Error ? error : new SeedEncryptionKeyUnavailableError(),
        );
      }
    },
  };
};
