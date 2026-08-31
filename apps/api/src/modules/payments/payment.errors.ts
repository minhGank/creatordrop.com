export class FundingUnavailableError extends Error {
  constructor() {
    super('Stripe wallet funding is unavailable in this runtime.');
    this.name = 'FundingUnavailableError';
  }
}

export class FundingAmountOutOfRangeError extends Error {
  constructor() {
    super('The funding amount is outside the configured limits.');
    this.name = 'FundingAmountOutOfRangeError';
  }
}

export class FundingProviderUnavailableError extends Error {
  constructor() {
    super('The funding provider is temporarily unavailable.');
    this.name = 'FundingProviderUnavailableError';
  }
}

export class FundingWebhookSignatureError extends Error {
  constructor() {
    super('The Stripe webhook signature is invalid.');
    this.name = 'FundingWebhookSignatureError';
  }
}

export class FundingEventRetryRequiredError extends Error {
  constructor() {
    super('The verified provider event must be retried.');
    this.name = 'FundingEventRetryRequiredError';
  }
}
