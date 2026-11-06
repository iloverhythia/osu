// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game.Rulesets.Catch/UI/DrawableCatchRuleset.cs, CatchPlayfield.cs (layer order), CatchPlayfieldAdjustmentContainer.cs,
// CatcherArea.cs, Catcher.cs (plate / dropping / explosions), CatcherTrailDisplay.cs, CatcherTrail.cs,
// CatchTouchInputMapper.cs, Objects/Drawables/* (falling, judgement on catch), Mods/CatchModHidden.cs,
// Mods/CatchModFlashlight.cs and Mods/CatchModRelax.cs (mouse controls the catcher).

import type { DrawableRuleset, GameplayContext } from '../Ruleset';
import type { RGB } from '../../Skin';
import { isHit } from '../../scoring/HitResult';
import type { JudgementResult } from '../../scoring/Judgement';
import { CatchAutoGenerator } from './CatchAutoGenerator';
import { CATCHER_BASE_SIZE, CatcherState, HYPER_DASH_TRANSITION_DURATION } from './CatcherLogic';
import type { CatchPlayableBeatmap } from './CatchPlayable';
import {
  Banana,
  Droplet,
  getTimeRange,
  OBJECT_RADIUS,
  PalpableCatchHitObject,
  PLAYFIELD_WIDTH,
  statelessNextSingle,
  TinyDroplet,
  type CatchHitObject,
} from './objects';
import { drawBanana, drawCatcherPlate, drawDroplet, drawFruit, drawHitExplosion, HYPER_DASH_COLOUR, type PieceParams } from './pieces';
import { CatchLegacySkinRenderer, type CatcherAnimationState } from './legacySkin';
import { skinComboColour } from '../../skinning/SkinSource';
import { normaliseComboColour } from '../../skinning/HSPAColour';

/** Height of the falling area in playfield units: stable fruits fall from y = -100 down to the catcher at y = 340. */
const FALL_HEIGHT = 440;

const enum PieceKind {
  Fruit,
  Droplet,
  TinyDroplet,
  Banana,
}

const enum JudgeState {
  Pending,
  Hit,
  Miss,
}

const outQuint = (t: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 5);
const inSine = (t: number) => 1 - Math.cos((Math.min(1, Math.max(0, t)) * Math.PI) / 2);
const outSine = (t: number) => Math.sin((Math.min(1, Math.max(0, t)) * Math.PI) / 2);
const inQuad = (t: number) => Math.min(1, Math.max(0, t)) ** 2;

class PalpableEntry {
  state = JudgeState.Pending;
  judgedAt = 0;
  readonly kind: PieceKind;
  readonly colour: RGB;
  /** Fruit: fixed rotation; droplet: start rotation; banana: start angle. */
  readonly rotation: number;
  readonly endAngle: number;
  readonly startScale: number;
  readonly layerSpeed: number;
  readonly seed: number;
  /** Start of the object's lifetime (StartTime - TimePreempt). */
  readonly lifetimeStart: number;

  constructor(
    readonly obj: PalpableCatchHitObject,
    ctx: GameplayContext,
  ) {
    const seed = obj.randomSeed;
    this.seed = seed;
    this.lifetimeStart = obj.startTime - obj.timePreempt;
    const r = (series: number) => statelessNextSingle(seed, series);
    if (obj instanceof Banana) {
      this.kind = PieceKind.Banana;
      this.colour = obj.bananaColour;
      // DrawableBanana.UpdateInitialTransforms
      this.startScale = 0.6 + 1.6 * r(3);
      this.rotation = 180 * (r(1) * 2 - 1);
      this.endAngle = 180 * (r(2) * 2 - 1);
      // ArgonBananaPiece is an ArgonFruitPiece: rotationRandomness = RNG.NextSingle(0.2f, 1) * (RNG.NextBool() ? -1 : 1)
      this.layerSpeed = (0.2 + 0.8 * r(5)) * (r(6) < 0.5 ? -1 : 1);
    } else {
      this.kind = obj instanceof TinyDroplet ? PieceKind.TinyDroplet : obj instanceof Droplet ? PieceKind.Droplet : PieceKind.Fruit;
      // PalpableCatchHitObject.GetComboColour: IndexInBeatmap + 1
      this.colour = normaliseComboColour(skinComboColour(ctx.skin, obj.indexInBeatmap + 1));
      this.startScale = 1;
      this.endAngle = 0;
      if (this.kind === PieceKind.Fruit) {
        this.rotation = (r(1) - 0.5) * 40; // DrawableFruit
        this.layerSpeed = (0.2 + 0.8 * r(5)) * (r(6) < 0.5 ? -1 : 1);
      } else {
        this.rotation = r(1) * 20; // DrawableDroplet startRotation
        this.layerSpeed = 0.2 + 0.8 * r(5);
      }
    }
  }
}

interface JudgeEntry {
  time: number;
  palpable: PalpableEntry | null;
  object: CatchHitObject;
}

interface CaughtObject {
  entry: PalpableEntry;
  /** Position relative to the plate (playfield units). */
  x: number;
  y: number;
  /** Displayed radius in playfield units (already includes caught_fruit_scale_adjust). */
  radius: number;
  rotation: number;
  spawnTime: number;
}

interface DroppedObject {
  entry: PalpableEntry;
  x: number;
  y: number;
  radius: number;
  rotation: number;
  spawnTime: number;
  startTime: number;
  explode: boolean;
  /** Explode: horizontal travel over 1000ms. */
  dx: number;
}

const enum TrailKind {
  Dashing,
  HyperDashing,
  HyperDashAfterImage,
}

interface Trail {
  time: number;
  x: number;
  kind: TrailKind;
  /** Catcher animation state and direction when the trail was created (CatcherTrailEntry), for legacy catcher sprites. */
  state?: CatcherAnimationState;
  direction?: number;
}

interface Explosion {
  time: number;
  /** Offset from the catcher in playfield units. */
  x: number;
  colour: RGB;
  tall: boolean;
  objectScale: number;
  comboScale: number;
}

const enum TouchAction {
  MoveLeft,
  MoveRight,
  DashLeft,
  DashRight,
}

interface Layout {
  width: number;
  height: number;
  /** Game units -> px (DrawSizePreservingFillContainer at 1024x768). */
  u: number;
  /** Playfield units -> px. */
  k: number;
  ox: number;
  oy: number;
  clipTop: number;
  clipBottom: number;
  clipLeft: number;
  clipRight: number;
}

export class DrawableCatchRuleset implements DrawableRuleset {
  readonly drawsCursor = true;
  readonly leadInTime = 2000;

  private readonly catcher: CatcherState;
  private readonly timeRange: number;
  private readonly judgeQueue: JudgeEntry[] = [];
  private nextJudge = 0;
  private readonly renderEntries: PalpableEntry[] = [];
  private firstAlive = 0;
  private lastRenderTime = -Infinity;

  private readonly autoplay: CatchAutoGenerator | null;
  private readonly relax: boolean;
  private readonly hidden: boolean;
  private readonly flashlight: boolean;
  private readonly catchFruitOnPlate: boolean;
  private readonly hitLighting: boolean;
  private readonly positionalHitsoundsLevel: number;
  private readonly touchZoneWidth: number;

  private catcherTime = -Infinity;
  private lastUpdateTime = -Infinity;
  private started = false;

  // Input state
  private keyLeft = false;
  private keyRight = false;
  private keyDash = false;
  private readonly touches = new Map<number, TouchAction>();
  private touchZonesVisible = false;
  private touchZonesFadeTime = -Infinity;
  private pointerPlayfieldX: number | null = null;

  // Visual state
  private readonly caught: CaughtObject[] = [];
  private readonly dropped: DroppedObject[] = [];
  private readonly trails: Trail[] = [];
  private readonly explosions: Explosion[] = [];
  private lastHyperDashState = false;
  private hyperColourFrom = 0;
  private hyperColourTo = 0;
  private hyperColourStart = -Infinity;
  private flashlightSize = 0;
  private flashlightFrom = 0;
  private flashlightTarget = 0;
  private flashlightStart = 0;
  private flashlightDuration = 0;
  private layout: Layout | null = null;
  private readonly piece: PieceParams = {
    x: 0,
    y: 0,
    radius: 0,
    rotation: 0,
    colour: [255, 255, 255],
    hyper: false,
    alpha: 1,
    seed: 0,
    layerRotation: 0,
  };
  /** Legacy skin renderer (when a user / beatmap skin is in use). */
  private readonly legacy: CatchLegacySkinRenderer | null;
  /** Catcher.CurrentState (CatcherAnimationState), only used for legacy catcher sprites. */
  private catcherAnimationState: CatcherAnimationState = 'idle';
  private catcherAnimationStateTime = 0;
  private readonly hyperDashColour: RGB;
  private readonly hyperDashAfterImageColour: RGB;

  constructor(
    private readonly playable: CatchPlayableBeatmap,
    private readonly ctx: GameplayContext,
  ) {
    const difficulty = playable.difficulty;
    this.catcher = new CatcherState(difficulty.circleSize);
    this.timeRange = getTimeRange(difficulty.approachRate);

    const mods = ctx.mods;
    this.relax = mods.has('RX') && !ctx.autoplay;
    this.hidden = mods.has('HD');
    this.flashlight = mods.has('FL');
    this.catchFruitOnPlate = !this.hidden;
    this.hitLighting = ctx.settings.get('fruits.hitLighting', true);
    this.positionalHitsoundsLevel = ctx.settings.get('fruits.positionalHitsoundsLevel', 0.2);
    this.touchZoneWidth = Math.min(0.5, Math.max(0.05, ctx.settings.get('fruits.touchZoneWidth', TOUCH_ZONE_WIDTH)));
    this.autoplay = ctx.autoplay ? new CatchAutoGenerator(playable.hitObjects, difficulty.circleSize) : null;
    this.legacy = ctx.skin.sources && ctx.skin.sources.length > 0 ? new CatchLegacySkinRenderer(ctx.skin.sources) : null;
    this.hyperDashColour = this.legacy?.hyperDashColour ?? HYPER_DASH_COLOUR;
    this.hyperDashAfterImageColour = this.legacy?.hyperDashAfterImageColour ?? HYPER_DASH_COLOUR;

    // Judgement order: nested objects before their parent (DrawableHitObject.UpdateResult in UpdateAfterChildren), then by time.
    const entryFor = new Map<PalpableCatchHitObject, PalpableEntry>();
    const visit = (h: CatchHitObject) => {
      for (const n of h.nested) visit(n);
      if (h instanceof PalpableCatchHitObject) {
        const e = new PalpableEntry(h, ctx);
        entryFor.set(h, e);
        this.judgeQueue.push({ time: h.startTime, palpable: e, object: h });
      } else this.judgeQueue.push({ time: h.endTime, palpable: null, object: h });
    };
    for (const h of playable.hitObjects) visit(h);
    this.judgeQueue.sort((a, b) => a.time - b.time);

    for (const e of entryFor.values()) this.renderEntries.push(e);
    this.renderEntries.sort((a, b) => a.obj.startTime - b.obj.startTime);

    this.flashlightSize = this.flashlightTarget = this.getFlashlightSize(0, -Infinity);
  }

  get hasCompleted(): boolean {
    return this.nextJudge >= this.judgeQueue.length;
  }

  // -------------------------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------------------------

  private get keyboardEnabled(): boolean {
    return !this.autoplay && !this.relax;
  }

  private get direction(): number {
    let left = this.keyLeft;
    let right = this.keyRight;
    for (const a of this.touches.values()) {
      if (a === TouchAction.MoveLeft || a === TouchAction.DashLeft) left = true;
      if (a === TouchAction.MoveRight || a === TouchAction.DashRight) right = true;
    }
    return (right ? 1 : 0) - (left ? 1 : 0);
  }

  private get dashHeld(): boolean {
    if (this.keyDash) return true;
    for (const a of this.touches.values()) if (a === TouchAction.DashLeft || a === TouchAction.DashRight) return true;
    return false;
  }

  /**
   * Input events carry their own (gameplay) timestamp; gameplay is advanced to it before applying the input so that
   * movement starts exactly when the key was pressed. Guarded against timestamps far ahead of the last frame.
   */
  private advanceToInput(time: number): void {
    this.advance(Math.min(time, this.lastUpdateTime + MAX_INPUT_LOOKAHEAD));
  }

  onPressed(action: string, time: number): void {
    if (!this.keyboardEnabled) return;
    this.advanceToInput(time);
    this.setAction(action, true);
  }

  onReleased(action: string, time: number): void {
    if (!this.keyboardEnabled) return;
    this.advanceToInput(time);
    this.setAction(action, false);
  }

  private setAction(action: string, pressed: boolean): void {
    if (action === 'MoveLeft') this.keyLeft = pressed;
    else if (action === 'MoveRight') this.keyRight = pressed;
    else if (action === 'Dash') this.keyDash = pressed;
    else return;
    // CatchTouchInputMapper.OnKeyDown: hide whenever the keyboard is used.
    if (pressed && this.touches.size === 0 && action !== 'Dash') this.setTouchZonesVisible(false, time0(this.catcherTime));
  }

  onPointerMove(x: number, _y: number, time: number): void {
    if (!this.relax || !this.layout) return;
    this.advanceToInput(time);
    this.pointerPlayfieldX = (x - this.layout.ox) / this.layout.k;
  }

  onTouchStart(id: number, x: number, y: number, time: number): void {
    if (this.relax) return this.onPointerMove(x, y, time);
    if (this.autoplay) return;
    this.advanceToInput(time);
    this.updateTouch(id, this.touchActionAt(x, y), time);
  }

  onTouchMove(id: number, x: number, y: number, time: number): void {
    if (this.relax) return this.onPointerMove(x, y, time);
    if (this.autoplay) return;
    this.advanceToInput(time);
    this.updateTouch(id, this.touchActionAt(x, y), time);
  }

  onTouchEnd(id: number, _x: number, _y: number, time: number): void {
    if (this.relax || this.autoplay) return;
    this.advanceToInput(time);
    this.updateTouch(id, null, time);
  }

  /** CatchTouchInputMapper.updateAction */
  private updateTouch(id: number, action: TouchAction | null, time: number): void {
    const before = this.touches.get(id) ?? null;
    if (before !== action) {
      if (action != null) this.touches.set(id, action);
      else this.touches.delete(id);
    }
    this.setTouchZonesVisible(true, time);
  }

  private setTouchZonesVisible(visible: boolean, time: number): void {
    if (this.touchZonesVisible === visible) return;
    this.touchZonesVisible = visible;
    this.touchZonesFadeTime = time;
  }

  /** CatchTouchInputMapper.getTouchCatchActionFromInput: 15% wide columns (by default) at each side, dash on the upper 55%. */
  private touchActionAt(x: number, y: number): TouchAction | null {
    const l = this.layout;
    if (!l) return null;
    const zoneWidth = l.width * this.touchZoneWidth;
    const dashBottom = l.height * (1 - TOUCH_NORMAL_AREA_HEIGHT_RATIO);
    if (x <= zoneWidth) return y < dashBottom ? TouchAction.DashLeft : TouchAction.MoveLeft;
    if (x >= l.width - zoneWidth) return y < dashBottom ? TouchAction.DashRight : TouchAction.MoveRight;
    return null;
  }

  // -------------------------------------------------------------------------------------------
  // Gameplay
  // -------------------------------------------------------------------------------------------

  update(time: number, _elapsed: number): void {
    if (!this.started) {
      this.started = true;
      this.catcherTime = time;
    }

    if (this.keyboardEnabled) {
      // Pick up actions the player reports as held but whose press event we did not receive
      // (e.g. a key held down before gameplay started). Releases always arrive through onReleased.
      if (!this.keyLeft && this.ctx.isPressed('MoveLeft')) this.keyLeft = true;
      if (!this.keyRight && this.ctx.isPressed('MoveRight')) this.keyRight = true;
      if (!this.keyDash && this.ctx.isPressed('Dash')) this.keyDash = true;
    }

    this.lastUpdateTime = time;
    this.advance(time);
    this.updateAfterFrame(time);
  }

  /**
   * Advances the catcher to `target`, judging every object whose time is reached on the way. Movement is integrated
   * piecewise up to each object's time, which matches lazer's behaviour at a high update rate regardless of the
   * display's frame rate.
   */
  private advance(target: number): void {
    if (!this.started) return;
    while (this.nextJudge < this.judgeQueue.length && this.judgeQueue[this.nextJudge].time <= target) {
      const e = this.judgeQueue[this.nextJudge++];
      this.moveCatcherTo(Math.max(this.catcherTime, e.time));
      this.judge(e, Math.max(this.catcherTime, e.time));
    }
    this.moveCatcherTo(target);
  }

  private moveCatcherTo(time: number): void {
    const elapsed = time - this.catcherTime;
    if (elapsed < 0) return;

    if (this.autoplay) {
      // CatchFramedReplayInputHandler: replay frames drive the catcher position directly.
      this.catcher.dashing = this.autoplay.dashingAt(time);
      this.catcher.setPosition(this.autoplay.positionAt(time));
      this.catcher.correctOvershoot();
    } else if (this.relax) {
      this.catcher.dashing = false;
      if (this.pointerPlayfieldX != null) this.catcher.setPosition(this.pointerPlayfieldX);
      this.catcher.correctOvershoot();
    } else {
      this.catcher.dashing = this.dashHeld;
      this.catcher.move(this.direction, elapsed);
    }

    this.catcherTime = time;
  }

  private judge(e: JudgeEntry, time: number): void {
    const obj = e.object;
    const j = obj.judgement;

    // DrawableCatchHitObject.CheckForResult: catchable objects are judged by the catcher position, the rest
    // (juice streams / banana showers) can never be "caught" and receive their minimum (ignore) result.
    const caught = e.palpable != null && this.catcher.canCatch(obj);
    const type = caught ? j.maxResult : j.minResult;

    const result: JudgementResult = {
      hitObject: obj,
      judgement: j,
      type,
      timeOffset: 0,
      objectEndTime: obj.endTime,
      newCombo: obj.newCombo,
      lastInCombo: obj.lastInCombo,
      position: { x: obj.effectiveX, y: obj.legacyConvertedY },
    };
    this.ctx.applyResult(result);

    const entry = e.palpable;
    if (!entry) return;

    entry.state = caught ? JudgeState.Hit : JudgeState.Miss;
    entry.judgedAt = time;

    if (caught && obj.samples.length > 0) {
      // DrawableHitObject.CalculateSamplePlaybackBalance with SamplePlaybackPosition = EffectiveX / WIDTH
      const pan = Math.round(this.positionalHitsoundsLevel * 2 * (obj.effectiveX / PLAYFIELD_WIDTH - 0.5) * 100) / 100;
      // DrawableBanana: each successive banana in a shower is pitched up slightly.
      const rate = obj instanceof Banana ? 0.77 + obj.bananaIndex * 0.006 : 1;
      this.ctx.playSamples(obj.samples, { pan, rate });
    }

    this.onNewResult(entry, result, time);
  }

  /** Catcher.OnNewResult */
  private onNewResult(entry: PalpableEntry, result: JudgementResult, time: number): void {
    const hitObject = entry.obj;
    const hit = isHit(result.type);

    if (hit) {
      const diameter = this.displayDiameter(entry, time);
      const pos = this.computePositionInStack(hitObject.effectiveX - this.catcher.x, diameter);

      if (this.catchFruitOnPlate) this.placeCaughtObject(entry, pos.x, pos.y, diameter, time);

      if (this.hitLighting) {
        const combo = result.comboAfterJudgement ?? this.ctx.combo;
        this.explosions.push({
          time,
          x: pos.x,
          colour: entry.colour,
          tall: !(hitObject instanceof Droplet),
          objectScale: hitObject.scale,
          comboScale: Math.min(1.125, Math.max(0.35, combo / 200)),
        });
      }
    }

    if (hitObject.lastInCombo) {
      // CatchJudgement.ShouldExplodeFor: IsHit (bananas always explode).
      if (hit || hitObject instanceof Banana) this.clearPlate(true, time);
      else this.clearPlate(false, time);
    }

    this.catcher.onPalpableResult(hitObject, hit, time);

    // Catcher.OnNewResult: the catcher's animation state (droplets don't affect it).
    if (!(hitObject instanceof TinyDroplet)) {
      const state: CatcherAnimationState | null = hit ? (hitObject.kiai ? 'kiai' : 'idle') : hitObject instanceof Banana ? null : 'fail';
      if (state && state !== this.catcherAnimationState) {
        this.catcherAnimationState = state;
        this.catcherAnimationStateTime = time;
      }
    }
  }

  /** Catcher.computePositionInStack */
  private computePositionInStack(x: number, displayDiameter: number): { x: number; y: number } {
    // this is taken from osu-stable (lenience should be 10 * 10 at standard scale).
    const lenienceAdjust = 10 / OBJECT_RADIUS;
    const adjustedRadius = displayDiameter * lenienceAdjust;
    const checkDistance = adjustedRadius * adjustedRadius;
    let y = 0;

    const overlaps = () => {
      for (const c of this.caught) if ((c.x - x) ** 2 + (c.y - y) ** 2 < checkDistance) return true;
      return false;
    };

    for (let guard = 0; guard < 1000 && overlaps(); guard++) {
      x += -adjustedRadius + Math.random() * 2 * adjustedRadius;
      y -= Math.random() * 5;
    }

    return { x, y };
  }

  private placeCaughtObject(entry: PalpableEntry, x: number, y: number, diameter: number, time: number): void {
    // caught_fruit_scale_adjust = 0.5
    const c: CaughtObject = {
      entry,
      x,
      y,
      radius: (diameter / 2) * 0.5,
      rotation: this.displayRotation(entry, time),
      spawnTime: time,
    };
    // CaughtDroplet.StaysOnPlate == false
    if (entry.obj instanceof Droplet) this.dropObject(c, true, time);
    else this.caught.push(c);
  }

  private clearPlate(explode: boolean, time: number): void {
    for (const c of this.caught) this.dropObject(c, explode, time);
    this.caught.length = 0;
  }

  /** Catcher.getDroppedObject + applyDropAnimation */
  private dropObject(c: CaughtObject, explode: boolean, time: number): void {
    const plateY = FALL_HEIGHT - 5 * this.catcher.scale;
    this.dropped.push({
      entry: c.entry,
      x: this.catcher.x + c.x,
      y: plateY + c.y,
      radius: c.radius,
      rotation: c.rotation,
      spawnTime: c.spawnTime,
      startTime: time,
      explode,
      dx: (c.x / this.catcher.scale) * 6,
    });
  }

  private displayFactor(entry: PalpableEntry, time: number): number {
    switch (entry.kind) {
      case PieceKind.TinyDroplet:
        return 0.5;
      case PieceKind.Banana:
        return entry.startScale + (0.6 - entry.startScale) * this.bananaProgress(entry, time);
      default:
        return 1;
    }
  }

  private displayDiameter(entry: PalpableEntry, time: number): number {
    return OBJECT_RADIUS * 2 * entry.obj.scale * this.displayFactor(entry, time);
  }

  private bananaProgress(entry: PalpableEntry, time: number): number {
    let p = (time - entry.lifetimeStart) / entry.obj.timePreempt;
    // Clamp scale and rotation at the point of bananas being caught, else let them freely extrapolate.
    if (entry.state === JudgeState.Hit) p = Math.min(1, p);
    return p;
  }

  private displayRotation(entry: PalpableEntry, time: number): number {
    switch (entry.kind) {
      case PieceKind.Fruit:
        return entry.rotation;
      case PieceKind.Banana:
        return entry.rotation + (entry.endAngle - entry.rotation) * this.bananaProgress(entry, time);
      default: {
        // No clamping for droplets. They should be considered indefinitely spinning regardless of time.
        const p = (time - entry.lifetimeStart) / (entry.obj.timePreempt + 2000);
        return entry.rotation + 720 * p;
      }
    }
  }

  /** CatcherArea.UpdateAfterChildren (trails) + hyper-dash colour transitions + flashlight size. */
  private updateAfterFrame(time: number): void {
    const hyper = this.catcher.hyperDashing;

    if (hyper !== this.lastHyperDashState) {
      // Catcher.runHyperDashStateTransition
      this.hyperColourFrom = this.hyperColourValue(time);
      this.hyperColourTo = hyper ? 1 : 0;
      this.hyperColourStart = time;
    }

    if (!this.lastHyperDashState && hyper)
      this.trails.push({
        time,
        x: this.catcher.x,
        kind: TrailKind.HyperDashAfterImage,
        state: this.catcherAnimationState,
        direction: this.catcher.visualDirection,
      });

    if (this.catcher.dashing || hyper) {
      const TRAIL_GENERATION_INTERVAL = 16;
      let lastDashTrailTime = -Infinity;
      for (const t of this.trails) if (t.kind !== TrailKind.HyperDashAfterImage && t.time > lastDashTrailTime) lastDashTrailTime = t.time;
      if (time - lastDashTrailTime >= TRAIL_GENERATION_INTERVAL)
        this.trails.push({
          time,
          x: this.catcher.x,
          kind: hyper ? TrailKind.HyperDashing : TrailKind.Dashing,
          state: this.catcherAnimationState,
          direction: this.catcher.visualDirection,
        });
    }

    this.lastHyperDashState = hyper;

    // expire visuals
    compact(this.trails, t => time - t.time < (t.kind === TrailKind.HyperDashAfterImage ? 1200 : 800) && t.time <= time);
    compact(this.dropped, d => time - d.startTime < 1000 && d.startTime <= time);
    compact(this.explosions, e => time - e.time < 400 && e.time <= time);

    if (this.flashlight) this.updateFlashlight(time);
  }

  private hyperColourValue(time: number): number {
    const t = (time - this.hyperColourStart) / HYPER_DASH_TRANSITION_DURATION;
    return this.hyperColourFrom + (this.hyperColourTo - this.hyperColourFrom) * outQuint(t);
  }

  // -------------------------------------------------------------------------------------------
  // Flashlight (CatchModFlashlight)
  // -------------------------------------------------------------------------------------------

  private isBreakTime(time: number): boolean {
    for (const b of this.playable.breaks) if (time >= b.startTime && time <= b.endTime) return true;
    return false;
  }

  private getFlashlightSize(combo: number, time: number): number {
    const DEFAULT_FLASHLIGHT_SIZE = 203.125;
    const sizeMultiplier = this.ctx.settings.get('fruits.flashlightSizeMultiplier', 1);
    let size = DEFAULT_FLASHLIGHT_SIZE * sizeMultiplier;
    if (this.isBreakTime(time))
      size *= 1.538; // ≈ 8.0 / 5.2
    else if (combo >= 200)
      size *= 0.77; // ≈ 4.0 / 5.2
    else if (combo >= 100) size *= 0.885; // ≈ 4.6 / 5.2
    return size;
  }

  private updateFlashlight(time: number): void {
    const target = this.getFlashlightSize(this.ctx.combo, time);
    if (target !== this.flashlightTarget) {
      // CatchFlashlight.UpdateFlashlightSize: stable's animation speed is 0.1 "units" per frame at 60 fps.
      const SCALE_ANIMATION_SPEED = 1.154 / 1000;
      this.flashlightFrom = this.flashlightSize;
      this.flashlightTarget = target;
      this.flashlightStart = time;
      this.flashlightDuration = Math.abs(this.flashlightSize - target) / 203.125 / SCALE_ANIMATION_SPEED;
    }
    const t = this.flashlightDuration > 0 ? Math.min(1, (time - this.flashlightStart) / this.flashlightDuration) : 1;
    this.flashlightSize = this.flashlightFrom + (this.flashlightTarget - this.flashlightFrom) * Math.max(0, t);
  }

  // -------------------------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------------------------

  /** CatchPlayfieldAdjustmentContainer layout. */
  private computeLayout(width: number, height: number): Layout {
    const BASE_WIDTH = 1024;
    const BASE_HEIGHT = 768;
    const PLAYFIELD_SIZE_ADJUST = 0.8;
    const EXTRA_BOTTOM_SPACE = 200;

    // The game's ScalingContainer (draw size preserving 1024x768).
    let u = Math.min(width / BASE_WIDTH, height / BASE_HEIGHT);
    // scaleContainer.Scale = Math.Min(1, base_aspect_ratio / aspectRatio), where the aspect ratio is that of
    // OsuGame.ScalingContainerTargetDrawSize (1024x768 on desktop), i.e. 1.
    let aspectScale = 1;
    // Portrait screens (phones): let the playfield use (almost) the full width instead of 80% of a 4:3 area.
    if (height > width) {
      u = Math.min(height / BASE_HEIGHT, (width * 0.98) / (BASE_WIDTH * PLAYFIELD_SIZE_ADJUST));
      aspectScale = 1;
    }
    const s = u * aspectScale;
    const cy = height / 2;

    // "Visible area": RelativeSizeAxes.X, Height = 768 + 200, Y = 100 (masked), scaled around the screen centre.
    const visibleHeight = BASE_HEIGHT + EXTRA_BOTTOM_SPACE;
    const visibleTop = cy + (-(visibleHeight / 2) + EXTRA_BOTTOM_SPACE / 2) * s;
    const visibleWidth = width / u;
    const playableTop = visibleTop + BASE_HEIGHT * ((1 - PLAYFIELD_SIZE_ADJUST) / 4) * 3 * s;
    const playableWidth = BASE_WIDTH * PLAYFIELD_SIZE_ADJUST * s;
    const k = playableWidth / PLAYFIELD_WIDTH;

    return {
      width,
      height,
      u,
      k,
      ox: width / 2 - playableWidth / 2,
      // local y = 0 is stable y = -100
      oy: playableTop - 100 * k,
      clipTop: Math.max(0, visibleTop),
      clipBottom: Math.min(height, visibleTop + visibleHeight * s),
      clipLeft: Math.max(0, width / 2 - (visibleWidth / 2) * s),
      clipRight: Math.min(width, width / 2 + (visibleWidth / 2) * s),
    };
  }

  render(g: CanvasRenderingContext2D, width: number, height: number, time: number): void {
    const l = (this.layout = this.computeLayout(width, height));
    const k = l.k;
    const catcherX = l.ox + this.catcher.x * k;
    const plateY = l.oy + FALL_HEIGHT * k;
    const catcherScale = this.catcher.scale;

    // Catcher.FadeColour(hyperDashColour, HYPER_DASH_TRANSITION_DURATION, OutQuint) while hyper dashing. The colour applies to
    // everything inside the Catcher: the body, the (proxied) caught objects and the hit explosions.
    const hyperT = Math.min(1, Math.max(0, this.hyperColourValue(time)));
    const hc = this.hyperDashColour;
    const catcherColour: RGB = [255 + (hc[0] - 255) * hyperT, 255 + (hc[1] - 255) * hyperT, 255 + (hc[2] - 255) * hyperT];

    g.save();
    g.beginPath();
    g.rect(l.clipLeft, l.clipTop, l.clipRight - l.clipLeft, l.clipBottom - l.clipTop);
    g.clip();

    // DroppedObjectContainer (Catcher.applyDropAnimation)
    for (const d of this.dropped) {
      const el = time - d.startTime;
      let y = d.y;
      let x = d.x;
      if (d.explode) {
        // MoveToY(Y - 50, 250, OutSine).Then().MoveToY(Y + 50, 500, InSine); MoveToX(X + originalX * 6, 1000)
        y = el < 250 ? d.y - 50 * outSine(el / 250) : d.y - 50 + 100 * inSine((el - 250) / 500);
        x = d.x + d.dx * Math.min(1, el / 1000);
      } else y = d.y + 75 * inSine(el / 750); // MoveToY(Y + 75, 750, InSine)
      const alpha = 1 - el / 750; // FadeOut(750)
      if (alpha <= 0) continue;
      this.drawEntry(g, d.entry, l.ox + x * k, l.oy + y * k, d.radius * k, d.rotation, alpha, time - d.spawnTime, time, null, true);
    }

    // Catcher.CreateProxiedContent(): caught objects on the plate (inside the Catcher, so they take its colour)
    const plateBase = FALL_HEIGHT - 5 * catcherScale;
    for (const c of this.caught)
      this.drawEntry(g, c.entry, catcherX + c.x * k, l.oy + (plateBase + c.y) * k, c.radius * k, c.rotation, 1, time - c.spawnTime, time, catcherColour, true);

    // HitObjectContainer proxy: falling objects
    this.renderHitObjects(g, l, time);

    // CatcherArea: catcher (body, then hit explosions), then CatcherTrailDisplay
    const catcherWidthPx = CATCHER_BASE_SIZE * catcherScale * k;
    const legacyCatcher = this.legacy?.has.catcher ? this.legacy : null;
    if (legacyCatcher)
      legacyCatcher.drawCatcher(
        g,
        catcherX,
        plateY,
        k,
        catcherScale,
        this.catcher.visualDirection,
        this.catcherAnimationState,
        time - this.catcherAnimationStateTime,
        catcherColour,
      );
    else drawCatcherPlate(g, catcherX, plateY, catcherWidthPx, catcherScale * k, catcherColour, 1);

    for (const e of this.explosions) {
      // HitExplosionContainer is in catcher space; X = position in stack (playfield units, applied in catcher space)
      const unit = e.objectScale * catcherScale * k;
      drawHitExplosion(g, catcherX + e.x * catcherScale * k, plateY, unit, e.colour, time - e.time, e.tall, e.comboScale, catcherColour);
    }

    // CatcherTrail: Blending = Additive; dash trails (white), hyper dash trails and after-images (hyper dash colours)
    g.globalCompositeOperation = 'lighter';
    for (const kind of TRAIL_ORDER) {
      for (const t of this.trails) {
        if (t.kind !== kind) continue;
        const el = time - t.time;
        const tx = l.ox + t.x * k;
        if (t.kind === TrailKind.HyperDashAfterImage) {
          // MoveToOffset((0, -10), 1200, In); ScaleTo(Scale * 0.95).ScaleTo(Scale * 1.2, 1200, In); FadeOut(1200)
          const p = Math.min(1, el / 1200);
          const s = 0.95 + (1.2 - 0.95) * inQuad(p);
          if (legacyCatcher)
            legacyCatcher.drawCatcher(
              g,
              tx,
              plateY - 10 * inQuad(p) * k,
              k,
              catcherScale * s,
              t.direction ?? 1,
              t.state ?? 'idle',
              0,
              this.hyperDashAfterImageColour,
              1 - p,
              true,
            );
          else drawCatcherPlate(g, tx, plateY - 10 * inQuad(p) * k, catcherWidthPx * s, catcherScale * k * s, this.hyperDashAfterImageColour, 1 - p);
        } else {
          // FadeTo(0.4f).FadeOut(800, OutQuint)
          const alpha = 0.4 * (1 - outQuint(el / 800));
          const colour = t.kind === TrailKind.HyperDashing ? this.hyperDashColour : WHITE;
          if (legacyCatcher) legacyCatcher.drawCatcher(g, tx, plateY, k, catcherScale, t.direction ?? 1, t.state ?? 'idle', 0, colour, alpha, true);
          else drawCatcherPlate(g, tx, plateY, catcherWidthPx, catcherScale * k, colour, alpha);
        }
      }
    }
    g.globalCompositeOperation = 'source-over';

    g.restore();

    if (this.flashlight) this.renderFlashlight(g, l, catcherX, plateY);
    this.renderTouchZones(g, l, time);
  }

  private renderHitObjects(g: CanvasRenderingContext2D, l: Layout, time: number): void {
    const entries = this.renderEntries;
    if (time < this.lastRenderTime) this.firstAlive = 0;
    this.lastRenderTime = time;

    // Missed objects fade out over 250ms after being judged (at their start time).
    while (this.firstAlive < entries.length && entries[this.firstAlive].obj.startTime < time - 300) this.firstAlive++;

    let last = this.firstAlive;
    while (last < entries.length && entries[last].lifetimeStart <= time) last++;

    // Earlier objects are drawn above later ones.
    for (let i = last - 1; i >= this.firstAlive; i--) {
      const e = entries[i];
      if (e.state === JudgeState.Hit) continue;

      let alpha = 1;
      if (e.state === JudgeState.Miss) {
        alpha = 1 - (time - e.judgedAt) / 250;
        if (alpha <= 0) continue;
      }

      if (this.hidden) {
        // CatchModHidden.fadeOutHitObject
        const preempt = e.obj.timePreempt;
        const offset = preempt * 0.6;
        const duration = offset - preempt * 0.44;
        const fadeStart = e.obj.startTime - offset;
        if (time > fadeStart) alpha *= Math.max(0, 1 - (time - fadeStart) / duration);
        if (alpha <= 0) continue;
      }

      // ScrollingHitObjectContainer (constant visualisation, scrolling down)
      const y = FALL_HEIGHT - ((e.obj.startTime - time) / this.timeRange) * FALL_HEIGHT;
      const r = (this.displayDiameter(e, time) / 2) * l.k;
      this.drawEntry(g, e, l.ox + e.obj.effectiveX * l.k, l.oy + y * l.k, r, this.displayRotation(e, time), alpha, time - e.lifetimeStart, time);
    }
  }

  private drawEntry(
    g: CanvasRenderingContext2D,
    e: PalpableEntry,
    x: number,
    y: number,
    radius: number,
    rotation: number,
    alpha: number,
    age: number,
    time: number,
    tint: RGB | null = null,
    caught = false,
  ): void {
    const L = this.legacy;
    if (L) {
      const kind = e.kind === PieceKind.Fruit ? 'fruit' : e.kind === PieceKind.Banana ? 'banana' : 'droplet';
      if (L.has[kind]) {
        L.drawPiece(g, kind, e.obj.indexInBeatmap, x, y, radius, rotation, e.colour, e.obj.hyperDash, alpha);
        return;
      }
    }
    const p = this.piece;
    p.x = x;
    p.y = y;
    p.radius = radius;
    p.rotation = rotation;
    p.colour = e.colour;
    p.hyper = e.obj.hyperDash;
    p.alpha = alpha;
    p.seed = e.seed;
    p.tint = tint ?? WHITE;

    switch (e.kind) {
      case PieceKind.Fruit:
        // ArgonFruitPiece layer rotation: i * 2 * elapsed * 0.02 * randomness
        p.layerRotation = age * 0.02 * e.layerSpeed;
        drawFruit(g, p);
        break;
      case PieceKind.Droplet:
      case PieceKind.TinyDroplet: {
        p.layerRotation = -age * 0.4 * e.layerSpeed;
        // the white core is a 20px circle inside the 128px piece
        drawDroplet(g, p, radius * (10 / 64));
        break;
      }
      case PieceKind.Banana: {
        // ArgonFruitPiece layer rotation, plus the ArgonBananaPiece lens flare: fades out between 30% and 80% of the
        // time on screen. Caught objects have DisplayStartTime == StartTime, so their flare is hidden.
        p.layerRotation = age * 0.02 * e.layerSpeed;
        const duration = e.obj.startTime - e.lifetimeStart;
        const start = e.lifetimeStart + duration * 0.3;
        const end = e.lifetimeStart + duration * 0.8;
        const flare = time <= start ? 1 : 1 - outQuint((time - start) / (end - start));
        drawBanana(g, p, caught ? 0 : flare, (radius * 2) / (OBJECT_RADIUS * 2 * l2(this.layout)));
        break;
      }
    }
  }

  /** CatchFlashlight: circular, smoothness 1.4, centred on the catcher. */
  private renderFlashlight(g: CanvasRenderingContext2D, l: Layout, x: number, y: number): void {
    const r = this.flashlightSize * l.u;
    const outer = r * 1.4;
    const grad = g.createRadialGradient(x, y, r, x, y, outer);
    // smoothstep(r, 1.4r, dist)
    for (let i = 0; i <= 4; i++) {
      const t = i / 4;
      grad.addColorStop(t, `rgba(0,0,0,${t * t * (3 - 2 * t)})`);
    }
    g.save();
    g.fillStyle = grad;
    g.fillRect(0, 0, l.width, l.height);
    g.restore();
  }

  /** CatchTouchInputMapper visuals. */
  private renderTouchZones(g: CanvasRenderingContext2D, l: Layout, time: number): void {
    const fade = outQuint((time - this.touchZonesFadeTime) / 300);
    const alpha = this.touchZonesVisible ? fade : 1 - fade;
    if (alpha <= 0.001 || this.relax) return;

    const zw = l.width * this.touchZoneWidth;
    const dashH = l.height * (1 - TOUCH_NORMAL_AREA_HEIGHT_RATIO);
    const radius = 10 * l.u;
    const zone = (x: number, y: number, w: number, h: number, colour: string, action: TouchAction) => {
      let a = 0.15;
      for (const v of this.touches.values()) if (v === action) a += 0.1;
      g.globalAlpha = alpha * Math.min(1, a);
      g.fillStyle = colour;
      g.beginPath();
      g.roundRect(x, y, w, h, radius);
      g.fill();
    };

    g.save();
    zone(0, 0, zw, dashH, '#ffffff', TouchAction.DashLeft);
    zone(0, dashH, zw, l.height - dashH, '#999999', TouchAction.MoveLeft);
    zone(l.width - zw, 0, zw, dashH, '#ffffff', TouchAction.DashRight);
    zone(l.width - zw, dashH, zw, l.height - dashH, '#999999', TouchAction.MoveRight);
    g.restore();
  }

  dispose(): void {
    this.caught.length = 0;
    this.dropped.length = 0;
    this.trails.length = 0;
    this.explosions.length = 0;
  }

  // -------------------------------------------------------------------------------------------
  // Test helpers
  // -------------------------------------------------------------------------------------------

  /** Current catcher X (playfield units). */
  get catcherX(): number {
    return this.catcher.x;
  }

  get catcherHyperDashing(): boolean {
    return this.catcher.hyperDashing;
  }
}

const WHITE: RGB = [255, 255, 255];

/** CatcherTrailDisplay children order: dashTrails, hyperDashTrails, hyperDashAfterImages. */
const TRAIL_ORDER = [TrailKind.Dashing, TrailKind.HyperDashing, TrailKind.HyperDashAfterImage] as const;

/** Playfield units -> px of a layout (1 before the first render). */
const l2 = (l: Layout | null): number => (l ? l.k : 1);

/** CatchTouchInputMapper: width of the touch columns (relative) and the ratio of the normal (non-dash) area. */
const TOUCH_ZONE_WIDTH = 0.15;
const TOUCH_NORMAL_AREA_HEIGHT_RATIO = 0.45;

/** How far ahead of the last frame an input timestamp may advance gameplay (ms). */
const MAX_INPUT_LOOKAHEAD = 50;

const time0 = (t: number) => (Number.isFinite(t) ? t : 0);

/** In-place filter. */
function compact<T>(arr: T[], keep: (v: T) => boolean): void {
  let j = 0;
  for (let i = 0; i < arr.length; i++) if (keep(arr[i])) arr[j++] = arr[i];
  arr.length = j;
}
