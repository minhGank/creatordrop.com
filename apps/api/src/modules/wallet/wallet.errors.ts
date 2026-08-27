export class WalletNotFoundError extends Error {
  constructor() {
    super('The requested wallet was not found.');
    this.name = 'WalletNotFoundError';
  }
}

export class WalletCurrencyNotEnabledError extends Error {
  constructor() {
    super('The requested wallet currency is not enabled.');
    this.name = 'WalletCurrencyNotEnabledError';
  }
}

export class TestCreditsUnavailableError extends Error {
  constructor() {
    super('Test credit grants are unavailable in this runtime.');
    this.name = 'TestCreditsUnavailableError';
  }
}

export class InsufficientBalanceError extends Error {
  constructor() {
    super('The wallet has insufficient funds.');
    this.name = 'InsufficientBalanceError';
  }
}

export class WalletAmountOverflowError extends Error {
  constructor() {
    super('The wallet amount exceeds signed 64-bit storage.');
    this.name = 'WalletAmountOverflowError';
  }
}

export class IdempotencyKeyReusedError extends Error {
  constructor() {
    super('The idempotency key was reused for a different request.');
    this.name = 'IdempotencyKeyReusedError';
  }
}

export class LedgerTransactionNotFoundError extends Error {
  constructor() {
    super('The ledger transaction was not found.');
    this.name = 'LedgerTransactionNotFoundError';
  }
}

export class LedgerTransactionNotReversibleError extends Error {
  constructor() {
    super('The ledger transaction cannot be reversed independently.');
    this.name = 'LedgerTransactionNotReversibleError';
  }
}
