import { describe, expect, it } from 'vitest';
import { parseEntryStorageEnvironment } from '../src/index.js';

const valid = {
  AUTH_JWT_ISSUER: 'http://127.0.0.1:54321/auth/v1',
  ENTRY_STORAGE_URL: 'http://127.0.0.1:54321/storage/v1',
  ENTRY_STORAGE_PUBLISHABLE_KEY: 'sb_publishable_SYNTHETIC_TEST_ONLY',
};
// Construct a deliberately invalid synthetic URL without a credential-shaped literal.
const credentialUrl = new URL(valid.ENTRY_STORAGE_URL);
credentialUrl.username = 'synthetic-user';
credentialUrl.password = 'synthetic-password';
describe('private evidence Storage configuration', () => {
  it('accepts a local or HTTPS same-origin publishable-key configuration', () => {
    expect(parseEntryStorageEnvironment(valid)).toEqual({
      url: valid.ENTRY_STORAGE_URL,
      publishableKey: valid.ENTRY_STORAGE_PUBLISHABLE_KEY,
    });
    expect(
      parseEntryStorageEnvironment({
        ...valid,
        AUTH_JWT_ISSUER: 'https://supabase.example.test/auth/v1',
        ENTRY_STORAGE_URL: 'https://supabase.example.test/storage/v1',
      }).url,
    ).toBe('https://supabase.example.test/storage/v1');
  });
  it.each([
    { AUTH_PROVIDER: 'unrelated-provider' },
    { ENTRY_STORAGE_URL: 'https://attacker.example.test/storage/v1' },
    { ENTRY_STORAGE_URL: 'http://127.0.0.1:54321/other-path' },
    { ENTRY_STORAGE_URL: 'http://127.0.0.1:54321/storage/v1?secret=synthetic' },
    { ENTRY_STORAGE_URL: 'http://127.0.0.1:54321/storage/v1#fragment' },
    { ENTRY_STORAGE_URL: credentialUrl.href },
    {
      AUTH_JWT_ISSUER: 'http://supabase.example.test/auth/v1',
      ENTRY_STORAGE_URL: 'http://supabase.example.test/storage/v1',
    },
    { ENTRY_STORAGE_PUBLISHABLE_KEY: 'sb_secret_SYNTHETIC_NOT_A_REAL_KEY' },
    { ENTRY_STORAGE_PUBLISHABLE_KEY: '' },
    {
      ENTRY_STORAGE_PUBLISHABLE_KEY: `synthetic.${Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url')}.synthetic`,
    },
  ])('rejects unsafe configuration %j', (change) => {
    expect(() => parseEntryStorageEnvironment({ ...valid, ...change })).toThrow();
  });
});
