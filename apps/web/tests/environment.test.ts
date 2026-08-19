import { describe, expect, it } from 'vitest';

import { parseWebEnvironment } from '../src/config/environment.js';

describe('web environment configuration', () => {
  it('parses public build-time configuration', () => {
    expect(
      parseWebEnvironment({
        VITE_API_BASE_URL: 'https://api.example.test',
        VITE_APP_ENV: 'test',
      }),
    ).toEqual({
      apiBaseUrl: 'https://api.example.test',
      appEnvironment: 'test',
    });
  });

  it('rejects malformed public configuration', () => {
    expect(() => parseWebEnvironment({ VITE_API_BASE_URL: 'not-a-url' })).toThrow();
  });
});
