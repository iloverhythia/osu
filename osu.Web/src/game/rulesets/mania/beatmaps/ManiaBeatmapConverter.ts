// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game.Rulesets.Mania/Beatmaps/ManiaBeatmapConverter.cs
// (+ LegacyBeatmapConversionDifficultyInfo, BeatmapConverter.ConvertBeatmap ordering, ManiaKeyMod.ApplyToBeatmapConverter)

import { LegacyRandom, type Vec2 } from '../../../../framework/math';
import { LegacyHitObjectType, type Beatmap, type ConvertHitObject } from '../../../beatmaps/Beatmap';
import type { ManiaHitObject } from '../objects/ManiaHitObject';
import { f32, roundHalfEven } from '../utils';
import { HitCirclePatternGenerator } from './HitCirclePatternGenerator';
import type { LegacyPatternGenerator } from './LegacyPatternGenerator';
import { PassThroughPatternGenerator } from './PassThroughPatternGenerator';
import { Pattern, PatternType } from './Pattern';
import { SliderPatternGenerator } from './SliderPatternGenerator';
import { SpinnerPatternGenerator } from './SpinnerPatternGenerator';

/** The maximum number of supported keys in a single stage (ManiaRuleset.MAX_STAGE_KEYS). */
export const MAX_STAGE_KEYS = 10;
export const MANIA_RULESET_ID = 3;

/** Maximum number of previous notes to consider for density calculation. */
const max_notes_for_density = 7;
const INT_MAX = 2147483647;

/** A set of properties that are required to facilitate beatmap conversion between legacy rulesets. */
export interface LegacyBeatmapConversionDifficultyInfo {
  sourceRulesetId: number;
  drainRate: number;
  approachRate: number;
  circleSize: number;
  overallDifficulty: number;
  /** The number of hitobjects in the beatmap with a distinct end time. */
  endTimeObjectCount: number;
  totalObjectCount: number;
}

export function conversionDifficultyFromBeatmap(beatmap: Beatmap): LegacyBeatmapConversionDifficultyInfo {
  return {
    sourceRulesetId: beatmap.rulesetId,
    drainRate: f32(beatmap.difficulty.drainRate),
    approachRate: f32(beatmap.difficulty.approachRate),
    circleSize: f32(beatmap.difficulty.circleSize),
    overallDifficulty: f32(beatmap.difficulty.overallDifficulty),
    endTimeObjectCount: beatmap.hitObjects.filter(h => h.hasDuration).length,
    totalObjectCount: beatmap.hitObjects.length,
  };
}

function getColumnCount(difficulty: LegacyBeatmapConversionDifficultyInfo): number {
  const roundedCircleSize = roundHalfEven(difficulty.circleSize);

  if (difficulty.sourceRulesetId === MANIA_RULESET_ID) return Math.trunc(Math.max(1, roundedCircleSize));

  const roundedOverallDifficulty = roundHalfEven(difficulty.overallDifficulty);

  if (difficulty.totalObjectCount > 0 && difficulty.endTimeObjectCount >= 0) {
    const countSliderOrSpinner = difficulty.endTimeObjectCount;

    // In osu!stable, this division appears as if it happens on floats, but due to release-mode
    // optimisations, it actually ends up happening on doubles.
    const percentSpecialObjects = countSliderOrSpinner / difficulty.totalObjectCount;

    if (percentSpecialObjects < 0.2) return 7;
    if (percentSpecialObjects < 0.3 || roundedCircleSize >= 5) return roundedOverallDifficulty > 5 ? 7 : 6;
    if (percentSpecialObjects > 0.6) return roundedOverallDifficulty > 4 ? 5 : 4;
  }

  return Math.max(4, Math.min(Math.trunc(roundedOverallDifficulty) + 1, 7));
}

/** LimitedCapacityQueue<double> */
class LimitedCapacityQueue {
  private readonly items: number[] = [];

  constructor(private readonly capacity: number) {}

  enqueue(v: number): void {
    if (this.items.length === this.capacity) this.items.shift();
    this.items.push(v);
  }

  get count(): number {
    return this.items.length;
  }

  at(i: number): number {
    return this.items[i];
  }
}

export class ManiaBeatmapConverter {
  /** The number of columns per-stage. */
  targetColumns: number;
  /** Whether to double the number of stages. */
  dual = false;
  /** Whether the beatmap instantiated with is for the mania ruleset. */
  readonly isForCurrentRuleset: boolean;
  /** Internal for testing purposes. */
  readonly random: LegacyRandom;

  private lastPattern = new Pattern();

  private readonly prevNoteTimes = new LimitedCapacityQueue(max_notes_for_density);
  private density = INT_MAX;
  private lastTime = 0;
  private lastPosition: Vec2 = { x: 0, y: 0 };
  private lastStair: number = PatternType.Stair;

  constructor(difficulty: LegacyBeatmapConversionDifficultyInfo) {
    this.isForCurrentRuleset = difficulty.sourceRulesetId === MANIA_RULESET_ID;

    const seed =
      Math.trunc(roundHalfEven(f32(difficulty.drainRate + difficulty.circleSize))) * 20 +
      Math.trunc(difficulty.overallDifficulty * 41.2) +
      Math.trunc(roundHalfEven(difficulty.approachRate));
    this.random = new LegacyRandom(seed | 0);

    this.targetColumns = getColumnCount(difficulty);

    if (this.isForCurrentRuleset && this.targetColumns > MAX_STAGE_KEYS) {
      // If support for odd key counts above 10 (11 / 13 / 15 / 17K) is ever desired, this code needs to go.
      this.targetColumns = Math.trunc(this.targetColumns / 2);
      this.dual = true;
    }
  }

  /** The total number of columns. */
  get totalColumns(): number {
    return this.targetColumns * (this.dual ? 2 : 1);
  }

  /** Stage column counts of the converted beatmap (ManiaBeatmapConverter.CreateBeatmap). */
  get stages(): number[] {
    return this.dual ? [this.targetColumns, this.targetColumns] : [this.targetColumns];
  }

  /** ManiaKeyMod.ApplyToBeatmapConverter */
  applyKeyMod(keyCount: number): void {
    // Although this can work, for now let's not allow keymods for mania-specific beatmaps
    if (this.isForCurrentRuleset) return;
    this.targetColumns = keyCount;
  }

  /** ManiaBeatmapConverter.GetColumnCount */
  static getColumnCount(difficulty: LegacyBeatmapConversionDifficultyInfo, keyMod?: number | null): number {
    const converter = new ManiaBeatmapConverter(difficulty);
    if (keyMod != null) converter.applyKeyMod(keyMod);
    return converter.totalColumns;
  }

  /** ManiaBeatmapConverter.CanConvert (all objects have an X position) + lazer's "convert only from osu!" rule. */
  static canConvert(beatmap: Beatmap): boolean {
    return beatmap.rulesetId === 0 || beatmap.rulesetId === MANIA_RULESET_ID;
  }

  /**
   * Converts every hit object of `beatmap` (BeatmapConverter.ConvertBeatmap).
   * The result is stable-sorted by start time, as lazer's OrderBy does.
   */
  convert(beatmap: Beatmap, onConverted?: (original: ConvertHitObject, result: ManiaHitObject[]) => void): ManiaHitObject[] {
    const result: ManiaHitObject[] = [];
    for (const obj of beatmap.hitObjects) {
      const converted = this.convertHitObject(obj, beatmap);
      onConverted?.(obj, converted);
      for (const c of converted) result.push(c);
    }
    // Array.prototype.sort is stable, matching LINQ OrderBy.
    return result.sort((a, b) => a.startTime - b.startTime);
  }

  private convertHitObject(original: ConvertHitObject, beatmap: Beatmap): ManiaHitObject[] {
    const objectTypes = LegacyHitObjectType.Circle | LegacyHitObjectType.Slider | LegacyHitObjectType.Spinner | LegacyHitObjectType.Hold;
    let legacyType = original.legacyType & objectTypes;

    if (legacyType !== LegacyHitObjectType.Circle && legacyType !== LegacyHitObjectType.Slider && legacyType !== LegacyHitObjectType.Spinner && legacyType !== LegacyHitObjectType.Hold) {
      // Objects constructed without a legacy type (or malformed ones): fall back on the object kind.
      switch (original.kind) {
        case 'slider':
          legacyType = LegacyHitObjectType.Slider;
          break;
        case 'spinner':
          legacyType = LegacyHitObjectType.Spinner;
          break;
        case 'hold':
          legacyType = LegacyHitObjectType.Hold;
          break;
        default:
          legacyType = LegacyHitObjectType.Circle;
      }
    }

    const startTime = original.startTime;
    const endTime = original.hasDuration ? original.endTime : startTime;
    const position: Vec2 = { x: original.x, y: original.y };

    let conversion: LegacyPatternGenerator;

    switch (legacyType) {
      case LegacyHitObjectType.Circle:
        if (this.isForCurrentRuleset) {
          conversion = new PassThroughPatternGenerator(this.random, original, beatmap, this.totalColumns, this.lastPattern);
          this.recordNote(startTime, position);
        } else {
          // Note: The density is used during the pattern generator constructor, and intentionally computed first.
          this.computeDensity(startTime);
          conversion = new HitCirclePatternGenerator(
            this.random,
            original,
            beatmap,
            this.totalColumns,
            this.lastPattern,
            this.lastTime,
            this.lastPosition,
            this.density,
            this.lastStair,
          );
          this.recordNote(startTime, position);
        }
        break;

      case LegacyHitObjectType.Slider:
        if (this.isForCurrentRuleset) {
          conversion = new PassThroughPatternGenerator(this.random, original, beatmap, this.totalColumns, this.lastPattern);
          this.recordNote(original.startTime, position);
        } else {
          const generator = new SliderPatternGenerator(this.random, original, beatmap, this.totalColumns, this.lastPattern);
          conversion = generator;

          for (let i = 0; i <= generator.spanCount; i++) {
            const time = original.startTime + generator.segmentDuration * i;

            this.recordNote(time, position);
            this.computeDensity(time);
          }
        }
        break;

      case LegacyHitObjectType.Spinner:
        // Note: Some older mania-specific beatmaps can have spinners that are converted rather than passed through.
        //       Newer beatmaps will usually use the "hold" hitobject type below.
        conversion = new SpinnerPatternGenerator(this.random, original, beatmap, this.totalColumns, this.lastPattern);
        this.recordNote(endTime, { x: 256, y: 192 });
        this.computeDensity(endTime);
        break;

      case LegacyHitObjectType.Hold:
      default:
        conversion = new PassThroughPatternGenerator(this.random, original, beatmap, this.totalColumns, this.lastPattern);
        this.recordNote(endTime, position);
        this.computeDensity(endTime);
        break;
    }

    const out: ManiaHitObject[] = [];

    for (const newPattern of conversion.generate()) {
      if (conversion instanceof HitCirclePatternGenerator) this.lastStair = conversion.stairType;

      if (conversion instanceof HitCirclePatternGenerator || conversion instanceof SliderPatternGenerator) this.lastPattern = newPattern;

      for (const obj of newPattern.hitObjects) out.push(obj);
    }

    return out;
  }

  private computeDensity(newNoteTime: number): void {
    this.prevNoteTimes.enqueue(newNoteTime);

    if (this.prevNoteTimes.count >= 2) this.density = (this.prevNoteTimes.at(this.prevNoteTimes.count - 1) - this.prevNoteTimes.at(0)) / this.prevNoteTimes.count;
  }

  private recordNote(time: number, position: Vec2): void {
    this.lastTime = time;
    this.lastPosition = position;
  }
}
