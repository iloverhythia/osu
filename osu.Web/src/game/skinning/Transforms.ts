// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Closed-form evaluation of osu-framework transform sequences (Easing / Interpolation.ValueAt / chained ScaleTo, FadeTo...),
// used by the legacy skin pieces which are defined in lazer as absolute-time transform sequences.

export enum Easing {
  None,
  Out,
  In,
  InQuad,
  OutQuad,
  OutSine,
  InSine,
  OutQuint,
  OutCubic,
  InCubic,
}

/** osu-framework DefaultEasingFunction */
export function applyEasing(easing: Easing, t: number): number {
  switch (easing) {
    case Easing.None:
      return t;
    case Easing.In:
    case Easing.InQuad:
      return t * t;
    case Easing.Out:
    case Easing.OutQuad:
      return t * (2 - t);
    case Easing.OutSine:
      return Math.sin((t * Math.PI) / 2);
    case Easing.InSine:
      return 1 - Math.cos((t * Math.PI) / 2);
    case Easing.OutQuint: {
      const u = t - 1;
      return u * u * u * u * u + 1;
    }
    case Easing.OutCubic: {
      const u = t - 1;
      return u * u * u + 1;
    }
    case Easing.InCubic:
      return t * t * t;
  }
}

/** Interpolation.ValueAt (clamped to the [startTime, endTime] range). */
export function valueAt(time: number, from: number, to: number, startTime: number, endTime: number, easing: Easing = Easing.None): number {
  const duration = endTime - startTime;
  if (from === to || duration === 0) return from;
  const t = Math.min(1, Math.max(0, (time - startTime) / duration));
  return from + (to - from) * applyEasing(easing, t);
}

export interface Step {
  /** Absolute start time. */
  start: number;
  duration: number;
  to: number;
  easing?: Easing;
  /** Explicit start value (e.g. FadeInFromZero); otherwise the property's value when the step starts. */
  from?: number;
}

/**
 * Value of a property driven by a list of transforms (in the order they were added), at `time`.
 * As in osu-framework, the latest-started transform wins and starts from the property's value at its start time.
 */
export function evaluate(time: number, initial: number, steps: readonly Step[], count = steps.length): number {
  let v = initial;
  for (let k = 0; k < count; k++) {
    const s = steps[k];
    if (time < s.start) continue;
    const from = s.from ?? evaluate(s.start, initial, steps, k);
    if (s.duration <= 0 || time >= s.start + s.duration) v = s.to;
    else v = from + (s.to - from) * applyEasing(s.easing ?? Easing.None, (time - s.start) / s.duration);
  }
  return v;
}

/** Fraction (0..1) of an eased transition starting at `start` lasting `duration`. */
export function progress(time: number, start: number, duration: number, easing: Easing = Easing.None): number {
  if (duration <= 0) return time >= start ? 1 : 0;
  const t = Math.min(1, Math.max(0, (time - start) / duration));
  return applyEasing(easing, t);
}
