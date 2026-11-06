// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game.Rulesets.Mania/Scoring/ManiaScoreProcessor.cs

import { HitResult } from '../../../scoring/HitResult';
import type { JudgementResult } from '../../../scoring/Judgement';
import { ScoreProcessor } from '../../../scoring/ScoreProcessor';
import type { ScoreRank } from '../../../scoring/ScoreRank';
import { Note, type ManiaHitObject } from '../objects/ManiaHitObject';

const combo_base = 4;
const log4 = (x: number): number => Math.log(x) / Math.log(combo_base);
const MAX_COMBO_FACTOR = log4(400);

export class ManiaScoreProcessor extends ScoreProcessor {
  protected computeTotalScore(comboProgress: number, accuracyProgress: number, bonusPortion: number): number {
    return 150000 * comboProgress + 850000 * Math.pow(this.accuracy, 2 + 2 * this.accuracy) * accuracyProgress + bonusPortion;
  }

  protected getComboScoreChange(result: JudgementResult): number {
    const combo = result.comboAfterJudgement ?? 0;
    return getBaseComboScoreForResult(this, result.type) * Math.min(Math.max(0.5, log4(combo)), MAX_COMBO_FACTOR);
  }

  getBaseScoreForResult(result: HitResult): number {
    switch (result) {
      case HitResult.Perfect:
        return 305;
    }
    return super.getBaseScoreForResult(result);
  }

  rankFromScore(accuracy: number, results: Map<HitResult, number>): ScoreRank {
    const rank = super.rankFromScore(accuracy, results);

    if (rank !== 'S') return rank;

    // SS is expected as long as all hitobjects have been hit with either a GREAT or PERFECT result.
    const anyImperfect =
      (results.get(HitResult.Good) ?? 0) > 0 ||
      (results.get(HitResult.Ok) ?? 0) > 0 ||
      (results.get(HitResult.Meh) ?? 0) > 0 ||
      (results.get(HitResult.Miss) ?? 0) > 0;

    return anyImperfect ? rank : 'X';
  }
}

function getBaseComboScoreForResult(processor: ManiaScoreProcessor, result: HitResult): number {
  switch (result) {
    case HitResult.Perfect:
      return 300;
  }
  return processor.getBaseScoreForResult(result);
}

/**
 * ManiaScoreProcessor.JudgementOrderComparer: by end time, then Notes before non-notes, then by column.
 * Used with a stable sort to reproduce `Order(JudgementOrderComparer.DEFAULT)`.
 */
export function compareJudgementOrder(x: ManiaHitObject, y: ManiaHitObject): number {
  if (x === y) return 0;

  const result = x.endTime - y.endTime;
  if (result !== 0) return result < 0 ? -1 : 1;

  // due to the way input is handled in mania, notes take precedence over ticks in judging order.
  const xNote = x instanceof Note;
  const yNote = y instanceof Note;
  if (xNote && !yNote) return -1;
  if (!xNote && yNote) return 1;

  return x.column - y.column;
}
