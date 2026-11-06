// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game.Rulesets.Osu/Difficulty/Evaluators/{Aim/SnapAimEvaluator,Aim/AgilityEvaluator,Aim/FlowAimEvaluator,
// Speed/SpeedEvaluator,Speed/RhythmEvaluator,ReadingEvaluator,FlashlightEvaluator}.cs

import type { ModSet } from '../../../mods/Mods';
import { MIN_DELTA_TIME, NORMALISED_DIAMETER, NORMALISED_RADIUS, OsuDifficultyHitObject } from './preprocessing';
import {
  bpmToMilliseconds,
  clamp,
  degToRad,
  doubleLerp,
  logistic,
  millisecondsToBpm,
  norm,
  pow,
  pow2,
  pow3,
  pow4,
  reverseLerp,
  smootherstep,
  smoothstep,
  smoothstepBellCurve,
  vLength,
  vSub,
} from './utils';

// ============================================================================================
// SnapAimEvaluator
// ============================================================================================

export const calcAngleAcuteness = (angle: number): number => smoothstep(angle, degToRad(140), degToRad(40));
const calcAngleWideness = (angle: number): number => smoothstep(angle, degToRad(40), degToRad(140));

export function evaluateSnapAim(current: OsuDifficultyHitObject, withSliderTravelDistance: boolean): number {
  const osuCurrObj = current;
  if (current.baseObject.kind === 'spinner' || current.index <= 1) return 0;
  const osuLastObj = current.previous(0)!;
  if (osuLastObj.baseObject.kind === 'spinner') return 0;

  const wide_angle_multiplier = 9.67;
  const acute_angle_multiplier = 2.41;
  const slider_multiplier = 1.5;
  const velocity_change_multiplier = 0.9;
  // WARNING: Increasing this multiplier beyond 1.02 reduces difficulty as distance increases.
  const wiggle_multiplier = 1.02;

  const osuLast2Obj = current.previous(2);

  const radius = NORMALISED_RADIUS;
  const diameter = NORMALISED_DIAMETER;

  // Calculate the velocity to the current hitobject, which starts with a base distance / time assuming the last object is a hitcircle.
  const currDistance = withSliderTravelDistance ? osuCurrObj.lazyJumpDistance : osuCurrObj.jumpDistance;
  let currVelocity = currDistance / osuCurrObj.adjustedDeltaTime;

  // But if the last object is a slider, then we extend the travel velocity through the slider into the current object.
  if (osuLastObj.baseObject.kind === 'slider' && withSliderTravelDistance) {
    const sliderDistance = osuLastObj.lazyTravelDistance + osuCurrObj.lazyJumpDistance;
    currVelocity = Math.max(currVelocity, sliderDistance / osuCurrObj.adjustedDeltaTime);
  }

  const prevDistance = withSliderTravelDistance ? osuLastObj.lazyJumpDistance : osuLastObj.jumpDistance;
  const prevVelocity = prevDistance / osuLastObj.adjustedDeltaTime;

  let snapDifficulty = currVelocity; // Start difficulty with regular velocity.

  // Penalize angle repetition.
  snapDifficulty *= vectorAngleRepetition(osuCurrObj, osuLastObj);

  if (osuCurrObj.angle != null && osuLastObj.angle != null) {
    const currAngle = osuCurrObj.angle;
    const lastAngle = osuLastObj.angle;

    // Rewarding angles, take the smaller velocity as base.
    const velocityInfluence = Math.min(currVelocity, prevVelocity);

    let acuteAngleBonus = 0;

    if (Math.max(osuCurrObj.adjustedDeltaTime, osuLastObj.adjustedDeltaTime) < 1.25 * Math.min(osuCurrObj.adjustedDeltaTime, osuLastObj.adjustedDeltaTime)) {
      // If rhythms are the same.
      acuteAngleBonus = calcAngleAcuteness(currAngle);

      // Penalize angle repetition. It is important to do it _before_ multiplying by anything because we compare raw acuteness here
      acuteAngleBonus *= 0.08 + 0.92 * (1 - Math.min(acuteAngleBonus, pow3(calcAngleAcuteness(lastAngle))));

      // Apply acute angle bonus for BPM above 300 1/2 and distance more than one diameter
      acuteAngleBonus *=
        velocityInfluence * smootherstep(millisecondsToBpm(osuCurrObj.adjustedDeltaTime, 2), 300, 400) * smootherstep(currDistance, 0, diameter * 2);
    }

    let wideAngleBonus = calcAngleWideness(currAngle);

    // Penalize angle repetition. It is important to do it _before_ multiplying by velocity because we compare raw wideness here
    wideAngleBonus *= 0.25 + 0.75 * (1 - Math.min(wideAngleBonus, pow3(calcAngleWideness(lastAngle))));

    // Rescaling velocity for the wide angle bonus
    const wide_angle_time_scale = 1.45;
    let wideAngleCurrVelocity = currDistance / pow(osuCurrObj.adjustedDeltaTime, wide_angle_time_scale);
    const wideAnglePrevVelocity = prevDistance / pow(osuLastObj.adjustedDeltaTime, wide_angle_time_scale);

    if (osuLastObj.baseObject.kind === 'slider' && withSliderTravelDistance) {
      const sliderDistance = osuLastObj.lazyTravelDistance + osuCurrObj.lazyJumpDistance;
      wideAngleCurrVelocity = Math.max(wideAngleCurrVelocity, sliderDistance / pow(osuCurrObj.adjustedDeltaTime, wide_angle_time_scale));
    }

    wideAngleBonus *= Math.min(wideAngleCurrVelocity, wideAnglePrevVelocity);

    if (osuLast2Obj != null) {
      // If objects just go back and forth through a middle point - don't give as much wide bonus
      const distance = vLength(vSub(osuLast2Obj.baseObject.stackedPosition, osuLastObj.baseObject.stackedPosition));
      if (distance < 1) wideAngleBonus *= 1 - 0.55 * (1 - distance);
    }

    // Add in acute angle bonus or wide angle bonus, whichever is larger.
    snapDifficulty += Math.max(acuteAngleBonus * acute_angle_multiplier, wideAngleBonus * wide_angle_multiplier);

    // Apply wiggle bonus for jumps that are [radius, 3*diameter] in distance, with < 110 angle
    const wiggleBonus =
      velocityInfluence *
      smootherstep(currDistance, radius, diameter) *
      pow(reverseLerp(currDistance, diameter * 3, diameter), 1.8) *
      smootherstep(currAngle, degToRad(110), degToRad(60)) *
      smootherstep(prevDistance, radius, diameter) *
      pow(reverseLerp(prevDistance, diameter * 3, diameter), 1.8) *
      smootherstep(lastAngle, degToRad(110), degToRad(60));

    snapDifficulty += wiggleBonus * wiggle_multiplier;
  }

  if (Math.max(prevVelocity, currVelocity) !== 0) {
    if (withSliderTravelDistance) {
      // We want to use just the object jump without slider velocity when awarding differences
      currVelocity = currDistance / osuCurrObj.adjustedDeltaTime;
    }

    // Scale with ratio of difference compared to 0.5 * max dist.
    const distRatio = smoothstep(Math.abs(prevVelocity - currVelocity) / Math.max(prevVelocity, currVelocity), 0, 1);

    // Reward for % distance up to 125 / strainTime for overlaps where velocity is still changing.
    const overlapVelocityBuff = Math.min(
      (diameter * 1.25) / Math.min(osuCurrObj.adjustedDeltaTime, osuLastObj.adjustedDeltaTime),
      Math.abs(prevVelocity - currVelocity),
    );

    let velocityChangeBonus = overlapVelocityBuff * distRatio;

    // Penalize for rhythm changes.
    velocityChangeBonus *= pow2(
      Math.min(osuCurrObj.adjustedDeltaTime, osuLastObj.adjustedDeltaTime) / Math.max(osuCurrObj.adjustedDeltaTime, osuLastObj.adjustedDeltaTime),
    );

    snapDifficulty += velocityChangeBonus * velocity_change_multiplier;
  }

  // Reward sliders based on velocity.
  if (osuCurrObj.baseObject.kind === 'slider' && withSliderTravelDistance) {
    const sliderBonus = osuCurrObj.travelDistance / osuCurrObj.travelTime;
    snapDifficulty += (sliderBonus < 1 ? sliderBonus : pow(sliderBonus, 0.75)) * slider_multiplier;
  }

  // Apply high circle size bonus
  snapDifficulty *= osuCurrObj.smallCircleBonus;

  snapDifficulty *= snapHighBpmBonus(osuCurrObj.adjustedDeltaTime);

  return snapDifficulty;
}

const snapHighBpmBonus = (ms: number): number => 1 / (1 - pow(0.03, pow(ms / 1000, 0.65)));

function vectorAngleRepetition(current: OsuDifficultyHitObject, previous: OsuDifficultyHitObject): number {
  if (current.angle == null || previous.angle == null) return 1;

  const note_limit = 6;
  const maximum_repetition_nerf = 0.15;
  const maximum_vector_influence = 0.5;

  let constantAngleCount = 0;

  for (let index = 0; index < note_limit; index++) {
    const prevObj = current.previous(index);
    if (prevObj == null) break;

    // Only consider vectors in the same jump section, stopping to change rhythm ruins momentum
    if (Math.max(current.adjustedDeltaTime, prevObj.adjustedDeltaTime) > 1.1 * Math.min(current.adjustedDeltaTime, prevObj.adjustedDeltaTime)) break;

    if (prevObj.normalisedVectorAngle != null && current.normalisedVectorAngle != null) {
      const angleDifference = Math.abs(current.normalisedVectorAngle - prevObj.normalisedVectorAngle);
      constantAngleCount += Math.cos(8 * Math.min(degToRad(11.25), angleDifference));
    }
  }

  const vectorRepetition = pow2(Math.min(0.5 / constantAngleCount, 1));

  const stackFactor = smootherstep(current.lazyJumpDistance, 0, NORMALISED_DIAMETER);

  const currAngle = current.angle;
  const lastAngle = previous.angle;

  const angleDifferenceAdjusted = Math.cos(2 * Math.min(degToRad(45), Math.abs(currAngle - lastAngle) * stackFactor));

  const baseNerf = 1 - maximum_repetition_nerf * calcAngleAcuteness(lastAngle) * angleDifferenceAdjusted;

  return pow2(baseNerf + (1 - baseNerf) * vectorRepetition * maximum_vector_influence * stackFactor);
}

// ============================================================================================
// AgilityEvaluator
// ============================================================================================

export function evaluateAgility(current: OsuDifficultyHitObject): number {
  if (current.baseObject.kind === 'spinner') return 0;

  const distance_cap = NORMALISED_DIAMETER * 1.2; // 1.2 circles distance between centers

  const osuCurrObj = current;
  const osuPrevObj = current.index > 0 ? current.previous(0) : null;

  const travelDistance = osuPrevObj?.lazyTravelDistance ?? 0;
  const distance = travelDistance + osuCurrObj.lazyJumpDistance;

  const distanceScaled = Math.min(distance, distance_cap) / distance_cap;

  let agilityDifficulty = (distanceScaled * 1000) / osuCurrObj.adjustedDeltaTime;
  agilityDifficulty *= pow(osuCurrObj.smallCircleBonus, 1.5);
  agilityDifficulty *= 1 / (1 - pow(0.2, osuCurrObj.adjustedDeltaTime / 1000));

  return agilityDifficulty;
}

// ============================================================================================
// FlowAimEvaluator
// ============================================================================================

export function evaluateFlowAim(current: OsuDifficultyHitObject, withSliderTravelDistance: boolean): number {
  const osuCurrObj = current;
  if (current.baseObject.kind === 'spinner' || current.index <= 1) return 0;
  const osuLastObj = current.previous(0)!;
  if (osuLastObj.baseObject.kind === 'spinner') return 0;

  const velocity_change_multiplier = 0.52;

  const osuLastLastObj = current.previous(1)!;

  const currDistance = withSliderTravelDistance ? osuCurrObj.lazyJumpDistance : osuCurrObj.jumpDistance;
  const prevDistance = withSliderTravelDistance ? osuLastObj.lazyJumpDistance : osuLastObj.jumpDistance;

  let currVelocity = currDistance / osuCurrObj.adjustedDeltaTime;

  if (osuLastObj.baseObject.kind === 'slider' && withSliderTravelDistance) {
    // If the last object is a slider, then we extend the travel velocity through the slider into the current object.
    const sliderDistance = osuLastObj.lazyTravelDistance + osuCurrObj.lazyJumpDistance;
    currVelocity = Math.max(currVelocity, sliderDistance / osuCurrObj.adjustedDeltaTime);
  }

  const prevVelocity = prevDistance / osuLastObj.adjustedDeltaTime;

  let flowDifficulty = currVelocity;

  // Apply high circle size bonus to the base velocity.
  flowDifficulty *= Math.sqrt(osuCurrObj.smallCircleBonus);

  // Rhythm changes are harder to flow
  flowDifficulty *=
    1 +
    Math.min(
      0.25,
      pow4(
        (Math.max(osuCurrObj.adjustedDeltaTime, osuLastObj.adjustedDeltaTime) - Math.min(osuCurrObj.adjustedDeltaTime, osuLastObj.adjustedDeltaTime)) / 50,
      ),
    );

  if (osuCurrObj.angle != null && osuLastObj.angle != null) {
    const angleDifference = Math.abs(osuCurrObj.angle - osuLastObj.angle);
    const angleDifferenceAdjusted = Math.sin(angleDifference / 2) * 180.0;
    const angularVelocity = angleDifferenceAdjusted / (osuCurrObj.adjustedDeltaTime * 0.1);

    // Low angular velocity flow (angles are consistent) is easier to follow than erratic flow
    flowDifficulty *= 0.8 + Math.sqrt(angularVelocity / 270.0);
  }

  // If all three notes are overlapping - don't reward bonuses as you don't have to do additional movement
  let overlappedNotesWeight = 1;

  if (current.index > 2) {
    const o1 = calculateOverlapFactor(osuCurrObj, osuLastObj);
    const o2 = calculateOverlapFactor(osuCurrObj, osuLastLastObj);
    const o3 = calculateOverlapFactor(osuLastObj, osuLastLastObj);
    overlappedNotesWeight = 1 - o1 * o2 * o3;
  }

  if (osuCurrObj.angle != null) {
    // Acute angles are also hard to flow
    flowDifficulty += currVelocity * calcAngleAcuteness(osuCurrObj.angle) * overlappedNotesWeight;
  }

  if (Math.max(prevVelocity, currVelocity) !== 0) {
    if (withSliderTravelDistance) currVelocity = currDistance / osuCurrObj.adjustedDeltaTime;

    // Scale with ratio of difference compared to 0.5 * max dist.
    const distRatio = smoothstep(Math.abs(prevVelocity - currVelocity) / Math.max(prevVelocity, currVelocity), 0, 1);

    // Reward for % distance up to 125 / strainTime for overlaps where velocity is still changing.
    const overlapVelocityBuff = Math.min(
      (NORMALISED_DIAMETER * 1.25) / Math.min(osuCurrObj.adjustedDeltaTime, osuLastObj.adjustedDeltaTime),
      Math.abs(prevVelocity - currVelocity),
    );

    flowDifficulty += overlapVelocityBuff * distRatio * overlappedNotesWeight * velocity_change_multiplier;
  }

  if (osuCurrObj.baseObject.kind === 'slider' && withSliderTravelDistance) {
    // Include slider velocity to make velocity more consistent with snap
    flowDifficulty += osuCurrObj.travelDistance / osuCurrObj.travelTime;
  }

  // Final velocity is being raised to a power because flow difficulty scales harder with both high distance and time
  flowDifficulty = pow(flowDifficulty, 1.45);

  // Reduce difficulty for low spacing since spacing below radius is always to be flowed
  return flowDifficulty * smootherstep(currDistance, 0, NORMALISED_RADIUS);
}

function calculateOverlapFactor(first: OsuDifficultyHitObject, second: OsuDifficultyHitObject): number {
  const objectRadius = first.baseObject.radius;
  const distance = vLength(vSub(second.baseObject.stackedPosition, first.baseObject.stackedPosition));
  return clamp(1 - pow2(Math.max(distance - objectRadius, 0) / objectRadius), 0, 1);
}

// ============================================================================================
// SpeedEvaluator
// ============================================================================================

export function evaluateSpeed(current: OsuDifficultyHitObject): number {
  if (current.baseObject.kind === 'spinner') return 0;

  const min_speed_bonus = 200; // 200 BPM 1/4th
  const speed_balancing_factor = 40;

  const osuCurrObj = current;

  let strainTime = osuCurrObj.adjustedDeltaTime;
  const doubleTapFeasibility = 1.0 - osuCurrObj.calculateDoubleTapFeasibility(osuCurrObj.next(0));

  // Cap deltatime to the OD 300 hitwindow.
  strainTime /= clamp(strainTime / osuCurrObj.hitWindowGreat / 0.93, 0.92, 1);

  // speedBonus will be 0.0 for BPM < 200
  let speedBonus = 0.0;

  // Add additional scaling bonus for streams/bursts higher than 200bpm
  if (millisecondsToBpm(strainTime) > min_speed_bonus) speedBonus = 0.75 * pow2((bpmToMilliseconds(min_speed_bonus) - strainTime) / speed_balancing_factor);

  // Base difficulty with all bonuses
  let speedDifficulty = ((1 + speedBonus) * 1000) / strainTime;

  speedDifficulty *= 1 / (1 - pow(0.3, osuCurrObj.adjustedDeltaTime / 1000));

  // Apply penalty if there's doubletappable doubles
  return speedDifficulty * doubleTapFeasibility;
}

// ============================================================================================
// RhythmEvaluator
// ============================================================================================

const INT_MAX = 2147483647;

/** C# (int) cast of a double (truncation, saturating for out-of-range values as .NET 9+ does). */
function toInt(x: number): number {
  if (Number.isNaN(x)) return 0;
  if (x >= INT_MAX) return INT_MAX;
  if (x <= -2147483648) return -2147483648;
  return Math.trunc(x);
}

/** An island is a group of consecutive objects with the same delta time. */
class Island {
  delta: number;
  deltaCount = 1;
  occurrences = 1;

  constructor(delta: number) {
    this.delta = Math.max(delta, MIN_DELTA_TIME);
  }

  addDelta(delta: number): void {
    if (this.delta === INT_MAX) this.delta = Math.max(delta, MIN_DELTA_TIME);
    this.deltaCount++;
  }

  isSimilarPolarity(other: Island, epsilon: number): boolean {
    // single delta islands shouldn't be compared
    if (this.deltaCount <= 1 || other.deltaCount <= 1) return false;
    return Math.abs(this.delta - other.delta) < epsilon && this.deltaCount % 2 === other.deltaCount % 2;
  }

  almostEquals(other: Island, epsilon: number): boolean {
    return Math.abs(this.delta - other.delta) < epsilon && this.deltaCount === other.deltaCount;
  }
}

function getEffectiveDifficulty(deltaDifferenceRatio: number): number {
  const rhythm_ratio_difficulty_multiplier = 26.0;
  // Take only the fractional part of the value since we're only interested in punishing multiples
  const deltaDifferenceFraction = deltaDifferenceRatio - Math.trunc(deltaDifferenceRatio);
  return 1.0 + rhythm_ratio_difficulty_multiplier * Math.min(0.5, smoothstepBellCurve(deltaDifferenceFraction));
}

/** Calculates a rhythm multiplier for the difficulty of the tap associated with historic data of the current object. */
export function evaluateRhythm(current: OsuDifficultyHitObject): number {
  if (current.baseObject.kind === 'spinner') return 0;

  const history_time_max = 5 * 1000; // 5 seconds
  const history_objects_max = 32;
  const rhythm_overall_multiplier = 0.95;

  let rhythmComplexitySum = 0;

  const deltaDifferenceEpsilon = current.hitWindowGreat * 0.3;

  let island = new Island(INT_MAX);
  let previousIsland = new Island(INT_MAX);

  const islands: Island[] = [];

  let startDifficulty = 0; // store the difficulty of the current start of an island to buff for tighter rhythms

  let firstDeltaSwitch = false;

  const historicalNoteCount = Math.min(current.index, history_objects_max);

  let rhythmStart = 0;

  while (rhythmStart < historicalNoteCount - 2 && current.startTime - current.previous(rhythmStart)!.startTime < history_time_max) rhythmStart++;

  let prevObj = current.previous(rhythmStart)!;
  let prevPrevObj = current.previous(rhythmStart + 1)!;

  // we go from the furthest object back to the current one
  for (let i = rhythmStart; i > 0; i--) {
    const currObj = current.previous(i - 1)!;

    if (currObj.baseObject.kind === 'spinner') continue;

    // scales note 0 to 1 from history to now
    const timeDecay = (history_time_max - (current.startTime - currObj.startTime)) / history_time_max;
    const noteDecay = (historicalNoteCount - i) / historicalNoteCount;

    const currHistoricalDecay = Math.min(noteDecay, timeDecay); // either we're limited by time or limited by object count.

    // Use custom cap value to ensure that at this point delta time is actually zero
    const delta_min_value = 1e-7;

    const currDelta = Math.max(currObj.deltaTime, delta_min_value);
    const prevDelta = Math.max(prevObj.deltaTime, delta_min_value);

    const deltaDifference = Math.abs(prevDelta - currDelta);

    // Make sure to always have the current island initialised
    if (island.delta === INT_MAX) island = new Island(toInt(currDelta));

    // calculate how much current delta difference deserves a rhythm bonus
    const deltaDifferenceRatio = Math.max(prevDelta, currDelta) / Math.min(prevDelta, currDelta);

    // reduce ratio bonus if delta difference is too big
    const differenceMultiplier = clamp(2.0 - deltaDifferenceRatio / 8.0, 0.0, 1.0);

    const windowPenalty = clamp((deltaDifference - deltaDifferenceEpsilon) / deltaDifferenceEpsilon, 0, 1);

    let effectiveDifficulty = getEffectiveDifficulty(deltaDifferenceRatio) * windowPenalty * differenceMultiplier;

    // if previous object is a slider it might be easier to tap since you don't have to do a whole tapping motion
    if (prevObj.baseObject.kind === 'slider') {
      const sliderLazyEndDelta = currObj.minimumJumpTime;
      const sliderLazyDeltaDifferenceRatio = Math.max(sliderLazyEndDelta, currDelta) / Math.min(sliderLazyEndDelta, currDelta);

      const sliderRealEndDelta = currObj.lastObjectEndDeltaTime;
      const sliderRealDeltaDifferenceRatio = Math.max(sliderRealEndDelta, currDelta) / Math.min(sliderRealEndDelta, currDelta);

      const sliderEffectiveDifficulty = Math.min(getEffectiveDifficulty(sliderLazyDeltaDifferenceRatio), getEffectiveDifficulty(sliderRealDeltaDifferenceRatio));
      effectiveDifficulty = Math.min(sliderEffectiveDifficulty, effectiveDifficulty);
    }

    if (deltaDifference < deltaDifferenceEpsilon) {
      // island is still progressing
      island.addDelta(toInt(currDelta));
    }

    if (firstDeltaSwitch) {
      if (deltaDifference > deltaDifferenceEpsilon) {
        // bpm change is into slider, this is easy acc window
        if (currObj.baseObject.kind === 'slider') effectiveDifficulty *= 0.5;

        // repeated island polarity (2 -> 4, 3 -> 5)
        if (island.isSimilarPolarity(previousIsland, deltaDifferenceEpsilon)) effectiveDifficulty *= 0.5;

        // previous increase happened a note ago, 1/1->1/2-1/4, dont want to buff this.
        if (Math.max(prevPrevObj.deltaTime, delta_min_value) > prevDelta + deltaDifferenceEpsilon && prevDelta > currDelta + deltaDifferenceEpsilon)
          effectiveDifficulty *= 0.125;

        // repeated island size (ex: triplet -> triplet)
        if (previousIsland.deltaCount === island.deltaCount) effectiveDifficulty *= 0.5;

        const isSpeedingUp = prevDelta > currDelta + deltaDifferenceEpsilon;
        if (isSpeedingUp) effectiveDifficulty *= 0.65;

        let found = false;

        for (const existingIsland of islands) {
          if (existingIsland.almostEquals(island, deltaDifferenceEpsilon)) {
            // only increase island occurrences if they're going one after another
            if (previousIsland.almostEquals(island, deltaDifferenceEpsilon)) existingIsland.occurrences++;

            // repeated island (ex: triplet -> triplet)
            const power = logistic(island.delta, 58.33, 0.24, 2.75);
            effectiveDifficulty *= Math.min(3.0 / existingIsland.occurrences, pow(1.0 / existingIsland.occurrences, power));

            found = true;
            break;
          }
        }

        if (!found && island.deltaCount > 0) islands.push(island);

        // scale down the difficulty if the object is double-tappable
        effectiveDifficulty *= 1 - prevObj.calculateDoubleTapFeasibility(currObj) * 0.75;

        if (island.deltaCount > 1) rhythmComplexitySum += Math.sqrt(effectiveDifficulty * startDifficulty) * currHistoricalDecay;
        // constant difficulty for single-note islands
        else rhythmComplexitySum += 0.7 * currHistoricalDecay;

        startDifficulty = effectiveDifficulty;

        if (prevDelta + deltaDifferenceEpsilon < currDelta) firstDeltaSwitch = false; // we're slowing down, stop counting

        previousIsland = island;
        island = new Island(toInt(currDelta));
      }
    } else if (prevDelta > currDelta + deltaDifferenceEpsilon) {
      // we're speeding up. Begin counting island until we change speed again.
      firstDeltaSwitch = true;

      // bpm change is into slider, this is easy acc window
      if (currObj.baseObject.kind === 'slider') effectiveDifficulty *= 0.6;

      // bpm change was from a slider, this is easier typically than circle -> circle
      if (prevObj.baseObject.kind === 'slider') effectiveDifficulty *= 0.6;

      startDifficulty = effectiveDifficulty;

      island = new Island(toInt(currDelta));
    }

    prevPrevObj = prevObj;
    prevObj = currObj;
  }

  // If the current island is long we don't want the sum to have as big of an effect
  rhythmComplexitySum *= reverseLerp(island.deltaCount, 22, 3);

  return Math.sqrt(4 + rhythmComplexitySum * rhythm_overall_multiplier) / 2.0;
}

// ============================================================================================
// ReadingEvaluator
// ============================================================================================

const reading_window_size = 3000; // 3 seconds
const distance_influence_threshold = NORMALISED_DIAMETER * 1.5; // 1.5 circles distance between centers

export function evaluateReading(current: OsuDifficultyHitObject, hidden: boolean): number {
  if (current.baseObject.kind === 'spinner' || current.index === 0) return 0;

  const currObj = current;
  const nextObj = current.next(0);

  const velocity = Math.max(1, currObj.lazyJumpDistance / currObj.adjustedDeltaTime); // Only allow velocity to buff

  const currentVisibleObjectDensity = retrieveCurrentVisibleObjectDensity(currObj);
  const pastObjectDifficultyInfluence = getPastObjectDifficultyInfluence(currObj);

  const constantAngleNerfFactor = getConstantAngleNerfFactor(currObj);

  const noteDensityDifficulty = calculateDensityDifficulty(nextObj, velocity, constantAngleNerfFactor, pastObjectDifficultyInfluence, currentVisibleObjectDensity);

  const hiddenDifficulty = hidden ? calculateHiddenDifficulty(currObj, pastObjectDifficultyInfluence, currentVisibleObjectDensity, velocity, constantAngleNerfFactor) : 0;

  const preemptDifficulty = calculatePreemptDifficulty(velocity, constantAngleNerfFactor, currObj.preempt);

  let readingDifficulty = norm(1.5, preemptDifficulty, hiddenDifficulty, noteDensityDifficulty);

  // Having less time to process information is harder
  readingDifficulty *= 1 / (1 - pow(0.8, currObj.adjustedDeltaTime / 1000));

  return readingDifficulty;
}

function calculateDensityDifficulty(
  nextObj: OsuDifficultyHitObject | null,
  velocity: number,
  constantAngleNerfFactor: number,
  pastObjectDifficultyInfluence: number,
  currentVisibleObjectDensity: number,
): number {
  const density_multiplier = 2.4;
  const density_difficulty_base = 2.5;

  // Consider future densities too because it can make the path the cursor takes less clear
  let futureObjectDifficultyInfluence = Math.sqrt(currentVisibleObjectDensity);

  // Reduce difficulty if movement to next object is small
  if (nextObj != null) futureObjectDifficultyInfluence *= smootherstep(nextObj.lazyJumpDistance, 15, distance_influence_threshold);

  // Value higher note densities exponentially
  let noteDensityDifficulty = pow(pastObjectDifficultyInfluence + futureObjectDifficultyInfluence, 1.7) * 0.4 * constantAngleNerfFactor * velocity;

  // Award only denser than average maps.
  noteDensityDifficulty = Math.max(0, noteDensityDifficulty - density_difficulty_base);

  // Apply a soft cap to general density reading to account for partial memorization
  noteDensityDifficulty = pow(noteDensityDifficulty, 0.45) * density_multiplier;

  return noteDensityDifficulty;
}

function calculatePreemptDifficulty(velocity: number, constantAngleNerfFactor: number, preempt: number): number {
  const preempt_balancing_factor = 140000;
  const preempt_starting_point = 500; // AR 9.66 in milliseconds

  let preemptDifficulty = pow((preempt_starting_point - preempt + Math.abs(preempt - preempt_starting_point)) / 2, 2.5) / preempt_balancing_factor;
  preemptDifficulty *= constantAngleNerfFactor * velocity;
  return preemptDifficulty;
}

function calculateHiddenDifficulty(
  currObj: OsuDifficultyHitObject,
  pastObjectDifficultyInfluence: number,
  currentVisibleObjectDensity: number,
  velocity: number,
  constantAngleNerfFactor: number,
): number {
  const hidden_multiplier = 0.28;

  // Higher preempt means that time spent invisible is higher too, we want to reward that
  const preemptFactor = pow(currObj.preempt, 2.2) * 0.01;

  // Account for both past and current densities
  const densityFactor = pow(currentVisibleObjectDensity + pastObjectDifficultyInfluence, 3.3) * 3;

  let hiddenDifficulty = (preemptFactor + densityFactor) * constantAngleNerfFactor * velocity * 0.01;

  // Apply a soft cap to general HD reading to account for partial memorization
  hiddenDifficulty = pow(hiddenDifficulty, 0.4) * hidden_multiplier;

  const previousObj = currObj.previous(0)!;

  // Buff perfect stacks only if current note is completely invisible at the time you click the previous note.
  if (
    currObj.lazyJumpDistance === 0 &&
    currObj.opacityAt(previousObj.baseObject.startTime, true) === 0 &&
    previousObj.startTime > currObj.startTime - currObj.preempt
  )
    hiddenDifficulty += (hidden_multiplier * 2500) / pow(currObj.adjustedDeltaTime, 1.5); // Perfect stacks are harder the less time between notes

  return hiddenDifficulty;
}

function getPastObjectDifficultyInfluence(currObj: OsuDifficultyHitObject): number {
  let pastObjectDifficultyInfluence = 0;

  // Objects that are visible on screen at the point in time the current object becomes visible.
  for (let i = 0; i < currObj.index; i++) {
    const loopObj = currObj.previous(i);
    if (loopObj == null || currObj.startTime - loopObj.startTime > reading_window_size || loopObj.startTime < currObj.startTime - currObj.preempt) break;

    let loopDifficulty = currObj.opacityAt(loopObj.baseObject.startTime, false);

    // When aiming an object small distances mean previous objects may be cheesed, so it doesn't matter whether they were arranged confusingly.
    loopDifficulty *= smootherstep(loopObj.lazyJumpDistance, 15, distance_influence_threshold);

    // Account less for objects close to the max reading window
    loopDifficulty *= getTimeNerfFactor(currObj.startTime - loopObj.startTime);
    pastObjectDifficultyInfluence += loopDifficulty;
  }

  return pastObjectDifficultyInfluence;
}

function retrieveCurrentVisibleObjectDensity(current: OsuDifficultyHitObject): number {
  let visibleObjectCount = 0;
  let hitObject = current.next(0);

  while (hitObject != null) {
    // Object not visible at the time current object needs to be clicked.
    if (hitObject.startTime - current.startTime > reading_window_size || current.startTime < hitObject.startTime - hitObject.preempt) break;

    const timeNerfFactor = getTimeNerfFactor(hitObject.startTime - current.startTime);
    visibleObjectCount += hitObject.opacityAt(current.baseObject.startTime, false) * timeNerfFactor;
    hitObject = hitObject.next(0);
  }

  return visibleObjectCount;
}

function getConstantAngleNerfFactor(current: OsuDifficultyHitObject): number {
  const minimum_angle_relevancy_time = 2000; // 2 seconds
  const maximum_angle_relevancy_time = 200;

  let constantAngleCount = 0;
  let index = 0;
  let currentTimeGap = 0;

  let loopObjPrev0: OsuDifficultyHitObject = current;
  let loopObjPrev1: OsuDifficultyHitObject | null = null;
  let loopObjPrev2: OsuDifficultyHitObject | null = null;

  while (currentTimeGap < minimum_angle_relevancy_time) {
    const loopObj = current.previous(index);
    if (loopObj == null) break;

    // Account less for objects that are close to the time limit.
    const longIntervalFactor = 1 - reverseLerp(loopObj.adjustedDeltaTime, maximum_angle_relevancy_time, minimum_angle_relevancy_time);

    if (loopObj.angle != null && current.angle != null) {
      const angleDifference = Math.abs(current.angle - loopObj.angle);
      let angleDifferenceAlternating = Math.PI;

      if (loopObjPrev0.angle != null && loopObjPrev1?.angle != null && loopObjPrev2?.angle != null) {
        angleDifferenceAlternating = Math.abs(loopObjPrev1.angle - loopObj.angle);
        angleDifferenceAlternating += Math.abs(loopObjPrev2.angle - loopObjPrev0.angle);

        let weight = 1.0;

        // Be sure that one of the angles is very sharp, when other is wide
        weight *= reverseLerp((Math.min(loopObj.angle, loopObjPrev0.angle) * 180) / Math.PI, 20, 5);
        weight *= reverseLerp((Math.max(loopObj.angle, loopObjPrev0.angle) * 180) / Math.PI, 60, 120);

        // Lerp between max angle difference and rescaled alternating difference, with more harsh scaling compared to normal difference
        angleDifferenceAlternating = doubleLerp(Math.PI, 0.1 * angleDifferenceAlternating, weight);
      }

      const stackFactor = smootherstep(loopObj.lazyJumpDistance, 0, NORMALISED_RADIUS);

      constantAngleCount += Math.cos(3 * Math.min(degToRad(30), Math.min(angleDifference, angleDifferenceAlternating) * stackFactor)) * longIntervalFactor;
    }

    currentTimeGap = current.startTime - loopObj.startTime;
    index++;

    loopObjPrev2 = loopObjPrev1;
    loopObjPrev1 = loopObjPrev0;
    loopObjPrev0 = loopObj;
  }

  return clamp(2 / constantAngleCount, 0.2, 1);
}

const getTimeNerfFactor = (deltaTime: number): number => clamp(2 - deltaTime / (reading_window_size / 2), 0, 1);

// ============================================================================================
// FlashlightEvaluator
// ============================================================================================

export function evaluateFlashlight(current: OsuDifficultyHitObject, mods: ModSet): number {
  if (current.baseObject.kind === 'spinner') return 0;

  const max_opacity_bonus = 0.4;
  const hidden_bonus = 0.2;
  const min_velocity = 0.5;
  const slider_multiplier = 1.3;
  const min_angle_multiplier = 0.2;

  const osuCurrent = current;
  const osuHitObject = osuCurrent.baseObject;
  const hidden = mods.has('HD');

  const scalingFactor = 52.0 / osuHitObject.radius;
  let smallDistNerf = 1.0;
  let cumulativeStrainTime = 0.0;

  let flashlightDifficulty = 0.0;

  let lastObj = osuCurrent;

  let angleRepeatCount = 0.0;

  // This is iterating backwards in time from the current object.
  for (let i = 0; i < Math.min(current.index, 10); i++) {
    const currentObj = current.previous(i)!;
    const currentHitObject = currentObj.baseObject;

    cumulativeStrainTime += lastObj.adjustedDeltaTime;

    if (currentHitObject.kind !== 'spinner') {
      const jumpDistance = vLength(vSub(osuHitObject.stackedPosition, currentHitObject.stackedEndPosition));

      // We want to nerf objects that can be easily seen within the Flashlight circle radius.
      if (i === 0) smallDistNerf = Math.min(1.0, jumpDistance / 75.0);

      // We also want to nerf stacks so that only the first object of the stack is accounted for.
      const stackNerf = Math.min(1.0, currentObj.lazyJumpDistance / scalingFactor / 25.0);

      // Bonus based on how visible the object is.
      const opacityBonus = 1.0 + max_opacity_bonus * (1.0 - osuCurrent.opacityAt(currentHitObject.startTime, hidden));

      flashlightDifficulty += (stackNerf * opacityBonus * scalingFactor * jumpDistance) / cumulativeStrainTime;

      if (currentObj.angle != null && osuCurrent.angle != null) {
        // Objects further back in time should count less for the nerf.
        if (Math.abs(currentObj.angle - osuCurrent.angle) < 0.02) angleRepeatCount += Math.max(1.0 - 0.1 * i, 0.0);
      }
    }

    lastObj = currentObj;
  }

  flashlightDifficulty = pow2(smallDistNerf * flashlightDifficulty);

  // Additional bonus for Hidden due to there being no approach circles.
  if (hidden) flashlightDifficulty *= 1.0 + hidden_bonus;

  // Nerf patterns with repeated angles.
  flashlightDifficulty *= min_angle_multiplier + (1.0 - min_angle_multiplier) / (angleRepeatCount + 1.0);

  let sliderBonus = 0.0;

  if (osuCurrent.baseObject.kind === 'slider') {
    // Invert the scaling factor to determine the true travel distance independent of circle size.
    const pixelTravelDistance = osuCurrent.lazyTravelDistance / scalingFactor;

    // Reward sliders based on velocity.
    sliderBonus = pow(Math.max(0.0, pixelTravelDistance / osuCurrent.travelTime - min_velocity), 0.5);

    // Longer sliders require more memorisation.
    sliderBonus *= pixelTravelDistance;

    // Nerf sliders with repeats, as less memorisation is required.
    const repeatCount = osuCurrent.baseObject.repeatCount;
    if (repeatCount > 0) sliderBonus /= repeatCount + 1;
  }

  flashlightDifficulty += sliderBonus * slider_multiplier;

  return flashlightDifficulty;
}
