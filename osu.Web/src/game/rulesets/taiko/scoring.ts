// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game.Rulesets.Taiko/Scoring/TaikoScoreProcessor.cs, TaikoHealthProcessor.cs and TaikoScoreMultiplierCalculator.cs

import type { BreakPeriod } from '../../beatmaps/Beatmap';
import { difficultyRange } from '../../beatmaps/Difficulty';
import type { ModSet } from '../../mods/Mods';
import { AccumulatingHealthProcessor } from '../../scoring/HealthProcessor';
import { HitResult, isHit } from '../../scoring/HitResult';
import type { JudgementResult } from '../../scoring/Judgement';
import { ScoreProcessor } from '../../scoring/ScoreProcessor';
import type { ScoreRank } from '../../scoring/ScoreRank';
import { DrumRollTick, StrongNestedHitObject, TaikoHitObject, taikoHealthIncreaseFor } from './objects';

const COMBO_BASE = 4;

function strongScaleValue(result: JudgementResult): number {
  const h = result.hitObject;
  if (h instanceof StrongNestedHitObject) return h.parent instanceof DrumRollTick ? 3 : 7;
  return 1;
}

export class TaikoScoreProcessor extends ScoreProcessor {
  protected computeTotalScore(comboProgress: number, accuracyProgress: number, bonusPortion: number): number {
    return 250000 * comboProgress + 750000 * Math.pow(this.accuracy, 3.6) * accuracyProgress + bonusPortion;
  }

  protected getBonusScoreChange(result: JudgementResult): number {
    return super.getBonusScoreChange(result) * strongScaleValue(result);
  }

  protected getComboScoreChange(result: JudgementResult): number {
    const combo = result.comboAfterJudgement ?? 0;
    return (
      this.getBaseScoreForResult(result.type) *
      Math.min(Math.max(0.5, Math.log(combo) / Math.log(COMBO_BASE)), Math.log(400) / Math.log(COMBO_BASE)) *
      strongScaleValue(result)
    );
  }

  rankFromScore(accuracy: number, results: Map<HitResult, number>): ScoreRank {
    let rank = super.rankFromScore(accuracy, results);
    switch (rank) {
      case 'S':
      case 'X':
        if ((results.get(HitResult.Miss) ?? 0) > 0) rank = 'A';
        break;
    }
    return rank;
  }

  getBaseScoreForResult(result: HitResult): number {
    switch (result) {
      case HitResult.Ok:
        return 150;
    }
    return super.getBaseScoreForResult(result);
  }
}

/**
 * A HealthProcessor for the taiko ruleset.
 * Taiko fails if the player has not half-filled their health by the end of the map.
 */
export class TaikoHealthProcessor extends AccumulatingHealthProcessor {
  /** A value used for calculating hpMultiplier. */
  private static readonly OBJECT_COUNT_FACTOR = 3;
  private static readonly REQUIRED_HEALTH = 0.5;

  /** HP multiplier for a successful HitResult. */
  private hpMultiplier = 0;
  /** HP multiplier for a HitResult that does not satisfy isHit. */
  private hpMissMultiplier = 0;
  /**
   * Sum of all achievable health increases throughout the map.
   * If there are none, health will be forcibly pulled up to 1 to avoid cases of impassable maps.
   */
  private sumOfMaxHealthIncreases = 0;

  judgedHits = 0;
  maxHits = 0;

  constructor() {
    super(TaikoHealthProcessor.REQUIRED_HEALTH);
  }

  applyBeatmap(perfectResults: JudgementResult[], drainRate: number, _breaks?: BreakPeriod[], _lastObjectEndTime?: number): void {
    const hitCount = perfectResults.filter(r => r.hitObject instanceof TaikoHitObject && r.hitObject.kind === 'hit').length;
    this.hpMultiplier = 1 / (TaikoHealthProcessor.OBJECT_COUNT_FACTOR * Math.max(1, hitCount) * difficultyRange(drainRate, 0.5, 0.75, 0.98));
    this.hpMissMultiplier = difficultyRange(drainRate, 0.0018, 0.0075, 0.012);

    this.sumOfMaxHealthIncreases = 0;
    for (const r of perfectResults) if (r.hitObject instanceof TaikoHitObject) this.sumOfMaxHealthIncreases += taikoHealthIncreaseFor(r.hitObject, r.judgement.maxResult);
    this.maxHits = perfectResults.length;
    this.reset();
  }

  reset(): void {
    super.reset();
    this.judgedHits = 0;
    // TaikoHealthProcessor.Reset(storeResults: true)
    if (this.maxHits > 0 && this.sumOfMaxHealthIncreases === 0) this.health = 1;
  }

  applyResult(result: JudgementResult): void {
    this.judgedHits++;
    super.applyResult(result);
  }

  protected getHealthIncreaseFor(result: JudgementResult): number {
    const h = result.hitObject;
    const base = h instanceof TaikoHitObject ? taikoHealthIncreaseFor(h, result.type) : 0;
    return base * (isHit(result.type) ? this.hpMultiplier : this.hpMissMultiplier);
  }

  /** AccumulatingHealthProcessor.CheckDefaultFailCondition */
  protected checkDefaultFailCondition(): boolean {
    return this.judgedHits === this.maxHits && this.health < TaikoHealthProcessor.REQUIRED_HEALTH;
  }
}

/** TaikoScoreMultiplierCalculator.rateAdjustMultiplier */
function rateAdjustMultiplier(speedChange: number): number {
  // Round to the nearest multiple of 0.1.
  let value = Math.trunc(speedChange * 10) / 10.0;
  // Offset back to 0.
  value -= 1;
  return speedChange >= 1 ? 1 + value / 5 : 0.6 + value;
}

/** TaikoScoreMultiplierCalculator (default mod configurations). */
export function taikoScoreMultiplier(mods: ModSet): number {
  let m = 1;
  if (mods.has('EZ')) m *= 0.5;
  if (mods.has('NF')) m *= 0.5;
  if (mods.has('HT')) m *= rateAdjustMultiplier(0.75);
  if (mods.has('DC')) m *= rateAdjustMultiplier(0.75);
  if (mods.has('HR')) m *= 1.06;
  if (mods.has('DT')) m *= rateAdjustMultiplier(1.5);
  if (mods.has('NC')) m *= rateAdjustMultiplier(1.5);
  if (mods.has('HD')) m *= 1.06;
  if (mods.has('FL')) m *= 1.12;
  if (mods.has('DA')) m *= 0.5;
  if (mods.has('RX')) m *= 0.1;
  return m;
}
