import { creatorRoles, creatorStatuses } from '@creatordrop/contracts';
import type { CreatorRole, CreatorStatus } from '@creatordrop/contracts';

export { creatorRoles, creatorStatuses };
export type { CreatorRole, CreatorStatus };

declare const creatorIdBrand: unique symbol;
declare const userIdBrand: unique symbol;

export type CreatorId = string & { readonly [creatorIdBrand]: 'CreatorId' };
export type UserId = string & { readonly [userIdBrand]: 'UserId' };

export interface Creator {
  readonly createdAt: string;
  readonly customSlug: string;
  readonly displayName: string;
  readonly handle: string;
  readonly id: CreatorId;
  readonly revision: number;
  readonly status: CreatorStatus;
  readonly updatedAt: string;
}

export interface CreatorWorkspace extends Creator {
  readonly role: CreatorRole;
}

export interface CreatorWorkspaceMembership {
  readonly creator: Creator;
  readonly joinedAt: string;
  readonly role: CreatorRole;
}

export interface CreatorMember {
  readonly createdAt: string;
  readonly role: CreatorRole;
  readonly updatedAt: string;
  readonly user: {
    readonly id: UserId;
    readonly username: string;
  };
}

export interface CreatorScope {
  readonly actorUserId: UserId;
  readonly creatorId: CreatorId;
}
