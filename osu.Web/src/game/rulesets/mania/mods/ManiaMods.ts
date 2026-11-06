// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Ports of osu.Game.Rulesets.Mania/Mods: ManiaModMirror, ManiaModRandom, ManiaKeyMod, ManiaModEasy/HardRock
// (difficulty + hit window multipliers), IManiaRateAdjustmentMod, and ManiaScoreMultiplierCalculator.

import { BeatmapDifficulty } from '../../../beatmaps/Difficulty';
import type { ModSet } from '../../../mods/Mods';
import { HoldNote, type ManiaHitObject } from '../objects/ManiaHitObject';
import type { ManiaHitWindows } from '../scoring/ManiaHitWindows';
import { f32 } from '../utils';
import { DotNetRandom } from './DotNetRandom';

export const MANIA_MODS: readonly string[] = [
  'EZ', 'NF', 'HT', 'DC', 'HR', 'SD', 'PF', 'DT', 'NC', 'FI', 'HD', 'FL', 'AC',
  'RD', 'MR', '1K', '2K', '3K', '4K', '5K', '6K', '7K', '8K', '9K', '10K', 'AT', 'CN',
];

/** ManiaModEasy.HIT_WINDOW_DIFFICULTY_MULTIPLIER */
export const EASY_HIT_WINDOW_DIFFICULTY_MULTIPLIER = 1 / 1.4;
/** ManiaModHardRock.HIT_WINDOW_DIFFICULTY_MULTIPLIER */
export const HARD_ROCK_HIT_WINDOW_DIFFICULTY_MULTIPLIER = 1.4;

/** The key count selected by a key mod (1K..10K), if any. */
export function keyModCount(mods: ModSet): number | null {
  for (let k = 1; k <= 10; k++) if (mods.has(`${k}K`)) return k;
  return null;
}

/**
 * IApplicableToDifficulty for mania: ModEasy halves CS / AR / HP, ModHardRock multiplies HP by 1.4 (capped at 10).
 * Neither changes OD in osu!mania (hit windows are adjusted per-object instead).
 */
export function applyManiaDifficultyMods(d: BeatmapDifficulty, mods: ModSet): BeatmapDifficulty {
  const out = d.clone();
  if (mods.has('EZ')) {
    const ratio = 0.5;
    out.circleSize = f32(out.circleSize * ratio);
    out.approachRate = f32(out.approachRate * ratio);
    out.drainRate = f32(out.drainRate * ratio);
  }
  if (mods.has('HR')) {
    const ratio = f32(1.4);
    out.drainRate = Math.min(f32(f32(out.drainRate) * ratio), 10.0);
  }
  return out;
}

function forEachHitWindows(h: ManiaHitObject, fn: (w: ManiaHitWindows) => void): void {
  if (h instanceof HoldNote) {
    if (h.head?.hitWindows) fn(h.head.hitWindows);
    if (h.tail?.hitWindows) fn(h.tail.hitWindows);
  } else if (h.hitWindows) fn(h.hitWindows);
}

/** IApplicableToHitObject mods (EZ / HR hit window difficulty multipliers, rate-adjust speed multiplier). */
export function applyManiaHitObjectMods(objects: readonly ManiaHitObject[], mods: ModSet): void {
  const rate = mods.rate;
  for (const h of objects) {
    forEachHitWindows(h, w => {
      if (mods.has('EZ')) w.difficultyMultiplier = EASY_HIT_WINDOW_DIFFICULTY_MULTIPLIER;
      if (mods.has('HR')) w.difficultyMultiplier = HARD_ROCK_HIT_WINDOW_DIFFICULTY_MULTIPLIER;
      if (rate !== 1) w.speedMultiplier = rate;
    });
  }
}

/** ManiaModMirror.ApplyToBeatmap */
export function applyMirror(objects: readonly ManiaHitObject[], totalColumns: number): void {
  for (const h of objects) h.column = totalColumns - 1 - h.column;
}

/** ManiaModRandom.ApplyToBeatmap */
export function applyRandom(objects: readonly ManiaHitObject[], totalColumns: number, seed: number): void {
  const rng = new DotNetRandom(seed);
  // Enumerable.Range(0, n).OrderBy(_ => rng.Next()) — keys are computed once per element, then stable-sorted.
  const keyed = Array.from({ length: totalColumns }, (_, i) => ({ column: i, key: rng.next() }));
  keyed.sort((a, b) => a.key - b.key);
  const shuffledColumns = keyed.map(k => k.column);
  for (const h of objects) h.column = shuffledColumns[h.column];
}

/** ManiaScoreMultiplierCalculator.rateAdjustMultiplier */
function rateAdjustMultiplier(speedChange: number): number {
  // Round to the nearest multiple of 0.1.
  let value = Math.trunc(speedChange * 10) / 10.0;
  // Offset back to 0.
  value -= 1;
  if (speedChange >= 1) return 1 + value / 5;
  return 0.6 + value;
}

/** ManiaScoreMultiplierCalculator.CalculateFor (current multipliers, i.e. no legacy score context). */
export function maniaScoreMultiplier(mods: ModSet): number {
  let result = 1;
  if (mods.has('EZ')) result *= 0.5;
  if (mods.has('NF')) result *= 0.5;
  if (mods.has('HT')) result *= rateAdjustMultiplier(0.75);
  if (mods.has('DC')) result *= rateAdjustMultiplier(0.75);
  if (keyModCount(mods) != null) result *= 0.9;
  return result;
}
