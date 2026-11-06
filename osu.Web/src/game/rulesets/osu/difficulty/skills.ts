// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game/Rulesets/Difficulty/Skills/{Skill,StrainSkill,HarmonicSkill,VariableLengthStrainSkill}.cs

import type { OsuDifficultyHitObject } from './preprocessing';
import { compareDouble, logistic, pow } from './utils';

const descending = (a: number, b: number): number => compareDouble(b, a);

/** A bare minimal abstract skill for fully custom skill implementations. */
export abstract class Skill {
  /** List of calculated per-object difficulties, populated by process(). */
  protected readonly objectDifficulties: number[] = [];

  process(current: OsuDifficultyHitObject): void {
    this.objectDifficulties.push(this.processInternal(current));
  }

  protected abstract processInternal(current: OsuDifficultyHitObject): number;

  abstract difficultyValue(): number;

  getObjectDifficulties(): readonly number[] {
    return this.objectDifficulties;
  }
}

/** StrainSkill: fixed-length (400ms) strain sections with a geometric weighted sum. */
export abstract class StrainSkill extends Skill {
  protected readonly decayWeight: number = 0.9;
  protected readonly sectionLength: number = 400;

  private currentSectionPeak = 0;
  private currentSectionEnd = 0;
  private readonly strainPeaks: number[] = [];

  protected abstract strainValueAt(current: OsuDifficultyHitObject): number;
  protected abstract calculateInitialStrain(time: number, current: OsuDifficultyHitObject): number;

  protected processInternal(current: OsuDifficultyHitObject): number {
    // The first object doesn't generate a strain, so we begin with an incremented section end
    if (current.index === 0) this.currentSectionEnd = Math.ceil(current.startTime / this.sectionLength) * this.sectionLength;

    while (current.startTime > this.currentSectionEnd) {
      this.strainPeaks.push(this.currentSectionPeak);
      this.currentSectionPeak = this.calculateInitialStrain(this.currentSectionEnd, current);
      this.currentSectionEnd += this.sectionLength;
    }

    const strain = this.strainValueAt(current);
    this.currentSectionPeak = Math.max(strain, this.currentSectionPeak);
    return strain;
  }

  countTopWeightedStrains(difficultyValue: number): number {
    if (this.objectDifficulties.length === 0) return 0.0;
    const consistentTopStrain = difficultyValue * (1 - this.decayWeight);
    if (consistentTopStrain === 0) return this.objectDifficulties.length;
    let sum = 0;
    for (const s of this.objectDifficulties) sum += logistic(s / consistentTopStrain, 0.88, 10, 1.1);
    return sum;
  }

  getCurrentStrainPeaks(): number[] {
    return [...this.strainPeaks, this.currentSectionPeak];
  }

  difficultyValue(): number {
    let difficulty = 0;
    let weight = 1;
    // Sections with 0 strain are excluded to avoid worst-case time complexity of the following sort.
    const peaks = this.getCurrentStrainPeaks()
      .filter(p => p > 0)
      .sort(descending);
    for (const strain of peaks) {
      difficulty += strain * weight;
      weight *= this.decayWeight;
    }
    return difficulty;
  }
}

/** HarmonicSkill: per-object difficulties summed with a harmonic weighting. */
export abstract class HarmonicSkill extends Skill {
  /** The sum of object weights, calculated during summation. */
  protected objectWeightSum = 0;
  protected get harmonicScale(): number {
    return 1.0;
  }
  protected get decayExponent(): number {
    return 0.9;
  }

  protected abstract objectDifficultyOf(current: OsuDifficultyHitObject): number;

  protected processInternal(current: OsuDifficultyHitObject): number {
    return this.objectDifficultyOf(current);
  }

  protected getTransformedDifficulties(difficulties: number[]): number[] {
    return difficulties;
  }

  difficultyValue(): number {
    this.objectWeightSum = 0;
    if (this.objectDifficulties.length === 0) return 0;

    const difficulties = this.getTransformedDifficulties(this.objectDifficulties);
    const sorted = difficulties.slice().sort(descending);
    const scale = this.harmonicScale;
    const exponent = this.decayExponent;

    let difficulty = 0;
    let index = 0;
    // Objects with 0 difficulty are excluded.
    for (const obj of sorted) {
      if (!(obj > 0)) continue;
      const weight = (1 + scale / (1 + index)) / (pow(index, exponent) + 1 + scale / (1 + index));
      this.objectWeightSum += weight;
      difficulty += obj * weight;
      index += 1;
    }
    return difficulty;
  }

  countTopWeightedObjectDifficulties(difficultyValue: number): number {
    if (this.objectDifficulties.length === 0) return 0.0;
    if (this.objectWeightSum === 0) return 0.0;
    // What would the top difficulty be if all object difficulties were identical
    const consistentTopObject = difficultyValue / this.objectWeightSum;
    if (consistentTopObject === 0) return 0;
    let sum = 0;
    for (const d of this.objectDifficulties) sum += logistic(d / consistentTopObject, 0.88, 10, 1.1);
    return sum;
  }

  static difficultyToPerformance(difficulty: number): number {
    return 4.0 * difficulty * difficulty * difficulty;
  }
}

/** VariableLengthStrainSkill.StrainPeak */
export interface StrainPeak {
  readonly value: number;
  readonly sectionLength: number;
}

export const strainPeak = (value: number, sectionLength: number): StrainPeak => ({ value, sectionLength: roundHalfEven(sectionLength) });

/** .NET Math.Round (banker's rounding). */
function roundHalfEven(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** StrainPeak.CompareTo: reverse sort, highest first. Compare(listItem, value) = value.Value.CompareTo(listItem.Value). */
const comparePeaks = (a: StrainPeak, b: StrainPeak): number => compareDouble(b.value, a.value);

/** osu.Framework ListExtensions.AddInPlace (List.BinarySearch + Insert). */
function addInPlace(list: StrainPeak[], item: StrainPeak): void {
  let lo = 0;
  let hi = list.length - 1;
  let index = -1;
  while (lo <= hi) {
    const i = lo + ((hi - lo) >> 1);
    const order = comparePeaks(list[i], item);
    if (order === 0) {
      index = i;
      break;
    }
    if (order < 0) lo = i + 1;
    else hi = i - 1;
  }
  if (index < 0) index = lo;
  list.splice(index, 0, item);
}

/** Similar to StrainSkill, but strain sections can be any length (a new peak is started by each harder object). */
export abstract class VariableLengthStrainSkill extends Skill {
  protected readonly maxStoredLength: number;

  private currentSectionPeak = 0;
  private currentSectionBegin = 0;
  private currentSectionEnd = 0;
  private readonly strainPeaks: StrainPeak[] = [];
  private totalLength = 0;
  /** Previous strains kept so a high strain followed by lower ones still gets a full-length section. */
  private readonly queuedStrains: { strainValue: number; startTime: number }[] = [];
  private finalPeak: StrainPeak | null = null;

  constructor(
    protected readonly decayWeight = 0.9,
    protected readonly maxSectionLength = 400,
  ) {
    super();
    this.maxStoredLength = 11 / (1 - decayWeight);
  }

  protected abstract strainValueAt(current: OsuDifficultyHitObject): number;
  protected abstract calculateInitialStrain(time: number, current: OsuDifficultyHitObject): number;

  protected processInternal(current: OsuDifficultyHitObject): number {
    // If we're on the first object, set up the first section to end `MaxSectionLength` after it.
    if (current.index === 0) {
      this.currentSectionBegin = current.startTime;
      this.currentSectionEnd = this.currentSectionBegin + this.maxSectionLength;
      this.currentSectionPeak = this.strainValueAt(current);
      return this.currentSectionPeak;
    }

    this.backfillPeaks(current);

    const currentStrain = this.strainValueAt(current);

    if (currentStrain > this.currentSectionPeak) {
      // Clear the queue since none of the strains inside of it will be contributing to the difficulty.
      this.queuedStrains.length = 0;
      // End the current section with the new peak
      this.saveCurrentPeak(current.startTime - this.currentSectionBegin);
      this.currentSectionBegin = current.startTime;
      this.currentSectionEnd = this.currentSectionBegin + this.maxSectionLength;
      this.currentSectionPeak = currentStrain;
    } else {
      // Empty the queue of smaller elements as they won't be relevant to difficulty
      while (this.queuedStrains.length > 0 && this.queuedStrains[this.queuedStrains.length - 1].strainValue < currentStrain) this.queuedStrains.pop();
      this.queuedStrains.push({ strainValue: currentStrain, startTime: current.startTime });
    }

    return currentStrain;
  }

  private backfillPeaks(current: OsuDifficultyHitObject): void {
    while (current.startTime > this.currentSectionEnd) {
      // Save the current peak, marking the end of the section.
      this.saveCurrentPeak(this.currentSectionEnd - this.currentSectionBegin);
      this.currentSectionBegin = this.currentSectionEnd;

      if (this.queuedStrains.length > 0) {
        const { strainValue, startTime } = this.queuedStrains.shift()!;
        // We want the section to end `MaxSectionLength` after the strain we're using as an influence.
        this.currentSectionEnd = startTime + this.maxSectionLength;
        this.currentSectionPeak = this.calculateInitialStrain(this.currentSectionBegin, current);
        // Only use the queued strain if it contributes more difficulty.
        this.currentSectionPeak = Math.max(this.currentSectionPeak, strainValue);
      } else {
        this.currentSectionEnd = this.currentSectionBegin + this.maxSectionLength;
        this.currentSectionPeak = this.calculateInitialStrain(this.currentSectionBegin, current);
      }
    }
  }

  private saveCurrentPeak(sectionLength: number): void {
    if (this.finalPeak != null) {
      removeFirst(this.strainPeaks, this.finalPeak);
      this.finalPeak = null;
    }

    const peak = strainPeak(this.currentSectionPeak, sectionLength);
    addInPlace(this.strainPeaks, peak);
    this.totalLength += sectionLength;

    // Remove from the back of our strain peaks if there's any which are too deep to contribute to difficulty.
    while (this.totalLength > this.maxStoredLength * this.maxSectionLength) {
      this.totalLength -= this.strainPeaks[this.strainPeaks.length - 1].sectionLength;
      this.strainPeaks.pop();
    }
  }

  /** Live list of peak strains including the current section's peak. */
  getCurrentStrainPeaks(): StrainPeak[] {
    if (this.finalPeak == null) {
      this.finalPeak = strainPeak(this.currentSectionPeak, this.currentSectionEnd - this.currentSectionBegin);
      addInPlace(this.strainPeaks, this.finalPeak);
    }
    return this.strainPeaks;
  }

  countTopWeightedStrains(difficultyValue: number): number {
    if (this.objectDifficulties.length === 0) return 0.0;
    const consistentTopStrain = difficultyValue * (1 - this.decayWeight);
    if (consistentTopStrain === 0) return this.objectDifficulties.length;
    let sum = 0;
    for (const s of this.objectDifficulties) sum += logistic(s / consistentTopStrain, 0.88, 10, 1.1);
    return sum;
  }
}

/** List<StrainPeak>.Remove (record struct equality). */
function removeFirst(list: StrainPeak[], peak: StrainPeak): void {
  const eq = (a: number, b: number): boolean => a === b || (Number.isNaN(a) && Number.isNaN(b));
  const i = list.findIndex(p => eq(p.value, peak.value) && eq(p.sectionLength, peak.sectionLength));
  if (i >= 0) list.splice(i, 1);
}
