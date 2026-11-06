// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game.Rulesets.Catch/Scoring/CatchScoreProcessor.cs, CatchHealthProcessor.cs (+ LegacyDrainingHealthProcessor.cs)
// and CatchScoreMultiplierCalculator.cs.

import { difficultyRange } from '../../beatmaps/Difficulty';
import { rateAdjustMultiplier, type ModSet } from '../../mods/Mods';
import { DrainingHealthProcessor } from '../../scoring/HealthProcessor';
import { HitResult } from '../../scoring/HitResult';
import type { JudgementResult } from '../../scoring/Judgement';
import { ScoreProcessor } from '../../scoring/ScoreProcessor';
import type { ScoreRank } from '../../scoring/ScoreRank';
import { Banana, BananaShower, Droplet, Fruit, type CatchHitObject } from './objects';

const ACCURACY_CUTOFF_X = 1;
const ACCURACY_CUTOFF_S = 0.98;
const ACCURACY_CUTOFF_A = 0.94;
const ACCURACY_CUTOFF_B = 0.9;
const ACCURACY_CUTOFF_C = 0.85;

const COMBO_CAP = 200;
const COMBO_BASE = 4;

export class CatchScoreProcessor extends ScoreProcessor {
  private fruitTinyScale = 0;

  override reset(): void {
    // Computed before the base reset, which recomputes the score through computeTotalScore().
    const max = this.maximumStatistics ?? new Map<HitResult, number>();
    // large ticks are *purposefully* not counted to match stable
    const smallTicks = max.get(HitResult.SmallTickHit) ?? 0;
    const fruitTinyScaleDivisor = smallTicks + (max.get(HitResult.Great) ?? 0);
    this.fruitTinyScale = fruitTinyScaleDivisor === 0 ? 0 : smallTicks / fruitTinyScaleDivisor;
    super.reset();
  }

  protected override computeTotalScore(comboProgress: number, _accuracyProgress: number, bonusPortion: number): number {
    const MAX_TINY_DROPLETS_PORTION = 400000;

    const comboPortion = 1000000 - MAX_TINY_DROPLETS_PORTION + MAX_TINY_DROPLETS_PORTION * (1 - this.fruitTinyScale);
    const dropletsPortion = MAX_TINY_DROPLETS_PORTION * this.fruitTinyScale;
    const maxSmallTicks = this.maximumStatistics?.get(HitResult.SmallTickHit) ?? 0;
    const dropletsHit = maxSmallTicks === 0 ? 0 : (this.statistics?.get(HitResult.SmallTickHit) ?? 0) / maxSmallTicks;

    return comboPortion * comboProgress + dropletsPortion * dropletsHit + bonusPortion;
  }

  override getBaseScoreForResult(result: HitResult): number {
    switch (result) {
      // dirty hack to emulate accuracy on stable weighting every object equally in accuracy portion
      case HitResult.Great:
      case HitResult.LargeTickHit:
      case HitResult.SmallTickHit:
        return 300;
      case HitResult.LargeBonus:
        return 200;
    }
    return super.getBaseScoreForResult(result);
  }

  protected override getComboScoreChange(result: JudgementResult): number {
    let baseIncrease = 0;
    switch (result.type) {
      case HitResult.Great:
        baseIncrease = 300;
        break;
      case HitResult.LargeTickHit:
        baseIncrease = 100;
        break;
    }
    const combo = result.comboAfterJudgement ?? 0;
    return baseIncrease * Math.min(Math.max(0.5, Math.log(combo) / Math.log(COMBO_BASE)), Math.log(COMBO_CAP) / Math.log(COMBO_BASE));
  }

  override rankFromScore(accuracy: number, _results: Map<HitResult, number>): ScoreRank {
    if (accuracy === ACCURACY_CUTOFF_X) return 'X';
    if (accuracy >= ACCURACY_CUTOFF_S) return 'S';
    if (accuracy >= ACCURACY_CUTOFF_A) return 'A';
    if (accuracy >= ACCURACY_CUTOFF_B) return 'B';
    if (accuracy >= ACCURACY_CUTOFF_C) return 'C';
    return 'D';
  }
}

/**
 * CatchHealthProcessor (a LegacyDrainingHealthProcessor). The drain rate is computed with the osu!stable algorithm over
 * the catchable objects of the beatmap rather than the generic health-increase simulation.
 */
export class CatchHealthProcessor extends DrainingHealthProcessor {
  /** LegacyDrainingHealthProcessor.HpMultiplierNormal */
  hpMultiplierNormal = 1;

  /** EnumerateTopLevelHitObjects(): every Fruit / Droplet / Banana in JudgementProcessor.EnumerateHitObjects order. */
  private readonly drainObjects: CatchHitObject[];

  constructor(
    drainStartTime: number,
    hitObjects: readonly CatchHitObject[],
    private readonly drainRateDifficulty: number,
  ) {
    super(drainStartTime);
    const out: CatchHitObject[] = [];
    const visit = (objs: readonly CatchHitObject[]) => {
      for (const h of objs) {
        visit(h.nested);
        if (h instanceof Fruit || h instanceof Droplet || h instanceof Banana) out.push(h);
      }
    };
    visit(hitObjects);
    this.drainObjects = out;
  }

  protected override checkDefaultFailCondition(result: JudgementResult): boolean {
    // matches stable: it is impossible to fail on a tiny droplet regardless of result.
    if (result.type === HitResult.SmallTickMiss) return false;
    // on stable, banana showers don't exist as concrete objects themselves, so they can't cause a fail.
    if (result.hitObject instanceof BananaShower) return false;
    return super.checkDefaultFailCondition(result);
  }

  protected override getHealthIncreaseFor(result: JudgementResult): number {
    return this.healthIncreaseFor(result.type);
  }

  private healthIncreaseFor(result: HitResult): number {
    let increase = 0;
    switch (result) {
      case HitResult.SmallTickMiss:
        return 0;
      case HitResult.LargeTickMiss:
      case HitResult.Miss:
        return difficultyRange(this.drainRateDifficulty, -0.03, -0.125, -0.2);
      case HitResult.SmallTickHit:
        increase = 0.0015;
        break;
      case HitResult.LargeTickHit:
        increase = 0.015;
        break;
      case HitResult.Great:
        increase = 0.03;
        break;
      case HitResult.LargeBonus:
        increase = 0.0025;
        break;
    }
    return this.hpMultiplierNormal * increase;
  }

  /** LegacyDrainingHealthProcessor.ComputeDrainRate */
  protected override computeDrainRate(): number {
    const hp = this.drainRateDifficulty;
    const lowestHpEver = difficultyRange(hp, 0.975, 0.8, 0.3);
    const lowestHpEnd = difficultyRange(hp, 0.99, 0.9, 0.4);
    const hpRecoveryAvailable = difficultyRange(hp, 0.04, 0.02, 0);

    this.hpMultiplierNormal = 1;

    let testDrop = 0.00025;
    let currentHp: number;
    let currentHpUncapped: number;

    const reduceHp = (amount: number) => {
      currentHpUncapped = Math.max(0, currentHpUncapped - amount);
      currentHp = Math.max(0, currentHp - amount);
    };

    const increaseHp = (h: CatchHitObject) => {
      const amount = this.healthIncreaseFor(h.judgement.maxResult);
      currentHpUncapped += amount;
      currentHp = Math.max(0, Math.min(1, currentHp + amount));
    };

    const breaks = this.breaks;

    // Safety net against pathological inputs; the stable algorithm converges well before this.
    for (let iteration = 0; iteration < 100000; iteration++) {
      currentHp = 1;
      currentHpUncapped = 1;

      let lowestHp = currentHp;
      let lastTime = this.drainStartTime;
      let currentBreak = 0;
      let fail = false;
      let topLevelObjectCount = 0;

      for (const h of this.drainObjects) {
        topLevelObjectCount++;

        while (currentBreak < breaks.length && breaks[currentBreak].endTime <= h.startTime) {
          // If two hitobjects are separated by a break period, there is no drain for the full duration between the hitobjects.
          lastTime = h.startTime;
          currentBreak++;
        }

        reduceHp(testDrop * (h.startTime - lastTime));

        lastTime = h.endTime;

        if (currentHp < lowestHp) lowestHp = currentHp;

        if (currentHp <= lowestHpEver) {
          fail = true;
          testDrop *= 0.96;
          break;
        }

        const hpReduction = testDrop * (h.endTime - h.startTime);
        const hpOverkill = Math.max(0, hpReduction - currentHp);
        reduceHp(hpReduction);

        if (hpOverkill > 0 && currentHp - hpOverkill <= lowestHpEver) {
          fail = true;
          testDrop *= 0.96;
          break;
        }

        increaseHp(h);
      }

      if (topLevelObjectCount === 0) return testDrop;

      if (!fail && currentHp < lowestHpEnd) {
        fail = true;
        testDrop *= 0.94;
        this.hpMultiplierNormal *= 1.01;
      }

      const recovery = (currentHpUncapped - 1) / Math.max(1, topLevelObjectCount);

      if (!fail && recovery < hpRecoveryAvailable) {
        fail = true;
        testDrop *= 0.96;
        this.hpMultiplierNormal *= 1.01;
      }

      if (!fail && !Number.isFinite(this.hpMultiplierNormal)) {
        this.hpMultiplierNormal = 1;
        return 0;
      }

      if (!fail) return testDrop;
    }

    return testDrop;
  }
}

/** CatchScoreMultiplierCalculator */
export function catchScoreMultiplier(mods: ModSet): number {
  let result = 1;
  if (mods.has('EZ')) result *= 0.5;
  if (mods.has('NF')) result *= 0.5;
  if (mods.has('HT') || mods.has('DC')) result *= rateAdjustMultiplier(mods.rate);
  if (mods.has('HR')) result *= 1.12;
  if (mods.has('DT') || mods.has('NC')) result *= rateAdjustMultiplier(mods.rate);
  if (mods.has('HD')) result *= 1.06;
  if (mods.has('FL')) result *= 1.12;
  if (mods.has('DA')) result *= 0.5;
  if (mods.has('RX')) result *= 0.1;
  return result;
}
