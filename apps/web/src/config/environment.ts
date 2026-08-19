import { z } from 'zod';

const webEnvironmentSchema = z.object({
  VITE_API_BASE_URL: z.url().default('http://localhost:3000'),
  VITE_APP_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

export interface WebEnvironment {
  readonly apiBaseUrl: string;
  readonly appEnvironment: 'development' | 'test' | 'production';
}

export const parseWebEnvironment = (input: Record<string, unknown>): WebEnvironment => {
  const parsed = webEnvironmentSchema.parse(input);

  return {
    apiBaseUrl: parsed.VITE_API_BASE_URL,
    appEnvironment: parsed.VITE_APP_ENV,
  };
};

export const getWebEnvironment = (): WebEnvironment => parseWebEnvironment(import.meta.env);
