// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game/Beatmaps/ControlPoints/* (+ LegacyControlPointInfo).

import { clamp } from '../../framework/math';

export interface ControlPoint {
  time: number;
}

export class TimingControlPoint implements ControlPoint {
  static readonly DEFAULT_BEAT_LENGTH = 1000;
  static readonly DEFAULT = Object.freeze(Object.assign(new TimingControlPoint(), { beatLength: 1000 })) as TimingControlPoint;
  time = 0;
  private _beatLength = TimingControlPoint.DEFAULT_BEAT_LENGTH;
  timeSignature = 4;
  omitFirstBarLine = false;

  get beatLength(): number {
    return this._beatLength;
  }

  set beatLength(v: number) {
    this._beatLength = clamp(v, 6, 60000);
  }

  get bpm(): number {
    return 60000 / this.beatLength;
  }
}

export class DifficultyControlPoint implements ControlPoint {
  static readonly DEFAULT = Object.freeze(new DifficultyControlPoint()) as DifficultyControlPoint;
  time = 0;
  private _sliderVelocity = 1;
  generateTicks = true;

  get sliderVelocity(): number {
    return this._sliderVelocity;
  }

  set sliderVelocity(v: number) {
    this._sliderVelocity = clamp(v, 0.1, 10);
  }
}

export class EffectControlPoint implements ControlPoint {
  static readonly DEFAULT = Object.freeze(new EffectControlPoint()) as EffectControlPoint;
  time = 0;
  kiaiMode = false;
  private _scrollSpeed = 1;

  get scrollSpeed(): number {
    return this._scrollSpeed;
  }

  set scrollSpeed(v: number) {
    this._scrollSpeed = clamp(v, 0.01, 10);
  }
}

export class SampleControlPoint implements ControlPoint {
  static readonly DEFAULT_BANK = 'normal';
  static readonly DEFAULT = Object.freeze(new SampleControlPoint()) as SampleControlPoint;
  time = 0;
  sampleBank = SampleControlPoint.DEFAULT_BANK;
  sampleVolume = 100;
  customSampleBank = 0;
}

function binarySearchRightmost<T extends ControlPoint>(list: readonly T[], time: number): number {
  // Returns index of the rightmost point with point.time <= time, or -1.
  if (list.length === 0 || time < list[0].time) return -1;
  if (time >= list[list.length - 1].time) return list.length - 1;
  let lo = 0;
  let hi = list.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].time <= time) lo = mid + 1;
    else hi = mid - 1;
  }
  return lo - 1;
}

function insertSorted<T extends ControlPoint>(list: T[], point: T): void {
  let i = list.length;
  while (i > 0 && list[i - 1].time > point.time) i--;
  list.splice(i, 0, point);
}

export class ControlPointInfo {
  readonly timingPoints: TimingControlPoint[] = [];
  readonly difficultyPoints: DifficultyControlPoint[] = [];
  readonly effectPoints: EffectControlPoint[] = [];
  readonly samplePoints: SampleControlPoint[] = [];

  add(time: number, point: ControlPoint): void {
    point.time = time;
    if (point instanceof TimingControlPoint) {
      // Replace an existing timing point at the same time (matches ControlPointGroup semantics).
      const existing = this.timingPoints.findIndex(p => p.time === time);
      if (existing >= 0) this.timingPoints.splice(existing, 1);
      insertSorted(this.timingPoints, point);
    } else if (point instanceof DifficultyControlPoint) {
      const existing = this.difficultyPoints.findIndex(p => p.time === time);
      if (existing >= 0) this.difficultyPoints.splice(existing, 1);
      insertSorted(this.difficultyPoints, point);
    } else if (point instanceof EffectControlPoint) {
      const existing = this.effectPoints.findIndex(p => p.time === time);
      if (existing >= 0) this.effectPoints.splice(existing, 1);
      insertSorted(this.effectPoints, point);
    } else if (point instanceof SampleControlPoint) {
      const existing = this.samplePoints.findIndex(p => p.time === time);
      if (existing >= 0) this.samplePoints.splice(existing, 1);
      insertSorted(this.samplePoints, point);
    }
  }

  timingPointAt(time: number): TimingControlPoint {
    const i = binarySearchRightmost(this.timingPoints, time);
    if (i >= 0) return this.timingPoints[i];
    return this.timingPoints.length > 0 ? this.timingPoints[0] : TimingControlPoint.DEFAULT;
  }

  difficultyPointAt(time: number): DifficultyControlPoint {
    const i = binarySearchRightmost(this.difficultyPoints, time);
    return i >= 0 ? this.difficultyPoints[i] : DifficultyControlPoint.DEFAULT;
  }

  effectPointAt(time: number): EffectControlPoint {
    const i = binarySearchRightmost(this.effectPoints, time);
    return i >= 0 ? this.effectPoints[i] : EffectControlPoint.DEFAULT;
  }

  samplePointAt(time: number): SampleControlPoint {
    const i = binarySearchRightmost(this.samplePoints, time);
    if (i >= 0) return this.samplePoints[i];
    return this.samplePoints.length > 0 ? this.samplePoints[0] : SampleControlPoint.DEFAULT;
  }

  get bpmMaximum(): number {
    if (this.timingPoints.length === 0) return 60;
    return 60000 / Math.min(...this.timingPoints.map(t => t.beatLength));
  }

  get bpmMinimum(): number {
    if (this.timingPoints.length === 0) return 60;
    return 60000 / Math.max(...this.timingPoints.map(t => t.beatLength));
  }

  /** Port of Beatmap.GetMostCommonBeatLength. */
  mostCommonBeatLength(lastTime: number): number {
    if (this.timingPoints.length === 0) return TimingControlPoint.DEFAULT_BEAT_LENGTH;
    const durations = new Map<number, number>();
    for (let i = 0; i < this.timingPoints.length; i++) {
      const t = this.timingPoints[i];
      if (t.time > lastTime) {
        durations.set(t.beatLength, (durations.get(t.beatLength) ?? 0) + 0);
        continue;
      }
      const nextTime = i === this.timingPoints.length - 1 ? lastTime : this.timingPoints[i + 1].time;
      const beatLength = Math.round(t.beatLength * 1000) / 1000;
      durations.set(beatLength, (durations.get(beatLength) ?? 0) + (nextTime - t.time));
    }
    let best = this.timingPoints[0].beatLength;
    let bestDuration = -1;
    for (const [bl, d] of durations) {
      if (d > bestDuration) {
        best = bl;
        bestDuration = d;
      }
    }
    return best;
  }
}
