import type { QueryExecutor } from '@creatordrop/database';

import type { LocalUser, TrustedIdentity } from './user.js';

interface UserRow {
  readonly id: unknown;
  readonly status: unknown;
  readonly username: unknown;
}

export interface BootstrapUserInput {
  readonly id: string;
  readonly identity: TrustedIdentity;
  readonly username: string;
}

const parseUserRow = (row: UserRow | undefined): LocalUser => {
  if (
    row === undefined ||
    typeof row.id !== 'string' ||
    typeof row.username !== 'string' ||
    (row.status !== 'active' && row.status !== 'suspended' && row.status !== 'closed')
  ) {
    throw new Error('The database returned an invalid local user record.');
  }

  return { id: row.id, status: row.status, username: row.username };
};

export const findOrCreateUser = async (
  executor: QueryExecutor,
  input: BootstrapUserInput,
): Promise<LocalUser> => {
  const inserted = await executor.query<UserRow>(
    `insert into app.users (id, auth_provider, auth_subject, username)
     values ($1, $2, $3, $4)
     on conflict (auth_provider, auth_subject) do nothing
     returning id, username::text as username, status`,
    [input.id, input.identity.provider, input.identity.subject, input.username],
  );

  if (inserted.rowCount === 1) {
    return parseUserRow(inserted.rows[0]);
  }

  const existing = await executor.query<UserRow>(
    `select id, username::text as username, status
       from app.users
      where auth_provider = $1 and auth_subject = $2`,
    [input.identity.provider, input.identity.subject],
  );

  return parseUserRow(existing.rows[0]);
};
