// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of HealthProcessor.cs, DrainingHealthProcessor.cs and AccumulatingHealthProcessor.cs

import type { BreakPeriod } from '../beatmaps/Beatmap';
import { difficultyRange } from '../beatmaps/Difficulty';
import { HitResult, defaultHealthIncreaseFor, isBonus, isHit } from './HitResult';
import type { JudgementResult } from './Judgement';

export abstract class HealthProcessor {
  health = 1;
  failed = false;
  /** Set by mods (NoFail disables, SuddenDeath/Perfect add conditions). */
  failConditions: ((result: JudgementResult, hp: HealthProcessor) => boolean)[] = [];
  noFail = false;
  onFail: (() => void) | null = null;

  protected simulating = false;

  abstract applyBeatmap(perfectResults: JudgementResult[], drainRate: number, breaks: BreakPeriod[], lastObjectEndTime: number, objectTimes?: { start: number; end: number }[]): void;

  /** Called every frame with the current gameplay time. */
  update(_time: number, _elapsed: number): void {}

  applyResult(result: JudgementResult): void {
    this.health = Math.min(1, Math.max(0, this.health + this.getHealthIncreaseFor(result)));
    if (this.simulating || this.failed) return;
    if (this.meetsAnyFailCondition(result)) this.triggerFailure();
  }

  protected getHealthIncreaseFor(result: JudgementResult): number {
    return defaultHealthIncreaseFor(result.type);
  }

  protected checkDefaultFailCondition(_result: JudgementResult): boolean {
    return this.health <= 0;
  }

  protected meetsAnyFailCondition(result: JudgementResult): boolean {
    if (!this.noFail && this.checkDefaultFailCondition(result)) return true;
    return this.failConditions.some(c => c(result, this));
  }

  triggerFailure(): void {
    if (this.failed || this.noFail) {
      // NoFail still honours explicit fail conditions only when not NoFail.
      if (this.failed) return;
    }
    this.failed = true;
    this.onFail?.();
  }

  /** Whether the player should fail at the end of the map (used by AccumulatingHealthProcessor). */
  checkFailAtEnd(): boolean {
    return false;
  }

  reset(): void {
    this.health = 1;
    this.failed = false;
  }
}

/** A health processor that drains over time and is filled up by hits. */
export class DrainingHealthProcessor extends HealthProcessor {
  private static readonly MINIMUM_HEALTH_ERROR = 0.01;
  private static readonly MIN_HEALTH_TARGET = 0.99;
  private static readonly MID_HEALTH_TARGET = 0.9;
  private static readonly MAX_HEALTH_TARGET = 0.4;

  drainRate = 0;
  protected breaks: BreakPeriod[] = [];
  protected noDrainPeriods: { start: number; end: number }[] = [];
  private gameplayEndTime = 0;
  private targetMinimumHealth = 0;
  private healthIncreases: { time: number; amount: number }[] = [];
  protected hpDifficulty = 5;

  constructor(
    protected readonly drainStartTime: number,
    protected readonly drainLenience = 0,
  ) {
    super();
  }

  update(time: number, elapsed: number): void {
    if (this.failed) return;
    if (this.noDrainPeriods.some(p => time >= p.start && time <= p.end)) return;
    const lastGameplayTime = Math.min(Math.max(time - elapsed, this.drainStartTime), this.gameplayEndTime);
    const currentGameplayTime = Math.min(Math.max(time, this.drainStartTime), this.gameplayEndTime);
    if (this.drainLenience < 1) this.health = Math.max(0, this.health - this.drainRate * (currentGameplayTime - lastGameplayTime));
    if (this.health <= 0 && !this.noFail) this.triggerFailure();
  }

  /**
   * @param perfectResults judgements of a perfect play in time order.
   * @param hp the (mod-adjusted) HP drain difficulty.
   * @param breaks break periods.
   * @param objectTimes start/end times of top-level objects (used for no-drain periods during breaks).
   */
  applyBeatmap(perfectResults: JudgementResult[], hp: number, breaks: BreakPeriod[], lastObjectEndTime: number, objectTimes?: { start: number; end: number }[]): void {
    this.hpDifficulty = hp;
    this.breaks = breaks;
    this.gameplayEndTime = lastObjectEndTime;
    const times = objectTimes ?? [];
    this.noDrainPeriods = breaks.map(b => {
      let start = -Infinity;
      for (const t of times) if (t.end <= b.startTime) start = Math.max(start, t.end);
      let end = Infinity;
      for (const t of times) if (t.start >= b.endTime) end = Math.min(end, t.start);
      return { start, end };
    });

    this.targetMinimumHealth = difficultyRange(
      hp,
      DrainingHealthProcessor.MIN_HEALTH_TARGET,
      DrainingHealthProcessor.MID_HEALTH_TARGET,
      DrainingHealthProcessor.MAX_HEALTH_TARGET,
    );
    // Add back a portion of the amount of HP to be drained, depending on the lenience requested.
    this.targetMinimumHealth += this.drainLenience * (1 - this.targetMinimumHealth);
    // Ensure the target HP is within an acceptable range.
    this.targetMinimumHealth = Math.min(1, Math.max(0, this.targetMinimumHealth));

    this.simulating = true;
    this.healthIncreases = [];
    this.resetSimulationState();
    for (const r of perfectResults) {
      const simulated = { ...r, type: r.judgement.maxResult, timeOffset: 0 };
      const inc = this.getHealthIncreaseFor(simulated);
      if (!isBonus(simulated.type)) this.healthIncreases.push({ time: r.objectEndTime, amount: inc });
    }
    this.simulating = false;
    this.drainRate = this.computeDrainRate();
    this.reset();
  }

  /** Hook for subclasses to reset any per-play state before / after simulation. */
  protected resetSimulationState(): void {}

  reset(): void {
    super.reset();
    this.resetSimulationState();
  }

  protected checkDefaultFailCondition(result: JudgementResult): boolean {
    // Bonus and ignore results don't count towards failing.
    if (isBonus(result.judgement.maxResult) || result.type === HitResult.IgnoreHit) return false;
    return super.checkDefaultFailCondition(result);
  }

  protected computeDrainRate(): number {
    const incs = this.healthIncreases;
    if (incs.length <= 1) return 0;

    let adjustment = 1;
    let result = 1;

    // Although we expect the following loop to converge within 30 iterations (health within 1/2^31 accuracy of the target),
    // we'll still keep a safety measure to avoid infinite loops by detecting overflows.
    while (adjustment > 0 && adjustment < 2 ** 31) {
      let currentHealth = 1;
      let lowestHealth = 1;
      let currentBreak = 0;

      for (let i = 0; i < incs.length; i++) {
        const currentTime = incs[i].time;
        let lastTime = i > 0 ? incs[i - 1].time : this.drainStartTime;

        while (currentBreak < this.breaks.length && this.breaks[currentBreak].endTime <= currentTime) {
          // If two hitobjects are separated by a break period, there is no drain for the full duration between the hitobjects.
          // This differs from legacy (version < 8) beatmaps which continue draining until the break section is entered,
          // but this shouldn't have a noticeable impact in practice.
          lastTime = currentTime;
          currentBreak++;
        }

        // Apply health adjustments
        currentHealth -= (currentTime - lastTime) * result;
        lowestHealth = Math.min(lowestHealth, currentHealth);
        currentHealth = Math.min(1, currentHealth + incs[i].amount);

        // Common scenario for when the drain rate is definitely too harsh
        if (lowestHealth < 0) break;
      }

      // Stop if the resulting health is within a reasonable offset from the target
      if (Math.abs(lowestHealth - this.targetMinimumHealth) <= DrainingHealthProcessor.MINIMUM_HEALTH_ERROR) break;

      // This effectively works like a binary search - each iteration the search space moves closer to the target, but may exceed it.
      adjustment *= 2;
      result += (1.0 / adjustment) * Math.sign(lowestHealth - this.targetMinimumHealth);
    }
    return result;
  }
}

/** A health processor that starts at 0 and must exceed a threshold by the end (taiko). */
export class AccumulatingHealthProcessor extends HealthProcessor {
  constructor(private readonly requiredHealth: number) {
    super();
    this.health = 0;
  }

  applyBeatmap(_perfectResults?: JudgementResult[], _drainRate?: number, _breaks?: BreakPeriod[], _lastObjectEndTime?: number, _objectTimes?: { start: number; end: number }[]): void {
    this.reset();
  }

  reset(): void {
    super.reset();
    this.health = 0;
  }

  protected checkDefaultFailCondition(): boolean {
    return false;
  }

  checkFailAtEnd(): boolean {
    return !this.noFail && this.health < this.requiredHealth;
  }
}

export { isHit };
