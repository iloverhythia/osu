// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Runs lazer's own osu!catch reference data (osu.Game.Rulesets.Catch.Tests/Resources/Testing/Beatmaps) against the port:
// CatchBeatmapConversionTest (expected conversions) and CatchDifficultyCalculatorTest (expected star ratings).

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LegacyBeatmapDecoder } from '../../src/game/beatmaps/LegacyBeatmapDecoder';
import { ModSet } from '../../src/game/mods/Mods';
import { catchRuleset, CatchPlayableBeatmap } from '../../src/game/rulesets/catch';
import { PalpableCatchHitObject, type CatchHitObject } from '../../src/game/rulesets/catch/objects';

const RESOURCES = resolve(__dirname, '../../../osu.Game.Rulesets.Catch.Tests/Resources/Testing/Beatmaps');

// [name, mods] from CatchBeatmapConversionTest
const CASES: [string, string[]][] = [
  ['basic', []],
  ['spinner', []],
  ['spinner-and-circles', []],
  ['slider', []],
  ['hardrock-stream', ['HR']],
  ['hardrock-repeat-slider', ['HR']],
  ['hardrock-spinner', ['HR']],
  ['right-bound-hr-offset', ['HR']],
  ['basic-hyperdash', []],
  ['pixel-jump', []],
  ['tiny-ticks', []],
  ['v8-tick-distance', []],
  ['spinner-precision', []],
  ['37902', ['DT', 'HR', 'HD']],
  ['39206', ['DT', 'HD']],
  ['42587', []],
  ['50859', ['DT', 'HD']],
  ['75858', ['HR', 'HD']],
  ['103019', ['HD']],
  ['104973', ['HR', 'HD']],
  ['871815', ['DT', 'HD']],
  ['1284935', ['DT', 'HR']],
  ['1431386', ['DT', 'HR', 'HD']],
  ['1597806', ['DT', 'HD']],
  ['2190499', ['DT', 'HD']],
  ['2571731', ['HR', 'HD']],
  ['2768615', ['DT', 'HR']],
  ['2781126', ['HD']],
  ['3152510', ['DT']],
  ['3227428', ['HR', 'HD']],
  ['3524302', ['DT', 'EZ']],
  ['3644427', ['EZ', 'FL']],
  ['3689906', ['DT', 'EZ']],
  ['3949367', ['DT', 'EZ']],
  ['112643', []],
  ['1041052', ['HR']],
  ['high-speed-multiplier-precision', []],
];

interface ExpectedValue {
  StartTime: number;
  Position: number;
  HyperDash: boolean;
}

const load = (name: string, mods: string[]) =>
  catchRuleset.createPlayable(LegacyBeatmapDecoder.decode(readFileSync(resolve(RESOURCES, `${name}.osu`), 'utf8')), new ModSet(mods)) as CatchPlayableBeatmap;

function flatten(objects: readonly CatchHitObject[]): ExpectedValue[] {
  const out: ExpectedValue[] = [];
  const push = (h: CatchHitObject) => out.push({ StartTime: h.startTime, Position: h.effectiveX, HyperDash: h instanceof PalpableCatchHitObject && h.hyperDash });
  for (const h of objects) {
    if (h.kind === 'juiceStream' || h.kind === 'bananaShower') h.nested.forEach(push);
    else push(h);
  }
  return out;
}

const LENIENCE = 3; // ConvertValue.conversion_lenience

describe.runIf(existsSync(RESOURCES))('lazer reference data', () => {
  for (const [name, mods] of CASES) {
    it(`converts ${name}${mods.length ? ` +${mods.join('')}` : ''} like lazer`, () => {
      const expected: ExpectedValue[] = JSON.parse(readFileSync(resolve(RESOURCES, `${name}-expected-conversion.json`), 'utf8')).Mappings.flatMap(
        (m: { Objects: ExpectedValue[] }) => m.Objects,
      );
      const ours = flatten(load(name, mods).hitObjects);

      expect(ours.length).toBe(expected.length);
      const mismatches: string[] = [];
      for (let i = 0; i < expected.length; i++) {
        const e = expected[i];
        const o = ours[i];
        if (Math.abs(e.StartTime - o.StartTime) > LENIENCE || Math.abs(e.Position - o.Position) > LENIENCE || e.HyperDash !== o.HyperDash)
          mismatches.push(`#${i} expected ${JSON.stringify(e)} got ${JSON.stringify(o)}`);
      }
      expect(mismatches.slice(0, 5)).toEqual([]);
    });
  }

  it('matches CatchDifficultyCalculatorTest star ratings', () => {
    const nm = load('diffcalc-test', []);
    expect(nm.maxCombo).toBe(127);
    expect(catchRuleset.starRating!(nm)).toBeCloseTo(4.039861734717169, 6);
    const dt = load('diffcalc-test', ['DT']);
    expect(catchRuleset.starRating!(dt)).toBeCloseTo(5.1527173897800873, 6);
  });
});
