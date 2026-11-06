// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Test helpers for the osu!mania ruleset.

import { Beatmap } from '../../src/game/beatmaps/Beatmap';
import { BeatmapDifficulty } from '../../src/game/beatmaps/Difficulty';
import { ModSet } from '../../src/game/mods/Mods';
import type { JudgementResult } from '../../src/game/scoring/Judgement';
import { createSkin } from '../../src/game/Skin';
import type { GameplayContext } from '../../src/game/rulesets/Ruleset';
import { maniaRuleset } from '../../src/game/rulesets/mania';
import { ManiaPlayableBeatmap } from '../../src/game/rulesets/mania/ManiaPlayableBeatmap';
import { applyManiaHitObjectMods } from '../../src/game/rulesets/mania/mods/ManiaMods';
import { HoldNote, Note, type ManiaHitObject } from '../../src/game/rulesets/mania/objects/ManiaHitObject';
import { ManiaScoreProcessor } from '../../src/game/rulesets/mania/scoring/ManiaScoreProcessor';
import { DrawableManiaRuleset } from '../../src/game/rulesets/mania/ui/DrawableManiaRuleset';

export function note(startTime: number, column = 0): Note {
  const n = new Note();
  n.startTime = startTime;
  n.column = column;
  return n;
}

export function hold(startTime: number, duration: number, column = 0): HoldNote {
  const h = new HoldNote();
  h.startTime = startTime;
  h.duration = duration;
  h.column = column;
  return h;
}

/** Builds a playable mania beatmap directly from objects (like the Beatmap<ManiaHitObject> used by lazer's input tests). */
export function buildPlayable(objects: ManiaHitObject[], options: { od?: number; hp?: number; columns?: number; mods?: string[] } = {}): ManiaPlayableBeatmap {
  const mods = new ModSet(options.mods ?? []);
  const source = new Beatmap();
  source.rulesetId = 3;
  const difficulty = new BeatmapDifficulty();
  difficulty.overallDifficulty = options.od ?? 5;
  difficulty.drainRate = options.hp ?? 5;
  source.difficulty = difficulty;
  const sorted = [...objects].sort((a, b) => a.startTime - b.startTime);
  for (const h of sorted) h.applyDefaults(difficulty.overallDifficulty);
  applyManiaHitObjectMods(sorted, mods);
  return new ManiaPlayableBeatmap(source, maniaRuleset, difficulty, mods, sorted, [], [options.columns ?? 4], false);
}

export interface Frame {
  time: number;
  /** Held columns from this time onwards. */
  columns: number[];
}

export interface RunResult {
  results: JudgementResult[];
  score: ManiaScoreProcessor;
  drawable: DrawableManiaRuleset;
}

export function makeContext(score: ManiaScoreProcessor, options: { autoplay?: boolean; mods?: ModSet; rate?: number } = {}): GameplayContext {
  return {
    mods: options.mods ?? new ModSet(),
    skin: createSkin(null),
    settings: { get: <T>(_key: string, fallback: T): T => fallback },
    autoplay: options.autoplay ?? false,
    rate: options.rate ?? 1,
    applyResult: (r: JudgementResult) => score.applyResult(r),
    playSamples: () => {},
    startLoop: () => null,
    isPressed: () => false,
    get combo() {
      return score.combo;
    },
    health: 1,
  };
}

/** Plays `frames` (like lazer's ManiaReplayFrame lists) against the playable, stepping the clock in small increments. */
export function play(playable: ManiaPlayableBeatmap, frames: Frame[], options: { autoplay?: boolean; endTime?: number; step?: number } = {}): RunResult {
  const score = new ManiaScoreProcessor();
  score.applyBeatmap(playable.perfectResults());
  const results: JudgementResult[] = [];
  const ctx = makeContext(score, { autoplay: options.autoplay, mods: playable.mods, rate: playable.mods.rate });
  const baseApply = ctx.applyResult;
  (ctx as { applyResult: (r: JudgementResult) => void }).applyResult = r => {
    baseApply(r);
    results.push(r);
  };

  const drawable = maniaRuleset.createDrawableRuleset(playable, ctx) as DrawableManiaRuleset;

  const lastObject = Math.max(0, ...playable.hitObjects.map(h => h.endTime));
  const endTime = options.endTime ?? Math.max(lastObject + 2000, ...frames.map(f => f.time + 1000));
  const step = options.step ?? 4;
  const held = new Set<number>();
  let frameIndex = 0;

  for (let t = -1000; t <= endTime; t += step) {
    while (frameIndex < frames.length && frames[frameIndex].time <= t) {
      const f = frames[frameIndex++];
      const next = new Set(f.columns);
      for (const c of [...held]) {
        if (!next.has(c)) {
          held.delete(c);
          drawable.onReleased(`K${c + 1}`, f.time);
        }
      }
      for (const c of next) {
        if (!held.has(c)) {
          held.add(c);
          drawable.onPressed(`K${c + 1}`, f.time);
        }
      }
    }
    drawable.update(t, step);
  }

  return { results, score, drawable };
}
