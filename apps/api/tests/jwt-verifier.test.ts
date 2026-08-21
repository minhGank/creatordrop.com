import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type JSONWebKeySet,
  type JWTPayload,
} from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';

import { createJwtVerifier } from '../src/modules/auth/jwt-verifier.js';

const issuer = 'https://auth.example.test/auth/v1';
const audience = 'authenticated';
const keyId = 'synthetic-test-key';

let privateKey: CryptoKey;
let otherPrivateKey: CryptoKey;
let publicJwks: JSONWebKeySet;

beforeAll(async () => {
  const primaryKeys = await generateKeyPair('ES256');
  const otherKeys = await generateKeyPair('ES256');
  const publicKey = await exportJWK(primaryKeys.publicKey);

  privateKey = primaryKeys.privateKey;
  otherPrivateKey = otherKeys.privateKey;
  publicJwks = { keys: [{ ...publicKey, alg: 'ES256', kid: keyId, use: 'sig' }] };
});

const signToken = async (
  overrides: JWTPayload = {},
  signingKey: CryptoKey = privateKey,
): Promise<string> => {
  const now = Math.floor(Date.now() / 1000);
  const payload: JWTPayload = {
    aud: audience,
    exp: now + 300,
    iat: now,
    iss: issuer,
    sub: 'synthetic-auth-subject',
    ...overrides,
  };

  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'ES256', kid: keyId, typ: 'JWT' })
    .sign(signingKey);
};

const createVerifier = () =>
  createJwtVerifier(
    {
      audience,
      issuer,
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      provider: 'supabase',
    },
    createLocalJWKSet(publicJwks),
  );

describe('Supabase JWT verifier', () => {
  it('returns only trusted identity claims from a valid token', async () => {
    await expect(createVerifier()(await signToken())).resolves.toEqual({
      provider: 'supabase',
      subject: 'synthetic-auth-subject',
    });
  });

  it('rejects a token signed by an untrusted key', async () => {
    await expect(createVerifier()(await signToken({}, otherPrivateKey))).rejects.toThrow();
  });

  it.each([
    ['issuer', { iss: 'https://attacker.example.test/auth/v1' }],
    ['audience', { aud: 'wrong-audience' }],
    ['expiry', { exp: Math.floor(Date.now() / 1000) - 1 }],
    ['not-before', { nbf: Math.floor(Date.now() / 1000) + 300 }],
    ['subject', { sub: '' }],
  ])('rejects an invalid %s claim', async (_claim, overrides) => {
    await expect(createVerifier()(await signToken(overrides))).rejects.toThrow();
  });

  it('requires an explicit expiry claim', async () => {
    const token = await new SignJWT({
      aud: audience,
      iss: issuer,
      sub: 'synthetic-auth-subject',
    })
      .setProtectedHeader({ alg: 'ES256', kid: keyId, typ: 'JWT' })
      .sign(privateKey);

    await expect(createVerifier()(token)).rejects.toThrow();
  });
});
