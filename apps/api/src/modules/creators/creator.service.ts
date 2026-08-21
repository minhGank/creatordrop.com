import { v7 as uuidv7 } from 'uuid';

import type { Database, QueryExecutor } from '@creatordrop/database';
import type { Logger } from '@creatordrop/observability';

import {
  CreatorFinalOwnerError,
  CreatorMemberNotFoundError,
  CreatorNotFoundError,
  CreatorPermissionDeniedError,
  CreatorRevisionConflictError,
  CreatorTargetUserNotFoundError,
} from './creator.errors.js';
import {
  activeUserExists,
  deleteCreatorMember,
  findCreatorForMember,
  findCreatorMember,
  findMembershipRole,
  hasDatabaseConstraint,
  insertCreator,
  insertCreatorMembership,
  listCreatorMembersScoped,
  listCreatorWorkspacesForUser,
  lockCreator,
  updateCreatorMemberRole,
  updateCreatorSettingsScoped,
} from './creator.repository.js';
import {
  canPerformCreatorAction,
  rolesForCreatorAction,
  type CreatorAction,
} from './creator.policy.js';
import type {
  CreatorId,
  CreatorMember,
  CreatorRole,
  CreatorScope,
  CreatorWorkspace,
  CreatorWorkspaceMembership,
  UserId,
} from './creator.js';

interface AuditContext {
  readonly actorUserId: UserId;
  readonly requestId: string;
}

export interface CreateCreatorCommand extends AuditContext {
  readonly customSlug: string;
  readonly displayName: string;
  readonly handle: string;
}

export interface UpdateCreatorCommand extends AuditContext, CreatorScope {
  readonly displayName: string;
  readonly expectedRevision: number;
}

export interface AddCreatorMemberCommand extends AuditContext {
  readonly creatorId: CreatorId;
  readonly role: CreatorRole;
  readonly targetUserId: UserId;
}

export type UpdateCreatorMemberCommand = AddCreatorMemberCommand;

export interface RemoveCreatorMemberCommand extends AuditContext {
  readonly creatorId: CreatorId;
  readonly targetUserId: UserId;
}

export interface CreatorService {
  addMember(command: AddCreatorMemberCommand): Promise<CreatorMember>;
  createCreator(command: CreateCreatorCommand): Promise<CreatorWorkspace>;
  getCreator(scope: CreatorScope): Promise<CreatorWorkspace>;
  listMembers(scope: CreatorScope): Promise<readonly CreatorMember[]>;
  listMyWorkspaces(userId: UserId): Promise<readonly CreatorWorkspaceMembership[]>;
  removeMember(command: RemoveCreatorMemberCommand): Promise<void>;
  updateCreator(command: UpdateCreatorCommand): Promise<CreatorWorkspace>;
  updateMember(command: UpdateCreatorMemberCommand): Promise<CreatorMember>;
}

export interface CreatorServiceOptions {
  readonly createCreatorId?: () => string;
  readonly database: Database;
  readonly logger: Logger;
}

const creatorIdFromGeneratedValue = (value: string): CreatorId => value as CreatorId;

const requirePermission = async (
  transaction: QueryExecutor,
  scope: CreatorScope,
  action: CreatorAction,
): Promise<CreatorWorkspace> => {
  const creator = await lockCreator(transaction, scope.creatorId);

  if (creator === undefined) {
    throw new CreatorNotFoundError();
  }

  const role = await findMembershipRole(transaction, scope.creatorId, scope.actorUserId);

  if (role === undefined) {
    throw new CreatorNotFoundError();
  }

  if (!canPerformCreatorAction(role, action)) {
    throw new CreatorPermissionDeniedError();
  }

  return { ...creator, role };
};

const throwFinalOwnerConstraint = (error: unknown): never => {
  if (hasDatabaseConstraint(error, 'active_creator_owner_required')) {
    throw new CreatorFinalOwnerError();
  }

  throw error;
};

export const createCreatorService = ({
  createCreatorId = uuidv7,
  database,
  logger,
}: CreatorServiceOptions): CreatorService => ({
  createCreator: async (command) => {
    const creatorId = creatorIdFromGeneratedValue(createCreatorId());
    const workspace = await database.transaction(async (transaction) => {
      const creator = await insertCreator(transaction, {
        customSlug: command.customSlug,
        displayName: command.displayName,
        handle: command.handle,
        id: creatorId,
      });
      await insertCreatorMembership(transaction, creatorId, command.actorUserId, 'owner');
      return { ...creator, role: 'owner' as const };
    });

    logger.info('creator.audit', {
      action: 'creator.created',
      actorUserId: command.actorUserId,
      creatorId,
      requestId: command.requestId,
      revision: workspace.revision,
    });

    return workspace;
  },

  getCreator: async (scope) => {
    const workspace = await findCreatorForMember(database, scope);

    if (workspace === undefined) {
      throw new CreatorNotFoundError();
    }

    if (!canPerformCreatorAction(workspace.role, 'workspace.view')) {
      throw new CreatorPermissionDeniedError();
    }

    return workspace;
  },

  listMyWorkspaces: (userId) => listCreatorWorkspacesForUser(database, userId),

  updateCreator: async (command) => {
    const scope: CreatorScope = {
      actorUserId: command.actorUserId,
      creatorId: command.creatorId,
    };
    const workspace = await database.transaction(async (transaction) => {
      const current = await requirePermission(transaction, scope, 'settings.update');

      if (current.revision !== command.expectedRevision) {
        throw new CreatorRevisionConflictError(current.revision);
      }

      const updated = await updateCreatorSettingsScoped(
        transaction,
        scope,
        command.expectedRevision,
        command.displayName,
        rolesForCreatorAction('settings.update'),
      );

      if (updated === undefined) {
        throw new Error('The locked creator update unexpectedly affected no rows.');
      }

      return updated;
    });

    logger.info('creator.audit', {
      action: 'creator.updated',
      actorUserId: command.actorUserId,
      creatorId: command.creatorId,
      requestId: command.requestId,
      revision: workspace.revision,
    });

    return workspace;
  },

  listMembers: async (scope) => {
    const workspace = await findCreatorForMember(database, scope);

    if (workspace === undefined) {
      throw new CreatorNotFoundError();
    }

    if (!canPerformCreatorAction(workspace.role, 'membership.list')) {
      throw new CreatorPermissionDeniedError();
    }

    const members = await listCreatorMembersScoped(
      database,
      scope,
      rolesForCreatorAction('membership.list'),
    );

    if (members.length === 0) {
      throw new CreatorNotFoundError();
    }

    return members;
  },

  addMember: async (command) => {
    const member = await database.transaction(async (transaction) => {
      await requirePermission(
        transaction,
        { actorUserId: command.actorUserId, creatorId: command.creatorId },
        'membership.manage',
      );

      if (!(await activeUserExists(transaction, command.targetUserId))) {
        throw new CreatorTargetUserNotFoundError();
      }

      return insertCreatorMembership(
        transaction,
        command.creatorId,
        command.targetUserId,
        command.role,
      );
    });

    logger.info('creator.audit', {
      action: 'creator.member_added',
      actorUserId: command.actorUserId,
      afterRole: member.role,
      creatorId: command.creatorId,
      requestId: command.requestId,
      targetUserId: command.targetUserId,
    });

    return member;
  },

  updateMember: async (command) => {
    try {
      const result = await database.transaction(async (transaction) => {
        await requirePermission(
          transaction,
          { actorUserId: command.actorUserId, creatorId: command.creatorId },
          'membership.manage',
        );
        const existing = await findCreatorMember(
          transaction,
          command.creatorId,
          command.targetUserId,
        );

        if (existing === undefined) {
          throw new CreatorMemberNotFoundError();
        }

        if (existing.role === command.role) {
          return { changed: false as const, member: existing, previousRole: existing.role };
        }

        const member = await updateCreatorMemberRole(
          transaction,
          command.creatorId,
          command.targetUserId,
          command.role,
        );

        if (member === undefined) {
          throw new CreatorMemberNotFoundError();
        }

        return { changed: true as const, member, previousRole: existing.role };
      });

      if (result.changed) {
        logger.info('creator.audit', {
          action: 'creator.member_role_changed',
          actorUserId: command.actorUserId,
          afterRole: result.member.role,
          beforeRole: result.previousRole,
          creatorId: command.creatorId,
          requestId: command.requestId,
          targetUserId: command.targetUserId,
        });
      }

      return result.member;
    } catch (error) {
      return throwFinalOwnerConstraint(error);
    }
  },

  removeMember: async (command) => {
    const removedRole = await database
      .transaction(async (transaction) => {
        await requirePermission(
          transaction,
          { actorUserId: command.actorUserId, creatorId: command.creatorId },
          'membership.manage',
        );
        const existing = await findCreatorMember(
          transaction,
          command.creatorId,
          command.targetUserId,
        );

        if (existing === undefined) {
          throw new CreatorMemberNotFoundError();
        }

        if (!(await deleteCreatorMember(transaction, command.creatorId, command.targetUserId))) {
          throw new CreatorMemberNotFoundError();
        }

        return existing.role;
      })
      .catch((error: unknown) => throwFinalOwnerConstraint(error));

    logger.info('creator.audit', {
      action: 'creator.member_removed',
      actorUserId: command.actorUserId,
      beforeRole: removedRole,
      creatorId: command.creatorId,
      requestId: command.requestId,
      targetUserId: command.targetUserId,
    });
  },
});
