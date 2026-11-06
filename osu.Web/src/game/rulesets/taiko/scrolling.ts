// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of the scrolling pieces used by osu!taiko:
//  - osu.Game/Rulesets/UI/Scrolling/DrawableScrollingRuleset.cs (MultiplierControlPoint generation)
//  - osu.Game/Rulesets/Timing/MultiplierControlPoint.cs
//  - osu.Game/Rulesets/UI/Scrolling/Algorithms/OverlappingScrollAlgorithm.cs
//  - osu.Game.Rulesets.Taiko/UI/TaikoPlayfieldAdjustmentContainer.cs (playfield scale + ComputeTimeRange)

import type { ControlPointInfo, EffectControlPoint, TimingControlPoint } from '../../beatmaps/ControlPoints';
import { VELOCITY_MULTIPLIER } from './objects';

export interface MultiplierControlPoint {
  time: number;
  multiplier: number;
}

const DEFAULT_BEAT_LENGTH = 1000;

/** DrawableScrollingRuleset.load(): merges timing and effect points into aggregate multiplier points. */
export function createMultiplierControlPoints(controlPoints: ControlPointInfo, sliderMultiplier: number, lastObjectTime: number): MultiplierControlPoint[] {
  // RelativeScaleBeatLengths is false for taiko, so the base beat length is the default.
  const baseBeatLength = DEFAULT_BEAT_LENGTH;
  type P = { time: number; timing?: TimingControlPoint; effect?: EffectControlPoint };
  const all: P[] = [];
  for (const t of controlPoints.timingPoints) all.push({ time: t.time, timing: t });
  for (const e of controlPoints.effectPoints) all.push({ time: e.time, effect: e });
  all.sort((a, b) => a.time - b.time);

  let lastBeatLength = DEFAULT_BEAT_LENGTH;
  let lastScrollSpeed = 1;
  const out: MultiplierControlPoint[] = [];
  for (const p of all) {
    if (p.timing) lastBeatLength = p.timing.beatLength;
    if (p.effect) lastScrollSpeed = p.effect.scrollSpeed;
    // Collapse sections after the last hit object
    if (p.time > lastObjectTime) continue;
    const point = { time: p.time, multiplier: (sliderMultiplier * lastScrollSpeed * baseBeatLength) / lastBeatLength };
    // Collapse sections with the same start time (last wins)
    if (out.length > 0 && out[out.length - 1].time === p.time) out[out.length - 1] = point;
    else out.push(point);
  }
  if (out.length === 0) out.push({ time: 0, multiplier: sliderMultiplier });
  return out;
}

export class OverlappingScrollAlgorithm {
  constructor(readonly controlPoints: readonly MultiplierControlPoint[]) {}

  /** Finds the point which affects the speed of hitobjects at a specific time (the first one when before all points). */
  controlPointAt(time: number): MultiplierControlPoint {
    const list = this.controlPoints;
    if (time < list[0].time) return list[0];
    let lo = 0;
    let hi = list.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].time <= time) lo = mid + 1;
      else hi = mid - 1;
    }
    return list[lo - 1];
  }

  positionAt(time: number, currentTime: number, timeRange: number, scrollLength: number, originTime?: number): number {
    return ((time - currentTime) / timeRange) * this.controlPointAt(originTime ?? time).multiplier * scrollLength;
  }

  getLength(startTime: number, endTime: number, timeRange: number, scrollLength: number): number {
    return -this.positionAt(startTime, endTime, timeRange, scrollLength);
  }

  get minimumMultiplier(): number {
    let m = Infinity;
    for (const p of this.controlPoints) m = Math.min(m, p.multiplier);
    return m;
  }
}

export const TAIKO_BASE_HEIGHT = 200;
export const MAXIMUM_ASPECT = 16 / 9;
export const MINIMUM_ASPECT = 5 / 4;
const STABLE_GAMEFIELD_HEIGHT = 480;

export interface TaikoLayout {
  /** CSS pixels per playfield unit. */
  scale: number;
  /** Top of the playfield in CSS pixels. */
  top: number;
  /** Playfield width in playfield units. */
  width: number;
  /** Size of one osu! "game unit" in CSS pixels (the game is scaled to fit 1024x768). */
  unit: number;
}

/** TaikoPlayfieldAdjustmentContainer.Update(): computes the playfield scale for a given screen size. */
export function computeTaikoLayout(width: number, height: number, lockAspect = true): TaikoLayout {
  const baseRelativeHeight = TAIKO_BASE_HEIGHT / 768;
  let relativeHeight = baseRelativeHeight;
  if (lockAspect) {
    const currentAspect = width / height;
    if (currentAspect > MAXIMUM_ASPECT) relativeHeight *= currentAspect / MAXIMUM_ASPECT;
    else if (currentAspect < MINIMUM_ASPECT) relativeHeight *= currentAspect / MINIMUM_ASPECT;
  }
  // Limit the maximum relative height of the playfield to one-third of available area to avoid it masking out on extreme resolutions.
  relativeHeight = Math.min(relativeHeight, 1 / 3);
  const scale = (height / 768) * (relativeHeight / baseRelativeHeight);
  const unit = width / height >= 1024 / 768 ? height / 768 : width / 1024;
  return { scale, top: (height * 135) / STABLE_GAMEFIELD_HEIGHT, width: width / scale, unit };
}

/** TaikoPlayfieldAdjustmentContainer.ComputeTimeRange() */
export function computeTaikoTimeRange(width: number, height: number, lockAspect = true): number {
  let currentAspect = width / height;
  if (lockAspect) currentAspect = Math.min(Math.max(currentAspect, MINIMUM_ASPECT), MAXIMUM_ASPECT);
  // in a game resolution of 1024x768, stable's scrolling system consists of objects being placed 600px (widthScaled - 40) away from their hit location.
  // lazer adjusts the "in length" so that it's in a 640px->160px fashion before passing it down as a "time range".
  const stableHitLocation = 160;
  const widthScaled = currentAspect * STABLE_GAMEFIELD_HEIGHT;
  const inLength = widthScaled - stableHitLocation;
  // stable makes hit objects scroll from 760px->160px at a duration of 6000ms, divided by slider velocity (i.e. at a rate of 0.1px/ms)
  let inMsLength = (inLength / 100) * 1000;
  // stable multiplies the slider velocity by 1.4x, divide the time range by that factor to achieve similar result.
  inMsLength /= VELOCITY_MULTIPLIER;
  return inMsLength;
}
