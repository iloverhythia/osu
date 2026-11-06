// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game/Scoring/Legacy/ScoreInfoExtensions.GetDisplayScore (ScoringMode.Standardised / Classic).

import { settings } from '../../framework/Settings';
import { HitResult, isBasic } from './HitResult';

export const MAX_SCORE = 1000000;

export type ScoringMode = 'standardised' | 'classic';

/** convertStandardisedToClassic: per-ruleset least-squares fits giving a stable-like "feel". */
export function convertStandardisedToClassic(rulesetId: number, standardisedTotalScore: number, objectCount: number): number {
  switch (rulesetId) {
    case 0:
      return Math.round(((Math.pow(objectCount, 2) * 32.57 + 100000) * standardisedTotalScore) / MAX_SCORE);
    case 1:
      return Math.round(((objectCount * 1109 + 100000) * standardisedTotalScore) / MAX_SCORE);
    case 2:
      // `standardisedTotalScore / MAX_SCORE` is integer (long) division in lazer.
      return Math.round(Math.pow(Math.trunc(standardisedTotalScore / MAX_SCORE) * objectCount, 2) * 21.62 + standardisedTotalScore / 10);
    default:
      return standardisedTotalScore;
  }
}

type Stats = ReadonlyMap<HitResult, number> | Readonly<Record<string, number>>;

function maxBasicJudgements(maximumStatistics: Stats): number {
  let sum = 0;
  if (maximumStatistics instanceof Map) {
    for (const [k, v] of maximumStatistics) if (isBasic(k)) sum += v;
  } else {
    for (const [k, v] of Object.entries(maximumStatistics)) {
      const r = HitResult[k as keyof typeof HitResult];
      if (r !== undefined && isBasic(r)) sum += v;
    }
  }
  return sum;
}

export function getDisplayScore(rulesetId: number, totalScore: number, maximumStatistics: Stats, mode: ScoringMode = settings.get<ScoringMode>('gameplay.scoreDisplayMode', 'standardised')): number {
  if (mode === 'standardised') return totalScore;
  return convertStandardisedToClassic(rulesetId, totalScore, maxBasicJudgements(maximumStatistics));
}
