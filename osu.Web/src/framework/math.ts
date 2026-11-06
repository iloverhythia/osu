// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Small vector / precision helpers mirroring osuTK + osu.Framework.Utils.Precision.

export interface Vec2 {
  x: number;
  y: number;
}

export const vec = (x: number, y: number): Vec2 => ({ x, y });
export const ZERO: Readonly<Vec2> = Object.freeze({ x: 0, y: 0 });

export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, y: a.y * s });
export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
export const length = (a: Vec2): number => Math.hypot(a.x, a.y);
export const lengthSq = (a: Vec2): number => a.x * a.x + a.y * a.y;
export const distance = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);
export const distanceSq = (a: Vec2, b: Vec2): number => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
export const equals = (a: Vec2, b: Vec2): boolean => a.x === b.x && a.y === b.y;
export const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

export function normalize(a: Vec2): Vec2 {
  const len = length(a);
  return len === 0 ? { x: 0, y: 0 } : { x: a.x / len, y: a.y / len };
}

export const FLOAT_EPSILON = 1e-3;
export const DOUBLE_EPSILON = 1e-7;

export function almostEquals(a: number, b: number, epsilon = FLOAT_EPSILON): boolean {
  return Math.abs(a - b) <= epsilon;
}

export function definitelyBigger(a: number, b: number, epsilon = FLOAT_EPSILON): boolean {
  return a - epsilon > b;
}

export function almostEqualsVec(a: Vec2, b: Vec2, epsilon = FLOAT_EPSILON): boolean {
  return almostEquals(a.x, b.x, epsilon) && almostEquals(a.y, b.y, epsilon);
}

export const clamp = (v: number, min: number, max: number): number => (v < min ? min : v > max ? max : v);

/** Single-precision rounding, used where the C# code relies on float maths. */
export const f32 = Math.fround;

/** Binary search matching List<T>.BinarySearch semantics (returns ~insertionIndex when not found). */
export function binarySearch(list: ArrayLike<number>, value: number): number {
  let lo = 0;
  let hi = list.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = list[mid];
    if (v === value) return mid;
    if (v < value) lo = mid + 1;
    else hi = mid - 1;
  }
  return ~lo;
}

/** Deterministic PRNG (matches osu!stable's LegacyRandom / FastRandom). */
export class LegacyRandom {
  static readonly INT_MASK = 0x7fffffff;
  static readonly INT_TO_REAL = 1.0 / (0x7fffffff + 1.0);
  private x: number;
  private y = 842502087 >>> 0;
  private z = 3579807591 >>> 0;
  private w = 273326509 >>> 0;
  private bitBuffer = 0;
  private bitIndex = 32;

  constructor(seed: number) {
    this.x = seed >>> 0;
  }

  nextUInt(): number {
    const t = (this.x ^ (this.x << 11)) >>> 0;
    this.x = this.y;
    this.y = this.z;
    this.z = this.w;
    this.w = (this.w ^ (this.w >>> 19) ^ t ^ (t >>> 8)) >>> 0;
    return this.w;
  }

  next(): number {
    return (LegacyRandom.INT_MASK & this.nextUInt()) | 0;
  }

  nextDouble(): number {
    return LegacyRandom.INT_TO_REAL * this.next();
  }

  /** Random integer in [lowerBound, upperBound). */
  nextRange(lowerBound: number, upperBound: number): number {
    return Math.trunc(lowerBound + this.nextDouble() * (upperBound - lowerBound));
  }

  nextMax(upperBound: number): number {
    return Math.trunc(this.nextDouble() * upperBound);
  }

  nextBool(): boolean {
    if (this.bitIndex === 32) {
      this.bitBuffer = this.nextUInt();
      this.bitIndex = 1;
      return (this.bitBuffer & 1) === 1;
    }
    this.bitIndex++;
    this.bitBuffer = this.bitBuffer >>> 1;
    return (this.bitBuffer & 1) === 1;
  }
}
