const positiveIntegerPattern = /^[1-9][0-9]*$/u;
const decimalPlaces = 6;
const percentageScale = 10n ** BigInt(decimalPlaces);

export const formatProbability = (weightText: string, totalText: string): string => {
  if (!positiveIntegerPattern.test(weightText) || !positiveIntegerPattern.test(totalText)) {
    throw new Error('Probability weights must be canonical positive integer strings.');
  }
  const weight = BigInt(weightText);
  const total = BigInt(totalText);
  if (weight > total) throw new Error('A probability weight cannot exceed the total weight.');

  const numerator = weight * 100n;
  const scaledNumerator = numerator * percentageScale;
  const rounded = (scaledNumerator + total / 2n) / total;
  if (rounded === 0n) return '<0.000001%';

  const whole = rounded / percentageScale;
  const fractional = (rounded % percentageScale).toString().padStart(decimalPlaces, '0');
  const trimmed = fractional.replace(/0+$/u, '').padEnd(2, '0');
  const exactAtDisplayedPrecision = scaledNumerator % total === 0n;
  return `${exactAtDisplayedPrecision ? '' : '≈'}${whole.toString()}.${trimmed}%`;
};
