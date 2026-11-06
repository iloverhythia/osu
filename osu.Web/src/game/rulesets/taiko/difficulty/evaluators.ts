// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game.Rulesets.Taiko/Difficulty/Evaluators/{Colour,Reading,Rhythm,Stamina}Evaluator.cs

import { Hit } from '../objects';
import { AlternatingMonoPattern, MonoStreak, RepeatingHitPatterns, SameRhythmHitObjectGrouping, TaikoDifficultyHitObject } from './preprocessing';
import { bellCurve, isNormal, logistic, logisticExp, reverseLerp, smootherstep } from './utils';

// ------------------------------------------------------------------ colour

/** ColourEvaluator.consistentRatioPenalty */
function consistentRatioPenalty(hitObject: TaikoDifficultyHitObject, threshold = 0.01, maxObjectsToCheck = 64): number {
  let consistentRatioCount = 0;
  let totalRatioCount = 0.0;
  const recentRatios: number[] = [];
  let current = hitObject;
  const previousHitObject = current.previous(1);

  for (let i = 0; i < maxObjectsToCheck; i++) {
    // Break if there is no valid previous object
    if (current.index <= 1) break;

    const currentRatio = current.rhythmData.ratio;
    const previousRatio = previousHitObject!.rhythmData.ratio;
    recentRatios.push(currentRatio);

    // A consistent interval is defined as the percentage difference between the two rhythmic ratios with the margin of error.
    if (Math.abs(1 - currentRatio / previousRatio) <= threshold) {
      consistentRatioCount++;
      totalRatioCount += currentRatio;
      break;
    }
    current = previousHitObject!;
  }

  if (consistentRatioCount > 0) return 1 - (totalRatioCount / (consistentRatioCount + 1)) * 0.8;
  if (recentRatios.length <= 1) return 1.0;

  // As a fallback, calculate the maximum deviation from the average of the recent ratios to ensure slightly off-snapped objects don't bypass the penalty.
  let avg = 0;
  for (const r of recentRatios) avg += r;
  avg /= recentRatios.length;
  let maxRatioDeviation = -Infinity;
  for (const r of recentRatios) maxRatioDeviation = Math.max(maxRatioDeviation, Math.abs(r - avg));

  return 0.7 + 0.3 * smootherstep(maxRatioDeviation, 0.0, 1.0);
}

const evaluateRepeatingHitPatternsDifficulty = (p: RepeatingHitPatterns): number => 2 * (1 - logisticExp(Math.E * p.repetitionInterval - 2 * Math.E));
const evaluateAlternatingMonoPatternDifficulty = (p: AlternatingMonoPattern): number => logisticExp(Math.E * p.index - 2 * Math.E) * evaluateRepeatingHitPatternsDifficulty(p.parent);
const evaluateMonoStreakDifficulty = (m: MonoStreak): number => logisticExp(Math.E * m.index - 2 * Math.E) * evaluateAlternatingMonoPatternDifficulty(m.parent) * 0.5;

/** ColourEvaluator.EvaluateDifficultyOf: the difficulty of the first hitobject within a colour streak. */
export function evaluateColourDifficultyOf(taikoObject: TaikoDifficultyHitObject): number {
  const colourData = taikoObject.colourData;
  let difficulty = 0.0;

  if (colourData.monoStreak?.firstHitObject === taikoObject) difficulty += evaluateMonoStreakDifficulty(colourData.monoStreak);
  if (colourData.alternatingMonoPattern?.firstHitObject === taikoObject) difficulty += evaluateAlternatingMonoPatternDifficulty(colourData.alternatingMonoPattern);
  if (colourData.repeatingHitPattern?.firstHitObject === taikoObject) difficulty += evaluateRepeatingHitPatternsDifficulty(colourData.repeatingHitPattern);

  difficulty *= consistentRatioPenalty(taikoObject);
  return difficulty;
}

// ------------------------------------------------------------------ reading

/** ReadingEvaluator.EvaluateDifficultyOf: the influence of higher slider velocities on hitobject difficulty. */
export function evaluateReadingDifficultyOf(noteObject: TaikoDifficultyHitObject): number {
  const highMin = 480;
  const highMax = 640;
  const midMin = 360;
  const midMax = 480;
  const highCenter = (highMax + highMin) / 2;
  const highRange = highMax - highMin;
  const midCenter = (midMax + midMin) / 2;
  const midRange = midMax - midMin;

  // Apply a cap to prevent outlier values on maps that exceed the editor's parameters.
  const effectiveBPM = Math.max(1.0, noteObject.effectiveBPM);

  const midVelocityDifficulty = 0.5 * logistic(effectiveBPM, midCenter, 1.0 / (midRange / 10));

  // Expected DeltaTime is the DeltaTime this note would need to be spaced equally to a base slider velocity 1/4 note.
  const expectedDeltaTime = 21000.0 / effectiveBPM;
  const objectDensity = expectedDeltaTime / Math.max(1.0, noteObject.deltaTime);

  // High density is penalised at high velocity as it is generally considered easier to read.
  const densityPenalty = logistic(objectDensity, 0.925, 15);

  const highVelocityDifficulty = (1.0 - 0.33 * densityPenalty) * logistic(effectiveBPM, highCenter + 8 * densityPenalty, (1.0 + 0.5 * densityPenalty) / (highRange / 10));

  return midVelocityDifficulty + highVelocityDifficulty;
}

// ------------------------------------------------------------------ rhythm

/** RhythmEvaluator.termPenalty */
const termPenalty = (ratio: number, denominator: number, power: number, multiplier: number): number => -multiplier * Math.pow(Math.cos(denominator * Math.PI * ratio), power);

/** RhythmEvaluator.ratioDifficulty */
function ratioDifficulty(ratio: number, terms = 8): number {
  let difficulty = 0;
  // Validate the ratio by ensuring it is a normal number in cases where maps breach regular mapping conditions.
  ratio = isNormal(ratio) ? ratio : 0;
  for (let i = 1; i <= terms; ++i) difficulty += termPenalty(ratio, i, 4, 1);
  difficulty += terms / (1 + ratio);
  // Give bonus to near-1 ratios
  difficulty += bellCurve(ratio, 1, 0.5);
  // Penalize ratios that are VERY near 1
  difficulty -= bellCurve(ratio, 1, 0.3);
  difficulty = Math.max(difficulty, 0);
  difficulty /= Math.sqrt(8);
  return difficulty;
}

/** RhythmEvaluator.repeatedIntervalPenalty */
function repeatedIntervalPenalty(group: SameRhythmHitObjectGrouping, hitWindow: number, threshold = 0.1): number {
  const sameInterval = (startObject: SameRhythmHitObjectGrouping, intervalCount: number): number => {
    const intervals: number[] = [];
    let currentObject: SameRhythmHitObjectGrouping | null = startObject;
    for (let i = 0; i < intervalCount && currentObject !== null; i++) {
      if (currentObject.hitObjectInterval !== null) intervals.push(currentObject.hitObjectInterval);
      currentObject = currentObject.previous;
    }
    if (intervals.length < intervalCount) return 1.0; // No penalty if there aren't enough valid intervals.
    for (let i = 0; i < intervals.length; i++) {
      for (let j = i + 1; j < intervals.length; j++) {
        const ratio = intervals[i] / intervals[j];
        if (Math.abs(1 - ratio) <= threshold) return 0.8; // If any two intervals are similar, apply a penalty.
      }
    }
    return 1.0;
  };

  const longIntervalPenalty = sameInterval(group, 3);
  const shortIntervalPenalty = group.hitObjects.length < 6 ? sameInterval(group, 4) : 1.0;
  // The duration penalty is based on hit object duration relative to hitWindow.
  const durationPenalty = Math.max(1 - (group.duration * 2) / hitWindow, 0.5);
  return Math.min(longIntervalPenalty, shortIntervalPenalty) * durationPenalty;
}

/** RhythmEvaluator.evaluateDifficultyOf(SameRhythmHitObjectGrouping, hitWindow) */
function evaluateGroupDifficulty(group: SameRhythmHitObjectGrouping, hitWindow: number): number {
  let intervalDifficulty = ratioDifficulty(group.hitObjectIntervalRatio);
  const previousInterval = group.previous?.hitObjectInterval ?? null;

  intervalDifficulty *= repeatedIntervalPenalty(group, hitWindow);

  // If a previous interval exists and there are multiple hit objects in the sequence:
  if (previousInterval !== null && group.hitObjects.length > 1) {
    const expectedDurationFromPrevious = previousInterval * group.hitObjects.length;
    const durationDifference = group.duration - expectedDurationFromPrevious;
    if (durationDifference > 0) intervalDifficulty *= logistic(durationDifference / hitWindow, 0.35, 2, 1);
  }

  // Penalise patterns that can be hit within a single hit window.
  intervalDifficulty *= logistic(group.duration / hitWindow, 0.3, 2, 1);

  return Math.pow(intervalDifficulty, 0.75);
}

/** RhythmEvaluator.longGapPenalty */
function longGapPenalty(previous: SameRhythmHitObjectGrouping | null): number {
  if (previous === null) return 1.0;
  const gapInterval = previous.firstHitObject.deltaTime;
  const rhythmInterval = previous.hitObjectInterval ?? gapInterval;
  const rhythmLength = previous.hitObjects.length;
  // The ratio of the gap before this rhythm to the rhythm itself.
  const gapRatio = gapInterval / Math.max(rhythmInterval, 1);
  // The gap ratio normalised to represent if the gap is long.
  const gapFactor = logistic(gapRatio, 1.75, 20);
  // The length in objects of this rhythm normalised to represent if the rhythm change is frequent enough to be penalised.
  const lengthFactor = reverseLerp(rhythmLength, 8, 2);
  return 1.0 - 0.75 * gapFactor * lengthFactor;
}

/** RhythmEvaluator.EvaluateDifficultyOf: the difficulty of a hitobject considering its interval change. */
export function evaluateRhythmDifficultyOf(hitObject: TaikoDifficultyHitObject): number {
  if (!(hitObject.baseObject instanceof Hit)) return 0;
  const rhythmData = hitObject.rhythmData;
  let difficulty = 0.0;
  let sameRhythm = 0;
  let samePattern = 0;
  let intervalPenalty = 0;
  let gapPenalty = 0;
  const hitWindow = hitObject.hitWindowGreat;

  const sameRhythmGroup = rhythmData.sameRhythmGroupedHitObjects;
  if (sameRhythmGroup?.firstHitObject === hitObject) {
    sameRhythm += 10.0 * evaluateGroupDifficulty(sameRhythmGroup, hitWindow);
    intervalPenalty = repeatedIntervalPenalty(sameRhythmGroup, hitWindow);
    gapPenalty = longGapPenalty(sameRhythmGroup.previous);
  }

  const patternGroup = rhythmData.samePatternsGroupedHitObjects;
  if (patternGroup?.firstHitObject === hitObject) samePattern += 1.15 * ratioDifficulty(patternGroup.intervalRatio);

  difficulty += Math.max(sameRhythm, samePattern) * intervalPenalty * gapPenalty;
  return difficulty;
}

// ------------------------------------------------------------------ stamina

/** StaminaEvaluator.speedBonus */
function speedBonus(interval: number): number {
  // Interval is capped at a very small value to prevent infinite values.
  interval = Math.max(interval, 1);
  return 20 / interval;
}

/** StaminaEvaluator.availableFingersFor */
function availableFingersFor(hitObject: TaikoDifficultyHitObject): number {
  const previousColourChange = hitObject.colourData.previousColourChange;
  const nextColourChange = hitObject.colourData.nextColourChange;
  if (previousColourChange !== null && hitObject.startTime - previousColourChange.startTime < 300) return 2;
  if (nextColourChange !== null && nextColourChange.startTime - hitObject.startTime < 300) return 2;
  return 8;
}

/** StaminaEvaluator.EvaluateDifficultyOf: the minimum mechanical stamina required to play the current object. */
export function evaluateStaminaDifficultyOf(current: TaikoDifficultyHitObject): number {
  if (!(current.baseObject instanceof Hit)) return 0.0;

  // Find the previous hit object hit by the current finger, which is n notes prior, n being the number of available fingers.
  const taikoPrevious = current.previous(1);
  const previousMono = current.previousMono(availableFingersFor(current) - 1);

  let objectStrain = 0.5; // Add a base strain to all objects
  if (taikoPrevious === null) return objectStrain;
  if (previousMono !== null) objectStrain += speedBonus(current.startTime - previousMono.startTime) + 0.5 * speedBonus(current.startTime - taikoPrevious.startTime);
  return objectStrain;
}
