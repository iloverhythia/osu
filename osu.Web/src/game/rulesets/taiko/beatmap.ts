// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Taiko playable beatmap: WorkingBeatmap.GetPlayableBeatmap applied to TaikoBeatmapConverter,
// with TaikoModEasy / TaikoModHardRock / TaikoModRandom (osu.Game.Rulesets.Taiko/Mods).

import type { Beatmap, BreakPeriod } from '../../beatmaps/Beatmap';
import type { ControlPointInfo } from '../../beatmaps/ControlPoints';
import { BeatmapDifficulty } from '../../beatmaps/Difficulty';
import { generateBarLines } from '../../objects/BarLineGenerator';
import type { ModSet } from '../../mods/Mods';
import type { JudgementResult } from '../../scoring/Judgement';
import type { PlayableBeatmap, Ruleset } from '../Ruleset';
import { DotNetRandom } from './DotNetRandom';
import { Hit, HitType, TaikoBarLine, TaikoHitObject, forEachJudgedInSimulationOrder } from './objects';
import { TaikoBeatmapConverter } from './TaikoBeatmapConverter';

/** ModEasy.ADJUST_RATIO / ModHardRock.ADJUST_RATIO (C# floats). */
const EZ_RATIO = Math.fround(0.5);
const HR_RATIO = Math.fround(1.4);
/** TaikoModEasy.slider_multiplier */
const EZ_SLIDER_MULTIPLIER = 0.8;
/** TaikoModHardRock.slider_multiplier: base part (1.4) and the aspect ratio adjustment (4/3). */
const HR_SLIDER_MULTIPLIER = (1.4 * 4) / 3;

const f = Math.fround;

/** IApplicableToDifficulty for the taiko mods (TaikoModEasy / TaikoModHardRock). Float fields are kept in single precision like C#. */
export function applyTaikoDifficultyMods(d: BeatmapDifficulty, mods: ModSet): BeatmapDifficulty {
  const out = d.clone();
  out.drainRate = f(out.drainRate);
  out.overallDifficulty = f(out.overallDifficulty);
  out.circleSize = f(out.circleSize);
  out.approachRate = f(out.approachRate);
  if (mods.has('EZ')) {
    // ModEasy
    out.circleSize = f(out.circleSize * EZ_RATIO);
    out.approachRate = f(out.approachRate * EZ_RATIO);
    out.drainRate = f(out.drainRate * EZ_RATIO);
    // TaikoModEasy
    out.overallDifficulty = f(out.overallDifficulty * EZ_RATIO);
    out.sliderMultiplier *= EZ_SLIDER_MULTIPLIER;
  }
  if (mods.has('HR')) {
    // ModHardRock
    out.drainRate = Math.min(f(out.drainRate * HR_RATIO), 10);
    // TaikoModHardRock
    out.overallDifficulty = Math.min(f(out.overallDifficulty * HR_RATIO), 10);
    out.sliderMultiplier *= HR_SLIDER_MULTIPLIER;
  }
  return out;
}

export class TaikoPlayableBeatmap implements PlayableBeatmap<TaikoHitObject> {
  readonly breaks: BreakPeriod[];
  readonly objectTimes: { start: number; end: number }[];
  readonly barLines: TaikoBarLine[];
  /** Seed used by the Random mod (null when not active). */
  readonly randomSeed: number | null;

  constructor(
    readonly source: Beatmap,
    readonly ruleset: Ruleset,
    readonly mods: ModSet,
    readonly difficulty: BeatmapDifficulty,
    readonly controlPoints: ControlPointInfo,
    readonly hitObjects: TaikoHitObject[],
    randomSeed: number | null,
  ) {
    this.breaks = source.breaks;
    this.objectTimes = hitObjects.map(h => ({ start: h.startTime, end: h.endTime }));
    this.randomSeed = randomSeed;
    this.barLines = hitObjects.length > 0 ? generateBarLines(controlPoints, hitObjects[0].startTime, this.lastObjectTime) : [];
  }

  /** Beatmap.GetLastObjectTime */
  get lastObjectTime(): number {
    let t = 0;
    for (const h of this.hitObjects) t = Math.max(t, h.endTime);
    return t;
  }

  /** Whether the source beatmap was an osu!standard map (convert). */
  get isConvert(): boolean {
    return this.source.rulesetId === 0;
  }

  perfectResults(): JudgementResult[] {
    const out: JudgementResult[] = [];
    for (const h of this.hitObjects) {
      forEachJudgedInSimulationOrder(h, o => {
        out.push({
          hitObject: o,
          judgement: o.judgement,
          type: o.judgement.maxResult,
          timeOffset: 0,
          objectEndTime: o.endTime,
          tag: o.kind,
        });
      });
    }
    return out;
  }
}

export interface TaikoPlayableOptions {
  /** Seed for the Random mod. A random seed is chosen when omitted (TaikoModRandom: `Seed.Value ??= RNG.Next()`). */
  randomSeed?: number;
}

export function createTaikoPlayable(beatmap: Beatmap, ruleset: Ruleset, mods: ModSet, options: TaikoPlayableOptions = {}): TaikoPlayableBeatmap {
  const converter = new TaikoBeatmapConverter(beatmap);
  const { hitObjects, controlPoints } = converter.convert();

  // Apply difficulty mods
  const difficulty = applyTaikoDifficultyMods(beatmap.difficulty, mods);

  // Compute default values for hitobjects, including creating nested hitobjects
  for (const h of hitObjects) h.applyDefaults(controlPoints, difficulty);

  // IApplicableToBeatmap: TaikoModRandom
  let seed: number | null = null;
  if (mods.has('RD')) {
    seed = options.randomSeed ?? Math.floor(Math.random() * 2147483647);
    const rng = new DotNetRandom(seed);
    for (const h of hitObjects) if (h instanceof Hit) h.type = rng.nextMax(2) === 0 ? HitType.Centre : HitType.Rim;
  }

  return new TaikoPlayableBeatmap(beatmap, ruleset, mods, difficulty, controlPoints, hitObjects, seed);
}
