import { describe, expect, it } from 'vitest';
import { LegacyBeatmapDecoder } from '../../src/game/beatmaps/LegacyBeatmapDecoder';
import { demoMaps } from '../../src/game/demo/Demo';
import { ModSet } from '../../src/game/mods/Mods';
import { osuRuleset } from '../../src/game/rulesets/osu';
import { Slider, Spinner, type OsuHitObject } from '../../src/game/rulesets/osu/objects';
import { osuPlayfieldTransform } from '../../src/game/rulesets/osu/playfield';
import type { GameplayContext } from '../../src/game/rulesets/Ruleset';
import type { ReplayEvent } from '../../src/game/replays/Replay';
import { createSkin } from '../../src/game/Skin';
import { HitResult } from '../../src/game/scoring/HitResult';

const W = 1280;
const H = 720;

/** Plays recorded gamefield events into a fresh drawable ruleset (what PlayerScreen.playReplayTo does). */
function play(events: ReplayEvent[], frameMs: number): HitResult[] {
  const playable = osuRuleset.createPlayable(LegacyBeatmapDecoder.decode(demoMaps.osuNormal()), new ModSet());
  const results: HitResult[] = [];
  const ctx: GameplayContext = {
    mods: new ModSet(),
    skin: createSkin(null),
    settings: { get: (_k, f) => f },
    autoplay: false,
    rate: 1,
    applyResult: r => results.push(r.type),
    playSamples: () => {},
    startLoop: () => null,
    isPressed: () => false,
    combo: 0,
    health: 1,
  };
  const d = osuRuleset.createDrawableRuleset(playable, ctx);
  // The ruleset computes its screen transform when rendering; give it a stub context once.
  const stub = new Proxy({}, { get: () => () => ({ addColorStop() {} }) }) as unknown as CanvasRenderingContext2D;
  d.render(stub, W, H, -3000);
  const tr = osuPlayfieldTransform(W, H);
  let i = 0;
  const end = Math.max(...playable.objectTimes.map(t => t.end)) + 1500;
  for (let t = -2000; t < end; t += frameMs) {
    while (i < events.length && events[i].t <= t) {
      const e = events[i++];
      if (e.k === 'm') d.onPointerMove!(tr.offsetX + e.x * tr.scale, tr.offsetY + e.y * tr.scale, e.t);
      else if (e.k === 'p') d.onPressed(e.a, e.t);
      else if (e.k === 'r') d.onReleased(e.a, e.t);
    }
    d.update(t, frameMs);
  }
  return results;
}

/** Builds a "human" replay that follows every object, hitting circles 12ms late. */
function buildEvents(): ReplayEvent[] {
  const playable = osuRuleset.createPlayable(LegacyBeatmapDecoder.decode(demoMaps.osuNormal()), new ModSet());
  const ev: ReplayEvent[] = [];
  let key: 'LeftButton' | 'RightButton' = 'LeftButton';
  for (const h of playable.hitObjects as OsuHitObject[]) {
    const t0 = h.startTime + 12;
    if (h instanceof Spinner) {
      ev.push({ t: h.startTime - 50, k: 'm', x: 256, y: 142 }, { t: h.startTime, k: 'p', a: key });
      for (let t = h.startTime; t <= h.endTime; t += 8) {
        const a = (t - h.startTime) * 0.04;
        ev.push({ t, k: 'm', x: 256 + Math.sin(a) * 50, y: 192 - Math.cos(a) * 50 });
      }
      ev.push({ t: h.endTime + 10, k: 'r', a: key });
    } else {
      const p = h.stackedPosition;
      ev.push({ t: t0 - 30, k: 'm', x: p.x, y: p.y }, { t: t0, k: 'p', a: key });
      if (h instanceof Slider) {
        for (let t = t0; t <= h.endTime; t += 10) {
          const q = h.stackedPositionAt((t - h.startTime) / h.duration);
          ev.push({ t, k: 'm', x: q.x, y: q.y });
        }
        ev.push({ t: h.endTime + 20, k: 'r', a: key });
      } else ev.push({ t: t0 + 40, k: 'r', a: key });
    }
    key = key === 'LeftButton' ? 'RightButton' : 'LeftButton';
  }
  return ev.sort((a, b) => a.t - b.t);
}

describe('replay playback', () => {
  it('produces identical judgements at different frame rates', () => {
    const events = buildEvents();
    const a = play(events, 1000 / 60);
    const b = play(events, 1000 / 240);
    expect(a.length).toBeGreaterThan(100);
    expect(b).toEqual(a);
    // 12ms late is within the Great window at OD6, so circles should all be Greats.
    expect(a.filter(r => r === HitResult.Miss).length).toBe(0);
  });
});
