// Port of osu.Game.Tests/Beatmaps/Formats/LegacyBeatmapEncoderTest: decode → encode → decode must round-trip.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Beatmap } from '../../src/game/beatmaps/Beatmap';
import { LegacyBeatmapDecoder } from '../../src/game/beatmaps/LegacyBeatmapDecoder';
import { LegacyBeatmapEncoder } from '../../src/game/beatmaps/LegacyBeatmapEncoder';

const RES = join(__dirname, '../../../osu.Game.Tests/Resources');
const FILES = [
  'Soleily - Renatus (Gamu) [Insane].osu',
  'sample-beatmap-osu.osu',
  'sample-beatmap-taiko.osu',
  'sample-beatmap-catch.osu',
  'multi-segment-slider.osu',
  'controlpoint-custom-samplebank.osu',
  'hitobject-custom-samplebank.osu',
  'hitobject-file-samples.osu',
  'hitobject-combo-offset.osu',
  'custom-slider-length.osu',
  'omit-barline-control-points.osu',
  'storyboard_no_video.osu',
];

const r = (v: number) => Math.round(v * 1000) / 1000;

function summary(b: Beatmap) {
  return {
    rulesetId: b.rulesetId,
    metadata: { ...b.metadata },
    difficultyName: b.difficultyName,
    difficulty: { ...b.difficulty },
    flags: [b.audioLeadIn, b.stackLeniency, b.countdown, b.letterboxInBreaks, b.widescreenStoryboard, b.epilepsyWarning, b.beatDivisor],
    bookmarks: b.bookmarks,
    breaks: b.breaks,
    comboColours: b.comboColours,
    timing: b.controlPoints.timingPoints.map(p => [p.time, r(p.beatLength), p.timeSignature, p.omitFirstBarLine]),
    effects: b.hitObjects.map(h => [h.startTime, b.controlPoints.effectPointAt(h.startTime).kiaiMode]),
    objects: b.hitObjects.map(h => ({
      kind: h.kind,
      t: h.startTime,
      x: b.rulesetId === 1 ? 0 : h.x,
      y: b.rulesetId === 1 || b.rulesetId === 3 ? 0 : h.y,
      nc: h.newCombo,
      co: h.comboOffset,
      end: r(h.endTime),
      repeats: h.repeatCount,
      sv: r(h.sliderVelocityMultiplier),
      dist: r(h.path.distance),
      cps: h.path.controlPoints.map(c => [r(c.position.x), r(c.position.y), c.type?.type ?? null]),
      samples: h.samples.map(s => [s.name, s.bank, s.volume, s.customSampleBank, s.filename]).sort(),
      nodeSamples: h.nodeSamples.map(n => n.map(s => [s.name, s.bank, s.volume]).sort()),
    })),
  };
}

describe('LegacyBeatmapEncoder', () => {
  for (const f of FILES) {
    it(`round-trips ${f}`, () => {
      const original = LegacyBeatmapDecoder.decode(readFileSync(join(RES, f), 'utf8'));
      const encoded = LegacyBeatmapEncoder.encode(original);
      expect(encoded.startsWith('osu file format v128')).toBe(true);
      const decoded = LegacyBeatmapDecoder.decode(encoded);
      expect(summary(decoded)).toEqual(summary(original));
      // A second round trip keeps the same beatmap.
      expect(summary(LegacyBeatmapDecoder.decode(LegacyBeatmapEncoder.encode(decoded)))).toEqual(summary(original));
    });
  }
});
