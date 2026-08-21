import type { UserStatus } from '@creatordrop/contracts';

export interface LocalUser {
  readonly id: string;
  readonly status: UserStatus;
  readonly username: string;
}

export interface TrustedIdentity {
  readonly provider: string;
  readonly subject: string;
}

export class InactiveUserError extends Error {
  readonly status: Exclude<UserStatus, 'active'>;

  constructor(status: Exclude<UserStatus, 'active'>) {
    super('The local user is not active.');
    this.name = 'InactiveUserError';
    this.status = status;
  }
}
