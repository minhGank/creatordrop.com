import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const fromRoot = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@creatordrop/config': fromRoot('./packages/config/src/index.ts'),
      '@creatordrop/contracts': fromRoot('./packages/contracts/src/index.ts'),
      '@creatordrop/database': fromRoot('./packages/database/src/index.ts'),
      '@creatordrop/domain': fromRoot('./packages/domain/src/index.ts'),
      '@creatordrop/observability': fromRoot('./packages/observability/src/index.ts'),
      '@creatordrop/rng-verifier': fromRoot('./packages/rng-verifier/src/index.ts'),
      '@creatordrop/test-support': fromRoot('./packages/test-support/src/index.ts'),
    },
  },
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
    },
    include: ['apps/**/*.test.{ts,tsx}', 'packages/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['**/*.integration.test.ts', '**/dist/**', '**/node_modules/**'],
    passWithNoTests: false,
  },
});
