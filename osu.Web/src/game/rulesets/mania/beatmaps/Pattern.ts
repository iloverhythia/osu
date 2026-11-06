// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game.Rulesets.Mania/Beatmaps/Patterns/Pattern.cs and Legacy/PatternType.cs

import type { ManiaHitObject } from '../objects/ManiaHitObject';

/** Creates a pattern containing hit objects. */
export class Pattern {
  private objects: ManiaHitObject[] | null = null;
  private containedColumns: Set<number> | null = null;

  get hitObjects(): readonly ManiaHitObject[] {
    return this.objects ?? [];
  }

  /** Check whether a column of this pattern contains a hit object. */
  columnHasObject(column: number): boolean {
    return this.containedColumns?.has(column) === true;
  }

  /** Amount of columns taken up by hit objects in this pattern. */
  get columnWithObjects(): number {
    return this.containedColumns?.size ?? 0;
  }

  add(hitObject: ManiaHitObject): void {
    this.prepareStorage();
    this.objects!.push(hitObject);
    this.containedColumns!.add(hitObject.column);
  }

  /** Copies hit objects from another pattern to this one. */
  addPattern(other: Pattern): void {
    this.prepareStorage();
    if (other.objects != null) {
      this.objects!.push(...other.objects);
      for (const h of other.objects) this.containedColumns!.add(h.column);
    }
  }

  clear(): void {
    if (this.objects) this.objects.length = 0;
    this.containedColumns?.clear();
  }

  private prepareStorage(): void {
    this.objects ??= [];
    this.containedColumns ??= new Set();
  }
}

/** The type of pattern to generate. Used for legacy patterns. [Flags] */
export const PatternType = {
  None: 0,
  /** Keep the same as last row. */
  ForceStack: 1,
  /** Keep different from last row. */
  ForceNotStack: 1 << 1,
  /** Keep as single note at its original position. */
  KeepSingle: 1 << 2,
  /** Use a lower random value. */
  LowProbability: 1 << 3,
  /** Reserved. */
  Alternate: 1 << 4,
  /** Ignore the repeat count. */
  ForceSigSlider: 1 << 5,
  /** Convert slider to circle. */
  ForceNotSlider: 1 << 6,
  /** Notes gathered together. */
  Gathered: 1 << 7,
  Mirror: 1 << 8,
  /** Change 0 -> 6. */
  Reverse: 1 << 9,
  /** 1 -> 5 -> 1 -> 5 like reverse. */
  Cycle: 1 << 10,
  /** Next note will be at column + 1. */
  Stair: 1 << 11,
  /** Next note will be at column - 1. */
  ReverseStair: 1 << 12,
} as const;

export const hasFlag = (value: number, flag: number): boolean => (value & flag) === flag;
