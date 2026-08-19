import { describe, expect, it, vi } from 'vitest';

import { getApiEnvironment } from '../src/config/environment.js';

describe('API environment adapter', () => {
  it('reads and validates process.env at the configuration boundary', () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('HOST', '127.0.0.1');
    vi.stubEnv('PORT', '4321');

    expect(getApiEnvironment()).toEqual({
      host: '127.0.0.1',
      nodeEnvironment: 'test',
      port: 4321,
    });

    vi.unstubAllEnvs();
  });
});
