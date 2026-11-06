// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Visual harness for the taiko / catch / mania drawable rulesets: renders the built-in demo beatmap at chosen times
// with autoplay so headless screenshots (see run.mjs) can be compared against lazer's Argon skin.
import { LegacyBeatmapDecoder } from '../../src/game/beatmaps/LegacyBeatmapDecoder';
import { demoMaps } from '../../src/game/demo/Demo';
import { ModSet } from '../../src/game/mods/Mods';
import { getRuleset } from '../../src/game/rulesets';
import type { DrawableRuleset, GameplayContext } from '../../src/game/rulesets/Ruleset';
import { HitResult, isHit } from '../../src/game/scoring/HitResult';
import { createSkin } from '../../src/game/Skin';

const params = new URLSearchParams(location.search);
const rulesetId = Number(params.get('ruleset') ?? 1);
const mods = new ModSet((params.get('mods') ?? '').split(',').filter(Boolean));
const width = Number(params.get('w') ?? 1366);
const height = Number(params.get('h') ?? 768);
const settings: Record<string, unknown> = JSON.parse(params.get('settings') ?? '{}');

const canvas = document.getElementById('c') as HTMLCanvasElement;
canvas.width = width;
canvas.height = height;
canvas.style.width = `${width}px`;
canvas.style.height = `${height}px`;
const g = canvas.getContext('2d')!;

const ruleset = getRuleset(rulesetId);
const mapParam = params.get('map');
const text = mapParam ? await (await fetch(`./maps/${mapParam}`)).text() : rulesetId === 3 ? demoMaps.mania() : demoMaps.osuNormal();
const beatmap = LegacyBeatmapDecoder.decode(text);
const playable = ruleset.createPlayable(beatmap, mods);

let combo = 0;
const ctx: GameplayContext = {
  mods,
  skin: createSkin(null),
  settings: {
    get: <T>(key: string, fallback: T): T => (key in settings ? (settings[key] as T) : fallback),
  },
  autoplay: params.get('autoplay') !== '0',
  rate: mods.rate,
  applyResult: r => {
    if (params.has('debug')) console.log('result', r.type, r.judgement.maxResult);
    if (r.type === HitResult.Miss) combo = 0;
    else if (isHit(r.type) && r.judgement.maxResult !== HitResult.IgnoreHit) combo++;
  },
  playSamples: () => {},
  startLoop: () => null,
  isPressed: () => false,
  get combo() {
    return combo;
  },
  health: 1,
};

const drawable: DrawableRuleset = ruleset.createDrawableRuleset(playable, ctx);
let now = (playable.objectTimes[0]?.start ?? 0) - 2000;

function step(to: number): void {
  while (now < to) {
    const dt = Math.min(16, to - now);
    now += dt;
    drawable.update(now, dt);
  }
}

function render(): void {
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = '#2a2a33';
  g.fillRect(0, 0, width, height);
  drawable.render(g, width, height, now);
}

const api = {
  objectTimes: playable.objectTimes,
  kinds: (playable.hitObjects as { kind?: string; startTime: number }[]).map(o => `${o.kind}@${o.startTime}`),
  renderAt(time: number): void {
    step(time);
    render();
  },
  press(action: string): void {
    drawable.onPressed(action, now);
  },
  release(action: string): void {
    drawable.onReleased(action, now);
  },
};
(window as unknown as { harness: typeof api }).harness = api;
document.fonts.ready.then(() => document.body.setAttribute('data-ready', '1'));
