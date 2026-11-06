// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game/Rulesets/Difficulty/DifficultyCalculator.cs (Calculate / CalculateTimed) and
// osu.Game.Rulesets.Osu/Difficulty/OsuDifficultyCalculator.cs.

import { inverseDifficultyRange, difficultyRange } from '../../../beatmaps/Difficulty';
import type { ModSet } from '../../../mods/Mods';
import { affectsCombo } from '../../../scoring/HitResult';
import type { OsuPlayableBeatmap } from '../beatmap';
import type { OsuHitObject } from '../objects';
import { Aim, Flashlight, Reading, Speed } from './osuSkills';
import { computeFloatDifficulty, createDiffObjects, DiffObject, FloatDifficulty, greatHitWindow, OsuDifficultyHitObject } from './preprocessing';
import { HarmonicSkill, Skill } from './skills';
import { norm } from './utils';

/** OsuDifficultyCalculator.Version */
export const OSU_DIFFICULTY_VERSION = 20260706;

export const PERFORMANCE_BASE_MULTIPLIER = 1.12;
export const PERFORMANCE_NORM_EXPONENT = 1.1;

export interface OsuDifficultyAttributes {
  starRating: number;
  /** Mod acronyms the difficulty was calculated with. */
  mods: string[];
  aimDifficulty: number;
  aimDifficultSliderCount: number;
  speedDifficulty: number;
  speedNoteCount: number;
  /** Only present when Flashlight is enabled. */
  flashlightDifficulty?: number;
  readingDifficulty: number;
  sliderFactor: number;
  aimTopWeightedSliderFactor: number;
  speedTopWeightedSliderFactor: number;
  aimDifficultStrainCount: number;
  speedDifficultStrainCount: number;
  readingDifficultNoteCount: number;
  maxCombo: number;
  hitCircleCount: number;
  sliderCount: number;
  spinnerCount: number;

  // ---- not part of the C# OsuDifficultyAttributes; provided for display / the performance calculator ----
  /** Clock rate the attributes were calculated at (from DT/NC/HT/DC). */
  clockRate: number;
  /** Approach rate adjusted for clock rate (as the performance calculator computes it). */
  approachRate: number;
  /** Overall difficulty adjusted for clock rate (from the rate-adjusted great hit window). */
  overallDifficulty: number;
  /** Mod-adjusted (EZ/HR), not rate-adjusted beatmap difficulty values. */
  beatmapApproachRate: number;
  beatmapOverallDifficulty: number;
  beatmapCircleSize: number;
  drainRate: number;
}

export interface TimedOsuDifficultyAttributes {
  /** End time of the last hit object included (unadjusted for rate). */
  time: number;
  attributes: OsuDifficultyAttributes;
}

interface Skills {
  aim: Aim;
  aimWithoutSliders: Aim;
  speed: Speed;
  reading: Reading;
  flashlight: Flashlight | null;
  all: Skill[];
}

function createSkills(mods: ModSet, objectCount: number): Skills {
  const aim = new Aim(mods, true);
  const aimWithoutSliders = new Aim(mods, false);
  const speed = new Speed(mods);
  const reading = new Reading(mods);
  const flashlight = mods.has('FL') ? new Flashlight(mods, objectCount) : null;
  const all: Skill[] = [aim, aimWithoutSliders, speed, reading];
  if (flashlight) all.push(flashlight);
  return { aim, aimWithoutSliders, speed, reading, flashlight, all };
}

function createDifficultyHitObjects(objects: DiffObject[], clockRate: number): OsuDifficultyHitObject[] {
  const list: OsuDifficultyHitObject[] = [];
  // The first jump is formed by the first two hitobjects of the map.
  for (let i = 1; i < objects.length; i++) list.push(new OsuDifficultyHitObject(objects[i], objects[i - 1], clockRate, list, list.length));
  return list;
}

/** SortObjects: OrderBy(BaseObject.StartTime) (stable). Indices / Previous() keep referring to creation order. */
function sortObjects(objects: OsuDifficultyHitObject[]): OsuDifficultyHitObject[] {
  for (let i = 1; i < objects.length; i++) if (objects[i].baseObject.startTime < objects[i - 1].baseObject.startTime) {
    return objects.slice().sort((a, b) => a.baseObject.startTime - b.baseObject.startTime);
  }
  return objects;
}

/** IBeatmap.GetMaxCombo(): counts every (nested) judgement which affects combo. */
function maxComboOf(hitObjects: readonly OsuHitObject[]): number {
  let combo = 0;
  const visit = (h: OsuHitObject) => {
    if (affectsCombo(h.judgement.maxResult)) combo++;
    for (const n of h.nested) visit(n);
  };
  for (const h of hitObjects) visit(h);
  return combo;
}

const calculateAimDifficultyRating = (difficultyValue: number): number => Math.pow(difficultyValue, 0.63) * 0.02275;
const calculateDifficultyRating = (difficultyValue: number): number => Math.sqrt(difficultyValue) * 0.0675;
const calculateStarRating = (basePerformance: number): number => Math.cbrt(basePerformance * PERFORMANCE_BASE_MULTIPLIER);

/** OsuPerformanceCalculator.DifficultyToPerformance */
export const aimDifficultyToPerformance = (difficulty: number): number => 4.0 * difficulty * difficulty * difficulty;

/** OsuDifficultyCalculator.SumCognitionDifficulty */
export function sumCognitionDifficulty(reading: number, flashlight: number): number {
  if (reading <= 0) return flashlight;
  if (flashlight <= 0) return reading;
  // Nerf flashlight value in cognition sum when reading is greater than flashlight
  return norm(PERFORMANCE_NORM_EXPONENT, reading, flashlight * Math.min(Math.max(flashlight / reading, 0.25), 1.0));
}

/** OsuPerformanceCalculator.calculateRateAdjustedApproachRate */
export function rateAdjustedApproachRate(approachRate: number, clockRate: number): number {
  const preempt = difficultyRange(approachRate, 1800, 1200, 450) / clockRate;
  return inverseDifficultyRange(preempt, 1800, 1200, 450);
}

/** Overall difficulty from the rate-adjusted great hit window (as OsuPerformanceCalculator). */
export const rateAdjustedOverallDifficulty = (overallDifficulty: number, clockRate: number): number => (79.5 - greatHitWindow(overallDifficulty) / clockRate) / 6;

function createDifficultyAttributes(
  hitObjects: readonly OsuHitObject[],
  mods: ModSet,
  skills: Skills,
  clockRate: number,
  difficulty: FloatDifficulty,
): OsuDifficultyAttributes {
  const base: OsuDifficultyAttributes = {
    starRating: 0,
    mods: mods.list,
    aimDifficulty: 0,
    aimDifficultSliderCount: 0,
    speedDifficulty: 0,
    speedNoteCount: 0,
    readingDifficulty: 0,
    sliderFactor: 0,
    aimTopWeightedSliderFactor: 0,
    speedTopWeightedSliderFactor: 0,
    aimDifficultStrainCount: 0,
    speedDifficultStrainCount: 0,
    readingDifficultNoteCount: 0,
    maxCombo: 0,
    hitCircleCount: 0,
    sliderCount: 0,
    spinnerCount: 0,
    clockRate,
    approachRate: rateAdjustedApproachRate(difficulty.approachRate, clockRate),
    overallDifficulty: rateAdjustedOverallDifficulty(difficulty.overallDifficulty, clockRate),
    beatmapApproachRate: difficulty.approachRate,
    beatmapOverallDifficulty: difficulty.overallDifficulty,
    beatmapCircleSize: difficulty.circleSize,
    drainRate: difficulty.drainRate,
  };

  if (hitObjects.length === 0) return base;

  const { aim, aimWithoutSliders, speed, reading, flashlight } = skills;

  const aimDifficultyValue = aim.difficultyValue();
  const aimNoSlidersDifficultyValue = aimWithoutSliders.difficultyValue();
  const speedDifficultyValue = speed.difficultyValue();
  const readingDifficultyValue = reading.difficultyValue();

  const aimDifficultStrainCount = aim.countTopWeightedStrains(aimDifficultyValue);
  const speedDifficultStrainCount = speed.countTopWeightedObjectDifficulties(speedDifficultyValue);
  const readingDifficultNoteCount = reading.countTopWeightedObjectDifficulties(readingDifficultyValue);

  const speedNotes = speed.relevantObjectCount();

  const aimNoSlidersTopWeightedSliderCount = aimWithoutSliders.countTopWeightedSliders(aimNoSlidersDifficultyValue);
  const aimNoSlidersDifficultStrainCount = aimWithoutSliders.countTopWeightedStrains(aimNoSlidersDifficultyValue);

  const aimTopWeightedSliderFactor = aimNoSlidersTopWeightedSliderCount / Math.max(1, aimNoSlidersDifficultStrainCount - aimNoSlidersTopWeightedSliderCount);

  const speedTopWeightedSliderCount = speed.countTopWeightedSliders(speedDifficultyValue);
  const speedTopWeightedSliderFactor = speedTopWeightedSliderCount / Math.max(1, speedDifficultStrainCount - speedTopWeightedSliderCount);

  const difficultSliders = aim.getDifficultSliders();

  let hitCircleCount = 0;
  let sliderCount = 0;
  let spinnerCount = 0;
  for (const h of hitObjects) {
    if (h.kind === 'circle') hitCircleCount++;
    else if (h.kind === 'slider') sliderCount++;
    else if (h.kind === 'spinner') spinnerCount++;
  }

  const aimRating = calculateAimDifficultyRating(aimDifficultyValue);
  const aimNoSlidersRating = calculateAimDifficultyRating(aimNoSlidersDifficultyValue);

  const sliderFactor = aimDifficultyValue > 0 ? aimNoSlidersRating / aimRating : 1;

  const speedRating = calculateDifficultyRating(speedDifficultyValue);
  const readingRating = calculateDifficultyRating(readingDifficultyValue);

  const flashlightRating = flashlight ? calculateDifficultyRating(flashlight.difficultyValue()) : undefined;

  const baseAimPerformance = aimDifficultyToPerformance(aimRating);
  const baseSpeedPerformance = HarmonicSkill.difficultyToPerformance(speedRating);
  const baseReadingPerformance = HarmonicSkill.difficultyToPerformance(readingRating);
  const baseFlashlightPerformance = flashlightRating != null ? Flashlight.difficultyToPerformance(flashlightRating) : 0.0;

  const baseCognitionPerformance = sumCognitionDifficulty(baseReadingPerformance, baseFlashlightPerformance);

  const basePerformance = norm(PERFORMANCE_NORM_EXPONENT, baseAimPerformance, baseSpeedPerformance, baseCognitionPerformance);

  const attributes: OsuDifficultyAttributes = {
    ...base,
    starRating: calculateStarRating(basePerformance),
    aimDifficulty: aimRating,
    aimDifficultSliderCount: difficultSliders,
    speedDifficulty: speedRating,
    speedNoteCount: speedNotes,
    readingDifficulty: readingRating,
    sliderFactor,
    aimDifficultStrainCount,
    speedDifficultStrainCount,
    readingDifficultNoteCount,
    aimTopWeightedSliderFactor,
    speedTopWeightedSliderFactor,
    maxCombo: maxComboOf(hitObjects),
    hitCircleCount,
    sliderCount,
    spinnerCount,
  };
  if (flashlightRating != null) attributes.flashlightDifficulty = flashlightRating;
  return attributes;
}

function prepare(playable: OsuPlayableBeatmap) {
  const mods = playable.mods;
  const clockRate = mods.rate;
  const difficulty = computeFloatDifficulty(playable);
  const diffObjects = createDiffObjects(playable, difficulty);
  const skills = createSkills(mods, playable.hitObjects.length);
  const difficultyObjects = sortObjects(createDifficultyHitObjects(diffObjects, clockRate));
  return { mods, clockRate, difficulty, skills, difficultyObjects };
}

/**
 * Calculates the osu! difficulty attributes (star rating etc.) of a converted, mod-applied playable beatmap.
 * Mods are taken from `playable.mods` (rate from DT/NC/HT/DC; HD, FL, RX, AP affect skills; EZ/HR via difficulty).
 */
export function calculateOsuDifficulty(playable: OsuPlayableBeatmap): OsuDifficultyAttributes {
  const { mods, clockRate, difficulty, skills, difficultyObjects } = prepare(playable);

  if (playable.hitObjects.length > 0) {
    for (const hitObject of difficultyObjects) for (const skill of skills.all) skill.process(hitObject);
  }

  return createDifficultyAttributes(playable.hitObjects, mods, skills, clockRate, difficulty);
}

/**
 * DifficultyCalculator.CalculateTimed: difficulty attributes after every hit object (useful for live pp/SR displays).
 */
export function calculateOsuDifficultyTimed(playable: OsuPlayableBeatmap): TimedOsuDifficultyAttributes[] {
  const { mods, clockRate, difficulty, skills, difficultyObjects } = prepare(playable);
  const out: TimedOsuDifficultyAttributes[] = [];
  if (playable.hitObjects.length === 0) return out;

  const progressive: OsuHitObject[] = [];
  let currentIndex = 0;

  for (const obj of playable.hitObjects) {
    progressive.push(obj);
    while (currentIndex < difficultyObjects.length && difficultyObjects[currentIndex].baseObject.source.endTime <= obj.endTime) {
      for (const skill of skills.all) skill.process(difficultyObjects[currentIndex]);
      currentIndex++;
    }
    out.push({ time: obj.endTime, attributes: createDifficultyAttributes(progressive, mods, skills, clockRate, difficulty) });
  }

  return out;
}
