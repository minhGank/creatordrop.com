const currencyPattern = /^[A-Z]{3}$/u;
const positiveMoneyPattern = /^[1-9][0-9]*$/u;

export const maximumMoneyMinor = 9_223_372_036_854_775_807n;
export const minimumMoneyMinor = -9_223_372_036_854_775_808n;

declare const currencyBrand: unique symbol;
declare const moneyMinorBrand: unique symbol;
declare const positiveMoneyMinorBrand: unique symbol;

export type Currency = string & { readonly [currencyBrand]: 'Currency' };
export type MoneyMinor = bigint & { readonly [moneyMinorBrand]: 'MoneyMinor' };
export type PositiveMoneyMinor = MoneyMinor & {
  readonly [positiveMoneyMinorBrand]: 'PositiveMoneyMinor';
};

export class MoneyValueError extends Error {
  readonly reason: 'currency' | 'format' | 'overflow' | 'positive';

  constructor(reason: MoneyValueError['reason']) {
    super(`Invalid monetary value: ${reason}.`);
    this.name = 'MoneyValueError';
    this.reason = reason;
  }
}

export const parseCurrency = (value: unknown): Currency => {
  if (typeof value !== 'string' || !currencyPattern.test(value)) {
    throw new MoneyValueError('currency');
  }
  return value as Currency;
};

export const toMoneyMinor = (value: bigint): MoneyMinor => {
  if (value < minimumMoneyMinor || value > maximumMoneyMinor) {
    throw new MoneyValueError('overflow');
  }
  return value as MoneyMinor;
};

export const parsePositiveMoneyMinor = (value: unknown): PositiveMoneyMinor => {
  if (typeof value !== 'string' || !positiveMoneyPattern.test(value)) {
    throw new MoneyValueError('format');
  }
  const parsed = BigInt(value);
  if (parsed > maximumMoneyMinor) throw new MoneyValueError('overflow');
  if (parsed <= 0n) throw new MoneyValueError('positive');
  return parsed as PositiveMoneyMinor;
};

export const addMoneyMinor = (left: MoneyMinor, right: MoneyMinor): MoneyMinor =>
  toMoneyMinor(left + right);

export const negateMoneyMinor = (value: MoneyMinor): MoneyMinor => {
  if (value === minimumMoneyMinor) throw new MoneyValueError('overflow');
  return toMoneyMinor(0n - BigInt(value));
};

export const moneyMinorToDecimal = (value: MoneyMinor): string => value.toString();
