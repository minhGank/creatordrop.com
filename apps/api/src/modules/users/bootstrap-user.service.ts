import { v7 as uuidv7 } from 'uuid';

import type { Database } from '@creatordrop/database';

import { findOrCreateUser } from './user.repository.js';
import { InactiveUserError, type LocalUser, type TrustedIdentity } from './user.js';

export interface UserBootstrapService {
  bootstrap(identity: TrustedIdentity): Promise<LocalUser>;
}

export interface UserBootstrapServiceOptions {
  readonly createUserId?: () => string;
  readonly database: Database;
}

const bootstrapUsername = (userId: string): string => `user_${userId.replaceAll('-', '')}`;

export const createUserBootstrapService = ({
  createUserId = uuidv7,
  database,
}: UserBootstrapServiceOptions): UserBootstrapService => ({
  bootstrap: async (identity) => {
    const userId = createUserId();
    const user = await database.transaction((transaction) =>
      findOrCreateUser(transaction, {
        id: userId,
        identity,
        username: bootstrapUsername(userId),
      }),
    );

    if (user.status !== 'active') {
      throw new InactiveUserError(user.status);
    }

    return user;
  },
});
