import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  buildFulfillmentActorBindingMessage,
  createEnvironmentFulfillmentActorBindingProvider,
} from '../src/modules/fulfillment/fulfillment.actor-binding.js';
import {
  buildFulfillmentAad,
  decryptFulfillmentValue,
  encryptFulfillmentValue,
  fingerprintFulfillmentCommand,
} from '../src/modules/fulfillment/fulfillment.crypto.js';
import {
  FulfillmentCryptographyError,
  FulfillmentKeyUnavailableError,
} from '../src/modules/fulfillment/fulfillment.errors.js';
import {
  createEnvironmentFulfillmentKeyProvider,
  deriveFulfillmentKeyIdentity,
} from '../src/modules/fulfillment/fulfillment.key-provider.js';

const bytes = (value: number, size: number): Uint8Array => new Uint8Array(size).fill(value);

const context = {
  creatorId: '019d0000-0000-7000-8000-000000000002',
  domain: 'address' as const,
  fulfillmentId: '019d0000-0000-7000-8000-000000000003',
  keyVersion: 'address-test-v1',
  userId: '019d0000-0000-7000-8000-000000000001',
};

describe('fulfillment authenticated encryption', () => {
  it('locks the purpose-bound AAD and round-trips variable-length UTF-8 data', () => {
    const aad = buildFulfillmentAad(context);
    expect(Buffer.from(aad).toString('utf8')).toBe(
      'creatordrop:fulfillment-data:v1|address|019d0000-0000-7000-8000-000000000003|' +
        '019d0000-0000-7000-8000-000000000002|019d0000-0000-7000-8000-000000000001|' +
        'address-test-v1',
    );
    const plaintext = new TextEncoder().encode('{"city":"Montréal"}');
    const encrypted = encryptFulfillmentValue({
      aad,
      ivSource: () => bytes(7, 12),
      key: bytes(9, 32),
      plaintext,
    });
    expect(encrypted.iv).toEqual(bytes(7, 12));
    expect(encrypted.authenticationTag).toHaveLength(16);
    expect(
      new TextDecoder().decode(
        decryptFulfillmentValue({
          aad,
          authenticationTag: encrypted.authenticationTag,
          ciphertext: encrypted.ciphertext,
          iv: encrypted.iv,
          key: bytes(9, 32),
        }),
      ),
    ).toBe('{"city":"Montréal"}');
  });

  it.each(['creatorId', 'userId', 'fulfillmentId', 'domain', 'keyVersion'] as const)(
    'rejects authentication when %s changes',
    (field) => {
      const aad = buildFulfillmentAad(context);
      const encrypted = encryptFulfillmentValue({
        aad,
        ivSource: () => bytes(7, 12),
        key: bytes(9, 32),
        plaintext: bytes(3, 20),
      });
      const changed = buildFulfillmentAad({
        ...context,
        [field]:
          field === 'domain'
            ? 'digital_secret'
            : field === 'keyVersion'
              ? 'address-test-v2'
              : '019d0000-0000-7000-8000-000000000099',
      });
      expect(() =>
        decryptFulfillmentValue({
          aad: changed,
          authenticationTag: encrypted.authenticationTag,
          ciphertext: encrypted.ciphertext,
          iv: encrypted.iv,
          key: bytes(9, 32),
        }),
      ).toThrow(FulfillmentCryptographyError);
    },
  );

  it('canonicalizes UUID case for AAD and actor-command identity', async () => {
    const upperContext = {
      ...context,
      creatorId: context.creatorId.toUpperCase(),
      fulfillmentId: context.fulfillmentId.toUpperCase(),
      userId: context.userId.toUpperCase(),
    };
    expect(buildFulfillmentAad(upperContext)).toEqual(buildFulfillmentAad(context));

    const provider = createEnvironmentFulfillmentActorBindingProvider({
      clock: () => new Date('2026-09-01T12:00:00.000Z'),
      keyHex: '33'.repeat(32),
      version: 'actor-test-v1',
    });
    expect(provider.keyIdentity).toBe(createHash('sha256').update(bytes(0x33, 32)).digest('hex'));
    expect(provider.keyVersion).toBe('actor-test-v1');
    const lowerInput = {
      actionKey: 'action-key-0001',
      actorUserId: context.userId,
      commandFingerprint: bytes(4, 32),
      commandName: 'deliver_digital',
      creatorId: context.creatorId,
      expectedRevision: 1,
      nonce: '019d0000-0000-7000-8000-000000000004',
      operation: 'fulfillment.deliver_digital' as const,
      quantity: null,
      resourceId: context.fulfillmentId,
    };
    const lower = await provider.bind(lowerInput);
    const upper = await provider.bind({
      ...lowerInput,
      actorUserId: lowerInput.actorUserId.toUpperCase(),
      creatorId: lowerInput.creatorId.toUpperCase(),
      nonce: lowerInput.nonce.toUpperCase(),
      resourceId: lowerInput.resourceId.toUpperCase(),
    });
    expect(upper).toEqual(lower);
    expect(
      buildFulfillmentActorBindingMessage({
        ...lowerInput,
        expiresAtMs: lower.expiresAtMs,
        keyVersion: lower.keyVersion,
      }),
    ).toContain(`|${context.creatorId}|${context.fulfillmentId}|`);
  });

  it.each(['ciphertext', 'iv', 'authenticationTag'] as const)(
    'rejects independently tampered %s bytes',
    (field) => {
      const aad = buildFulfillmentAad(context);
      const encrypted = encryptFulfillmentValue({
        aad,
        ivSource: () => bytes(7, 12),
        key: bytes(9, 32),
        plaintext: bytes(3, 20),
      });
      const changed = Uint8Array.from(encrypted[field]);
      changed[0] = (changed[0] ?? 0) ^ 1;
      expect(() =>
        decryptFulfillmentValue({
          aad,
          authenticationTag: field === 'authenticationTag' ? changed : encrypted.authenticationTag,
          ciphertext: field === 'ciphertext' ? changed : encrypted.ciphertext,
          iv: field === 'iv' ? changed : encrypted.iv,
          key: bytes(9, 32),
        }),
      ).toThrow(FulfillmentCryptographyError);
    },
  );

  it('uses separate domains, retained historical versions, and defensive key copies', async () => {
    const provider = createEnvironmentFulfillmentKeyProvider({
      address: {
        historicalKeys: { 'address-test-v0': '03'.repeat(32) },
        keyHex: '01'.repeat(32),
        version: 'address-test-v1',
      },
      digitalSecret: { keyHex: '02'.repeat(32), version: 'digital-test-v1' },
    });
    const active = await provider.getActiveKey('address');
    expect(deriveFulfillmentKeyIdentity(active.key)).toHaveLength(64);
    active.key.fill(0);
    expect((await provider.getActiveKey('address')).key).toEqual(bytes(1, 32));
    expect((await provider.getKey('address', 'address-test-v0')).key).toEqual(bytes(3, 32));
    await expect(provider.getKey('digital_secret', 'address-test-v1')).rejects.toThrow(
      FulfillmentKeyUnavailableError,
    );
  });

  it('uses a deterministic keyed, domain-separated sensitive-command fingerprint', () => {
    const canonicalCommand = '{"action":"deliver_digital","secret":"short-code"}';
    const first = fingerprintFulfillmentCommand({
      canonicalCommand,
      domain: 'digital_secret',
      key: bytes(9, 32),
    });
    expect(first).toEqual(
      fingerprintFulfillmentCommand({
        canonicalCommand,
        domain: 'digital_secret',
        key: bytes(9, 32),
      }),
    );
    expect(first).not.toEqual(
      fingerprintFulfillmentCommand({
        canonicalCommand,
        domain: 'address',
        key: bytes(9, 32),
      }),
    );
    expect(Buffer.from(first).toString('hex')).not.toBe(
      createHash('sha256').update(canonicalCommand).digest('hex'),
    );
  });

  it('rejects malformed or reused key material and malformed crypto sizes', () => {
    expect(() =>
      createEnvironmentFulfillmentKeyProvider({
        address: { keyHex: '01'.repeat(32), version: 'address-v1' },
        digitalSecret: { keyHex: '01'.repeat(32), version: 'digital-v1' },
      }),
    ).toThrow(FulfillmentCryptographyError);
    expect(() =>
      encryptFulfillmentValue({
        aad: bytes(1, 1),
        key: bytes(1, 31),
        plaintext: bytes(2, 1),
      }),
    ).toThrow(FulfillmentCryptographyError);
  });
});
