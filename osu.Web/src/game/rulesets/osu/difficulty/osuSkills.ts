// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game.Rulesets.Osu/Difficulty/Skills/{Aim,Speed,Reading,Flashlight}.cs

import type { ModSet } from '../../../mods/Mods';
import { evaluateAgility, evaluateFlashlight, evaluateFlowAim, evaluateReading, evaluateRhythm, evaluateSnapAim, evaluateSpeed } from './evaluators';
import type { OsuDifficultyHitObject } from './preprocessing';
import { HarmonicSkill, StrainPeak, strainPeak, StrainSkill, VariableLengthStrainSkill } from './skills';
import { clamp, lerp, logistic, logisticExp, norm, pow, pow2 } from './utils';

/** OsuModTouchDevice is not part of our ModSet, but honour it if it ever appears. */
const hasTouchDevice = (mods: ModSet): boolean => mods.has('TD');

/** Represents the skill required to correctly aim at every object in the map with a uniform CircleSize and normalized distances. */
export class Aim extends VariableLengthStrainSkill {
  private currentStrain = 0;
  private readonly sliderStrains: number[] = [];

  constructor(
    private readonly mods: ModSet,
    readonly includeSliders: boolean,
  ) {
    super();
  }

  private strainDecay(ms: number): number {
    return pow(0.2, ms / 1000);
  }

  protected calculateInitialStrain(time: number, current: OsuDifficultyHitObject): number {
    return this.currentStrain * this.strainDecay(time - current.previous(0)!.startTime);
  }

  protected strainValueAt(current: OsuDifficultyHitObject): number {
    if (this.mods.has('AP')) return 0;

    const decay = this.strainDecay(current.adjustedDeltaTime);

    this.currentStrain *= decay;
    this.currentStrain += this.calculateAdjustedDifficulty(current) * (1 - decay);

    if (current.baseObject.kind === 'slider') this.sliderStrains.push(this.currentStrain);

    return this.currentStrain;
  }

  private calculateAdjustedDifficulty(current: OsuDifficultyHitObject): number {
    const skill_multiplier_snap = 70.9;
    const skill_multiplier_agility = 2.35;
    const skill_multiplier_flow = 242.0;

    const snapDifficulty = evaluateSnapAim(current, this.includeSliders) * skill_multiplier_snap;
    const agilityDifficulty = evaluateAgility(current) * skill_multiplier_agility;
    const flowDifficulty = evaluateFlowAim(current, this.includeSliders) * skill_multiplier_flow;

    let totalDifficulty = this.calculateTotalValue(snapDifficulty, agilityDifficulty, flowDifficulty);

    // (OsuModMagnetised is not available in this port.)

    totalDifficulty *= 0.985 + pow2(Math.max(0, current.overallDifficulty)) / 4000;

    return totalDifficulty;
  }

  private calculateTotalValue(snapDifficulty: number, agilityDifficulty: number, flowDifficulty: number): number {
    const skill_multiplier_total = 1.12;
    const combined_snap_norm_exponent = 1.2;

    // We compare flow to combined snap and agility because snap by itself doesn't have enough difficulty to be above flow on streams
    let combinedSnapDifficulty = norm(combined_snap_norm_exponent, snapDifficulty, agilityDifficulty);

    const pSnap = calculateSnapFlowProbability(flowDifficulty / combinedSnapDifficulty);
    const pFlow = 1 - pSnap;

    if (hasTouchDevice(this.mods)) {
      // we don't adjust agility here since agility represents TD difficulty in a decent enough way
      snapDifficulty = pow(snapDifficulty, 0.89);
      combinedSnapDifficulty = norm(combined_snap_norm_exponent, snapDifficulty, agilityDifficulty);
    }

    if (this.mods.has('RX')) {
      combinedSnapDifficulty *= 0.75;
      flowDifficulty *= 0.6;
    }

    const totalDifficulty = combinedSnapDifficulty * pSnap + flowDifficulty * pFlow;

    return totalDifficulty * skill_multiplier_total;
  }

  getDifficultSliders(): number {
    if (this.sliderStrains.length === 0) return 0;
    let maxSliderStrain = -Infinity;
    for (const s of this.sliderStrains) if (s > maxSliderStrain) maxSliderStrain = s;
    if (maxSliderStrain === 0) return 0;
    let sum = 0;
    for (const strain of this.sliderStrains) sum += logistic(strain / maxSliderStrain, 0.5, 12.0);
    return sum;
  }

  countTopWeightedSliders(difficultyValue: number): number {
    if (this.sliderStrains.length === 0) return 0;
    const consistentTopStrain = difficultyValue * (1 - this.decayWeight);
    if (consistentTopStrain === 0) return 0;
    let sum = 0;
    for (const s of this.sliderStrains) sum += logistic(s / consistentTopStrain, 0.88, 10, 1.1);
    return sum;
  }

  difficultyValue(): number {
    let difficulty = 0;
    let time = 0;

    // Difficulty is a continuous weighted sum of the sorted strains
    for (const strain of this.getReducedStrainPeaks()) {
      // ∫ DecayWeight^x dx over [startTime, endTime], scaled so that MaxSectionLength chunks match StrainSkill.
      const startTime = time;
      const endTime = time + strain.sectionLength / this.maxSectionLength;
      const weight = pow(this.decayWeight, startTime) - pow(this.decayWeight, endTime);
      difficulty += strain.value * weight;
      time = endTime;
    }

    return difficulty / (1 - this.decayWeight);
  }

  /** Returns a sorted list of strain peaks with the highest values reduced. */
  private getReducedStrainPeaks(): StrainPeak[] {
    const reduced_section_time = 4000;
    const reduced_strain_baseline = 0.727;

    // Sections with 0 strain are excluded to avoid worst-case time complexity of the following sort.
    const strains = this.getCurrentStrainPeaks().filter(p => p.value > 0);

    const chunk_size = 20;
    let time = 0;
    let skipCount = 0;

    // We are reducing the highest strains first to account for extreme difficulty spikes
    // Strains are split into 20ms chunks to try to mitigate inconsistencies caused by reducing strains
    while (strains.length > skipCount && time < reduced_section_time) {
      const strain = strains[skipCount];

      for (let addedTime = 0; addedTime < strain.sectionLength; addedTime += chunk_size) {
        const scale = Math.log10(lerp(1, 10, clamp((time + addedTime) / reduced_section_time, 0, 1)));
        // intentionally add at end and sort afterwards
        strains.push(strainPeak(strain.value * lerp(reduced_strain_baseline, 1.0, scale), Math.min(chunk_size, strain.sectionLength - addedTime)));
      }

      time += strain.sectionLength;
      skipCount++;
    }

    // OrderByDescending is a stable sort, as is Array.prototype.sort.
    return strains.slice(skipCount).sort((a, b) => (a.value < b.value ? 1 : a.value > b.value ? -1 : 0));
  }
}

// A function that turns the ratio of snap : flow into the probability of snapping/flowing.
function calculateSnapFlowProbability(ratio: number): number {
  const k = 7.27;
  if (ratio === 0) return 0;
  if (Number.isNaN(ratio)) return 1;
  return logisticExp(-k * Math.log(ratio));
}

/** Represents the skill required to press keys with regards to keeping up with the speed at which objects need to be hit. */
export class Speed extends HarmonicSkill {
  private readonly sliderStrains: number[] = [];
  private currentStrain = 0;

  constructor(private readonly mods: ModSet) {
    super();
  }

  protected get harmonicScale(): number {
    return 20;
  }

  protected get decayExponent(): number {
    return 0.9;
  }

  private strainDecay(ms: number): number {
    return pow(0.3, ms / 1000);
  }

  protected objectDifficultyOf(current: OsuDifficultyHitObject): number {
    const skill_multiplier = 1.16;

    if (this.mods.has('RX')) return 0;

    const decay = this.strainDecay(current.adjustedDeltaTime);

    this.currentStrain *= decay;
    let difficulty = evaluateSpeed(current);
    if (this.mods.has('AP')) difficulty *= 0.5;
    this.currentStrain += difficulty * (1 - decay) * skill_multiplier;

    const currentRhythm = evaluateRhythm(current);
    const totalStrain = this.currentStrain * currentRhythm;

    if (current.baseObject.kind === 'slider') this.sliderStrains.push(totalStrain);

    return totalStrain;
  }

  relevantObjectCount(): number {
    if (this.objectDifficulties.length === 0) return 0;
    let maxStrain = -Infinity;
    for (const s of this.objectDifficulties) if (s > maxStrain) maxStrain = s;
    if (maxStrain === 0) return 0;
    let sum = 0;
    for (const strain of this.objectDifficulties) sum += logistic(strain / maxStrain, 0.5, 12.0);
    return sum;
  }

  countTopWeightedSliders(difficultyValue: number): number {
    if (this.sliderStrains.length === 0) return 0;
    if (this.objectWeightSum === 0) return 0.0;
    const consistentTopObject = difficultyValue / this.objectWeightSum;
    if (consistentTopObject === 0) return 0;
    let sum = 0;
    for (const s of this.sliderStrains) sum += logistic(s / consistentTopObject, 0.88, 10, 1.1);
    return sum;
  }
}

export class Reading extends HarmonicSkill {
  private readonly hasHiddenMod: boolean;
  private currentStrain = 0;
  private reducedNoteCount = 0;
  private reducedDuration: number | null = null;

  constructor(private readonly mods: ModSet) {
    super();
    // OsuModHidden with OnlyFadeApproachCircles = false (the default and only option here).
    this.hasHiddenMod = mods.has('HD');
  }

  private strainDecay(ms: number): number {
    return pow(0.8, ms / 1000);
  }

  protected objectDifficultyOf(current: OsuDifficultyHitObject): number {
    const skill_multiplier = 2.5;
    const reduced_difficulty_duration = 60 * 1000;

    const decay = this.strainDecay(current.deltaTime);

    this.currentStrain *= decay;
    this.currentStrain += this.calculateAdjustedDifficulty(current) * (1 - decay) * skill_multiplier;

    this.reducedDuration ??= current.startTime + reduced_difficulty_duration;

    if (current.startTime <= this.reducedDuration) this.reducedNoteCount++;

    return this.currentStrain;
  }

  private calculateAdjustedDifficulty(current: OsuDifficultyHitObject): number {
    let difficulty = evaluateReading(current, this.hasHiddenMod);

    if (hasTouchDevice(this.mods)) difficulty = pow(difficulty, 0.89);
    if (this.mods.has('RX')) difficulty *= 0.4;
    if (this.mods.has('AP')) difficulty *= 0.1;

    difficulty *= 0.825 + pow(Math.max(0, current.overallDifficulty), 2.2) / 1125.0;

    return difficulty;
  }

  protected getTransformedDifficulties(difficulties: number[]): number[] {
    difficulties = difficulties.filter(v => v > 0);

    const reduced_difficulty_base_line = 0.0; // Assume the first seconds are completely memorised

    for (let i = 0; i < Math.min(difficulties.length, this.reducedNoteCount); i++) {
      const scale = Math.log10(lerp(1, 10, clamp(i / this.reducedNoteCount, 0, 1)));
      difficulties[i] *= lerp(reduced_difficulty_base_line, 1.0, scale);
    }

    return difficulties;
  }

  countTopWeightedObjectDifficulties(difficultyValue: number): number {
    if (this.objectDifficulties.length === 0) return 0.0;
    if (this.objectWeightSum === 0) return 0.0;
    const consistentTopNote = difficultyValue / this.objectWeightSum;
    if (consistentTopNote === 0) return 0;
    let sum = 0;
    for (const d of this.objectDifficulties) sum += logistic(d / consistentTopNote, 1.15, 5, 1.1);
    return sum;
  }
}

/** Represents the skill required to memorise and hit every object in a map with the Flashlight mod enabled. */
export class Flashlight extends StrainSkill {
  private currentStrain = 0;

  constructor(
    private readonly mods: ModSet,
    private readonly totalObjects: number,
  ) {
    super();
  }

  private strainDecay(ms: number): number {
    return pow(0.15, ms / 1000);
  }

  protected calculateInitialStrain(time: number, current: OsuDifficultyHitObject): number {
    return this.currentStrain * this.strainDecay(time - current.previous(0)!.startTime);
  }

  protected strainValueAt(current: OsuDifficultyHitObject): number {
    const skill_multiplier = 0.058;

    if (!this.mods.has('FL')) return 0;

    this.currentStrain *= this.strainDecay(current.deltaTime);
    this.currentStrain += this.calculateAdjustedDifficulty(current) * skill_multiplier;

    return this.currentStrain;
  }

  private calculateAdjustedDifficulty(current: OsuDifficultyHitObject): number {
    let difficulty = evaluateFlashlight(current, this.mods);

    if (hasTouchDevice(this.mods)) difficulty = pow(difficulty, 0.9);
    if (this.mods.has('RX')) difficulty *= 0.7;
    if (this.mods.has('AP')) difficulty *= 0.4;

    difficulty *= 0.985 + pow2(Math.max(0, current.overallDifficulty)) / 4000;

    return difficulty;
  }

  difficultyValue(): number {
    let sum = 0;
    for (const p of this.getCurrentStrainPeaks()) sum += p;

    // Account for shorter maps having a higher ratio of 0 combo/100 combo flashlight radius.
    const n = this.totalObjects;
    sum *= 0.7 + 0.1 * Math.min(1.0, n / 200.0) + (n > 200 ? 0.2 * Math.min(1.0, (n - 200) / 200.0) : 0.0);

    return sum;
  }

  static difficultyToPerformance(difficulty: number): number {
    return 25 * difficulty * difficulty;
  }
}
