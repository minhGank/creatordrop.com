import type { QueryExecutor } from '@creatordrop/database';

import { CreatorIdentityConflictError, CreatorMemberConflictError } from './creator.errors.js';
import {
  creatorRoles,
  creatorStatuses,
  type Creator,
  type CreatorId,
  type CreatorMember,
  type CreatorRole,
  type CreatorScope,
  type CreatorWorkspace,
  type CreatorWorkspaceMembership,
  type UserId,
} from './creator.js';

interface CreatorRow {
  readonly createdAt: unknown;
  readonly customSlug: unknown;
  readonly displayName: unknown;
  readonly handle: unknown;
  readonly id: unknown;
  readonly revision: unknown;
  readonly role?: unknown;
  readonly status: unknown;
  readonly updatedAt: unknown;
}

interface MembershipRow {
  readonly createdAt: unknown;
  readonly role: unknown;
  readonly updatedAt: unknown;
  readonly userId: unknown;
  readonly username: unknown;
}

interface WorkspaceMembershipRow extends CreatorRow {
  readonly joinedAt: unknown;
  readonly role: unknown;
}

export interface InsertCreatorInput {
  readonly customSlug: string;
  readonly displayName: string;
  readonly handle: string;
  readonly id: CreatorId;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

export const hasDatabaseConstraint = (error: unknown, constraint: string): boolean =>
  isRecord(error) && error.constraint === constraint;

const parseTimestamp = (value: unknown): string => {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) {
    return value.toISOString();
  }

  if (typeof value === 'string') {
    const date = new Date(value);
    if (!Number.isNaN(date.valueOf())) {
      return date.toISOString();
    }
  }

  throw new Error('The database returned an invalid timestamp.');
};

const parseRole = (value: unknown): CreatorRole => {
  if (typeof value !== 'string' || !creatorRoles.includes(value as CreatorRole)) {
    throw new Error('The database returned an invalid creator role.');
  }

  return value as CreatorRole;
};

const parseCreator = (row: CreatorRow | undefined): Creator => {
  if (
    row === undefined ||
    typeof row.id !== 'string' ||
    typeof row.handle !== 'string' ||
    typeof row.customSlug !== 'string' ||
    typeof row.displayName !== 'string' ||
    typeof row.revision !== 'number' ||
    typeof row.status !== 'string' ||
    !creatorStatuses.includes(row.status as (typeof creatorStatuses)[number])
  ) {
    throw new Error('The database returned an invalid creator record.');
  }

  return {
    createdAt: parseTimestamp(row.createdAt),
    customSlug: row.customSlug,
    displayName: row.displayName,
    handle: row.handle,
    id: row.id as CreatorId,
    revision: row.revision,
    status: row.status as Creator['status'],
    updatedAt: parseTimestamp(row.updatedAt),
  };
};

const parseWorkspace = (row: CreatorRow | undefined): CreatorWorkspace => ({
  ...parseCreator(row),
  role: parseRole(row?.role),
});

const parseMember = (row: MembershipRow | undefined): CreatorMember => {
  if (row === undefined || typeof row.userId !== 'string' || typeof row.username !== 'string') {
    throw new Error('The database returned an invalid creator member record.');
  }

  return {
    createdAt: parseTimestamp(row.createdAt),
    role: parseRole(row.role),
    updatedAt: parseTimestamp(row.updatedAt),
    user: { id: row.userId as UserId, username: row.username },
  };
};

const creatorColumns = `
  c.id::text as id,
  c.handle::text as "handle",
  c.custom_slug::text as "customSlug",
  c.display_name as "displayName",
  c.status,
  c.revision,
  c.created_at as "createdAt",
  c.updated_at as "updatedAt"`;

export const insertCreator = async (
  executor: QueryExecutor,
  input: InsertCreatorInput,
): Promise<Creator> => {
  try {
    const result = await executor.query<CreatorRow>(
      `insert into app.creators (id, handle, custom_slug, display_name)
       values ($1, $2, $3, $4)
       returning
         id::text as id,
         handle::text as "handle",
         custom_slug::text as "customSlug",
         display_name as "displayName",
         status,
         revision,
         created_at as "createdAt",
         updated_at as "updatedAt"`,
      [input.id, input.handle, input.customSlug, input.displayName],
    );

    return parseCreator(result.rows[0]);
  } catch (error) {
    if (
      hasDatabaseConstraint(error, 'creators_handle_unique') ||
      hasDatabaseConstraint(error, 'creators_custom_slug_unique')
    ) {
      throw new CreatorIdentityConflictError();
    }

    throw error;
  }
};

export const insertCreatorMembership = async (
  executor: QueryExecutor,
  creatorId: CreatorId,
  userId: UserId,
  role: CreatorRole,
): Promise<CreatorMember> => {
  try {
    const result = await executor.query<MembershipRow>(
      `with inserted as (
         insert into app.creator_memberships (creator_id, user_id, role)
         values ($1, $2, $3)
         returning user_id, role, created_at, updated_at
       )
       select
         inserted.user_id::text as "userId",
         u.username::text as username,
         inserted.role,
         inserted.created_at as "createdAt",
         inserted.updated_at as "updatedAt"
       from inserted
       join app.users u on u.id = inserted.user_id`,
      [creatorId, userId, role],
    );

    return parseMember(result.rows[0]);
  } catch (error) {
    if (hasDatabaseConstraint(error, 'creator_memberships_primary_key')) {
      throw new CreatorMemberConflictError();
    }

    throw error;
  }
};

export const findCreatorForMember = async (
  executor: QueryExecutor,
  scope: CreatorScope,
): Promise<CreatorWorkspace | undefined> => {
  const result = await executor.query<CreatorRow>(
    `select ${creatorColumns}, membership.role
       from app.creators c
       join app.creator_memberships membership
         on membership.creator_id = c.id and membership.user_id = $2
      where c.id = $1`,
    [scope.creatorId, scope.actorUserId],
  );

  return result.rows[0] === undefined ? undefined : parseWorkspace(result.rows[0]);
};

export const listCreatorWorkspacesForUser = async (
  executor: QueryExecutor,
  userId: UserId,
): Promise<readonly CreatorWorkspaceMembership[]> => {
  const result = await executor.query<WorkspaceMembershipRow>(
    `select ${creatorColumns}, membership.role, membership.created_at as "joinedAt"
       from app.creator_memberships membership
       join app.creators c on c.id = membership.creator_id
      where membership.user_id = $1
      order by membership.created_at asc, c.id asc`,
    [userId],
  );

  return result.rows.map((row) => ({
    creator: parseCreator(row),
    joinedAt: parseTimestamp(row.joinedAt),
    role: parseRole(row.role),
  }));
};

export const updateCreatorSettingsScoped = async (
  executor: QueryExecutor,
  scope: CreatorScope,
  expectedRevision: number,
  displayName: string,
  allowedRoles: readonly CreatorRole[],
): Promise<CreatorWorkspace | undefined> => {
  const result = await executor.query<CreatorRow>(
    `update app.creators c
        set display_name = $3,
            revision = c.revision + 1,
            updated_at = statement_timestamp()
       from app.creator_memberships membership
      where c.id = $1
        and c.revision = $4
        and membership.creator_id = c.id
        and membership.user_id = $2
        and membership.role = any($5::text[])
      returning
        c.id::text as id,
        c.handle::text as "handle",
        c.custom_slug::text as "customSlug",
        c.display_name as "displayName",
        c.status,
        c.revision,
        c.created_at as "createdAt",
        c.updated_at as "updatedAt",
        membership.role`,
    [scope.creatorId, scope.actorUserId, displayName, expectedRevision, allowedRoles],
  );

  return result.rows[0] === undefined ? undefined : parseWorkspace(result.rows[0]);
};

export const lockCreator = async (
  executor: QueryExecutor,
  creatorId: CreatorId,
): Promise<Creator | undefined> => {
  const result = await executor.query<CreatorRow>(
    `select ${creatorColumns}
       from app.creators c
      where c.id = $1
      for update of c`,
    [creatorId],
  );

  return result.rows[0] === undefined ? undefined : parseCreator(result.rows[0]);
};

export const findMembershipRole = async (
  executor: QueryExecutor,
  creatorId: CreatorId,
  userId: UserId,
): Promise<CreatorRole | undefined> => {
  const result = await executor.query<{ readonly role: unknown }>(
    `select role
       from app.creator_memberships
      where creator_id = $1 and user_id = $2`,
    [creatorId, userId],
  );

  return result.rows[0] === undefined ? undefined : parseRole(result.rows[0].role);
};

export const activeUserExists = async (
  executor: QueryExecutor,
  userId: UserId,
): Promise<boolean> => {
  const result = await executor.query<{ readonly exists: unknown }>(
    `select exists (
       select 1 from app.users where id = $1 and status = 'active'
     ) as "exists"`,
    [userId],
  );

  if (typeof result.rows[0]?.exists !== 'boolean') {
    throw new Error('The database returned an invalid active-user result.');
  }

  return result.rows[0].exists;
};

export const listCreatorMembersScoped = async (
  executor: QueryExecutor,
  scope: CreatorScope,
  allowedRoles: readonly CreatorRole[],
): Promise<readonly CreatorMember[]> => {
  const result = await executor.query<MembershipRow>(
    `select
       member.user_id::text as "userId",
       u.username::text as username,
       member.role,
       member.created_at as "createdAt",
       member.updated_at as "updatedAt"
       from app.creator_memberships actor_membership
       join app.creator_memberships member
         on member.creator_id = actor_membership.creator_id
       join app.users u on u.id = member.user_id
      where actor_membership.creator_id = $1
        and actor_membership.user_id = $2
        and actor_membership.role = any($3::text[])
      order by member.created_at asc, member.user_id asc`,
    [scope.creatorId, scope.actorUserId, allowedRoles],
  );

  return result.rows.map(parseMember);
};

export const findCreatorMember = async (
  executor: QueryExecutor,
  creatorId: CreatorId,
  userId: UserId,
): Promise<CreatorMember | undefined> => {
  const result = await executor.query<MembershipRow>(
    `select
       membership.user_id::text as "userId",
       u.username::text as username,
       membership.role,
       membership.created_at as "createdAt",
       membership.updated_at as "updatedAt"
       from app.creator_memberships membership
       join app.users u on u.id = membership.user_id
      where membership.creator_id = $1 and membership.user_id = $2`,
    [creatorId, userId],
  );

  return result.rows[0] === undefined ? undefined : parseMember(result.rows[0]);
};

export const updateCreatorMemberRole = async (
  executor: QueryExecutor,
  creatorId: CreatorId,
  userId: UserId,
  role: CreatorRole,
): Promise<CreatorMember | undefined> => {
  const result = await executor.query<MembershipRow>(
    `with updated as (
       update app.creator_memberships
          set role = $3, updated_at = statement_timestamp()
        where creator_id = $1 and user_id = $2
        returning user_id, role, created_at, updated_at
     )
     select
       updated.user_id::text as "userId",
       u.username::text as username,
       updated.role,
       updated.created_at as "createdAt",
       updated.updated_at as "updatedAt"
       from updated
       join app.users u on u.id = updated.user_id`,
    [creatorId, userId, role],
  );

  return result.rows[0] === undefined ? undefined : parseMember(result.rows[0]);
};

export const deleteCreatorMember = async (
  executor: QueryExecutor,
  creatorId: CreatorId,
  userId: UserId,
): Promise<boolean> => {
  const result = await executor.query(
    `delete from app.creator_memberships
      where creator_id = $1 and user_id = $2`,
    [creatorId, userId],
  );

  return result.rowCount === 1;
};
