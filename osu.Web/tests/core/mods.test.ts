import { describe, expect, it } from 'vitest';
import { LegacyBeatmapDecoder } from '../../src/game/beatmaps/LegacyBeatmapDecoder';
import { ModSet, applyDifficultyAdjust, rateAdjustMultiplier } from '../../src/game/mods/Mods';
import { osuRuleset } from '../../src/game/rulesets/osu';
import { taikoRuleset } from '../../src/game/rulesets/taiko';
import { demoMaps } from '../../src/game/demo/Demo';

describe('mod settings', () => {
  it('uses customised rates and pitch settings', () => {
    let m = new ModSet(['DT']);
    expect(m.rate).toBe(1.5);
    expect(m.preservePitch).toBe(true);
    m = m.withSetting('DT', 'speed', 1.3).withSetting('DT', 'adjustPitch', true);
    expect(m.rate).toBe(1.3);
    expect(m.preservePitch).toBe(false);
    expect(m.isRanked).toBe(false);
    expect(m.label('DT')).toBe('DT (1.30x)');
    // Setting back to the default clears the customisation.
    expect(m.withSetting('DT', 'speed', 1.5).withSetting('DT', 'adjustPitch', false).isRanked).toBe(true);
    expect(new ModSet(['NC']).preservePitch).toBe(false);
  });

  it('keeps settings across toggles and ruleset filtering', () => {
    const m = new ModSet(['HT']).withSetting('HT', 'speed', 0.6).toggle('HD').forRuleset('osu', osuRuleset.availableMods);
    expect(m.rate).toBe(0.6);
    expect(m.has('HD')).toBe(true);
  });

  it('applies rate to score multipliers (ModRateAdjust)', () => {
    const m = new ModSet(['DT']).withSetting('DT', 'speed', 1.2);
    expect(osuRuleset.scoreMultiplier(m)).toBeCloseTo(rateAdjustMultiplier(1.2));
    expect(taikoRuleset.scoreMultiplier(m)).toBeCloseTo(rateAdjustMultiplier(1.2));
  });

  it('applies Difficulty Adjust overrides before conversion', () => {
    const beatmap = LegacyBeatmapDecoder.decode(demoMaps.osuNormal());
    const mods = new ModSet(['DA']).withSetting('DA', 'approachRate', 10).withSetting('DA', 'circleSize', 7);
    const adjusted = applyDifficultyAdjust(beatmap, mods);
    expect(adjusted.difficulty.approachRate).toBe(10);
    expect(beatmap.difficulty.approachRate).toBe(7); // original untouched
    const playable = osuRuleset.createPlayable(adjusted, mods);
    expect(playable.difficulty.approachRate).toBe(10);
    expect(playable.difficulty.overallDifficulty).toBe(beatmap.difficulty.overallDifficulty);
    expect(adjusted.hitObjects).toBe(beatmap.hitObjects);
  });
});
