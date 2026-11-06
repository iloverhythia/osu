// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game/Rulesets/Scoring/HitWindows.cs + DefaultHitWindows.cs

import { difficultyRange, range } from '../beatmaps/Difficulty';
import { HitResult } from './HitResult';

export abstract class HitWindows {
  isHitResultAllowed(_result: HitResult): boolean {
    return true;
  }

  abstract setDifficulty(difficulty: number): void;
  abstract windowFor(result: HitResult): number;

  protected lowestSuccessfulHitResult(): HitResult {
    for (let r = HitResult.Meh; r <= HitResult.Perfect; ++r) if (this.isHitResultAllowed(r)) return r;
    return HitResult.None;
  }

  /** All windows from Miss to Perfect that are allowed. */
  getAllAvailableWindows(): { result: HitResult; length: number }[] {
    const out: { result: HitResult; length: number }[] = [];
    for (let r = HitResult.Miss; r <= HitResult.Perfect; ++r) if (this.isHitResultAllowed(r)) out.push({ result: r, length: this.windowFor(r) });
    return out;
  }

  /** Retrieves the HitResult for a time offset, or None if outside every window. */
  resultFor(timeOffset: number): HitResult {
    timeOffset = Math.abs(timeOffset);
    for (let r = HitResult.Perfect; r >= HitResult.Miss; --r) {
      if (this.isHitResultAllowed(r) && timeOffset <= this.windowFor(r)) return r;
    }
    return HitResult.None;
  }

  /** Whether it's possible to achieve a successful HitResult at a time offset (timeOffset is negative before the object). */
  canBeHit(timeOffset: number): boolean {
    return timeOffset <= this.windowFor(this.lowestSuccessfulHitResult());
  }
}

export class EmptyHitWindows extends HitWindows {
  setDifficulty(): void {}
  windowFor(): number {
    return 0;
  }
}

export class DefaultHitWindows extends HitWindows {
  private static readonly ranges: Partial<Record<HitResult, ReturnType<typeof range>>> = {
    [HitResult.Perfect]: range(22.4, 19.4, 13.9),
    [HitResult.Great]: range(64, 49, 34),
    [HitResult.Good]: range(97, 82, 67),
    [HitResult.Ok]: range(127, 112, 97),
    [HitResult.Meh]: range(151, 136, 121),
    [HitResult.Miss]: range(188, 173, 158),
  };
  private windows = new Map<HitResult, number>();

  setDifficulty(difficulty: number): void {
    for (const [k, r] of Object.entries(DefaultHitWindows.ranges)) this.windows.set(Number(k) as HitResult, difficultyRange(difficulty, r!));
  }

  windowFor(result: HitResult): number {
    const w = this.windows.get(result);
    if (w === undefined) throw new Error(`No window for ${result}`);
    return w;
  }
}
