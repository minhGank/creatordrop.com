import { describe, expect, it } from 'vitest';

import { parseWebEnvironment } from '../src/config/environment.js';

const legacyKey = (role: string): string =>
  [
    btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' })),
    btoa(JSON.stringify({ role })),
    'synthetic-signature',
  ]
    .map((segment) => segment.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, ''))
    .join('.');

describe('web environment configuration', () => {
  it('parses public build-time configuration', () => {
    expect(
      parseWebEnvironment({
        VITE_API_BASE_URL: 'https://api.example.test',
        VITE_APP_ENV: 'test',
        VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_public_test_key',
        VITE_SUPABASE_URL: 'https://project.supabase.co',
      }),
    ).toEqual({
      apiBaseUrl: 'https://api.example.test',
      appEnvironment: 'test',
      supabasePublishableKey: 'sb_publishable_public_test_key',
      supabaseUrl: 'https://project.supabase.co',
    });
  });

  it('rejects malformed public configuration', () => {
    expect(() => parseWebEnvironment({ VITE_API_BASE_URL: 'not-a-url' })).toThrow();
  });

  it('rejects secret and legacy service-role keys while accepting a legacy anon key', () => {
    const input = {
      VITE_API_BASE_URL: 'https://api.example.test',
      VITE_APP_ENV: 'production',
      VITE_SUPABASE_URL: 'https://project.supabase.co',
    } as const;
    expect(() =>
      parseWebEnvironment({
        ...input,
        VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_secret_synthetic_do_not_use',
      }),
    ).toThrow(/publishable or anon/iu);
    expect(() =>
      parseWebEnvironment({
        ...input,
        VITE_SUPABASE_PUBLISHABLE_KEY: legacyKey('service_role'),
      }),
    ).toThrow(/publishable or anon/iu);
    expect(
      parseWebEnvironment({
        ...input,
        VITE_SUPABASE_PUBLISHABLE_KEY: legacyKey('anon'),
      }).supabasePublishableKey,
    ).toBe(legacyKey('anon'));
  });
});
