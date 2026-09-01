export class FulfillmentNotFoundError extends Error {
  constructor() {
    super('The fulfillment was not found.');
    this.name = 'FulfillmentNotFoundError';
  }
}

export class FulfillmentPermissionDeniedError extends Error {
  constructor() {
    super('The fulfillment action is not permitted.');
    this.name = 'FulfillmentPermissionDeniedError';
  }
}

export class FulfillmentRevisionConflictError extends Error {
  constructor() {
    super('The fulfillment revision is stale.');
    this.name = 'FulfillmentRevisionConflictError';
  }
}

export class FulfillmentTransitionError extends Error {
  constructor() {
    super('The fulfillment transition is invalid.');
    this.name = 'FulfillmentTransitionError';
  }
}

export class FulfillmentDataUnavailableError extends Error {
  constructor() {
    super('The protected fulfillment data is unavailable.');
    this.name = 'FulfillmentDataUnavailableError';
  }
}

export class FulfillmentKeyUnavailableError extends Error {
  constructor() {
    super('The required fulfillment encryption key is unavailable.');
    this.name = 'FulfillmentKeyUnavailableError';
  }
}

export class FulfillmentCryptographyError extends Error {
  constructor() {
    super('Fulfillment cryptography failed.');
    this.name = 'FulfillmentCryptographyError';
  }
}

export class InventoryRestockError extends Error {
  constructor() {
    super('The inventory pool cannot be restocked.');
    this.name = 'InventoryRestockError';
  }
}
