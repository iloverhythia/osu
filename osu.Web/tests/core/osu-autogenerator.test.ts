// Plays lazer's OsuAutoGenerator replay through the osu! playfield's normal input path (like ReplayInputHandler).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LegacyBeatmapDecoder } from '../../src/game/beatmaps/LegacyBeatmapDecoder';
import { demoMaps } from '../../src/game/demo/Demo';
import { ModSet } from '../../src/game/mods/Mods';
import { osuRuleset } from '../../src/game/rulesets/osu';
import { osuPlayfieldTransform } from '../../src/game/rulesets/osu/playfield';
import type { GameplayContext } from '../../src/game/rulesets/Ruleset';
import type { JudgementResult } from '../../src/game/scoring/Judgement';
import { createSkin } from '../../src/game/Skin';

const W = 1280;
const H = 720;

function playGeneratedAutoplay(text: string, mods: string[]) {
  const modSet = new ModSet(mods);
  const playable = osuRuleset.createPlayable(LegacyBeatmapDecoder.decode(text), modSet);
  const replay = osuRuleset.generateAutoplay!(playable);
  const results: JudgementResult[] = [];
  const ctx: GameplayContext = {
    mods: modSet,
    skin: createSkin(null),
    settings: { get: (_k, f) => f },
    autoplay: false,
    rate: modSet.rate,
    applyResult: r => results.push(r),
    playSamples: () => {},
    startLoop: () => null,
    isPressed: () => false,
    combo: 0,
    health: 1,
  };
  const d = osuRuleset.createDrawableRuleset(playable, ctx);
  const stub = new Proxy({}, { get: () => () => ({ addColorStop() {} }) }) as unknown as CanvasRenderingContext2D;
  d.render(stub, W, H, -3000);
  const tr = osuPlayfieldTransform(W, H);
  const frameMs = (1000 / 60) * modSet.rate;
  const end = Math.max(...playable.objectTimes.map(t => t.end)) + 2000;
  let i = 0;
  for (let t = replay.events[0].t - 100; t < end; t += frameMs) {
    while (i < replay.events.length && replay.events[i].t <= t) {
      const e = replay.events[i++];
      if (e.k === 'm') d.onPointerMove!(tr.offsetX + e.x * tr.scale, tr.offsetY + e.y * tr.scale, e.t);
      else if (e.k === 'p') d.onPressed(e.a, e.t);
      else if (e.k === 'r') d.onReleased(e.a, e.t);
    }
    d.update(t, frameMs);
  }
  return { results, playable, completed: d.hasCompleted, replay };
}

const maps: [string, string][] = [
  ['demo normal', demoMaps.osuNormal()],
  ['demo easy', demoMaps.osuEasy()],
  ['801165 (real map)', readFileSync('/home/user/osu/osu.Game.Rulesets.Osu.Tests/Resources/Testing/Beatmaps/801165.osu', 'utf8')],
];

describe('OsuAutoGenerator replay', () => {
  for (const [name, text] of maps) {
    for (const mods of [[], ['DT'], ['HR'], ['HT']]) {
      it(`plays ${name} perfectly${mods.length ? ' with ' + mods.join('') : ''}`, () => {
        const { results, playable, completed } = playGeneratedAutoplay(text, mods);
        expect(completed).toBe(true);
        const bad = results.filter(r => r.type !== r.judgement.maxResult && r.judgement.maxResult < 11);
        expect(bad.map(r => `${r.tag}@${r.objectEndTime.toFixed(0)}: ${r.type} (${r.timeOffset.toFixed(1)})`).slice(0, 10)).toEqual([]);
        expect(results.length).toBe(playable.perfectResults().length);
      });
    }
  }
});
