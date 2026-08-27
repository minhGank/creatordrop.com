export class CatalogResourceNotFoundError extends Error {
  constructor() {
    super('The catalog resource was not found in the actor scope.');
    this.name = 'CatalogResourceNotFoundError';
  }
}

export class CatalogPermissionDeniedError extends Error {
  constructor() {
    super('The actor role does not permit this catalog action.');
    this.name = 'CatalogPermissionDeniedError';
  }
}

export class CatalogRevisionConflictError extends Error {
  readonly currentRevision: number;

  constructor(currentRevision: number) {
    super('The catalog resource revision is stale.');
    this.name = 'CatalogRevisionConflictError';
    this.currentRevision = currentRevision;
  }
}

export class CatalogDraftConflictError extends Error {
  constructor(message = 'The catalog draft conflicts with existing state.') {
    super(message);
    this.name = 'CatalogDraftConflictError';
  }
}

export class CatalogPublicationError extends Error {
  readonly reason:
    | 'BASE_REWARD_INVALID'
    | 'EMPTY_CONFIGURATION'
    | 'INELIGIBLE_REWARD'
    | 'INVALID_INVENTORY'
    | 'WEIGHT_OVERFLOW';

  constructor(reason: CatalogPublicationError['reason'], message: string) {
    super(message);
    this.name = 'CatalogPublicationError';
    this.reason = reason;
  }
}

export class CatalogImmutableError extends Error {
  constructor() {
    super('Published catalog configuration is immutable.');
    this.name = 'CatalogImmutableError';
  }
}
