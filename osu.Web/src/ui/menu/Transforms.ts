// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Minimal port of osu-framework's transform semantics (osu.Framework/Graphics/Transforms/Transform.cs,
// TargetGroupingTransformTracker.cs) for a single numeric property, plus Interpolation.Damp.
//
// Semantics kept from osu-framework:
//  - a transform reads its start value when it first applies (i.e. at its start time), not when it is added;
//  - when a transform starts, older transforms of the same property are aborted;
//  - adding a transform removes transforms of the same property that start after it;
//  - transforms are pure functions of (start time, duration, easing, start value, end value).

import { applyEasing, Easing } from '../../game/storyboard/Easing';

export { Easing };

interface Tr {
  start: number;
  end: number;
  to: number;
  from: number;
  easing: number;
  started: boolean;
}

export class Anim {
  value: number;
  private ts: Tr[] = [];

  constructor(value = 0) {
    this.value = value;
  }

  /** Adds a transform to `to` beginning at absolute time `start` (ms) lasting `duration` ms. */
  to(to: number, start: number, duration = 0, easing: Easing = Easing.None): this {
    for (let i = this.ts.length - 1; i >= 0; i--) if (this.ts[i].start > start) this.ts.splice(i, 1);
    this.ts.push({ start, end: start + Math.max(0, duration), to, from: 0, easing, started: false });
    return this;
  }

  /** Sets the value immediately, clearing all transforms (`Drawable.X = ...` after ClearTransforms). */
  set(v: number): this {
    this.ts.length = 0;
    this.value = v;
    return this;
  }

  /** ClearTransforms: drops pending and running transforms, keeping the current value. */
  clear(): this {
    this.ts.length = 0;
    return this;
  }

  /** FinishTransforms: applies every transform to its end state immediately. */
  finish(): this {
    for (const t of this.ts) this.value = t.to;
    this.ts.length = 0;
    return this;
  }

  /** The end time of the latest transform (for `.Then()`), or -Infinity if none. */
  get endTime(): number {
    let e = -Infinity;
    for (const t of this.ts) e = Math.max(e, t.end);
    return e;
  }

  get hasTransforms(): boolean {
    return this.ts.length > 0;
  }

  update(now: number): number {
    const ts = this.ts;
    for (let i = 0; i < ts.length; i++) {
      const t = ts[i];
      if (now < t.start) break;
      if (!t.started) {
        // A newer transform of the same member has started: abort the older ones.
        if (i > 0) {
          ts.splice(0, i);
          i = 0;
        }
        t.started = true;
        t.from = this.value;
      }
      if (now >= t.end || t.end === t.start) this.value = t.to;
      else this.value = t.from + (t.to - t.from) * applyEasing(t.easing, (now - t.start) / (t.end - t.start));
    }
    // Drop completed transforms (keep the last started one until a newer one supersedes it is unnecessary once complete).
    while (ts.length > 0 && ts[0].started && now >= ts[0].end) ts.shift();
    return this.value;
  }
}

/** osu.Framework.Utils.Interpolation.Damp. */
export function damp(start: number, final: number, base: number, exponent: number): number {
  return lerp(final, start, Math.pow(base, exponent));
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Interpolation.ValueAt(time, val1, val2, startTime, endTime, easing). */
export function valueAt(time: number, val1: number, val2: number, startTime: number, endTime: number, easing: Easing = Easing.None): number {
  if (val1 === val2) return val1;
  const current = time - startTime;
  const duration = endTime - startTime;
  if (current === 0) return val1;
  if (duration === 0) return val2;
  return val1 + (val2 - val1) * applyEasing(easing, current / duration);
}

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** A drawable's Scheduler (AddDelayed / Schedule after a delayed sequence). */
export class Scheduler {
  private tasks: { time: number; fn: () => void; id: number }[] = [];
  private nextId = 1;

  add(time: number, fn: () => void): number {
    const id = this.nextId++;
    this.tasks.push({ time, fn, id });
    return id;
  }

  cancel(id: number | null | undefined): void {
    if (id == null) return;
    this.tasks = this.tasks.filter(t => t.id !== id);
  }

  clear(): void {
    this.tasks.length = 0;
  }

  update(now: number): void {
    if (this.tasks.length === 0) return;
    const due = this.tasks.filter(t => t.time <= now).sort((a, b) => a.time - b.time);
    if (due.length === 0) return;
    this.tasks = this.tasks.filter(t => t.time > now);
    for (const t of due) t.fn();
  }
}

/** Monotonic clock used for UI transforms. */
export const now = (): number => performance.now();
