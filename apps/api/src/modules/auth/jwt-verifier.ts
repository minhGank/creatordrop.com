import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey, type JWTPayload } from 'jose';

import type { VerifyAccessToken } from './authentication.js';

export interface JwtVerifierOptions {
  readonly audience: string;
  readonly issuer: string;
  readonly jwksUrl: string;
  readonly provider: string;
}

const isValidSubject = (subject: unknown): subject is string =>
  typeof subject === 'string' &&
  subject.length >= 1 &&
  subject.length <= 255 &&
  !Array.from(subject).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  });

const requireIdentityClaims = (payload: JWTPayload): string => {
  if (!isValidSubject(payload.sub) || !Number.isInteger(payload.exp)) {
    throw new Error('The verified token is missing required identity claims.');
  }

  return payload.sub;
};

export const createJwtVerifier =
  (
    options: JwtVerifierOptions,
    keyResolver: JWTVerifyGetKey = createRemoteJWKSet(new URL(options.jwksUrl)),
  ): VerifyAccessToken =>
  async (accessToken) => {
    const { payload } = await jwtVerify(accessToken, keyResolver, {
      algorithms: ['ES256', 'RS256'],
      audience: options.audience,
      issuer: options.issuer,
    });

    return {
      provider: options.provider,
      subject: requireIdentityClaims(payload),
    };
  };
