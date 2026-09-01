import { createHash, createHmac } from 'node:crypto';

import { validate as isUuid } from 'uuid';

import { FulfillmentCryptographyError } from './fulfillment.errors.js';

export const fulfillmentActorOperations = [
  'fulfillment.submit_address',
  'fulfillment.creator_action',
  'fulfillment.deliver_digital',
  'fulfillment.redact_user',
  'fulfillment.redact_creator',
  'fulfillment.read_user',
  'fulfillment.read_creator',
  'inventory.restock',
] as const;

export type FulfillmentActorOperation = (typeof fulfillmentActorOperations)[number];

export interface FulfillmentActorBindingInput {
  readonly actionKey: string | null;
  readonly actorUserId: string;
  readonly commandFingerprint: Uint8Array | null;
  readonly commandName: string;
  readonly creatorId: string | null;
  readonly expectedRevision: number | null;
  readonly nonce: string;
  readonly operation: FulfillmentActorOperation;
  readonly quantity: bigint | null;
  readonly resourceId: string;
}

export interface FulfillmentActorBinding {
  readonly expiresAtMs: string;
  readonly keyVersion: string;
  readonly signature: Uint8Array;
}

export interface FulfillmentActorBindingProvider {
  readonly keyIdentity: string;
  readonly keyVersion: string;
  bind(input: FulfillmentActorBindingInput): Promise<FulfillmentActorBinding>;
}

const keyPattern = /^[0-9a-f]{64}$/u;
const versionPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const safeTokenPattern = /^[A-Za-z0-9._:-]{1,128}$/u;

export const canonicalFulfillmentUuid = (value: string): string => {
  if (!isUuid(value)) throw new FulfillmentCryptographyError();
  return value.toLowerCase();
};

const nullable = (value: string | null): string => value ?? '-';

export const buildFulfillmentActorBindingMessage = (
  input: FulfillmentActorBindingInput & {
    readonly expiresAtMs: string;
    readonly keyVersion: string;
  },
): string => {
  if (
    !versionPattern.test(input.keyVersion) ||
    !fulfillmentActorOperations.includes(input.operation) ||
    !safeTokenPattern.test(input.commandName) ||
    (input.actionKey !== null && !safeTokenPattern.test(input.actionKey)) ||
    (input.expectedRevision !== null &&
      (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision <= 0)) ||
    (input.quantity !== null && input.quantity <= 0n) ||
    !/^[1-9][0-9]*$/u.test(input.expiresAtMs) ||
    (input.commandFingerprint !== null && input.commandFingerprint.byteLength !== 32)
  ) {
    throw new FulfillmentCryptographyError();
  }
  const actorUserId = canonicalFulfillmentUuid(input.actorUserId);
  const creatorId = input.creatorId === null ? null : canonicalFulfillmentUuid(input.creatorId);
  const nonce = canonicalFulfillmentUuid(input.nonce);
  const resourceId = canonicalFulfillmentUuid(input.resourceId);
  const fingerprint =
    input.commandFingerprint === null
      ? null
      : Buffer.from(input.commandFingerprint).toString('hex');
  return [
    'creatordrop:fulfillment-actor-binding:v1',
    input.keyVersion,
    actorUserId,
    input.operation,
    nullable(creatorId),
    resourceId,
    nonce,
    input.expectedRevision?.toString() ?? '-',
    nullable(input.actionKey),
    input.commandName,
    nullable(fingerprint),
    input.quantity?.toString() ?? '-',
    input.expiresAtMs,
  ].join('|');
};

export const createEnvironmentFulfillmentActorBindingProvider = (input: {
  readonly clock?: () => Date;
  readonly keyHex: string;
  readonly ttlMs?: number;
  readonly version: string;
}): FulfillmentActorBindingProvider => {
  const { clock = () => new Date(), ttlMs = 30_000 } = input;
  if (
    !keyPattern.test(input.keyHex) ||
    !versionPattern.test(input.version) ||
    !Number.isSafeInteger(ttlMs) ||
    ttlMs < 1_000 ||
    ttlMs > 60_000
  ) {
    throw new FulfillmentCryptographyError();
  }
  const key = Buffer.from(input.keyHex, 'hex');
  const keyIdentity = createHash('sha256').update(key).digest('hex');
  return {
    bind: (bindingInput) => {
      const expiresAtMs = (BigInt(clock().getTime()) + BigInt(ttlMs)).toString();
      const message = buildFulfillmentActorBindingMessage({
        ...bindingInput,
        expiresAtMs,
        keyVersion: input.version,
      });
      return Promise.resolve({
        expiresAtMs,
        keyVersion: input.version,
        signature: Uint8Array.from(createHmac('sha256', key).update(message, 'utf8').digest()),
      });
    },
    keyIdentity,
    keyVersion: input.version,
  };
};
