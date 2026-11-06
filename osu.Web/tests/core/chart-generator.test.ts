import { describe, expect, it } from 'vitest';
import { LegacyBeatmapDecoder } from '../../src/game/beatmaps/LegacyBeatmapDecoder';
import { ModSet } from '../../src/game/mods/Mods';
import { getRuleset } from '../../src/game/rulesets';
import { difficultyName, generateChart, generateForStars, GeneratorMode } from '../../src/game/generator/ChartGenerator';
import { synthGrid } from '../../src/game/generator/SongSynth';
import { estimateTempo } from '../../src/game/generator/AudioAnalysis';

const rate = (text: string) => {
  const beatmap = LegacyBeatmapDecoder.decode(text);
  const r = getRuleset(beatmap.rulesetId);
  return r.starRating!(r.createPlayable(beatmap, new ModSet()));
};

const meta = { title: 'Test', artist: 'Synth', creator: 'Generator', version: 'Test', audioFile: 'audio.wav' };

describe('chart generator', () => {
  const { grid } = synthGrid({ style: 'pop', bpm: 128, lengthSeconds: 90, seed: 1234 });

  it('builds a song grid with the requested tempo', () => {
    expect(grid.bpm).toBe(128);
    expect(grid.slots.length % 16).toBe(0);
    expect(grid.slots.some(s => s.low === 1)).toBe(true);
    expect(grid.energy.length * 4).toBe(grid.slots.length);
  });

  for (const mode of [0, 1, 2, 3] as GeneratorMode[]) {
    it(`generates decodable mode ${mode} charts at increasing difficulty`, () => {
      const stars: number[] = [];
      for (const intensity of [0, 0.5, 1]) {
        const text = generateChart(grid, { mode, intensity, keys: 4, seed: 7, meta });
        const beatmap = LegacyBeatmapDecoder.decode(text);
        expect(beatmap.rulesetId).toBe(mode);
        expect(beatmap.hitObjects.length).toBeGreaterThan(20);
        // Objects are time ordered and inside the song.
        for (let j = 1; j < beatmap.hitObjects.length; j++) expect(beatmap.hitObjects[j].startTime).toBeGreaterThanOrEqual(beatmap.hitObjects[j - 1].startTime);
        expect(beatmap.lastObjectTime).toBeLessThan(grid.durationMs);
        stars.push(rate(text));
      }
      expect(stars[1]).toBeGreaterThan(stars[0]);
      expect(stars[2]).toBeGreaterThan(stars[1]);
    });

    it(`hits a requested star rating for mode ${mode}`, async () => {
      for (const target of [2, 4.5]) {
        const r = await generateForStars(grid, { mode, keys: 4, seed: 7, meta }, target, rate);
        expect(Math.abs(r.stars - target)).toBeLessThan(0.6);
      }
    });
  }

  it('keeps mania notes in free columns', () => {
    const text = generateChart(grid, { mode: 3, intensity: 1, keys: 7, seed: 3, meta });
    const beatmap = LegacyBeatmapDecoder.decode(text);
    const playable = getRuleset(3).createPlayable(beatmap, new ModSet());
    const busy = new Map<number, number>();
    for (const h of playable.hitObjects as unknown as { column: number; startTime: number; endTime?: number }[]) {
      expect(h.startTime).toBeGreaterThan(busy.get(h.column) ?? -Infinity);
      busy.set(h.column, h.endTime ?? h.startTime);
    }
  });

  it('names difficulties by star rating', () => {
    expect(difficultyName(1.5)).toBe('Easy');
    expect(difficultyName(2.2)).toBe('Normal');
    expect(difficultyName(3.5)).toBe('Hard');
    expect(difficultyName(4.8)).toBe('Insane');
    expect(difficultyName(6)).toBe('Expert');
    expect(difficultyName(7.2)).toBe('Expert+');
  });

  it('recovers the tempo of a click track', () => {
    for (const bpm of [100, 128, 174]) {
      const env = new Float32Array(100 * 60);
      const beat = 60 / bpm;
      const hit = (t: number, v: number) => { for (let d = 0; d < 8; d++) { const f = Math.floor(t * 100) + d; if (f < env.length) env[f] = Math.max(env[f], v * Math.exp(-d / 2) * (d === 0 ? 1 - (t * 100 - Math.floor(t * 100)) : 1)); } };
      for (let t = 0.37; t < 60; t += beat) hit(t, 1);
      for (let t = 0.37 + beat / 2; t < 60; t += beat) hit(t, 0.4);
      const r = estimateTempo(env);
      expect(Math.abs(r.bpm - bpm)).toBeLessThan(0.6);
      const phaseErr = Math.abs(((r.phase - 0.37) % beat + beat) % beat);
      expect(Math.min(phaseErr, beat - phaseErr)).toBeLessThan(0.02);
    }
  });
});
