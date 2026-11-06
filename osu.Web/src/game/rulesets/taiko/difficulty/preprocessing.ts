// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game.Rulesets.Taiko/Difficulty/Preprocessing/** and Difficulty/Utils/** (+ osu.Game DifficultyHitObject).

import type { ControlPointInfo } from '../../../beatmaps/ControlPoints';
import { HitResult } from '../../../scoring/HitResult';
import { Hit, HitType, TaikoHitObject } from '../objects';
import { almostEquals, minBy, roundHalfEven } from './utils';

// ------------------------------------------------------------------ utils

/** IHasInterval */
export interface HasInterval {
  readonly interval: number;
}

/** IntervalGroupingUtils */
export const MARGIN_OF_ERROR = 5.0;

export function groupByInterval<T extends HasInterval>(objects: readonly T[]): T[][] {
  const groups: T[][] = [];
  const state = { i: 0 };
  while (state.i < objects.length) groups.push(createNextGroup(objects, state));
  return groups;
}

function createNextGroup<T extends HasInterval>(objects: readonly T[], state: { i: number }): T[] {
  // This never compares the first two elements in the group.
  // This sounds wrong but is apparently "as intended" (https://github.com/ppy/osu/pull/31636#discussion_r1942673329)
  const groupedObjects: T[] = [objects[state.i]];
  state.i++;

  for (; state.i < objects.length - 1; state.i++) {
    const i = state.i;
    if (!almostEquals(objects[i].interval, objects[i + 1].interval, MARGIN_OF_ERROR)) {
      // When an interval change occurs, include the object with the differing interval in the case it increased
      if (objects[i + 1].interval > objects[i].interval + MARGIN_OF_ERROR) {
        groupedObjects.push(objects[i]);
        state.i++;
      }
      return groupedObjects;
    }
    // No interval change occurred
    groupedObjects.push(objects[i]);
  }

  // Check if the last two objects in the object form a "flat" rhythm pattern within the specified margin of error.
  if (objects.length > 2 && state.i < objects.length && almostEquals(objects[objects.length - 1].interval, objects[objects.length - 2].interval, MARGIN_OF_ERROR)) {
    groupedObjects.push(objects[state.i]);
    state.i++;
  }
  return groupedObjects;
}

/** DeltaTimeNormaliser.Normalise */
export function normaliseDeltaTimes(hitObjects: readonly TaikoDifficultyHitObject[], marginOfError: number): Map<TaikoDifficultyHitObject, number> {
  const deltaTimes = [...new Set(hitObjects.map(h => h.deltaTime))].sort((a, b) => a - b);
  const sets: number[][] = [];
  let current: number[] | null = null;
  for (const value of deltaTimes) {
    // Add to the current group if within margin of error
    if (current !== null && Math.abs(value - current[0]) <= marginOfError) {
      current.push(value);
      continue;
    }
    // Otherwise begin a new group
    current = [value];
    sets.push(current);
  }

  // Compute median for each group
  const medianLookup = new Map<number, number>();
  for (const set of sets) {
    set.sort((a, b) => a - b);
    const mid = Math.trunc(set.length / 2);
    const median = set.length % 2 === 1 ? set[mid] : (set[mid - 1] + set[mid]) / 2;
    for (const v of set) medianLookup.set(v, median);
  }

  const out = new Map<TaikoDifficultyHitObject, number>();
  for (const h of hitObjects) out.set(h, medianLookup.get(h.deltaTime) ?? h.deltaTime);
  return out;
}

// ------------------------------------------------------------------ colour data

/** MonoStreak */
export class MonoStreak {
  readonly hitObjects: TaikoDifficultyHitObject[] = [];
  parent!: AlternatingMonoPattern;
  index = 0;

  get firstHitObject(): TaikoDifficultyHitObject {
    return this.hitObjects[0];
  }

  get lastHitObject(): TaikoDifficultyHitObject {
    return this.hitObjects[this.hitObjects.length - 1];
  }

  get hitType(): HitType | null {
    const b = this.hitObjects[0].baseObject;
    return b instanceof Hit ? b.type : null;
  }

  get runLength(): number {
    return this.hitObjects.length;
  }
}

/** AlternatingMonoPattern */
export class AlternatingMonoPattern {
  readonly monoStreaks: MonoStreak[] = [];
  parent!: RepeatingHitPatterns;
  index = 0;

  get firstHitObject(): TaikoDifficultyHitObject {
    return this.monoStreaks[0].firstHitObject;
  }

  isRepetitionOf(other: AlternatingMonoPattern): boolean {
    return this.hasIdenticalMonoLength(other) && other.monoStreaks.length === this.monoStreaks.length && other.monoStreaks[0].hitType === this.monoStreaks[0].hitType;
  }

  hasIdenticalMonoLength(other: AlternatingMonoPattern): boolean {
    return other.monoStreaks[0].runLength === this.monoStreaks[0].runLength;
  }
}

/** RepeatingHitPatterns */
export class RepeatingHitPatterns {
  private static readonly MAX_REPETITION_INTERVAL = 16;
  readonly alternatingMonoPatterns: AlternatingMonoPattern[] = [];
  repetitionInterval = RepeatingHitPatterns.MAX_REPETITION_INTERVAL + 1;

  constructor(readonly previous: RepeatingHitPatterns | null) {}

  get firstHitObject(): TaikoDifficultyHitObject {
    return this.alternatingMonoPatterns[0].firstHitObject;
  }

  private isRepetitionOf(other: RepeatingHitPatterns): boolean {
    if (this.alternatingMonoPatterns.length !== other.alternatingMonoPatterns.length) return false;
    for (let i = 0; i < Math.min(this.alternatingMonoPatterns.length, 2); i++) {
      if (!this.alternatingMonoPatterns[i].hasIdenticalMonoLength(other.alternatingMonoPatterns[i])) return false;
    }
    return true;
  }

  findRepetitionInterval(): void {
    const max = RepeatingHitPatterns.MAX_REPETITION_INTERVAL;
    if (this.previous === null) {
      this.repetitionInterval = max + 1;
      return;
    }
    let other: RepeatingHitPatterns | null = this.previous;
    let interval = 1;
    while (interval < max) {
      if (this.isRepetitionOf(other!)) {
        this.repetitionInterval = Math.min(interval, max);
        return;
      }
      other = other!.previous;
      if (other === null) break;
      ++interval;
    }
    this.repetitionInterval = max + 1;
  }
}

/** TaikoColourData */
export class TaikoColourData {
  monoStreak: MonoStreak | null = null;
  alternatingMonoPattern: AlternatingMonoPattern | null = null;
  repeatingHitPattern: RepeatingHitPatterns | null = null;
  /** Index of the object within its mono streak (MonoStreak.HitObjects.IndexOf), precomputed. */
  indexInMonoStreak = 0;

  get previousColourChange(): TaikoDifficultyHitObject | null {
    return this.monoStreak?.firstHitObject.previousNote(0) ?? null;
  }

  get nextColourChange(): TaikoDifficultyHitObject | null {
    return this.monoStreak?.lastHitObject.nextNote(0) ?? null;
  }
}

// ------------------------------------------------------------------ rhythm data

/** SameRhythmHitObjectGrouping */
export class SameRhythmHitObjectGrouping implements HasInterval {
  readonly hitObjectInterval: number | null = null;
  readonly hitObjectIntervalRatio: number;
  readonly interval: number = Infinity;

  constructor(
    readonly previous: SameRhythmHitObjectGrouping | null,
    readonly hitObjects: TaikoDifficultyHitObject[],
  ) {
    // Cluster and normalise each hitobjects delta-time.
    const normalised = normaliseDeltaTimes(hitObjects, MARGIN_OF_ERROR);
    const normalisedDeltas = hitObjects.slice(1).map(h => normalised.get(h)!);

    // Secondary check to ensure there isn't any 'noise' or outliers by taking the modal delta time.
    const modalDelta = normalisedDeltas.length > 0 ? roundHalfEven(normalisedDeltas[0]) : 0;

    // Calculate the average interval between hitobjects.
    if (normalisedDeltas.length > 0) {
      const previousDelta = previous?.hitObjectInterval;
      if (previousDelta != null && Math.abs(modalDelta - previousDelta) <= MARGIN_OF_ERROR) this.hitObjectInterval = previousDelta;
      else this.hitObjectInterval = modalDelta;
    }

    // Calculate the ratio between this group's interval and the previous group's interval
    const previousInterval = previous?.hitObjectInterval;
    this.hitObjectIntervalRatio = previousInterval != null && this.hitObjectInterval != null ? this.hitObjectInterval / previousInterval : 1.0;

    // Calculate the interval from the previous group's start time
    if (previous !== null) {
      if (Math.abs(this.startTime - previous.startTime) <= MARGIN_OF_ERROR) this.interval = 0;
      else this.interval = this.startTime - previous.startTime;
    }
  }

  get firstHitObject(): TaikoDifficultyHitObject {
    return this.hitObjects[0];
  }

  get startTime(): number {
    return this.hitObjects[0].startTime;
  }

  get duration(): number {
    return this.hitObjects[this.hitObjects.length - 1].startTime - this.hitObjects[0].startTime;
  }
}

/** SamePatternsGroupedHitObjects */
export class SamePatternsGroupedHitObjects {
  constructor(
    readonly previous: SamePatternsGroupedHitObjects | null,
    readonly groups: SameRhythmHitObjectGrouping[],
  ) {}

  get groupInterval(): number {
    return this.groups.length > 1 ? this.groups[1].interval : this.groups[0].interval;
  }

  get intervalRatio(): number {
    return this.previous ? this.groupInterval / this.previous.groupInterval : 1.0;
  }

  get firstHitObject(): TaikoDifficultyHitObject {
    return this.groups[0].firstHitObject;
  }

  get allHitObjects(): TaikoDifficultyHitObject[] {
    return this.groups.flatMap(g => g.hitObjects);
  }
}

/** List of most common rhythm changes in taiko maps (TaikoRhythmData.common_ratios). */
const COMMON_RATIOS = [1.0 / 1, 2.0 / 1, 1.0 / 2, 3.0 / 1, 1.0 / 3, 3.0 / 2, 2.0 / 3, 5.0 / 4, 4.0 / 5];

/** TaikoRhythmData */
export class TaikoRhythmData {
  sameRhythmGroupedHitObjects: SameRhythmHitObjectGrouping | null = null;
  samePatternsGroupedHitObjects: SamePatternsGroupedHitObjects | null = null;
  readonly ratio: number;

  constructor(current: TaikoDifficultyHitObject) {
    const previous = current.previous(0);
    if (previous === null) {
      this.ratio = 1;
      return;
    }
    const actualRatio = current.deltaTime / previous.deltaTime;
    this.ratio = minBy(COMMON_RATIOS, r => Math.abs(r - actualRatio));
  }
}

// ------------------------------------------------------------------ difficulty hit object

/** DifficultyHitObject + TaikoDifficultyHitObject */
export class TaikoDifficultyHitObject implements HasInterval {
  readonly deltaTime: number;
  readonly startTime: number;
  readonly endTime: number;
  readonly hitWindowGreat: number;

  private readonly monoDifficultyHitObjects: TaikoDifficultyHitObject[] | null = null;
  readonly monoIndex: number = 0;
  private readonly noteDifficultyHitObjects: TaikoDifficultyHitObject[];
  readonly noteIndex: number = 0;

  readonly rhythmData: TaikoRhythmData;
  readonly colourData: TaikoColourData;
  /** The adjusted BPM of this hit object, based on its slider velocity and scroll speed. */
  effectiveBPM: number;

  constructor(
    readonly baseObject: TaikoHitObject,
    readonly lastObject: TaikoHitObject,
    readonly clockRate: number,
    private readonly objects: TaikoDifficultyHitObject[],
    centreHitObjects: TaikoDifficultyHitObject[],
    rimHitObjects: TaikoDifficultyHitObject[],
    noteObjects: TaikoDifficultyHitObject[],
    public index: number,
    controlPointInfo: ControlPointInfo,
    globalSliderVelocity: number,
  ) {
    this.deltaTime = (baseObject.startTime - lastObject.startTime) / clockRate;
    this.startTime = baseObject.startTime / clockRate;
    this.endTime = baseObject.endTime / clockRate;
    this.hitWindowGreat = (2 * TaikoDifficultyHitObject.rawHitWindow(baseObject, HitResult.Great)) / clockRate;

    this.noteDifficultyHitObjects = noteObjects;
    this.colourData = new TaikoColourData();
    this.rhythmData = new TaikoRhythmData(this);

    if (baseObject instanceof Hit) {
      switch (baseObject.type) {
        case HitType.Centre:
          this.monoIndex = centreHitObjects.length;
          centreHitObjects.push(this);
          this.monoDifficultyHitObjects = centreHitObjects;
          break;
        case HitType.Rim:
          this.monoIndex = rimHitObjects.length;
          rimHitObjects.push(this);
          this.monoDifficultyHitObjects = rimHitObjects;
          break;
      }
      this.noteIndex = noteObjects.length;
      noteObjects.push(this);
    }

    // Using `hitObject.StartTime` causes floating point error differences
    const normalisedStartTime = this.startTime * clockRate;
    // Retrieve the timing point at the note's start time
    const currentControlPoint = controlPointInfo.timingPointAt(normalisedStartTime);
    // Calculate the slider velocity at the note's start time.
    const currentSliderVelocity = globalSliderVelocity * controlPointInfo.effectPointAt(normalisedStartTime).scrollSpeed * clockRate;
    this.effectiveBPM = currentControlPoint.bpm * currentSliderVelocity;
  }

  /** DifficultyHitObject.getRawHitWindow */
  private static rawHitWindow(h: TaikoHitObject, result: HitResult): number {
    // Only hits have non-empty hit windows; nested objects of drum rolls / swells have empty windows.
    if (h instanceof Hit) return h.hitWindows.windowFor(result);
    for (const n of h.nested) if (n instanceof Hit) return n.hitWindows.windowFor(result);
    return 0;
  }

  get interval(): number {
    return this.deltaTime;
  }

  previous(backwardsIndex: number): TaikoDifficultyHitObject | null {
    const index = this.index - (backwardsIndex + 1);
    return index >= 0 && index < this.objects.length ? this.objects[index] : null;
  }

  next(forwardsIndex: number): TaikoDifficultyHitObject | null {
    const index = this.index + (forwardsIndex + 1);
    return index >= 0 && index < this.objects.length ? this.objects[index] : null;
  }

  previousMono(backwardsIndex: number): TaikoDifficultyHitObject | null {
    return this.monoDifficultyHitObjects?.[this.monoIndex - (backwardsIndex + 1)] ?? null;
  }

  nextMono(forwardsIndex: number): TaikoDifficultyHitObject | null {
    return this.monoDifficultyHitObjects?.[this.monoIndex + (forwardsIndex + 1)] ?? null;
  }

  previousNote(backwardsIndex: number): TaikoDifficultyHitObject | null {
    return this.noteDifficultyHitObjects[this.noteIndex - (backwardsIndex + 1)] ?? null;
  }

  nextNote(forwardsIndex: number): TaikoDifficultyHitObject | null {
    return this.noteDifficultyHitObjects[this.noteIndex + (forwardsIndex + 1)] ?? null;
  }
}

// ------------------------------------------------------------------ preprocessors

/** TaikoColourDifficultyPreprocessor.ProcessAndAssign */
export function processColour(hitObjects: TaikoDifficultyHitObject[]): void {
  const hitPatterns = encodeRepeatingHitPattern(encodeAlternatingMonoPattern(encodeMonoStreak(hitObjects)));

  // Assign indexing and encoding data to all relevant objects.
  for (const repeatingHitPattern of hitPatterns) {
    for (let i = 0; i < repeatingHitPattern.alternatingMonoPatterns.length; ++i) {
      const monoPattern = repeatingHitPattern.alternatingMonoPatterns[i];
      monoPattern.parent = repeatingHitPattern;
      monoPattern.index = i;
      for (let j = 0; j < monoPattern.monoStreaks.length; ++j) {
        const monoStreak = monoPattern.monoStreaks[j];
        monoStreak.parent = monoPattern;
        monoStreak.index = j;
        for (let k = 0; k < monoStreak.hitObjects.length; k++) {
          const hitObject = monoStreak.hitObjects[k];
          hitObject.colourData.repeatingHitPattern = repeatingHitPattern;
          hitObject.colourData.alternatingMonoPattern = monoPattern;
          hitObject.colourData.monoStreak = monoStreak;
          hitObject.colourData.indexInMonoStreak = k;
        }
      }
    }
  }
}

function encodeMonoStreak(data: TaikoDifficultyHitObject[]): MonoStreak[] {
  const monoStreaks: MonoStreak[] = [];
  let currentMonoStreak: MonoStreak | null = null;
  for (const taikoObject of data) {
    // This ignores all non-note objects, which may or may not be the desired behaviour
    const previousObject = taikoObject.previousNote(0);
    const typeOf = (o: TaikoDifficultyHitObject): HitType | null => (o.baseObject instanceof Hit ? o.baseObject.type : null);
    // If this is the first object in the list or the colour changed, create a new mono streak
    if (currentMonoStreak === null || previousObject === null || typeOf(taikoObject) !== typeOf(previousObject)) {
      currentMonoStreak = new MonoStreak();
      monoStreaks.push(currentMonoStreak);
    }
    currentMonoStreak.hitObjects.push(taikoObject);
  }
  return monoStreaks;
}

function encodeAlternatingMonoPattern(data: MonoStreak[]): AlternatingMonoPattern[] {
  const monoPatterns: AlternatingMonoPattern[] = [];
  let currentMonoPattern: AlternatingMonoPattern | null = null;
  for (let i = 0; i < data.length; i++) {
    // Start a new AlternatingMonoPattern if the previous MonoStreak has a different mono length, or if this is the first MonoStreak in the list.
    if (currentMonoPattern === null || data[i].runLength !== data[i - 1].runLength) {
      currentMonoPattern = new AlternatingMonoPattern();
      monoPatterns.push(currentMonoPattern);
    }
    currentMonoPattern.monoStreaks.push(data[i]);
  }
  return monoPatterns;
}

function encodeRepeatingHitPattern(data: AlternatingMonoPattern[]): RepeatingHitPatterns[] {
  const hitPatterns: RepeatingHitPatterns[] = [];
  let currentHitPattern: RepeatingHitPatterns | null = null;

  for (let i = 0; i < data.length; i++) {
    // Start a new RepeatingHitPattern. AlternatingMonoPatterns that should be grouped together will be handled later within this loop.
    currentHitPattern = new RepeatingHitPatterns(currentHitPattern);

    // Determine if future AlternatingMonoPatterns should be grouped.
    let isCoupled = i < data.length - 2 && data[i].isRepetitionOf(data[i + 2]);

    if (!isCoupled) {
      currentHitPattern.alternatingMonoPatterns.push(data[i]);
    } else {
      while (isCoupled) {
        currentHitPattern.alternatingMonoPatterns.push(data[i]);
        i++;
        isCoupled = i < data.length - 2 && data[i].isRepetitionOf(data[i + 2]);
      }
      // Skip over viewed data and add the rest to the payload
      currentHitPattern.alternatingMonoPatterns.push(data[i]);
      currentHitPattern.alternatingMonoPatterns.push(data[i + 1]);
      i++;
    }
    hitPatterns.push(currentHitPattern);
  }

  // Final pass to find repetition intervals
  for (const p of hitPatterns) p.findRepetitionInterval();
  return hitPatterns;
}

/** TaikoRhythmDifficultyPreprocessor.ProcessAndAssign */
export function processRhythm(hitObjects: TaikoDifficultyHitObject[]): void {
  const rhythmGroups: SameRhythmHitObjectGrouping[] = [];
  for (const grouped of groupByInterval(hitObjects)) rhythmGroups.push(new SameRhythmHitObjectGrouping(rhythmGroups[rhythmGroups.length - 1] ?? null, grouped));
  for (const rhythmGroup of rhythmGroups) for (const h of rhythmGroup.hitObjects) h.rhythmData.sameRhythmGroupedHitObjects = rhythmGroup;

  const patternGroups: SamePatternsGroupedHitObjects[] = [];
  for (const grouped of groupByInterval(rhythmGroups)) patternGroups.push(new SamePatternsGroupedHitObjects(patternGroups[patternGroups.length - 1] ?? null, grouped));
  for (const patternGroup of patternGroups) for (const h of patternGroup.allHitObjects) h.rhythmData.samePatternsGroupedHitObjects = patternGroup;
}
