const canonicalIntegerPattern = /^(?:0|[1-9][0-9]*)$/u;
const currencyPattern = /^[A-Z]{3}$/u;

export const formatMinorUnits = (minorUnits: string, currency: string): string => {
  if (!canonicalIntegerPattern.test(minorUnits) || !currencyPattern.test(currency)) {
    throw new Error('Money must use a canonical non-negative minor-unit string and ISO currency.');
  }

  const currencyFormatter = new Intl.NumberFormat('en-US', {
    currency,
    currencyDisplay: 'narrowSymbol',
    style: 'currency',
  });
  const fractionDigits = currencyFormatter.resolvedOptions().maximumFractionDigits ?? 2;
  const divisor = 10n ** BigInt(fractionDigits);
  const value = BigInt(minorUnits);
  const major = value / divisor;
  const minor = (value % divisor).toString().padStart(fractionDigits, '0');
  const groupedMajor = new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 0,
    useGrouping: true,
  }).format(major);
  const currencySymbol =
    currencyFormatter.formatToParts(0).find((part) => part.type === 'currency')?.value ?? currency;

  return `${currencySymbol}${groupedMajor}${fractionDigits === 0 ? '' : `.${minor}`}`;
};
