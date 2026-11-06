// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Transform sequence semantics used by the legacy skin pieces (osu-framework transforms).

import { describe, expect, it } from 'vitest';
import { Easing, Prop, applyEasing, valueAt } from '../../src/game/skinning/Transforms';

describe('Transforms', () => {
  it('chains transforms from the value at their start time', () => {
    // LegacyJudgementPieceOld hit scale: 0.6 -> 1.1 (96ms) -> delay 24 -> 0.9 (24ms) -> 0.95 -> 1 (24ms)
    const p = new Prop(1).set(0, 0.6).add(0, 96, 1.1).add(120, 24, 0.9).set(144, 0.95).add(144, 24, 1);
    expect(p.at(0)).toBeCloseTo(0.6);
    expect(p.at(48)).toBeCloseTo(0.85);
    expect(p.at(100)).toBeCloseTo(1.1);
    expect(p.at(132)).toBeCloseTo(1.0);
    expect(p.at(156)).toBeCloseTo(0.975);
    expect(p.at(1000)).toBeCloseTo(1);
  });

  it('removes transforms which start after a newly added one', () => {
    // missed tick: FadeInFromZero(120); Delay(500).FadeOut(600); then Delay(250).FadeOut(600) replaces the later fade.
    const a = new Prop(0).add(0, 120, 1, Easing.None, 0).add(500, 600, 0).add(250, 600, 0);
    expect(a.at(250)).toBeCloseTo(1);
    expect(a.at(550)).toBeCloseTo(0.5);
    expect(a.at(850)).toBeCloseTo(0);
  });

  it('matches osu-framework easing functions', () => {
    expect(applyEasing(Easing.Out, 0.5)).toBeCloseTo(0.75);
    expect(applyEasing(Easing.In, 0.5)).toBeCloseTo(0.25);
    expect(applyEasing(Easing.OutQuint, 0.5)).toBeCloseTo(1 - 1 / 32);
    expect(applyEasing(Easing.OutElasticHalf, 1)).toBeCloseTo(1, 2);
    expect(valueAt(150, 1.3, 1, 0, 300)).toBeCloseTo(1.15);
  });
});
