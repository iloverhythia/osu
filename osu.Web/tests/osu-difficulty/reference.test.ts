/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LegacyBeatmapDecoder } from '../../src/game/beatmaps/LegacyBeatmapDecoder';
import { ModSet } from '../../src/game/mods/Mods';
import type { Ruleset } from '../../src/game/rulesets/Ruleset';
import { convertOsuBeatmap } from '../../src/game/rulesets/osu/beatmap';
import { calculateOsuDifficulty } from '../../src/game/rulesets/osu/difficulty';

const RES = new URL('../../../osu.Game.Rulesets.Osu.Tests/Resources/Testing/Beatmaps/', import.meta.url);

function load(name: string, mods: string[] = []) {
  const text = readFileSync(new URL(`${name}.osu`, RES), 'utf8');
  const beatmap = LegacyBeatmapDecoder.decode(text, false);
  return convertOsuBeatmap(beatmap, {} as Ruleset, new ModSet(mods));
}

const CHECK_PRECISION = 0.00001;

// Expected values from osu.Game.Rulesets.Osu.Tests/OsuDifficultyCalculatorTest.cs
const CASES: [number, number, string, string[]][] = [
  [6.5243170265483581, 239, 'diffcalc-test', []],
  [1.3280410795791415, 54, 'zero-length-sliders', []],
  [0.40867325147697559, 4, 'very-fast-slider', []],
  [0.87058175794353554, 6, 'nan-slider', []],
  [6.3059767387139756, 2359, '801165', []],
  [9.4677607900646308, 239, 'diffcalc-test', ['DT']],
  [1.6856612715618886, 54, 'zero-length-sliders', ['DT']],
  [0.53588473186572561, 4, 'very-fast-slider', ['DT']],
];

describe('osu! difficulty reference values (OsuDifficultyCalculatorTest)', () => {
  for (const [expected, combo, name, mods] of CASES) {
    it(`${name} ${mods.join('') || 'NM'}`, () => {
      const attr = calculateOsuDifficulty(load(name, mods));
      expect(attr.maxCombo).toBe(combo);
      // Same tolerance as DifficultyCalculatorTest.CHECK_PRECISION.
      expect(Math.abs(attr.starRating - expected)).toBeLessThan(CHECK_PRECISION);
    });
  }
});
