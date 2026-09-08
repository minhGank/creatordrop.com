export class UsageAccountNotActiveError extends Error {
  constructor() {
    super('The usage actor account is not active.');
    this.name = 'UsageAccountNotActiveError';
  }
}
