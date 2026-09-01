import { describe, expect, it } from 'vitest';

import { canPerformCreatorAction, creatorActions } from '../src/modules/creators/creator.policy.js';
import { creatorRoles, type CreatorRole } from '../src/modules/creators/creator.js';

const expectedActionsByRole: Readonly<Record<CreatorRole, readonly string[]>> = {
  editor: [
    'workspace.view',
    'membership.list',
    'content.draft.write',
    'catalog.view',
    'catalog.draft.write',
    'fulfillment.view',
  ],
  manager: [
    'workspace.view',
    'membership.list',
    'settings.update',
    'content.draft.write',
    'content.publish',
    'catalog.view',
    'catalog.draft.write',
    'catalog.publish',
    'catalog.archive',
    'fulfillment.view',
    'fulfillment.manage',
    'fulfillment.sensitive.read',
    'inventory.restock',
  ],
  owner: [...creatorActions],
  viewer: ['workspace.view', 'membership.list', 'catalog.view', 'fulfillment.view'],
};

describe('creator authorization policy', () => {
  it.each(creatorRoles)('implements the complete %s action matrix', (role) => {
    for (const action of creatorActions) {
      expect(canPerformCreatorAction(role, action), `${role} ${action}`).toBe(
        expectedActionsByRole[role].includes(action),
      );
    }
  });

  it('denies every action without a creator membership', () => {
    for (const action of creatorActions) {
      expect(canPerformCreatorAction(undefined, action), action).toBe(false);
    }
  });
});
