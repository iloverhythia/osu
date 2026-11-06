// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game.Rulesets.Taiko/Scoring/TaikoHitWindows.cs

import { difficultyRange, range } from '../../beatmaps/Difficulty';
import { HitResult } from '../../scoring/HitResult';
import { HitWindows } from '../../scoring/HitWindows';

export class TaikoHitWindows extends HitWindows {
  static readonly GREAT_WINDOW_RANGE = range(50, 35, 20);
  static readonly OK_WINDOW_RANGE = range(120, 80, 50);
  static readonly MISS_WINDOW_RANGE = range(135, 95, 70);

  private great = 0;
  private ok = 0;
  private miss = 0;

  isHitResultAllowed(result: HitResult): boolean {
    switch (result) {
      case HitResult.Great:
      case HitResult.Ok:
      case HitResult.Miss:
        return true;
    }
    return false;
  }

  setDifficulty(difficulty: number): void {
    this.great = Math.floor(difficultyRange(difficulty, TaikoHitWindows.GREAT_WINDOW_RANGE)) - 0.5;
    this.ok = Math.floor(difficultyRange(difficulty, TaikoHitWindows.OK_WINDOW_RANGE)) - 0.5;
    this.miss = Math.floor(difficultyRange(difficulty, TaikoHitWindows.MISS_WINDOW_RANGE)) - 0.5;
  }

  windowFor(result: HitResult): number {
    switch (result) {
      case HitResult.Great:
        return this.great;
      case HitResult.Ok:
        return this.ok;
      case HitResult.Miss:
        return this.miss;
      default:
        throw new RangeError(`Invalid hit result ${result}`);
    }
  }
}
