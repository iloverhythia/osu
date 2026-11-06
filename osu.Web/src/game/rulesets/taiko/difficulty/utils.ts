// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of the parts of osu.Game/Rulesets/Difficulty/Utils/DiffUtils.cs used by osu!taiko difficulty calculation,
// plus small .NET semantics helpers.

/** DiffUtils.Logistic(x, midpointOffset, multiplier, maxValue) */
export function logistic(x: number, midpointOffset: number, multiplier: number, maxValue = 1): number {
  return maxValue / (1 + Math.exp(multiplier * (midpointOffset - x)));
}

/** DiffUtils.Logistic(exponent, maxValue) */
export function logisticExp(exponent: number, maxValue = 1): number {
  return maxValue / (1 + Math.exp(exponent));
}

/** DiffUtils.Norm */
export function norm(p: number, ...values: number[]): number {
  let sum = 0;
  for (const x of values) sum += Math.pow(x, p);
  return Math.pow(sum, 1.0 / p);
}

/** DiffUtils.BellCurve */
export function bellCurve(x: number, mean: number, width: number, multiplier = 1.0): number {
  return multiplier * Math.exp(Math.E * -(Math.pow(x - mean, 2) / Math.pow(width, 2)));
}

/** DiffUtils.Smootherstep */
export function smootherstep(x: number, start: number, end: number): number {
  x = Math.min(Math.max((x - start) / (end - start), 0.0), 1.0);
  return x * x * x * (x * (6.0 * x - 15.0) + 10.0);
}

/** DiffUtils.ReverseLerp */
export function reverseLerp(x: number, start: number, end: number): number {
  return Math.min(Math.max((x - start) / (end - start), 0.0), 1.0);
}

/** DiffUtils.Pow(double, int) for small integer exponents (exact repeated multiplication like the C#). */
export function powInt(x: number, exponent: number): number {
  switch (exponent) {
    case 0:
      return 1;
    case 1:
      return x;
    case 2:
      return x * x;
    case 3:
      return x * x * x;
    case 4:
      return x * x * x * x;
    case 5:
      return x * x * x * x * x;
    default:
      return Math.pow(x, exponent);
  }
}

/** Precision.AlmostEquals(double, double, acceptableDifference) */
export function almostEquals(a: number, b: number, acceptableDifference: number): boolean {
  return Math.abs(a - b) <= acceptableDifference;
}

/** double.IsNormal */
export function isNormal(x: number): boolean {
  return Number.isFinite(x) && x !== 0 && Math.abs(x) >= 2.2250738585072014e-308;
}

/** Math.Round(double) (MidpointRounding.ToEven) */
export function roundHalfEven(x: number): number {
  const r = Math.round(x);
  if (Math.abs(x % 1) === 0.5 && r % 2 !== 0) return r - 1;
  return r;
}

/** Comparer<double>.Default.Compare (NaN sorts before every other value). */
export function compareDouble(a: number, b: number): number {
  if (a < b) return -1;
  if (a > b) return 1;
  if (a === b) return 0;
  const an = Number.isNaN(a);
  const bn = Number.isNaN(b);
  if (an && bn) return 0;
  return an ? -1 : 1;
}

/** Enumerable.MinBy (first minimal element). */
export function minBy<T>(items: readonly T[], key: (t: T) => number): T {
  let best = items[0];
  let bestKey = key(best);
  for (let i = 1; i < items.length; i++) {
    const k = key(items[i]);
    if (compareDouble(k, bestKey) < 0) {
      best = items[i];
      bestKey = k;
    }
  }
  return best;
}

/** Enumerable.OrderDescending for doubles. */
export function orderDescending(values: readonly number[]): number[] {
  return values.slice().sort((a, b) => compareDouble(b, a));
}
