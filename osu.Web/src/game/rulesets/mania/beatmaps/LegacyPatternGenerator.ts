// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game.Rulesets.Mania/Beatmaps/Patterns/PatternGenerator.cs + Legacy/LegacyPatternGenerator.cs

import type { LegacyRandom } from '../../../../framework/math';
import type { Beatmap, ConvertHitObject } from '../../../beatmaps/Beatmap';
import { clampNum, f32 } from '../utils';
import type { Pattern } from './Pattern';

/** Occurs when mania conversion is stuck in an infinite loop unable to find columns to place new hitobjects in. */
export class NotEnoughColumnsException extends Error {
  constructor() {
    super('There were not enough columns to complete conversion.');
  }
}

export interface FindColumnOptions {
  /** The minimum column index. If undefined, RandomStart is used. */
  lowerBound?: number | null;
  /** The maximum column index. If undefined, TotalColumns is used. */
  upperBound?: number | null;
  /** A function to retrieve the next column. If undefined, a randomisation scheme will be used. */
  nextColumn?: (last: number) => number;
  /** Additional validation for a candidate column. */
  validation?: (column: number) => boolean;
  /** A column is not a valid candidate if any of these patterns occupies it. */
  patterns?: Pattern[];
}

/** Total break time of a beatmap (Beatmap.TotalBreakTime). */
export function totalBreakTime(beatmap: Beatmap): number {
  let t = 0;
  for (const b of beatmap.breaks) t += b.endTime - b.startTime;
  return t;
}

/** A pattern generator for legacy hit objects. */
export abstract class LegacyPatternGenerator {
  /** The column index at which to start generating random notes. */
  protected readonly randomStart: number;

  private _conversionDifficulty: number | null = null;

  protected constructor(
    protected readonly random: LegacyRandom,
    /** The hit object to create the pattern for. */
    protected readonly hitObject: ConvertHitObject,
    /** The (un-converted) beatmap which hitObject is a part of. */
    protected readonly beatmap: Beatmap,
    /** The last pattern. */
    protected readonly previousPattern: Pattern,
    protected readonly totalColumns: number,
  ) {
    this.randomStart = totalColumns === 8 ? 1 : 0;
  }

  /** Generates the patterns for hitObject, each filled with hit objects. */
  abstract generate(): Pattern[];

  /**
   * Converts an x-position into a column.
   * @param allowSpecial Whether to treat as 7K + 1.
   */
  protected getColumn(position: number, allowSpecial = false): number {
    if (allowSpecial && this.totalColumns === 8) {
      const localXDivisor = f32(512 / 7);
      return clampNum(Math.trunc(Math.floor(f32(position / localXDivisor))), 0, 6) + 1;
    }

    const localXDivisor = f32(512 / this.totalColumns);
    return clampNum(Math.trunc(Math.floor(f32(position / localXDivisor))), 0, this.totalColumns - 1);
  }

  /** Generates a count of notes to be generated from probabilities. */
  protected getRandomNoteCount(p2: number, p3: number, p4 = 0, p5 = 0, p6 = 0): number {
    for (const p of [p2, p3, p4, p5, p6]) if (p < 0 || p > 1) throw new RangeError('Probability out of range');

    const val = this.random.nextDouble();
    if (val >= 1 - p6) return 6;
    if (val >= 1 - p5) return 5;
    if (val >= 1 - p4) return 4;
    if (val >= 1 - p3) return 3;
    return val >= 1 - p2 ? 2 : 1;
  }

  /** A difficulty factor used for various conversion methods from osu!stable. */
  protected get conversionDifficulty(): number {
    if (this._conversionDifficulty != null) return this._conversionDifficulty;

    const objects = this.beatmap.hitObjects;
    const lastObject = objects.length > 0 ? objects[objects.length - 1] : null;
    const firstObject = objects.length > 0 ? objects[0] : null;

    // Drain time in seconds
    let drainTime = Math.trunc(((lastObject?.startTime ?? 0) - (firstObject?.startTime ?? 0) - totalBreakTime(this.beatmap)) / 1000);

    if (drainTime === 0) drainTime = 10000;

    const difficulty = this.beatmap.difficulty;
    // DrainRate + Math.Clamp(ApproachRate, 4, 7) happens in single precision.
    const drainPlusAr = f32(f32(difficulty.drainRate) + clampNum(f32(difficulty.approachRate), 4, 7));
    let cd = ((drainPlusAr / 1.5 + (objects.length / drainTime) * 9) / 38) * 5 / 1.15;
    cd = Math.min(cd, 12);

    this._conversionDifficulty = cd;
    return cd;
  }

  /**
   * Finds a new column in which a hit object can be placed.
   * @throws NotEnoughColumnsException if there are no valid candidate columns.
   */
  protected findAvailableColumn(initialColumn: number, options: FindColumnOptions = {}): number {
    const lowerBound = options.lowerBound ?? this.randomStart;
    const upperBound = options.upperBound ?? this.totalColumns;
    const nextColumn = options.nextColumn ?? (() => this.getRandomColumn(lowerBound, upperBound));
    const validation = options.validation;
    const patterns = options.patterns ?? [];

    const isValid = (column: number): boolean => {
      if (validation && validation(column) === false) return false;
      for (const p of patterns) if (p.columnHasObject(column)) return false;
      return true;
    };

    // Check for the initial column
    if (isValid(initialColumn)) return initialColumn;

    // Ensure that we have at least one free column, so that an endless loop is avoided
    let hasValidColumns = false;

    for (let i = lowerBound; i < upperBound; i++) {
      hasValidColumns = isValid(i);
      if (hasValidColumns) break;
    }

    if (!hasValidColumns) throw new NotEnoughColumnsException();

    // Iterate until a valid column is found. This is a random iteration in the default case.
    do {
      initialColumn = nextColumn(initialColumn);
    } while (!isValid(initialColumn));

    return initialColumn;
  }

  /** Shorthand for FindAvailableColumn(initialColumn, params Pattern[] patterns). */
  protected findAvailableColumnIn(initialColumn: number, ...patterns: Pattern[]): number {
    return this.findAvailableColumn(initialColumn, { patterns });
  }

  /** Returns a random column index in the range [lowerBound, upperBound). */
  protected getRandomColumn(lowerBound?: number | null, upperBound?: number | null): number {
    return this.random.nextRange(lowerBound ?? this.randomStart, upperBound ?? this.totalColumns);
  }

  /** The x position of the hit object (IHasXPosition.X), or 0. */
  protected get xPosition(): number {
    return this.hitObject.x;
  }
}
