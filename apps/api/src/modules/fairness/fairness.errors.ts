export class FairnessNotInitializedError extends Error {
  constructor() {
    super('Fairness state has not been initialized.');
    this.name = 'FairnessNotInitializedError';
  }
}

export class FairnessAlreadyInitializedError extends Error {
  constructor() {
    super('Fairness state was initialized with a different client seed.');
    this.name = 'FairnessAlreadyInitializedError';
  }
}

export class FairnessRevisionConflictError extends Error {
  readonly currentRevision: number;

  constructor(currentRevision: number) {
    super('The fairness profile revision is stale.');
    this.name = 'FairnessRevisionConflictError';
    this.currentRevision = currentRevision;
  }
}

export class SeedRotationRequiredError extends Error {
  constructor() {
    super('The active RNG seed set must be rotated before another nonce can be allocated.');
    this.name = 'SeedRotationRequiredError';
  }
}

export class SeedSetNotFoundError extends Error {
  constructor() {
    super('The RNG seed set was not found.');
    this.name = 'SeedSetNotFoundError';
  }
}

export class SeedSetUnavailableError extends Error {
  constructor() {
    super('No active RNG seed set is available.');
    this.name = 'SeedSetUnavailableError';
  }
}

export class SeedRevealNotAllowedError extends Error {
  constructor() {
    super('Only a retired RNG seed set can be revealed.');
    this.name = 'SeedRevealNotAllowedError';
  }
}

export class SeedSetCompromisedError extends Error {
  constructor() {
    super('RNG seed-set integrity verification failed.');
    this.name = 'SeedSetCompromisedError';
  }
}

export class SeedCryptographyError extends Error {
  constructor() {
    super('RNG seed cryptography operation failed.');
    this.name = 'SeedCryptographyError';
  }
}

export class SeedEncryptionKeyUnavailableError extends Error {
  constructor() {
    super('The required RNG seed encryption key is unavailable.');
    this.name = 'SeedEncryptionKeyUnavailableError';
  }
}

export class SeedReplacementKeyUnsafeError extends Error {
  constructor() {
    super('A compromised RNG encryption key cannot protect its replacement seed.');
    this.name = 'SeedReplacementKeyUnsafeError';
  }
}

export class SeedRotationIdempotencyConflictError extends Error {
  constructor() {
    super('The RNG rotation idempotency key was reused for a different operation.');
    this.name = 'SeedRotationIdempotencyConflictError';
  }
}
