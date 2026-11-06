// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game.Rulesets.Taiko/Objects/* (TaikoHitObject, TaikoStrongableHitObject, Hit, DrumRoll, DrumRollTick,
// Swell, SwellTick, StrongNestedHitObject, BarLine) and osu.Game.Rulesets.Taiko/Judgements/*.

import { HIT_CLAP, HIT_FINISH, HIT_NORMAL, HIT_WHISTLE, HitSampleInfo } from '../../audio/HitSampleInfo';
import type { ControlPointInfo } from '../../beatmaps/ControlPoints';
import type { BeatmapDifficulty } from '../../beatmaps/Difficulty';
import { HitResult } from '../../scoring/HitResult';
import { EmptyHitWindows, HitWindows } from '../../scoring/HitWindows';
import { Judgement, judgement } from '../../scoring/Judgement';
import { TaikoHitWindows } from './TaikoHitWindows';

/** TaikoBeatmapConverter.VELOCITY_MULTIPLIER (a C# float constant: 1.4f). */
export const VELOCITY_MULTIPLIER = Math.fround(1.4);

/** TaikoHitObject.DEFAULT_SIZE */
export const DEFAULT_SIZE = Math.fround(0.475);
/** TaikoStrongableHitObject.STRONG_SCALE */
export const STRONG_SCALE = Math.fround(1 / Math.fround(0.65));
/** TaikoStrongableHitObject.DEFAULT_STRONG_SIZE */
export const DEFAULT_STRONG_SIZE = Math.fround(DEFAULT_SIZE * STRONG_SCALE);

/** HitObject.control_point_leniency */
const CONTROL_POINT_LENIENCY = 1;

export enum HitType {
  Centre = 0,
  Rim = 1,
}

export const EMPTY_HIT_WINDOWS: HitWindows = new EmptyHitWindows();

// Judgements (osu.Game.Rulesets.Taiko/Judgements + IgnoreJudgement)
export const TAIKO_JUDGEMENT = judgement(HitResult.Great);
export const TAIKO_STRONG_JUDGEMENT = judgement(HitResult.LargeBonus);
export const TAIKO_DRUMROLL_TICK_JUDGEMENT = judgement(HitResult.SmallBonus);
export const TAIKO_SWELL_JUDGEMENT = judgement(HitResult.LargeBonus);
export const IGNORE_JUDGEMENT = judgement(HitResult.IgnoreHit);

export type TaikoObjectKind = 'hit' | 'strong' | 'drumroll' | 'drumrolltick' | 'swell' | 'swelltick';

/** HitObject.CreateHitSampleInfo */
export function createHitSampleInfo(samples: readonly HitSampleInfo[], sampleName: string = HIT_NORMAL): HitSampleInfo {
  // As per stable, all non-normal "addition" samples should use the same bank.
  if (sampleName !== HIT_NORMAL) {
    const existingAddition = samples.find(s => s.name !== HIT_NORMAL);
    if (existingAddition) return existingAddition.with({ name: sampleName });
  }
  // Fall back to using the normal sample bank otherwise.
  const existingNormal = samples.find(s => s.name === HIT_NORMAL);
  if (existingNormal) return existingNormal.with({ name: sampleName });
  return new HitSampleInfo({ name: sampleName });
}

export abstract class TaikoHitObject {
  abstract readonly kind: TaikoObjectKind;
  startTime = 0;
  samples: HitSampleInfo[] = [];
  kiai = false;
  hitWindows: HitWindows = EMPTY_HIT_WINDOWS;
  nested: TaikoHitObject[] = [];

  get endTime(): number {
    return this.startTime;
  }

  abstract get judgement(): Judgement;

  /** HitObject.ApplyDefaults */
  applyDefaults(controlPoints: ControlPointInfo, difficulty: BeatmapDifficulty): void {
    this.applyDefaultsToSelf(controlPoints, difficulty);
    this.nested = [];
    this.createNestedHitObjects();
    // List.Sort is unstable in .NET, but only equal-time nested objects are affected (no gameplay impact).
    this.nested.sort((a, b) => a.startTime - b.startTime);
    for (const n of this.nested) n.applyDefaults(controlPoints, difficulty);
  }

  protected applyDefaultsToSelf(controlPoints: ControlPointInfo, difficulty: BeatmapDifficulty): void {
    this.kiai = controlPoints.effectPointAt(this.startTime + CONTROL_POINT_LENIENCY).kiaiMode;
    this.hitWindows.setDifficulty(difficulty.overallDifficulty);
  }

  protected createNestedHitObjects(): void {}
}

/** TaikoStrongableHitObject */
export abstract class TaikoStrongableHitObject extends TaikoHitObject {
  private _isStrong = false;

  /** Whether this object is "strong" (requires both keys for the bonus). Mirrors the bindable/sample sync of the C# class. */
  get isStrong(): boolean {
    return this._isStrong;
  }

  set isStrong(value: boolean) {
    this._isStrong = value;
    this.updateSamplesFromStrong();
  }

  /** Sets samples and updates the strong state (and hit type for hits) from them, like the C# SamplesBindable callbacks. */
  setSamples(samples: HitSampleInfo[]): void {
    this.samples = samples.slice();
    this.updateFromSamples();
  }

  protected updateFromSamples(): void {
    this._isStrong = this.samples.some(s => s.name === HIT_FINISH);
  }

  private updateSamplesFromStrong(): void {
    const hasStrongSamples = this.samples.some(s => s.name === HIT_FINISH);
    if (this._isStrong === hasStrongSamples) return;
    if (this._isStrong) this.samples.push(createHitSampleInfo(this.samples, HIT_FINISH));
    else this.samples = this.samples.filter(s => s.name !== HIT_FINISH);
  }

  protected createNestedHitObjects(): void {
    if (this.isStrong) this.nested.push(this.createStrongNestedHit(this.endTime));
  }

  protected createStrongNestedHit(startTime: number): StrongNestedHitObject {
    const s = new StrongNestedHitObject(this);
    s.startTime = startTime;
    s.samples = this.samples;
    return s;
  }
}

/** StrongNestedHitObject (Hit.StrongNestedHit, DrumRoll.StrongNestedHit, DrumRollTick.StrongNestedHit). */
export class StrongNestedHitObject extends TaikoHitObject {
  readonly kind = 'strong' as const;

  constructor(readonly parent: TaikoStrongableHitObject) {
    super();
  }

  get judgement(): Judgement {
    // The strong hit of the drum roll doesn't actually provide any score.
    return this.parent instanceof DrumRoll ? IGNORE_JUDGEMENT : TAIKO_STRONG_JUDGEMENT;
  }
}

export class Hit extends TaikoStrongableHitObject {
  readonly kind = 'hit' as const;
  private _type: HitType = HitType.Centre;

  static readonly COLOUR_CENTRE: [number, number, number] = [0xbb, 0x11, 0x77];
  static readonly COLOUR_RIM: [number, number, number] = [0x22, 0x99, 0xbb];

  constructor() {
    super();
    this.hitWindows = new TaikoHitWindows();
  }

  get type(): HitType {
    return this._type;
  }

  set type(value: HitType) {
    this._type = value;
    this.updateSamplesFromType();
  }

  get judgement(): Judgement {
    return TAIKO_JUDGEMENT;
  }

  private isRimSample(s: HitSampleInfo): boolean {
    return s.name === HIT_CLAP || s.name === HIT_WHISTLE;
  }

  protected updateFromSamples(): void {
    super.updateFromSamples();
    this._type = this.samples.some(s => this.isRimSample(s)) ? HitType.Rim : HitType.Centre;
  }

  private updateSamplesFromType(): void {
    const isRimType = this._type === HitType.Rim;
    const hasRim = this.samples.some(s => this.isRimSample(s));
    if (isRimType === hasRim) return;
    if (isRimType) this.samples.push(createHitSampleInfo(this.samples, HIT_CLAP));
    else this.samples = this.samples.filter(s => !this.isRimSample(s));
  }
}

/** DrumRoll */
export class DrumRoll extends TaikoStrongableHitObject {
  readonly kind = 'drumroll' as const;
  /** Drum roll distance that results in a duration of 1 speed-adjusted beat length. */
  static readonly BASE_DISTANCE = 100;

  duration = 0;
  velocity = 0;
  /** Number of ticks per beat length. */
  tickRate = 1;
  /** The length (in milliseconds) between ticks of this drumroll. */
  tickSpacing = 100;

  get endTime(): number {
    return this.startTime + this.duration;
  }

  get judgement(): Judgement {
    return IGNORE_JUDGEMENT;
  }

  get ticks(): DrumRollTick[] {
    return this.nested.filter((n): n is DrumRollTick => n instanceof DrumRollTick);
  }

  get strongNested(): StrongNestedHitObject | undefined {
    return this.nested.find((n): n is StrongNestedHitObject => n instanceof StrongNestedHitObject);
  }

  protected applyDefaultsToSelf(controlPoints: ControlPointInfo, difficulty: BeatmapDifficulty): void {
    super.applyDefaultsToSelf(controlPoints, difficulty);
    const timingPoint = controlPoints.timingPointAt(this.startTime);
    const effectPoint = controlPoints.effectPointAt(this.startTime);
    const scoringDistance = DrumRoll.BASE_DISTANCE * (difficulty.sliderMultiplier * VELOCITY_MULTIPLIER) * effectPoint.scrollSpeed;
    this.velocity = scoringDistance / timingPoint.beatLength;
    this.tickRate = difficulty.sliderTickRate === 3 ? 3 : 4;
    this.tickSpacing = timingPoint.beatLength / this.tickRate;
  }

  protected createNestedHitObjects(): void {
    this.createTicks();
    super.createNestedHitObjects();
  }

  private createTicks(): void {
    if (this.tickSpacing === 0) return;
    let first = true;
    for (let t = this.startTime; t < this.endTime + this.tickSpacing / 2; t += this.tickSpacing) {
      const tick = new DrumRollTick(this);
      tick.firstTick = first;
      tick.tickSpacing = this.tickSpacing;
      tick.startTime = t;
      tick.samples = this.samples;
      tick.isStrong = this.isStrong;
      this.nested.push(tick);
      first = false;
    }
  }
}

export class DrumRollTick extends TaikoStrongableHitObject {
  readonly kind = 'drumrolltick' as const;
  /** Whether this is the first (initial) tick of the slider. */
  firstTick = false;
  /** The length (in milliseconds) between this tick and the next. Half of this value is the hit window of the tick. */
  tickSpacing = 0;

  constructor(readonly parent: DrumRoll) {
    super();
  }

  /** The time allowed to hit this tick. */
  get hitWindow(): number {
    return this.tickSpacing / 2;
  }

  get judgement(): Judgement {
    return TAIKO_DRUMROLL_TICK_JUDGEMENT;
  }

  get strongNested(): StrongNestedHitObject | undefined {
    return this.nested[0] as StrongNestedHitObject | undefined;
  }
}

export class Swell extends TaikoHitObject {
  readonly kind = 'swell' as const;
  duration = 0;
  /** The number of hits required to complete the swell successfully. */
  requiredHits = 10;

  get endTime(): number {
    return this.startTime + this.duration;
  }

  get judgement(): Judgement {
    return TAIKO_SWELL_JUDGEMENT;
  }

  get ticks(): SwellTick[] {
    return this.nested as SwellTick[];
  }

  protected createNestedHitObjects(): void {
    for (let i = 0; i < this.requiredHits; i++) {
      const t = new SwellTick();
      t.startTime = this.startTime;
      t.samples = this.samples;
      this.nested.push(t);
    }
  }
}

export class SwellTick extends TaikoHitObject {
  readonly kind = 'swelltick' as const;

  get judgement(): Judgement {
    return IGNORE_JUDGEMENT;
  }
}

/** Taiko BarLine (generated by BarLineGenerator, never judged). */
export interface TaikoBarLine {
  startTime: number;
  major: boolean;
}

/** Judgement.HealthIncreaseFor for each taiko judgement type. */
export function taikoHealthIncreaseFor(h: TaikoHitObject, result: HitResult): number {
  switch (h.kind) {
    case 'hit':
      // TaikoJudgement
      switch (result) {
        case HitResult.Miss:
          return -1.0;
        case HitResult.Ok:
          return 1.1;
        case HitResult.Great:
          return 3.0;
        default:
          return 0;
      }
    case 'swell':
      // TaikoSwellJudgement
      return result === HitResult.IgnoreMiss ? -0.65 : 0;
    default:
      // TaikoStrongJudgement / TaikoDrumRollTickJudgement / IgnoreJudgement: no health change.
      return 0;
  }
}

/** Iterates the object and its nested objects in the order of HitObject simulation (nested first, then the object itself). */
export function forEachJudgedInSimulationOrder(h: TaikoHitObject, fn: (o: TaikoHitObject) => void): void {
  for (const n of h.nested) forEachJudgedInSimulationOrder(n, fn);
  fn(h);
}
