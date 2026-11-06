import { describe, expect, it } from 'vitest';
import { LegacyBeatmapDecoder } from '../../src/game/beatmaps/LegacyBeatmapDecoder';
import { ModSet } from '../../src/game/mods/Mods';
import { osuRuleset } from '../../src/game/rulesets/osu';
import type { GameplayContext } from '../../src/game/rulesets/Ruleset';
import { createSkin } from '../../src/game/Skin';
import { demoMaps } from '../../src/game/demo/Demo';
import type { JudgementResult } from '../../src/game/scoring/Judgement';

/** Runs a ruleset's autoplay headlessly and returns all judgements. */
export function runAutoplay(text: string, mods: string[] = ['AT'], frameMs = 1000 / 60) {
  const beatmap = LegacyBeatmapDecoder.decode(text);
  const modSet = new ModSet(mods);
  const playable = osuRuleset.createPlayable(beatmap, modSet);
  const results: JudgementResult[] = [];
  const ctx: GameplayContext = {
    mods: modSet,
    skin: createSkin(null),
    settings: { get: (_k, f) => f },
    autoplay: modSet.isAutoplay,
    rate: modSet.rate,
    applyResult: r => results.push(r),
    playSamples: () => {},
    startLoop: () => null,
    isPressed: () => false,
    combo: 0,
    health: 1,
  };
  const d = osuRuleset.createDrawableRuleset(playable, ctx);
  const end = Math.max(...playable.objectTimes.map(t => t.end)) + 2000;
  for (let t = -2000; t < end && !d.hasCompleted; t += frameMs * modSet.rate) d.update(t, frameMs * modSet.rate);
  return { results, playable, completed: d.hasCompleted };
}

describe('osu! autoplay', () => {
  for (const [name, map] of [['easy', demoMaps.osuEasy()], ['normal', demoMaps.osuNormal()]] as const) {
    for (const mods of [['AT'], ['AT', 'DT'], ['AT', 'HR'], ['AT', 'HT']]) {
      it(`plays the ${name} demo perfectly with ${mods.join('')}`, () => {
        const { results, playable, completed } = runAutoplay(map, mods);
        expect(completed).toBe(true);
        const bad = results.filter(r => r.type !== r.judgement.maxResult && r.judgement.maxResult < 11);
        expect(bad.map(r => `${r.tag}@${r.objectEndTime.toFixed(0)}: ${r.type}`)).toEqual([]);
        expect(results.length).toBe(playable.perfectResults().length);
      });
    }
  }
});
