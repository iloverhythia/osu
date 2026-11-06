// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Ruleset-agnostic beatmap model (port of Beatmap / BeatmapInfo / BeatmapMetadata + legacy convert objects).

import type { HitSampleInfo } from '../audio/HitSampleInfo';
import { SliderPath } from '../objects/SliderPath';
import { ControlPointInfo } from './ControlPoints';
import { BeatmapDifficulty } from './Difficulty';

export interface BeatmapMetadata {
  title: string;
  titleUnicode: string;
  artist: string;
  artistUnicode: string;
  creator: string;
  source: string;
  tags: string;
  audioFile: string;
  backgroundFile: string;
  previewTime: number;
}

export interface BreakPeriod {
  startTime: number;
  endTime: number;
}

/** Breaks shorter than this are not considered significant (BreakPeriod.MIN_BREAK_DURATION). */
export const MIN_BREAK_DURATION = 650;

export const LegacyHitObjectType = {
  Circle: 1,
  Slider: 1 << 1,
  NewCombo: 1 << 2,
  Spinner: 1 << 3,
  ComboOffset: (1 << 4) | (1 << 5) | (1 << 6),
  Hold: 1 << 7,
} as const;

export type ConvertKind = 'circle' | 'slider' | 'spinner' | 'hold';

/** A hit object as decoded from a .osu file, before conversion to a specific ruleset. */
export class ConvertHitObject {
  kind: ConvertKind;
  startTime = 0;
  x = 0;
  y = 0;
  newCombo = false;
  comboOffset = 0;
  legacyType = 0;
  samples: HitSampleInfo[] = [];

  // Slider-only
  path: SliderPath = new SliderPath();
  repeatCount = 0;
  nodeSamples: HitSampleInfo[][] = [];
  velocity = 1;
  sliderVelocityMultiplier = 1;
  generateTicks = true;

  // Spinner / hold only
  private _duration = 0;

  constructor(kind: ConvertKind) {
    this.kind = kind;
  }

  get spanCount(): number {
    return this.repeatCount + 1;
  }

  get duration(): number {
    if (this.kind === 'slider') return (this.spanCount * this.path.distance) / this.velocity;
    return this._duration;
  }

  set duration(v: number) {
    this._duration = v;
  }

  get endTime(): number {
    return this.startTime + this.duration;
  }

  get hasDuration(): boolean {
    return this.kind !== 'circle';
  }

  /** ConvertSlider.ApplyDefaultsToSelf */
  applyDefaults(controlPoints: ControlPointInfo, difficulty: BeatmapDifficulty): void {
    if (this.kind === 'slider') {
      const timingPoint = controlPoints.timingPointAt(this.startTime);
      const scoringDistance = 100 * difficulty.sliderMultiplier * this.sliderVelocityMultiplier;
      this.velocity = scoringDistance / timingPoint.beatLength;
    }
  }
}

export class Beatmap {
  formatVersion = 14;
  /** 0 = osu!, 1 = taiko, 2 = catch, 3 = mania */
  rulesetId = 0;
  metadata: BeatmapMetadata = {
    title: '',
    titleUnicode: '',
    artist: '',
    artistUnicode: '',
    creator: '',
    source: '',
    tags: '',
    audioFile: '',
    backgroundFile: '',
    previewTime: -1,
  };
  difficultyName = '';
  onlineId = -1;
  beatmapSetOnlineId = -1;
  difficulty = new BeatmapDifficulty();
  controlPoints = new ControlPointInfo();
  breaks: BreakPeriod[] = [];
  hitObjects: ConvertHitObject[] = [];
  comboColours: [number, number, number][] = [];
  customColours: Record<string, [number, number, number, number]> = {};
  audioLeadIn = 0;
  stackLeniency = Math.fround(0.7);
  countdown = 1;
  countdownOffset = 0;
  specialStyle = false;
  epilepsyWarning = false;
  samplesMatchPlaybackRate = false;
  letterboxInBreaks = false;
  widescreenStoryboard = false;
  bookmarks: number[] = [];
  /** [Editor] BeatDivisor (BeatmapInfo.BeatDivisor), clamped to 1..16. */
  beatDivisor = 4;
  /** [Editor] DistanceSpacing / GridSize / TimelineZoom / VelocityPresets */
  distanceSpacing = 1;
  gridSize = 32;
  timelineZoom = 1;
  sliderVelocityPresets: number[] = [];
  /** [Events] lines other than the background and breaks (video, storyboard elements and commands), kept for re-encoding. */
  storyboardLines: string[] = [];

  get firstObjectTime(): number {
    return this.hitObjects.length > 0 ? this.hitObjects[0].startTime : 0;
  }

  get lastObjectTime(): number {
    let t = 0;
    for (const h of this.hitObjects) t = Math.max(t, h.endTime);
    return t;
  }

  /** Total drain length in ms (excluding breaks), matching BeatmapExtensions.CalculateDrainLength. */
  get drainLength(): number {
    if (this.hitObjects.length === 0) return 0;
    const breakTime = this.breaks.reduce((acc, b) => acc + (b.endTime - b.startTime), 0);
    return this.lastObjectTime - this.firstObjectTime - breakTime;
  }
}
