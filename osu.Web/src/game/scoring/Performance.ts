// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Performance points for every ruleset:
//   - osu!: OsuPerformanceCalculator (ported in rulesets/osu/difficulty/performance.ts)
//   - osu!taiko: TaikoPerformanceCalculator.cs
//   - osu!catch: CatchPerformanceCalculator.cs (+ CatchDifficultyAttributes.MaxCombo)
//   - osu!mania: ManiaPerformanceCalculator.cs
// and the profile aggregation done by osu-web / osu-performance (weighted total pp, bonus pp).

import { difficultyRange } from '../beatmaps/Difficulty';
import type { ModSet } from '../mods/Mods';
import { CatchHitObject, Fruit, JuiceStream, TinyDroplet } from '../rulesets/catch/objects';
import { calculateCatchStarRating } from '../rulesets/catch/CatchDifficultyCalculator';
import { calculateManiaDifficulty } from '../rulesets/mania/difficulty/ManiaDifficultyCalculator';
import { calculateOsuDifficulty } from '../rulesets/osu/difficulty/calculator';
import { calculateOsuPerformance } from '../rulesets/osu/difficulty/performance';
import { erf, erfInv, logistic, reverseLerp, SQRT2 } from '../rulesets/osu/difficulty/utils';
import type { OsuPlayableBeatmap } from '../rulesets/osu/beatmap';
import type { PlayableBeatmap } from '../rulesets/Ruleset';
import { calculateTaikoDifficulty, type TaikoDifficultyAttributes } from '../rulesets/taiko/difficulty/TaikoDifficultyCalculator';
import { TaikoHitWindows } from '../rulesets/taiko/TaikoHitWindows';
import type { TaikoPlayableBeatmap } from '../rulesets/taiko/beatmap';
import { HitResult } from './HitResult';

export interface PerformanceScore {
  statistics: ReadonlyMap<HitResult, number>;
  maxCombo: number;
  accuracy: number;
  mods: ModSet;
}

const count = (s: ReadonlyMap<HitResult, number>, r: HitResult) => s.get(r) ?? 0;

// ------------------------------------------------------------------ osu!taiko

export function calculateTaikoPerformance(attributes: TaikoDifficultyAttributes, score: PerformanceScore, overallDifficulty: number, isConvert: boolean): number {
  const countGreat = count(score.statistics, HitResult.Great);
  const countOk = count(score.statistics, HitResult.Ok);
  const countMeh = count(score.statistics, HitResult.Meh);
  const countMiss = Math.max(0, count(score.statistics, HitResult.Miss));
  const totalHits = countGreat + countOk + countMeh + countMiss;
  const clockRate = score.mods.rate;
  const hitWindows = new TaikoHitWindows();
  hitWindows.setDifficulty(overallDifficulty);
  const greatHitWindow = hitWindows.windowFor(HitResult.Great) / clockRate;

  const deviationUpperBound = (accuracy: number) => {
    const z = 2.32634787404;
    const n = totalHits;
    const p = accuracy;
    const pLowerBound = (n * p + (z * z) / 2) / (n + z * z) - (z / (n + z * z)) * Math.sqrt(n * p * (1 - p) + (z * z) / 4);
    return greatHitWindow / (SQRT2 * erfInv(pLowerBound));
  };

  const estimatedUnstableRate = countGreat === 0 || greatHitWindow <= 0 ? null : deviationUpperBound(countGreat / totalHits) * 10;
  const totalDifficultHits = totalHits * attributes.consistencyFactor;
  const isClassic = score.mods.has('CL');
  const hidden = score.mods.has('HD');
  const flashlight = score.mods.has('FL');

  // computeDifficultyValue
  let difficultyValue = 0;
  let lengthBonus = 1;
  if (estimatedUnstableRate != null && totalDifficultHits !== 0) {
    const rhythmExpectedUnstableRate = deviationUpperBound(1.0) * 10;
    const rhythmMaximumUnstableRate = deviationUpperBound(0.8) * 10;
    const rhythmFactor = reverseLerp(attributes.rhythmDifficulty / attributes.starRating, 0.15, 0.4);
    const rhythmPenalty =
      1 -
      logistic(estimatedUnstableRate, (rhythmExpectedUnstableRate + rhythmMaximumUnstableRate) / 2, 10 / (rhythmMaximumUnstableRate - rhythmExpectedUnstableRate), 0.25 * Math.pow(rhythmFactor, 3));
    const baseDifficulty = 5 * Math.max(1.0, (attributes.starRating * rhythmPenalty) / 0.11) - 4.0;
    difficultyValue = Math.min(Math.pow(baseDifficulty, 3) / 69052.51, Math.pow(baseDifficulty, 2.25) / 1250.0);
    difficultyValue *= 1 + 0.1 * Math.max(0, attributes.starRating - 10);
    lengthBonus = 1 + (0.25 * totalDifficultHits) / (totalDifficultHits + 4000);
    difficultyValue *= lengthBonus;
    const missPenalty = 0.97 + (0.03 * totalDifficultHits) / (totalDifficultHits + 1500);
    difficultyValue *= Math.pow(missPenalty, countMiss);
    if (hidden) {
      let hiddenBonus = isConvert ? 0.025 : 0.1;
      if (!flashlight) {
        if (!isClassic) hiddenBonus *= 0.2;
        if (score.mods.has('EZ') && isClassic) hiddenBonus *= 0.5;
      }
      difficultyValue *= 1 + hiddenBonus;
    }
    if (flashlight) difficultyValue *= Math.max(1, 1.05 - Math.min(attributes.monoStaminaFactor / 50, 1) * lengthBonus);
    const monoAccScalingExponent = 2 + attributes.monoStaminaFactor;
    const monoAccScalingShift = 500 - 100 * (attributes.monoStaminaFactor * 3);
    difficultyValue *= Math.pow(erf(monoAccScalingShift / (SQRT2 * estimatedUnstableRate)), monoAccScalingExponent);
  }

  // computeAccuracyValue
  let accuracyValue = 0;
  if (greatHitWindow > 0 && estimatedUnstableRate != null) {
    accuracyValue = 470 * Math.pow(0.9885, estimatedUnstableRate);
    accuracyValue *= 1 + (Math.pow(50 / estimatedUnstableRate, 2) * Math.pow(attributes.starRating, 2.8)) / 600;
    if (hidden && !isConvert) accuracyValue *= 1.075;
    accuracyValue *= 1 + (0.3 * totalDifficultHits) / (totalDifficultHits + 4000);
    const memoryLengthBonus = Math.min(1.15, Math.pow(totalHits / 1500.0, 0.3));
    if (flashlight && hidden && !isConvert) accuracyValue *= Math.max(1.0, 1.05 * memoryLengthBonus);
  }

  return difficultyValue * 1.08 + accuracyValue * 1.1;
}

// ------------------------------------------------------------------ osu!catch

/** CatchDifficultyCalculator: MaxCombo = fruits + non-tiny juice stream nested objects. */
export function catchMaxCombo(hitObjects: readonly CatchHitObject[]): number {
  let n = 0;
  for (const h of hitObjects) {
    if (h instanceof Fruit) n++;
    else if (h instanceof JuiceStream) n += h.nested.filter(x => !(x instanceof TinyDroplet)).length;
  }
  return n;
}

export function calculateCatchPerformance(starRating: number, maxCombo: number, score: PerformanceScore, approachRateSetting: number): number {
  // GetCount300 = Great, GetCount100 = LargeTickHit, GetCount50 = SmallTickHit, GetCountKatu = SmallTickMiss, GetCountMiss = Miss + LargeTickMiss
  const num300 = count(score.statistics, HitResult.Great);
  const num100 = count(score.statistics, HitResult.LargeTickHit);
  const num50 = count(score.statistics, HitResult.SmallTickHit);
  const numKatu = count(score.statistics, HitResult.SmallTickMiss);
  const numMiss = Math.max(0, count(score.statistics, HitResult.Miss) + count(score.statistics, HitResult.LargeTickMiss));
  const scoreMaxCombo = Math.min(Math.max(score.maxCombo, 0), maxCombo);

  let value = Math.pow(5.0 * Math.max(1.0, starRating / 0.0049) - 4.0, 2.0) / 100000.0;
  const numTotalHits = numMiss + num100 + num300;
  const lengthBonus = 0.95 + 0.3 * Math.min(1.0, numTotalHits / 2500.0) + (numTotalHits > 2500 ? Math.log10(numTotalHits / 2500.0) * 0.475 : 0.0);
  value *= lengthBonus;
  value *= Math.pow(0.97, numMiss);
  if (maxCombo > 0) value *= Math.min(Math.pow(scoreMaxCombo, 0.35) / Math.pow(maxCombo, 0.35), 1.0);

  const clockRate = score.mods.rate;
  const preempt = difficultyRange(approachRateSetting, 1800, 1200, 450) / clockRate;
  const approachRate = preempt > 1200.0 ? -(preempt - 1800.0) / 120.0 : -(preempt - 1200.0) / 150.0 + 5.0;
  let approachRateFactor = 1.0;
  if (approachRate > 9.0) approachRateFactor += 0.1 * (approachRate - 9.0);
  if (approachRate > 10.0) approachRateFactor += 0.1 * (approachRate - 10.0);
  else if (approachRate < 8.0) approachRateFactor += 0.025 * (8.0 - approachRate);
  value *= approachRateFactor;

  if (score.mods.has('HD')) {
    if (approachRate <= 10.0) value *= 1.05 + 0.075 * (10.0 - approachRate);
    else if (approachRate > 10.0) value *= 1.01 + 0.04 * (11.0 - Math.min(11.0, approachRate));
  }
  if (score.mods.has('FL')) value *= 1.35 * lengthBonus;

  const totalHits = num50 + num100 + num300 + numMiss + numKatu;
  const accuracy = totalHits === 0 ? 0 : Math.min(1, Math.max(0, (num50 + num100 + num300) / totalHits));
  value *= Math.pow(accuracy, 5.5);
  if (score.mods.has('NF')) value *= Math.max(0.9, 1.0 - 0.02 * numMiss);
  return value;
}

// ------------------------------------------------------------------ osu!mania

export function calculateManiaPerformance(starRating: number, score: PerformanceScore): number {
  const s = score.statistics;
  const perfect = count(s, HitResult.Perfect);
  const great = count(s, HitResult.Great);
  const good = count(s, HitResult.Good);
  const ok = count(s, HitResult.Ok);
  const meh = count(s, HitResult.Meh);
  const miss = Math.max(0, count(s, HitResult.Miss));
  const totalHits = perfect + ok + great + good + meh + miss;
  const accuracy = totalHits === 0 ? 0 : Math.min(1, Math.max(0, (perfect * 320 + great * 300 + good * 200 + ok * 100 + meh * 50) / (totalHits * 320)));
  let multiplier = 1.0;
  if (score.mods.has('NF')) multiplier *= 0.75;
  if (score.mods.has('EZ')) multiplier *= 0.5;
  const difficultyValue = 8.0 * Math.pow(Math.max(starRating - 0.15, 0.05), 2.2) * Math.max(0, 5 * accuracy - 4) * (1 + 0.1 * Math.min(1, totalHits / 1500));
  return difficultyValue * multiplier;
}

// ------------------------------------------------------------------ dispatch

/** PerformanceCalculator for the score's ruleset (the playable beatmap has the score's mods applied). */
export function calculatePerformance(rulesetId: number, playable: PlayableBeatmap, score: PerformanceScore): number | undefined {
  switch (rulesetId) {
    case 0: {
      const attributes = calculateOsuDifficulty(playable as OsuPlayableBeatmap);
      const s = score.statistics;
      return calculateOsuPerformance(
        attributes,
        {
          count300: count(s, HitResult.Great),
          count100: count(s, HitResult.Ok),
          count50: count(s, HitResult.Meh),
          countMiss: count(s, HitResult.Miss),
          maxCombo: score.maxCombo,
          accuracy: score.accuracy,
          sliderTailHits: count(s, HitResult.SliderTailHit),
          largeTickMisses: count(s, HitResult.LargeTickMiss),
        } as Parameters<typeof calculateOsuPerformance>[1],
        score.mods,
      );
    }
    case 1: {
      const p = playable as TaikoPlayableBeatmap;
      return calculateTaikoPerformance(calculateTaikoDifficulty(p), score, p.difficulty.overallDifficulty, p.isConvert);
    }
    case 2: {
      const p = playable as PlayableBeatmap<CatchHitObject> & { difficulty: import('../beatmaps/Difficulty').BeatmapDifficulty };
      const objects = p.hitObjects;
      const stars = calculateCatchStarRating(objects, p.difficulty, score.mods.rate);
      return calculateCatchPerformance(stars, catchMaxCombo(objects), score, p.difficulty.approachRate);
    }
    case 3: {
      const p = playable as PlayableBeatmap & { hitObjects: Parameters<typeof calculateManiaDifficulty>[0]; totalColumns: number };
      return calculateManiaPerformance(calculateManiaDifficulty(p.hitObjects, p.totalColumns, score.mods.rate).starRating, score);
    }
  }
  return undefined;
}

// ------------------------------------------------------------------ profile aggregation (osu-performance / osu-web)

/** Weighted total: Σ pp_i × 0.95^i over the best score per beatmap, plus bonus pp for the number of ranked scores. */
export function totalPerformance(bestPpPerBeatmap: number[]): { total: number; weighted: number[]; bonus: number } {
  const sorted = [...bestPpPerBeatmap].sort((a, b) => b - a);
  const weighted = sorted.map((pp, i) => pp * Math.pow(0.95, i));
  // Bonus pp: 416.6667 × (1 − 0.995^min(n, 1000))
  const bonus = 416.6667 * (1 - Math.pow(0.995, Math.min(sorted.length, 1000)));
  return { total: weighted.reduce((a, b) => a + b, 0) + bonus, weighted, bonus };
}
