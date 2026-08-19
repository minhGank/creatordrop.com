import { describe, expect, it } from 'vitest';

import { createSyntheticEnvironment } from '../src/index.js';

describe('synthetic environment', () => {
  it('uses test mode and explicit overrides', () => {
    expect(createSyntheticEnvironment({ PORT: '4000' })).toEqual({
      NODE_ENV: 'test',
      PORT: '4000',
    });
  });
});
