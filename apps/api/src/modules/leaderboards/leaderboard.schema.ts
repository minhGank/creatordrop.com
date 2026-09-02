import { validate as isUuid } from 'uuid';

import { ApiError } from '../../http/errors.js';

const validationError = (message: string, field: string): ApiError =>
  new ApiError(400, 'VALIDATION_ERROR', message, { field });

const containsControlCharacter = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 31 || codeUnit === 127) return true;
  }
  return false;
};

export const parseLeaderboardUuid = (value: string | undefined, field: string): string => {
  if (value === undefined || !isUuid(value)) {
    throw validationError(`${field} must be a UUID.`, field);
  }
  return value.toLowerCase();
};

export const parseLeaderboardUsername = (value: string | undefined): string => {
  if (
    value === undefined ||
    value.length < 1 ||
    value.length > 64 ||
    containsControlCharacter(value)
  ) {
    throw validationError('username must be a valid public username.', 'username');
  }
  return value;
};
