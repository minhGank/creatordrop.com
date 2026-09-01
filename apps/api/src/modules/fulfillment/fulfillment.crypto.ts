import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

import { canonicalFulfillmentUuid } from './fulfillment.actor-binding.js';
import { FulfillmentCryptographyError } from './fulfillment.errors.js';
import type { FulfillmentEncryptionContext } from './fulfillment.js';

export interface EncryptedFulfillmentValue {
  readonly authenticationTag: Uint8Array;
  readonly ciphertext: Uint8Array;
  readonly iv: Uint8Array;
}

export const buildFulfillmentAad = (context: FulfillmentEncryptionContext): Uint8Array => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(context.keyVersion)) {
    throw new FulfillmentCryptographyError();
  }
  return new TextEncoder().encode(
    `creatordrop:fulfillment-data:v1|${context.domain}|${canonicalFulfillmentUuid(context.fulfillmentId)}|${canonicalFulfillmentUuid(context.creatorId)}|${canonicalFulfillmentUuid(context.userId)}|${context.keyVersion}`,
  );
};

const sized = (value: unknown, size: number): value is Uint8Array =>
  value instanceof Uint8Array && value.byteLength === size;

export const fingerprintFulfillmentCommand = (input: {
  readonly canonicalCommand: string;
  readonly domain: 'address' | 'digital_secret';
  readonly key: Uint8Array;
}): Uint8Array => {
  if (
    !sized(input.key, 32) ||
    input.canonicalCommand.length < 1 ||
    input.canonicalCommand.length > 16_384
  ) {
    throw new FulfillmentCryptographyError();
  }
  const fingerprintKey = createHmac('sha256', input.key)
    .update(`creatordrop:fulfillment-command-fingerprint-key:v1|${input.domain}`, 'utf8')
    .digest();
  try {
    return Uint8Array.from(
      createHmac('sha256', fingerprintKey).update(input.canonicalCommand, 'utf8').digest(),
    );
  } finally {
    fingerprintKey.fill(0);
  }
};

export const encryptFulfillmentValue = (input: {
  readonly aad: Uint8Array;
  readonly ivSource?: (size: number) => Uint8Array;
  readonly key: Uint8Array;
  readonly plaintext: Uint8Array;
}): EncryptedFulfillmentValue => {
  if (
    !sized(input.key, 32) ||
    input.plaintext.byteLength < 1 ||
    input.plaintext.byteLength > 8192
  ) {
    throw new FulfillmentCryptographyError();
  }
  const generatedIv = (input.ivSource ?? randomBytes)(12);
  let ciphertext: Buffer | undefined;
  let authenticationTag: Buffer | undefined;
  try {
    if (!sized(generatedIv, 12)) throw new FulfillmentCryptographyError();
    const cipher = createCipheriv('aes-256-gcm', input.key, generatedIv, { authTagLength: 16 });
    cipher.setAAD(input.aad);
    ciphertext = Buffer.concat([cipher.update(input.plaintext), cipher.final()]);
    authenticationTag = cipher.getAuthTag();
    return {
      authenticationTag: Uint8Array.from(authenticationTag),
      ciphertext: Uint8Array.from(ciphertext),
      iv: Uint8Array.from(generatedIv),
    };
  } catch {
    throw new FulfillmentCryptographyError();
  } finally {
    generatedIv.fill(0);
    ciphertext?.fill(0);
    authenticationTag?.fill(0);
  }
};

export const decryptFulfillmentValue = (input: {
  readonly aad: Uint8Array;
  readonly authenticationTag: Uint8Array;
  readonly ciphertext: Uint8Array;
  readonly iv: Uint8Array;
  readonly key: Uint8Array;
}): Uint8Array => {
  if (
    !sized(input.key, 32) ||
    !sized(input.iv, 12) ||
    !sized(input.authenticationTag, 16) ||
    input.ciphertext.byteLength < 1 ||
    input.ciphertext.byteLength > 8192
  ) {
    throw new FulfillmentCryptographyError();
  }
  let first: Buffer | undefined;
  let last: Buffer | undefined;
  let plaintext: Buffer | undefined;
  try {
    const decipher = createDecipheriv('aes-256-gcm', input.key, input.iv, { authTagLength: 16 });
    decipher.setAAD(input.aad);
    decipher.setAuthTag(input.authenticationTag);
    first = decipher.update(input.ciphertext);
    last = decipher.final();
    plaintext = Buffer.concat([first, last]);
    return Uint8Array.from(plaintext);
  } catch {
    throw new FulfillmentCryptographyError();
  } finally {
    first?.fill(0);
    last?.fill(0);
    plaintext?.fill(0);
  }
};
