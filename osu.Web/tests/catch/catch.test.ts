// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.

import { describe, expect, it } from 'vitest';
import { f32 } from '../../src/framework/math';
import { LegacyBeatmapDecoder } from '../../src/game/beatmaps/LegacyBeatmapDecoder';
import { ModSet } from '../../src/game/mods/Mods';
import { HitResult } from '../../src/game/scoring/HitResult';
import type { JudgementResult } from '../../src/game/scoring/Judgement';
import { createSkin } from '../../src/game/Skin';
import type { GameplayContext } from '../../src/game/rulesets/Ruleset';
import { catchRuleset, CatchPlayableBeatmap } from '../../src/game/rulesets/catch';
import { calculateCatchWidth, CatcherState } from '../../src/game/rulesets/catch/CatcherLogic';
import { DrawableCatchRuleset } from '../../src/game/rulesets/catch/DrawableCatchRuleset';
import { Banana, BananaShower, Droplet, Fruit, JuiceStream, TinyDroplet, getPalpableObjects, statelessNextInt, statelessNextSingle } from '../../src/game/rulesets/catch/objects';

function osu(hitObjects: string[], opts: { mode?: number; cs?: number; ar?: number; hp?: number; sm?: number; tickRate?: number; version?: number } = {}): string {
  return `osu file format v${opts.version ?? 14}

[General]
AudioFilename: audio.mp3
Mode: ${opts.mode ?? 2}

[Metadata]
Title:test
Artist:test
Creator:test
Version:test

[Difficulty]
HPDrainRate:${opts.hp ?? 5}
CircleSize:${opts.cs ?? 5}
OverallDifficulty:5
ApproachRate:${opts.ar ?? 5}
SliderMultiplier:${opts.sm ?? 1}
SliderTickRate:${opts.tickRate ?? 1}

[TimingPoints]
0,500,4,2,0,100,1,0

[HitObjects]
${hitObjects.join('\n')}
`;
}

const play = (text: string, mods: string[] = []) => catchRuleset.createPlayable(LegacyBeatmapDecoder.decode(text), new ModSet(mods)) as CatchPlayableBeatmap;

function mockContext(mods: string[], autoplay: boolean, pressed: Set<string>, results: JudgementResult[]): GameplayContext {
  return {
    mods: new ModSet(mods),
    skin: createSkin(null),
    settings: { get: <T>(_k: string, fallback: T) => fallback },
    autoplay,
    rate: 1,
    applyResult: r => results.push(r),
    playSamples: () => {},
    startLoop: () => null,
    isPressed: a => pressed.has(a),
    combo: 0,
    health: 1,
  };
}

/** Runs a drawable ruleset at 60fps until every object is judged. */
function runGameplay(d: DrawableCatchRuleset, endTime: number, frame = 1000 / 60, onFrame?: (t: number) => void): void {
  for (let t = -2000; t <= endTime + 1000 && !d.hasCompleted; t += frame) {
    onFrame?.(t);
    d.update(t, frame);
  }
}

describe('osu!catch conversion', () => {
  const map = osu([
    '256,192,1000,5,0,0:0:0:0:', // fruit
    '100,192,2000,2,0,L|300:192,1,200', // juice stream, 200px
    '256,192,4000,12,0,5000,0:0:0:0:', // banana shower 4000-5000
  ]);

  it('converts objects to fruits, juice streams and banana showers', () => {
    const p = play(map);
    expect(p.hitObjects.map(h => h.kind)).toEqual(['fruit', 'juiceStream', 'bananaShower']);
    expect(p.hitObjects[0]).toBeInstanceOf(Fruit);
    expect(p.hitObjects[0].effectiveX).toBe(256);
  });

  it('generates juice stream nested objects like lazer', () => {
    const p = play(map);
    const js = p.hitObjects[1] as JuiceStream;
    // velocity = 100 * SM / beatLength = 0.2 px/ms, 200px => 1000ms
    expect(js.velocity).toBeCloseTo(0.2, 10);
    expect(js.duration).toBeCloseTo(1000, 6);
    expect(js.tickDistance).toBeCloseTo(100, 6);

    const fruits = js.nested.filter(n => n instanceof Fruit);
    const droplets = js.nested.filter(n => n instanceof Droplet && !(n instanceof TinyDroplet));
    const tiny = js.nested.filter(n => n instanceof TinyDroplet);
    expect(fruits.map(f => f.startTime)).toEqual([2000, 3000]);
    expect(droplets.map(d => d.startTime)).toEqual([2500]);
    expect(droplets[0].effectiveX).toBeCloseTo(200, 3);
    // head -> tick: 500ms split into 62.5ms gaps (7), tick -> legacy last tick (464ms) split into 58ms gaps (7)
    expect(tiny.length).toBe(14);
    expect(tiny[0].startTime).toBeCloseTo(2062.5, 6);
    expect(tiny[7].startTime).toBeCloseTo(2558, 6);
    // tiny droplets get a random -20..20 offset, clamped to the playfield
    for (const t of tiny) expect(Math.abs(t.xOffset)).toBeLessThanOrEqual(20);
    // nested objects are sorted
    const times = js.nested.map(n => n.startTime);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it('generates bananas with random x positions', () => {
    const p = play(map);
    const shower = p.hitObjects[2] as BananaShower;
    // spacing 1000 -> 500 -> 250 -> 125 -> 62.5
    expect(shower.nested.length).toBe(17);
    expect(shower.nested[1].startTime).toBe(4062.5);
    for (const b of shower.nested) {
      expect(b).toBeInstanceOf(Banana);
      expect(b.effectiveX).toBeGreaterThanOrEqual(0);
      expect(b.effectiveX).toBeLessThanOrEqual(512);
    }
    // the same positions every time (LegacyRandom seeded with 1337)
    const again = play(map).hitObjects[2] as BananaShower;
    expect(again.nested.map(b => b.xOffset)).toEqual(shower.nested.map(b => b.xOffset));
    // The banana after the shower is last in combo, so the plate explodes after it.
    expect(shower.nested[shower.nested.length - 1].lastInCombo).toBe(true);
  });

  it('converts osu! standard beatmaps', () => {
    const p = play(osu(['256,192,1000,1,0,0:0:0:0:', '100,100,2000,2,0,B|200:200|300:100,2,150'], { mode: 0 }));
    expect(p.hitObjects.map(h => h.kind)).toEqual(['fruit', 'juiceStream']);
    const js = p.hitObjects[1] as JuiceStream;
    // head, repeat, repeat, tail
    expect(js.nested.filter(n => n.kind === 'fruit').length).toBe(3);
    expect(catchRuleset.canConvert(LegacyBeatmapDecoder.decode(osu([], { mode: 3 })))).toBe(false);
  });

  it('applies preempt and scale from difficulty', () => {
    const p = play(map);
    expect(p.hitObjects[0].timePreempt).toBe(1200);
    expect(p.hitObjects[0].scale).toBe(0.5);
    const hr = play(map, ['HR']);
    // AR 5 * 1.4 = 7 => 1200 - 750 * 0.4 = 900
    expect(hr.hitObjects[0].timePreempt).toBe(900);
    expect(hr.difficulty.circleSize).toBe(f32(6.5));
  });
});

describe('osu!catch catcher', () => {
  it('computes the catch width from circle size', () => {
    expect(calculateCatchWidth(5)).toBe(f32(f32(106.75) * f32(0.8)));
    expect(calculateCatchWidth(0)).toBeGreaterThan(calculateCatchWidth(10));
  });

  it('catches objects within half the catch width', () => {
    const c = new CatcherState(5);
    const f = new Fruit();
    f.originalX = 256 + 42.7;
    expect(c.canCatch(f)).toBe(true);
    f.originalX = 256 + 42.8;
    expect(c.canCatch(f)).toBe(false);
  });

  it('moves with lazer speeds', () => {
    const c = new CatcherState(5);
    c.move(1, 100);
    expect(c.x).toBe(256 + 50);
    c.dashing = true;
    c.move(-1, 100);
    expect(c.x).toBe(256 - 50);
    c.move(-1, 10000);
    expect(c.x).toBe(0);
  });
});

describe('osu!catch hyperdash', () => {
  it('marks impossible jumps as hyperdashes', () => {
    const p = play(osu(['0,192,1000,5,0,0:0:0:0:', '512,192,1200,1,0,0:0:0:0:', '512,192,2000,1,0,0:0:0:0:']));
    const [a, b] = p.hitObjects as Fruit[];
    expect(a.hyperDash).toBe(true);
    expect(a.hyperDashTarget).toBe(b);
    expect(b.hyperDash).toBe(false);
  });

  it('does not hyperdash walkable movements', () => {
    const p = play(osu(['200,192,1000,5,0,0:0:0:0:', '300,192,1500,1,0,0:0:0:0:']));
    const a = p.hitObjects[0] as Fruit;
    expect(a.hyperDash).toBe(false);
    expect(a.distanceToHyperDash).toBeGreaterThan(0);
  });

  it('applies hard rock offsets to close fruits', () => {
    const fruits = Array.from({ length: 20 }, (_, i) => `${200 + (i % 2) * 10},192,${1000 + i * 100},${i === 0 ? 5 : 1},0,0:0:0:0:`);
    const nm = play(osu(fruits));
    const hr = play(osu(fruits), ['HR']);
    expect(nm.hitObjects.every(h => h.xOffset === 0)).toBe(true);
    expect(hr.hitObjects.some(h => h.xOffset !== 0)).toBe(true);
  });

  it('mirrors positions', () => {
    const p = play(osu(['100,192,1000,5,0,0:0:0:0:']), ['MR']);
    expect(p.hitObjects[0].effectiveX).toBe(412);
  });
});

describe('osu!catch scoring', () => {
  const map = osu(['256,192,1000,5,0,0:0:0:0:', '100,192,2000,2,0,L|300:192,1,200', '256,192,4000,12,0,5000,0:0:0:0:', '300,192,5500,5,0,0:0:0:0:']);

  it('reaches 1,000,000 (+ bananas) on a perfect play', () => {
    const p = play(map);
    const sp = catchRuleset.createScoreProcessor(p);
    const perfect = p.perfectResults();
    sp.applyBeatmap(perfect);
    for (const r of perfect) sp.applyResult({ ...r, type: r.judgement.maxResult });
    const bananas = perfect.filter(r => r.judgement.maxResult === HitResult.LargeBonus).length;
    expect(sp.totalScore).toBe(1000000 + bananas * 200);
    expect(sp.accuracy).toBe(1);
    expect(sp.rank).toBe('X');
    // fruit + juice stream (head, droplet, tail) + fruit
    expect(sp.highestCombo).toBe(5);
  });

  it('uses catch rank cutoffs', () => {
    const sp = catchRuleset.createScoreProcessor(play(map));
    expect(sp.rankFromScore(0.985, new Map())).toBe('S');
    expect(sp.rankFromScore(0.95, new Map())).toBe('A');
    expect(sp.rankFromScore(0.86, new Map())).toBe('C');
  });

  it('computes score multipliers', () => {
    expect(catchRuleset.scoreMultiplier(new ModSet(['HD', 'HR']))).toBeCloseTo(1.06 * 1.12, 10);
    expect(catchRuleset.scoreMultiplier(new ModSet(['DT']))).toBeCloseTo(1.1, 10);
    expect(catchRuleset.scoreMultiplier(new ModSet(['HT']))).toBeCloseTo(0.3, 10);
    expect(catchRuleset.scoreMultiplier(new ModSet(['EZ', 'RX']))).toBeCloseTo(0.05, 10);
  });

  it('computes a legacy drain rate', () => {
    const p = play(map);
    const hp = catchRuleset.createHealthProcessor(p, 0) as unknown as { drainRate: number; applyBeatmap: (...a: unknown[]) => void };
    hp.applyBeatmap(p.perfectResults(), p.difficulty.drainRate, p.breaks, 6000, p.objectTimes);
    expect(hp.drainRate).toBeGreaterThan(0);
    expect(Number.isFinite(hp.drainRate)).toBe(true);
  });
});

describe('osu!catch gameplay', () => {
  const map = osu([
    '256,192,1000,5,0,0:0:0:0:',
    '50,192,1600,1,0,0:0:0:0:',
    '480,192,1900,5,0,0:0:0:0:',
    '100,192,2500,2,0,L|300:192,2,200',
    '256,192,6000,12,0,7000,0:0:0:0:',
    '400,192,7500,5,0,0:0:0:0:',
  ]);

  it('autoplay catches everything', () => {
    const p = play(map, ['AT']);
    const results: JudgementResult[] = [];
    const d = catchRuleset.createDrawableRuleset(p, mockContext(['AT'], true, new Set(), results)) as DrawableCatchRuleset;
    runGameplay(d, 8000);
    expect(d.hasCompleted).toBe(true);
    expect(results.length).toBe(p.perfectResults().length);
    for (const r of results) {
      if (r.judgement.maxResult === HitResult.IgnoreHit) continue;
      expect(r.type, `${(r.hitObject as { kind: string }).kind} at ${(r.hitObject as { startTime: number }).startTime}`).toBe(r.judgement.maxResult);
    }
  });

  it('autoplay catches a hard rock map at an odd frame rate', () => {
    const p = play(map, ['HR', 'AT']);
    const results: JudgementResult[] = [];
    const d = catchRuleset.createDrawableRuleset(p, mockContext(['HR', 'AT'], true, new Set(), results)) as DrawableCatchRuleset;
    runGameplay(d, 8000, 23.7);
    expect(results.filter(r => r.judgement.maxResult !== HitResult.IgnoreHit && r.type !== r.judgement.maxResult)).toEqual([]);
  });

  it('misses objects out of reach when idle, and catches the ones under the catcher', () => {
    const p = play(map);
    const results: JudgementResult[] = [];
    const d = catchRuleset.createDrawableRuleset(p, mockContext([], false, new Set(), results)) as DrawableCatchRuleset;
    runGameplay(d, 8000);
    expect(results[0].type).toBe(HitResult.Great); // fruit at x=256
    expect(results[1].type).toBe(HitResult.Miss); // fruit at x=50
  });

  it('moves the catcher with held keys', () => {
    const p = play(osu(['256,192,5000,5,0,0:0:0:0:']));
    const pressed = new Set<string>();
    const d = catchRuleset.createDrawableRuleset(p, mockContext([], false, pressed, [])) as DrawableCatchRuleset;
    d.update(0, 0);
    pressed.add('MoveRight');
    d.onPressed('MoveRight', 0);
    d.update(100, 100);
    expect(d.catcherX).toBeCloseTo(306, 3);
    pressed.add('Dash');
    d.onPressed('Dash', 100);
    d.update(150, 50);
    expect(d.catcherX).toBeCloseTo(356, 3);
  });

  it('hyperdashes after catching a hyper fruit', () => {
    const p = play(osu(['0,192,1000,5,0,0:0:0:0:', '512,192,1200,1,0,0:0:0:0:', '512,192,3000,1,0,0:0:0:0:']));
    const pressed = new Set<string>(['MoveLeft', 'Dash']);
    const results: JudgementResult[] = [];
    const d = catchRuleset.createDrawableRuleset(p, mockContext([], false, pressed, results)) as DrawableCatchRuleset;
    let switched = false;
    runGameplay(d, 4000, 1000 / 60, t => {
      if (t >= 1000 && !switched) {
        switched = true;
        pressed.clear();
        d.onReleased('MoveLeft', t);
        pressed.add('MoveRight');
        d.onPressed('MoveRight', t);
        pressed.add('Dash');
      }
    });
    expect(results[0].type).toBe(HitResult.Great);
    expect(results[1].type).toBe(HitResult.Great);
    expect(d.catcherX).toBe(512);
  });
});

describe('osu!catch star rating', () => {
  it('is zero for an empty map and grows with jumps', () => {
    expect(catchRuleset.starRating!(play(osu([])))).toBe(0);
    const easy = play(osu(Array.from({ length: 40 }, (_, i) => `${240 + (i % 2) * 30},192,${1000 + i * 400},${i === 0 ? 5 : 1},0,0:0:0:0:`)));
    const hard = play(osu(Array.from({ length: 40 }, (_, i) => `${60 + (i % 2) * 390},192,${1000 + i * 300},${i === 0 ? 5 : 1},0,0:0:0:0:`)));
    const sEasy = catchRuleset.starRating!(easy);
    const sHard = catchRuleset.starRating!(hard);
    expect(sEasy).toBeGreaterThan(0);
    expect(sHard).toBeGreaterThan(sEasy);
    const dt = catchRuleset.starRating!(play(osu(Array.from({ length: 40 }, (_, i) => `${60 + (i % 2) * 390},192,${1000 + i * 300},${i === 0 ? 5 : 1},0,0:0:0:0:`)), ['DT']));
    expect(dt).toBeGreaterThan(sHard);
  });

  it('only counts combo objects', () => {
    const p = play(osu(['100,192,2000,6,0,L|300:192,1,200']));
    expect(getPalpableObjects(p.hitObjects).length).toBe(17);
    expect(p.maxCombo).toBe(3);
  });
});

describe('StatelessRNG', () => {
  it('is deterministic and in range', () => {
    expect(statelessNextSingle(1000, 1)).toBe(statelessNextSingle(1000, 1));
    expect(statelessNextSingle(1000, 1)).not.toBe(statelessNextSingle(1000, 2));
    for (let i = 0; i < 100; i++) {
      const v = statelessNextSingle(i * 37, 3);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      expect(statelessNextInt(3, i)).toBeLessThan(3);
    }
  });
});
