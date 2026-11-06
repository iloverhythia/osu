// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game/Rulesets/Difficulty/Skills/{Skill,StrainSkill,StrainDecaySkill}.cs and
// osu.Game.Rulesets.Taiko/Difficulty/Skills/{Colour,Reading,Rhythm,Stamina}.cs

import { Hit } from '../objects';
import { evaluateColourDifficultyOf, evaluateReadingDifficultyOf, evaluateRhythmDifficultyOf, evaluateStaminaDifficultyOf } from './evaluators';
import type { TaikoDifficultyHitObject } from './preprocessing';
import { logistic, logisticExp, orderDescending, reverseLerp } from './utils';

export abstract class StrainSkill {
  protected readonly objectDifficulties: number[] = [];
  protected get decayWeight(): number {
    return 0.9;
  }
  protected get sectionLength(): number {
    return 400;
  }

  private currentSectionPeak = 0;
  private currentSectionEnd = 0;
  private readonly strainPeaks: number[] = [];

  /** Skill.Process */
  process(current: TaikoDifficultyHitObject): void {
    this.objectDifficulties.push(this.processInternal(current));
  }

  private processInternal(current: TaikoDifficultyHitObject): number {
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

  protected abstract strainValueAt(current: TaikoDifficultyHitObject): number;
  protected abstract calculateInitialStrain(time: number, current: TaikoDifficultyHitObject): number;

  getObjectDifficulties(): readonly number[] {
    return this.objectDifficulties;
  }

  getCurrentStrainPeaks(): number[] {
    return [...this.strainPeaks, this.currentSectionPeak];
  }

  countTopWeightedStrains(difficultyValue: number): number {
    if (this.objectDifficulties.length === 0) return 0.0;
    // What would the top strain be if all strain values were identical
    const consistentTopStrain = difficultyValue * (1 - this.decayWeight);
    if (consistentTopStrain === 0) return this.objectDifficulties.length;
    // Use a weighted sum of all strains. Constants are arbitrary and give nice values
    let sum = 0;
    for (const s of this.objectDifficulties) sum += logistic(s / consistentTopStrain, 0.88, 10, 1.1);
    return sum;
  }

  difficultyValue(): number {
    let difficulty = 0;
    let weight = 1;
    // Sections with 0 strain are excluded to avoid worst-case time complexity of the following sort.
    const peaks = orderDescending(this.getCurrentStrainPeaks().filter(p => p > 0));
    for (const strain of peaks) {
      difficulty += strain * weight;
      weight *= this.decayWeight;
    }
    return difficulty;
  }
}

export abstract class StrainDecaySkill extends StrainSkill {
  protected abstract get skillMultiplier(): number;
  protected abstract get strainDecayBase(): number;
  protected currentStrain = 0;

  protected calculateInitialStrain(time: number, current: TaikoDifficultyHitObject): number {
    return this.currentStrain * this.strainDecay(time - current.previous(0)!.startTime);
  }

  protected strainValueAt(current: TaikoDifficultyHitObject): number {
    this.currentStrain *= this.strainDecay(current.deltaTime);
    this.currentStrain += this.strainValueOf(current) * this.skillMultiplier;
    return this.currentStrain;
  }

  protected abstract strainValueOf(current: TaikoDifficultyHitObject): number;

  private strainDecay(ms: number): number {
    return Math.pow(this.strainDecayBase, ms / 1000);
  }
}

/** Calculates the colour coefficient of taiko difficulty. */
export class Colour extends StrainDecaySkill {
  protected get skillMultiplier(): number {
    return 0.12;
  }
  // This is set to decay slower than other skills, due to the fact that only the first note of each encoding class having any difficulty values.
  protected get strainDecayBase(): number {
    return 0.8;
  }
  protected strainValueOf(current: TaikoDifficultyHitObject): number {
    return evaluateColourDifficultyOf(current);
  }
}

/** Calculates the reading coefficient of taiko difficulty. */
export class Reading extends StrainDecaySkill {
  protected get skillMultiplier(): number {
    return 1.0;
  }
  protected get strainDecayBase(): number {
    return 0.4;
  }
  private readingStrain = 0;

  protected strainValueOf(current: TaikoDifficultyHitObject): number {
    // Drum Rolls and Swells are exempt.
    if (!(current.baseObject instanceof Hit)) return 0.0;
    const index = current.colourData.monoStreak ? current.colourData.indexInMonoStreak : 0;
    this.readingStrain *= logistic(index, 4, -1 / 25.0, 0.5) + 0.5;
    this.readingStrain *= this.strainDecayBase;
    this.readingStrain += evaluateReadingDifficultyOf(current) * this.skillMultiplier;
    return this.readingStrain;
  }
}

/** Calculates the rhythm coefficient of taiko difficulty. */
export class Rhythm extends StrainDecaySkill {
  protected get skillMultiplier(): number {
    return 1.0;
  }
  protected get strainDecayBase(): number {
    return 0.4;
  }
  protected strainValueOf(current: TaikoDifficultyHitObject): number {
    let difficulty = evaluateRhythmDifficultyOf(current);
    // To prevent abuse of exceedingly long intervals between awkward rhythms, we penalise its difficulty.
    const staminaDifficulty = evaluateStaminaDifficultyOf(current) - 0.5; // Remove base strain
    difficulty *= logistic(staminaDifficulty, 1 / 15.0, 50.0);
    return difficulty;
  }
}

/** Calculates the stamina coefficient of taiko difficulty. */
export class Stamina extends StrainSkill {
  private static readonly SKILL_MULTIPLIER = 1.1;
  private static readonly STRAIN_DECAY_BASE = 0.4;
  private staminaStrain = 0;

  constructor(
    readonly singleColourStamina: boolean,
    private readonly isConvert: boolean,
  ) {
    super();
  }

  private strainDecay(ms: number): number {
    return Math.pow(Stamina.STRAIN_DECAY_BASE, ms / 1000);
  }

  protected strainValueAt(current: TaikoDifficultyHitObject): number {
    this.staminaStrain *= this.strainDecay(current.deltaTime);
    let staminaDifficulty = evaluateStaminaDifficultyOf(current) * Stamina.SKILL_MULTIPLIER;

    // Safely prevents previous strains from shifting as new notes are added.
    const index = current.colourData.monoStreak ? current.colourData.indexInMonoStreak : 0;
    const monoLengthBonus = this.isConvert ? 1.0 : 1.0 + 0.5 * reverseLerp(index, 5, 20);

    // Mono-streak bonus is only applied to colour-based stamina to reward longer sequences of same-colour hits within patterns.
    if (!this.singleColourStamina) staminaDifficulty *= monoLengthBonus;

    this.staminaStrain += staminaDifficulty;

    // For converted maps, difficulty often comes entirely from long mono streams with no colour variation.
    // To avoid over-rewarding these maps based purely on stamina strain, we dampen the strain value once the index exceeds 10.
    return this.singleColourStamina ? logisticExp(-(index - 10) / 2.0, this.staminaStrain) : this.staminaStrain;
  }

  protected calculateInitialStrain(time: number, current: TaikoDifficultyHitObject): number {
    return this.singleColourStamina ? 0 : this.staminaStrain * this.strainDecay(time - current.previous(0)!.startTime);
  }
}
