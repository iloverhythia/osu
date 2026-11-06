// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game.Rulesets.Taiko/Difficulty/TaikoDifficultyCalculator.cs (+ DifficultyCalculator.Calculate).

import type { TaikoPlayableBeatmap } from '../beatmap';
import { TaikoDifficultyHitObject, processColour, processRhythm } from './preprocessing';
import { Colour, Reading, Rhythm, Stamina } from './skills';
import { norm, orderDescending, powInt, reverseLerp } from './utils';

const DIFFICULTY_MULTIPLIER = 0.084375;
const RHYTHM_SKILL_MULTIPLIER = 0.77 * DIFFICULTY_MULTIPLIER;
const READING_SKILL_MULTIPLIER = 0.1 * DIFFICULTY_MULTIPLIER;
const COLOUR_SKILL_MULTIPLIER = 0.375 * DIFFICULTY_MULTIPLIER;
const STAMINA_SKILL_MULTIPLIER = 0.445 * DIFFICULTY_MULTIPLIER;

export interface TaikoDifficultyAttributes {
  starRating: number;
  mechanicalDifficulty: number;
  rhythmDifficulty: number;
  readingDifficulty: number;
  colourDifficulty: number;
  staminaDifficulty: number;
  monoStaminaFactor: number;
  staminaTopStrains: number;
  consistencyFactor: number;
  maxCombo: number;
}

/** TaikoDifficultyCalculator.CreateDifficultyHitObjects */
export function createTaikoDifficultyHitObjects(playable: TaikoPlayableBeatmap, clockRate: number): TaikoDifficultyHitObject[] {
  const hitObjects = playable.hitObjects;
  const difficultyHitObjects: TaikoDifficultyHitObject[] = [];
  const centreObjects: TaikoDifficultyHitObject[] = [];
  const rimObjects: TaikoDifficultyHitObject[] = [];
  const noteObjects: TaikoDifficultyHitObject[] = [];

  // Generate TaikoDifficultyHitObjects from the beatmap's hit objects.
  for (let i = 2; i < hitObjects.length; i++) {
    difficultyHitObjects.push(
      new TaikoDifficultyHitObject(
        hitObjects[i],
        hitObjects[i - 1],
        clockRate,
        difficultyHitObjects,
        centreObjects,
        rimObjects,
        noteObjects,
        difficultyHitObjects.length,
        playable.controlPoints,
        playable.difficulty.sliderMultiplier,
      ),
    );
  }

  processColour(difficultyHitObjects);
  processRhythm(noteObjects);
  return difficultyHitObjects;
}

function rescale(sr: number): number {
  if (sr < 0) return sr;
  return 10.43 * Math.log(sr / 8 + 1);
}

/** Calculates the difficulty of a (mod-applied) taiko playable beatmap. */
export function calculateTaikoDifficulty(playable: TaikoPlayableBeatmap): TaikoDifficultyAttributes {
  const mods = playable.mods;
  const isConvert = playable.isConvert;
  const isRelax = mods.has('RX');
  const clockRate = mods.rate;
  const maxCombo = playable.hitObjects.filter(h => h.kind === 'hit').length;

  const rhythm = new Rhythm();
  const reading = new Reading();
  const colour = new Colour();
  const stamina = new Stamina(false, isConvert);
  const singleColourStamina = new Stamina(true, isConvert);

  const empty: TaikoDifficultyAttributes = {
    starRating: 0,
    mechanicalDifficulty: 0,
    rhythmDifficulty: 0,
    readingDifficulty: 0,
    colourDifficulty: 0,
    staminaDifficulty: 0,
    monoStaminaFactor: 0,
    staminaTopStrains: 0,
    consistencyFactor: 0,
    maxCombo,
  };
  if (playable.hitObjects.length === 0) return empty;

  // DifficultyCalculator.SortObjects: OrderBy(BaseObject.StartTime) (stable; objects are already in time order).
  const objects = createTaikoDifficultyHitObjects(playable, clockRate)
    .map((o, i) => ({ o, i }))
    .sort((a, b) => a.o.baseObject.startTime - b.o.baseObject.startTime || a.i - b.i)
    .map(x => x.o);
  for (const h of objects) {
    rhythm.process(h);
    reading.process(h);
    colour.process(h);
    stamina.process(h);
    singleColourStamina.process(h);
  }

  const staminaDifficultyValue = stamina.difficultyValue();
  const rhythmSkill = rhythm.difficultyValue() * RHYTHM_SKILL_MULTIPLIER;
  const readingSkill = reading.difficultyValue() * READING_SKILL_MULTIPLIER;
  const colourSkill = colour.difficultyValue() * COLOUR_SKILL_MULTIPLIER;
  const staminaSkill = staminaDifficultyValue * STAMINA_SKILL_MULTIPLIER;
  const monoStaminaSkill = singleColourStamina.difficultyValue() * STAMINA_SKILL_MULTIPLIER;
  const monoStaminaFactor = staminaSkill === 0 ? 1 : powInt(monoStaminaSkill / staminaSkill, 5);

  const staminaDifficultStrains = stamina.countTopWeightedStrains(staminaDifficultyValue);

  // As we don't have pattern integration in osu!taiko, we apply the other two skills relative to rhythm.
  const patternMultiplier = Math.pow(staminaSkill * colourSkill, 0.1);
  const strainLengthBonus = 1 + 0.15 * reverseLerp(staminaDifficultStrains, 1000, 1555);

  const combinePeaks = (rhythmPeaks: readonly number[], readingPeaks: readonly number[], colourPeaks: readonly number[], staminaPeaks: readonly number[]): number[] => {
    const combined: number[] = [];
    for (let i = 0; i < colourPeaks.length; i++) {
      const rhythmPeak = rhythmPeaks[i] * RHYTHM_SKILL_MULTIPLIER * patternMultiplier;
      const readingPeak = readingPeaks[i] * READING_SKILL_MULTIPLIER;
      const colourPeak = isRelax ? 0 : colourPeaks[i] * COLOUR_SKILL_MULTIPLIER; // There is no colour difficulty in relax.
      let staminaPeak = staminaPeaks[i] * STAMINA_SKILL_MULTIPLIER * strainLengthBonus;
      staminaPeak /= isConvert || isRelax ? 1.5 : 1.0; // Available finger count is increased by 150%, thus we adjust accordingly.
      const peak = norm(2, norm(1.5, colourPeak, staminaPeak), rhythmPeak, readingPeak);
      // Sections with 0 strain are excluded to avoid worst-case time complexity of the following sort.
      if (peak > 0) combined.push(peak);
    }
    return combined;
  };

  // combinedDifficultyValue
  let combinedRating = 0;
  let consistencyFactor = 0;
  const peaks = combinePeaks(rhythm.getCurrentStrainPeaks(), reading.getCurrentStrainPeaks(), colour.getCurrentStrainPeaks(), stamina.getCurrentStrainPeaks());
  if (peaks.length > 0) {
    let difficulty = 0;
    let weight = 1;
    for (const strain of orderDescending(peaks)) {
      difficulty += strain * weight;
      weight *= 0.9;
    }
    const hitObjectStrainPeaks = combinePeaks(rhythm.getObjectDifficulties(), reading.getObjectDifficulties(), colour.getObjectDifficulties(), stamina.getObjectDifficulties());
    if (hitObjectStrainPeaks.length > 0) {
      // The average of the top 5% of strain peaks from hit objects.
      const top = orderDescending(hitObjectStrainPeaks).slice(0, 1 + Math.trunc(hitObjectStrainPeaks.length / 20));
      const topAverageHitObjectStrain = top.reduce((a, b) => a + b, 0) / top.length;
      // Calculates a consistency factor as the sum of difficulty from hit objects compared to if every object were as hard as the hardest.
      const sum = hitObjectStrainPeaks.reduce((a, b) => a + b, 0);
      consistencyFactor = sum / (topAverageHitObjectStrain * hitObjectStrainPeaks.length);
      combinedRating = difficulty;
    }
  }

  const starRating = rescale(combinedRating * 1.4);

  // Calculate proportional contribution of each skill to the combinedRating.
  const skillRating = starRating / (rhythmSkill + readingSkill + colourSkill + staminaSkill);
  const rhythmDifficulty = rhythmSkill * skillRating;
  const readingDifficulty = readingSkill * skillRating;
  const colourDifficulty = colourSkill * skillRating;
  const staminaDifficulty = staminaSkill * skillRating;

  return {
    starRating,
    mechanicalDifficulty: colourDifficulty + staminaDifficulty,
    rhythmDifficulty,
    readingDifficulty,
    colourDifficulty,
    staminaDifficulty,
    monoStaminaFactor,
    staminaTopStrains: staminaDifficultStrains,
    consistencyFactor,
    maxCombo,
  };
}
