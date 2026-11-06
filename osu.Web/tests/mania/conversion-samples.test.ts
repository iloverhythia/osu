// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Runs lazer's osu!mania sample conversion test cases (osu.Game.Rulesets.Mania.Tests/ManiaBeatmapSampleConversionTest.cs).

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { HitSampleInfo } from '../../src/game/audio/HitSampleInfo';
import { LegacyBeatmapDecoder } from '../../src/game/beatmaps/LegacyBeatmapDecoder';
import { ModSet } from '../../src/game/mods/Mods';
import { createManiaPlayable } from '../../src/game/rulesets/mania/ManiaPlayableBeatmap';
import { maniaRuleset } from '../../src/game/rulesets/mania';
import { HoldNote } from '../../src/game/rulesets/mania/objects/ManiaHitObject';

const RESOURCES = resolve(__dirname, '../../../osu.Game.Rulesets.Mania.Tests/Resources/Testing/Beatmaps');
const CASES = ['convert-samples', 'mania-samples', 'mania-slider', 'slider-convert-samples', 'spinner-convert-samples'];

interface ExpectedObject {
  StartTime: number;
  EndTime: number;
  Column: number;
  PlaySlidingSamples?: boolean;
  Samples?: string[];
  NodeSamples?: string[][] | null;
}

/** Strips a BOM and trailing commas (some resources are not strict JSON). */
const stripJson = (text: string): string => text.replace(/^\uFEFF/, '').replace(/,(\s*[}\]])/g, '$1');

const lookupName = (s: HitSampleInfo): string => `Gameplay/${s.bank}-${s.name}${s.suffix ?? ''}`;

describe.skipIf(!existsSync(RESOURCES))('mania sample conversion matches lazer test resources', () => {
  for (const name of CASES) {
    it(name, () => {
      const beatmap = LegacyBeatmapDecoder.decode(readFileSync(resolve(RESOURCES, `${name}.osu`), 'utf8'));
      const expected: { Mappings: { StartTime: number; Objects: ExpectedObject[] }[] } = JSON.parse(
        stripJson(readFileSync(resolve(RESOURCES, `${name}-expected-conversion.json`), 'utf8')),
      );

      const playable = createManiaPlayable(beatmap, new ModSet(), maniaRuleset);
      const expectedObjects = expected.Mappings.flatMap(m => m.Objects).sort((a, b) => a.StartTime - b.StartTime || a.Column - b.Column);
      const actual = [...playable.hitObjects].sort((a, b) => a.startTime - b.startTime || a.column - b.column);

      expect(actual.length).toBe(expectedObjects.length);
      for (let i = 0; i < actual.length; i++) {
        const a = actual[i];
        const e = expectedObjects[i];
        const ctx = `${name} #${i} @${e.StartTime}`;
        expect(Math.abs(a.startTime - e.StartTime), ctx).toBeLessThanOrEqual(2);
        expect(Math.abs(a.endTime - e.EndTime), ctx).toBeLessThanOrEqual(2);
        expect(a.column, ctx).toBe(e.Column);
        expect(a instanceof HoldNote && a.playSlidingSamples, ctx).toBe(e.PlaySlidingSamples ?? false);
        if (e.Samples) expect(a.samples.map(lookupName), ctx).toEqual(e.Samples);
        if (e.NodeSamples !== undefined) {
          const ns = a instanceof HoldNote ? a.nodeSamples : null;
          expect(ns?.map(list => list.map(lookupName)) ?? null, ctx).toEqual(e.NodeSamples);
        }
      }
    });
  }
});
