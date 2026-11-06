// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Minimal stand-in for osu-framework's transform system (Transformable.TransformTo / Delay / Then / Loop) used by the HUD port,
// plus the OsuColour / OverlayColourProvider values the gameplay screens use (osu.Game/Graphics/OsuColour.cs,
// osu.Game/Overlays/OverlayColourProvider.cs) and Interpolation.DampContinuously (osu.Framework/Utils/Interpolation.cs).
//
// A transform's start value is the value at its start time (as in osu-framework), and adding a transform removes any
// transforms of the same property which start at or after it.

import { Easing, applyEasing } from '../../game/storyboard/Easing';

export { Easing };

interface Segment {
  start: number;
  duration: number;
  from: number;
  to: number;
  easing: Easing;
}

/** A single animatable number. All times are in the same clock domain (usually performance.now()). */
export class Anim {
  private segments: Segment[] = [];
  private base: number;
  /** End of the last queued transform (osu-framework's TransformSequence "Then" anchor). */
  private tail = -Infinity;

  constructor(initial = 0) {
    this.base = initial;
  }

  valueAt(time: number): number {
    let v = this.base;
    const segs = this.segments;
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      if (time < s.start) break;
      if (s.duration <= 0 || time >= s.start + s.duration) v = s.to;
      else v = s.from + (s.to - s.from) * applyEasing(s.easing, (time - s.start) / s.duration);
    }
    return v;
  }

  /** TransformTo(target, duration, easing) starting at `start`. */
  to(target: number, duration: number, easing: Easing, start: number): this {
    const from = this.valueAt(start);
    this.truncate(start);
    this.segments.push({ start, duration, from, to: target, easing });
    this.tail = start + Math.max(0, duration);
    return this;
  }

  /** Instantly set the value at `start` (a zero-duration transform). */
  set(value: number, start: number): this {
    return this.to(value, 0, Easing.None, start);
  }

  /** Queue a transform after the previously added one (`.Then()`). */
  then(target: number, duration: number, easing: Easing = Easing.None, delay = 0): this {
    const start = this.tail + delay;
    const from = this.valueAt(start);
    this.segments = this.segments.filter(s => s.start < start);
    this.segments.push({ start, duration, from, to: target, easing });
    this.tail = start + Math.max(0, duration);
    return this;
  }

  /** Time the last queued transform ends at. */
  get endTime(): number {
    return this.tail;
  }

  /** Whether any transform is still running (or queued) at `time`. */
  isAnimating(time: number): boolean {
    return time < this.tail;
  }

  /** FinishTransforms: jump to the final value. */
  finish(): void {
    const last = this.segments[this.segments.length - 1];
    if (last) this.base = last.to;
    this.segments = [];
    this.tail = -Infinity;
  }

  private truncate(start: number): void {
    // Remove transforms starting at/after the new one, and collapse completed ones (keeping the value they produced).
    const segs = this.segments.filter(s => s.start < start);
    let collapse = 0;
    for (let i = 0; i < segs.length - 1; i++) {
      const s = segs[i];
      if (s.start + s.duration <= start && segs[i + 1].start <= start) collapse = i + 1;
      else break;
    }
    if (collapse > 0) {
      this.base = segs[collapse - 1].to;
      segs.splice(0, collapse);
    }
    this.segments = segs;
  }
}

export type RGBA = [number, number, number, number];

/** An animatable colour (FadeColour / TransformTo(nameof(Colour))): RGBA in 0..1 floats. */
export class ColourAnim {
  readonly c: [Anim, Anim, Anim, Anim];

  constructor(initial: RGBA) {
    this.c = [new Anim(initial[0]), new Anim(initial[1]), new Anim(initial[2]), new Anim(initial[3])];
  }

  to(target: RGBA, duration: number, easing: Easing, start: number): this {
    for (let i = 0; i < 4; i++) this.c[i].to(target[i], duration, easing, start);
    return this;
  }

  set(target: RGBA, start: number): this {
    return this.to(target, 0, Easing.None, start);
  }

  then(target: RGBA, duration: number, easing: Easing = Easing.None): this {
    for (let i = 0; i < 4; i++) this.c[i].then(target[i], duration, easing);
    return this;
  }

  valueAt(time: number): RGBA {
    return [this.c[0].valueAt(time), this.c[1].valueAt(time), this.c[2].valueAt(time), this.c[3].valueAt(time)];
  }
}

/** Interpolation.DampContinuously(current, target, halfTime, elapsed). */
export function dampContinuously(current: number, target: number, halfTime: number, elapsed: number): number {
  const exponent = elapsed / halfTime;
  return target + (current - target) * Math.pow(0.5, exponent);
}

/** Interpolation.Lerp. */
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Interpolation.ValueAt for numbers. */
export function valueAt(time: number, v1: number, v2: number, startTime: number, endTime: number, easing: Easing): number {
  if (time <= startTime) return v1;
  if (time >= endTime) return v2;
  return v1 + (v2 - v1) * applyEasing(easing, (time - startTime) / (endTime - startTime));
}

export const hex = (h: string, a = 1): RGBA => {
  let s = h.replace('#', '');
  if (s.length === 3) s = s.split('').map(c => c + c).join('');
  return [parseInt(s.slice(0, 2), 16) / 255, parseInt(s.slice(2, 4), 16) / 255, parseInt(s.slice(4, 6), 16) / 255, a];
};

export const css = (c: RGBA, alphaMul = 1): string =>
  `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${Math.max(0, Math.min(1, c[3] * alphaMul))})`;

export const opacity = (c: RGBA, a: number): RGBA => [c[0], c[1], c[2], a];

export const gray = (amt: number, a = 1): RGBA => [amt, amt, amt, a];

/** osu-framework Color4Extensions.Lighten. */
export function lighten(c: RGBA, amount: number): RGBA {
  amount *= 0.5;
  const f = (x: number) => Math.min(1, x * (1 + 0.5 * amount) + amount);
  return [f(c[0]), f(c[1]), f(c[2]), c[3]];
}

/** osu-framework Color4Extensions.Darken. */
export function darken(c: RGBA, amount: number): RGBA {
  const scalar = Math.max(1, 1 + amount);
  return [c[0] / scalar, c[1] / scalar, c[2] / scalar, c[3]];
}

/** Colour4.FromHSL. */
export function fromHSL(h: number, s: number, l: number, a = 1): RGBA {
  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  if (s === 0) return [l, l, l, a];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue2rgb(p, q, h + 1 / 3), hue2rgb(p, q, h), hue2rgb(p, q, h - 1 / 3), a];
}

/** OsuColour values used by the gameplay HUD and overlays. */
export const OsuColour = {
  Red: hex('ed1121'),
  RedLight: hex('ed7787'),
  Yellow: hex('ffcc22'),
  YellowLight: hex('ffdd55'),
  YellowDark: hex('eeaa00'),
  Green: hex('88b300'),
  GreenLight: hex('b3d944'),
  Blue: hex('66ccff'),
  BlueLight: hex('99eeff'),
  BlueLighter: hex('ddffff'),
  BlueDark: hex('44aadd'),
  PinkDarker: hex('bb1177'),
  Gray1: hex('111'),
  Blue0: hex('99ddff'),
  Blue1: hex('66ccff'),
  Red1: hex('ff6666'),
  Red2: hex('eb4747'),
  Red3: hex('cc3333'),
  Lime1: hex('b2ff66'),
  Purple1: hex('8c66ff'),
  Pink1: hex('ff66ab'),
  Orange1: hex('ffd966'),
  Orange3: hex('cca633'),
};

/** OverlayColourProvider(OverlayColourScheme.Purple) (hue 255). */
export const PurpleProvider = {
  background3: fromHSL(255 / 360, 0.1, 0.25),
  background4: fromHSL(255 / 360, 0.1, 0.2),
  background6: fromHSL(255 / 360, 0.1, 0.1),
};

/** Font stack substituting Torus / Venera (not redistributable) with the app font. */
export const FONT = '"Exo 2", system-ui, sans-serif';
