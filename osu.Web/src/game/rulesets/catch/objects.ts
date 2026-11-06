// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game.Rulesets.Catch/Objects/*: CatchHitObject.cs, PalpableCatchHitObject.cs, Fruit.cs, Droplet.cs,
// TinyDroplet.cs, Banana.cs, BananaShower.cs, JuiceStream.cs (+ the judgements in Judgements/*.cs).

import { f32 } from '../../../framework/math';
import { HIT_NORMAL, HitSampleInfo } from '../../audio/HitSampleInfo';
import type { ControlPointInfo } from '../../beatmaps/ControlPoints';
import { BeatmapDifficulty, difficultyRange, difficultyRangeInt, range } from '../../beatmaps/Difficulty';
import { SliderPath } from '../../objects/SliderPath';
import { generateSliderEvents, type SliderEventDescriptor } from '../../objects/SliderEventGenerator';
import { HitResult } from '../../scoring/HitResult';
import { judgement, type Judgement } from '../../scoring/Judgement';

/** CatchPlayfield.WIDTH */
export const PLAYFIELD_WIDTH = 512;
/** CatchPlayfield.HEIGHT */
export const PLAYFIELD_HEIGHT = 384;
export const PLAYFIELD_CENTER_X = PLAYFIELD_WIDTH / 2;

export const OBJECT_RADIUS = 64;
export const DEFAULT_LEGACY_CONVERT_Y = 192;
export const PREEMPT_MIN = 450;
export const PREEMPT_MID = 1200;
export const PREEMPT_MAX = 1800;
export const PREEMPT_RANGE = range(PREEMPT_MAX, PREEMPT_MID, PREEMPT_MIN);

/** C# float clamp (Math.Clamp on floats). */
const clampF = (v: number, min: number, max: number): number => (v < min ? min : v > max ? max : v);

/** LegacyRulesetExtensions.CalculateScaleFromCircleSize (no fudge, as used by catch). */
export function calculateScaleFromCircleSize(circleSize: number): number {
  return f32(f32(1.0 - f32(0.7) * ((circleSize - 5) / 5)) / 2);
}

/** IBeatmapDifficultyInfo.DifficultyRange with a single argument. */
export const difficultyRangeUnitC = (difficulty: number): number => (difficulty - 5) / 5;

const CONTROL_POINT_LENIENCY = 1;

export type CatchObjectKind = 'fruit' | 'droplet' | 'tinyDroplet' | 'banana' | 'juiceStream' | 'bananaShower';

export abstract class CatchHitObject {
  abstract readonly kind: CatchObjectKind;

  startTime = 0;
  samples: HitSampleInfo[] = [];
  kiai = false;

  /** Single-precision original X position. */
  private _originalX = 0;
  private _xOffset = 0;

  timePreempt = 1000;
  scale = 1;
  indexInBeatmap = 0;

  newCombo = false;
  comboOffset = 0;
  indexInCurrentCombo = 0;
  comboIndex = 0;
  comboIndexWithOffsets = 0;
  private _lastInCombo = false;

  legacyConvertedY = DEFAULT_LEGACY_CONVERT_Y;

  /** Nested hit objects, sorted by start time (HitObject.NestedHitObjects). */
  nested: CatchHitObject[] = [];
  parent: CatchHitObject | null = null;

  get originalX(): number {
    return this._originalX;
  }
  set originalX(v: number) {
    this._originalX = f32(v);
  }

  get xOffset(): number {
    return this._xOffset;
  }
  set xOffset(v: number) {
    this._xOffset = f32(v);
  }

  /** Math.Clamp(OriginalX + XOffset, 0, CatchPlayfield.WIDTH) */
  get effectiveX(): number {
    return clampF(f32(this._originalX + this._xOffset), 0, PLAYFIELD_WIDTH);
  }

  get lastInCombo(): boolean {
    return this._lastInCombo;
  }
  set lastInCombo(v: boolean) {
    this._lastInCombo = v;
  }

  get duration(): number {
    return 0;
  }

  get endTime(): number {
    return this.startTime + this.duration;
  }

  /** (int)StartTime */
  get randomSeed(): number {
    return Math.trunc(this.startTime) | 0;
  }

  abstract createJudgement(): Judgement;

  private _judgement: Judgement | null = null;
  get judgement(): Judgement {
    return (this._judgement ??= this.createJudgement());
  }

  /** HitObject.ApplyDefaults */
  applyDefaults(controlPoints: ControlPointInfo, difficulty: BeatmapDifficulty, formatVersion: number): void {
    this.applyDefaultsToSelf(controlPoints, difficulty);

    this.nested = [];
    this.createNestedHitObjects(formatVersion);

    for (const n of this.nested) {
      n.parent = this;
      // Combo information of nested objects is bound to the parent's.
      n.comboIndex = this.comboIndex;
      n.comboIndexWithOffsets = this.comboIndexWithOffsets;
      n.indexInCurrentCombo = this.indexInCurrentCombo;
    }

    // List.Sort by start time (a stable sort is used here).
    this.nested.sort((a, b) => a.startTime - b.startTime);

    for (const n of this.nested) n.applyDefaults(controlPoints, difficulty, formatVersion);
  }

  protected applyDefaultsToSelf(controlPoints: ControlPointInfo, difficulty: BeatmapDifficulty): void {
    this.kiai = controlPoints.effectPointAt(this.startTime + CONTROL_POINT_LENIENCY).kiaiMode;
    this.timePreempt = difficultyRangeInt(difficulty.approachRate, PREEMPT_RANGE);
    this.scale = calculateScaleFromCircleSize(difficulty.circleSize);
  }

  protected createNestedHitObjects(_formatVersion: number): void {}

  /** CatchHitObject.UpdateComboInformation */
  updateComboInformation(lastObj: CatchHitObject | null): void {
    let index = lastObj?.comboIndex ?? 0;
    let indexWithOffsets = lastObj?.comboIndexWithOffsets ?? 0;
    let inCurrentCombo = lastObj ? lastObj.indexInCurrentCombo + 1 : 0;

    if (!(this instanceof BananaShower) && (this.newCombo || lastObj == null || lastObj instanceof BananaShower)) {
      inCurrentCombo = 0;
      index++;
      indexWithOffsets += this.comboOffset + 1;
      if (lastObj) lastObj.lastInCombo = true;
    }

    this.comboIndex = index;
    this.comboIndexWithOffsets = indexWithOffsets;
    this.indexInCurrentCombo = inCurrentCombo;
  }

  /** HitObject.CreateHitSampleInfo */
  createHitSampleInfo(sampleName = HIT_NORMAL): HitSampleInfo {
    if (sampleName !== HIT_NORMAL) {
      const addition = this.samples.find(s => s.name !== HIT_NORMAL);
      if (addition) return addition.with({ name: sampleName });
    }
    const normal = this.samples.find(s => s.name === HIT_NORMAL);
    if (normal) return normal.with({ name: sampleName });
    return new HitSampleInfo({ name: sampleName });
  }
}

/** PalpableCatchHitObject: an object that can be caught by the catcher. */
export abstract class PalpableCatchHitObject extends CatchHitObject {
  distanceToHyperDash = 0;
  hyperDashTarget: CatchHitObject | null = null;

  get hyperDash(): boolean {
    return this.hyperDashTarget != null;
  }
}

export class Fruit extends PalpableCatchHitObject {
  readonly kind: CatchObjectKind = 'fruit';
  createJudgement(): Judgement {
    return judgement(HitResult.Great);
  }
}

export class Droplet extends PalpableCatchHitObject {
  readonly kind: CatchObjectKind = 'droplet';
  createJudgement(): Judgement {
    return judgement(HitResult.LargeTickHit);
  }
}

export class TinyDroplet extends Droplet {
  readonly kind: CatchObjectKind = 'tinyDroplet';
  createJudgement(): Judgement {
    return judgement(HitResult.SmallTickHit);
  }
}

/** Banana.BananaHitSampleInfo: looks up the dedicated banana sample instead of the normal hitsound. */
export class BananaHitSampleInfo extends HitSampleInfo {
  static readonly LOOKUP_NAMES = ['Gameplay/metronomelow', 'Gameplay/catch-banana'];

  constructor(info?: HitSampleInfo) {
    super({ name: info?.name ?? '', bank: info?.bank, volume: info?.volume ?? 100, customSampleBank: info?.customSampleBank ?? 0 });
  }

  override get lookupNames(): string[] {
    return BananaHitSampleInfo.LOOKUP_NAMES;
  }

  override with(changes: Parameters<HitSampleInfo['with']>[0]): HitSampleInfo {
    return new BananaHitSampleInfo(super.with(changes));
  }
}

const DEFAULT_BANANA_SAMPLES: HitSampleInfo[] = [new BananaHitSampleInfo()];

export class Banana extends PalpableCatchHitObject {
  readonly kind: CatchObjectKind = 'banana';
  bananaIndex = 0;

  constructor() {
    super();
    this.samples = DEFAULT_BANANA_SAMPLES;
  }

  createJudgement(): Judgement {
    return judgement(HitResult.LargeBonus);
  }

  /** Banana.getBananaColour */
  get bananaColour(): [number, number, number] {
    switch (statelessNextInt(3, this.randomSeed)) {
      default:
        return [255, 240, 0];
      case 1:
        return [255, 192, 0];
      case 2:
        return [214, 221, 28];
    }
  }
}

export class BananaShower extends CatchHitObject {
  readonly kind: CatchObjectKind = 'bananaShower';
  private _duration = 0;

  override get lastInCombo(): boolean {
    return true;
  }
  override set lastInCombo(_v: boolean) {}

  override get duration(): number {
    return this._duration;
  }
  setDuration(v: number): void {
    this._duration = v;
  }

  createJudgement(): Judgement {
    return judgement(HitResult.IgnoreHit);
  }

  protected override createNestedHitObjects(): void {
    // Int truncation added to match osu!stable.
    const startTime = Math.trunc(this.startTime);
    const endTime = Math.trunc(this.endTime);
    let spacing = f32(this.endTime - this.startTime);
    while (spacing > 100) spacing = f32(spacing / 2);

    if (spacing <= 0) return;

    let count = 0;
    const samples = [new BananaHitSampleInfo(this.createHitSampleInfo())];

    for (let time = f32(startTime); time <= endTime; time = f32(time + spacing)) {
      const banana = new Banana();
      banana.startTime = time;
      banana.bananaIndex = count;
      banana.samples = samples;
      this.nested.push(banana);
      count++;
    }
  }
}

const BASE_SCORING_DISTANCE = 100;

export class JuiceStream extends CatchHitObject {
  readonly kind: CatchObjectKind = 'juiceStream';

  repeatCount = 0;
  private _sliderVelocityMultiplier = 1;
  tickDistanceMultiplier = 1;
  velocity = 0;
  tickDistance = 0;
  path: SliderPath = new SliderPath();
  nodeSamples: HitSampleInfo[][] = [];

  get sliderVelocityMultiplier(): number {
    return this._sliderVelocityMultiplier;
  }
  set sliderVelocityMultiplier(v: number) {
    this._sliderVelocityMultiplier = Math.min(10, Math.max(0.1, v));
  }

  get spanCount(): number {
    return this.repeatCount + 1;
  }

  override get duration(): number {
    return (this.spanCount * this.path.distance) / this.velocity;
  }

  get spanDuration(): number {
    return this.duration / this.spanCount;
  }

  /** EffectiveX + CurvePositionAt(1).X */
  get endX(): number {
    const progress = this.spanCount % 2 === 0 ? 0 : 1;
    return f32(this.effectiveX + this.path.positionAt(progress).x);
  }

  createJudgement(): Judgement {
    return judgement(HitResult.IgnoreHit);
  }

  protected override applyDefaultsToSelf(controlPoints: ControlPointInfo, difficulty: BeatmapDifficulty): void {
    super.applyDefaultsToSelf(controlPoints, difficulty);

    const timingPoint = controlPoints.timingPointAt(this.startTime);

    this.velocity = (BASE_SCORING_DISTANCE * difficulty.sliderMultiplier) / getPrecisionAdjustedBeatLength(this.sliderVelocityMultiplier, timingPoint.beatLength);

    // WARNING: this is intentionally not computed as `BASE_SCORING_DISTANCE * difficulty.SliderMultiplier`
    // for backwards compatibility reasons (intentionally introducing floating point errors to match stable).
    const scoringDistance = this.velocity * timingPoint.beatLength;

    this.tickDistance = (scoringDistance / difficulty.sliderTickRate) * this.tickDistanceMultiplier;
  }

  private getNodeSamples(nodeIndex: number): HitSampleInfo[] {
    return nodeIndex < this.nodeSamples.length ? this.nodeSamples[nodeIndex] : this.samples;
  }

  protected override createNestedHitObjects(): void {
    // IHasRepeatsExtensions.PopulateNodeSamples
    while (this.nodeSamples.length < this.repeatCount + 2) this.nodeSamples.push(this.samples.map(s => s.with({})));

    const dropletSamples = this.samples.map(s => s.with({ name: 'slidertick' }));

    let nodeIndex = 0;
    let lastEvent: SliderEventDescriptor | null = null;
    const baseX = this.effectiveX;

    const events = generateSliderEvents(this.startTime, this.spanDuration, this.velocity, this.tickDistance, this.path.distance, this.spanCount);

    for (const e of events) {
      // generate tiny droplets since the last point
      if (lastEvent != null) {
        const sinceLastTick = Math.trunc(e.time) - Math.trunc(lastEvent.time);

        if (sinceLastTick > 80) {
          let timeBetweenTiny = sinceLastTick;
          while (timeBetweenTiny > 100) timeBetweenTiny /= 2;

          for (let t = timeBetweenTiny; t < sinceLastTick; t += timeBetweenTiny) {
            const tiny = new TinyDroplet();
            tiny.startTime = t + lastEvent.time;
            tiny.originalX = f32(baseX + f32(this.path.positionAt(lastEvent.pathProgress + (t / sinceLastTick) * (e.pathProgress - lastEvent.pathProgress)).x));
            this.nested.push(tiny);
          }
        }
      }

      // this also includes LastTick and this is used for TinyDroplet generation above.
      // this means that the final segment of TinyDroplets are increasingly mistimed where LastTick is being applied.
      lastEvent = e;

      switch (e.type) {
        case 'Tick': {
          const droplet = new Droplet();
          droplet.samples = dropletSamples;
          droplet.startTime = e.time;
          droplet.originalX = f32(baseX + f32(this.path.positionAt(e.pathProgress).x));
          this.nested.push(droplet);
          break;
        }

        case 'Head':
        case 'Tail':
        case 'Repeat': {
          const fruit = new Fruit();
          fruit.samples = this.getNodeSamples(nodeIndex++);
          fruit.startTime = e.time;
          fruit.originalX = f32(baseX + f32(this.path.positionAt(e.pathProgress).x));
          this.nested.push(fruit);
          break;
        }
      }
    }
  }
}

/** LegacyRulesetExtensions.GetPrecisionAdjustedBeatLength for "fruits". */
export function getPrecisionAdjustedBeatLength(sliderVelocityMultiplier: number, beatLength: number): number {
  const sliderVelocityAsBeatLength = -100 / sliderVelocityMultiplier;
  const bpmMultiplier = sliderVelocityAsBeatLength < 0 ? clampF(f32(-sliderVelocityAsBeatLength), 10, 1000) / 100.0 : 1;
  return beatLength * bpmMultiplier;
}

/** CatchBeatmap.GetPalpableObjects: every palpable object (including nested), ordered by start time (stable). */
export function getPalpableObjects(hitObjects: readonly CatchHitObject[]): PalpableCatchHitObject[] {
  const out: PalpableCatchHitObject[] = [];
  for (const h of hitObjects) {
    if (h instanceof PalpableCatchHitObject) out.push(h);
    for (const n of h.nested) if (n instanceof PalpableCatchHitObject) out.push(n);
  }
  // Array.prototype.sort is stable, matching LINQ OrderBy.
  return out.sort((a, b) => a.startTime - b.startTime);
}

/** DrawableCatchRuleset.GetTimeRange */
export const getTimeRange = (approachRate: number): number => difficultyRange(approachRate, PREEMPT_MAX, PREEMPT_MID, PREEMPT_MIN);

// ---- StatelessRNG (osu.Game/Utils/StatelessRNG.cs) ----

const M64 = (1n << 64n) - 1n;

function mix(x: bigint): bigint {
  x ^= x >> 33n;
  x = (x * 0xff51afd7ed558ccdn) & M64;
  x ^= x >> 33n;
  x = (x * 0xc4ceb9fe1a85ec53n) & M64;
  x ^= x >> 33n;
  return x;
}

export function statelessNextULong(seed: number, series = 0): bigint {
  const combined = (BigInt(series >>> 0) << 32n) | BigInt(seed >>> 0);
  return mix(combined ^ 0x12345678n);
}

export function statelessNextInt(maxValue: number, seed: number, series = 0): number {
  return Number(statelessNextULong(seed, series) % BigInt(maxValue));
}

export function statelessNextSingle(seed: number, series = 0): number {
  return Number(statelessNextULong(seed, series) & 0xffffffn) / (1 << 24);
}
