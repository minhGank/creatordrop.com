export class ApiError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly status: number;

  constructor(
    status: number,
    code: string,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.details = details;
    this.status = status;
  }
}

export const authenticationRequired = (): ApiError =>
  new ApiError(401, 'AUTHENTICATION_REQUIRED', 'A valid bearer access token is required.');

export const accountNotActive = (): ApiError =>
  new ApiError(403, 'ACCOUNT_NOT_ACTIVE', 'This account is not active.');
