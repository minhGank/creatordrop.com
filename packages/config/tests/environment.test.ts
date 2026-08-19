import { describe, expect, it } from 'vitest';

import { parseApiEnvironment, parseWorkerEnvironment } from '../src/index.js';

describe('environment configuration', () => {
  it('applies safe local defaults', () => {
    expect(parseApiEnvironment({})).toEqual({
      host: '127.0.0.1',
      nodeEnvironment: 'development',
      port: 3000,
    });
    expect(parseWorkerEnvironment({})).toEqual({
      nodeEnvironment: 'development',
      pollIntervalMs: 1000,
    });
  });

  it('parses valid string values from process environments', () => {
    expect(parseApiEnvironment({ HOST: '0.0.0.0', NODE_ENV: 'test', PORT: '4100' })).toEqual({
      host: '0.0.0.0',
      nodeEnvironment: 'test',
      port: 4100,
    });
  });

  it.each([{ PORT: 'not-a-port' }, { PORT: '0' }, { PORT: '65536' }, { NODE_ENV: 'staging' }])(
    'rejects an invalid API environment: %o',
    (environment) => {
      expect(() => parseApiEnvironment(environment)).toThrow();
    },
  );

  it.each([{ WORKER_POLL_INTERVAL_MS: '99' }, { WORKER_POLL_INTERVAL_MS: '60001' }])(
    'rejects an invalid worker environment: %o',
    (environment) => {
      expect(() => parseWorkerEnvironment(environment)).toThrow();
    },
  );
});
