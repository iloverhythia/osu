// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game/Rulesets/Difficulty/Utils/DiffUtils.cs, plus small helpers that emulate the
// single-precision (osuTK Vector2 / float) arithmetic the C# difficulty calculator relies on.

export const f32 = Math.fround;

/** Square root of 2 */
export const SQRT2 = 1.414213562373095;

// ---- DiffUtils.Pow ----
// C# has a (double, int) overload which uses plain multiplication for small integer exponents.
// Use these where the C# call site passes an integer literal so results match bit-for-bit.
export const pow2 = (x: number): number => x * x;
export const pow3 = (x: number): number => x * x * x;
export const pow4 = (x: number): number => x * x * x * x;
export const pow5 = (x: number): number => x * x * x * x * x;
/** DiffUtils.Pow(double, double) */
export const pow = (x: number, e: number): number => Math.pow(x, e);

export const bpmToMilliseconds = (bpm: number, delimiter = 4): number => 60000.0 / delimiter / bpm;
export const millisecondsToBpm = (ms: number, delimiter = 4): number => 60000.0 / (ms * delimiter);

/** DiffUtils.Logistic(x, midpointOffset, multiplier, maxValue) */
export const logistic = (x: number, midpointOffset: number, multiplier: number, maxValue = 1): number =>
  maxValue / (1 + Math.exp(multiplier * (midpointOffset - x)));

/** DiffUtils.Logistic(exponent, maxValue) */
export const logisticExp = (exponent: number, maxValue = 1): number => maxValue / (1 + Math.exp(exponent));

/** DiffUtils.Norm(p, values) */
export function norm(p: number, ...values: number[]): number {
  let sum = 0;
  for (const x of values) sum += Math.pow(x, p);
  return Math.pow(sum, 1.0 / p);
}

export const clamp = (x: number, min: number, max: number): number => {
  // Math.Clamp semantics (NaN passes through).
  if (x < min) return min;
  if (x > max) return max;
  return x;
};

export function smoothstep(x: number, start: number, end: number): number {
  x = clamp((x - start) / (end - start), 0.0, 1.0);
  return x * x * (3.0 - 2.0 * x);
}

export function smootherstep(x: number, start: number, end: number): number {
  x = clamp((x - start) / (end - start), 0.0, 1.0);
  return x * x * x * (x * (6.0 * x - 15.0) + 10.0);
}

/** DiffUtils.SmoothstepBellCurve(x) */
export function smoothstepBellCurve(x: number): number {
  x = 0.5 - Math.abs(x - 0.5);
  x = clamp(x * 2.0, 0.0, 1.0);
  return x * x * (3.0 - 2.0 * x);
}

export const reverseLerp = (x: number, start: number, end: number): number => clamp((x - start) / (end - start), 0.0, 1.0);

export function erf(x: number): number {
  if (x === 0) return 0;
  if (x === Infinity) return 1;
  if (x === -Infinity) return -1;
  if (Number.isNaN(x)) return NaN;

  // Constants for approximation (Abramowitz and Stegun formula 7.1.26)
  const t = 1.0 / (1.0 + 0.3275911 * Math.abs(x));
  const tau = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const e = 1.0 - tau * Math.exp(-x * x);
  return x >= 0 ? e : -e;
}

export function erfInv(x: number): number {
  if (x <= -1) return -Infinity;
  if (x >= 1) return Infinity;
  if (x === 0) return 0;

  const a = 0.147;
  const sgn = Math.sign(x);
  x = Math.abs(x);

  const ln = Math.log(1 - x * x);
  const t1 = 2 / (Math.PI * a) + ln / 2;
  const t2 = ln / a;
  const baseApprox = Math.sqrt(t1 * t1 - t2) - t1;

  // Correction reduces max error from -0.005 to -0.00045.
  const c = x >= 0.85 ? Math.pow((x - 0.85) / 0.293, 8) : 0;
  return sgn * (Math.sqrt(baseApprox) + c);
}

/** osu.Framework Interpolation.Lerp(start, final, amount) */
export const lerp = (start: number, final: number, amount: number): number => start + (final - start) * amount;

/** .NET double.Lerp(value1, value2, amount) */
export const doubleLerp = (a: number, b: number, t: number): number => a * (1.0 - t) + b * t;

/** .NET double.DegreesToRadians */
export const degToRad = (deg: number): number => (deg * Math.PI) / 180.0;

// ---- single precision Vector2 emulation ----

export interface V2 {
  readonly x: number;
  readonly y: number;
}

export const v2 = (x: number, y: number): V2 => ({ x: f32(x), y: f32(y) });
export const vAdd = (a: V2, b: V2): V2 => ({ x: f32(a.x + b.x), y: f32(a.y + b.y) });
export const vSub = (a: V2, b: V2): V2 => ({ x: f32(a.x - b.x), y: f32(a.y - b.y) });
export const vMul = (a: V2, s: number): V2 => ({ x: f32(a.x * s), y: f32(a.y * s) });
/** osuTK Vector2.Length: (float)Math.Sqrt(X * X + Y * Y) with float intermediate arithmetic. */
export const vLength = (a: V2): number => f32(Math.sqrt(f32(f32(a.x * a.x) + f32(a.y * a.y))));
export const vDot = (a: V2, b: V2): number => f32(f32(a.x * b.x) + f32(a.y * b.y));

/** .NET double.CompareTo semantics (NaN sorts lowest). */
export function compareDouble(a: number, b: number): number {
  if (a < b) return -1;
  if (a > b) return 1;
  if (a === b) return 0;
  if (Number.isNaN(a)) return Number.isNaN(b) ? 0 : -1;
  return 1;
}
