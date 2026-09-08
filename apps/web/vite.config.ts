import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type ConfigEnv, type UserConfig } from 'vite';

import { assertBrowserSafeSupabaseKey } from './src/config/supabase-browser-key.js';

const environmentDirectory = fileURLToPath(new URL('../../', import.meta.url));

export const createWebViteConfig = ({ mode }: ConfigEnv): UserConfig => {
  const environment = loadEnv(mode, environmentDirectory, '');
  const browserKey =
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? environment.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (browserKey !== undefined) assertBrowserSafeSupabaseKey(browserKey);

  return {
    envDir: environmentDirectory,
    plugins: [react(), tailwindcss()],
  };
};

export default defineConfig(createWebViteConfig);
