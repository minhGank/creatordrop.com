export const serviceStates = ['ok', 'ready'] as const;

export type ServiceState = (typeof serviceStates)[number];

export interface ServiceStatusResponse {
  readonly service: 'api';
  readonly status: ServiceState;
}

export const userStatuses = ['active', 'suspended', 'closed'] as const;

export type UserStatus = (typeof userStatuses)[number];

export interface AuthSessionResponse {
  readonly user: {
    readonly id: string;
    readonly status: UserStatus;
    readonly username: string;
  };
}

export interface ApiErrorResponse {
  readonly error: {
    readonly code: string;
    readonly details: Readonly<Record<string, unknown>>;
    readonly message: string;
    readonly requestId: string;
  };
}

export const creatorRoles = ['owner', 'manager', 'editor', 'viewer'] as const;
export type CreatorRole = (typeof creatorRoles)[number];

export const creatorStatuses = ['active', 'suspended', 'closed'] as const;
export type CreatorStatus = (typeof creatorStatuses)[number];

export interface CreatorContract {
  readonly createdAt: string;
  readonly customSlug: string;
  readonly displayName: string;
  readonly handle: string;
  readonly id: string;
  readonly revision: number;
  readonly status: CreatorStatus;
  readonly updatedAt: string;
}

export interface CreatorWorkspaceResponse {
  readonly creator: CreatorContract & { readonly role: CreatorRole };
}

export interface CreatorWorkspaceMembershipsResponse {
  readonly memberships: readonly {
    readonly creator: CreatorContract;
    readonly joinedAt: string;
    readonly role: CreatorRole;
  }[];
}

export interface CreatorMemberContract {
  readonly createdAt: string;
  readonly role: CreatorRole;
  readonly updatedAt: string;
  readonly user: {
    readonly id: string;
    readonly username: string;
  };
}

export interface CreatorMembersResponse {
  readonly members: readonly CreatorMemberContract[];
}

export interface CreatorMemberResponse {
  readonly member: CreatorMemberContract;
}
