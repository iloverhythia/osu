// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game/Rulesets/Difficulty/Preprocessing/DifficultyHitObject.cs and
// osu.Game.Rulesets.Osu/Difficulty/Preprocessing/OsuDifficultyHitObject.cs.
//
// The C# works on osuTK Vector2 (single precision) positions. To reproduce the reference values as closely as
// possible, the hit object data needed by the calculator is re-derived here (DiffObject) with float32 rounding,
// including circle scale / preempt / hit windows which C# computes from float BeatmapDifficulty values.

import type { ModSet } from '../../../mods/Mods';
import type { OsuPlayableBeatmap } from '../beatmap';
import { OsuHitObject, Slider, SliderRepeat, SliderTick, Spinner } from '../objects';
import { PREEMPT_MIN, PREEMPT_RANGE } from '../objects';
import { difficultyRange } from '../../../beatmaps/Difficulty';
import { TAIL_LENIENCY } from '../../../objects/SliderEventGenerator';
import { clamp, f32, pow, pow2, pow5, reverseLerp, V2, v2, vAdd, vDot, vLength, vMul, vSub } from './utils';

export const NORMALISED_RADIUS = 50; // Change radius to 50 to make 100 the diameter. Easier for mental maths.
export const NORMALISED_DIAMETER = NORMALISED_RADIUS * 2;
export const MIN_DELTA_TIME = 25;

// C# `const float` values (folded in single precision).
const MAXIMUM_SLIDER_RADIUS = f32(NORMALISED_RADIUS * f32(2.4));
const ASSUMED_SLIDER_RADIUS = f32(NORMALISED_RADIUS * f32(1.8));

/** OsuModHidden.FADE_IN_DURATION_MULTIPLIER / FADE_OUT_DURATION_MULTIPLIER */
const HD_FADE_IN_DURATION_MULTIPLIER = 0.4;
const HD_FADE_OUT_DURATION_MULTIPLIER = 0.3;

/** BeatmapDifficulty values as C# would hold them (floats), after EZ/HR. */
export interface FloatDifficulty {
  circleSize: number;
  approachRate: number;
  overallDifficulty: number;
  drainRate: number;
}

export function computeFloatDifficulty(playable: OsuPlayableBeatmap): FloatDifficulty {
  const src = playable.source?.difficulty ?? playable.difficulty;
  return applyFloatDifficultyMods(
    { circleSize: f32(src.circleSize), approachRate: f32(src.approachRate), overallDifficulty: f32(src.overallDifficulty), drainRate: f32(src.drainRate) },
    playable.mods,
  );
}

/** ModEasy / OsuModEasy / ModHardRock / OsuModHardRock ApplyToDifficulty, in single precision. */
export function applyFloatDifficultyMods(d: FloatDifficulty, mods: ModSet): FloatDifficulty {
  let { circleSize, approachRate, overallDifficulty, drainRate } = d;
  if (mods.has('EZ')) {
    const r = f32(0.5);
    circleSize = f32(circleSize * r);
    approachRate = f32(approachRate * r);
    drainRate = f32(drainRate * r);
    overallDifficulty = f32(overallDifficulty * r);
  }
  if (mods.has('HR')) {
    const r = f32(1.4);
    drainRate = Math.min(f32(drainRate * r), 10);
    overallDifficulty = Math.min(f32(overallDifficulty * r), 10);
    circleSize = Math.min(f32(circleSize * f32(1.3)), 10);
    approachRate = Math.min(f32(approachRate * r), 10);
  }
  return { circleSize, approachRate, overallDifficulty, drainRate };
}

/** LegacyRulesetExtensions.CalculateScaleFromCircleSize(circleSize, applyFudge: true) */
export function scaleFromCircleSize(circleSize: number): number {
  const r = f32(1.0 - f32(0.7) * ((circleSize - 5) / 5));
  return f32(f32(r / 2) * f32(1.00041));
}

/** OsuHitWindows great window (half-width) */
export const greatHitWindow = (od: number): number => Math.floor(difficultyRange(od, 80, 50, 20)) - 0.5;

export type DiffKind = 'circle' | 'slider' | 'spinner';

export interface DiffNested {
  readonly kind: 'head' | 'tick' | 'repeat' | 'tail';
  readonly startTime: number;
  readonly stackedPosition: V2;
}

/** The per-HitObject data used by the difficulty calculator (an OsuHitObject view with float32 maths). */
export class DiffObject {
  kind: DiffKind = 'circle';
  startTime = 0;
  endTime = 0;
  radius = 0;
  timePreempt = 0;
  timeFadeIn = 0;
  /** Raw (not rate adjusted, half-width) great hit window; 0 for spinners (HitWindows.Empty). */
  hitWindowGreat = 0;
  position: V2 = { x: 0, y: 0 };
  stackedPosition: V2 = { x: 0, y: 0 };
  stackedEndPosition: V2 = { x: 0, y: 0 };

  // sliders only
  repeatCount = 0;
  spanCount = 1;
  duration = 0;
  spanDuration = 0;
  /** Nested objects sorted by start time (HitObject.ApplyDefaults sorts NestedHitObjects). */
  nested: DiffNested[] = [];
  headStackedPosition: V2 = { x: 0, y: 0 };
  tailStackedPosition: V2 = { x: 0, y: 0 };
  slider: Slider | null = null;

  constructor(readonly source: OsuHitObject) {}

  /** SliderPath.PositionAt (relative to the slider head) rounded to float. */
  pathPositionAt(progress: number): V2 {
    const p = this.slider!.path.positionAt(progress);
    return v2(p.x, p.y);
  }
}

export function createDiffObjects(playable: OsuPlayableBeatmap, difficulty: FloatDifficulty): DiffObject[] {
  const scale = scaleFromCircleSize(difficulty.circleSize);
  const radius = f32(64 * scale);
  const preempt = Math.trunc(difficultyRange(difficulty.approachRate, PREEMPT_RANGE));
  const fadeIn = 400 * Math.min(1, preempt / PREEMPT_MIN);
  const great = greatHitWindow(difficulty.overallDifficulty);
  const hidden = playable.mods.has('HD');

  return playable.hitObjects.map(h => {
    const o = new DiffObject(h);
    o.startTime = h.startTime;
    o.endTime = h.endTime;
    o.radius = radius;
    o.timePreempt = preempt;
    o.timeFadeIn = fadeIn;
    o.position = v2(h.position.x, h.position.y);

    const stackOffsetValue = h instanceof Spinner ? 0 : f32(f32(h.stackHeight * scale) * f32(-6.4));
    const stackOffset: V2 = { x: stackOffsetValue, y: stackOffsetValue };
    o.stackedPosition = vAdd(o.position, stackOffset);
    o.stackedEndPosition = o.stackedPosition;

    if (h instanceof Spinner) {
      o.kind = 'spinner';
      o.hitWindowGreat = 0;
      if (hidden) o.timeFadeIn = preempt * HD_FADE_IN_DURATION_MULTIPLIER;
    } else if (h instanceof Slider) {
      o.kind = 'slider';
      o.slider = h;
      o.hitWindowGreat = great; // from the slider head (Slider itself has HitWindows.Empty)
      o.repeatCount = h.repeatCount;
      o.spanCount = h.repeatCount + 1;
      o.duration = o.endTime - o.startTime;
      o.spanDuration = o.duration / o.spanCount;

      // Slider.EndPosition => Position + this.CurvePositionAt(1)
      const endPosition = vAdd(o.position, o.pathPositionAt(o.spanCount % 2 === 1 ? 1 : 0));
      o.stackedEndPosition = vAdd(endPosition, stackOffset);
      o.headStackedPosition = o.stackedPosition;
      o.tailStackedPosition = o.stackedEndPosition;

      const nested: DiffNested[] = [];
      for (const n of h.nested) {
        if (n instanceof SliderTick) {
          nested.push({ kind: 'tick', startTime: n.startTime, stackedPosition: vAdd(vAdd(o.position, o.pathPositionAt(n.pathProgress)), stackOffset) });
        } else if (n instanceof SliderRepeat) {
          nested.push({ kind: 'repeat', startTime: n.startTime, stackedPosition: vAdd(vAdd(o.position, o.pathPositionAt(n.pathProgress)), stackOffset) });
        } else if (n.kind === 'sliderHead') {
          nested.push({ kind: 'head', startTime: n.startTime, stackedPosition: o.headStackedPosition });
        } else if (n.kind === 'sliderTail') {
          nested.push({ kind: 'tail', startTime: n.startTime, stackedPosition: o.tailStackedPosition });
        }
      }
      // Stable sort by start time (matches List.Sort for the small lists involved).
      o.nested = nested.map((n, i) => ({ n, i })).sort((a, b) => a.n.startTime - b.n.startTime || a.i - b.i).map(x => x.n);
    } else {
      o.kind = 'circle';
      o.hitWindowGreat = great;
      if (hidden) o.timeFadeIn = preempt * HD_FADE_IN_DURATION_MULTIPLIER;
    }
    return o;
  });
}

/** DifficultyHitObject + OsuDifficultyHitObject */
export class OsuDifficultyHitObject {
  readonly deltaTime: number;
  readonly startTime: number;
  readonly endTime: number;
  readonly hitWindowGreat: number;

  /** DeltaTime capped to a minimum of MIN_DELTA_TIME ms. */
  readonly adjustedDeltaTime: number;
  /** Time between the last object's end time and this object's start time, capped to MIN_DELTA_TIME. */
  lastObjectEndDeltaTime: number;
  jumpDistance = 0;
  lazyJumpDistance = 0;
  minimumJumpDistance = 0;
  minimumJumpTime = 0;
  travelDistance = 0;
  travelTime = 0;
  lazyEndPosition: V2 | null = null;
  lazyTravelDistance = 0;
  lazyTravelTime = 0;
  angle: number | null = null;
  normalisedVectorAngle: number | null = null;

  constructor(
    readonly baseObject: DiffObject,
    readonly lastObject: DiffObject,
    readonly clockRate: number,
    private readonly objects: OsuDifficultyHitObject[],
    readonly index: number,
  ) {
    this.deltaTime = (baseObject.startTime - lastObject.startTime) / clockRate;
    this.startTime = baseObject.startTime / clockRate;
    this.endTime = baseObject.endTime / clockRate;
    // DifficultyHitObject.HitWindow(HitResult.Great) => 2 * raw / ClockRate
    this.hitWindowGreat = (2 * baseObject.hitWindowGreat) / clockRate;

    // Capped to 25ms to prevent difficulty calculation breaking from simultaneous objects.
    this.adjustedDeltaTime = Math.max(this.deltaTime, MIN_DELTA_TIME);
    const last = this.previous(0);
    this.lastObjectEndDeltaTime = last ? Math.max(this.startTime - last.endTime, MIN_DELTA_TIME) : this.adjustedDeltaTime;

    this.computeSliderCursorPosition();
    this.setDistances(clockRate);
  }

  previous(skipCount = 0): OsuDifficultyHitObject | null {
    const i = this.index - (skipCount + 1);
    return i >= 0 && i < this.objects.length ? this.objects[i] : null;
  }

  next(skipCount = 0): OsuDifficultyHitObject | null {
    const i = this.index + (skipCount + 1);
    return i >= 0 && i < this.objects.length ? this.objects[i] : null;
  }

  /** Time (in ms) between the object first appearing and the time it needs to be clicked, adjusted by clock rate. */
  get preempt(): number {
    return this.baseObject.timePreempt / this.clockRate;
  }

  /** Selective bonus for maps with higher circle size. */
  get smallCircleBonus(): number {
    return Math.max(1.0, 1.0 + (30 - this.baseObject.radius) / 70);
  }

  /** Object's immediate OverallDifficulty value calculated from the raw hitwindow. */
  get overallDifficulty(): number {
    return (79.5 - this.hitWindowGreat / 2) / 6;
  }

  opacityAt(time: number, hidden: boolean): number {
    const b = this.baseObject;
    if (time > b.startTime) {
      // Consider a hitobject as being invisible when its start time is passed.
      return 0.0;
    }

    const fadeInStartTime = b.startTime - b.timePreempt;
    // Equal to `OsuHitObject.TimeFadeIn` minus any adjustments from the HD mod.
    const fadeInDuration = 400 * Math.min(1, b.timePreempt / PREEMPT_MIN);

    if (hidden) {
      // Taken from OsuModHidden.
      const fadeOutStartTime = b.startTime - b.timePreempt + b.timeFadeIn;
      const fadeOutDuration = b.timePreempt * HD_FADE_OUT_DURATION_MULTIPLIER;
      return Math.min(clamp((time - fadeInStartTime) / fadeInDuration, 0.0, 1.0), 1.0 - clamp((time - fadeOutStartTime) / fadeOutDuration, 0.0, 1.0));
    }

    return clamp((time - fadeInStartTime) / fadeInDuration, 0.0, 1.0);
  }

  /** How possible it is to doubletap this object together with the next one and get a perfect judgement, in range 0 to 1. */
  calculateDoubleTapFeasibility(nextObj: OsuDifficultyHitObject | null): number {
    if (nextObj == null) return 0;

    const currDeltaTime = Math.max(1, this.deltaTime);
    const nextDeltaTime = Math.max(1, nextObj.deltaTime);
    const deltaDifference = Math.abs(nextDeltaTime - currDeltaTime);
    const speedRatio = currDeltaTime / Math.max(currDeltaTime, deltaDifference);
    const windowRatio = pow5(Math.min(1, currDeltaTime / this.hitWindowGreat));

    // Can't doubletap if circles don't intersect
    const distanceFactor = pow2(reverseLerp(this.lazyJumpDistance, NORMALISED_DIAMETER, NORMALISED_RADIUS));

    return 1.0 - pow(speedRatio, distanceFactor * (1 - windowRatio));
  }

  private setDistances(clockRate: number): void {
    const base = this.baseObject;
    const last = this.lastObject;

    if (base.kind === 'slider') {
      // Bonus for repeat sliders until a better per nested object strain system can be achieved.
      this.travelDistance = this.lazyTravelDistance * Math.max(1, pow(base.repeatCount, 0.3));
      this.travelTime = Math.max(this.lazyTravelTime / clockRate, MIN_DELTA_TIME);
    }

    this.minimumJumpTime = this.adjustedDeltaTime;

    // We don't need to calculate either angle or distance when one of the last->curr objects is a spinner
    if (base.kind === 'spinner' || last.kind === 'spinner') return;

    // We will scale distances by this factor, so we can assume a uniform CircleSize among beatmaps.
    const scalingFactor = f32(NORMALISED_RADIUS / f32(base.radius));

    const lastDifficultyObject = this.previous(0);
    const lastLastDifficultyObject = this.previous(1);

    let lastCursorPosition = lastDifficultyObject != null ? getEndCursorPosition(lastDifficultyObject) : last.stackedPosition;

    this.jumpDistance = f32(vLength(vSub(last.stackedPosition, base.stackedPosition)) * scalingFactor);
    this.lazyJumpDistance = f32(vLength(vSub(base.stackedPosition, lastCursorPosition)) * scalingFactor);
    this.minimumJumpDistance = this.lazyJumpDistance;

    if (last.kind === 'slider' && lastDifficultyObject != null) {
      const lastTravelTime = Math.max(lastDifficultyObject.lazyTravelTime / clockRate, MIN_DELTA_TIME);
      this.minimumJumpTime = Math.max(this.adjustedDeltaTime - lastTravelTime, MIN_DELTA_TIME);

      // The player is assumed to jump the minimum of the "lazy" jump and the jump from the slider tail (flow pattern).
      const tailJumpDistance = f32(vLength(vSub(last.tailStackedPosition, base.stackedPosition)) * scalingFactor);
      this.minimumJumpDistance = Math.max(
        0,
        Math.min(this.lazyJumpDistance - f32(MAXIMUM_SLIDER_RADIUS - ASSUMED_SLIDER_RADIUS), f32(tailJumpDistance - MAXIMUM_SLIDER_RADIUS)),
      );
    }

    if (lastLastDifficultyObject != null && lastLastDifficultyObject.baseObject.kind !== 'spinner') {
      if (lastDifficultyObject!.baseObject.kind === 'slider' && lastDifficultyObject!.travelDistance > 0)
        lastCursorPosition = lastDifficultyObject!.baseObject.headStackedPosition;

      const lastLastCursorPosition = getEndCursorPosition(lastLastDifficultyObject);

      const angle = calculateAngle(base.stackedPosition, lastCursorPosition, lastLastCursorPosition);
      const sliderAngle = this.calculateSliderAngle(lastDifficultyObject!, lastLastCursorPosition);

      const v = vSub(base.stackedPosition, lastCursorPosition);
      this.normalisedVectorAngle = Math.atan2(Math.abs(v.y), Math.abs(v.x));

      this.angle = Math.min(angle, sliderAngle);
    }
  }

  private computeSliderCursorPosition(): void {
    const slider = this.baseObject;
    if (slider.kind !== 'slider') return;
    if (this.lazyEndPosition != null) return;

    // NOTE: intentionally matches the C#, which holds back the "correct" tracking end time to preserve known behaviour.
    let trackingEndTime = Math.max(slider.startTime + slider.duration + TAIL_LENIENCY, slider.startTime + slider.duration / 2);

    let nestedObjects = slider.nested;

    let lastRealTick: DiffNested | null = null;
    for (const n of slider.nested) if (n.kind === 'tick') lastRealTick = n;

    if (lastRealTick != null && lastRealTick.startTime > trackingEndTime) {
      trackingEndTime = lastRealTick.startTime;

      // When the last tick falls after the tracking end time, re-sort the nested objects (matches known diffcalc output).
      const reordered = nestedObjects.slice();
      reordered.splice(reordered.indexOf(lastRealTick), 1);
      reordered.push(lastRealTick);
      nestedObjects = reordered;
    }

    this.lazyTravelTime = trackingEndTime - slider.startTime;

    let endTimeMin = this.lazyTravelTime / slider.spanDuration;
    if (endTimeMin % 2 >= 1) endTimeMin = 1 - (endTimeMin % 1);
    else endTimeMin %= 1;

    // temporary lazy end position until a real result can be derived.
    this.lazyEndPosition = vAdd(slider.stackedPosition, slider.pathPositionAt(endTimeMin));

    let currCursorPosition = slider.stackedPosition;

    // lazySliderDistance is coded to be sensitive to scaling, this makes the maths easier with the thresholds being used.
    const scalingFactor = NORMALISED_RADIUS / slider.radius;

    for (let i = 1; i < nestedObjects.length; i++) {
      const currMovementObj = nestedObjects[i];

      let currMovement = vSub(currMovementObj.stackedPosition, currCursorPosition);
      let currMovementLength = scalingFactor * vLength(currMovement);

      // Amount of movement required so that the cursor position needs to be updated.
      let requiredMovement = ASSUMED_SLIDER_RADIUS;

      if (i === nestedObjects.length - 1) {
        // The end of a slider has special aim rules due to the relaxed time constraint on position.
        // We assume the player takes the simpler movement of the lazy end position or the actual end position.
        const lazyMovement = vSub(this.lazyEndPosition, currCursorPosition);
        if (vLength(lazyMovement) < vLength(currMovement)) currMovement = lazyMovement;
        currMovementLength = scalingFactor * vLength(currMovement);
      } else if (currMovementObj.kind === 'repeat') {
        // For a slider repeat, assume a tighter movement threshold to better assess repeat sliders.
        requiredMovement = NORMALISED_RADIUS;
      }

      if (currMovementLength > requiredMovement) {
        // this finds the positional delta from the required radius and the current position, and updates the currCursorPosition accordingly, as well as rewarding distance.
        currCursorPosition = vAdd(currCursorPosition, vMul(currMovement, f32((currMovementLength - requiredMovement) / currMovementLength)));
        currMovementLength *= (currMovementLength - requiredMovement) / currMovementLength;
        this.lazyTravelDistance += currMovementLength;
      }

      if (i === nestedObjects.length - 1) this.lazyEndPosition = currCursorPosition;
    }
  }

  private calculateSliderAngle(lastDifficultyObject: OsuDifficultyHitObject, lastLastCursorPosition: V2): number {
    const lastCursorPosition = getEndCursorPosition(lastDifficultyObject);

    if (lastDifficultyObject.baseObject.kind === 'slider' && lastDifficultyObject.travelDistance > 0) {
      const nested = lastDifficultyObject.baseObject.nested;
      lastLastCursorPosition = nested[nested.length - 2].stackedPosition;
    }

    return calculateAngle(this.baseObject.stackedPosition, lastCursorPosition, lastLastCursorPosition);
  }
}

function calculateAngle(currentPosition: V2, lastPosition: V2, lastLastPosition: V2): number {
  const v1 = vSub(lastLastPosition, lastPosition);
  const v2_ = vSub(currentPosition, lastPosition);
  const dot = vDot(v1, v2_);
  const det = f32(f32(v1.x * v2_.y) - f32(v1.y * v2_.x));
  return Math.abs(Math.atan2(det, dot));
}

function getEndCursorPosition(o: OsuDifficultyHitObject): V2 {
  return o.lazyEndPosition ?? o.baseObject.stackedPosition;
}
