// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Tests for the ported gameplay timing rules (src/ui/hud/clock.ts) and the transform helper (src/ui/hud/anim.ts).

import { describe, expect, it } from 'vitest';
import { BREAK_FADE_DURATION, BreakTracker, MINIMUM_SKIP_TIME, breakPeriods, findEarliestStartTime, gameplayStartTime, skipTarget } from '../../src/ui/hud/clock';
import { Anim, Easing, dampContinuously } from '../../src/ui/hud/anim';
import { formatAccuracy } from '../../src/ui/hud/ArgonCounter';
import { segmentedGraph } from '../../src/ui/hud/HudComponents';

describe('GameplayStartTime', () => {
  it('uses first object - 2000 for non-osu rulesets', () => {
    expect(gameplayStartTime('taiko', 5000)).toBe(3000);
    expect(gameplayStartTime('mania', 5000, 9999)).toBe(3000);
  });

  it('uses max(2000, preempt) for osu!', () => {
    expect(gameplayStartTime('osu', 5000, 1200)).toBe(3000);
    expect(gameplayStartTime('osu', 5000, 2400)).toBe(2600);
  });
});

describe('MasterGameplayClockContainer.findEarliestStartTime', () => {
  it('is zero when gameplay starts after zero', () => {
    expect(findEarliestStartTime(3000, 5000, 0, null)).toBe(0);
  });

  it('goes negative for early objects', () => {
    expect(findEarliestStartTime(-1500, 500, 0, null)).toBe(-1500);
  });

  it('respects storyboard intros and audio lead-in', () => {
    expect(findEarliestStartTime(3000, 5000, 0, -4000)).toBe(-4000);
    expect(findEarliestStartTime(3000, 1000, 2500, null)).toBe(-1500);
    // AudioLeadIn not reaching before zero doesn't move the start.
    expect(findEarliestStartTime(3000, 5000, 1000, null)).toBe(0);
  });
});

describe('MasterGameplayClockContainer.Skip', () => {
  it('skips to gameplay start - MINIMUM_SKIP_TIME', () => {
    expect(skipTarget(0, 10000, 0)).toBe(10000 - MINIMUM_SKIP_TIME);
  });

  it('does nothing once past the skip point', () => {
    expect(skipTarget(9500, 10000, 0)).toBeNull();
  });

  it('double-skips long storyboard intros to zero first', () => {
    expect(skipTarget(-12000, 20000, -15000)).toBe(0);
    expect(skipTarget(-12000, 20000, -15000, true)).toBe(19000);
    expect(skipTarget(0, 20000, -15000)).toBe(19000);
  });
});

describe('BreakTracker', () => {
  const breaks = [
    { startTime: 10000, endTime: 15000 },
    { startTime: 20000, endTime: 20500 }, // shorter than MIN_BREAK_DURATION: no effect
  ];

  it('only tracks breaks with effect, ending BREAK_FADE_DURATION early', () => {
    expect(breakPeriods(breaks)).toEqual([{ start: 10000, end: 15000 - BREAK_FADE_DURATION }]);
  });

  it('is break time before gameplay start and after completion', () => {
    const t = new BreakTracker(3000, breaks);
    t.update(0, false);
    expect(t.isBreakTime).toBe(true);
    t.update(5000, false);
    expect(t.isBreakTime).toBe(false);
    t.update(12000, false);
    expect(t.isBreakTime).toBe(true);
    expect(t.currentPeriod).toEqual({ start: 10000, end: 14675 });
    t.update(14800, false);
    expect(t.isBreakTime).toBe(false);
    expect(t.currentPeriod).toBeNull();
    t.update(20200, false);
    expect(t.isBreakTime).toBe(false);
    t.update(30000, true);
    expect(t.isBreakTime).toBe(true);
  });
});

describe('Anim (TransformTo semantics)', () => {
  it('starts from the value at the transform start time', () => {
    const a = new Anim(0);
    a.to(1, 100, Easing.None, 0);
    expect(a.valueAt(50)).toBeCloseTo(0.5);
    a.to(0, 100, Easing.None, 50);
    expect(a.valueAt(50)).toBeCloseTo(0.5);
    expect(a.valueAt(100)).toBeCloseTo(0.25);
    expect(a.valueAt(200)).toBe(0);
  });

  it('chains with then() and delays', () => {
    const a = new Anim(1);
    a.set(1.3, 0).then(1, 500, Easing.OutQuint);
    expect(a.valueAt(0)).toBeCloseTo(1.3);
    expect(a.valueAt(500)).toBe(1);
    const b = new Anim(0);
    b.to(1, 100, Easing.None, 0).then(0, 100, Easing.None, 1000);
    expect(b.valueAt(500)).toBe(1);
    expect(b.valueAt(1150)).toBeCloseTo(0.5);
  });

  it('damps continuously like Interpolation.DampContinuously', () => {
    expect(dampContinuously(0, 1, 50, 50)).toBeCloseTo(0.5);
    expect(dampContinuously(0, 1, 50, 100)).toBeCloseTo(0.75);
  });
});

describe('HUD helpers', () => {
  it('formats accuracy without rounding up (FormatAccuracy)', () => {
    expect(formatAccuracy(1)).toBe('100.00%');
    expect(formatAccuracy(0.99999)).toBe('99.99%');
    expect(formatAccuracy(0.9542)).toBe('95.42%');
  });

  it('builds SegmentedGraph tiers', () => {
    const segs = segmentedGraph([0, 5, 10, 5], 5);
    // tier 0 covers everything; the top tier (5) only the maximum.
    expect(segs.filter(s => s.tier === 0)).toEqual([{ tier: 0, start: 0, end: 1 }]);
    expect(segs.filter(s => s.tier === 4)).toEqual([{ tier: 4, start: 0.5, end: 0.75 }]);
  });
});
