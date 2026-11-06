// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Runs lazer's own osu!mania conversion test cases (osu.Game.Rulesets.Mania.Tests/ManiaBeatmapConversionTest.cs)
// against the TypeScript converter: per original object, the converted objects and the LegacyRandom state must match.

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LegacyBeatmapDecoder } from '../../src/game/beatmaps/LegacyBeatmapDecoder';
import { conversionDifficultyFromBeatmap, ManiaBeatmapConverter } from '../../src/game/rulesets/mania/beatmaps/ManiaBeatmapConverter';

const RESOURCES = resolve(__dirname, '../../../osu.Game.Rulesets.Mania.Tests/Resources/Testing/Beatmaps');

const CASES = [
  'basic',
  'zero-length-slider',
  'mania-specific-spinner',
  '20544',
  '100374',
  '1450162',
  '4869637',
  '1K',
  '2K',
  '3K',
  '4K',
  '5K',
  '6K',
  '7K',
  '8K',
  '9K',
  '10K',
  '12K',
  '14K',
  '16K',
  '18K',
];

interface ExpectedObject {
  StartTime: number;
  EndTime: number;
  Column: number;
}

interface ExpectedMapping {
  RandomW: number;
  RandomX: number;
  RandomY: number;
  RandomZ: number;
  StartTime: number;
  Objects: ExpectedObject[];
}

const sortObjects = (objs: ExpectedObject[]): ExpectedObject[] =>
  [...objs].sort((a, b) => (a.StartTime !== b.StartTime ? a.StartTime - b.StartTime : a.Column - b.Column));

describe.skipIf(!existsSync(RESOURCES))('mania conversion matches lazer test resources', () => {
  for (const name of CASES) {
    it(name, () => {
      const text = readFileSync(resolve(RESOURCES, `${name}.osu`), 'utf8');
      const expected: { Mappings: ExpectedMapping[] } = JSON.parse(readFileSync(resolve(RESOURCES, `${name}-expected-conversion.json`), 'utf8').replace(/^\uFEFF/, ''));

      const beatmap = LegacyBeatmapDecoder.decode(text);
      const converter = new ManiaBeatmapConverter(conversionDifficultyFromBeatmap(beatmap));
      const rng = converter.random as unknown as { x: number; y: number; z: number; w: number };

      const actual: ExpectedMapping[] = [];
      converter.convert(beatmap, (original, result) => {
        actual.push({
          RandomW: rng.w,
          RandomX: rng.x,
          RandomY: rng.y,
          RandomZ: rng.z,
          StartTime: original.startTime,
          Objects: sortObjects(result.map(h => ({ StartTime: h.startTime, EndTime: h.endTime, Column: h.column }))),
        });
      });

      expect(actual.length).toBe(expected.Mappings.length);

      for (let i = 0; i < expected.Mappings.length; i++) {
        const e = expected.Mappings[i];
        const a = actual[i];
        const ctx = `${name} mapping #${i} @${e.StartTime}`;
        expect(a.StartTime, ctx).toBeCloseTo(e.StartTime, 0);
        expect({ W: a.RandomW, X: a.RandomX, Y: a.RandomY, Z: a.RandomZ }, ctx).toEqual({ W: e.RandomW, X: e.RandomX, Y: e.RandomY, Z: e.RandomZ });
        const eo = sortObjects(e.Objects);
        expect(a.Objects.length, ctx).toBe(eo.length);
        for (let j = 0; j < eo.length; j++) {
          // ConvertValue.Equals: Precision.AlmostEquals(..., 2) on times, exact column.
          expect(Math.abs(a.Objects[j].StartTime - eo[j].StartTime), `${ctx} obj ${j} start`).toBeLessThanOrEqual(2);
          expect(Math.abs(a.Objects[j].EndTime - eo[j].EndTime), `${ctx} obj ${j} end`).toBeLessThanOrEqual(2);
          expect(a.Objects[j].Column, `${ctx} obj ${j} column`).toBe(eo[j].Column);
        }
      }
    });
  }
});
