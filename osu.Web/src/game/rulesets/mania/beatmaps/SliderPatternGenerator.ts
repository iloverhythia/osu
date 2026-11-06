// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game.Rulesets.Mania/Beatmaps/Patterns/Legacy/SliderPatternGenerator.cs
// (+ LegacyRulesetExtensions.GetPrecisionAdjustedBeatLength)

import type { LegacyRandom } from '../../../../framework/math';
import { HIT_CLAP, HIT_FINISH, HIT_WHISTLE, type HitSampleInfo } from '../../../audio/HitSampleInfo';
import type { Beatmap, ConvertHitObject } from '../../../beatmaps/Beatmap';
import type { TimingControlPoint } from '../../../beatmaps/ControlPoints';
import { HoldNote, Note, type ManiaHitObject } from '../objects/ManiaHitObject';
import { clampNum, f32, roundHalfEven } from '../utils';
import { LegacyPatternGenerator } from './LegacyPatternGenerator';
import { Pattern, PatternType, hasFlag } from './Pattern';

/**
 * Introduces floating-point errors to post-multiplied beat length for legacy rulesets that depend on it.
 * Port of LegacyRulesetExtensions.GetPrecisionAdjustedBeatLength for "mania".
 */
export function getPrecisionAdjustedBeatLength(sliderVelocityMultiplier: number, timingControlPoint: TimingControlPoint): number {
  const sliderVelocityAsBeatLength = -100 / sliderVelocityMultiplier;
  const bpmMultiplier = sliderVelocityAsBeatLength < 0 ? clampNum(f32(-sliderVelocityAsBeatLength), 10, 10000) / 100.0 : 1;
  return timingControlPoint.beatLength * bpmMultiplier;
}

const isDoubleSample = (sample: HitSampleInfo): boolean => sample.name === HIT_CLAP || sample.name === HIT_FINISH;

/** Converter for legacy "Slider" hit objects. */
export class SliderPatternGenerator extends LegacyPatternGenerator {
  readonly startTime: number;
  readonly endTime: number;
  readonly segmentDuration: number;
  readonly spanCount: number;

  private convertType: number;

  constructor(random: LegacyRandom, hitObject: ConvertHitObject, beatmap: Beatmap, totalColumns: number, previousPattern: Pattern) {
    super(random, hitObject, beatmap, previousPattern, totalColumns);

    this.convertType = PatternType.None;
    if (!beatmap.controlPoints.effectPointAt(hitObject.startTime).kiaiMode) this.convertType = PatternType.LowProbability;

    const timingPoint = beatmap.controlPoints.timingPointAt(hitObject.startTime);
    const beatLength = getPrecisionAdjustedBeatLength(hitObject.sliderVelocityMultiplier, timingPoint);

    this.spanCount = hitObject.spanCount;
    this.startTime = roundHalfEven(hitObject.startTime);

    const distance = hitObject.path.expectedDistance ?? 0;

    // This matches stable's calculation.
    this.endTime = Math.floor(this.startTime + (distance * beatLength * this.spanCount * 0.01) / beatmap.difficulty.sliderMultiplier);

    this.segmentDuration = Math.trunc((this.endTime - this.startTime) / this.spanCount);
  }

  generate(): Pattern[] {
    const originalPattern = this.generateCore();

    if (originalPattern.hitObjects.length === 1) return [originalPattern];

    // We need to split the intermediate pattern into two new patterns:
    // 1. A pattern containing all objects that do not end at our EndTime.
    // 2. A pattern containing all objects that end at our EndTime. This will be used for further pattern generation.
    const intermediatePattern = new Pattern();
    const endTimePattern = new Pattern();

    for (const obj of originalPattern.hitObjects) {
      if (this.endTime !== roundHalfEven(obj.endTime)) intermediatePattern.add(obj);
      else endTimePattern.add(obj);
    }

    return [intermediatePattern, endTimePattern];
  }

  private generateCore(): Pattern {
    const startTime = this.startTime;

    if (this.totalColumns === 1) {
      const pattern = new Pattern();
      this.addToPattern(pattern, 0, startTime, this.endTime);
      return pattern;
    }

    if (this.spanCount > 1) {
      if (this.segmentDuration <= 90) return this.generateRandomHoldNotes(startTime, 1);

      if (this.segmentDuration <= 120) {
        this.convertType |= PatternType.ForceNotStack;
        return this.generateRandomNotes(startTime, this.spanCount + 1);
      }

      if (this.segmentDuration <= 160) return this.generateStair(startTime);

      if (this.segmentDuration <= 200 && this.conversionDifficulty > 3) return this.generateRandomMultipleNotes(startTime);

      const duration = this.endTime - startTime;
      if (duration >= 4000) return this.generateNRandomNotes(startTime, 0.23, 0, 0);

      if (this.segmentDuration > 400 && this.spanCount < this.totalColumns - 1 - this.randomStart) return this.generateTiledHoldNotes(startTime);

      return this.generateHoldAndNormalNotes(startTime);
    }

    if (this.segmentDuration <= 110) {
      if (this.previousPattern.columnWithObjects < this.totalColumns) this.convertType |= PatternType.ForceNotStack;
      else this.convertType &= ~PatternType.ForceNotStack;
      return this.generateRandomNotes(startTime, this.segmentDuration < 80 ? 1 : 2);
    }

    const cd = this.conversionDifficulty;
    const low = hasFlag(this.convertType, PatternType.LowProbability);

    if (cd > 6.5) {
      if (low) return this.generateNRandomNotes(startTime, 0.78, 0.3, 0);

      return this.generateNRandomNotes(startTime, 0.85, 0.36, 0.03);
    }

    if (cd > 4) {
      if (low) return this.generateNRandomNotes(startTime, 0.43, 0.08, 0);

      return this.generateNRandomNotes(startTime, 0.56, 0.18, 0);
    }

    if (cd > 2.5) {
      if (low) return this.generateNRandomNotes(startTime, 0.3, 0, 0);

      return this.generateNRandomNotes(startTime, 0.37, 0.08, 0);
    }

    if (low) return this.generateNRandomNotes(startTime, 0.17, 0, 0);

    return this.generateNRandomNotes(startTime, 0.27, 0, 0);
  }

  /** Generates random hold notes that start at an span the same amount of rows. */
  private generateRandomHoldNotes(startTime: number, noteCount: number): Pattern {
    const pattern = new Pattern();

    const usableColumns = this.totalColumns - this.randomStart - this.previousPattern.columnWithObjects;
    let nextColumn = this.getRandomColumn();

    for (let i = 0; i < Math.min(usableColumns, noteCount); i++) {
      // Find available column
      nextColumn = this.findAvailableColumnIn(nextColumn, pattern, this.previousPattern);
      this.addToPattern(pattern, nextColumn, startTime, this.endTime);
    }

    // This is can't be combined with the above loop due to RNG
    for (let i = 0; i < noteCount - usableColumns; i++) {
      nextColumn = this.findAvailableColumnIn(nextColumn, pattern);
      this.addToPattern(pattern, nextColumn, startTime, this.endTime);
    }

    return pattern;
  }

  /** Generates random notes, with one note per row and no stacking. */
  private generateRandomNotes(startTime: number, noteCount: number): Pattern {
    const pattern = new Pattern();

    let nextColumn = this.getColumn(this.xPosition, true);
    if (hasFlag(this.convertType, PatternType.ForceNotStack) && this.previousPattern.columnWithObjects < this.totalColumns)
      nextColumn = this.findAvailableColumnIn(nextColumn, this.previousPattern);

    let lastColumn = nextColumn;

    for (let i = 0; i < noteCount; i++) {
      this.addToPattern(pattern, nextColumn, startTime, startTime);
      nextColumn = this.findAvailableColumn(nextColumn, { validation: c => c !== lastColumn });
      lastColumn = nextColumn;
      startTime += this.segmentDuration;
    }

    return pattern;
  }

  /** Generates a stair of notes, with one note per row. */
  private generateStair(startTime: number): Pattern {
    const pattern = new Pattern();

    let column = this.getColumn(this.xPosition, true);
    let increasing = this.random.nextDouble() > 0.5;

    for (let i = 0; i <= this.spanCount; i++) {
      this.addToPattern(pattern, column, startTime, startTime);
      startTime += this.segmentDuration;

      // Check if we're at the borders of the stage, and invert the pattern if so
      if (increasing) {
        if (column >= this.totalColumns - 1) {
          increasing = false;
          column--;
        } else column++;
      } else {
        if (column <= this.randomStart) {
          increasing = true;
          column++;
        } else column--;
      }
    }

    return pattern;
  }

  /** Generates random notes with 1-2 notes per row and no stacking. */
  private generateRandomMultipleNotes(startTime: number): Pattern {
    const pattern = new Pattern();
    const total = this.totalColumns;

    const legacy = total >= 4 && total <= 8;
    const interval = this.random.nextRange(1, total - (legacy ? 1 : 0));

    let nextColumn = this.getColumn(this.xPosition, true);

    for (let i = 0; i <= this.spanCount; i++) {
      this.addToPattern(pattern, nextColumn, startTime, startTime);

      nextColumn += interval;
      if (nextColumn >= total - this.randomStart) nextColumn = nextColumn - total - this.randomStart + (legacy ? 1 : 0);
      nextColumn += this.randomStart;

      // If we're in 2K, let's not add many consecutive doubles
      if (total > 2) this.addToPattern(pattern, nextColumn, startTime, startTime);

      nextColumn = this.getRandomColumn();
      startTime += this.segmentDuration;
    }

    return pattern;
  }

  /** Generates random hold notes. The amount of hold notes generated is determined by probabilities. */
  private generateNRandomNotes(startTime: number, p2: number, p3: number, p4: number): Pattern {
    switch (this.totalColumns) {
      case 2:
        p2 = 0;
        p3 = 0;
        p4 = 0;
        break;

      case 3:
        p2 = Math.min(p2, 0.1);
        p3 = 0;
        p4 = 0;
        break;

      case 4:
        p2 = Math.min(p2, 0.3);
        p3 = Math.min(p3, 0.04);
        p4 = 0;
        break;

      case 5:
        p2 = Math.min(p2, 0.34);
        p3 = Math.min(p3, 0.1);
        p4 = Math.min(p4, 0.03);
        break;
    }

    let canGenerateTwoNotes = !hasFlag(this.convertType, PatternType.LowProbability);
    canGenerateTwoNotes &&= this.hitObject.samples.some(isDoubleSample) || this.sampleInfoListAt(this.startTime).some(isDoubleSample);

    if (canGenerateTwoNotes) p2 = 1;

    return this.generateRandomHoldNotes(startTime, this.getRandomNoteCount(p2, p3, p4));
  }

  /** Generates tiled hold notes. You can think of this as a stair of hold notes. */
  private generateTiledHoldNotes(startTime: number): Pattern {
    const pattern = new Pattern();

    const columnRepeat = Math.min(this.spanCount, this.totalColumns);

    // Due to integer rounding, this is not guaranteed to be the same as EndTime (the class-level variable).
    const endTime = startTime + this.segmentDuration * this.spanCount;

    let nextColumn = this.getColumn(this.xPosition, true);
    if (hasFlag(this.convertType, PatternType.ForceNotStack) && this.previousPattern.columnWithObjects < this.totalColumns)
      nextColumn = this.findAvailableColumnIn(nextColumn, this.previousPattern);

    for (let i = 0; i < columnRepeat; i++) {
      nextColumn = this.findAvailableColumnIn(nextColumn, pattern);
      this.addToPattern(pattern, nextColumn, startTime, endTime);
      startTime += this.segmentDuration;
    }

    return pattern;
  }

  /** Generates a hold note alongside normal notes. */
  private generateHoldAndNormalNotes(startTime: number): Pattern {
    const pattern = new Pattern();
    const total = this.totalColumns;

    let holdColumn = this.getColumn(this.xPosition, true);
    if (hasFlag(this.convertType, PatternType.ForceNotStack) && this.previousPattern.columnWithObjects < total)
      holdColumn = this.findAvailableColumnIn(holdColumn, this.previousPattern);

    // Create the hold note
    this.addToPattern(pattern, holdColumn, startTime, this.endTime);

    let nextColumn = this.getRandomColumn();
    let noteCount: number;
    const cd = this.conversionDifficulty;
    if (cd > 6.5) noteCount = this.getRandomNoteCount(0.63, 0);
    else if (cd > 4) noteCount = this.getRandomNoteCount(total < 6 ? 0.12 : 0.45, 0);
    else if (cd > 2.5) noteCount = this.getRandomNoteCount(total < 6 ? 0 : 0.24, 0);
    else noteCount = 0;
    noteCount = Math.min(total - 1, noteCount);

    const ignoreHead = !this.sampleInfoListAt(startTime).some(s => s.name === HIT_WHISTLE || s.name === HIT_FINISH || s.name === HIT_CLAP);

    const rowPattern = new Pattern();

    for (let i = 0; i <= this.spanCount; i++) {
      if (!(ignoreHead && startTime === this.startTime)) {
        for (let j = 0; j < noteCount; j++) {
          nextColumn = this.findAvailableColumn(nextColumn, { validation: c => c !== holdColumn, patterns: [rowPattern] });
          this.addToPattern(rowPattern, nextColumn, startTime, startTime);
        }
      }

      pattern.addPattern(rowPattern);
      rowPattern.clear();

      startTime += this.segmentDuration;
    }

    return pattern;
  }

  /** Retrieves the sample info list at a point in time. */
  private sampleInfoListAt(time: number): HitSampleInfo[] {
    const nodes = this.nodeSamplesAt(time);
    // Note: C# uses First(), which throws on an empty list; fall back to the object's samples instead.
    return nodes && nodes.length > 0 ? nodes[0] : this.hitObject.samples;
  }

  /** Retrieves the list of node samples that occur at time greater than or equal to `time`. */
  private nodeSamplesAt(time: number): HitSampleInfo[][] | null {
    if (this.hitObject.kind !== 'slider') return null;

    const index = this.segmentDuration === 0 ? 0 : Math.trunc((time - this.startTime) / this.segmentDuration);

    return index === 0 ? this.hitObject.nodeSamples : this.hitObject.nodeSamples.slice(Math.max(0, index));
  }

  private addToPattern(pattern: Pattern, column: number, startTime: number, endTime: number): void {
    let newObject: ManiaHitObject;

    if (startTime === endTime) {
      const note = new Note();
      note.startTime = startTime;
      note.samples = this.sampleInfoListAt(startTime);
      note.column = column;
      newObject = note;
    } else {
      const hold = new HoldNote();
      hold.startTime = startTime;
      hold.duration = endTime - startTime;
      hold.column = column;
      hold.samples = this.hitObject.samples;
      hold.playSlidingSamples = true;
      hold.nodeSamples = this.nodeSamplesAt(startTime);
      newObject = hold;
    }

    pattern.add(newObject);
  }
}
