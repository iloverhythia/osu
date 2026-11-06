// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game.Rulesets.Catch/Difficulty/CatchDifficultyCalculator.cs, Preprocessing/CatchDifficultyHitObject.cs,
// Skills/Movement.cs, Evaluators/MovementEvaluator.cs and the StrainSkill / StrainDecaySkill / DifficultyHitObject bases.

import { f32 } from '../../../framework/math';
import type { BeatmapDifficulty } from '../../beatmaps/Difficulty';
import { calculateCatchWidth } from './CatcherLogic';
import { Banana, getPalpableObjects, TinyDroplet, type CatchHitObject, type PalpableCatchHitObject } from './objects';

const DIFFICULTY_MULTIPLIER = 4.59;

export const NORMALIZED_HALF_CATCHER_WIDTH = 41.0;
const ABSOLUTE_PLAYER_POSITIONING_ERROR = 16.0;

export class CatchDifficultyHitObject {
  readonly deltaTime: number;
  readonly startTime: number;
  readonly normalizedPosition: number;
  readonly lastNormalizedPosition: number;
  playerPosition = 0;
  lastPlayerPosition = 0;
  distanceMoved = 0;
  exactDistanceMoved = 0;
  readonly strainTime: number;

  constructor(
    readonly baseObject: PalpableCatchHitObject,
    readonly lastObject: PalpableCatchHitObject,
    readonly clockRate: number,
    halfCatcherWidth: number,
    private readonly objects: CatchDifficultyHitObject[],
    readonly index: number,
  ) {
    this.deltaTime = (baseObject.startTime - lastObject.startTime) / clockRate;
    this.startTime = baseObject.startTime / clockRate;

    // We will scale everything by this factor, so we can assume a uniform CircleSize among beatmaps.
    const scalingFactor = f32(NORMALIZED_HALF_CATCHER_WIDTH / halfCatcherWidth);

    this.normalizedPosition = f32(baseObject.effectiveX * scalingFactor);
    this.lastNormalizedPosition = f32(lastObject.effectiveX * scalingFactor);

    // Every strain interval is hard capped at the equivalent of 375 BPM streaming speed as a safety measure
    this.strainTime = Math.max(40, this.deltaTime);

    this.setMovementState();
  }

  previous(skipCount = 0): CatchDifficultyHitObject | null {
    const i = this.index - (skipCount + 1);
    return i >= 0 && i < this.objects.length ? this.objects[i] : null;
  }

  private setMovementState(): void {
    this.lastPlayerPosition = this.index === 0 ? this.lastNormalizedPosition : this.previous(0)!.playerPosition;

    const min = f32(this.normalizedPosition - (NORMALIZED_HALF_CATCHER_WIDTH - ABSOLUTE_PLAYER_POSITIONING_ERROR));
    const max = f32(this.normalizedPosition + (NORMALIZED_HALF_CATCHER_WIDTH - ABSOLUTE_PLAYER_POSITIONING_ERROR));
    this.playerPosition = this.lastPlayerPosition < min ? min : this.lastPlayerPosition > max ? max : this.lastPlayerPosition;

    this.distanceMoved = f32(this.playerPosition - this.lastPlayerPosition);

    // For the exact position we consider that the catcher is in the correct position for both objects
    this.exactDistanceMoved = f32(this.normalizedPosition - this.lastPlayerPosition);

    // After a hyperdash we ARE in the correct position. Always!
    if (this.lastObject.hyperDash) this.playerPosition = this.normalizedPosition;
  }
}

const DIRECTION_CHANGE_BONUS = 21.0;

/** MovementEvaluator.EvaluateDifficultyOf */
export function evaluateMovement(current: CatchDifficultyHitObject): number {
  const catchLast = current.previous(0);
  const catchLastLast = current.previous(1);

  // In catch, clockrate adjustments do not only affect the timings of hitobjects,
  // but also the speed of the player's catcher, which has an impact on difficulty
  const catcherSpeedMultiplier = current.clockRate;

  const weightedStrainTime = current.strainTime + 13 + 3 / catcherSpeedMultiplier;

  let distanceAddition = Math.pow(Math.abs(current.distanceMoved), 1.3) / 510;
  const sqrtStrain = Math.sqrt(weightedStrainTime);

  let edgeDashBonus = 0;

  // Direction change bonus.
  if (Math.abs(current.distanceMoved) > 0.1) {
    if (current.index >= 1 && catchLast && Math.abs(catchLast.distanceMoved) > 0.1 && Math.sign(current.distanceMoved) !== Math.sign(catchLast.distanceMoved)) {
      const bonusFactor = Math.min(50, Math.abs(current.distanceMoved)) / 50;
      const antiflowFactor = Math.max(Math.min(70, Math.abs(catchLast.distanceMoved)) / 70, 0.38);
      const w = weightedStrainTime / 1000;

      distanceAddition += (DIRECTION_CHANGE_BONUS / Math.sqrt(catchLast.strainTime + 16)) * bonusFactor * antiflowFactor * Math.max(1 - w * w * w, 0);
    }

    // Base bonus for every movement, giving some weight to streams.
    distanceAddition += (12.5 * Math.min(Math.abs(current.distanceMoved), NORMALIZED_HALF_CATCHER_WIDTH * 2)) / (NORMALIZED_HALF_CATCHER_WIDTH * 6) / sqrtStrain;
  }

  // Linear spacing nerf.
  let linearSpacingCount = 0;

  for (let i = 0; i < Math.min(current.index, 10); i++) {
    const catchPrevObj = current.previous(i)!;

    // Only same direction movements matter as they do not take any additional inputs.
    if (Math.sign(current.distanceMoved) !== Math.sign(catchPrevObj.distanceMoved) || current.distanceMoved === 0 || catchPrevObj.distanceMoved === 0) break;

    const currentSpacing = Math.abs(current.distanceMoved / current.strainTime);
    const prevSpacing = Math.abs(catchPrevObj.distanceMoved / catchPrevObj.strainTime);

    const relativeDifference = Math.abs(currentSpacing / prevSpacing - 1);

    if (relativeDifference > 0.05) break;

    linearSpacingCount++;
  }

  distanceAddition *= Math.pow(0.7, linearSpacingCount);

  // Bonus for edge dashes.
  if (current.lastObject.distanceToHyperDash <= 20.0) {
    if (!current.lastObject.hyperDash) edgeDashBonus += 5.7;

    distanceAddition *=
      1.0 + edgeDashBonus * ((20 - current.lastObject.distanceToHyperDash) / 20) * Math.pow(Math.min(current.strainTime * catcherSpeedMultiplier, 265) / 265, 1.5); // Edge Dashes are easier at lower ms values
  }

  // There is an edge case where horizontal back and forth sliders create "buzz" patterns which are repeated "movements" with a distance lower than
  // the platter's width but high enough to be considered a movement due to the absolute_player_positioning_error and NORMALIZED_HALF_CATCHER_WIDTH offsets
  // We are detecting this exact scenario. The first back and forth is counted but all subsequent ones are nullified.
  if (
    current.index >= 2 &&
    catchLast &&
    catchLastLast &&
    Math.abs(current.exactDistanceMoved) <= NORMALIZED_HALF_CATCHER_WIDTH * 2 &&
    current.exactDistanceMoved === -catchLast.exactDistanceMoved &&
    catchLast.exactDistanceMoved === -catchLastLast.exactDistanceMoved &&
    current.strainTime === catchLast.strainTime &&
    catchLast.strainTime === catchLastLast.strainTime
  )
    distanceAddition = 0;

  return distanceAddition / weightedStrainTime;
}

/** Skills/Movement (StrainDecaySkill + StrainSkill) */
export class MovementSkill {
  private static readonly SKILL_MULTIPLIER = 1;
  private static readonly STRAIN_DECAY_BASE = 0.2;
  private static readonly DECAY_WEIGHT = 0.94;
  private static readonly SECTION_LENGTH = 750;

  private currentStrain = 0;
  private currentSectionPeak = 0;
  private currentSectionEnd = 0;
  private readonly strainPeaks: number[] = [];
  readonly objectDifficulties: number[] = [];

  private strainDecay(ms: number): number {
    return Math.pow(MovementSkill.STRAIN_DECAY_BASE, ms / 1000);
  }

  process(current: CatchDifficultyHitObject): void {
    const sectionLength = MovementSkill.SECTION_LENGTH;
    // The first object doesn't generate a strain, so we begin with an incremented section end
    if (current.index === 0) this.currentSectionEnd = Math.ceil(current.startTime / sectionLength) * sectionLength;

    while (current.startTime > this.currentSectionEnd) {
      this.strainPeaks.push(this.currentSectionPeak);
      // startNewSectionFrom: the maximum strain of the new section is not zero by default
      this.currentSectionPeak = this.currentStrain * this.strainDecay(this.currentSectionEnd - current.previous(0)!.startTime);
      this.currentSectionEnd += sectionLength;
    }

    // StrainDecaySkill.StrainValueAt
    this.currentStrain *= this.strainDecay(current.deltaTime);
    this.currentStrain += evaluateMovement(current) * MovementSkill.SKILL_MULTIPLIER;

    this.currentSectionPeak = Math.max(this.currentStrain, this.currentSectionPeak);
    this.objectDifficulties.push(this.currentStrain);
  }

  difficultyValue(): number {
    let difficulty = 0;
    let weight = 1;

    // Sections with 0 strain are excluded to avoid worst-case time complexity of the following sort (e.g. /b/2351871).
    const peaks = [...this.strainPeaks, this.currentSectionPeak].filter(p => p > 0).sort((a, b) => b - a);

    // Difficulty is the weighted sum of the highest strains from every section.
    for (const strain of peaks) {
      difficulty += strain * weight;
      weight *= MovementSkill.DECAY_WEIGHT;
    }

    return difficulty;
  }
}

/** CatchDifficultyCalculator.CreateDifficultyHitObjects */
export function createDifficultyHitObjects(hitObjects: readonly CatchHitObject[], difficulty: BeatmapDifficulty, clockRate: number): CatchDifficultyHitObject[] {
  let lastObject: PalpableCatchHitObject | null = null;
  const objects: CatchDifficultyHitObject[] = [];

  let halfCatcherWidth = f32(calculateCatchWidth(difficulty.circleSize) * 0.5);

  // For circle sizes above 5.5, reduce the catcher width further to simulate imperfect gameplay.
  halfCatcherWidth = f32(halfCatcherWidth * f32(1 - f32(Math.max(0, f32(difficulty.circleSize - 5.5)) * 0.0625)));

  // In 2B beatmaps, it is possible that a normal Fruit is placed in the middle of a JuiceStream.
  for (const hitObject of getPalpableObjects(hitObjects)) {
    // We want to only consider fruits that contribute to the combo.
    if (hitObject instanceof Banana || hitObject instanceof TinyDroplet) continue;

    if (lastObject != null) objects.push(new CatchDifficultyHitObject(hitObject, lastObject, clockRate, halfCatcherWidth, objects, objects.length));

    lastObject = hitObject;
  }

  // DifficultyCalculator.SortObjects (stable OrderBy start time) - already in order.
  return objects;
}

/** CatchDifficultyCalculator: star rating of a mod-applied catch beatmap. */
export function calculateCatchStarRating(hitObjects: readonly CatchHitObject[], difficulty: BeatmapDifficulty, clockRate: number): number {
  if (hitObjects.length === 0) return 0;

  const movement = new MovementSkill();
  for (const h of createDifficultyHitObjects(hitObjects, difficulty, clockRate)) movement.process(h);

  return Math.sqrt(movement.difficultyValue()) * DIFFICULTY_MULTIPLIER;
}
