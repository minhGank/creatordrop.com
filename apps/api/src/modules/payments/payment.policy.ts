import { parseCurrency, parsePositiveMoneyMinor } from '@creatordrop/domain';

export const stripeFundingPolicy = Object.freeze({
  currency: parseCurrency('USD'),
  maximumAmountMinor: parsePositiveMoneyMinor('50000'),
  minimumAmountMinor: parsePositiveMoneyMinor('500'),
  provider: 'stripe' as const,
});
