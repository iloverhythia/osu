// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Pure-function evaluation of osu-framework transforms (Transformable.TransformTo / TargetGroupingTransformTracker semantics),
// osu.Framework.Utils.Interpolation (Damp / DampContinuously / ValueAt) and Color4Extensions (Darken / Lighten / Opacity),
// as used by the osu! drawables ported in this folder.

import { Easing, applyEasing, toLinear, toSRGB } from '../../storyboard/Easing';

export { Easing };

interface Transform {
  start: number;
  end: number;
  to: number;
  easing: Easing;
  /** Start value, read when the transform starts (cached lazily). */
  from: number;
  fromValid: boolean;
}

/**
 * A single transformable property. As in osu-framework:
 * - adding a transform removes the transforms of the same property which start after it;
 * - when a transform starts it reads the property's current value as its start value and supersedes any still-running one;
 * - transforms with the same start time apply in the order they were added.
 * The value is a pure function of time, so seeking / replays stay deterministic.
 */
export class Prop {
  private readonly ts: Transform[] = [];

  constructor(public initial: number) {}

  /** TransformTo(value, duration, easing) inside BeginAbsoluteSequence(start). Returns the end time (for `.Then()` chains). */
  to(start: number, value: number, duration = 0, easing: Easing = Easing.None): number {
    let n = this.ts.length;
    while (n > 0 && this.ts[n - 1].start > start) n--;
    this.ts.length = n;
    const end = start + Math.max(0, duration);
    this.ts.push({ start, end, to: value, easing, from: 0, fromValid: false });
    return end;
  }

  /** FadeInFromZero-style "set then transform": the value is set instantly at `start`, then transformed. */
  fromTo(start: number, from: number, value: number, duration = 0, easing: Easing = Easing.None): number {
    this.to(start, from);
    return this.to(start, value, duration, easing);
  }

  private startValue(i: number): number {
    const t = this.ts[i];
    if (!t.fromValid) {
      t.from = i === 0 ? this.initial : this.evalTransform(i - 1, t.start);
      t.fromValid = true;
    }
    return t.from;
  }

  private evalTransform(i: number, time: number): number {
    const t = this.ts[i];
    if (time >= t.end) return t.to;
    const from = this.startValue(i);
    if (time <= t.start) return from;
    return from + (t.to - from) * applyEasing(t.easing, (time - t.start) / (t.end - t.start));
  }

  at(time: number): number {
    // the latest-started transform (with start <= time) determines the value.
    for (let i = this.ts.length - 1; i >= 0; i--) if (this.ts[i].start <= time) return this.evalTransform(i, time);
    return this.initial;
  }

  /** LatestTransformEndTime */
  get endTime(): number {
    let e = -Infinity;
    for (const t of this.ts) if (t.end > e) e = t.end;
    return e;
  }

  get count(): number {
    return this.ts.length;
  }

  clear(initial = this.initial): void {
    this.ts.length = 0;
    this.initial = initial;
  }
}

/** Interpolation.ValueAt (clamped progress, as transforms are). */
export function valueAt(time: number, from: number, to: number, startTime: number, endTime: number, easing: Easing = Easing.None): number {
  if (from === to) return from;
  const duration = endTime - startTime;
  if (duration <= 0 || time >= endTime) return to;
  if (time <= startTime) return from;
  return from + (to - from) * applyEasing(easing, (time - startTime) / duration);
}

/** Eased progress (0..1) of a transform starting at `start` lasting `duration`. */
export function progressAt(time: number, start: number, duration: number, easing: Easing = Easing.None): number {
  if (time < start) return 0;
  if (duration <= 0 || time >= start + duration) return 1;
  return applyEasing(easing, (time - start) / duration);
}

/** Interpolation.Damp(start, final, base, exponent) */
export function damp(start: number, final: number, base: number, exponent: number): number {
  return start + (final - start) * (1 - Math.pow(base, exponent));
}

/** Interpolation.DampContinuously(current, target, halfTime, elapsedTime) */
export function dampContinuously(current: number, target: number, halfTime: number, elapsed: number): number {
  return damp(current, target, 0.5, elapsed / halfTime);
}

/** RGBA colour with components in 0..1 (osuTK Color4). */
export type Colour4 = [number, number, number, number];

export const fromHex = (hex: string, alpha = 1): Colour4 => {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255, alpha];
};

export const fromRgb = (c: readonly number[], alpha = 1): Colour4 => [c[0] / 255, c[1] / 255, c[2] / 255, alpha];

/** Color4Extensions.Darken: divides RGB by (1 + amount). */
export const darken = (c: Colour4, amount: number): Colour4 => {
  const s = 1 / (1 + amount);
  return [c[0] * s, c[1] * s, c[2] * s, c[3]];
};

/** Color4Extensions.Lighten: multiplies RGB by (1 + amount), clamped. */
export const lighten = (c: Colour4, amount: number): Colour4 => {
  const s = 1 + amount;
  return [Math.min(1, c[0] * s), Math.min(1, c[1] * s), Math.min(1, c[2] * s), c[3]];
};

/** Color4Extensions.Opacity */
export const opacity = (c: Colour4, a: number): Colour4 => [c[0], c[1], c[2], a];

/** Multiplies two colours (osu-framework colour inheritance: child colour * parent colour). */
export const multiply = (a: Colour4, b: Colour4): Colour4 => [a[0] * b[0], a[1] * b[1], a[2] * b[2], a[3] * b[3]];

/** Interpolation.ValueAt(Color4): gamma-correct interpolation (in linear space). */
export function lerpColour(a: Colour4, b: Colour4, t: number): Colour4 {
  if (t <= 0) return a;
  if (t >= 1) return b;
  const l = (x: number, y: number) => toSRGB(toLinear(x) + (toLinear(y) - toLinear(x)) * t);
  return [l(a[0], b[0]), l(a[1], b[1]), l(a[2], b[2]), a[3] + (b[3] - a[3]) * t];
}

/** CSS colour string, with an extra alpha multiplier. */
export function css(c: Colour4, alpha = 1): string {
  const a = Math.max(0, Math.min(1, c[3] * alpha));
  return `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a})`;
}

export const WHITE: Colour4 = [1, 1, 1, 1];
