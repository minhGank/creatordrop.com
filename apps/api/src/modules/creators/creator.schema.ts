import { validate as isUuid } from 'uuid';

import { ApiError } from '../../http/errors.js';
import { creatorRoles, type CreatorId, type CreatorRole, type UserId } from './creator.js';

export interface CreateCreatorInput {
  readonly customSlug: string;
  readonly displayName: string;
  readonly handle: string;
}

export interface UpdateCreatorInput {
  readonly displayName: string;
}

export interface AddCreatorMemberInput {
  readonly role: CreatorRole;
  readonly userId: UserId;
}

export interface UpdateCreatorMemberInput {
  readonly role: CreatorRole;
}

const handlePattern = /^[a-z0-9][a-z0-9_]{2,31}$/u;
const slugPattern = /^[a-z0-9][a-z0-9-]{2,62}$/u;
const quotedRevisionPattern = /^"(?<revision>[1-9][0-9]*)"$/u;

const validationError = (
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): ApiError => new ApiError(400, 'VALIDATION_ERROR', message, details);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const requireRecord = (body: unknown): Record<string, unknown> => {
  if (!isRecord(body)) {
    throw validationError('The request body must be a JSON object.');
  }

  return body;
};

const rejectUnknownFields = (
  record: Record<string, unknown>,
  allowedFields: readonly string[],
): void => {
  const unknownFields = Object.keys(record).filter((field) => !allowedFields.includes(field));

  if (unknownFields.length > 0) {
    throw validationError('The request contains unknown fields.', { unknownFields });
  }
};

const requireString = (record: Record<string, unknown>, field: string): string => {
  const value = record[field];

  if (typeof value !== 'string') {
    throw validationError(`${field} must be a string.`, { field });
  }

  return value;
};

const parseDisplayName = (record: Record<string, unknown>): string => {
  const displayName = requireString(record, 'displayName').trim();

  if (displayName.length < 1 || displayName.length > 100) {
    throw validationError('displayName must contain between 1 and 100 characters.', {
      field: 'displayName',
    });
  }

  return displayName;
};

const parseRole = (value: unknown): CreatorRole => {
  if (typeof value !== 'string' || !creatorRoles.includes(value as CreatorRole)) {
    throw validationError('role must be owner, manager, editor, or viewer.', { field: 'role' });
  }

  return value as CreatorRole;
};

export const parseCreatorId = (value: string | undefined): CreatorId => {
  if (value === undefined || !isUuid(value)) {
    throw validationError('creatorId must be a UUID.', { field: 'creatorId' });
  }

  return value as CreatorId;
};

export const parseUserId = (value: string | undefined): UserId => {
  if (value === undefined || !isUuid(value)) {
    throw validationError('userId must be a UUID.', { field: 'userId' });
  }

  return value as UserId;
};

export const trustedUserId = (value: string): UserId => {
  if (!isUuid(value)) {
    throw new Error('The authenticated local user ID is not a UUID.');
  }

  return value as UserId;
};

export const parseCreateCreatorInput = (body: unknown): CreateCreatorInput => {
  const record = requireRecord(body);
  rejectUnknownFields(record, ['customSlug', 'displayName', 'handle']);
  const handle = requireString(record, 'handle');
  const customSlug = requireString(record, 'customSlug');

  if (!handlePattern.test(handle)) {
    throw validationError(
      'handle must be 3–32 lowercase letters, numbers, or underscores and start with a letter or number.',
      { field: 'handle' },
    );
  }

  if (!slugPattern.test(customSlug)) {
    throw validationError(
      'customSlug must be 3–63 lowercase letters, numbers, or hyphens and start with a letter or number.',
      { field: 'customSlug' },
    );
  }

  return { customSlug, displayName: parseDisplayName(record), handle };
};

export const parseUpdateCreatorInput = (body: unknown): UpdateCreatorInput => {
  const record = requireRecord(body);
  rejectUnknownFields(record, ['displayName']);
  return { displayName: parseDisplayName(record) };
};

export const parseAddCreatorMemberInput = (body: unknown): AddCreatorMemberInput => {
  const record = requireRecord(body);
  rejectUnknownFields(record, ['role', 'userId']);
  return {
    role: parseRole(record.role),
    userId: parseUserId(typeof record.userId === 'string' ? record.userId : undefined),
  };
};

export const parseUpdateCreatorMemberInput = (body: unknown): UpdateCreatorMemberInput => {
  const record = requireRecord(body);
  rejectUnknownFields(record, ['role']);
  return { role: parseRole(record.role) };
};

export const parseExpectedRevision = (ifMatch: string | undefined): number => {
  if (ifMatch === undefined) {
    throw new ApiError(
      428,
      'PRECONDITION_REQUIRED',
      'If-Match with the current quoted creator revision is required.',
    );
  }

  const revisionText = quotedRevisionPattern.exec(ifMatch)?.groups?.revision;
  const revision = revisionText === undefined ? Number.NaN : Number(revisionText);

  if (!Number.isSafeInteger(revision) || revision < 1 || revision > 2_147_483_647) {
    throw validationError('If-Match must contain one quoted positive creator revision.', {
      field: 'If-Match',
    });
  }

  return revision;
};
