// Port of osu.Game.Rulesets.Osu.Tests/OsuBeatmapConversionTest.cs against lazer's expected-conversion JSON.
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LegacyBeatmapDecoder } from '../../src/game/beatmaps/LegacyBeatmapDecoder';
import { ModSet } from '../../src/game/mods/Mods';
import { osuRuleset } from '../../src/game/rulesets/osu';
import { OsuHitObject, Slider, SliderTailCircle } from '../../src/game/rulesets/osu/objects';

const DIR = '/home/user/osu/osu.Game.Rulesets.Osu.Tests/Resources/Testing/Beatmaps/';
const CASES = [
  'basic',
  'colinear-perfect-curve',
  'slider-ticks',
  'slider-ticks-edge-case',
  'slider-paths-edge-case',
  'repeat-slider',
  'uneven-repeat-slider',
  'old-stacking',
  'multi-segment-slider',
  'nan-slider',
  '1124896',
  '1341554',
  '2593923',
  '801165',
];
const LENIENCE = 2;
const TAIL_LENIENCY = -36;

interface ConvertValue {
  StartTime: number;
  EndTime: number;
  X: number;
  Y: number;
}

function convertValue(obj: OsuHitObject, parent?: Slider): ConvertValue {
  let startTime = obj.startTime;
  let endTime = obj.endTime;
  if (obj instanceof SliderTailCircle && parent) {
    startTime = Math.max(startTime + TAIL_LENIENCY, parent.startTime + parent.duration / 2);
    endTime = Math.max(endTime + TAIL_LENIENCY, parent.startTime + parent.duration / 2);
  }
  const p = obj.stackedPosition;
  return { StartTime: startTime, EndTime: endTime, X: Math.fround(p.x), Y: Math.fround(p.y) };
}

describe.skipIf(!existsSync(DIR))('OsuBeatmapConversionTest', () => {
  for (const name of CASES) {
    it(name, () => {
      const expected = JSON.parse(readFileSync(`${DIR}${name}-expected-conversion.json`, 'utf8')) as { Mappings: { StartTime: number; Objects: ConvertValue[] }[] };
      // BeatmapConversionTest sets ApplyOffsets = false.
      const beatmap = LegacyBeatmapDecoder.decode(readFileSync(`${DIR}${name}.osu`, 'utf8'), false);
      const playable = osuRuleset.createPlayable(beatmap, new ModSet());
      const ours = (playable.hitObjects as OsuHitObject[]).map(h => ({
        StartTime: h.startTime,
        Objects: h instanceof Slider ? h.nested.map(n => convertValue(n, h)) : [convertValue(h)],
      }));
      expect(ours.length).toBe(expected.Mappings.length);
      for (let i = 0; i < expected.Mappings.length; i++) {
        const e = expected.Mappings[i];
        const o = ours[i];
        expect(Math.abs(o.StartTime - e.StartTime), `mapping ${i} start time`).toBeLessThanOrEqual(LENIENCE);
        expect(o.Objects.length, `object count for mapping at ${e.StartTime}`).toBe(e.Objects.length);
        e.Objects.forEach((eo, j) => {
          const oo = o.Objects[j];
          const ok =
            Math.abs(oo.StartTime - eo.StartTime) <= LENIENCE &&
            Math.abs(oo.EndTime - eo.EndTime) <= LENIENCE &&
            Math.abs(oo.X - eo.X) <= LENIENCE &&
            Math.abs(oo.Y - eo.Y) <= LENIENCE;
          expect(ok, `mapping at ${e.StartTime}, object ${j}: expected ${JSON.stringify(eo)}, got ${JSON.stringify(oo)}`).toBe(true);
        });
      }
    });
  }
});
