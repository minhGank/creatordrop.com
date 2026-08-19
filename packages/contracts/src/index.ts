export const serviceStates = ['ok', 'ready'] as const;

export type ServiceState = (typeof serviceStates)[number];

export interface ServiceStatusResponse {
  readonly service: 'api';
  readonly status: ServiceState;
}
