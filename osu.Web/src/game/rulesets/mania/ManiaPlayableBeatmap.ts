// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of the mania-relevant parts of WorkingBeatmap.GetPlayableBeatmap (conversion, mod application, defaults),
// ManiaBeatmap (stages) and JudgementProcessor.SimulateAutoplay ordering (ManiaScoreProcessor.EnumerateHitObjects).

import type { Beatmap, BreakPeriod } from '../../beatmaps/Beatmap';
import type { BeatmapDifficulty } from '../../beatmaps/Difficulty';
import type { ModSet } from '../../mods/Mods';
import type { JudgementResult } from '../../scoring/Judgement';
import type { PlayableBeatmap, Ruleset } from '../Ruleset';
import { conversionDifficultyFromBeatmap, ManiaBeatmapConverter } from './beatmaps/ManiaBeatmapConverter';
import { variantName } from './input/ManiaInput';
import { applyManiaDifficultyMods, applyManiaHitObjectMods, applyMirror, applyRandom, keyModCount } from './mods/ManiaMods';
import { HeadNote, HoldNote, HoldNoteBody, TailNote, type ManiaHitObject } from './objects/ManiaHitObject';
import { compareJudgementOrder } from './scoring/ManiaScoreProcessor';

export type ManiaJudgementTag = 'note' | 'head' | 'tail' | 'body' | 'hold';

export function tagFor(h: ManiaHitObject): ManiaJudgementTag {
  if (h instanceof HeadNote) return 'head';
  if (h instanceof TailNote) return 'tail';
  if (h instanceof HoldNoteBody) return 'body';
  if (h instanceof HoldNote) return 'hold';
  return 'note';
}

export class ManiaPlayableBeatmap implements PlayableBeatmap<ManiaHitObject> {
  readonly objectTimes: { start: number; end: number }[];
  readonly variant: string;

  constructor(
    readonly source: Beatmap,
    readonly ruleset: Ruleset,
    readonly difficulty: BeatmapDifficulty,
    readonly mods: ModSet,
    readonly hitObjects: ManiaHitObject[],
    readonly breaks: BreakPeriod[],
    /** Column count of each stage. */
    readonly stages: number[],
    /** Whether the beatmap was converted from another ruleset. */
    readonly isConvert: boolean,
  ) {
    this.objectTimes = hitObjects.map(h => ({ start: h.startTime, end: h.endTime }));
    this.variant = variantName(stages);
  }

  get totalColumns(): number {
    return this.stages.reduce((a, b) => a + b, 0);
  }

  /** ManiaBeatmap.GetStageForColumnIndex -> special column check (StageDefinition.IsSpecialColumn). */
  isSpecialColumn(column: number): boolean {
    for (const columns of this.stages) {
      if (column < columns) return columns % 2 === 1 && column === Math.trunc(columns / 2);
      column -= columns;
    }
    return false;
  }

  /** Every hit object including nested ones, in ManiaScoreProcessor judgement order. */
  allObjectsInJudgementOrder(): ManiaHitObject[] {
    const all: ManiaHitObject[] = [];
    for (const h of this.hitObjects) {
      // enumerateRecursively: nested first, then the object itself.
      if (h instanceof HoldNote) all.push(...h.nested);
      all.push(h);
    }
    // Enumerable.Order is a stable sort.
    return all.sort(compareJudgementOrder);
  }

  perfectResults(): JudgementResult[] {
    return this.allObjectsInJudgementOrder().map(h => ({
      hitObject: h,
      judgement: h.judgement,
      type: h.judgement.maxResult,
      timeOffset: 0,
      objectEndTime: h.endTime,
      tag: tagFor(h),
    }));
  }
}

export interface CreatePlayableOptions {
  /** Seed for the Random mod (random when omitted). */
  randomSeed?: number;
}

export function createManiaPlayable(beatmap: Beatmap, mods: ModSet, ruleset: Ruleset, options: CreatePlayableOptions = {}): ManiaPlayableBeatmap {
  if (!ManiaBeatmapConverter.canConvert(beatmap)) throw new Error('This beatmap cannot be converted to osu!mania.');

  // Converter (+ IApplicableToBeatmapConverter key mods).
  const converter = new ManiaBeatmapConverter(conversionDifficultyFromBeatmap(beatmap));
  const keys = keyModCount(mods);
  if (keys != null) converter.applyKeyMod(keys);

  const hitObjects = converter.convert(beatmap);
  const stages = converter.stages;
  const totalColumns = converter.totalColumns;

  // IApplicableToDifficulty
  const difficulty = applyManiaDifficultyMods(beatmap.difficulty, mods);

  // HitObject.ApplyDefaults (hit windows + nested objects)
  for (const h of hitObjects) h.applyDefaults(difficulty.overallDifficulty);

  // IApplicableToHitObject
  applyManiaHitObjectMods(hitObjects, mods);

  // IApplicableToBeatmap
  if (mods.has('MR')) applyMirror(hitObjects, totalColumns);
  if (mods.has('RD')) applyRandom(hitObjects, totalColumns, options.randomSeed ?? Math.floor(Math.random() * 2147483647));

  return new ManiaPlayableBeatmap(beatmap, ruleset, difficulty, mods, hitObjects, beatmap.breaks, stages, !converter.isForCurrentRuleset);
}
