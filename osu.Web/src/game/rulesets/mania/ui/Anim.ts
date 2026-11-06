// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// A minimal stand-in for osu-framework transform chains on a single numeric property
// (e.g. `FadeTo(1, 70, OutQuint).Then().FadeTo(0.8f, 500)`), evaluated as a pure function of time.
// Starting a new chain at time T continues from the value the previous chain had at T, like a new transform
// on the same property in osu-framework.

import { applyEasing, Easing } from '../../../storyboard/Easing';

interface Segment {
  start: number;
  duration: number;
  from: number;
  to: number;
  easing: Easing;
}

/** One step of a chain: [target value, duration, easing]. */
export type Step = readonly [to: number, duration: number, easing?: Easing];

export class Anim {
  private segments: Segment[] = [];

  constructor(private base: number) {}

  valueAt(time: number): number {
    let value = this.base;
    for (const s of this.segments) {
      if (time < s.start) break;
      if (s.duration <= 0 || time >= s.start + s.duration) value = s.to;
      else value = s.from + (s.to - s.from) * applyEasing(s.easing, (time - s.start) / s.duration);
    }
    return value;
  }

  /** Starts a sequential chain at `time` (each step `.Then()` the previous one). `jumpTo` sets the value instantly first. */
  start(time: number, steps: readonly Step[], jumpTo?: number): this {
    let from = jumpTo ?? this.valueAt(time);
    this.base = from;
    this.segments = [];
    let t = time;
    for (const [to, duration, easing = Easing.None] of steps) {
      this.segments.push({ start: t, duration, from, to, easing });
      t += duration;
      from = to;
    }
    return this;
  }
}
