// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Unit tests for the osu!mania ruleset: hand-reasoned convert, hit windows, scoring, health, mods, bindings, autoplay.

import { describe, expect, it } from 'vitest';
import { LegacyRandom } from '../../src/framework/math';
import { LegacyBeatmapDecoder } from '../../src/game/beatmaps/LegacyBeatmapDecoder';
import { ModSet } from '../../src/game/mods/Mods';
import { HitResult } from '../../src/game/scoring/HitResult';
import type { JudgementResult } from '../../src/game/scoring/Judgement';
import { maniaRuleset } from '../../src/game/rulesets/mania';
import { conversionDifficultyFromBeatmap, ManiaBeatmapConverter } from '../../src/game/rulesets/mania/beatmaps/ManiaBeatmapConverter';
import type { ManiaPlayableBeatmap } from '../../src/game/rulesets/mania/ManiaPlayableBeatmap';
import { HeadNote, HoldNote, HoldNoteBody, Note, TailNote, type ManiaHitObject } from '../../src/game/rulesets/mania/objects/ManiaHitObject';
import { ManiaHealthProcessor } from '../../src/game/rulesets/mania/scoring/ManiaHealthProcessor';
import { ManiaHitWindows } from '../../src/game/rulesets/mania/scoring/ManiaHitWindows';
import { ManiaScoreProcessor } from '../../src/game/rulesets/mania/scoring/ManiaScoreProcessor';
import type { ScoreRank } from '../../src/game/scoring/ScoreRank';
import { buildPlayable, hold, note, play } from './helpers';

// A small osu!standard map. Expected output reasoned through ManiaBeatmapConverter / HitCirclePatternGenerator / SpinnerPatternGenerator:
//  - 1 of 5 objects has an end time (20%), rounded CS 4 < 5, rounded OD 5 is not > 5  => 6 keys.
//  - seed = round(HP 0 + CS 4) * 20 + (int)(OD 5 * 41.2) + round(AR 4) = 80 + 206 + 4 = 290.
//  - conversion difficulty = ((0 + clamp(4, 4, 7)) / 1.5 + 5 / 4s * 9) / 38 * 5 / 1.15 ~= 1.59 (<= 2): single random notes.
//  1. circle x=100 @1000: LowProbability (no density yet) -> 1 note (1 rng draw) at floor(100 / (512/6)) = column 1.
//  2. circle x=100 @2000: same position, density 500 >= 500/2.5 -> Reverse: copies column 1 mirrored -> 6 - 1 - 1 = column 4 (no rng).
//  3. circle x=400 @3000: LowProbability -> 1 note (1 rng draw) at floor(400 / 85.33) = column 4.
//  4. circle x=500 @4000 with clap: Gathered, clap forces 2 notes (1 rng draw): column 5, then the next gathered column (6 wraps to 0).
//  5. spinner 5000-6000: ForceNotStack against {0, 5}: random columns from LegacyRandom(290) after 3 draws are 5, 5, 3 => hold in column 3.
const SMALL_CONVERT = `osu file format v14

[General]
Mode: 0

[Difficulty]
HPDrainRate:0
CircleSize:4
OverallDifficulty:5
ApproachRate:4
SliderMultiplier:1.4
SliderTickRate:1

[TimingPoints]
0,500,4,2,0,100,1,0

[HitObjects]
100,100,1000,1,0,0:0:0:0:
100,100,2000,1,0,0:0:0:0:
400,300,3000,1,0,0:0:0:0:
500,300,4000,1,8,0:0:0:0:
256,192,5000,12,0,6000,0:0:0:0:
`;

const simplify = (objects: ManiaHitObject[]) =>
  objects.map(h => ({ start: h.startTime, end: h.endTime, column: h.column, hold: h instanceof HoldNote })).sort((a, b) => a.start - b.start || a.column - b.column);

describe('convert (hand-reasoned)', () => {
  it('converts a small osu! map to 6K', () => {
    const beatmap = LegacyBeatmapDecoder.decode(SMALL_CONVERT);
    const playable = maniaRuleset.createPlayable(beatmap, new ModSet()) as ManiaPlayableBeatmap;

    expect(playable.variant).toBe('6K');
    expect(simplify(playable.hitObjects)).toEqual([
      { start: 1000, end: 1000, column: 1, hold: false },
      { start: 2000, end: 2000, column: 4, hold: false },
      { start: 3000, end: 3000, column: 4, hold: false },
      { start: 4000, end: 4000, column: 0, hold: false },
      { start: 4000, end: 4000, column: 5, hold: false },
      { start: 5000, end: 6000, column: 3, hold: true },
    ]);
  });

  it('uses the expected seed and rng draws', () => {
    const beatmap = LegacyBeatmapDecoder.decode(SMALL_CONVERT);
    const converter = new ManiaBeatmapConverter(conversionDifficultyFromBeatmap(beatmap));
    converter.convert(beatmap);

    const reference = new LegacyRandom(290);
    for (let i = 0; i < 3; i++) reference.nextDouble();
    expect([reference.nextRange(0, 6), reference.nextRange(0, 6), reference.nextRange(0, 6)]).toEqual([5, 5, 3]);
    // The converter's generator must be in the same state.
    expect(converter.random.nextUInt()).toBe(reference.nextUInt());
  });

  it('applies key mods to converts only', () => {
    const beatmap = LegacyBeatmapDecoder.decode(SMALL_CONVERT);
    const playable = maniaRuleset.createPlayable(beatmap, new ModSet(['4K'])) as ManiaPlayableBeatmap;
    expect(playable.variant).toBe('4K');
    expect(playable.hitObjects.every(h => h.column >= 0 && h.column < 4)).toBe(true);

    const native = LegacyBeatmapDecoder.decode(SMALL_CONVERT.replace('Mode: 0', 'Mode: 3').replace('CircleSize:4', 'CircleSize:7'));
    const nativePlayable = maniaRuleset.createPlayable(native, new ModSet(['4K'])) as ManiaPlayableBeatmap;
    expect(nativePlayable.variant).toBe('7K');
    // Native columns: floor(x * 7 / 512)
    expect(nativePlayable.hitObjects.slice(0, 4).map(h => h.column)).toEqual([1, 1, 5, 6]);
  });

  it('mirrors columns', () => {
    const beatmap = LegacyBeatmapDecoder.decode(SMALL_CONVERT);
    const mirrored = maniaRuleset.createPlayable(beatmap, new ModSet(['MR'])) as ManiaPlayableBeatmap;
    expect(simplify(mirrored.hitObjects).map(o => o.column)).toEqual([4, 1, 1, 0, 5, 2]);
  });

  it('random mod permutes columns', () => {
    const beatmap = LegacyBeatmapDecoder.decode(SMALL_CONVERT);
    const random = maniaRuleset.createPlayable(beatmap, new ModSet(['RD'])) as ManiaPlayableBeatmap;
    expect(random.hitObjects.length).toBe(6);
    // Notes at 4000 are still on two different columns.
    const chord = random.hitObjects.filter(h => h.startTime === 4000).map(h => h.column);
    expect(new Set(chord).size).toBe(2);
  });

  it('only converts osu! and mania beatmaps', () => {
    const beatmap = LegacyBeatmapDecoder.decode(SMALL_CONVERT);
    expect(maniaRuleset.canConvert(beatmap)).toBe(true);
    beatmap.rulesetId = 1;
    expect(maniaRuleset.canConvert(beatmap)).toBe(false);
  });
});

describe('ManiaHitWindows', () => {
  const windows = (od: number, setup?: (w: ManiaHitWindows) => void) => {
    const w = new ManiaHitWindows();
    setup?.(w);
    w.setDifficulty(od);
    return [HitResult.Perfect, HitResult.Great, HitResult.Good, HitResult.Ok, HitResult.Meh, HitResult.Miss].map(r => w.windowFor(r));
  };

  it('OD ranges', () => {
    expect(windows(0)).toEqual([22.5, 64.5, 97.5, 127.5, 151.5, 188.5]);
    expect(windows(5)).toEqual([19.5, 49.5, 82.5, 112.5, 136.5, 173.5]);
    expect(windows(10)).toEqual([13.5, 34.5, 67.5, 97.5, 121.5, 158.5]);
  });

  it('hard rock / easy / rate multipliers', () => {
    expect(windows(5, w => (w.difficultyMultiplier = 1.4))).toEqual([13.5, 35.5, 58.5, 80.5, 97.5, 123.5]);
    expect(windows(5, w => (w.difficultyMultiplier = 1 / 1.4))).toEqual([27.5, 68.5, 114.5, 156.5, 190.5, 242.5]);
    expect(windows(5, w => (w.speedMultiplier = 1.5))).toEqual([29.5, 73.5, 123.5, 168.5, 204.5, 259.5]);
  });

  it('classic mod windows', () => {
    expect(
      windows(8, w => {
        w.classicModActive = true;
      }),
    ).toEqual([16.5, 40.5, 73.5, 103.5, 127.5, 164.5]);
    expect(
      windows(8, w => {
        w.classicModActive = true;
        w.isConvert = true;
      }),
    ).toEqual([16.5, 34.5, 67.5, 97.5, 121.5, 158.5]);
  });

  it('result lookup', () => {
    const w = new ManiaHitWindows();
    w.setDifficulty(5);
    expect(w.resultFor(0)).toBe(HitResult.Perfect);
    expect(w.resultFor(-19.5)).toBe(HitResult.Perfect);
    expect(w.resultFor(20)).toBe(HitResult.Great);
    expect(w.resultFor(-150)).toBe(HitResult.Miss);
    expect(w.resultFor(174)).toBe(HitResult.None);
    expect(w.canBeHit(136.5)).toBe(true);
    expect(w.canBeHit(137)).toBe(false);
  });

  it('mods are applied to playable hit windows', () => {
    const p = buildPlayable([note(1000), hold(2000, 500)], { mods: ['HR'] });
    expect(p.hitObjects[0].hitWindows!.windowFor(HitResult.Great)).toBe(35.5);
    const h = p.hitObjects[1] as HoldNote;
    expect(h.hitWindows).toBeNull();
    expect(h.head!.hitWindows!.windowFor(HitResult.Great)).toBe(35.5);
    expect(h.tail!.hitWindows!.windowFor(HitResult.Great)).toBe(35.5);
  });
});

describe('ManiaScoreProcessor', () => {
  it('ranks (ManiaScoreProcessorTest)', () => {
    const cases: [ScoreRank, number, HitResult[]][] = [
      ['X', 1, [HitResult.Perfect]],
      ['X', 0.99, [HitResult.Great]],
      ['D', 0.1, [HitResult.Great]],
      ['X', 0.99, [HitResult.Perfect, HitResult.Great]],
      ['X', 0.99, [HitResult.Great, HitResult.Great]],
      ['S', 0.99, [HitResult.Perfect, HitResult.Good]],
      ['S', 0.99, [HitResult.Perfect, HitResult.Ok]],
      ['S', 0.99, [HitResult.Perfect, HitResult.Meh]],
      ['S', 0.99, [HitResult.Perfect, HitResult.Miss]],
      ['S', 0.99, [HitResult.Great, HitResult.Good]],
      ['S', 0.99, [HitResult.Great, HitResult.Ok]],
      ['S', 0.99, [HitResult.Great, HitResult.Meh]],
      ['S', 0.99, [HitResult.Great, HitResult.Miss]],
    ];
    const sp = new ManiaScoreProcessor();
    for (const [expected, accuracy, results] of cases) {
      const map = new Map<HitResult, number>();
      for (const r of results) map.set(r, (map.get(r) ?? 0) + 1);
      expect(sp.rankFromScore(accuracy, map), `${results}`).toBe(expected);
    }
  });

  it('base scores', () => {
    const sp = new ManiaScoreProcessor();
    expect(sp.getBaseScoreForResult(HitResult.Perfect)).toBe(305);
    expect(sp.getBaseScoreForResult(HitResult.Great)).toBe(300);
    expect(sp.getBaseScoreForResult(HitResult.Good)).toBe(200);
    expect(sp.getBaseScoreForResult(HitResult.Ok)).toBe(100);
    expect(sp.getBaseScoreForResult(HitResult.Meh)).toBe(50);
  });

  it('perfect results are in judgement order with nested objects', () => {
    const p = buildPlayable([note(1000, 1), hold(500, 500, 0), note(1000, 0)]);
    const results = p.perfectResults();
    const describe = (r: JudgementResult) => `${r.tag}@${r.objectEndTime}:${(r.hitObject as ManiaHitObject).column}`;
    // Stable sort: the tail (enumerated before the notes) wins the tie against the column-0 note.
    expect(results.map(describe)).toEqual(['head@500:0', 'tail@1000:0', 'note@1000:0', 'note@1000:1', 'body@1000:0', 'hold@1000:0']);
    expect(results.map(r => r.type)).toEqual([HitResult.Perfect, HitResult.Perfect, HitResult.Perfect, HitResult.Perfect, HitResult.IgnoreHit, HitResult.IgnoreHit]);
  });

  it('a perfect autoplay gives 1M score, 100% accuracy and SS', () => {
    const objects: ManiaHitObject[] = [];
    for (let i = 0; i < 40; i++) objects.push(i % 5 === 0 ? hold(1000 + i * 250, 180, i % 4) : note(1000 + i * 250, i % 4));
    const p = buildPlayable(objects, { od: 8 });
    const r = play(p, [], { autoplay: true });
    expect(r.drawable.hasCompleted).toBe(true);
    expect(r.results.length).toBe(p.perfectResults().length);
    expect(r.score.totalScore).toBe(1000000);
    expect(r.score.accuracy).toBe(1);
    expect(r.score.rank).toBe('X');
    expect(r.score.highestCombo).toBe(r.score.maximumCombo);
    expect(r.results.filter(j => j.hitObject instanceof Note).every(j => j.type === HitResult.Perfect)).toBe(true);
  });

  it('autoplay of a converted beatmap with DT is perfect', () => {
    const beatmap = LegacyBeatmapDecoder.decode(SMALL_CONVERT);
    const p = maniaRuleset.createPlayable(beatmap, new ModSet(['DT'])) as ManiaPlayableBeatmap;
    const r = play(p, [], { autoplay: true });
    expect(r.score.totalScore).toBe(1000000);
  });

  it('missing everything gives zero score', () => {
    const p = buildPlayable([note(1000), note(1500, 1), hold(2000, 400, 2)]);
    const r = play(p, []);
    expect(r.drawable.hasCompleted).toBe(true);
    expect(r.score.totalScore).toBe(0);
    expect(r.results.filter(j => j.hitObject instanceof Note).every(j => j.type === HitResult.Miss)).toBe(true);
  });

  it('note lock: hitting a later note misses earlier ones in the column', () => {
    const first = note(1000);
    const second = note(1100);
    const p = buildPlayable([first, second]);
    // At 1105 the first note is not hittable any more (time >= next object start), so the second one is hit and the first is missed.
    const r = play(p, [
      { time: 1105, columns: [0] },
      { time: 1150, columns: [] },
    ]);
    expect(r.results.find(j => j.hitObject === second)!.type).toBe(HitResult.Perfect);
    expect(r.results.find(j => j.hitObject === first)!.type).toBe(HitResult.Miss);
    // The hit is applied before the forced miss.
    expect(r.results.findIndex(j => j.hitObject === second)).toBeLessThan(r.results.findIndex(j => j.hitObject === first));
  });
});

describe('ManiaHealthProcessor (ManiaHealthProcessorTest)', () => {
  const make = (objects: ManiaHitObject[]) => {
    const p = buildPlayable(objects);
    const hp = new ManiaHealthProcessor(0, p.hitObjects, p.difficulty.drainRate, p.breaks);
    hp.applyBeatmap(p.perfectResults(), p.difficulty.drainRate, p.breaks, 1000, p.objectTimes);
    return hp;
  };

  it('has no drain', () => {
    const hp = make([note(0), note(1000)]);
    expect(hp.drainRate).toBe(0);
  });

  const nestedCases: [string, () => { objects: ManiaHitObject[]; target: (objs: ManiaHitObject[]) => ManiaHitObject }, number][] = [
    ['note', () => ({ objects: [note(0)], target: o => o[0] }), 0.01],
    ['head', () => ({ objects: [hold(0, 500)], target: o => (o[0] as HoldNote).head! }), 0.01],
    ['tail', () => ({ objects: [hold(0, 500)], target: o => (o[0] as HoldNote).tail! }), 0.01],
    ['body', () => ({ objects: [hold(0, 500)], target: o => (o[0] as HoldNote).body! }), 0],
    ['hold', () => ({ objects: [hold(0, 500)], target: o => o[0] }), 0],
  ];

  for (const [name, setup, startingHealth] of nestedCases) {
    it(`fails after min result (${name})`, () => {
      const { objects, target } = setup();
      const hp = make(objects);
      hp.health = startingHealth;
      const t = target(objects);
      hp.applyResult({ hitObject: t, judgement: t.judgement, type: t.judgement.minResult, timeOffset: 0, objectEndTime: t.endTime });
      expect(hp.failed).toBe(true);
    });

    it(`does not fail after max result (${name})`, () => {
      const { objects, target } = setup();
      const hp = make(objects);
      hp.health = startingHealth;
      const t = target(objects);
      hp.applyResult({ hitObject: t, judgement: t.judgement, type: t.judgement.maxResult, timeOffset: 0, objectEndTime: t.endTime });
      expect(hp.failed).toBe(false);
    });
  }

  it('health increases', () => {
    const hp = make([note(0)]);
    const n = new Note();
    expect(hp.healthIncreaseFor(n, HitResult.Miss)).toBeCloseTo(-(5 + 1) * 0.0075);
    expect(hp.healthIncreaseFor(new HeadNote(), HitResult.Miss)).toBeCloseTo(-(5 + 1) * 0.00375);
    expect(hp.healthIncreaseFor(new TailNote(), HitResult.Miss)).toBeCloseTo(-(5 + 1) * 0.00375);
    expect(hp.healthIncreaseFor(n, HitResult.Meh)).toBeCloseTo(-(5 + 1) * 0.0016);
    expect(hp.healthIncreaseFor(n, HitResult.Ok)).toBe(0);
    expect(hp.healthIncreaseFor(new HoldNoteBody(), HitResult.ComboBreak)).toBe(0);
    expect(hp.healthIncreaseFor(n, HitResult.Perfect)).toBeCloseTo(hp.hpMultiplierNormal * (0.0055 - 5 * 0.0005));
    expect(hp.hpMultiplierNormal).toBeGreaterThanOrEqual(1);
  });

  it('easy gives extra lives', () => {
    const p = buildPlayable([note(0)]);
    const hp = new ManiaHealthProcessor(0, p.hitObjects, p.difficulty.drainRate, p.breaks, 2);
    hp.applyBeatmap(p.perfectResults(), p.difficulty.drainRate, p.breaks, 0, p.objectTimes);
    const n = p.hitObjects[0];
    const miss = () => {
      hp.health = 0.01;
      hp.applyResult({ hitObject: n, judgement: n.judgement, type: HitResult.Miss, timeOffset: 0, objectEndTime: 0 });
    };
    miss();
    expect(hp.failed).toBe(false);
    expect(hp.health).toBeGreaterThan(0.9);
    miss();
    expect(hp.failed).toBe(false);
    miss();
    expect(hp.failed).toBe(true);
  });
});

describe('mods and multipliers (ManiaScoreMultiplierTest)', () => {
  it('score multipliers', () => {
    const m = (...mods: string[]) => maniaRuleset.scoreMultiplier(new ModSet(mods));
    expect(m()).toBe(1);
    expect(m('EZ')).toBe(0.5);
    expect(m('NF')).toBe(0.5);
    expect(m('HT')).toBeCloseTo(0.3);
    expect(m('DC')).toBeCloseTo(0.3);
    expect(m('HR')).toBe(1);
    expect(m('DT')).toBe(1);
    expect(m('NC')).toBe(1);
    expect(m('HD')).toBe(1);
    expect(m('FL')).toBe(1);
    expect(m('MR')).toBe(1);
    expect(m('RD')).toBe(1);
    expect(m('4K')).toBe(0.9);
    expect(m('EZ', 'NF')).toBe(0.25);
  });
});

describe('input', () => {
  it('default key bindings (VariantMappingGenerator)', () => {
    const keys = (v: string) => Object.values(maniaRuleset.defaultBindings(v)).map(k => k[0]);
    expect(keys('1K')).toEqual(['Space']);
    expect(keys('4K')).toEqual(['KeyD', 'KeyF', 'KeyJ', 'KeyK']);
    expect(keys('5K')).toEqual(['KeyD', 'KeyF', 'Space', 'KeyJ', 'KeyK']);
    expect(keys('7K')).toEqual(['KeyS', 'KeyD', 'KeyF', 'Space', 'KeyJ', 'KeyK', 'KeyL']);
    expect(keys('8K')).toEqual(['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyJ', 'KeyK', 'KeyL', 'Semicolon']);
    expect(keys('10K')).toEqual(['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyV', 'KeyN', 'KeyJ', 'KeyK', 'KeyL', 'Semicolon']);
    expect(Object.keys(maniaRuleset.defaultBindings('4K'))).toEqual(['K1', 'K2', 'K3', 'K4']);
    expect(keys('5K+5K')).toEqual(['KeyE', 'KeyR', 'KeyV', 'KeyI', 'KeyO', 'KeyF', 'KeyG', 'KeyB', 'KeyJ', 'KeyK']);
    expect(maniaRuleset.actions('7K').map(a => a.id)).toEqual(['K1', 'K2', 'K3', 'K4', 'K5', 'K6', 'K7']);
  });
});
