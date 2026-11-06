// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Gameplay timing rules, ported from:
//  - osu.Game/Rulesets/UI/DrawableRuleset.cs (GameplayStartTime) and osu.Game.Rulesets.Osu/UI/DrawableOsuRuleset.cs (osu! override)
//  - osu.Game/Screens/Play/MasterGameplayClockContainer.cs (findEarliestStartTime, Skip, MINIMUM_SKIP_TIME)
//  - osu.Game/Screens/Play/SkipOverlay.cs (fadeOutBeginTime / progress)
//  - osu.Game/Screens/Play/BreakTracker.cs + osu.Game/Beatmaps/Timing/BreakPeriod.cs (HasEffect) + BreakOverlay.BREAK_FADE_DURATION
//  - osu.Game/Screens/Play/Player.cs (RESULTS_DISPLAY_DELAY, PauseCooldownDuration)

import { MIN_BREAK_DURATION, type BreakPeriod } from '../../game/beatmaps/Beatmap';

/** MasterGameplayClockContainer.MINIMUM_SKIP_TIME */
export const MINIMUM_SKIP_TIME = 1000;
/** Player.RESULTS_DISPLAY_DELAY */
export const RESULTS_DISPLAY_DELAY = 1000;
/** Player.PauseCooldownDuration */
export const PAUSE_COOLDOWN_DURATION = 1000;
/** BreakOverlay.BREAK_FADE_DURATION = BreakPeriod.MIN_BREAK_DURATION / 2 */
export const BREAK_FADE_DURATION = MIN_BREAK_DURATION / 2;

/**
 * DrawableRuleset.GameplayStartTime: first object start - 2000.
 * DrawableOsuRuleset overrides it with first.StartTime - Math.Max(2000, first.TimePreempt).
 */
export function gameplayStartTime(rulesetShortName: string, firstObjectStartTime: number, osuFirstTimePreempt = 0): number {
  if (rulesetShortName === 'osu') return firstObjectStartTime - Math.max(2000, osuFirstTimePreempt);
  return firstObjectStartTime - 2000;
}

/** MasterGameplayClockContainer.findEarliestStartTime. */
export function findEarliestStartTime(gameplayStart: number, firstHitObjectTime: number, audioLeadIn: number, storyboardEarliestEventTime: number | null): number {
  // start with the originally provided latest time (if before zero).
  let time = Math.min(0, gameplayStart);
  // if a storyboard is present, it may dictate the appropriate start time by having events in negative time space.
  if (storyboardEarliestEventTime != null) time = Math.min(time, storyboardEarliestEventTime);
  // some beatmaps specify a current lead-in time which should be used instead of the ruleset-provided value when available.
  if (audioLeadIn > 0) time = Math.min(time, firstHitObjectTime - audioLeadIn);
  return time;
}

/** MasterGameplayClockContainer.Skip: the time to seek to, or null if no skip is possible. */
export function skipTarget(currentTime: number, gameplayStart: number, clockStartTime: number, fullLength = false): number | null {
  if (currentTime > gameplayStart - MINIMUM_SKIP_TIME) return null;
  let target = gameplayStart - MINIMUM_SKIP_TIME;
  // double skip exception for storyboards with very long intros
  if (!fullLength && clockStartTime < -10000 && currentTime < 0 && target > 6000) target = 0;
  return target;
}

export interface Period {
  start: number;
  end: number;
}

/** BreakPeriod.HasEffect: Duration >= MIN_BREAK_DURATION. */
export const breakHasEffect = (b: BreakPeriod): boolean => b.endTime - b.startTime >= MIN_BREAK_DURATION;

/** BreakTracker.Breaks setter: the tracked periods end BREAK_FADE_DURATION before the break does. */
export function breakPeriods(breaks: readonly BreakPeriod[]): Period[] {
  return breaks.filter(breakHasEffect).map(b => ({ start: b.startTime, end: b.endTime - BREAK_FADE_DURATION }));
}

/** BreakTracker: IsBreakTime / CurrentPeriod. */
export class BreakTracker {
  readonly periods: Period[];
  isBreakTime = true;
  currentPeriod: Period | null = null;

  constructor(
    private readonly gameplayStart: number,
    breaks: readonly BreakPeriod[],
  ) {
    this.periods = breakPeriods(breaks);
  }

  update(time: number, scoreCompleted: boolean): void {
    // PeriodTracker.IsInAny is inclusive of both ends.
    const current = this.periods.find(p => time >= p.start && time <= p.end) ?? null;
    if (current) {
      this.currentPeriod = current;
      this.isBreakTime = true;
    } else {
      this.currentPeriod = null;
      this.isBreakTime = time < this.gameplayStart || scoreCompleted;
    }
  }
}
