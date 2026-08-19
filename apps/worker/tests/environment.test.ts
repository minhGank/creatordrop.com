import { describe, expect, it, vi } from 'vitest';

import { getWorkerEnvironment } from '../src/config/environment.js';

describe('worker environment adapter', () => {
  it('reads and validates process.env at the configuration boundary', () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('WORKER_POLL_INTERVAL_MS', '250');

    expect(getWorkerEnvironment()).toEqual({
      nodeEnvironment: 'test',
      pollIntervalMs: 250,
    });

    vi.unstubAllEnvs();
  });
});
