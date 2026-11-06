// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game.Rulesets.Mania/Beatmaps/Patterns/Legacy/HitCirclePatternGenerator.cs

import type { LegacyRandom, Vec2 } from '../../../../framework/math';
import { HIT_CLAP, HIT_FINISH } from '../../../audio/HitSampleInfo';
import type { Beatmap, ConvertHitObject } from '../../../beatmaps/Beatmap';
import { Note } from '../objects/ManiaHitObject';
import { clampNum, f32 } from '../utils';
import { LegacyPatternGenerator } from './LegacyPatternGenerator';
import { Pattern, PatternType, hasFlag } from './Pattern';

/** Converter for legacy "HitCircle" hit objects. */
export class HitCirclePatternGenerator extends LegacyPatternGenerator {
  stairType: number;
  private readonly convertType: number = PatternType.None;

  constructor(
    random: LegacyRandom,
    hitObject: ConvertHitObject,
    beatmap: Beatmap,
    totalColumns: number,
    previousPattern: Pattern,
    previousTime: number,
    previousPosition: Vec2,
    density: number,
    lastStair: number,
  ) {
    super(random, hitObject, beatmap, previousPattern, totalColumns);

    this.stairType = lastStair;

    const timingPoint = beatmap.controlPoints.timingPointAt(hitObject.startTime);
    const effectPoint = beatmap.controlPoints.effectPointAt(hitObject.startTime);

    // Vector2 (single precision) length
    const dx = f32(f32(hitObject.x) - f32(previousPosition.x));
    const dy = f32(f32(hitObject.y) - f32(previousPosition.y));
    const positionSeparation = f32(Math.sqrt(f32(f32(dx * dx) + f32(dy * dy))));
    const timeSeparation = hitObject.startTime - previousTime;

    let convertType: number = PatternType.None;

    if (timeSeparation <= 80) {
      // More than 187 BPM
      convertType |= PatternType.ForceNotStack | PatternType.KeepSingle;
    } else if (timeSeparation <= 95) {
      // More than 157 BPM
      convertType |= PatternType.ForceNotStack | PatternType.KeepSingle | lastStair;
    } else if (timeSeparation <= 105) {
      // More than 140 BPM
      convertType |= PatternType.ForceNotStack | PatternType.LowProbability;
    } else if (timeSeparation <= 125) {
      // More than 120 BPM
      convertType |= PatternType.ForceNotStack;
    } else if (timeSeparation <= 135 && positionSeparation < 20) {
      // More than 111 BPM stream
      convertType |= PatternType.Cycle | PatternType.KeepSingle;
    } else if (timeSeparation <= 150 && positionSeparation < 20) {
      // More than 100 BPM stream
      convertType |= PatternType.ForceStack | PatternType.LowProbability;
    } else if (positionSeparation < 20 && density >= timingPoint.beatLength / 2.5) {
      // Low density stream
      convertType |= PatternType.Reverse | PatternType.LowProbability;
    } else if (density < timingPoint.beatLength / 2.5 || effectPoint.kiaiMode) {
      // High density
    } else convertType |= PatternType.LowProbability;

    if (!hasFlag(convertType, PatternType.KeepSingle)) {
      if (hitObject.samples.some(s => s.name === HIT_FINISH) && totalColumns !== 8) convertType |= PatternType.Mirror;
      else if (hitObject.samples.some(s => s.name === HIT_CLAP)) convertType |= PatternType.Gathered;
    }

    this.convertType = convertType;
  }

  generate(): Pattern[] {
    const p = this.generateCore();

    for (const obj of p.hitObjects) {
      if (hasFlag(this.convertType, PatternType.Stair) && obj.column === this.totalColumns - 1) this.stairType = PatternType.ReverseStair;
      if (hasFlag(this.convertType, PatternType.ReverseStair) && obj.column === this.randomStart) this.stairType = PatternType.Stair;
    }

    return [p];
  }

  private generateCore(): Pattern {
    const pattern = new Pattern();
    const total = this.totalColumns;
    const prev = this.previousPattern;
    const ct = this.convertType;

    if (total === 1) {
      this.addToPattern(pattern, 0);
      return pattern;
    }

    const prevObjects = prev.hitObjects;
    const lastColumn = prevObjects.length > 0 ? prevObjects[0].column : 0;

    if (hasFlag(ct, PatternType.Reverse) && prevObjects.length > 0) {
      // Generate a new pattern by copying the last hit objects in reverse-column order
      for (let i = this.randomStart; i < total; i++) if (prev.columnHasObject(i)) this.addToPattern(pattern, this.randomStart + total - i - 1);

      return pattern;
    }

    if (
      hasFlag(ct, PatternType.Cycle) &&
      prevObjects.length === 1 &&
      // If we convert to 7K + 1, let's not overload the special key
      (total !== 8 || lastColumn !== 0) &&
      // Make sure the last column was not the centre column
      (total % 2 === 0 || lastColumn !== Math.trunc(total / 2))
    ) {
      // Generate a new pattern by cycling backwards (similar to Reverse but for only one hit object)
      const column = this.randomStart + total - lastColumn - 1;
      this.addToPattern(pattern, column);
      return pattern;
    }

    if (hasFlag(ct, PatternType.ForceStack) && prevObjects.length > 0) {
      // Generate a new pattern by placing on the already filled columns
      for (let i = this.randomStart; i < total; i++) if (prev.columnHasObject(i)) this.addToPattern(pattern, i);

      return pattern;
    }

    if (prevObjects.length === 1) {
      if (hasFlag(ct, PatternType.Stair)) {
        // Generate a new pattern by placing on the next column, cycling back to the start if there is no "next"
        let targetColumn = lastColumn + 1;
        if (targetColumn === total) targetColumn = this.randomStart;

        this.addToPattern(pattern, targetColumn);
        return pattern;
      }

      if (hasFlag(ct, PatternType.ReverseStair)) {
        // Generate a new pattern by placing on the previous column, cycling back to the end if there is no "previous"
        let targetColumn = lastColumn - 1;
        if (targetColumn === this.randomStart - 1) targetColumn = total - 1;

        this.addToPattern(pattern, targetColumn);
        return pattern;
      }
    }

    if (hasFlag(ct, PatternType.KeepSingle)) return this.generateRandomNotes(1);

    const cd = this.conversionDifficulty;

    if (hasFlag(ct, PatternType.Mirror)) {
      if (cd > 6.5) return this.generateRandomPatternWithMirrored(0.12, 0.38, 0.12);
      if (cd > 4) return this.generateRandomPatternWithMirrored(0.12, 0.17, 0);

      return this.generateRandomPatternWithMirrored(0.12, 0, 0);
    }

    if (cd > 6.5) {
      if (hasFlag(ct, PatternType.LowProbability)) return this.generateRandomPattern(0.78, 0.42, 0, 0);

      return this.generateRandomPattern(1, 0.62, 0, 0);
    }

    if (cd > 4) {
      if (hasFlag(ct, PatternType.LowProbability)) return this.generateRandomPattern(0.35, 0.08, 0, 0);

      return this.generateRandomPattern(0.52, 0.15, 0, 0);
    }

    if (cd > 2) {
      if (hasFlag(ct, PatternType.LowProbability)) return this.generateRandomPattern(0.18, 0, 0, 0);

      return this.generateRandomPattern(0.45, 0, 0, 0);
    }

    return this.generateRandomPattern(0, 0, 0, 0);
  }

  /**
   * Generates random notes. This will generate as many as it can up to noteCount,
   * accounting for any stacks if convertType is forcing no stacks.
   */
  private generateRandomNotes(noteCount: number): Pattern {
    const pattern = new Pattern();

    const allowStacking = !hasFlag(this.convertType, PatternType.ForceNotStack);

    if (!allowStacking) noteCount = Math.min(noteCount, this.totalColumns - this.randomStart - this.previousPattern.columnWithObjects);

    let nextColumn = this.getColumn(this.xPosition, true);

    const getNextColumn = (last: number): number => {
      if (hasFlag(this.convertType, PatternType.Gathered)) {
        last++;
        if (last === this.totalColumns) last = this.randomStart;
      } else last = this.getRandomColumn();

      return last;
    };

    for (let i = 0; i < noteCount; i++) {
      nextColumn = allowStacking
        ? this.findAvailableColumn(nextColumn, { nextColumn: getNextColumn, patterns: [pattern] })
        : this.findAvailableColumn(nextColumn, { nextColumn: getNextColumn, patterns: [pattern, this.previousPattern] });

      this.addToPattern(pattern, nextColumn);
    }

    return pattern;
  }

  /** Whether this hit object can generate a note in the special column. */
  private get hasSpecialColumn(): boolean {
    const s = this.hitObject.samples;
    return s.some(x => x.name === HIT_CLAP) && s.some(x => x.name === HIT_FINISH);
  }

  /** Generates a random pattern. */
  private generateRandomPattern(p2: number, p3: number, p4: number, p5: number): Pattern {
    const pattern = new Pattern();

    pattern.addPattern(this.generateRandomNotes(this.getRandomNoteCountFor(p2, p3, p4, p5)));

    if (this.randomStart > 0 && this.hasSpecialColumn) this.addToPattern(pattern, 0);

    return pattern;
  }

  /** Generates a random pattern which has both normal and mirrored notes. */
  private generateRandomPatternWithMirrored(centreProbability: number, p2: number, p3: number): Pattern {
    if (hasFlag(this.convertType, PatternType.ForceNotStack)) return this.generateRandomPattern(1 / 2 + p2 / 2, p2, (p2 + p3) / 2, p3);

    const pattern = new Pattern();
    const total = this.totalColumns;

    const { noteCount, addToCentre } = this.getRandomNoteCountMirrored(centreProbability, p2, p3);

    const columnLimit = Math.trunc((total % 2 === 0 ? total : total - 1) / 2);
    let nextColumn = this.getRandomColumn(null, columnLimit);

    for (let i = 0; i < noteCount; i++) {
      nextColumn = this.findAvailableColumn(nextColumn, { upperBound: columnLimit, patterns: [pattern] });

      // Add normal note
      this.addToPattern(pattern, nextColumn);
      // Add mirrored note
      this.addToPattern(pattern, this.randomStart + total - nextColumn - 1);
    }

    if (addToCentre) this.addToPattern(pattern, Math.trunc(total / 2));

    if (this.randomStart > 0 && this.hasSpecialColumn) this.addToPattern(pattern, 0);

    return pattern;
  }

  /** Generates a count of notes to be generated from a list of probabilities. */
  private getRandomNoteCountFor(p2: number, p3: number, p4: number, p5: number): number {
    switch (this.totalColumns) {
      case 2:
        p2 = 0;
        p3 = 0;
        p4 = 0;
        p5 = 0;
        break;

      case 3:
        p2 = Math.min(p2, 0.1);
        p3 = 0;
        p4 = 0;
        p5 = 0;
        break;

      case 4:
        p2 = Math.min(p2, 0.23);
        p3 = Math.min(p3, 0.04);
        p4 = 0;
        p5 = 0;
        break;

      case 5:
        p3 = Math.min(p3, 0.15);
        p4 = Math.min(p4, 0.03);
        p5 = 0;
        break;
    }

    if (this.hitObject.samples.some(s => s.name === HIT_CLAP)) p2 = 1;

    return this.getRandomNoteCount(p2, p3, p4, p5);
  }

  /**
   * Generates a count of notes to be generated from a list of probabilities.
   * The note to be added to the centre column will NOT be part of this count.
   */
  private getRandomNoteCountMirrored(centreProbability: number, p2: number, p3: number): { noteCount: number; addToCentre: boolean } {
    switch (this.totalColumns) {
      case 2:
        centreProbability = 0;
        p2 = 0;
        p3 = 0;
        break;

      case 3:
        centreProbability = Math.min(centreProbability, 0.03);
        p2 = 0;
        p3 = 0;
        break;

      case 4:
        centreProbability = 0;
        // Stable requires rngValue > x, which is an inverse-probability. Lazer uses true probability (1 - x).
        // But multiplying this value by 2 (stable) is not the same operation as dividing it by 2 (lazer),
        // so it needs to be converted to from a probability and then back after the multiplication.
        p2 = 1 - Math.max((1 - p2) * 2, 0.8);
        p3 = 0;
        break;

      case 5:
        centreProbability = Math.min(centreProbability, 0.03);
        p3 = 0;
        break;

      case 6:
        centreProbability = 0;
        p2 = 1 - Math.max((1 - p2) * 2, 0.5);
        p3 = 1 - Math.max((1 - p3) * 2, 0.85);
        break;
    }

    // The stable values were allowed to exceed 1, which indicate <0% probability.
    // These values needs to be clamped otherwise GetRandomNoteCount() will throw an exception.
    p2 = clampNum(p2, 0, 1);
    p3 = clampNum(p3, 0, 1);

    const centreVal = this.random.nextDouble();
    const noteCount = this.getRandomNoteCount(p2, p3);

    const addToCentre = this.totalColumns % 2 !== 0 && noteCount !== 3 && centreVal > 1 - centreProbability;
    return { noteCount, addToCentre };
  }

  private addToPattern(pattern: Pattern, column: number): void {
    const note = new Note();
    note.startTime = this.hitObject.startTime;
    note.samples = this.hitObject.samples;
    note.column = column;
    pattern.add(note);
  }
}
