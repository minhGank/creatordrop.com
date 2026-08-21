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
