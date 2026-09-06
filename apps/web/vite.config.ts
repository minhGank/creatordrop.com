import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type ConfigEnv, type UserConfig } from 'vite';

import { assertBrowserSafeSupabaseKey } from './src/config/supabase-browser-key.js';

const environmentDirectory = fileURLToPath(new URL('../../', import.meta.url));

export const createWebViteConfig = ({ command, mode }: ConfigEnv): UserConfig => {
  const environment = loadEnv(mode, environmentDirectory, '');
  const browserKey =
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? environment.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (browserKey !== undefined) assertBrowserSafeSupabaseKey(browserKey);
  const appEnvironment = process.env.VITE_APP_ENV ?? environment.VITE_APP_ENV;
  const testCreditsConfigured =
    (process.env.WALLET_TEST_CREDITS_ENABLED ?? environment.WALLET_TEST_CREDITS_ENABLED) === 'true';
  const testCreditsEnabled =
    command === 'serve' &&
    (mode === 'development' || mode === 'test') &&
    (appEnvironment === 'development' || appEnvironment === 'test') &&
    testCreditsConfigured;

  return {
    define: {
      __CREATORDROP_TEST_CREDITS_ENABLED__: JSON.stringify(testCreditsEnabled),
    },
    envDir: environmentDirectory,
    plugins: [react(), tailwindcss()],
  };
};

export default defineConfig(createWebViteConfig);
