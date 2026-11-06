// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Unit tests for the osu!taiko port: conversion, hit windows, scoring (TaikoScoreProcessorTest / TaikoHealthProcessorTest),
// gameplay judging (DrawableHit / strong second hits / drum rolls / swells) and autoplay.

import { describe, expect, it } from 'vitest';
import type { HitSampleInfo } from '../../src/game/audio/HitSampleInfo';
import { LegacyBeatmapDecoder } from '../../src/game/beatmaps/LegacyBeatmapDecoder';
import { ModSet } from '../../src/game/mods/Mods';
import { HitResult } from '../../src/game/scoring/HitResult';
import { judgement, type JudgementResult } from '../../src/game/scoring/Judgement';
import type { GameplayContext } from '../../src/game/rulesets/Ruleset';
import { taikoRuleset, type TaikoPlayableBeatmap } from '../../src/game/rulesets/taiko';
import { DotNetRandom } from '../../src/game/rulesets/taiko/DotNetRandom';
import { DrawableTaikoRuleset } from '../../src/game/rulesets/taiko/DrawableTaikoRuleset';
import { DrumRoll, DrumRollTick, Hit, HitType, StrongNestedHitObject, Swell, TaikoHitObject } from '../../src/game/rulesets/taiko/objects';
import { TaikoHealthProcessor, TaikoScoreProcessor, taikoScoreMultiplier } from '../../src/game/rulesets/taiko/scoring';
import { TaikoHitWindows } from '../../src/game/rulesets/taiko/TaikoHitWindows';
import { createSkin } from '../../src/game/Skin';

function osu(mode: number, hitObjects: string[], extra: { timing?: string[]; od?: number; sv?: number; tickRate?: number } = {}): string {
  return [
    'osu file format v14',
    '',
    '[General]',
    `Mode: ${mode}`,
    '',
    '[Difficulty]',
    'HPDrainRate:5',
    'CircleSize:4',
    `OverallDifficulty:${extra.od ?? 5}`,
    'ApproachRate:5',
    `SliderMultiplier:${extra.sv ?? 1.4}`,
    `SliderTickRate:${extra.tickRate ?? 1}`,
    '',
    '[TimingPoints]',
    ...(extra.timing ?? ['0,500,4,1,0,100,1,0']),
    '',
    '[HitObjects]',
    ...hitObjects,
  ].join('\n');
}

const playableOf = (text: string, mods: string[] = []) => taikoRuleset.createPlayable(LegacyBeatmapDecoder.decode(text), new ModSet(mods)) as TaikoPlayableBeatmap;

function makeCtx(mods: string[] = [], autoplay = false) {
  const results: JudgementResult[] = [];
  const samples: HitSampleInfo[][] = [];
  const ctx: GameplayContext = {
    mods: new ModSet(mods),
    skin: createSkin(null),
    settings: { get: <T>(_k: string, f: T) => f },
    autoplay,
    rate: 1,
    applyResult: r => results.push(r),
    playSamples: s => samples.push([...s]),
    startLoop: () => null,
    isPressed: () => false,
    combo: 0,
    health: 1,
  };
  return { ctx, results, samples };
}

describe('conversion', () => {
  it('converts circles by hitsound: clap/whistle = rim, finish = strong', () => {
    const p = playableOf(osu(0, ['256,192,1000,1,0', '256,192,1500,1,2', '256,192,2000,1,8', '256,192,2500,1,4', '256,192,3000,1,6']));
    const hits = p.hitObjects as Hit[];
    expect(hits.map(h => h.type)).toEqual([HitType.Centre, HitType.Rim, HitType.Rim, HitType.Centre, HitType.Rim]);
    expect(hits.map(h => h.isStrong)).toEqual([false, false, false, true, true]);
    // Strong hits get a nested strong hit at the same time.
    expect(hits[3].nested.length).toBe(1);
    expect(hits[3].nested[0]).toBeInstanceOf(StrongNestedHitObject);
    expect(hits[0].nested.length).toBe(0);
  });

  it('converts spinners to swells with RequiredSwellHitsPerSecond', () => {
    const p = playableOf(osu(0, ['256,192,1000,12,0,3000']));
    const swell = p.hitObjects[0] as Swell;
    expect(swell).toBeInstanceOf(Swell);
    expect(swell.duration).toBe(2000);
    // OD5: DifficultyRange(5, 3, 5, 7.5) * 1.65f = 8.25 per second -> (int)(2 * 8.25) = 16
    expect(swell.requiredHits).toBe(16);
    expect(swell.nested.length).toBe(16);
  });

  it('long sliders become drum rolls with ticks; short ones become hits', () => {
    // 1 beat = 500ms. Slider length 280 = 2 beats at SV 1.4 -> drum roll (osu duration >= 2 beats).
    const p = playableOf(osu(0, ['0,192,1000,2,0,L|280:192,1,280', '0,192,4000,2,0,L|70:192,1,70']));
    const roll = p.hitObjects[0] as DrumRoll;
    expect(roll).toBeInstanceOf(DrumRoll);
    // taikoDuration = (int)(280 * 1.4f / (100 * 1.4 * 1.4f) * 500) = 1000 (float error -> 999)
    expect(roll.duration).toBeGreaterThanOrEqual(999);
    expect(roll.duration).toBeLessThanOrEqual(1000);
    // tickRate 4 per beat -> tickSpacing 125 -> ticks at t < end + 62.5
    const ticks = roll.nested.filter(n => n instanceof DrumRollTick) as DrumRollTick[];
    expect(ticks.length).toBe(9);
    expect(ticks[0].firstTick).toBe(true);
    expect(ticks[1].startTime - ticks[0].startTime).toBe(125);
    // Short slider (half a beat) is split into hits spaced by min(beatLength / tickRate, duration / spans).
    const rest = p.hitObjects.slice(1);
    expect(rest.every(h => h instanceof Hit)).toBe(true);
    expect(rest.map(h => h.startTime)).toEqual([4000, 4250]);
  });

  it('native taiko sliders are always drum rolls', () => {
    const p = playableOf(osu(1, ['0,192,4000,2,0,L|70:192,1,70']));
    expect(p.hitObjects.length).toBe(1);
    expect(p.hitObjects[0]).toBeInstanceOf(DrumRoll);
  });

  it('transforms osu! slider velocity changes into scroll speed changes', () => {
    const p = playableOf(osu(0, ['0,192,1000,2,0,L|100:192,1,100', '0,192,3000,2,0,L|100:192,1,100'], { timing: ['0,500,4,1,0,100,1,0', '2500,-50,4,1,0,100,0,0'] }));
    expect(p.controlPoints.effectPointAt(1000).scrollSpeed).toBe(1);
    expect(p.controlPoints.effectPointAt(3000).scrollSpeed).toBe(2);
    // The source beatmap is not modified.
    expect(p.source.controlPoints.effectPointAt(3000).scrollSpeed).toBe(1);
  });

  it('mania objects at the same time become a single strong hit', () => {
    const p = playableOf(osu(3, ['64,192,1000,1,0', '192,192,1000,1,0', '320,192,2000,1,0']));
    expect(p.hitObjects.length).toBe(2);
    expect((p.hitObjects[0] as Hit).isStrong).toBe(true);
    expect((p.hitObjects[1] as Hit).isStrong).toBe(false);
  });

  it('HR / EZ adjust OD, HP and slider multiplier like TaikoModHardRock / TaikoModEasy', () => {
    const text = osu(0, ['256,192,1000,1,0'], { od: 5, sv: 1.5 });
    const hr = playableOf(text, ['HR']);
    expect(hr.difficulty.overallDifficulty).toBeCloseTo(7, 5);
    expect(hr.difficulty.drainRate).toBeCloseTo(7, 5);
    expect(hr.difficulty.sliderMultiplier).toBeCloseTo((1.5 * 1.4 * 4) / 3, 10);
    const ez = playableOf(text, ['EZ']);
    expect(ez.difficulty.overallDifficulty).toBeCloseTo(2.5, 5);
    expect(ez.difficulty.sliderMultiplier).toBeCloseTo(1.2, 10);
  });

  it('Random swaps colours deterministically for a seed', () => {
    const objects = Array.from({ length: 40 }, (_, i) => `256,192,${1000 + i * 100},1,0`);
    const a = taikoRuleset.createPlayable(LegacyBeatmapDecoder.decode(osu(0, objects)), new ModSet(['RD'])) as TaikoPlayableBeatmap;
    expect(a.randomSeed).not.toBeNull();
    const types = (a.hitObjects as Hit[]).map(h => h.type);
    expect(types.some(t => t === HitType.Rim)).toBe(true);
    expect(types.some(t => t === HitType.Centre)).toBe(true);
  });

  it('generates bar lines', () => {
    const p = playableOf(osu(1, ['256,192,0,1,0', '256,192,4000,1,0']));
    expect(p.barLines.length).toBeGreaterThan(0);
    expect(p.barLines[0].major).toBe(true);
  });
});

describe('DotNetRandom', () => {
  it('matches System.Random(seed) output', () => {
    expect(new DotNetRandom(0).next()).toBe(1559595546);
    expect(new DotNetRandom(1).next()).toBe(534011718);
  });
});

describe('TaikoHitWindows', () => {
  it('uses floored windows minus 0.5', () => {
    const w = new TaikoHitWindows();
    w.setDifficulty(5);
    expect(w.windowFor(HitResult.Great)).toBe(34.5);
    expect(w.windowFor(HitResult.Ok)).toBe(79.5);
    expect(w.windowFor(HitResult.Miss)).toBe(94.5);
    expect(w.resultFor(30)).toBe(HitResult.Great);
    expect(w.resultFor(-60)).toBe(HitResult.Ok);
    expect(w.resultFor(90)).toBe(HitResult.Miss);
    expect(w.resultFor(100)).toBe(HitResult.None);
    expect(w.canBeHit(79)).toBe(true);
    expect(w.canBeHit(80)).toBe(false);
    w.setDifficulty(10);
    expect(w.windowFor(HitResult.Great)).toBe(19.5);
    w.setDifficulty(0);
    expect(w.windowFor(HitResult.Ok)).toBe(119.5);
  });
});

function result(h: TaikoHitObject, type: HitResult): JudgementResult {
  return { hitObject: h, judgement: h.judgement, type, timeOffset: 0, objectEndTime: h.endTime, tag: h.kind };
}

describe('TaikoScoreProcessor', () => {
  it('TestInaccurateHitScore', () => {
    const a = new Hit();
    const b = new Hit();
    b.startTime = 1000;
    const sp = new TaikoScoreProcessor();
    sp.applyBeatmap([result(a, HitResult.Great), result(b, HitResult.Great)]);
    sp.applyResult(result(a, HitResult.Great));
    sp.applyResult(result(b, HitResult.Ok));
    expect(sp.totalScore).toBe(453745);
    expect(sp.accuracy).toBeCloseTo(0.75, 4);
  });

  it('perfect play gives 1M plus strong bonus; misses cap rank at A', () => {
    const p = playableOf(osu(0, ['256,192,1000,1,4', '256,192,1500,1,0', '256,192,2000,1,0']));
    const sp = new TaikoScoreProcessor();
    const perfect = p.perfectResults();
    sp.applyBeatmap(perfect);
    for (const r of perfect) sp.applyResult({ ...r });
    // Strong bonus: LargeBonus 50 * 7
    expect(sp.totalScore).toBe(1000000 + 350);
    expect(sp.rank).toBe('X');
    expect(sp.rankFromScore(0.97, new Map([[HitResult.Miss, 1]]))).toBe('A');
    expect(sp.rankFromScore(0.97, new Map())).toBe('S');
  });

  it('score multipliers', () => {
    expect(taikoScoreMultiplier(new ModSet(['HD', 'HR']))).toBeCloseTo(1.06 * 1.06, 10);
    expect(taikoScoreMultiplier(new ModSet(['DT']))).toBeCloseTo(1.1, 10);
    expect(taikoScoreMultiplier(new ModSet(['HT']))).toBeCloseTo(0.3, 10);
    expect(taikoScoreMultiplier(new ModSet(['FL', 'EZ']))).toBeCloseTo(0.56, 10);
    expect(taikoScoreMultiplier(new ModSet(['RX']))).toBeCloseTo(0.1, 10);
  });
});

describe('TaikoHealthProcessor', () => {
  const fiveHits = () =>
    Array.from({ length: 5 }, (_, i) => {
      const h = new Hit();
      h.startTime = i * 1000;
      return h;
    });

  const run = (objects: TaikoHitObject[], types: HitResult[]) => {
    const hp = new TaikoHealthProcessor();
    hp.applyBeatmap(objects.map(o => result(o, o.judgement.maxResult)), 5, [], 0);
    objects.forEach((o, i) => hp.applyResult(result(o, types[i])));
    return hp;
  };

  it('TestHitsOnlyGreat', () => {
    const hp = run(fiveHits(), Array(5).fill(HitResult.Great));
    expect(hp.health).toBe(1);
    expect(hp.failed).toBe(false);
  });

  it('TestHitsAboveThreshold', () => {
    const hp = run(fiveHits(), [HitResult.Great, HitResult.Ok, HitResult.Ok, HitResult.Ok, HitResult.Miss]);
    expect(hp.health).toBeGreaterThan(0.5);
    expect(hp.failed).toBe(false);
  });

  it('TestHitsBelowThreshold', () => {
    const hp = run(fiveHits(), [HitResult.Miss, HitResult.Ok, HitResult.Ok, HitResult.Ok, HitResult.Miss]);
    expect(hp.health).toBeLessThan(0.5);
    expect(hp.failed).toBe(true);
  });

  it('TestSwellOnly / TestMissHitAndHitSwell', () => {
    const p = playableOf(osu(0, ['256,192,1000,12,0,3000']));
    const hp = new TaikoHealthProcessor();
    hp.applyBeatmap(p.perfectResults(), 5, [], 0);
    for (const r of p.perfectResults()) hp.applyResult({ ...r });
    expect(hp.health).toBe(1);
    expect(hp.failed).toBe(false);

    const p2 = playableOf(osu(0, ['256,192,0,1,0', '256,192,1000,12,0,3000']));
    const hp2 = new TaikoHealthProcessor();
    const perfect = p2.perfectResults();
    hp2.applyBeatmap(perfect, 5, [], 0);
    for (const r of perfect) hp2.applyResult({ ...r, type: r.tag === 'hit' ? HitResult.Miss : r.type });
    expect(hp2.health).toBe(0);
    expect(hp2.failed).toBe(true);
  });
});

describe('gameplay', () => {
  const hitAt = (t: number, sound = 0) => `256,192,${t},1,${sound}`;

  it('judges hits by timing and colour', () => {
    const p = playableOf(osu(1, [hitAt(1000), hitAt(2000, 2), hitAt(3000), hitAt(4000)], { od: 5 }));
    const { ctx, results } = makeCtx();
    const d = new DrawableTaikoRuleset(p, ctx);
    d.update(990, 16);
    d.onPressed('LeftCentre', 1010); // +10ms: Great
    d.onReleased('LeftCentre', 1050);
    d.onPressed('LeftCentre', 2000); // wrong colour: Miss
    d.onReleased('LeftCentre', 2050);
    d.onPressed('RightCentre', 3060); // +60ms: Ok
    d.onReleased('RightCentre', 3100);
    d.update(5000, 16); // 4000 not hit: Miss
    expect(results.filter(r => r.tag === 'hit').map(r => r.type)).toEqual([HitResult.Great, HitResult.Miss, HitResult.Ok, HitResult.Miss]);
    expect(d.hasCompleted).toBe(true);
  });

  it('strong hits need a second key within 30ms', () => {
    const p = playableOf(osu(1, [hitAt(1000, 4), hitAt(2000, 4), hitAt(3000, 4)]));
    const { ctx, results } = makeCtx();
    const d = new DrawableTaikoRuleset(p, ctx);
    d.update(990, 16);
    d.onPressed('LeftCentre', 1000);
    d.onPressed('RightCentre', 1020); // within 30ms
    d.onReleased('LeftCentre', 1050);
    d.onReleased('RightCentre', 1050);
    d.onPressed('LeftCentre', 2000);
    d.onPressed('RightCentre', 2040); // too late
    d.onReleased('LeftCentre', 2100);
    d.onReleased('RightCentre', 2100);
    d.onPressed('LeftCentre', 3000);
    d.onReleased('LeftCentre', 3005); // released before second key
    d.onPressed('RightCentre', 3010);
    d.update(4000, 16);
    const strong = results.filter(r => r.tag === 'strong').map(r => r.type);
    expect(strong).toEqual([HitResult.LargeBonus, HitResult.IgnoreMiss, HitResult.IgnoreMiss]);
    expect(results.filter(r => r.tag === 'hit').every(r => r.type === HitResult.Great)).toBe(true);
  });

  it('swells require alternating centre/rim hits (unless Relax)', () => {
    const text = osu(0, ['256,192,1000,12,0,1500']); // 0.5s at OD5 -> 4 hits
    for (const relax of [false, true]) {
      const p = playableOf(text);
      expect((p.hitObjects[0] as Swell).requiredHits).toBe(4);
      const { ctx, results } = makeCtx(relax ? ['RX'] : []);
      const d = new DrawableTaikoRuleset(p, ctx);
      let t = 1000;
      for (let i = 0; i < 4; i++) {
        d.update(t, 16);
        d.onPressed('LeftCentre', t);
        d.onReleased('LeftCentre', t + 10);
        t += 50;
      }
      d.update(2000, 16);
      const swell = results.find(r => r.tag === 'swell')!;
      expect(swell.type).toBe(relax ? HitResult.LargeBonus : HitResult.IgnoreMiss);
    }
  });

  it('drum roll ticks are hit by any key within half a tick spacing', () => {
    const p = playableOf(osu(1, ['0,192,1000,2,0,L|280:192,1,280']));
    const roll = p.hitObjects[0] as DrumRoll;
    const ticks = roll.nested.filter(n => n instanceof DrumRollTick);
    const { ctx, results } = makeCtx();
    const d = new DrawableTaikoRuleset(p, ctx);
    let alt = false;
    for (const tick of ticks) {
      d.update(tick.startTime, 16);
      const a = alt ? 'RightRim' : 'LeftCentre';
      d.onPressed(a, tick.startTime + 5);
      d.onReleased(a, tick.startTime + 20);
      alt = !alt;
    }
    d.update(roll.endTime + 500, 16);
    const tickResults = results.filter(r => r.tag === 'drumrolltick');
    expect(tickResults.length).toBe(ticks.length);
    expect(tickResults.every(r => r.type === HitResult.SmallBonus)).toBe(true);
    expect(results.find(r => r.tag === 'drumroll')!.type).toBe(HitResult.IgnoreHit);
  });

  it('autoplay plays a perfect game (all judgements at max)', () => {
    const text = osu(0, [
      hitAt(1000),
      hitAt(1250, 2),
      hitAt(1500, 4),
      hitAt(1750, 6),
      '0,192,2000,2,4,L|280:192,1,280',
      '256,192,3500,12,0,4500',
      hitAt(5000),
      hitAt(5000 + 1000 / 8),
    ]);
    const p = playableOf(text);
    const { ctx, results, samples } = makeCtx(['AT'], true);
    const d = new DrawableTaikoRuleset(p, ctx);
    for (let t = 0; t <= 7000; t += 7) d.update(t, 7);
    expect(d.hasCompleted).toBe(true);
    const perfect = p.perfectResults();
    expect(results.length).toBe(perfect.length);
    for (const r of results) expect(r.type, `${r.tag}`).toBe(r.judgement.maxResult);
    expect(results.filter(r => r.tag === 'hit').every(r => r.timeOffset === 0)).toBe(true);
    expect(samples.length).toBeGreaterThan(0);

    const sp = new TaikoScoreProcessor();
    sp.applyBeatmap(perfect);
    for (const r of results) sp.applyResult(r);
    expect(sp.accuracy).toBe(1);
    expect(sp.totalScore).toBeGreaterThanOrEqual(1000000);
  });

  it('perfectResults lists every judgement including nested strong / ticks', () => {
    const p = playableOf(osu(1, [hitAt(1000, 4), '0,192,2000,2,4,L|280:192,1,280']));
    const r = p.perfectResults();
    const roll = p.hitObjects[1] as DrumRoll;
    const tickCount = roll.nested.filter(n => n instanceof DrumRollTick).length;
    // hit + strong, ticks + tick strongs, roll + roll strong
    expect(r.length).toBe(2 + tickCount * 2 + 2);
    expect(r.filter(x => x.judgement.maxResult === HitResult.LargeBonus).length).toBe(1 + tickCount);
    expect(judgement(HitResult.SmallBonus).minResult).toBe(HitResult.IgnoreMiss);
  });
});
