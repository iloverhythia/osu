// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game.Rulesets.Osu/Difficulty/OsuPerformanceCalculator.cs
//
// Our ModSet has no Classic (CL) / ScoreV2 / Blinds / Traceable mods, so the lazer (non-classic slider accuracy) code paths
// are used and the legacy-score miss estimation (OsuLegacyScoreMissCalculator) is not needed.

import type { ModSet } from '../../../mods/Mods';
import {
  aimDifficultyToPerformance,
  OsuDifficultyAttributes,
  PERFORMANCE_BASE_MULTIPLIER,
  PERFORMANCE_NORM_EXPONENT,
  sumCognitionDifficulty,
} from './calculator';
import { Flashlight } from './osuSkills';
import { greatHitWindow } from './preprocessing';
import { HarmonicSkill } from './skills';
import { difficultyRange } from '../../../beatmaps/Difficulty';
import { doubleLerp, erf, erfInv, norm, pow, pow2, pow3, pow5, reverseLerp, SQRT2 } from './utils';

export interface OsuScoreForPerformance {
  count300: number;
  count100: number;
  count50: number;
  countMiss: number;
  maxCombo: number;
  /** Number of slider tails hit (HitResult.SliderTailHit). Defaults to all slider tails hit. */
  sliderTailHits?: number;
  /** Number of missed slider ticks / repeats (HitResult.LargeTickMiss). Defaults to 0. */
  largeTickMisses?: number;
  /** Accuracy in [0, 1]. */
  accuracy: number;
}

export interface OsuPerformanceAttributes {
  aim: number;
  speed: number;
  accuracy: number;
  flashlight: number;
  reading: number;
  effectiveMissCount: number;
  comboBasedEstimatedMissCount: number;
  speedDeviation: number | null;
  total: number;
}

/** Calculates total pp (and its breakdown) for a score, given difficulty attributes calculated with the same mods. */
export function calculateOsuPerformance(attributes: OsuDifficultyAttributes, score: OsuScoreForPerformance, mods: ModSet): number {
  return calculateOsuPerformanceAttributes(attributes, score, mods).total;
}

export function calculateOsuPerformanceAttributes(attributes: OsuDifficultyAttributes, score: OsuScoreForPerformance, mods: ModSet): OsuPerformanceAttributes {
  const accuracy = Math.min(Math.max(score.accuracy, 0), 1);
  const scoreMaxCombo = Math.min(Math.max(score.maxCombo, 0), attributes.maxCombo);
  const countGreat = score.count300;
  const countOk = score.count100;
  const countMeh = score.count50;
  const countMiss = score.countMiss;
  const countSliderEndsDropped = attributes.sliderCount - (score.sliderTailHits ?? attributes.sliderCount);
  const countSliderTickMiss = score.largeTickMisses ?? 0;

  const totalHits = countGreat + countOk + countMeh + countMiss;
  const totalSuccessfulHits = countGreat + countOk + countMeh;
  const totalImperfectHits = countOk + countMeh + countMiss;

  const clockRate = mods.rate;

  const rawGreat = greatHitWindow(attributes.beatmapOverallDifficulty);
  const rawOk = Math.floor(difficultyRange(attributes.beatmapOverallDifficulty, 140, 100, 60)) - 0.5;
  const rawMeh = Math.floor(difficultyRange(attributes.beatmapOverallDifficulty, 200, 150, 100)) - 0.5;
  const greatHitWindowMs = rawGreat / clockRate;
  const okHitWindow = rawOk / clockRate;
  const mehHitWindow = rawMeh / clockRate;

  // (The rate adjusted approach rate is only used by Traceable / Blinds, which this port doesn't have.)
  const overallDifficulty = (79.5 - greatHitWindowMs) / 6;

  // ---- combo based miss count (non-classic) ----
  let comboBasedEstimatedMissCount: number = countMiss;
  if (attributes.sliderCount > 0) {
    let missCount: number = countMiss;
    const fullComboThreshold = attributes.maxCombo - countSliderEndsDropped;
    if (scoreMaxCombo < fullComboThreshold) missCount = fullComboThreshold / Math.max(1.0, scoreMaxCombo);
    // Combine regular misses with tick misses since tick misses break combo as well
    missCount = Math.min(missCount, countSliderTickMiss + countMiss);
    comboBasedEstimatedMissCount = missCount;
  }

  let effectiveMissCount = comboBasedEstimatedMissCount;
  effectiveMissCount = Math.max(countMiss, effectiveMissCount);
  effectiveMissCount = Math.min(totalHits, effectiveMissCount);
  effectiveMissCount = Math.max(0, effectiveMissCount);

  // calculateEstimatedSliderBreaks returns 0 for non-classic scores.
  const aimEstimatedSliderBreaks = 0;
  const speedEstimatedSliderBreaks = 0;

  let multiplier = PERFORMANCE_BASE_MULTIPLIER;

  if (mods.has('NF')) multiplier *= Math.max(0.9, 1.0 - 0.02 * effectiveMissCount);

  if (mods.has('SO') && totalHits > 0) multiplier *= 1.0 - pow(attributes.spinnerCount / totalHits, 0.85);

  if (mods.has('RX')) {
    // we use OD13.3 as maximum since it's the value at which great hitwidow becomes 0
    const okMultiplier = 0.75 * Math.max(0.0, overallDifficulty > 0.0 ? 1 - overallDifficulty / 13.33 : 1.0);
    const mehMultiplier = Math.max(0.0, overallDifficulty > 0.0 ? 1 - pow5(overallDifficulty / 13.33) : 1.0);
    effectiveMissCount = Math.min(effectiveMissCount + countOk * okMultiplier + countMeh * mehMultiplier, totalHits);
  }

  const calculateMissPenalty = (missCount: number, difficultStrainCount: number): number =>
    0.93 / (missCount / (4 * Math.log(Math.max(1, difficultStrainCount))) + 1);

  // ---- speed deviation ----
  const calculateDeviation = (relevantCountGreat: number, relevantCountOk: number, relevantCountMeh: number): number | null => {
    if (relevantCountGreat + relevantCountOk + relevantCountMeh <= 0) return null;

    // The sample proportion of successful hits.
    const n = Math.max(1, relevantCountGreat + relevantCountOk);
    const p = relevantCountGreat / n;

    // 99% critical value for the normal distribution (one-tailed).
    const z = 2.32634787404;

    // We can be 99% confident that the population proportion is at least this value.
    const pLowerBound = Math.min(p, (n * p + (z * z) / 2) / (n + z * z) - (z / (n + z * z)) * Math.sqrt(n * p * (1 - p) + (z * z) / 4));

    let deviation: number;

    if (pLowerBound > 0.01) {
      // Compute deviation assuming greats and oks are normally distributed.
      deviation = greatHitWindowMs / (SQRT2 * erfInv(pLowerBound));

      // Subtract the deviation provided by tails that land outside the ok hit window from the deviation computed above.
      const okHitWindowTailAmount =
        (Math.sqrt(2 / Math.PI) * okHitWindow * Math.exp(-0.5 * pow2(okHitWindow / deviation))) / (deviation * erf(okHitWindow / (SQRT2 * deviation)));

      deviation *= Math.sqrt(1 - okHitWindowTailAmount);
    } else {
      // A tested limit value for the case of a score only containing oks.
      deviation = okHitWindow / Math.sqrt(3);
    }

    // Compute and add the variance for mehs, assuming that they are uniformly distributed.
    const mehVariance = (mehHitWindow * mehHitWindow + okHitWindow * mehHitWindow + okHitWindow * okHitWindow) / 3;

    return Math.sqrt(
      ((relevantCountGreat + relevantCountOk) * pow2(deviation) + relevantCountMeh * mehVariance) / (relevantCountGreat + relevantCountOk + relevantCountMeh),
    );
  };

  let speedDeviation: number | null = null;
  if (totalSuccessfulHits !== 0) {
    // Calculate accuracy assuming the worst case scenario
    let speedNoteCount = attributes.speedNoteCount;
    speedNoteCount += (totalHits - attributes.speedNoteCount) * 0.1;

    // Assume worst case: all mistakes were on speed notes
    const relevantCountMiss = Math.min(countMiss, speedNoteCount);
    const relevantCountMeh = Math.min(countMeh, speedNoteCount - relevantCountMiss);
    const relevantCountOk = Math.min(countOk, speedNoteCount - relevantCountMiss - relevantCountMeh);
    const relevantCountGreat = Math.max(0, speedNoteCount - relevantCountMiss - relevantCountMeh - relevantCountOk);

    speedDeviation = calculateDeviation(relevantCountGreat, relevantCountOk, relevantCountMeh);
  }

  // ---- aim ----
  const computeAimValue = (): number => {
    if (mods.has('AP')) return 0.0;

    let aimDifficulty = attributes.aimDifficulty;

    if (attributes.sliderCount > 0 && attributes.aimDifficultSliderCount > 0) {
      // We add tick misses here since they too mean that the player didn't follow the slider properly
      const estimateImproperlyFollowedDifficultSliders = Math.min(Math.max(countSliderEndsDropped + countSliderTickMiss, 0), attributes.aimDifficultSliderCount);

      const sliderNerfFactor =
        (1 - attributes.sliderFactor) * pow3(1 - estimateImproperlyFollowedDifficultSliders / attributes.aimDifficultSliderCount) + attributes.sliderFactor;
      aimDifficulty *= sliderNerfFactor;
    }

    let aimValue = aimDifficultyToPerformance(aimDifficulty);

    const lengthBonus = 0.95 + 0.35 * Math.min(1.0, totalHits / 2000.0) + (totalHits > 2000 ? Math.log10(totalHits / 2000.0) * 0.5 : 0.0);
    aimValue *= lengthBonus;

    if (effectiveMissCount > 0) {
      const relevantMissCount = Math.min(effectiveMissCount + aimEstimatedSliderBreaks, totalImperfectHits + countSliderTickMiss);
      aimValue *= calculateMissPenalty(relevantMissCount, attributes.aimDifficultStrainCount);
    }

    aimValue *= accuracy;
    return aimValue;
  };

  // ---- speed ----
  const calculateSpeedHighDeviationNerf = (): number => {
    if (speedDeviation == null) return 0;

    const speedValue = HarmonicSkill.difficultyToPerformance(attributes.speedDifficulty);

    // Any PP above this point is considered "excess" speed difficulty.
    const excessSpeedDifficultyCutoff = 100 + 220 * pow(22 / speedDeviation, 6.5);

    if (speedValue <= excessSpeedDifficultyCutoff) return 1.0;

    const scale = 50;
    let adjustedSpeedValue = scale * (Math.log((speedValue - excessSpeedDifficultyCutoff) / scale + 1) + excessSpeedDifficultyCutoff / scale);

    // 220 UR and less are considered tapped correctly to ensure that normal scores will be punished as little as possible
    const t = 1 - reverseLerp(speedDeviation, 22.0, 27.0);
    adjustedSpeedValue = doubleLerp(adjustedSpeedValue, speedValue, t);

    return adjustedSpeedValue / speedValue;
  };

  const computeSpeedValue = (): number => {
    if (mods.has('RX') || speedDeviation == null) return 0.0;

    let speedValue = HarmonicSkill.difficultyToPerformance(attributes.speedDifficulty);

    if (effectiveMissCount > 0) {
      const relevantMissCount = Math.min(effectiveMissCount + speedEstimatedSliderBreaks, totalImperfectHits + countSliderTickMiss);
      speedValue *= calculateMissPenalty(relevantMissCount, attributes.speedDifficultStrainCount);
    }

    speedValue *= calculateSpeedHighDeviationNerf();

    // An effective hit window is created based on the speed SR. The higher the speed difficulty, the shorter the hit window.
    const effectiveHitWindow = 20 * pow(4 / attributes.speedDifficulty, 0.35);

    // Find the proportion of 300s on speed notes assuming the hit window was the effective hit window.
    const effectiveAccuracy = erf(effectiveHitWindow / speedDeviation);

    // Scale speed value by normalized accuracy.
    speedValue *= pow2(effectiveAccuracy);

    return speedValue;
  };

  // ---- accuracy ----
  const computeAccuracyValue = (): number => {
    if (mods.has('RX')) return 0.0;

    // This percentage only considers HitCircles of any value (sliders too, as slider heads have accuracy in lazer).
    const amountHitObjectsWithAccuracy = attributes.hitCircleCount + attributes.sliderCount;

    let betterAccuracyPercentage =
      amountHitObjectsWithAccuracy > 0
        ? ((countGreat - Math.max(totalHits - amountHitObjectsWithAccuracy, 0)) * 6 + countOk * 2 + countMeh) / (amountHitObjectsWithAccuracy * 6)
        : 0;

    // It is possible to reach a negative accuracy with this formula. Cap it at zero - zero points.
    if (betterAccuracyPercentage < 0) betterAccuracyPercentage = 0;

    let accuracyValue = pow(1.52163, overallDifficulty) * pow(betterAccuracyPercentage, 24) * 2.83;

    // Bonus for many hitcircles - it's harder to keep good accuracy up for longer.
    accuracyValue *= amountHitObjectsWithAccuracy < 1000 ? pow(amountHitObjectsWithAccuracy / 1000.0, 0.3) : pow(amountHitObjectsWithAccuracy / 1000.0, 0.1);

    return accuracyValue;
  };

  // ---- flashlight ----
  const computeFlashlightValue = (): number => {
    if (!mods.has('FL') || attributes.flashlightDifficulty == null) return 0.0;

    let flashlightValue = Flashlight.difficultyToPerformance(attributes.flashlightDifficulty);

    // Penalize misses by assessing # of misses relative to the total # of objects. Default a 3% reduction for any # of misses.
    if (effectiveMissCount > 0) flashlightValue *= 0.97 * pow(1 - pow(effectiveMissCount / totalHits, 0.775), pow(effectiveMissCount, 0.875));

    // Combo scaling
    flashlightValue *= attributes.maxCombo <= 0 ? 1.0 : Math.min(pow(scoreMaxCombo, 0.8) / pow(attributes.maxCombo, 0.8), 1.0);

    // Scale the flashlight value with accuracy _slightly_.
    flashlightValue *= 0.5 + accuracy / 2.0;

    return flashlightValue;
  };

  // ---- reading ----
  const computeReadingValue = (): number => {
    let readingValue = HarmonicSkill.difficultyToPerformance(attributes.readingDifficulty);

    if (effectiveMissCount > 0) readingValue *= calculateMissPenalty(effectiveMissCount + aimEstimatedSliderBreaks, attributes.readingDifficultNoteCount);

    // Scale the reading value with accuracy _harshly_.
    readingValue *= pow3(accuracy);

    return readingValue;
  };

  const aimValue = computeAimValue();
  const speedValue = computeSpeedValue();
  const accuracyValue = computeAccuracyValue();
  const readingValue = computeReadingValue();
  const flashlightValue = computeFlashlightValue();
  const cognitionValue = sumCognitionDifficulty(readingValue, flashlightValue);

  const total = norm(PERFORMANCE_NORM_EXPONENT, aimValue, speedValue, accuracyValue, cognitionValue) * multiplier;

  return {
    aim: aimValue,
    speed: speedValue,
    accuracy: accuracyValue,
    flashlight: flashlightValue,
    reading: readingValue,
    effectiveMissCount,
    comboBasedEstimatedMissCount,
    speedDeviation,
    total,
  };
}
