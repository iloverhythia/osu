// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game.Rulesets.Mania.Tests/ManiaDifficultyCalculatorTest.cs

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LegacyBeatmapDecoder } from '../../src/game/beatmaps/LegacyBeatmapDecoder';
import { ModSet } from '../../src/game/mods/Mods';
import { maniaRuleset } from '../../src/game/rulesets/mania';
import { calculateManiaDifficulty } from '../../src/game/rulesets/mania/difficulty/ManiaDifficultyCalculator';
import { legacySort } from '../../src/game/rulesets/mania/difficulty/LegacySortHelper';
import type { ManiaPlayableBeatmap } from '../../src/game/rulesets/mania/ManiaPlayableBeatmap';

const RESOURCES = resolve(__dirname, '../../../osu.Game.Rulesets.Mania.Tests/Resources/Testing/Beatmaps');

describe.skipIf(!existsSync(RESOURCES))('ManiaDifficultyCalculator', () => {
  const load = (mods: string[]) => {
    const beatmap = LegacyBeatmapDecoder.decode(readFileSync(resolve(RESOURCES, 'diffcalc-test.osu'), 'utf8'));
    return maniaRuleset.createPlayable(beatmap, new ModSet(mods)) as ManiaPlayableBeatmap;
  };

  it('diffcalc-test (no mods)', () => {
    const playable = load([]);
    const attributes = calculateManiaDifficulty(playable.hitObjects, playable.totalColumns, 1);
    expect(attributes.starRating).toBeCloseTo(2.3493769750220914, 9);
    expect(attributes.maxCombo).toBe(242);
    expect(maniaRuleset.starRating!(playable)).toBeCloseTo(2.3493769750220914, 9);
  });

  it('diffcalc-test (DT)', () => {
    const playable = load(['DT']);
    expect(maniaRuleset.starRating!(playable)).toBeCloseTo(2.797245912537965, 9);
    expect(calculateManiaDifficulty(playable.hitObjects, playable.totalColumns, 1.5).maxCombo).toBe(242);
  });
});

describe('LegacySortHelper', () => {
  it('sorts', () => {
    const values = Array.from({ length: 500 }, (_, i) => (i * 7919) % 503);
    legacySort(values, (a, b) => a - b);
    for (let i = 1; i < values.length; i++) expect(values[i - 1]).toBeLessThanOrEqual(values[i]);
  });
});
