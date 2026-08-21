import { describe, expect, it, vi } from 'vitest';

import { getApiEnvironment, getDatabaseEnvironment } from '../src/config/environment.js';

describe('API environment adapter', () => {
  it('reads and validates process.env at the configuration boundary', () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('AUTH_JWT_ISSUER', 'http://127.0.0.1:54321/auth/v1');
    vi.stubEnv('AUTH_JWKS_URL', 'http://127.0.0.1:54321/auth/v1/.well-known/jwks.json');
    vi.stubEnv('CORS_ALLOWED_ORIGINS', 'http://localhost:5173');
    vi.stubEnv('HOST', '127.0.0.1');
    vi.stubEnv('PORT', '4321');

    expect(getApiEnvironment()).toEqual({
      authAudience: 'authenticated',
      authIssuer: 'http://127.0.0.1:54321/auth/v1',
      authJwksUrl: 'http://127.0.0.1:54321/auth/v1/.well-known/jwks.json',
      authProvider: 'supabase',
      authRateLimitMax: 20,
      authRateLimitWindowMs: 60_000,
      corsAllowedOrigins: ['http://localhost:5173'],
      creatorMutationRateLimitMax: 60,
      creatorMutationRateLimitWindowMs: 60_000,
      host: '127.0.0.1',
      nodeEnvironment: 'test',
      port: 4321,
      requestBodyLimitBytes: 32_768,
    });

    vi.unstubAllEnvs();
  });

  it('reads database configuration through the same process boundary', () => {
    const connectionString = [
      'postgresql:',
      '//synthetic:',
      'local-only',
      '@database.example.test:5432/creatordrop',
    ].join('');
    vi.stubEnv('DATABASE_URL', connectionString);

    expect(getDatabaseEnvironment()).toMatchObject({
      applicationName: 'creatordrop',
      maxConnections: 10,
    });

    vi.unstubAllEnvs();
  });
});
