export const entryErrorStatuses = {
  ENTRY_NOT_FOUND: 404,
  ENTRY_FORBIDDEN: 403,
  ENTRY_CONFLICT: 409,
  ENTRY_CLAIM_LIMIT_REACHED: 409,
  ENTRY_INVALID_INPUT: 400,
  ENTRY_REVISION_CONFLICT: 409,
  ENTRY_UNAVAILABLE: 409,
  ENTRY_STORAGE_UNAVAILABLE: 503,
} as const;
export class EntryError extends Error {
  constructor(readonly code: keyof typeof entryErrorStatuses) {
    super(
      code === 'ENTRY_INVALID_INPUT'
        ? 'The entry request is invalid.'
        : 'The entry operation could not be completed.',
    );
    this.name = 'EntryError';
  }
}
