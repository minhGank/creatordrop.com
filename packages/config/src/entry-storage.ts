import { z } from 'zod';

const storageSchema = z
  .object({
    AUTH_PROVIDER: z.literal('supabase').default('supabase'),
    AUTH_JWT_ISSUER: z.url(),
    ENTRY_STORAGE_URL: z.url(),
    ENTRY_STORAGE_PUBLISHABLE_KEY: z.string().min(1).max(4096),
  })
  .superRefine((value, context) => {
    const url = new URL(value.ENTRY_STORAGE_URL);
    if (
      url.origin !== new URL(value.AUTH_JWT_ISSUER).origin ||
      url.pathname !== '/storage/v1' ||
      url.username !== '' ||
      url.password !== '' ||
      url.search !== '' ||
      url.hash !== '' ||
      (url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))
    ) {
      context.addIssue({
        code: 'custom',
        path: ['ENTRY_STORAGE_URL'],
        message: 'Storage must use the trusted Supabase Auth origin and /storage/v1 path.',
      });
    }
    const key = value.ENTRY_STORAGE_PUBLISHABLE_KEY;
    let publicKey = /^sb_publishable_[A-Za-z0-9_-]+$/u.test(key);
    if (!publicKey && key.split('.').length === 3) {
      try {
        const claims: unknown = JSON.parse(
          Buffer.from(key.split('.')[1] ?? '', 'base64url').toString('utf8'),
        );
        publicKey =
          typeof claims === 'object' &&
          claims !== null &&
          'role' in claims &&
          claims.role === 'anon';
      } catch {
        publicKey = false;
      }
    }
    if (!publicKey)
      context.addIssue({
        code: 'custom',
        path: ['ENTRY_STORAGE_PUBLISHABLE_KEY'],
        message: 'Use a publishable/anon key, never a service credential.',
      });
  });
export const parseEntryStorageEnvironment = (input: NodeJS.ProcessEnv) => {
  const value = storageSchema.parse(input);
  return {
    url: value.ENTRY_STORAGE_URL,
    publishableKey: value.ENTRY_STORAGE_PUBLISHABLE_KEY,
  } as const;
};
