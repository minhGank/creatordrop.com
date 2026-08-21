import { describe, expect, it } from 'vitest';

import { serviceStates, userStatuses } from '../src/index.js';

describe('service status contract', () => {
  it('keeps health and readiness states explicit', () => {
    expect(serviceStates).toEqual(['ok', 'ready']);
  });

  it('keeps local user lifecycle states explicit', () => {
    expect(userStatuses).toEqual(['active', 'suspended', 'closed']);
  });
});
