import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { createAuthenticationMiddleware } from '../src/modules/auth/authentication.middleware.js';
import type { VerifyAccessToken } from '../src/modules/auth/authentication.js';
import type { UserBootstrapService } from '../src/modules/users/bootstrap-user.service.js';
import { InactiveUserError } from '../src/modules/users/user.js';
import { createTestApp } from './support/test-app.js';

const identity = { provider: 'supabase', subject: 'synthetic-subject' } as const;
const activeUser = {
  id: '019c0000-0000-7000-8000-000000000001',
  status: 'active',
  username: 'synthetic_user',
} as const;

const createAuthentication = (
  verifyAccessToken: VerifyAccessToken,
  bootstrapUsers: UserBootstrapService,
) => createAuthenticationMiddleware({ bootstrapUsers, verifyAccessToken });

describe('authentication middleware', () => {
  it('derives the local actor from the bearer token and bootstrap service', async () => {
    const verifyAccessToken = vi.fn<VerifyAccessToken>().mockResolvedValue(identity);
    const bootstrap = vi.fn<UserBootstrapService['bootstrap']>().mockResolvedValue(activeUser);
    const response = await request(
      createTestApp({
        authenticate: createAuthentication(verifyAccessToken, { bootstrap }),
      }),
    )
      .post('/v1/auth/session/exchange')
      .set('Authorization', 'Bearer synthetic.jwt.value')
      .send({});

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ user: activeUser });
    expect(verifyAccessToken).toHaveBeenCalledWith('synthetic.jwt.value');
    expect(bootstrap).toHaveBeenCalledWith(identity);
  });

  it.each([undefined, 'Basic synthetic', 'Bearer multiple tokens', 'Bearer one,two'])(
    'returns 401 for a missing or malformed authorization value: %s',
    async (authorization) => {
      const verifyAccessToken = vi.fn<VerifyAccessToken>();
      const bootstrap = vi.fn<UserBootstrapService['bootstrap']>();
      let pendingRequest = request(
        createTestApp({
          authenticate: createAuthentication(verifyAccessToken, { bootstrap }),
        }),
      ).post('/v1/auth/session/exchange');

      if (authorization !== undefined) {
        pendingRequest = pendingRequest.set('Authorization', authorization);
      }

      const response = await pendingRequest.send({});

      expect(response.status).toBe(401);
      expect(response.body).toMatchObject({ error: { code: 'AUTHENTICATION_REQUIRED' } });
      expect(verifyAccessToken).not.toHaveBeenCalled();
      expect(bootstrap).not.toHaveBeenCalled();
    },
  );

  it('returns 401 when cryptographic verification fails', async () => {
    const verifyAccessToken = vi
      .fn<VerifyAccessToken>()
      .mockRejectedValue(new Error('synthetic verifier detail'));
    const bootstrap = vi.fn<UserBootstrapService['bootstrap']>();
    const response = await request(
      createTestApp({
        authenticate: createAuthentication(verifyAccessToken, { bootstrap }),
      }),
    )
      .post('/v1/auth/session/exchange')
      .set('Authorization', 'Bearer invalid.jwt.value')
      .send({});

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ error: { code: 'AUTHENTICATION_REQUIRED' } });
    expect(bootstrap).not.toHaveBeenCalled();
    expect(JSON.stringify(response.body)).not.toContain('synthetic verifier detail');
  });

  it.each(['suspended', 'closed'] as const)('returns 403 for a %s local user', async (status) => {
    const verifyAccessToken = vi.fn<VerifyAccessToken>().mockResolvedValue(identity);
    const bootstrap = vi
      .fn<UserBootstrapService['bootstrap']>()
      .mockRejectedValue(new InactiveUserError(status));
    const response = await request(
      createTestApp({
        authenticate: createAuthentication(verifyAccessToken, { bootstrap }),
      }),
    )
      .post('/v1/auth/session/exchange')
      .set('Authorization', 'Bearer synthetic.jwt.value')
      .send({});

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ error: { code: 'ACCOUNT_NOT_ACTIVE' } });
  });
});
