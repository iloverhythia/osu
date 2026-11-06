// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of OsuScoreProcessor.cs, OsuHealthProcessor.cs and OsuScoreMultiplierCalculatorV1.cs

import { difficultyRange } from '../../beatmaps/Difficulty';
import { ModSet, rateAdjustMultiplier } from '../../mods/Mods';
import { DrainingHealthProcessor } from '../../scoring/HealthProcessor';
import { HitResult, isHit } from '../../scoring/HitResult';
import type { JudgementResult } from '../../scoring/Judgement';
import { ScoreProcessor } from '../../scoring/ScoreProcessor';
import type { ScoreRank } from '../../scoring/ScoreRank';

export class OsuScoreProcessor extends ScoreProcessor {
  rankFromScore(accuracy: number, results: Map<HitResult, number>): ScoreRank {
    let rank = super.rankFromScore(accuracy, results);
    if ((rank === 'S' || rank === 'X') && (results.get(HitResult.Miss) ?? 0) > 0) rank = 'A';
    return rank;
  }
}

const enum ComboResult {
  None = 0,
  Good = 1,
  Perfect = 2,
}

export class OsuHealthProcessor extends DrainingHealthProcessor {
  private currentComboResult = ComboResult.Perfect;

  protected resetSimulationState(): void {
    this.currentComboResult = ComboResult.Perfect;
  }

  protected getHealthIncreaseFor(result: JudgementResult): number {
    if (this.simulating) return this.baseIncrease(result);
    const tag = result.tag;
    // Only top-level combo objects + their nested objects carry combo info.
    if (result.newCombo === undefined) return this.baseIncrease(result);

    const isTopLevel = tag === 'circle' || tag === 'slider' || tag === 'spinner';
    if (isTopLevel && result.newCombo) this.currentComboResult = ComboResult.Perfect;

    const setComboResult = (c: ComboResult) => (this.currentComboResult = Math.min(this.currentComboResult, c));
    switch (result.type) {
      case HitResult.LargeTickMiss:
      case HitResult.Ok:
        setComboResult(ComboResult.Good);
        break;
      case HitResult.Meh:
      case HitResult.Miss:
        setComboResult(ComboResult.None);
        break;
    }

    // The tail has a special IgnoreMiss judgement
    if (tag === 'sliderTail' && !isHit(result.type)) setComboResult(ComboResult.Good);

    if (isTopLevel && result.lastInCombo && isHit(result.type)) {
      switch (this.currentComboResult) {
        case ComboResult.Perfect:
          return this.baseIncrease(result) + 0.07;
        case ComboResult.Good:
          return this.baseIncrease(result) + 0.05;
        default:
          return this.baseIncrease(result) + 0.03;
      }
    }
    return this.baseIncrease(result);
  }

  private baseIncrease(result: JudgementResult): number {
    const hp = this.hpDifficulty;
    switch (result.type) {
      case HitResult.SmallTickMiss:
        return difficultyRange(hp, -0.02, -0.075, -0.14);
      case HitResult.LargeTickMiss:
        return difficultyRange(hp, -0.02, -0.075, -0.14);
      case HitResult.Miss:
        return difficultyRange(hp, -0.03, -0.125, -0.2);
      case HitResult.SmallTickHit:
        // When classic slider mechanics are active, "slider ends" are replaced with "small ticks" and should also give health.
        return 0.02;
      case HitResult.SliderTailHit:
      case HitResult.LargeTickHit:
        switch (result.tag) {
          case 'sliderTick':
            return 0.015;
          case 'sliderHead':
          case 'sliderTail':
          case 'sliderRepeat':
            return 0.02;
        }
        break;
      case HitResult.Meh:
        return 0.002;
      case HitResult.Ok:
        return 0.011;
      case HitResult.Great:
        return 0.03;
      case HitResult.SmallBonus:
        return 0.0085;
      case HitResult.LargeBonus:
        return 0.01;
    }
    return super.getHealthIncreaseFor(result);
  }
}

/** OsuScoreMultiplierCalculatorV1 */
export function osuScoreMultiplier(mods: ModSet): number {
  let m = 1;
  const table: Record<string, number> = {
    EZ: 0.5,
    NF: 0.5,
    HR: 1.06,
    HD: 1.06,
    FL: 1.12,
    DA: 0.5,
    RX: 0.1,
    AP: 0.1,
    SO: 0.9,
  };
  for (const a of mods.list) {
    if (a in table) m *= table[a];
    else if (a === 'DT' || a === 'NC' || a === 'HT' || a === 'DC') m *= rateAdjustMultiplier(mods.rate);
  }
  return m;
}
