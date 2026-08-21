import type { RequestHandler } from 'express';

import { accountNotActive, authenticationRequired } from '../../http/errors.js';
import type { UserBootstrapService } from '../users/bootstrap-user.service.js';
import { InactiveUserError } from '../users/user.js';
import type { VerifyAccessToken } from './authentication.js';

export interface AuthenticationMiddlewareOptions {
  readonly bootstrapUsers: UserBootstrapService;
  readonly verifyAccessToken: VerifyAccessToken;
}

const bearerTokenPattern = /^Bearer (?<token>[^\s,]+)$/u;
const maximumAccessTokenLength = 8_192;

const readBearerToken = (authorization: string | undefined): string | undefined => {
  if (authorization === undefined || authorization.length > maximumAccessTokenLength) {
    return undefined;
  }

  return bearerTokenPattern.exec(authorization)?.groups?.token;
};

export const createAuthenticationMiddleware =
  ({ bootstrapUsers, verifyAccessToken }: AuthenticationMiddlewareOptions): RequestHandler =>
  async (request, _response, next) => {
    const accessToken = readBearerToken(request.get('authorization'));

    if (accessToken === undefined) {
      next(authenticationRequired());
      return;
    }

    let identity;

    try {
      identity = await verifyAccessToken(accessToken);
    } catch {
      next(authenticationRequired());
      return;
    }

    try {
      const user = await bootstrapUsers.bootstrap(identity);

      request.actor = {
        provider: identity.provider,
        subject: identity.subject,
        user: { ...user, status: 'active' },
      };
      next();
    } catch (error) {
      if (error instanceof InactiveUserError) {
        next(accountNotActive());
        return;
      }

      next(error);
    }
  };
