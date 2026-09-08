export class BoxNotOpenableError extends Error {
  constructor() {
    super('The box is not currently eligible for opening.');
    this.name = 'BoxNotOpenableError';
  }
}

export class InventoryUnavailableError extends Error {
  constructor() {
    super('The selected reward inventory is unavailable.');
    this.name = 'InventoryUnavailableError';
  }
}

export class OpeningCurrencyUnavailableError extends Error {
  constructor() {
    super('The published box currency is not enabled for openings.');
    this.name = 'OpeningCurrencyUnavailableError';
  }
}

export class OpeningConfirmationStaleError extends Error {
  constructor() {
    super('The confirmed box version is no longer current.');
    this.name = 'OpeningConfirmationStaleError';
  }
}

export class OpeningRetryableError extends Error {
  constructor() {
    super('The opening transaction must be retried by the client.');
    this.name = 'OpeningRetryableError';
  }
}

export class OpeningEntitlementRequiredError extends Error {
  constructor() {
    super('An available opening entitlement is required for this box.');
    this.name = 'OpeningEntitlementRequiredError';
  }
}

export class OpeningLimitReachedError extends Error {
  constructor() {
    super('The per-user opening limit for this box has been reached.');
    this.name = 'OpeningLimitReachedError';
  }
}
