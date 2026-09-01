import { createHash } from 'node:crypto';

import {
  FulfillmentCryptographyError,
  FulfillmentKeyUnavailableError,
} from './fulfillment.errors.js';
import type { FulfillmentEncryptionDomain } from './fulfillment.js';

export interface FulfillmentEncryptionKey {
  readonly key: Uint8Array;
  readonly version: string;
}

export interface FulfillmentEncryptionKeyProvider {
  getActiveKey(domain: FulfillmentEncryptionDomain): Promise<FulfillmentEncryptionKey>;
  getKey(domain: FulfillmentEncryptionDomain, version: string): Promise<FulfillmentEncryptionKey>;
}

const keyPattern = /^[0-9a-f]{64}$/u;
const versionPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

export const deriveFulfillmentKeyIdentity = (key: Uint8Array): string => {
  if (!(key instanceof Uint8Array) || key.byteLength !== 32) {
    throw new FulfillmentCryptographyError();
  }
  return createHash('sha256').update(key).digest('hex');
};

export const createEnvironmentFulfillmentKeyProvider = (
  input: Readonly<{
    address: Readonly<{
      historicalKeys?: Readonly<Record<string, string>>;
      keyHex: string;
      version: string;
    }>;
    digitalSecret: Readonly<{
      historicalKeys?: Readonly<Record<string, string>>;
      keyHex: string;
      version: string;
    }>;
  }>,
): FulfillmentEncryptionKeyProvider => {
  const keys = new Map<FulfillmentEncryptionDomain, Map<string, Uint8Array>>();
  const active = new Map<FulfillmentEncryptionDomain, string>();
  const material = new Set<string>();
  const addDomain = (
    domain: FulfillmentEncryptionDomain,
    config: {
      readonly historicalKeys?: Readonly<Record<string, string>>;
      readonly keyHex: string;
      readonly version: string;
    },
  ): void => {
    const domainKeys = new Map<string, Uint8Array>();
    const add = (version: string, keyHex: string): void => {
      if (
        !versionPattern.test(version) ||
        !keyPattern.test(keyHex) ||
        domainKeys.has(version) ||
        material.has(keyHex)
      ) {
        throw new FulfillmentCryptographyError();
      }
      const decoded = Uint8Array.from(Buffer.from(keyHex, 'hex'));
      if (decoded.byteLength !== 32) throw new FulfillmentCryptographyError();
      domainKeys.set(version, decoded);
      material.add(keyHex);
    };
    add(config.version, config.keyHex);
    for (const [version, keyHex] of Object.entries(config.historicalKeys ?? {}))
      add(version, keyHex);
    keys.set(domain, domainKeys);
    active.set(domain, config.version);
  };
  addDomain('address', input.address);
  addDomain('digital_secret', input.digitalSecret);

  const read = (domain: FulfillmentEncryptionDomain, version: string): FulfillmentEncryptionKey => {
    const key = keys.get(domain)?.get(version);
    if (key === undefined) throw new FulfillmentKeyUnavailableError();
    return { key: Uint8Array.from(key), version };
  };
  return {
    getActiveKey: (domain) => {
      try {
        const version = active.get(domain);
        if (version === undefined) throw new FulfillmentKeyUnavailableError();
        return Promise.resolve(read(domain, version));
      } catch (error) {
        return Promise.reject(
          error instanceof Error ? error : new FulfillmentKeyUnavailableError(),
        );
      }
    },
    getKey: (domain, version) => {
      try {
        return Promise.resolve(read(domain, version));
      } catch (error) {
        return Promise.reject(
          error instanceof Error ? error : new FulfillmentKeyUnavailableError(),
        );
      }
    },
  };
};
