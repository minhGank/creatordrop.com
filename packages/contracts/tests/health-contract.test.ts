import { describe, expect, it } from 'vitest';

import { serviceStates } from '../src/index.js';

describe('service status contract', () => {
  it('keeps health and readiness states explicit', () => {
    expect(serviceStates).toEqual(['ok', 'ready']);
  });
});
