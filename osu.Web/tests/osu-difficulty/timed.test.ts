/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LegacyBeatmapDecoder } from '../../src/game/beatmaps/LegacyBeatmapDecoder';
import { ModSet } from '../../src/game/mods/Mods';
import type { Ruleset } from '../../src/game/rulesets/Ruleset';
import { convertOsuBeatmap } from '../../src/game/rulesets/osu/beatmap';
import { calculateOsuDifficultyTimed } from '../../src/game/rulesets/osu/difficulty';

const RES = new URL('../../../osu.Game.Rulesets.Osu.Tests/Resources/Testing/Beatmaps/', import.meta.url);

// OsuDifficultyCalculatorTest.TestTimedExtended
const EXPECTED: [number, number, number][] = [
  [500, 1, 0],
  [1000, 2, 0.16948857823852109],
  [1500, 3, 0.26606949612932967],
  [2000, 4, 0.35775631754708426],
  [2500, 5, 0.56319343599556226],
  [17000, 62, 5.6685465406782036],
  [18000, 63, 5.7272669362777702],
  [18125, 64, 5.7347762555961532],
  [61500, 160, 6.5240565852553738],
  [70000, 176, 6.5240609777925842],
  [74600, 195, 6.5240617806983261],
];

describe('timed difficulty (TestTimedExtended)', () => {
  it('diffcalc-test', () => {
    const text = readFileSync(new URL('diffcalc-test.osu', RES), 'utf8');
    const playable = convertOsuBeatmap(LegacyBeatmapDecoder.decode(text, false), {} as Ruleset, new ModSet());
    const timed = new Map(calculateOsuDifficultyTimed(playable).map(t => [t.time, t.attributes]));
    for (const [time, combo, sr] of EXPECTED) {
      const a = timed.get(time)!;
      expect(a.maxCombo).toBe(combo);
      expect(Math.abs(a.starRating - sr)).toBeLessThan(0.00001);
    }
  });
});
