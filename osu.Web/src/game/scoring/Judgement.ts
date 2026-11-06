// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.

import { HitResult, minResultFor } from './HitResult';

export interface Judgement {
  maxResult: HitResult;
  minResult: HitResult;
}

export const judgement = (maxResult: HitResult, minResult?: HitResult): Judgement => ({
  maxResult,
  minResult: minResult ?? minResultFor(maxResult),
});

/**
 * The result of judging a hit object. `hitObject` is ruleset-specific; `tag` lets rulesets
 * classify judgements (e.g. "head", "tick", "tail") for health / statistics purposes.
 */
export interface JudgementResult {
  hitObject: unknown;
  judgement: Judgement;
  type: HitResult;
  /** Offset from the object's end time at which the judgement was made (positive = late). */
  timeOffset: number;
  /** Absolute time the object ends (used for health simulation ordering). */
  objectEndTime: number;
  tag?: string;
  /** Combo information of the object (only for objects implementing combo info). */
  newCombo?: boolean;
  lastInCombo?: boolean;
  /** Optional position (osu! playfield space) for hit error displays. */
  position?: { x: number; y: number };
  // Filled in by ScoreProcessor
  comboAfterJudgement?: number;
  /** Filled in by the player for hit error meters. */
  gameplayRate?: number;
}

export const isHitResult = (r: JudgementResult): boolean => r.type !== HitResult.None && r.type !== r.judgement.minResult;
