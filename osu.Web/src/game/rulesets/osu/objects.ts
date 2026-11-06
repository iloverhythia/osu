// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game.Rulesets.Osu/Objects/*.cs

import type { HitSampleInfo } from '../../audio/HitSampleInfo';
import { BeatmapDifficulty, difficultyRange, difficultyRangeInt, range } from '../../beatmaps/Difficulty';
import type { ControlPointInfo } from '../../beatmaps/ControlPoints';
import { Vec2 } from '../../../framework/math';
import { SliderPath } from '../../objects/SliderPath';
import { generateSliderEvents } from '../../objects/SliderEventGenerator';
import { HitResult } from '../../scoring/HitResult';
import { HitWindows } from '../../scoring/HitWindows';
import { Judgement, judgement } from '../../scoring/Judgement';

export const OBJECT_RADIUS = 64;
export const BASE_SCORING_DISTANCE = 100;
export const PREEMPT_MIN = 450;
export const PREEMPT_RANGE = range(1800, 1200, 450);
export const PLAYFIELD_WIDTH = 512;
export const PLAYFIELD_HEIGHT = 384;

/** OsuHitWindows */
export class OsuHitWindows extends HitWindows {
  static readonly GREAT_WINDOW_RANGE = range(80, 50, 20);
  static readonly OK_WINDOW_RANGE = range(140, 100, 60);
  static readonly MEH_WINDOW_RANGE = range(200, 150, 100);
  static readonly MISS_WINDOW = 400;
  great = 0;
  ok = 0;
  meh = 0;

  isHitResultAllowed(result: HitResult): boolean {
    return result === HitResult.Great || result === HitResult.Ok || result === HitResult.Meh || result === HitResult.Miss;
  }

  setDifficulty(difficulty: number): void {
    this.great = Math.floor(difficultyRange(difficulty, OsuHitWindows.GREAT_WINDOW_RANGE)) - 0.5;
    this.ok = Math.floor(difficultyRange(difficulty, OsuHitWindows.OK_WINDOW_RANGE)) - 0.5;
    this.meh = Math.floor(difficultyRange(difficulty, OsuHitWindows.MEH_WINDOW_RANGE)) - 0.5;
  }

  windowFor(result: HitResult): number {
    switch (result) {
      case HitResult.Great:
        return this.great;
      case HitResult.Ok:
        return this.ok;
      case HitResult.Meh:
        return this.meh;
      case HitResult.Miss:
        return OsuHitWindows.MISS_WINDOW;
      default:
        throw new Error(`Unsupported result ${result}`);
    }
  }
}

/** LegacyRulesetExtensions.CalculateScaleFromCircleSize */
export function calculateScaleFromCircleSize(circleSize: number, applyFudge = false): number {
  // The following comment is copied verbatim from osu-stable:
  // Builds of osu! up to 2013-05-04 had the gamefield being rounded down, which caused incorrect radius calculations
  // in widescreen cases. This ratio adjusts to allow for old replays to work post-fix, which in turn increases the lenience
  // for all plays, but by an amount so small it should only be effective in replays.
  const brokenGamefieldRoundingAllowance = Math.fround(1.00041);
  const r = Math.fround(1.0 - Math.fround(0.7) * ((circleSize - 5) / 5));
  return Math.fround((r / 2) * (applyFudge ? brokenGamefieldRoundingAllowance : 1));
}

export type OsuObjectKind = 'circle' | 'slider' | 'spinner' | 'sliderHead' | 'sliderTick' | 'sliderRepeat' | 'sliderTail' | 'spinnerTick' | 'spinnerBonusTick';

let nextId = 1;

export abstract class OsuHitObject {
  readonly id = nextId++;
  abstract readonly kind: OsuObjectKind;
  startTime = 0;
  position: Vec2 = { x: 0, y: 0 };
  stackHeight = 0;
  scale = 1;
  timePreempt = 600;
  timeFadeIn = 400;
  newCombo = false;
  comboOffset = 0;
  comboIndex = 0;
  comboIndexWithOffsets = 0;
  indexInCurrentCombo = 0;
  lastInCombo = false;
  samples: HitSampleInfo[] = [];
  hitWindows: HitWindows | null = null;

  get radius(): number {
    return OBJECT_RADIUS * this.scale;
  }

  get stackOffset(): Vec2 {
    const o = Math.fround(this.stackHeight * this.scale * Math.fround(-6.4));
    return { x: o, y: o };
  }

  get stackedPosition(): Vec2 {
    const o = this.stackOffset;
    return { x: this.position.x + o.x, y: this.position.y + o.y };
  }

  get endPosition(): Vec2 {
    return this.position;
  }

  get stackedEndPosition(): Vec2 {
    const o = this.stackOffset;
    const e = this.endPosition;
    return { x: e.x + o.x, y: e.y + o.y };
  }

  get endTime(): number {
    return this.startTime;
  }

  get duration(): number {
    return this.endTime - this.startTime;
  }

  abstract get judgement(): Judgement;

  /** HitObject.ApplyDefaults: sets own defaults then creates nested objects. */
  applyDefaults(controlPoints: ControlPointInfo, difficulty: BeatmapDifficulty): void {
    this.applyDefaultsToSelf(controlPoints, difficulty);
    this.createNestedHitObjects();
    // HitObject.ApplyDefaults sorts nested objects by start time.
    this.nested.sort((a, b) => a.startTime - b.startTime);
    for (const n of this.nested) n.applyDefaults(controlPoints, difficulty);
  }

  protected applyDefaultsToSelf(_controlPoints: ControlPointInfo, difficulty: BeatmapDifficulty): void {
    this.timePreempt = difficultyRangeInt(difficulty.approachRate, PREEMPT_RANGE);
    // Spinner fade in is relative to preempt; this formula mirrors OsuHitObject.
    this.timeFadeIn = 400 * Math.min(1, this.timePreempt / PREEMPT_MIN);
    this.scale = calculateScaleFromCircleSize(difficulty.circleSize, true);
    if (this.hitWindows) this.hitWindows.setDifficulty(difficulty.overallDifficulty);
  }

  nested: OsuHitObject[] = [];

  protected createNestedHitObjects(): void {
    this.nested = [];
  }

  /** Propagate stack height to nested objects (OsuHitObject stackHeight bindable). */
  setStackHeight(h: number): void {
    this.stackHeight = h;
    for (const n of this.nested) n.stackHeight = h;
  }
}

export class HitCircle extends OsuHitObject {
  readonly kind: OsuObjectKind = 'circle';
  hitWindows: HitWindows = new OsuHitWindows();
  get judgement(): Judgement {
    return judgement(HitResult.Great);
  }
}

export class SliderHeadCircle extends HitCircle {
  readonly kind: OsuObjectKind = 'sliderHead';
  constructor(readonly slider: Slider) {
    super();
  }
}

export abstract class SliderEndCircle extends HitCircle {
  repeatIndex = 0;
  constructor(readonly slider: Slider) {
    super();
    this.hitWindows = new OsuHitWindows(); // unused for judging, but keeps shape consistent
  }

  get spanDuration(): number {
    return this.slider.spanDuration;
  }

  protected applyDefaultsToSelf(cp: ControlPointInfo, d: BeatmapDifficulty): void {
    super.applyDefaultsToSelf(cp, d);
    if (this.repeatIndex > 0) {
      // Repeat points after the first span should appear behind the still-visible one.
      this.timeFadeIn = 0;
      // The next end circle should appear exactly after the previous circle (on the same end) is hit.
      this.timePreempt = this.spanDuration * 2;
    } else {
      // The first end circle should fade in with the slider.
      this.timePreempt += this.startTime - this.slider.startTime;
    }
  }

  get judgement(): Judgement {
    return judgement(HitResult.LargeTickHit);
  }
}

export class SliderRepeat extends SliderEndCircle {
  readonly kind: OsuObjectKind = 'sliderRepeat';
  pathProgress = 0;
}

export class SliderTailCircle extends SliderEndCircle {
  readonly kind: OsuObjectKind = 'sliderTail';
  get judgement(): Judgement {
    return judgement(HitResult.SliderTailHit);
  }
}

export class SliderTick extends OsuHitObject {
  readonly kind: OsuObjectKind = 'sliderTick';
  spanIndex = 0;
  spanStartTime = 0;
  pathProgress = 0;

  protected applyDefaultsToSelf(cp: ControlPointInfo, d: BeatmapDifficulty): void {
    super.applyDefaultsToSelf(cp, d);
    // Adding 200 to include the offset stable used.
    // This is so on repeats ticks don't appear too late to be visually processed by the player.
    const offset = this.spanIndex > 0 ? 200 : this.timePreempt * Math.fround(0.66);
    this.timePreempt = (this.startTime - this.spanStartTime) / 2 + offset;
  }

  get judgement(): Judgement {
    return judgement(HitResult.LargeTickHit);
  }
}

export class Slider extends OsuHitObject {
  readonly kind: OsuObjectKind = 'slider';
  path = new SliderPath([], null, true);
  repeatCount = 0;
  nodeSamples: HitSampleInfo[][] = [];
  tailSamples: HitSampleInfo[] = [];
  velocity = 1;
  tickDistance = 0;
  tickDistanceMultiplier = 1;
  sliderVelocityMultiplier = 1;
  generateTicks = true;

  headCircle!: SliderHeadCircle;
  tailCircle!: SliderTailCircle;
  ticks: SliderTick[] = [];
  repeats: SliderRepeat[] = [];
  /** Legacy last tick time (used by the difficulty calculator's lazy slider travel). */
  legacyLastTickTime = 0;

  get spanCount(): number {
    return this.repeatCount + 1;
  }

  get endTime(): number {
    return this.startTime + (this.spanCount * this.path.distance) / this.velocity;
  }

  get spanDuration(): number {
    return this.duration / this.spanCount;
  }

  /** Position + CurvePositionAt(1): the head position for sliders with an even span count. */
  get endPosition(): Vec2 {
    const p = this.curvePositionAt(1);
    return { x: this.position.x + p.x, y: this.position.y + p.y };
  }

  /** Position relative to the slider head at a given progress along the whole slider (accounting for repeats). */
  curvePositionAt(progress: number): Vec2 {
    return this.path.positionAt(this.progressAt(progress));
  }

  /** SliderExtensions / IHasPathWithRepeats.ProgressAt */
  progressAt(progress: number): number {
    let p = (progress * this.spanCount) % 1;
    if (Math.floor(progress * this.spanCount) % 2 === 1) p = 1 - p;
    if (progress >= 1 && this.spanCount % 2 === 1) return 1;
    if (progress >= 1 && this.spanCount % 2 === 0) return 0;
    return p;
  }

  stackedPositionAt(t: number): Vec2 {
    const s = this.stackedPosition;
    const c = this.curvePositionAt(t);
    return { x: s.x + c.x, y: s.y + c.y };
  }

  get judgement(): Judgement {
    // Non-classic: the slider itself is an ignore judgement; nested objects carry the score.
    return judgement(HitResult.IgnoreHit);
  }

  protected applyDefaultsToSelf(cp: ControlPointInfo, d: BeatmapDifficulty): void {
    super.applyDefaultsToSelf(cp, d);
    const timingPoint = cp.timingPointAt(this.startTime);
    this.velocity = (BASE_SCORING_DISTANCE * d.sliderMultiplier) / getPrecisionAdjustedBeatLength(this.sliderVelocityMultiplier, timingPoint.beatLength);
    // WARNING: this is intentionally not computed as `BASE_SCORING_DISTANCE * difficulty.SliderMultiplier`
    // for backwards compatibility reasons (intentionally introducing floating point errors to match stable).
    const scoringDistance = this.velocity * timingPoint.beatLength;
    this.tickDistance = this.generateTicks ? (scoringDistance / d.sliderTickRate) * this.tickDistanceMultiplier : Infinity;
  }

  protected createNestedHitObjects(): void {
    this.nested = [];
    this.ticks = [];
    this.repeats = [];
    const events = generateSliderEvents(this.startTime, this.spanDuration, this.velocity, this.tickDistance, this.path.distance, this.spanCount);
    for (const e of events) {
      switch (e.type) {
        case 'Tick': {
          const t = new SliderTick();
          t.spanIndex = e.spanIndex;
          t.spanStartTime = e.spanStartTime;
          t.startTime = e.time;
          const p = this.path.positionAt(e.pathProgress);
          t.position = { x: this.position.x + p.x, y: this.position.y + p.y };
          t.pathProgress = e.pathProgress;
          t.stackHeight = this.stackHeight;
          this.ticks.push(t);
          this.nested.push(t);
          break;
        }
        case 'Head': {
          const h = new SliderHeadCircle(this);
          h.startTime = e.time;
          h.position = { ...this.position };
          h.stackHeight = this.stackHeight;
          this.headCircle = h;
          this.nested.push(h);
          break;
        }
        case 'LegacyLastTick':
          this.legacyLastTickTime = e.time;
          break;
        case 'Tail': {
          const t = new SliderTailCircle(this);
          t.repeatIndex = e.spanIndex;
          t.startTime = e.time;
          t.position = this.endPosition;
          t.stackHeight = this.stackHeight;
          this.tailCircle = t;
          this.nested.push(t);
          break;
        }
        case 'Repeat': {
          const r = new SliderRepeat(this);
          r.repeatIndex = e.spanIndex;
          r.startTime = this.startTime + (e.spanIndex + 1) * this.spanDuration;
          const p = this.path.positionAt(e.pathProgress);
          r.position = { x: this.position.x + p.x, y: this.position.y + p.y };
          r.stackHeight = this.stackHeight;
          r.pathProgress = e.pathProgress;
          this.repeats.push(r);
          this.nested.push(r);
          break;
        }
      }
    }
    this.updateNestedSamples();
  }

  private updateNestedSamples(): void {
    // PopulateNodeSamples
    while (this.nodeSamples.length < this.repeatCount + 2) this.nodeSamples.push(this.samples.map(s => s.with({})));
    const normal = this.samples.find(s => s.name === 'hitnormal') ?? this.samples[0];
    const tickSample = normal ? normal.with({ name: 'slidertick' }) : null;
    const nodeSamplesAt = (i: number) => (i < this.nodeSamples.length ? this.nodeSamples[i] : this.samples);
    for (const t of this.ticks) t.samples = tickSample ? [tickSample] : [];
    for (const r of this.repeats) r.samples = nodeSamplesAt(r.repeatIndex + 1);
    if (this.headCircle) this.headCircle.samples = nodeSamplesAt(0);
    this.tailSamples = nodeSamplesAt(this.repeatCount + 1);
    if (this.tailCircle) this.tailCircle.samples = this.tailSamples;
  }

  /** Samples to loop while sliding (CreateSlidingSamples). */
  get slidingSamples(): HitSampleInfo[] {
    const out: HitSampleInfo[] = [];
    const normal = this.samples.find(s => s.name === 'hitnormal') ?? this.samples[0];
    if (normal) out.push(normal.with({ name: 'sliderslide' }));
    if (this.samples.some(s => s.name === 'hitwhistle') && normal) out.push(normal.with({ name: 'sliderwhistle' }));
    return out;
  }
}

/** LegacyRulesetExtensions.GetPrecisionAdjustedBeatLength for "osu" / "fruits". */
export function getPrecisionAdjustedBeatLength(sliderVelocityMultiplier: number, beatLength: number): number {
  const sliderVelocityAsBeatLength = -100 / sliderVelocityMultiplier;
  // Note: In stable, the division occurs on floats, but with compiler optimisations turned on actually seems to occur on doubles via some .NET black magic (possibly inlining?).
  const bpmMultiplier = sliderVelocityAsBeatLength < 0 ? Math.min(Math.max(Math.fround(-sliderVelocityAsBeatLength), 10), 1000) / 100.0 : 1;
  return beatLength * bpmMultiplier;
}

export class SpinnerTick extends OsuHitObject {
  readonly kind: OsuObjectKind = 'spinnerTick';
  spinnerDuration = 0;
  get judgement(): Judgement {
    return judgement(HitResult.SmallBonus);
  }
}

export class SpinnerBonusTick extends SpinnerTick {
  readonly kind: OsuObjectKind = 'spinnerBonusTick';
  get judgement(): Judgement {
    return judgement(HitResult.LargeBonus);
  }
}

export class Spinner extends OsuHitObject {
  readonly kind: OsuObjectKind = 'spinner';
  static readonly CLEAR_RPM_RANGE = range(90, 150, 225);
  static readonly COMPLETE_RPM_RANGE = range(250, 380, 430);
  static readonly BONUS_SPINS_GAP = 2;
  private _duration = 0;
  spinsRequired = 1;
  maximumBonusSpins = 1;
  ticks: SpinnerTick[] = [];

  get endTime(): number {
    return this.startTime + this._duration;
  }

  set spinnerDuration(v: number) {
    this._duration = v;
  }

  get spinsRequiredForBonus(): number {
    return this.spinsRequired + Spinner.BONUS_SPINS_GAP;
  }

  get stackOffset(): Vec2 {
    return { x: 0, y: 0 };
  }

  get judgement(): Judgement {
    return judgement(HitResult.Great);
  }

  protected applyDefaultsToSelf(cp: ControlPointInfo, d: BeatmapDifficulty): void {
    super.applyDefaultsToSelf(cp, d);
    // The average RPS required over the length of the spinner to clear the spinner.
    const minRps = difficultyRange(d.overallDifficulty, Spinner.CLEAR_RPM_RANGE) / 60;
    // The RPS required over the length of the spinner to receive the full score.
    const maxRps = difficultyRange(d.overallDifficulty, Spinner.COMPLETE_RPM_RANGE) / 60;
    const secondsDuration = this._duration / 1000;
    // Allow a 0.1ms floating point precision error in the calculation of the duration.
    const durationError = 0.0001;
    this.spinsRequired = Math.trunc(minRps * secondsDuration + durationError);
    this.maximumBonusSpins = Math.max(0, Math.trunc(maxRps * secondsDuration + durationError) - this.spinsRequired - Spinner.BONUS_SPINS_GAP);
  }

  protected createNestedHitObjects(): void {
    this.nested = [];
    this.ticks = [];
    const totalSpins = this.maximumBonusSpins + this.spinsRequired + Spinner.BONUS_SPINS_GAP;
    for (let i = 0; i < totalSpins; i++) {
      const startTime = this.startTime + (Math.fround((i + 1) / totalSpins)) * this._duration;
      const tick = i < this.spinsRequiredForBonus ? new SpinnerTick() : new SpinnerBonusTick();
      tick.startTime = startTime;
      tick.spinnerDuration = this._duration;
      tick.position = { ...this.position };
      if (tick instanceof SpinnerBonusTick) {
        const ref = this.samples[0];
        tick.samples = ref ? [ref.with({ name: 'spinnerbonus' })] : [];
      }
      this.ticks.push(tick);
      this.nested.push(tick);
    }
  }

  get spinningSamples(): HitSampleInfo[] {
    const ref = this.samples[0];
    return ref ? [ref.with({ name: 'spinnerspin' })] : [];
  }
}

export const isCircleLike = (h: OsuHitObject): h is HitCircle => h.kind === 'circle' || h.kind === 'sliderHead';
