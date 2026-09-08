import { z } from 'zod';

import { isBrowserSafeSupabaseKey } from './supabase-browser-key.js';

const webEnvironmentSchema = z.object({
  VITE_API_BASE_URL: z.url().default('http://localhost:3000'),
  VITE_APP_ENV: z.enum(['development', 'test', 'production']).default('development'),
  VITE_SUPABASE_PUBLISHABLE_KEY: z.string().min(1).refine(isBrowserSafeSupabaseKey, {
    message: 'The Supabase browser key must be a publishable or anon key.',
  }),
  VITE_SUPABASE_URL: z.url(),
});

export interface WebEnvironment {
  readonly apiBaseUrl: string;
  readonly appEnvironment: 'development' | 'test' | 'production';
  readonly supabasePublishableKey: string;
  readonly supabaseUrl: string;
}

export const parseWebEnvironment = (input: Record<string, unknown>): WebEnvironment => {
  const parsed = webEnvironmentSchema.parse(input);

  return {
    apiBaseUrl: parsed.VITE_API_BASE_URL,
    appEnvironment: parsed.VITE_APP_ENV,
    supabasePublishableKey: parsed.VITE_SUPABASE_PUBLISHABLE_KEY,
    supabaseUrl: parsed.VITE_SUPABASE_URL,
  };
};

export const getWebEnvironment = (): WebEnvironment => parseWebEnvironment(import.meta.env);
