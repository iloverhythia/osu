// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Helpers mapping osu-framework transforms onto the DOM. Easing curves come from the exact port of osu.Framework.Graphics.Easing:
// CSS transitions use a sampled `linear()` timing function, and per-frame values use `applyEasing` directly.

import { applyEasing, Easing } from '../../game/storyboard/Easing';

export { Easing };

const cssEasingCache = new Map<number, string>();
let linearSupported: boolean | null = null;

/** A CSS timing function reproducing an osu-framework easing (sampled `linear()`, falling back to an approximate cubic-bezier). */
export function cssEasing(easing: Easing): string {
  let s = cssEasingCache.get(easing);
  if (s) return s;
  linearSupported ??= typeof CSS !== 'undefined' && CSS.supports?.('transition-timing-function', 'linear(0, 1)') === true;
  if (easing === Easing.None) s = 'linear';
  else if (linearSupported) {
    const n = easing === Easing.OutElasticHalf || easing === Easing.OutElasticQuarter || easing === Easing.OutElastic ? 80 : 32;
    const pts: string[] = [];
    for (let i = 0; i <= n; i++) pts.push(+applyEasing(easing, i / n).toFixed(4) + '');
    s = `linear(${pts.join(', ')})`;
  } else s = 'cubic-bezier(0.22, 1, 0.36, 1)';
  cssEasingCache.set(easing, s);
  return s;
}

/** Sets a CSS transition for the given properties and applies the target values (Drawable.FadeTo / MoveTo / ... with one call). */
export function tween(el: HTMLElement | SVGElement, props: Partial<Record<'opacity' | 'transform' | 'width' | 'height' | 'color' | 'background' | 'backgroundColor' | 'filter' | 'left' | 'top' | 'paddingLeft' | 'borderColor', string>>, duration: number, easing: Easing = Easing.None, delay = 0): void {
  const style = (el as HTMLElement).style;
  const keys = Object.keys(props) as (keyof typeof props)[];
  const toCss = (k: string) => k.replace(/[A-Z]/g, c => '-' + c.toLowerCase());
  style.transition = duration > 0 || delay > 0 ? keys.map(k => `${toCss(k)} ${duration}ms ${cssEasing(easing)} ${delay}ms`).join(', ') : 'none';
  for (const k of keys) (style as unknown as Record<string, string>)[k] = props[k]!;
}

/** Runs a keyframe sequence (e.g. `FadeTo(0.8, 40).Then().FadeTo(0.4, length)`) using the Web Animations API. */
export function sequence(el: Element, steps: { props: Keyframe; duration: number; easing?: Easing }[], startFrom?: Keyframe): Animation | null {
  if (!('animate' in el)) return null;
  const total = steps.reduce((a, s) => a + s.duration, 0);
  if (total <= 0) return null;
  const frames: Keyframe[] = [];
  let t = 0;
  if (startFrom) frames.push({ ...startFrom, offset: 0 });
  for (const s of steps) {
    // per-segment easing is specified on the keyframe *preceding* the segment.
    if (frames.length > 0) frames[frames.length - 1].easing = cssEasing(s.easing ?? Easing.None);
    t += s.duration;
    frames.push({ ...s.props, offset: t / total });
  }
  return el.animate(frames, { duration: total, fill: 'forwards' });
}

/** Interpolation.DampContinuously */
export function dampContinuously(current: number, final: number, halfTime: number, elapsedTime: number): number {
  const exponent = elapsedTime / halfTime;
  return current + (final - current) * (1 - Math.pow(0.5, exponent));
}

/** A value transformed over time (`TransformTo(value, duration, easing)`), evaluated as a pure function of the clock. */
export class Tween {
  private from: number;
  private to: number;
  private start = 0;
  private duration = 0;
  private easing = Easing.None;

  constructor(value = 0) {
    this.from = this.to = value;
  }

  get target(): number {
    return this.to;
  }

  /** Starts a transform from the current value at `time`. */
  set(target: number, time: number, duration = 0, easing: Easing = Easing.None, delay = 0): void {
    const current = this.at(time);
    this.from = current;
    this.to = target;
    this.start = time + delay;
    this.duration = duration;
    this.easing = easing;
  }

  /** Instantly sets the value (FinishTransforms). */
  snap(value: number): void {
    this.from = this.to = value;
    this.duration = 0;
  }

  at(time: number): number {
    if (time <= this.start) return this.from;
    if (this.duration <= 0 || time >= this.start + this.duration) return this.to;
    return this.from + (this.to - this.from) * applyEasing(this.easing, (time - this.start) / this.duration);
  }

  isRunning(time: number): boolean {
    return time < this.start + this.duration;
  }
}
