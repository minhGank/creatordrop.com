import { createHash, createHmac } from 'node:crypto';

import { RngError } from './errors.js';
import type { DigestSource } from './types.js';
import {
  parseCanonicalNonnegativeInteger,
  requireCanonicalUuid,
  requireLowercaseHex256,
} from './validation.js';

export const parseClientSeed = (value: unknown): string =>
  requireLowercaseHex256(value, 'INVALID_CLIENT_SEED');

export const parseSeedSetId = (value: unknown): string =>
  requireCanonicalUuid(value, 'INVALID_SEED_SET_ID');

export const parseNonce = (value: unknown): bigint =>
  parseCanonicalNonnegativeInteger(value, 'INVALID_NONCE');

export const parseServerSeed = (value: unknown): Uint8Array => {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
    throw new RngError('INVALID_SERVER_SEED');
  }
  return Uint8Array.from(value);
};

export const digestToHex = (digest: Uint8Array): string => {
  if (!(digest instanceof Uint8Array) || digest.byteLength !== 32) {
    throw new RngError('INVALID_DIGEST');
  }
  return Buffer.from(digest).toString('hex');
};

export const digestToUnsignedBigint = (digest: Uint8Array): bigint =>
  BigInt(`0x${digestToHex(digest)}`);

export const sha256Hex = (value: Uint8Array): string =>
  createHash('sha256').update(value).digest('hex');

export const hmacSha256 = (key: Uint8Array, message: string): Uint8Array =>
  Uint8Array.from(createHmac('sha256', key).update(message, 'utf8').digest());

export const buildHmacMessage = (
  seedSetIdInput: unknown,
  clientSeedInput: unknown,
  nonceInput: unknown,
  round: bigint,
): string => {
  const seedSetId = parseSeedSetId(seedSetIdInput);
  const clientSeed = parseClientSeed(clientSeedInput);
  const nonce = parseNonce(nonceInput);
  if (typeof round !== 'bigint' || round < 0n) throw new RngError('INVALID_NONCE');
  return `creatordrop:rng:v1|${seedSetId}|${clientSeed}|${nonce.toString()}|${round.toString()}`;
};

export const createHmacSha256DigestSource = (input: {
  readonly clientSeed: unknown;
  readonly nonce: unknown;
  readonly seedSetId: unknown;
  readonly serverSeed: unknown;
}): DigestSource => {
  const serverSeed = parseServerSeed(input.serverSeed);
  const clientSeed = parseClientSeed(input.clientSeed);
  const seedSetId = parseSeedSetId(input.seedSetId);
  const nonce = parseNonce(input.nonce).toString();
  return (round) => {
    const message = buildHmacMessage(seedSetId, clientSeed, nonce, round);
    return hmacSha256(serverSeed, message);
  };
};

export const hashServerSeed = (serverSeedInput: unknown): string => {
  const serverSeed = parseServerSeed(serverSeedInput);
  return sha256Hex(serverSeed);
};
