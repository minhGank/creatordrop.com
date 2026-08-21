import { describe, expect, it } from 'vitest';

import {
  boxStatuses,
  boxVersionStates,
  creatorRoles,
  creatorStatuses,
  inventoryModes,
  rewardStatuses,
  rewardTypes,
  rewardVersionStates,
  serviceStates,
  userStatuses,
} from '../src/index.js';

describe('service status contract', () => {
  it('keeps health and readiness states explicit', () => {
    expect(serviceStates).toEqual(['ok', 'ready']);
  });

  it('keeps local user lifecycle states explicit', () => {
    expect(userStatuses).toEqual(['active', 'suspended', 'closed']);
  });

  it('keeps creator roles and lifecycle states explicit', () => {
    expect(creatorRoles).toEqual(['owner', 'manager', 'editor', 'viewer']);
    expect(creatorStatuses).toEqual(['active', 'suspended', 'closed']);
  });

  it('keeps catalog lifecycle and inventory values explicit', () => {
    expect(boxStatuses).toEqual(['draft', 'active', 'paused', 'archived']);
    expect(boxVersionStates).toEqual(['draft', 'published', 'retired']);
    expect(rewardStatuses).toEqual(['active', 'archived']);
    expect(rewardVersionStates).toEqual(['draft', 'published', 'retired']);
    expect(rewardTypes).toEqual(['digital', 'physical', 'experience']);
    expect(inventoryModes).toEqual(['unlimited', 'finite']);
  });
});
