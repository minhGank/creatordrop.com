import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';
import { build } from 'vite';

import { assertBrowserSafeSupabaseKey } from '../src/config/supabase-browser-key.js';
import { createWebViteConfig } from '../vite.config.js';

const originalBrowserKey = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const webRoot = fileURLToPath(new URL('../', import.meta.url));
const configFile = fileURLToPath(new URL('../vite.config.ts', import.meta.url));

afterEach(() => {
  if (originalBrowserKey === undefined) delete process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  else process.env.VITE_SUPABASE_PUBLISHABLE_KEY = originalBrowserKey;
});

const legacyServiceRoleKey = [
  Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
  Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url'),
  'synthetic-signature',
].join('.');

describe('Vite Supabase browser-key boundary', () => {
  it('accepts publishable keys and rejects modern and legacy privileged keys', () => {
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_public_test_key';
    expect(() => createWebViteConfig({ command: 'build', mode: 'production' })).not.toThrow();
    const modernSecret = 'sb_secret_synthetic_do_not_use';
    expect(() => assertBrowserSafeSupabaseKey(modernSecret)).toThrow(/browser-safe/iu);
    try {
      assertBrowserSafeSupabaseKey(modernSecret);
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain(modernSecret);
    }
    expect(() => assertBrowserSafeSupabaseKey(legacyServiceRoleKey)).toThrow(/browser-safe/iu);
    expect(() => assertBrowserSafeSupabaseKey('eyJmalformed.privileged.jwt')).toThrow(
      /browser-safe/iu,
    );
  });

  it('rejects a secret during Vite configuration before JavaScript is emitted', async () => {
    const secret = 'sb_secret_SYNTHETIC_DO_NOT_USE';
    const outputDirectory = await mkdtemp(join(tmpdir(), 'creatordrop-web-secret-'));
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY = secret;
    try {
      await expect(
        build({
          build: { emptyOutDir: true, outDir: outputDirectory },
          configFile,
          logLevel: 'silent',
          root: webRoot,
        }),
      ).rejects.toThrow(/browser-safe Supabase publishable or anon key/iu);
      const emittedFiles = await readdir(outputDirectory, { recursive: true });
      const emittedJavaScript = emittedFiles.filter((file) => file.endsWith('.js'));
      const emittedContents = await Promise.all(
        emittedJavaScript.map((file) => readFile(join(outputDirectory, file), 'utf8')),
      );
      expect(emittedContents.join('\n')).not.toContain(secret);
    } finally {
      await rm(outputDirectory, { force: true, recursive: true });
    }
  });
});
