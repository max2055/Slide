import type { MetricDefinition, MetricValue } from '../contracts/metrics-v2/index.js';

export type Rational = { numerator: bigint; denominator: bigint };
export type Scalar = Extract<MetricValue, { encoding: 'uint64' | 'int64' | 'float64' }>;
export function rational(numerator: bigint, denominator = 1n): Rational {
  if (denominator === 0n) throw new Error('ZERO_DENOMINATOR');
  if (denominator < 0n) { numerator = -numerator; denominator = -denominator; }
  let a = numerator < 0n ? -numerator : numerator, b = denominator;
  while (b) [a, b] = [b, a % b];
  return { numerator: numerator / a, denominator: denominator / a };
}
/** Decode the actual IEEE-754 value, without first rounding integers through Number. */
export function numberValue(value: number): Rational {
  if (!Number.isFinite(value)) throw new Error('NONFINITE_VALUE');
  if (value === 0) return rational(0n);
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0), exponent = Number((bits >> 52n) & 2047n);
  const mantissa = (bits & ((1n << 52n) - 1n)) + (exponent ? 1n << 52n : 0n);
  const shift = (exponent || 1) - 1023 - 52;
  const signed = bits >> 63n ? -mantissa : mantissa;
  return shift >= 0 ? rational(signed << BigInt(shift)) : rational(signed, 1n << BigInt(-shift));
}
export function decode(value: MetricValue): Rational {
  if (!('value' in value)) throw new Error('SCALAR_REQUIRED');
  return value.encoding === 'float64' ? numberValue(value.value) : rational(BigInt(value.value));
}
export const add = (a: Rational, b: Rational): Rational => rational(a.numerator * b.denominator + b.numerator * a.denominator, a.denominator * b.denominator);
export const subtract = (a: Rational, b: Rational): Rational => add(a, { ...b, numerator: -b.numerator });
export const multiply = (a: Rational, b: Rational): Rational => rational(a.numerator * b.numerator, a.denominator * b.denominator);
export const divide = (a: Rational, b: Rational): Rational => rational(a.numerator * b.denominator, a.denominator * b.numerator);
export const compare = (a: Rational, b: Rational): number => {
  const difference = a.numerator * b.denominator - b.numerator * a.denominator;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
};
export function unitFactor(from: MetricDefinition['unit'], to: MetricDefinition['unit']): Rational {
  if (from === to) return rational(1n);
  const factors: Record<string, [bigint, bigint]> = {
    's:ms': [1000n, 1n], 'ms:s': [1n, 1000n],
    'By/s:bit/s': [8n, 1n], 'bit/s:By/s': [1n, 8n],
    '1:%': [100n, 1n], '%:1': [1n, 100n],
  };
  const factor = factors[`${from}:${to}`];
  if (!factor) throw new Error('UNIT_CONVERSION');
  return rational(...factor);
}
export function encode(value: Rational, type: MetricDefinition['value_type']): { value: Scalar | null; exact: boolean } {
  if (type === 'int64' || type === 'uint64') {
    const lower = type === 'uint64' ? 0n : -(1n << 63n), upper = type === 'uint64' ? 1n << 64n : 1n << 63n;
    if (value.denominator !== 1n || value.numerator < lower || value.numerator >= upper) return { value: null, exact: false };
    return { value: { encoding: type, value: value.numerator.toString() }, exact: true };
  }
  if (type !== 'float64') throw new Error('SCALAR_REQUIRED');
  // Scale both integers before Number conversion to avoid Infinity/Infinity for large rationals.
  const abs = value.numerator < 0n ? -value.numerator : value.numerator;
  const nShift = Math.max(0, abs.toString(2).length - 54);
  const dShift = Math.max(0, value.denominator.toString(2).length - 54);
  const result = Number(value.numerator / (1n << BigInt(nShift))) / Number(value.denominator >> BigInt(dShift)) * 2 ** (nShift - dShift);
  if (!Number.isFinite(result)) return { value: null, exact: false };
  return { value: { encoding: 'float64', value: result }, exact: compare(numberValue(result), value) === 0 };
}
