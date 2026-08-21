import { randomUUID } from 'node:crypto';

import type { RequestHandler } from 'express';

const trustedRequestIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,63}$/u;

export const isTrustedRequestId = (value: string): boolean => trustedRequestIdPattern.test(value);

export const requestIdMiddleware = (): RequestHandler => (request, response, next) => {
  const proposedRequestId = request.get('x-request-id');
  const requestId =
    proposedRequestId !== undefined && isTrustedRequestId(proposedRequestId)
      ? proposedRequestId
      : randomUUID();

  request.requestId = requestId;
  response.setHeader('X-Request-Id', requestId);
  next();
};
