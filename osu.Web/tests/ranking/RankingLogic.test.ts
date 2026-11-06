// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.

import { describe, expect, it } from 'vitest';
import { applyEasing, Easing } from '../../src/game/storyboard/Easing';
import { HitResult } from '../../src/game/scoring/HitResult';
import { EmptyHitWindows } from '../../src/game/scoring/HitWindows';
import type { HitEvent } from '../../src/game/scoring/ScoreProcessor';
import {
  accuracyCircleTarget,
  badgeAppearDelay,
  binTimingDistribution,
  calculateAverageHitError,
  calculateUnstableRate,
  formatAccuracy,
  formatHitError,
  inverseEasing,
  statisticsForDisplay,
  timingBinSize,
  timingGraphEvents,
  TIMING_DISTRIBUTION_CENTRE_BIN_INDEX,
} from '../../src/ui/ranking/RankingLogic';

const ev = (timeOffset: number, result = HitResult.Great, hitObject: unknown = {}, gameplayRate = 1): HitEvent => ({ timeOffset, result, hitObject, gameplayRate, time: 0 });

describe('HitEventExtensions', () => {
  it('computes unstable rate like TestSceneHitEventExtensions', () => {
    // UnstableRateTest.TestDistributedHits: offsets -5..5 → UR = 10 * sqrt(10) (population std dev).
    const events = Array.from({ length: 11 }, (_, i) => ev(i - 5));
    expect(calculateUnstableRate(events)).toBeCloseTo(10 * Math.sqrt(10), 10);
  });

  it('ignores misses and objects without hit windows, divides by rate', () => {
    const events = [ev(10), ev(-10), ev(200, HitResult.Miss), ev(300, HitResult.Great, { hitWindows: new EmptyHitWindows() }), ev(400, HitResult.Great, { hitWindows: null })];
    expect(calculateUnstableRate(events)).toBeCloseTo(100, 10);
    expect(calculateAverageHitError(events)).toBe(0);
    expect(calculateUnstableRate([ev(20, HitResult.Great, {}, 2), ev(-20, HitResult.Great, {}, 2)])).toBeCloseTo(100, 10);
    expect(calculateUnstableRate([])).toBeNull();
    expect(calculateAverageHitError([ev(5, HitResult.Miss)])).toBeNull();
  });

  it('formats hit error', () => {
    expect(formatHitError(-3.456)).toBe('3.46 ms early');
    expect(formatHitError(2)).toBe('2.00 ms late');
    expect(formatHitError(null)).toBe('(not available)');
  });
});

describe('HitEventTimingDistributionGraph binning', () => {
  it('uses ceil(max / 50) bin size with a minimum of 1', () => {
    expect(timingBinSize([ev(0)])).toBe(1);
    expect(timingBinSize([ev(-101), ev(3)])).toBe(3);
  });

  it('alternates rounding for midpoints and rounds away from zero otherwise', () => {
    const bins = binTimingDistribution([ev(0.5), ev(0.5), ev(-0.5), ev(-0.5), ev(1.6), ev(-1.4)], 1);
    const c = TIMING_DISTRIBUTION_CENTRE_BIN_INDEX;
    const count = (i: number) => [...bins[c + i].values()].reduce((a, b) => a + b, 0);
    // midpoints: +0.5 → 1 (roundUp), +0.5 → 0, -0.5 → -1, -0.5 → 0
    expect(count(1)).toBe(1);
    expect(count(0)).toBe(2);
    expect(count(-1)).toBe(2); // -0.5 → -1 and -1.4 → -1
    expect(count(2)).toBe(1);
  });

  it('only shows basic hit results with hit windows', () => {
    const events = [ev(1), ev(1, HitResult.LargeTickHit), ev(1, HitResult.Miss), ev(1, HitResult.Great, { hitWindows: new EmptyHitWindows() })];
    expect(timingGraphEvents(events)).toHaveLength(1);
  });
});

describe('AccuracyCircle', () => {
  it('inverse easing finds the progress for a value', () => {
    for (const v of [0.1, 0.5, 0.9, 0.99]) expect(applyEasing(Easing.OutPow10, inverseEasing(Easing.OutPow10, v))).toBeCloseTo(v, 2);
    expect(inverseEasing(Easing.OutPow10, 0)).toBe(0);
  });

  it('nudges the target away from notches and the SS gap', () => {
    expect(accuracyCircleTarget(1, 'X')).toBe(1);
    expect(accuracyCircleTarget(0.95, 'S')).toBeCloseTo(0.95 + 1 / 360 - 0.001, 10);
    expect(accuracyCircleTarget(0.9499, 'A')).toBeCloseTo(0.95 - 1 / 360 - 0.001, 10);
    expect(accuracyCircleTarget(0.999, 'S')).toBeCloseTo(1 - 0.01 - 1 / 360 - 0.001, 10);
    expect(accuracyCircleTarget(0.85, 'B')).toBeCloseTo(0.849, 10);
  });

  it('badges appear in order', () => {
    const t = accuracyCircleTarget(0.97, 'S');
    const d = [0, 0.7, 0.8, 0.9, 0.95].map(a => badgeAppearDelay(a, t));
    for (let i = 1; i < d.length; i++) expect(d[i]).toBeGreaterThan(d[i - 1]);
    expect(d[4]).toBeLessThanOrEqual(3000);
  });

  it('formats accuracy without rounding up', () => {
    expect(formatAccuracy(0.89999)).toBe('89.99%');
    expect(formatAccuracy(0.9575)).toBe('95.75%');
    expect(formatAccuracy(1)).toBe('100.00%');
  });
});

describe('GetStatisticsForDisplay', () => {
  it('lists osu! results in display order with tick completion counts', () => {
    const stats = new Map([
      [HitResult.Great, 10],
      [HitResult.Ok, 2],
      [HitResult.LargeTickHit, 3],
    ]);
    const max = new Map([
      [HitResult.Great, 13],
      [HitResult.LargeTickHit, 4],
      [HitResult.SliderTailHit, 2],
    ]);
    const s = statisticsForDisplay(0, stats, max);
    expect(s.map(x => x.displayName)).toEqual(['Great', 'OK', 'Meh', 'Miss', 'slider tick', 'slider end']);
    expect(s[4]).toMatchObject({ count: 3, maxCount: 4 });
    expect(s[5]).toMatchObject({ count: 0, maxCount: 2 });
  });

  it('lists all mania judgements', () => {
    expect(statisticsForDisplay(3, new Map(), new Map()).map(x => x.result)).toEqual([HitResult.Perfect, HitResult.Great, HitResult.Good, HitResult.Ok, HitResult.Meh, HitResult.Miss]);
  });
});
