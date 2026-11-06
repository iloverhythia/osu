import { describe, expect, it } from 'vitest';
import { LegacyBeatmapDecoder } from '../../src/game/beatmaps/LegacyBeatmapDecoder';
import { ModSet } from '../../src/game/mods/Mods';
import { osuRuleset } from '../../src/game/rulesets/osu';
import { HitCircle, OsuHitObject, Slider, Spinner } from '../../src/game/rulesets/osu/objects';
import { demoMaps } from '../../src/game/demo/Demo';
import { HitResult } from '../../src/game/scoring/HitResult';

const SIMPLE = `osu file format v14

[General]
AudioFilename: audio.mp3
StackLeniency: 0.7
Mode: 0

[Difficulty]
HPDrainRate:5
CircleSize:4
OverallDifficulty:8
ApproachRate:9
SliderMultiplier:1.4
SliderTickRate:1

[TimingPoints]
1000,500,4,2,0,60,1,0
3000,-50,4,2,0,60,0,0

[HitObjects]
100,100,1000,5,0,0:0:0:0:
100,100,1250,1,0,0:0:0:0:
200,200,2000,2,0,B|300:200|300:300,1,280
256,192,4000,12,0,5000,0:0:0:0:
`;

describe('osu! pipeline', () => {
  it('decodes and converts a simple map', () => {
    const b = LegacyBeatmapDecoder.decode(SIMPLE);
    expect(b.hitObjects.length).toBe(4);
    expect(b.difficulty.approachRate).toBe(9);
    const p = osuRuleset.createPlayable(b, new ModSet());
    const objs = p.hitObjects as OsuHitObject[];
    expect(objs[0]).toBeInstanceOf(HitCircle);
    expect(objs[2]).toBeInstanceOf(Slider);
    expect(objs[3]).toBeInstanceOf(Spinner);
    // AR9 → 600ms preempt; OD8 great window = floor(80 - 30*0.6)-0.5 = 61.5
    expect(objs[0].timePreempt).toBe(600);
    expect((objs[0] as HitCircle).hitWindows.windowFor(HitResult.Great)).toBe(31.5);
    // Stacking: the two circles at the same position stack.
    expect(objs[0].stackHeight).toBe(1);
    expect(objs[1].stackHeight).toBe(0);
    const s = objs[2] as Slider;
    // velocity = 100 * 1.4 / 500 px/ms → 140px takes 500ms.
    expect(s.duration).toBeCloseTo(1000, 5);
    expect(s.path.distance).toBeCloseTo(280, 3);
    expect(s.ticks.length).toBe(1);
    const sp = objs[3] as Spinner;
    expect(sp.endTime).toBe(5000);
    expect(sp.spinsRequired).toBeGreaterThan(0);
  });

  it('computes score maxima over a perfect play', () => {
    const b = LegacyBeatmapDecoder.decode(SIMPLE);
    const p = osuRuleset.createPlayable(b, new ModSet());
    const sp = osuRuleset.createScoreProcessor(p);
    sp.applyBeatmap(p.perfectResults());
    for (const r of p.perfectResults()) sp.applyResult({ ...r, type: r.judgement.maxResult });
    expect(sp.accuracy).toBe(1);
    expect(sp.totalScore).toBeGreaterThanOrEqual(1000000);
    expect(sp.rank).toBe('X');
    // head + tick + tail + 3 circles... combo counts circles, head, tick, tail
    expect(sp.highestCombo).toBe(sp.maximumCombo);
  });

  it('applies hard rock (flip + difficulty)', () => {
    const b = LegacyBeatmapDecoder.decode(SIMPLE);
    const p = osuRuleset.createPlayable(b, new ModSet(['HR']));
    expect(p.difficulty.approachRate).toBe(10);
    expect((p.hitObjects as OsuHitObject[])[0].position.y).toBe(384 - 100);
  });

  it('decodes the generated demo maps', () => {
    for (const text of [demoMaps.osuEasy(), demoMaps.osuNormal(), demoMaps.mania()]) {
      const b = LegacyBeatmapDecoder.decode(text);
      expect(b.hitObjects.length).toBeGreaterThan(50);
      expect(b.breaks.length).toBe(1);
    }
    const b = LegacyBeatmapDecoder.decode(demoMaps.osuNormal());
    const p = osuRuleset.createPlayable(b, new ModSet());
    expect(p.hitObjects.some(h => h instanceof Spinner)).toBe(true);
    expect(p.hitObjects.filter(h => h instanceof Slider).length).toBeGreaterThan(10);
    for (const h of p.hitObjects) if (h instanceof Slider) expect(h.path.distance).toBeGreaterThan(0);
  });
});
