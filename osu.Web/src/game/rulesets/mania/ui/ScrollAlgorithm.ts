// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of DrawableScrollingRuleset control point setup (with DrawableManiaRuleset's adjustments),
// MultiplierControlPoint, SequentialScrollAlgorithm and Beatmap.GetMostCommonBeatLength.

import { EffectControlPoint, TimingControlPoint, type ControlPointInfo } from '../../../beatmaps/ControlPoints';
import { roundHalfEven } from '../utils';

/** DrawableManiaRuleset.MAX_TIME_RANGE: the time range at a scroll speed of 1. */
export const MAX_TIME_RANGE = 11485;
/** DrawableManiaRuleset.MIN_TIME_RANGE: the time range at a scroll speed of 40. */
export const MIN_TIME_RANGE = 290;

/** DrawableManiaRuleset.ComputeScrollTime: scroll time (ms) from a scroll speed in the range 1-40. */
export const computeScrollTime = (scrollSpeed: number): number => MAX_TIME_RANGE / scrollSpeed;

/** Beatmap.GetMostCommonBeatLength */
export function getMostCommonBeatLength(controlPoints: ControlPointInfo, lastObjectTime: number | null): number {
  const timingPoints = controlPoints.timingPoints;

  // The last playable time in the beatmap - the last timing point extends to this time.
  const lastTime = lastObjectTime ?? (timingPoints.length > 0 ? timingPoints[timingPoints.length - 1].time : 0);

  const groups = new Map<number, number>();
  for (let i = 0; i < timingPoints.length; i++) {
    const t = timingPoints[i];
    let duration: number;
    if (t.time > lastTime) duration = 0;
    else {
      // osu-stable forced the first control point to start at 0.
      const currentTime = i === 0 ? 0 : t.time;
      const nextTime = i === timingPoints.length - 1 ? lastTime : timingPoints[i + 1].time;
      duration = nextTime - currentTime;
    }
    const key = roundHalfEven(t.beatLength * 1000) / 1000;
    groups.set(key, (groups.get(key) ?? 0) + duration);
  }

  // OrderByDescending(duration).FirstOrDefault() — stable, so the first group wins ties.
  let best = 0;
  let bestDuration = -Infinity;
  for (const [beatLength, duration] of groups) {
    if (duration > bestDuration) {
      best = beatLength;
      bestDuration = duration;
    }
  }

  if (best === 0) return TimingControlPoint.DEFAULT_BEAT_LENGTH;

  let min = Infinity;
  let max = -Infinity;
  for (const t of timingPoints) {
    min = Math.min(min, t.beatLength);
    max = Math.max(max, t.beatLength);
  }
  return Math.min(Math.max(best, min), max);
}

interface MultiplierControlPoint {
  time: number;
  multiplier: number;
}

/**
 * The sequential scroll algorithm, expressed in "relative time": relativeTime(t) advances by `multiplier` per ms.
 * A position in pixels is (relativeTime(t) - relativeTime(current)) / timeRange * scrollLength.
 */
export class SequentialScroll {
  private readonly times: number[] = [];
  private readonly multipliers: number[] = [];
  private readonly positions: number[] = [];

  constructor(points: MultiplierControlPoint[]) {
    let position = 0;
    for (let i = 0; i < points.length; i++) {
      if (i > 0) position += (points[i].time - points[i - 1].time) * points[i - 1].multiplier;
      this.times.push(points[i].time);
      this.multipliers.push(points[i].multiplier);
      this.positions.push(position);
    }
  }

  /**
   * Builds the control points like DrawableScrollingRuleset.load + DrawableManiaRuleset.load:
   * mania ignores global velocity (Velocity = 1, BaseBeatLength scaled by the slider multiplier), relative beat lengths are used,
   * and converted beatmaps ignore effect-point scroll speed changes.
   */
  static forMania(controlPoints: ControlPointInfo, sliderMultiplier: number, lastObjectTime: number | null, isConvert: boolean): SequentialScroll {
    const lastTime = lastObjectTime ?? Number.MAX_VALUE;
    // RelativeScaleBeatLengths: baseBeatLength = mostCommon / SM, then mania multiplies by SM again.
    const baseBeatLength = (getMostCommonBeatLength(controlPoints, lastObjectTime) / sliderMultiplier) * sliderMultiplier;

    type P = { time: number; isTiming: boolean; timing?: TimingControlPoint; effect?: EffectControlPoint };
    const all: P[] = [
      ...controlPoints.timingPoints.map(t => ({ time: t.time, isTiming: true, timing: t })),
      ...controlPoints.effectPoints.map(e => ({ time: e.time, isTiming: false, effect: e })),
    ];
    // SortedList ordering by time (stable for equal times: timing points were added first).
    all.sort((a, b) => a.time - b.time);

    let lastTiming: TimingControlPoint = Object.assign(new TimingControlPoint(), { beatLength: TimingControlPoint.DEFAULT_BEAT_LENGTH });
    let lastEffect: EffectControlPoint = new EffectControlPoint();
    const defaultEffect = new EffectControlPoint();

    const byTime = new Map<number, MultiplierControlPoint>();
    for (const c of all) {
      if (c.isTiming) lastTiming = c.timing!;
      else lastEffect = c.effect!;

      if (c.time > lastTime) continue;

      // For non-mania beatmaps, speed changes should only happen through timing points.
      const effect = isConvert ? defaultEffect : lastEffect;
      // Velocity (1) * EffectPoint.ScrollSpeed * BaseBeatLength / TimingPoint.BeatLength; the last point of a time group wins.
      byTime.set(c.time, { time: c.time, multiplier: (effect.scrollSpeed * baseBeatLength) / lastTiming.beatLength });
    }

    const points = [...byTime.values()].sort((a, b) => a.time - b.time);

    if (points.length === 0) {
      // new MultiplierControlPoint { Velocity = SM } with mania's Velocity = 1 and BaseBeatLength = 1000 * SM.
      points.push({ time: 0, multiplier: sliderMultiplier });
    }

    return new SequentialScroll(points);
  }

  /** Relative position (in multiplier-scaled ms) of a time. */
  relativeTime(time: number): number {
    const times = this.times;
    if (times.length === 0) return time;

    // Rightmost mapping with time <= `time`, never underflowing the first one.
    let lo = 0;
    let hi = times.length - 1;
    let idx = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid] <= time) {
        idx = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }

    return this.positions[idx] + (time - times[idx]) * this.multipliers[idx];
  }
}
