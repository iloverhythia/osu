// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of StoryboardSprite.ApplyTransforms (osu.Game/Storyboards/StoryboardSprite.cs), the per-command ApplyInitialValue/ApplyTransforms
// implementations (osu.Game/Storyboards/Commands/*Command.cs, StoryboardLoopingGroup.StoryboardLoopingCommand) and
// StoryboardTriggerController.playTrigger, evaluated directly at a point in time instead of through osu-framework's transform system.
//
// The osu-framework semantics being reproduced (Transformable / TargetGroupingTransformTracker / TransformSequence.Loop):
// - Each command becomes transforms on one property, ordered by (StartTime, TransformID). Commands are applied in StartTime order
//   (stable over Commands.AllCommands followed by each loop's AllCommands), so TransformIDs follow that order.
// - At time t, the property has the value of the *last started* transform (greatest (StartTime, ID) with StartTime <= t), evaluated at t
//   (clamped to its end value once finished). Earlier transforms which are still running are superseded.
// - Before any transform has started, the property has its initial value: ApplyInitialValue of the chronologically first command for
//   that property (for parameter commands — flips and additive blending — only when that command has zero duration), else the default.
// - Tween commands are `X(StartValue).Then().X(EndValue, Duration, Easing)`: one segment. Parameter commands are
//   `TransformTo(StartValue).Delay(Duration).TransformTo(EndValue)`: two instantaneous segments at StartTime and EndTime.
// - Loops repeat each command TotalIterations times with an iteration period of the loop group's duration (no looping when it is zero).
// - Adding a transform removes all existing transforms of the same property which sort after it. This only happens for trigger groups
//   (which add transforms at runtime, relative to the trigger time) — see `addTriggerSegment`.

import { valueAtColour, valueAtNumber } from './Easing';
import { isParameterProperty, type CommandProperty, type StoryboardCommand, StoryboardLoopingCommand, type StoryboardTriggerGroup } from './Commands';
import type { StoryboardSprite } from './Storyboard';

export enum Prop {
  X,
  Y,
  Scale,
  VectorScale,
  Rotation,
  Colour,
  Alpha,
  Blending,
  FlipH,
  FlipV,
}

export const PROP_COUNT = 10;

const PROP_INDEX: Record<CommandProperty, Prop> = {
  X: Prop.X,
  Y: Prop.Y,
  Scale: Prop.Scale,
  VectorScale: Prop.VectorScale,
  Rotation: Prop.Rotation,
  Colour: Prop.Colour,
  Alpha: Prop.Alpha,
  Blending: Prop.Blending,
  FlipH: Prop.FlipH,
  FlipV: Prop.FlipV,
};

/** One transform (or one merged instant+tween pair) on a property. Values are encoded as up to 3 numbers (see `encode`). */
export interface Segment {
  start: number;
  end: number;
  easing: number;
  /** start value */
  a0: number;
  a1: number;
  a2: number;
  /** end value */
  b0: number;
  b1: number;
  b2: number;
  /** TransformID ordering key. */
  id: number;
}

/** A looping command: the segment of the first iteration, repeated `maxIter + 1` times every `period` ms. */
export interface LoopSegment extends Segment {
  period: number;
  /** Index of the last iteration which exists (-1 when the loop has been entirely removed by a trigger). */
  maxIter: number;
}

function encode(prop: Prop, value: unknown, out: number[]): void {
  switch (prop) {
    case Prop.VectorScale: {
      const v = value as { x: number; y: number };
      out[0] = v.x;
      out[1] = v.y;
      out[2] = 0;
      return;
    }
    case Prop.Colour: {
      const c = value as { r: number; g: number; b: number };
      out[0] = c.r;
      out[1] = c.g;
      out[2] = c.b;
      return;
    }
    case Prop.Blending:
      out[0] = value === 'Additive' ? 1 : 0;
      out[1] = out[2] = 0;
      return;
    case Prop.FlipH:
    case Prop.FlipV:
      out[0] = value ? 1 : 0;
      out[1] = out[2] = 0;
      return;
    default:
      out[0] = value as number;
      out[1] = out[2] = 0;
  }
}

const tmpA = [0, 0, 0];
const tmpB = [0, 0, 0];

function makeSegment(start: number, end: number, easing: number, a: number[], b: number[], id: number): Segment {
  return { start, end, easing, a0: a[0], a1: a[1], a2: a[2], b0: b[0], b1: b[1], b2: b[2], id };
}

/** Index of the first segment with start > x (segments sorted by (start, id)). */
function upperBound(list: readonly Segment[], x: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (list[mid].start <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const bySegmentKey = (a: Segment, b: Segment): number => a.start - b.start || a.id - b.id;

export class PropertyTimeline {
  readonly flat: Segment[] = [];
  readonly loops: LoopSegment[] = [];
  /** Transforms added at runtime by triggers (all with greater TransformIDs than the loaded ones). */
  readonly dynamic: Segment[] = [];
  /** Loaded (non-loop) segments starting after this time were removed by a trigger transform. */
  cutoff = Infinity;

  hasInitial = false;
  readonly initial = new Float64Array(3);
  /** Set by `evaluate`: whether the value is currently being interpolated between two different values. */
  tweening = false;

  constructor(readonly prop: Prop) {}

  /**
   * Evaluates the property at `time` into `out`. Returns false if no transform has started yet, in which case the caller should use
   * `initial` (when `hasInitial`) or the drawable's default value.
   */
  evaluate(time: number, out: Float64Array): boolean {
    let best: Segment | null = null;
    let bestStart = -Infinity;
    let bestId = -1;
    let shift = 0;

    const flat = this.flat;
    if (flat.length > 0) {
      const idx = upperBound(flat, time < this.cutoff ? time : this.cutoff) - 1;
      if (idx >= 0) {
        best = flat[idx];
        bestStart = best.start;
        bestId = best.id;
      }
    }

    const loops = this.loops;
    for (let i = 0; i < loops.length; i++) {
      const l = loops[i];
      if (l.maxIter < 0 || time < l.start) continue;
      let iter = l.period > 0 ? Math.floor((time - l.start) / l.period) : 0;
      if (iter > l.maxIter) iter = l.maxIter;
      const s = l.start + iter * l.period;
      if (s > bestStart || (s === bestStart && l.id > bestId)) {
        best = l;
        bestStart = s;
        bestId = l.id;
        shift = iter * l.period;
      }
    }

    const dyn = this.dynamic;
    if (dyn.length > 0) {
      const idx = upperBound(dyn, time) - 1;
      if (idx >= 0) {
        const d = dyn[idx];
        if (d.start > bestStart || (d.start === bestStart && d.id > bestId)) {
          best = d;
          shift = 0;
        }
      }
    }

    this.tweening = false;
    if (best === null) return false;

    const t = time - shift;
    if (t >= best.end) {
      out[0] = best.b0;
      out[1] = best.b1;
      out[2] = best.b2;
      return true;
    }

    this.tweening = best.a0 !== best.b0 || best.a1 !== best.b1 || best.a2 !== best.b2;
    switch (this.prop) {
      case Prop.Colour:
        valueAtColour(t, best.a0, best.a1, best.a2, best.b0, best.b1, best.b2, best.start, best.end, best.easing, out);
        break;
      case Prop.VectorScale:
        out[0] = valueAtNumber(t, best.a0, best.b0, best.start, best.end, best.easing);
        out[1] = valueAtNumber(t, best.a1, best.b1, best.start, best.end, best.easing);
        break;
      default:
        out[0] = valueAtNumber(t, best.a0, best.b0, best.start, best.end, best.easing);
    }
    return true;
  }

  /**
   * TargetGroupingTransformTracker.AddTransform for a transform added at runtime (trigger) at gameplay time `now`:
   * every existing transform of this property sorting after it is removed.
   */
  addDynamic(seg: Segment, now: number): void {
    if (seg.start < this.cutoff) this.cutoff = seg.start;

    // Loop iterations are materialised lazily by the framework (TransformSequence.Loop sets LoopCount/LoopDelay, and the next iteration is
    // re-added when the current one completes), so only the already-materialised next iteration can be removed — which ends the loop.
    for (const l of this.loops) {
      if (l.maxIter < 0) continue;
      let next: number;
      if (now < l.start) next = 0;
      else {
        let iter = l.period > 0 ? Math.floor((now - l.start) / l.period) : 0;
        if (iter > l.maxIter) iter = l.maxIter;
        next = now >= l.end + iter * l.period && iter + 1 <= l.maxIter ? iter + 1 : -1;
      }
      if (next >= 0 && l.start + next * l.period > seg.start) l.maxIter = next - 1;
    }

    const dyn = this.dynamic;
    let n = dyn.length;
    while (n > 0 && dyn[n - 1].start > seg.start) n--;
    dyn.length = n;
    dyn.push(seg);
  }
}

/** The drawable properties of a storyboard sprite, as evaluated at a point in time. */
export class SpriteState {
  x = 0;
  y = 0;
  scaleX = 1;
  scaleY = 1;
  vectorScaleX = 1;
  vectorScaleY = 1;
  /** degrees */
  rotation = 0;
  r = 1;
  g = 1;
  b = 1;
  alpha = 1;
  /** Whether the colour is mid-fade (changing every frame), which makes caching tinted textures pointless. */
  colourAnimating = false;
  additive = false;
  flipH = false;
  flipV = false;
}

const scratch = new Float64Array(3);

/**
 * The compiled transforms of one sprite (what `StoryboardSprite.ApplyTransforms` produces on its drawable), plus the trigger groups bound
 * to it by StoryboardTriggerController.
 */
export class SpriteTimeline {
  readonly props: (PropertyTimeline | null)[] = new Array(PROP_COUNT).fill(null);
  private nextDynamicId: number;

  constructor(readonly sprite: StoryboardSprite) {
    const commands: StoryboardCommand[] = sprite.commands.allCommands;
    for (const l of sprite.loopingGroups) for (const c of l.allCommands) commands.push(c);

    // For performance reasons, we need to apply the commands in chronological order (stable, like LINQ OrderBy).
    const ordered = commands.map((c, i) => ({ c, i }));
    ordered.sort((a, b) => a.c.startTime - b.c.startTime || a.i - b.i);

    const applied = new Set<Prop>();
    let k = 0;
    for (const { c } of ordered) {
      const prop = PROP_INDEX[c.property];
      let tl = this.props[prop];
      if (!tl) tl = this.props[prop] = new PropertyTimeline(prop);

      const parameter = isParameterProperty(c.property);

      if (!applied.has(prop)) {
        applied.add(prop);
        // ApplyInitialValue (looping commands delegate to the original command; its duration is the same).
        if (!parameter || c.startTime === c.endTime) {
          encode(prop, c.startValue, tmpA);
          tl.hasInitial = true;
          tl.initial[0] = tmpA[0];
          tl.initial[1] = tmpA[1];
          tl.initial[2] = tmpA[2];
        }
      }

      for (const seg of commandSegments(prop, c, parameter, 2 * k)) {
        if (c instanceof StoryboardLoopingCommand) {
          const group = c.loopingGroup;
          const period = group.duration;
          const loopSeg = seg as LoopSegment;
          loopSeg.period = period;
          loopSeg.maxIter = period === 0 ? 0 : group.totalIterations - 1;
          tl.loops.push(loopSeg);
        } else tl.flat.push(seg);
      }
      k++;
    }

    for (const tl of this.props) if (tl) tl.flat.sort(bySegmentKey);
    this.nextDynamicId = 2 * k;
  }

  /** Writes the value of every property at `time` into `state`, starting from the drawable's defaults. */
  evaluate(time: number, state: SpriteState): void {
    const p = this.props;
    const init = this.sprite.initialPosition;
    state.x = this.evalScalar(p[Prop.X], time, init.x);
    state.y = this.evalScalar(p[Prop.Y], time, init.y);
    const scale = this.evalScalar(p[Prop.Scale], time, 1);
    state.scaleX = scale;
    state.scaleY = scale;
    this.evalVectorScale(time, state);
    state.rotation = this.evalScalar(p[Prop.Rotation], time, 0);
    this.evalColour(time, state);
    state.alpha = this.evalScalar(p[Prop.Alpha], time, 1);
    state.additive = this.evalScalar(p[Prop.Blending], time, 0) === 1;
    state.flipH = this.evalScalar(p[Prop.FlipH], time, 0) === 1;
    state.flipV = this.evalScalar(p[Prop.FlipV], time, 0) === 1;
  }

  /** The raw (pre-flicker-modulo) alpha at `time`; used to skip invisible sprites cheaply. */
  alphaAt(time: number): number {
    return this.evalScalar(this.props[Prop.Alpha], time, 1);
  }

  private evalScalar(tl: PropertyTimeline | null, time: number, fallback: number): number {
    if (!tl) return fallback;
    if (tl.evaluate(time, scratch)) return scratch[0];
    return tl.hasInitial ? tl.initial[0] : fallback;
  }

  private evalVectorScale(time: number, state: SpriteState): void {
    const tl = this.props[Prop.VectorScale];
    if (!tl) {
      state.vectorScaleX = state.vectorScaleY = 1;
    } else if (tl.evaluate(time, scratch)) {
      state.vectorScaleX = scratch[0];
      state.vectorScaleY = scratch[1];
    } else if (tl.hasInitial) {
      state.vectorScaleX = tl.initial[0];
      state.vectorScaleY = tl.initial[1];
    } else state.vectorScaleX = state.vectorScaleY = 1;
  }

  private evalColour(time: number, state: SpriteState): void {
    const tl = this.props[Prop.Colour];
    state.colourAnimating = false;
    if (!tl) {
      state.r = state.g = state.b = 1;
    } else if (tl.evaluate(time, scratch)) {
      state.colourAnimating = tl.tweening;
      state.r = scratch[0];
      state.g = scratch[1];
      state.b = scratch[2];
    } else if (tl.hasInitial) {
      state.r = tl.initial[0];
      state.g = tl.initial[1];
      state.b = tl.initial[2];
    } else state.r = state.g = state.b = 1;
  }

  /**
   * StoryboardTriggerController.playTrigger: if the trigger group is active at `now`, its commands are applied relative to `now`
   * (`BeginDelayedSequence(command.StartTime)`), in start time order.
   */
  playTrigger(group: StoryboardTriggerGroup, now: number): void {
    if (!group.activeAt(now)) return;

    const ordered = group.allCommands.map((c, i) => ({ c, i }));
    ordered.sort((a, b) => a.c.startTime - b.c.startTime || a.i - b.i);

    for (const { c } of ordered) {
      const prop = PROP_INDEX[c.property];
      let tl = this.props[prop];
      if (!tl) tl = this.props[prop] = new PropertyTimeline(prop);
      const parameter = isParameterProperty(c.property);
      const id = this.nextDynamicId;
      this.nextDynamicId += 2;
      for (const seg of commandSegments(prop, c, parameter, id, now)) tl.addDynamic(seg, now);
    }
  }
}

/** The transforms generated by one command's ApplyTransforms, as segments (times offset by `offset`). */
function commandSegments(prop: Prop, c: StoryboardCommand, parameter: boolean, baseId: number, offset = 0): Segment[] {
  encode(prop, c.startValue, tmpA);
  encode(prop, c.endValue, tmpB);
  const start = c.startTime + offset;
  const end = c.endTime + offset;
  if (parameter) {
    // TransformTo(StartValue).Delay(Duration).TransformTo(EndValue): two instantaneous transforms.
    return [makeSegment(start, start, c.easing, tmpA, tmpA, baseId), makeSegment(end, end, c.easing, tmpB, tmpB, baseId + 1)];
  }
  // X(StartValue).Then().X(EndValue, Duration, Easing): the instantaneous transform is always superseded by the tween at the same time.
  return [makeSegment(start, end, c.easing, tmpA, tmpB, baseId + 1)];
}
