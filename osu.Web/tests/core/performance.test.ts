import { describe, expect, it } from 'vitest';
import { LegacyBeatmapDecoder } from '../../src/game/beatmaps/LegacyBeatmapDecoder';
import { generateChart, GeneratorMode } from '../../src/game/generator/ChartGenerator';
import { synthGrid } from '../../src/game/generator/SongSynth';
import { ModSet } from '../../src/game/mods/Mods';
import { getRuleset } from '../../src/game/rulesets';
import { HitResult } from '../../src/game/scoring/HitResult';
import { calculatePerformance, totalPerformance } from '../../src/game/scoring/Performance';
import { levelFromScore, scoreForLevel } from '../../src/game/Profiles';

const meta = { title: 'T', artist: 'S', creator: 'G', version: 'V', audioFile: 'a.wav' };

function perfect(mode: GeneratorMode, intensity: number, mods = new ModSet()) {
  const { grid } = synthGrid({ style: 'pop', bpm: 140, lengthSeconds: 90, seed: 77 });
  const beatmap = LegacyBeatmapDecoder.decode(generateChart(grid, { mode, intensity, keys: 4, seed: 3, meta }));
  const r = getRuleset(mode);
  const playable = r.createPlayable(beatmap, mods);
  const sp = r.createScoreProcessor(playable);
  sp.applyBeatmap(playable.perfectResults());
  return { r, playable, stats: sp.maximumStatistics, maxCombo: sp.maximumCombo };
}

describe('performance points', () => {
  for (const mode of [0, 1, 2, 3] as GeneratorMode[]) {
    it(`gives sensible pp for mode ${mode}`, () => {
      const easy = perfect(mode, 0.2);
      const hard = perfect(mode, 1.0);
      const pp = (p: ReturnType<typeof perfect>, stats: Map<HitResult, number>, acc: number, combo = p.maxCombo) =>
        calculatePerformance(mode, p.playable, { statistics: stats, maxCombo: combo, accuracy: acc, mods: new ModSet() })!;
      const ppEasy = pp(easy, easy.stats, 1);
      const ppHard = pp(hard, hard.stats, 1);
      expect(ppEasy).toBeGreaterThan(0);
      expect(ppHard).toBeGreaterThan(ppEasy);
      // Turning some perfect judgements into misses lowers pp.
      const worse = new Map(hard.stats);
      const top = [...worse.entries()].sort((a, b) => b[1] - a[1])[0];
      worse.set(top[0], top[1] - 20);
      worse.set(HitResult.Miss, (worse.get(HitResult.Miss) ?? 0) + 20);
      expect(pp(hard, worse, 0.95, Math.floor(hard.maxCombo / 2))).toBeLessThan(ppHard);
    });
  }

  it('weights the best scores like the website', () => {
    const t = totalPerformance([100, 100]);
    expect(t.weighted).toEqual([100, 95]);
    expect(t.total).toBeCloseTo(195 + 416.6667 * (1 - 0.995 ** 2), 3);
  });

  it('matches the osu! level curve', () => {
    expect(scoreForLevel(1)).toBe(0);
    expect(Math.round(scoreForLevel(2))).toBe(30000);
    expect(levelFromScore(0)).toBe(1);
    expect(Math.floor(levelFromScore(30000))).toBe(2);
    expect(Math.floor(levelFromScore(scoreForLevel(100)))).toBe(100);
    expect(Math.floor(levelFromScore(26931190829 + 99999999999))).toBe(101);
  });
});
