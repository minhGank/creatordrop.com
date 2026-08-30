import { describe, expect, it, vi } from 'vitest';

import { getWorkerEnvironment } from '../src/config/environment.js';

describe('worker environment adapter', () => {
  it('reads and validates process.env at the configuration boundary', () => {
    const connectionString = [
      'postgresql:',
      '//synthetic:',
      'local-only',
      '@database.example.test/creatordrop',
    ].join('');
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('REALTIME_URL', 'http://127.0.0.1:3000');
    vi.stubEnv('REALTIME_WORKER_TOKEN', 'synthetic-realtime-worker-token-00000001');
    vi.stubEnv('WORKER_DATABASE_URL', connectionString);
    vi.stubEnv('WORKER_POLL_INTERVAL_MS', '250');

    expect(getWorkerEnvironment()).toEqual({
      batchSize: 25,
      database: {
        applicationName: 'creatordrop-worker',
        connectionString,
        connectionTimeoutMs: 5000,
        idleTimeoutMs: 10_000,
        maxConnections: 10,
      },
      leaseMs: 30_000,
      maxAttempts: 8,
      nodeEnvironment: 'test',
      pollIntervalMs: 250,
      publishTimeoutMs: 5000,
      realtimeUrl: 'http://127.0.0.1:3000',
      realtimeWorkerToken: 'synthetic-realtime-worker-token-00000001',
      retryBaseMs: 1000,
      retryMaxMs: 60_000,
    });

    vi.unstubAllEnvs();
  });
});
