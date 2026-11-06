// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game/Beatmaps/BeatmapDifficulty.cs + IBeatmapDifficultyInfo.DifficultyRange helpers.

export interface DifficultyRangeDef {
  min: number; // value at difficulty 0
  mid: number; // value at difficulty 5
  max: number; // value at difficulty 10
}

export const range = (min: number, mid: number, max: number): DifficultyRangeDef => ({ min, mid, max });

/** Maps a difficulty value [0, 10] to a linear range of [-1, 1]. */
export function difficultyRangeUnit(difficulty: number): number {
  return (difficulty - 5) / 5;
}

export function difficultyRange(difficulty: number, min: number | DifficultyRangeDef, mid?: number, max?: number): number {
  if (typeof min === 'object') {
    max = min.max;
    mid = min.mid;
    min = min.min;
  }
  if (difficulty > 5) return mid! + (max! - mid!) * difficultyRangeUnit(difficulty);
  if (difficulty < 5) return mid! + (mid! - min) * difficultyRangeUnit(difficulty);
  return mid!;
}

export function difficultyRangeInt(difficulty: number, r: DifficultyRangeDef): number {
  return Math.trunc(difficultyRange(difficulty, r));
}

export function inverseDifficultyRange(value: number, diff0: number, diff5: number, diff10: number): number {
  return Math.sign(value - diff5) === Math.sign(diff10 - diff5)
    ? ((value - diff5) / (diff10 - diff5)) * 5 + 5
    : ((value - diff5) / (diff5 - diff0)) * 5 + 5;
}

export class BeatmapDifficulty {
  drainRate = 5;
  circleSize = 5;
  overallDifficulty = 5;
  approachRate = 5;
  sliderMultiplier = 1.4;
  sliderTickRate = 1;

  clone(): BeatmapDifficulty {
    return Object.assign(new BeatmapDifficulty(), this);
  }
}
