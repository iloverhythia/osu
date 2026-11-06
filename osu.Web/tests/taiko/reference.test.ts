// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Runs lazer's own osu!taiko reference data (osu.Game.Rulesets.Taiko/Resources/Testing/Beatmaps) against the port:
// TaikoBeatmapConversionTest (expected conversions) and TaikoDifficultyCalculatorTest (expected star ratings).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LegacyBeatmapDecoder } from '../../src/game/beatmaps/LegacyBeatmapDecoder';
import { ModSet } from '../../src/game/mods/Mods';
import { taikoRuleset, type TaikoPlayableBeatmap } from '../../src/game/rulesets/taiko';
import { calculateTaikoDifficulty } from '../../src/game/rulesets/taiko/difficulty/TaikoDifficultyCalculator';
import { DrumRoll, Hit, HitType, Swell, TaikoStrongableHitObject } from '../../src/game/rulesets/taiko/objects';

const RESOURCES = resolve(__dirname, '../../../osu.Game.Rulesets.Taiko/Resources/Testing/Beatmaps');

const load = (name: string) => LegacyBeatmapDecoder.decode(readFileSync(resolve(RESOURCES, `${name}.osu`), 'utf8'));

interface ConvertValue {
  StartTime: number;
  EndTime: number;
  IsRim: boolean;
  IsCentre: boolean;
  IsDrumRoll: boolean;
  IsSwell: boolean;
  IsStrong: boolean;
}

describe('TaikoBeatmapConversionTest', () => {
  for (const name of ['basic', 'slider-generating-drumroll', 'sample-to-type-conversions', 'slider-conversion-v6', 'slider-conversion-v14', 'slider-generating-drumroll-2', 'file-hitsamples']) {
    it(name, () => {
      const expected: { Mappings: { StartTime: number; Objects: ConvertValue[] }[] } = JSON.parse(readFileSync(resolve(RESOURCES, `${name}-expected-conversion.json`), 'utf8'));
      const beatmap = load(name);
      const playable = taikoRuleset.createPlayable(beatmap, new ModSet()) as TaikoPlayableBeatmap;
      const actual: ConvertValue[] = playable.hitObjects.map(h => ({
        StartTime: h.startTime,
        EndTime: h.endTime,
        IsRim: h instanceof Hit && h.type === HitType.Rim,
        IsCentre: h instanceof Hit && h.type === HitType.Centre,
        IsDrumRoll: h instanceof DrumRoll,
        IsSwell: h instanceof Swell,
        IsStrong: h instanceof TaikoStrongableHitObject && h.isStrong,
      }));
      const exp = expected.Mappings.flatMap(m => m.Objects).sort((a, b) => a.StartTime - b.StartTime);
      expect(actual.length).toBe(exp.length);
      // conversion_lenience = 2 (osu!stable uses ints everywhere)
      for (let i = 0; i < exp.length; i++) {
        const a = actual[i];
        const e = exp[i];
        const ctx = `${name} #${i} @${e.StartTime}`;
        expect(Math.abs(a.StartTime - e.StartTime), ctx).toBeLessThanOrEqual(2);
        expect(Math.abs(a.EndTime - e.EndTime), ctx).toBeLessThanOrEqual(2);
        expect({ ...a, StartTime: 0, EndTime: 0 }, ctx).toEqual({ ...e, StartTime: 0, EndTime: 0 });
      }
    });
  }
});

describe('TaikoDifficultyCalculatorTest', () => {
  const cases: [number, number, string, string[]][] = [
    [3.3190848563395079, 200, 'diffcalc-test', []],
    [3.3190848563395079, 200, 'diffcalc-test-strong', []],
    [4.4551414906554987, 200, 'diffcalc-test', ['DT']],
    [4.4551414906554987, 200, 'diffcalc-test-strong', ['DT']],
  ];
  for (const [sr, combo, name, mods] of cases) {
    it(`${name} ${mods.join('') || 'NM'}`, () => {
      const playable = taikoRuleset.createPlayable(load(name), new ModSet(mods)) as TaikoPlayableBeatmap;
      const attributes = calculateTaikoDifficulty(playable);
      expect(attributes.starRating).toBeCloseTo(sr, 5);
      expect(attributes.maxCombo).toBe(combo);
      expect(taikoRuleset.starRating!(playable)).toBeCloseTo(sr, 5);
    });
  }
});
