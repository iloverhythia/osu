// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game.Rulesets.Mania/Difficulty/ManiaDifficultyCalculator.cs, Skills/Strain.cs,
// Evaluators/{Individual,Overall}StrainEvaluator.cs, Preprocessing/ManiaDifficultyHitObject.cs
// and the generic DifficultyHitObject / StrainSkill / StrainDecaySkill machinery.

import { HoldNote, type ManiaHitObject } from '../objects/ManiaHitObject';
import { roundHalfEven } from '../utils';
import { legacySort } from './LegacySortHelper';

const difficulty_multiplier = 0.018;

/** Precision.DefinitelyBigger(a, b, acceptableDifference) */
const definitelyBigger = (value1: number, value2: number, acceptableDifference: number): boolean => value1 - acceptableDifference > value2;

/** DiffUtils.Logistic(x, midpointOffset, multiplier, maxValue) */
const logistic = (x: number, midpointOffset: number, multiplier: number, maxValue = 1): number => maxValue / (1 + Math.exp(multiplier * (midpointOffset - x)));

export class ManiaDifficultyHitObject {
  readonly deltaTime: number;
  readonly startTime: number;
  readonly endTime: number;
  readonly column: number;
  private readonly columnIndex: number;
  /** The hit object earlier in time than this note in each column. */
  readonly previousHitObjects: (ManiaDifficultyHitObject | null)[];
  readonly columnStrainTime: number;

  constructor(
    readonly baseObject: ManiaHitObject,
    lastObject: ManiaHitObject,
    clockRate: number,
    private readonly objects: ManiaDifficultyHitObject[],
    private readonly perColumnObjects: ManiaDifficultyHitObject[][],
    readonly index: number,
  ) {
    this.deltaTime = (baseObject.startTime - lastObject.startTime) / clockRate;
    this.startTime = baseObject.startTime / clockRate;
    this.endTime = baseObject.endTime / clockRate;

    const totalColumns = perColumnObjects.length;
    this.column = baseObject.column;
    this.columnIndex = perColumnObjects[this.column].length;
    this.previousHitObjects = new Array(totalColumns).fill(null);

    const prevInColumn = this.prevInColumn(0);
    this.columnStrainTime = prevInColumn ? this.startTime - prevInColumn.startTime : this.startTime;

    if (index > 0) {
      const prevNote = objects[index - 1];
      for (let i = 0; i < prevNote.previousHitObjects.length; i++) this.previousHitObjects[i] = prevNote.previousHitObjects[i];
      // intentionally depends on processing order to match live.
      this.previousHitObjects[prevNote.column] = prevNote;
    }
  }

  previous(backwardsIndex: number): ManiaDifficultyHitObject | null {
    const i = this.index - (backwardsIndex + 1);
    return i >= 0 && i < this.objects.length ? this.objects[i] : null;
  }

  /** The previous object in the same column, exclusive of Long Note tails. */
  prevInColumn(backwardsIndex: number): ManiaDifficultyHitObject | null {
    const i = this.columnIndex - (backwardsIndex + 1);
    const list = this.perColumnObjects[this.column];
    return i >= 0 && i < list.length ? list[i] : null;
  }
}

/** IndividualStrainEvaluator.EvaluateDifficultyOf */
function evaluateIndividual(current: ManiaDifficultyHitObject): number {
  const startTime = current.startTime;
  const endTime = current.endTime;
  let holdFactor = 1.0; // Factor to all additional strains in case something else is held

  // We award a bonus if this note starts and ends before the end of another hold note.
  for (const prev of current.previousHitObjects) {
    if (prev == null) continue;
    if (definitelyBigger(prev.endTime, endTime, 1) && definitelyBigger(startTime, prev.startTime, 1)) {
      holdFactor = 1.25;
      break;
    }
  }

  return 2.0 * holdFactor;
}

const release_threshold = 30;

/** OverallStrainEvaluator.EvaluateDifficultyOf */
function evaluateOverall(current: ManiaDifficultyHitObject): number {
  const startTime = current.startTime;
  const endTime = current.endTime;
  let isOverlapping = false;

  let closestEndTime = Math.abs(endTime - startTime); // Lowest value we can assume with the current information
  let holdFactor = 1.0; // Factor to all additional strains in case something else is held
  let holdAddition = 0; // Addition to the current note in case it's a hold and has to be released awkwardly

  for (const prev of current.previousHitObjects) {
    if (prev == null) continue;

    // The current note is overlapped if a previous note or end is overlapping the current note body
    isOverlapping ||= definitelyBigger(prev.endTime, startTime, 1) && definitelyBigger(endTime, prev.endTime, 1) && definitelyBigger(startTime, prev.startTime, 1);

    // We give a slight bonus to everything if something is held meanwhile
    if (definitelyBigger(prev.endTime, endTime, 1) && definitelyBigger(startTime, prev.startTime, 1)) holdFactor = 1.25;

    closestEndTime = Math.min(closestEndTime, Math.abs(endTime - prev.endTime));
  }

  // The hold addition is given if there was an overlap, however it is only valid if there are no other note with a similar ending.
  if (isOverlapping) holdAddition = logistic(closestEndTime, release_threshold, 0.27);

  return (1 + holdAddition) * holdFactor;
}

const individual_decay_base = 0.125;
const overall_decay_base = 0.3;
const applyDecay = (value: number, deltaTime: number, decayBase: number): number => value * Math.pow(decayBase, deltaTime / 1000);

/** Strain (StrainDecaySkill with StrainDecayBase = 1, SkillMultiplier = 1; section length 400, decay weight 0.9). */
class Strain {
  private readonly individualStrains: number[];
  private highestIndividualStrain = 0;
  private overallStrain = 1;
  private currentStrain = 0;

  private currentSectionPeak = 0;
  private currentSectionEnd = 0;
  private readonly strainPeaks: number[] = [];
  private static readonly SECTION_LENGTH = 400;
  private static readonly DECAY_WEIGHT = 0.9;

  constructor(totalColumns: number) {
    this.individualStrains = new Array(totalColumns).fill(0);
  }

  /** StrainSkill.ProcessInternal */
  process(current: ManiaDifficultyHitObject): void {
    const sectionLength = Strain.SECTION_LENGTH;
    // The first object doesn't generate a strain, so we begin with an incremented section end
    if (current.index === 0) this.currentSectionEnd = Math.ceil(current.startTime / sectionLength) * sectionLength;

    while (current.startTime > this.currentSectionEnd) {
      this.strainPeaks.push(this.currentSectionPeak);
      this.currentSectionPeak = this.calculateInitialStrain(this.currentSectionEnd, current);
      this.currentSectionEnd += sectionLength;
    }

    // StrainDecaySkill.StrainValueAt (strain decay base is 1, so no decay is applied to CurrentStrain).
    this.currentStrain *= Math.pow(1, current.deltaTime / 1000);
    this.currentStrain += this.strainValueOf(current) * 1;

    this.currentSectionPeak = Math.max(this.currentStrain, this.currentSectionPeak);
  }

  private strainValueOf(current: ManiaDifficultyHitObject): number {
    const col = current.column;
    this.individualStrains[col] = applyDecay(this.individualStrains[col], current.columnStrainTime, individual_decay_base);
    this.individualStrains[col] += evaluateIndividual(current);

    // Take the hardest individualStrain for notes that happen at the same time (in a chord).
    // This is to ensure the order in which the notes are processed does not affect the resultant total strain.
    this.highestIndividualStrain = current.deltaTime <= 1 ? Math.max(this.highestIndividualStrain, this.individualStrains[col]) : this.individualStrains[col];

    this.overallStrain = applyDecay(this.overallStrain, current.deltaTime, overall_decay_base);
    this.overallStrain += evaluateOverall(current);

    // By subtracting CurrentStrain, this skill effectively only considers the maximum strain of any one hitobject within each strain section.
    return this.highestIndividualStrain + this.overallStrain - this.currentStrain;
  }

  /** Strain.CalculateInitialStrain */
  private calculateInitialStrain(offset: number, current: ManiaDifficultyHitObject): number {
    const prevStart = current.previous(0)!.startTime;
    return applyDecay(this.highestIndividualStrain, offset - prevStart, individual_decay_base) + applyDecay(this.overallStrain, offset - prevStart, overall_decay_base);
  }

  /** StrainSkill.DifficultyValue */
  difficultyValue(): number {
    let difficulty = 0;
    let weight = 1;

    // Sections with 0 strain are excluded.
    const peaks = [...this.strainPeaks, this.currentSectionPeak].filter(p => p > 0).sort((a, b) => b - a);

    for (const strain of peaks) {
      difficulty += strain * weight;
      weight *= Strain.DECAY_WEIGHT;
    }

    return difficulty;
  }
}

export interface ManiaDifficultyAttributes {
  starRating: number;
  maxCombo: number;
}

/** ManiaDifficultyCalculator.maxComboForObject */
function maxComboForObject(h: ManiaHitObject): number {
  if (h instanceof HoldNote) return 1 + Math.trunc((h.endTime - h.startTime) / 100);
  return 1;
}

/**
 * Calculates the difficulty of a playable (converted, mod-applied) osu!mania beatmap.
 * @param hitObjects top-level objects of the playable beatmap.
 * @param totalColumns ManiaBeatmap.TotalColumns.
 * @param clockRate the rate of rate-adjust mods (1.5 for DT, 0.75 for HT).
 */
export function calculateManiaDifficulty(hitObjects: readonly ManiaHitObject[], totalColumns: number, clockRate: number): ManiaDifficultyAttributes {
  if (hitObjects.length === 0) return { starRating: 0, maxCombo: 0 };

  const sortedObjects = hitObjects.slice();
  legacySort(sortedObjects, (a, b) => Math.trunc(roundHalfEven(a.startTime)) - Math.trunc(roundHalfEven(b.startTime)));

  const objects: ManiaDifficultyHitObject[] = [];
  const perColumnObjects: ManiaDifficultyHitObject[][] = Array.from({ length: totalColumns }, () => []);

  for (let i = 1; i < sortedObjects.length; i++) {
    const current = new ManiaDifficultyHitObject(sortedObjects[i], sortedObjects[i - 1], clockRate, objects, perColumnObjects, objects.length);
    objects.push(current);
    perColumnObjects[current.column].push(current);
  }

  const strain = new Strain(totalColumns);
  for (const o of objects) strain.process(o);

  return {
    starRating: strain.difficultyValue() * difficulty_multiplier,
    maxCombo: hitObjects.reduce((acc, h) => acc + maxComboForObject(h), 0),
  };
}
