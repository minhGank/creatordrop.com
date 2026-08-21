import { creatorRoles, type CreatorRole } from './creator.js';

export const creatorActions = [
  'workspace.view',
  'membership.list',
  'settings.update',
  'content.draft.write',
  'content.publish',
  'catalog.view',
  'catalog.draft.write',
  'catalog.publish',
  'catalog.archive',
  'membership.manage',
  'ownership.manage',
] as const;

export type CreatorAction = (typeof creatorActions)[number];

const permissions: Readonly<Record<CreatorAction, readonly CreatorRole[]>> = {
  'catalog.archive': ['owner', 'manager'],
  'catalog.draft.write': ['owner', 'manager', 'editor'],
  'catalog.publish': ['owner', 'manager'],
  'catalog.view': creatorRoles,
  'content.draft.write': ['owner', 'manager', 'editor'],
  'content.publish': ['owner', 'manager'],
  'membership.list': creatorRoles,
  'membership.manage': ['owner'],
  'ownership.manage': ['owner'],
  'settings.update': ['owner', 'manager'],
  'workspace.view': creatorRoles,
};

export const rolesForCreatorAction = (action: CreatorAction): readonly CreatorRole[] =>
  permissions[action];

export const canPerformCreatorAction = (
  role: CreatorRole | undefined,
  action: CreatorAction,
): boolean => role !== undefined && permissions[action].includes(role);
