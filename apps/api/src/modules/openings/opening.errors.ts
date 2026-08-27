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

export class OpeningRetryableError extends Error {
  constructor() {
    super('The opening transaction must be retried by the client.');
    this.name = 'OpeningRetryableError';
  }
}
