// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game/Rulesets/Scoring/ScoreProcessor.cs (standardised scoring).

import { HitResult, affectsAccuracy, breaksCombo, increasesCombo, isBonus, isScorable } from './HitResult';
import type { JudgementResult } from './Judgement';
import type { ScoreRank } from './ScoreRank';

export const COMBO_EXPONENT = 0.5;
const ACCURACY_CUTOFF_X = 1;
const ACCURACY_CUTOFF_S = 0.95;
const ACCURACY_CUTOFF_A = 0.9;
const ACCURACY_CUTOFF_B = 0.8;
const ACCURACY_CUTOFF_C = 0.7;

export interface HitEvent {
  timeOffset: number;
  gameplayRate: number;
  result: HitResult;
  hitObject: unknown;
  position?: { x: number; y: number };
  time: number;
}

export class ScoreProcessor {
  combo = 0;
  highestCombo = 0;
  accuracy = 1;
  totalScore = 0;
  totalScoreWithoutMods = 0;
  rank: ScoreRank = 'X';
  statistics = new Map<HitResult, number>();
  maximumStatistics = new Map<HitResult, number>();
  readonly hitEvents: HitEvent[] = [];
  judgedHits = 0;
  maxHits = 0;
  failed = false;

  /** Multiplier applied for selected mods. */
  scoreMultiplier = 1;
  /** Hooks for mods such as Hidden / Flashlight that change silver ranks. */
  rankAdjusters: ((rank: ScoreRank, accuracy: number) => ScoreRank)[] = [];
  /** Listeners notified after every judgement. */
  onChange: (() => void)[] = [];

  private currentMaximumBaseScore = 0;
  private currentBaseScore = 0;
  private currentAccuracyJudgementCount = 0;
  private currentComboPortion = 0;
  private currentBonusPortion = 0;

  maximumBaseScore = 0;
  private maximumAccuracyJudgementCount = 0;
  private maximumComboPortion = 0;

  private simulating = false;

  /**
   * Simulates a perfect play over the provided judgements to find maximum values
   * (JudgementProcessor.ApplyBeatmap + SimulateAutoplay).
   */
  applyBeatmap(perfectResults: JudgementResult[]): void {
    this.reset();
    this.simulating = true;
    for (const r of perfectResults) this.applyResult({ ...r, type: r.judgement.maxResult, timeOffset: 0 });
    this.simulating = false;
    this.maximumBaseScore = this.currentBaseScore;
    this.maximumAccuracyJudgementCount = this.currentAccuracyJudgementCount;
    this.maximumComboPortion = this.currentComboPortion;
    this.maximumStatistics = new Map(this.statistics);
    this.maxHits = perfectResults.length;
    this.reset();
  }

  reset(): void {
    this.combo = 0;
    this.highestCombo = 0;
    this.currentBaseScore = 0;
    this.currentMaximumBaseScore = 0;
    this.currentAccuracyJudgementCount = 0;
    this.currentComboPortion = 0;
    this.currentBonusPortion = 0;
    this.statistics = new Map();
    this.hitEvents.length = 0;
    this.judgedHits = 0;
    this.failed = false;
    this.rank = 'X';
    this.updateScore();
  }

  get maximumCombo(): number {
    let c = 0;
    for (const [r, n] of this.maximumStatistics) if (increasesCombo(r)) c += n;
    return c;
  }

  applyResult(result: JudgementResult): void {
    if (this.failed && !this.simulating) return;
    this.judgedHits++;
    this.statistics.set(result.type, (this.statistics.get(result.type) ?? 0) + 1);

    if (increasesCombo(result.type)) this.combo++;
    else if (breaksCombo(result.type)) this.combo = 0;

    this.highestCombo = Math.max(this.highestCombo, this.combo);
    result.comboAfterJudgement = this.combo;

    if (affectsAccuracy(result.judgement.maxResult)) {
      this.currentMaximumBaseScore += this.getBaseScoreForResult(result.judgement.maxResult);
      this.currentAccuracyJudgementCount++;
    }

    if (affectsAccuracy(result.type)) this.currentBaseScore += this.getBaseScoreForResult(result.type);

    if (isBonus(result.type)) this.currentBonusPortion += this.getBonusScoreChange(result);
    else if (isScorable(result.type)) this.currentComboPortion += this.getComboScoreChange(result);

    if (!this.simulating) {
      this.hitEvents.push({
        timeOffset: result.timeOffset,
        gameplayRate: result.gameplayRate ?? 1,
        result: result.type,
        hitObject: result.hitObject,
        position: result.position,
        time: result.objectEndTime + result.timeOffset,
      });
      this.updateScore();
      for (const l of this.onChange) l();
    }
  }

  protected getBonusScoreChange(result: JudgementResult): number {
    return this.getBaseScoreForResult(result.type);
  }

  protected getComboScoreChange(result: JudgementResult): number {
    return this.getBaseScoreForResult(result.judgement.maxResult) * Math.pow(result.comboAfterJudgement ?? 0, COMBO_EXPONENT);
  }

  getBaseScoreForResult(result: HitResult): number {
    switch (result) {
      default:
        return 0;
      case HitResult.SmallTickHit:
        return 10;
      case HitResult.LargeTickHit:
        return 30;
      case HitResult.SliderTailHit:
        return 150;
      case HitResult.Meh:
        return 50;
      case HitResult.Ok:
        return 100;
      case HitResult.Good:
        return 200;
      case HitResult.Great:
      case HitResult.Perfect:
        return 300;
      case HitResult.SmallBonus:
        return 10;
      case HitResult.LargeBonus:
        return 50;
    }
  }

  protected updateScore(): void {
    this.accuracy = this.currentMaximumBaseScore > 0 ? this.currentBaseScore / this.currentMaximumBaseScore : 1;
    const comboProgress = this.maximumComboPortion > 0 ? this.currentComboPortion / this.maximumComboPortion : 1;
    const accuracyProgress = this.maximumAccuracyJudgementCount > 0 ? this.currentAccuracyJudgementCount / this.maximumAccuracyJudgementCount : 1;
    this.totalScoreWithoutMods = Math.round(this.computeTotalScore(comboProgress, accuracyProgress, this.currentBonusPortion));
    this.totalScore = Math.round(this.totalScoreWithoutMods * this.scoreMultiplier);
    this.updateRank();
  }

  protected computeTotalScore(comboProgress: number, accuracyProgress: number, bonusPortion: number): number {
    return 500000 * this.accuracy * comboProgress + 500000 * Math.pow(this.accuracy, 5) * accuracyProgress + bonusPortion;
  }

  private updateRank(): void {
    if (this.failed) return;
    let rank = this.rankFromScore(this.accuracy, this.statistics);
    for (const adjust of this.rankAdjusters) rank = adjust(rank, this.accuracy);
    this.rank = rank;
  }

  rankFromScore(accuracy: number, _results: Map<HitResult, number>): ScoreRank {
    if (accuracy === ACCURACY_CUTOFF_X) return 'X';
    if (accuracy >= ACCURACY_CUTOFF_S) return 'S';
    if (accuracy >= ACCURACY_CUTOFF_A) return 'A';
    if (accuracy >= ACCURACY_CUTOFF_B) return 'B';
    if (accuracy >= ACCURACY_CUTOFF_C) return 'C';
    return 'D';
  }

  fail(): void {
    this.failed = true;
    this.rank = 'F';
  }

  get count(): (r: HitResult) => number {
    return r => this.statistics.get(r) ?? 0;
  }
}
