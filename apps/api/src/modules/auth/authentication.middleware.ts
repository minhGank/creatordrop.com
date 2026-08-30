import type { RequestHandler } from 'express';

import { accountNotActive, authenticationRequired } from '../../http/errors.js';
import type { UserBootstrapService } from '../users/bootstrap-user.service.js';
import { InactiveUserError } from '../users/user.js';
import type { AuthenticateAccessToken, VerifyAccessToken } from './authentication.js';

export interface AuthenticationMiddlewareOptions {
  readonly bootstrapUsers: UserBootstrapService;
  readonly verifyAccessToken: VerifyAccessToken;
}

const bearerTokenPattern = /^Bearer (?<token>[^\s,]+)$/u;
const maximumAccessTokenLength = 8_192;

class AccessTokenAuthenticationError extends Error {
  constructor() {
    super('The access token could not be authenticated.');
    this.name = 'AccessTokenAuthenticationError';
  }
}

const readBearerToken = (authorization: string | undefined): string | undefined => {
  if (authorization === undefined || authorization.length > maximumAccessTokenLength) {
    return undefined;
  }

  return bearerTokenPattern.exec(authorization)?.groups?.token;
};

export const createAccessTokenAuthenticator =
  ({
    bootstrapUsers,
    verifyAccessToken,
  }: AuthenticationMiddlewareOptions): AuthenticateAccessToken =>
  async (accessToken) => {
    let identity;
    try {
      identity = await verifyAccessToken(accessToken);
    } catch {
      throw new AccessTokenAuthenticationError();
    }
    const user = await bootstrapUsers.bootstrap(identity);
    if (user.status !== 'active') throw new InactiveUserError(user.status);
    return {
      provider: identity.provider,
      subject: identity.subject,
      user: { ...user, status: 'active' },
    };
  };

export const createAuthenticationMiddleware = (
  options: AuthenticationMiddlewareOptions,
): RequestHandler => {
  const authenticateAccessToken = createAccessTokenAuthenticator(options);
  return async (request, _response, next) => {
    const accessToken = readBearerToken(request.get('authorization'));

    if (accessToken === undefined) {
      next(authenticationRequired());
      return;
    }

    try {
      request.actor = await authenticateAccessToken(accessToken);
      next();
    } catch (error) {
      if (error instanceof AccessTokenAuthenticationError) {
        next(authenticationRequired());
        return;
      }
      if (error instanceof InactiveUserError) {
        next(accountNotActive());
        return;
      }

      next(error);
    }
  };
};
