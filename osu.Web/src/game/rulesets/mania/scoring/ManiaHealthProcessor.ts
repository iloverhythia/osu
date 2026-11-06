// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game.Rulesets.Mania/Scoring/ManiaHealthProcessor.cs
// + osu.Game/Rulesets/Scoring/LegacyDrainingHealthProcessor.cs (HP multiplier computation)
// + ModEasyWithExtraLives (extra lives on fail).

import type { BreakPeriod } from '../../../beatmaps/Beatmap';
import { difficultyRange } from '../../../beatmaps/Difficulty';
import { DrainingHealthProcessor } from '../../../scoring/HealthProcessor';
import { HitResult, affectsAccuracy, affectsCombo } from '../../../scoring/HitResult';
import type { JudgementResult } from '../../../scoring/Judgement';
import { HeadNote, HoldNote, TailNote, type ManiaHitObject } from '../objects/ManiaHitObject';

export class ManiaHealthProcessor extends DrainingHealthProcessor {
  /** LegacyDrainingHealthProcessor.HpMultiplierNormal */
  hpMultiplierNormal = 1;

  private lowestHpEver = 0;
  private lowestHpEnd = 0;
  private hpRecoveryAvailable = 0;
  private retries: number;

  /**
   * @param objects top-level objects of the playable beatmap (sorted by start time).
   * @param maniaDrainRate the mod-adjusted HP drain rate of the playable beatmap.
   * @param extraLives ModEasyWithExtraLives retries (2 with Easy, 0 otherwise).
   */
  constructor(
    drainStartTime: number,
    private readonly objects: readonly ManiaHitObject[],
    private readonly maniaDrainRate: number,
    private readonly maniaBreaks: readonly BreakPeriod[],
    private readonly extraLives = 0,
  ) {
    super(drainStartTime);
    this.retries = extraLives;
  }

  applyBeatmap(perfectResults: JudgementResult[], hp: number, breaks: BreakPeriod[], lastObjectEndTime: number, objectTimes?: { start: number; end: number }[]): void {
    const dr = this.maniaDrainRate;
    this.lowestHpEver = difficultyRange(dr, 0.975, 0.8, 0.3);
    this.lowestHpEnd = difficultyRange(dr, 0.99, 0.9, 0.4);
    this.hpRecoveryAvailable = difficultyRange(dr, 0.04, 0.02, 0);

    super.applyBeatmap(perfectResults, hp, breaks, lastObjectEndTime, objectTimes);
  }

  reset(): void {
    super.reset();
    this.retries = this.extraLives;
  }

  protected computeDrainRate(): number {
    // Base call is run only to compute HP recovery (namely, `HpMultiplierNormal`).
    // This closely mirrors (broken) behaviour of stable and as such is preserved unchanged.
    this.computeLegacyDrainRate();
    return 0;
  }

  /** LegacyDrainingHealthProcessor.ComputeDrainRate */
  private computeLegacyDrainRate(): number {
    this.hpMultiplierNormal = 1;

    let testDrop = 0.00025;
    let currentHp = 1;
    let currentHpUncapped = 1;

    const reduceHp = (amount: number): void => {
      currentHpUncapped = Math.max(0, currentHpUncapped - amount);
      currentHp = Math.max(0, currentHp - amount);
    };

    const increaseHp = (h: ManiaHitObject): void => {
      const amount = this.healthIncreaseFor(h, h.judgement.maxResult);
      currentHpUncapped += amount;
      currentHp = Math.max(0, Math.min(1, currentHp + amount));
    };

    const breaks = this.maniaBreaks;

    // Safety net: the stable algorithm always terminates, but guard against pathological inputs.
    for (let iteration = 0; iteration < 100000; iteration++) {
      currentHp = 1;
      currentHpUncapped = 1;

      let lowestHp = currentHp;
      let lastTime = this.drainStartTime;
      let currentBreak = 0;
      let fail = false;
      let topLevelObjectCount = 0;

      for (const h of this.objects) {
        topLevelObjectCount++;

        while (currentBreak < breaks.length && breaks[currentBreak].endTime <= h.startTime) {
          // If two hitobjects are separated by a break period, there is no drain for the full duration between the hitobjects.
          lastTime = h.startTime;
          currentBreak++;
        }

        reduceHp(testDrop * (h.startTime - lastTime));

        lastTime = h.endTime;

        if (currentHp < lowestHp) lowestHp = currentHp;

        if (currentHp <= this.lowestHpEver) {
          fail = true;
          testDrop *= 0.96;
          break;
        }

        const hpReduction = testDrop * (h.endTime - h.startTime);
        const hpOverkill = Math.max(0, hpReduction - currentHp);
        reduceHp(hpReduction);

        if (h instanceof HoldNote) for (const nested of h.nested) increaseHp(nested);

        if (hpOverkill > 0 && currentHp - hpOverkill <= this.lowestHpEver) {
          fail = true;
          testDrop *= 0.96;
          break;
        }

        increaseHp(h);
      }

      if (topLevelObjectCount === 0) return testDrop;

      if (!fail && currentHp < this.lowestHpEnd) {
        fail = true;
        testDrop *= 0.94;
        this.hpMultiplierNormal *= 1.01;
      }

      const recovery = (currentHpUncapped - 1) / Math.max(1, topLevelObjectCount);

      if (!fail && recovery < this.hpRecoveryAvailable) {
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

  protected getHealthIncreaseFor(result: JudgementResult): number {
    return this.healthIncreaseFor(result.hitObject as ManiaHitObject, result.type);
  }

  /** ManiaHealthProcessor.GetHealthIncreaseFor(HitObject, HitResult) */
  healthIncreaseFor(hitObject: ManiaHitObject, result: HitResult): number {
    const drainRate = this.maniaDrainRate;
    let increase = 0;

    switch (result) {
      case HitResult.Miss:
        if (hitObject instanceof HeadNote || hitObject instanceof TailNote) return -(drainRate + 1) * 0.00375;
        return -(drainRate + 1) * 0.0075;

      case HitResult.Meh:
        return -(drainRate + 1) * 0.0016;

      case HitResult.Ok:
        return 0;

      case HitResult.Good:
        increase = 0.004 - drainRate * 0.0004;
        break;

      case HitResult.Great:
        increase = 0.005 - drainRate * 0.0005;
        break;

      case HitResult.Perfect:
        increase = 0.0055 - drainRate * 0.0005;
        break;
    }

    return this.hpMultiplierNormal * increase;
  }

  triggerFailure(): void {
    if (this.failed) return;

    // ModEasyWithExtraLives.PerformFail: refill health instead of failing while retries remain.
    if (this.retries > 0 && !this.simulating) {
      this.health = 1;
      this.retries--;
      return;
    }

    super.triggerFailure();
  }
}

const isRelevantResult = (result: HitResult): boolean => affectsAccuracy(result) || affectsCombo(result);

/**
 * ManiaModPerfect.FailCondition (RequirePerfectHits = false): mania allows imperfect "Great" hits without failing.
 * Use this instead of the generic Perfect fail condition for osu!mania.
 */
export function maniaPerfectFailCondition(result: JudgementResult): boolean {
  const j = result.judgement;
  if (!isRelevantResult(j.minResult) && !isRelevantResult(j.maxResult) && !isRelevantResult(result.type)) return false;

  if (j.maxResult === HitResult.Perfect) return result.type < HitResult.Great;

  return result.type !== j.maxResult;
}
