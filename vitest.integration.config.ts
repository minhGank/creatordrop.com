import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const fromRoot = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@creatordrop/config': fromRoot('./packages/config/src/index.ts'),
      '@creatordrop/contracts': fromRoot('./packages/contracts/src/index.ts'),
      '@creatordrop/database': fromRoot('./packages/database/src/index.ts'),
      '@creatordrop/observability': fromRoot('./packages/observability/src/index.ts'),
      '@creatordrop/test-support': fromRoot('./packages/test-support/src/index.ts'),
    },
  },
  test: {
    include: ['apps/**/*.integration.test.ts', 'packages/**/*.integration.test.ts'],
  },
});
