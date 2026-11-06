// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Gameplay for osu! standard. Ports (osu.Game.Rulesets.Osu/):
// - judging: Objects/Drawables/DrawableHitCircle.cs, DrawableSlider.cs, DrawableSliderHead/Tail/Repeat/Tick.cs, SliderInputManager.cs,
//   DrawableSpinner.cs, Skinning/Default/SpinnerRotationTracker.cs, UI/StartTimeOrderedHitPolicy.cs;
// - visuals: the DrawableHitObject state transforms of the drawables above + DrawableOsuHitObject.cs (dim, ApplyRepeatFadeIn),
//   DrawableSliderBall.cs, Skinning/FollowCircle.cs, Skinning/SnakingSliderBody.cs, Objects/Drawables/Connections/FollowPointConnection.cs
//   (+ FollowPointLifetimeEntry.cs / FollowPointRenderer.cs), DrawableOsuJudgement.cs, osu.Game/Graphics/Containers/ShakeContainer.cs,
//   UI/OsuPlayfield.cs (layering), UI/Cursor/OsuCursor.cs, OsuCursorContainer.cs, SkinnableCursor.cs, CursorTrail.cs;
// - the default skin pieces in argon.ts (Skinning/Argon/*);
// - mods in mods.ts (OsuModHidden, OsuModFlashlight, OsuModSpunOut, OsuModRelax, OsuModAutopilot).
// When a legacy skin (.osk / beatmap skin) provides elements, they are drawn by OsuLegacySkinRenderer (legacySkin.ts) instead.

import { HitSampleInfo } from '../../audio/HitSampleInfo';
import { Vec2, clamp, distanceSq } from '../../../framework/math';
import { HitResult, isHit } from '../../scoring/HitResult';
import type { DrawableRuleset, GameplayContext, LoopHandle } from '../Ruleset';
import { DEFAULT_COMBO_COLOURS, RGB } from '../../Skin';
import { applyEasing } from '../../storyboard/Easing';
import type { OsuPlayableBeatmap } from './beatmap';
import { OsuLegacySkinRenderer, type OsuLegacyHost } from './legacySkin';
import { osuPlayfieldTransform } from './playfield';
import { resolveComboColours } from '../../skinning/SkinSource';
import { generateOsuAutoplay } from './OsuAutoGenerator';
import { OsuFlashlight, OsuModAutopilot, OsuModHidden, OsuModRelax, isBreakTime, spunOutRotation, type RelaxPlayfield } from './mods';
import { SpinnerSpinHistory, SpinnerSpmCalculator, spinningSampleFrequency } from './spinner';
import { Colour4, Easing, Prop, fromRgb, valueAt } from './transforms';
import {
  ARGON_COMBO_COLOURS,
  ARGON_PATH_RADIUS,
  createRingExplosion,
  drawApproachCircle,
  drawArgonCursor,
  drawArgonFollowPoint,
  drawArgonSpinner,
  drawFollowCircle,
  drawJudgementText,
  drawMainCirclePiece,
  drawReverseArrow,
  drawRingExplosion,
  drawSliderBall,
  drawSliderScorePoint,
  drawTickMiss,
  drawTrailPart,
  renderArgonSliderPath,
  type ArgonSpinnerState,
  type RingParticle,
} from './argon';
import {
  HitCircle,
  OsuHitObject,
  PLAYFIELD_WIDTH,
  PREEMPT_MIN,
  Slider,
  SliderHeadCircle,
  SliderRepeat,
  SliderTailCircle,
  SliderTick,
  Spinner,
  SpinnerTick,
} from './objects';

/** DrawableSliderBall.FOLLOW_AREA */
const FOLLOW_AREA = 2.4;
/** SliderEventGenerator.TAIL_LENIENCY */
const TAIL_LENIENCY = -36;
/** FollowPointConnection */
const FOLLOW_POINT_SPACING = 32;
const FOLLOW_POINT_PREEMPT = 800;
/** DrawableSpinner.score_per_tick (OsuScoreProcessor base score of a LargeBonus) */
const SPINNER_SCORE_PER_TICK = 50;
/** OsuCursor.SIZE */
const CURSOR_SIZE = 28;
/** Display width of the "Cursor/cursortrail" texture (not shipped; approximation). */
const TRAIL_TEXTURE_WIDTH = 26;
/** DrawableOsuHitObject dim colour (195, 195, 195). */
const DIM = 195 / 255;
/** CursorTrail.FadeDuration */
const TRAIL_FADE_DURATION = 300;

type Action = 'LeftButton' | 'RightButton';

interface JudgeState {
  judged: boolean;
  result: HitResult;
  judgedAt: number;
  /** Incremented on every judgement change (invalidates cached state transforms). */
  version: number;
}

interface SliderState {
  tracking: boolean;
  headHitAction: Action | null;
  timeToAcceptAnyKeyAfter: number | null;
  lastPressedActions: Action[];
  slideLoop: LoopHandle[] | null;
  lastTrackingChange: number;
  /** ArgonFollowCircle transforms (driven by FollowCircle's tracking / nested judgement events). */
  followScale: Prop;
  followAlpha: Prop;
  /** DrawableSlider's ShakeContainer (body, ticks, repeats) X offset. */
  shake: Prop;
  /** DrawableSliderBall ball rotation (degrees). */
  ballRotation: number;
  /** DrawableSliderRepeat arrow rotation (degrees) and the last time it was updated. */
  arrowRotation: Map<SliderRepeat, { rotation: number; time: number }>;
}

interface SpinnerState {
  history: SpinnerSpinHistory;
  /** SpinnerRotationTracker.currentRotation */
  currentRotation: number;
  /** SpinnerRotationTracker.Rotation (damped display rotation) */
  displayRotation: number;
  lastAngle: number | null;
  rotationTransferred: boolean;
  tracking: boolean;
  isSpinning: boolean;
  completedFullSpins: number;
  spm: SpinnerSpmCalculator;
  timeStarted: number | null;
  timeCompleted: number | null;
  spinLoop: LoopHandle | null;
  spinVolume: Prop;
  // ArgonSpinnerDisc / arcs (frame-damped state)
  trackingElementInterpolation: number;
  fillAlpha: number;
  fillFlash: Prop | null;
  fillScale: number;
  wholeRotationCount: number;
  ringArcProgress: number;
  ringArcRadius: number;
  progressFillAlpha: number;
  progressFill: number;
  bonus: { text: string; time: number; max: boolean } | null;
}

interface CircleVis {
  version: number;
  alpha: Prop;
  pieceAlpha: Prop;
  dim: Prop;
  approachAlpha: Prop;
  approachScale: Prop;
  hitTime: number;
  hit: boolean;
}

interface SliderVis {
  version: number;
  alpha: Prop;
  bodyAlpha: Prop;
  dim: Prop;
  ballAlpha: Prop;
  argonBallAlpha: Prop;
  iconScale: Prop;
}

interface TickVis {
  version: number;
  alpha: Prop;
  scale: Prop;
}

interface RepeatVis {
  version: number;
  alpha: Prop;
  arrowAlpha: Prop;
  hitTime: number;
  hit: boolean;
  animDuration: number;
}

interface SpinnerVis {
  version: number;
  alpha: Prop;
  discScale: Prop;
  centreScale: Prop;
  ticksRotation: Prop;
}

interface ShownJudgement {
  result: HitResult;
  time: number;
  x: number;
  y: number;
  scale: number;
  kind: 'argon' | 'tickMiss';
  particles: RingParticle[];
}

interface TrailPart {
  x: number;
  y: number;
  time: number;
  scale: number;
}

/** DrawableSpinner.SpinnerBonusMaxSampleInfo: "spinnerbonus-max", falling back to "spinnerbonus". */
class SpinnerBonusMaxSampleInfo extends HitSampleInfo {
  constructor(sample: HitSampleInfo) {
    super({ name: 'spinnerbonus-max', bank: sample.bankSpecified ? sample.bank : null, volume: sample.volume, customSampleBank: sample.customSampleBank });
  }

  get lookupNames(): string[] {
    const names = super.lookupNames;
    return [...names, ...names.map(n => n.replace('-max', ''))];
  }
}

const outQuint = (t: number) => applyEasing(Easing.OutQuint, t);
const outSine = (t: number) => applyEasing(Easing.OutSine, t);

export class DrawableOsuRuleset implements DrawableRuleset {
  readonly drawsCursor = true;
  readonly objects: OsuHitObject[];

  private judge = new Map<OsuHitObject, JudgeState>();
  private sliderStates = new Map<Slider, SliderState>();
  private spinnerStates = new Map<Spinner, SpinnerState>();
  private parentOf = new Map<OsuHitObject, OsuHitObject>();
  private judgements: ShownJudgement[] = [];

  // cached state transforms
  private circleVis = new Map<HitCircle, CircleVis>();
  private sliderVis = new Map<Slider, SliderVis>();
  private tickVis = new Map<SliderTick, TickVis>();
  private repeatVis = new Map<SliderRepeat, RepeatVis>();
  private spinnerVis = new Map<Spinner, SpinnerVis>();
  private circleShake = new Map<HitCircle, Prop>();

  /** Cursor in osu! playfield coordinates. */
  private cursor: Vec2 = { x: PLAYFIELD_WIDTH / 2, y: 384 / 2 };
  private pressed = new Set<Action>();
  private lastUpdateTime = -Infinity;
  private firstActiveIndex = 0;
  private followPointIndex = 0;
  private touchActions = new Map<number, Action>();

  // Screen transform (updated every render)
  private scale = 1;
  private offsetX = 0;
  private offsetY = 0;

  // Cursor (OsuCursorContainer / OsuCursor / CursorTrail)
  private downCount = 0;
  private cursorExpand = new Prop(1);
  private readonly cursorScale: number;
  private trail: TrailPart[] = [];
  private lastTrailPosition: Vec2 | null = null;

  // Autoplay (a generated replay played through the input path, as lazer's ReplayInputHandler)
  private autoEvents: import('../../replays/Replay').ReplayEvent[] = [];
  private autoEventIndex = 0;
  private autoMoves: { t: number; x: number; y: number }[] = [];

  private readonly hidden: boolean;
  private readonly relax: OsuModRelax | null;
  private readonly autopilot: OsuModAutopilot | null;
  private readonly flashlight: OsuFlashlight | null;
  private readonly spunOut: boolean;
  private readonly firstObject: OsuHitObject | null;
  private readonly increaseFirstObjectVisibility: boolean;
  private readonly showFollowPoints: boolean;
  private readonly showCursorTrail: boolean;
  private readonly hitLighting: boolean;
  private readonly hitAnimations: boolean;
  private readonly snakingIn: boolean;
  private readonly snakingOut: boolean;
  private readonly positionalHitsoundsLevel: number;
  private readonly gameplayStartTime: number;
  /** Combo colours in effect (beatmap, then skin, then the argon defaults). */
  private readonly comboColours: RGB[];
  /** Legacy skin renderer, when a user / beatmap skin is in use. */
  private readonly legacy: OsuLegacySkinRenderer | null = null;

  constructor(
    private readonly playable: OsuPlayableBeatmap,
    private readonly ctx: GameplayContext,
  ) {
    this.objects = playable.hitObjects;
    const mods = ctx.mods;
    const settings = ctx.settings;
    this.hidden = mods.has('HD');
    this.spunOut = mods.has('SO');
    this.relax = mods.has('RX') ? new OsuModRelax() : null;
    this.flashlight = mods.has('FL') ? new OsuFlashlight() : null;
    this.showFollowPoints = settings.get('osu.followPoints', true);
    this.showCursorTrail = settings.get('osu.cursorTrail', true);
    this.hitLighting = settings.get('osu.hitLighting', true);
    this.hitAnimations = settings.get('osu.hitAnimations', true);
    this.snakingIn = settings.get('osu.snakingIn', true);
    this.snakingOut = settings.get('osu.snakingOut', true);
    this.positionalHitsoundsLevel = settings.get('audio.positionalHitsoundsLevel', 0.2);
    this.increaseFirstObjectVisibility = settings.get('gameplay.increaseFirstObjectVisibility', true);

    // OsuCursor.CalculateCursorScale
    let cursorScale = settings.get('osu.cursorSize', 1);
    if (settings.get('osu.autoCursorSize', false)) cursorScale *= 1 - (0.7 * (1 + playable.difficulty.circleSize - 5)) / 5;
    this.cursorScale = cursorScale;

    const colours = resolveComboColours(ctx.skin);
    const usingLegacy = !!ctx.skin.sources && ctx.skin.sources.length > 0;
    this.comboColours = colours === DEFAULT_COMBO_COLOURS && !usingLegacy ? ARGON_COMBO_COLOURS : colours;

    const first = this.objects[0];
    // DrawableOsuRuleset.GameplayStartTime
    this.gameplayStartTime = first ? first.startTime - Math.max(2000, first.timePreempt) : 0;

    const newJudge = (): JudgeState => ({ judged: false, result: HitResult.None, judgedAt: 0, version: 0 });
    for (const h of this.objects) {
      this.judge.set(h, newJudge());
      for (const n of h.nested) {
        this.judge.set(n, newJudge());
        this.parentOf.set(n, h);
      }
      if (h instanceof Slider)
        this.sliderStates.set(h, {
          tracking: false,
          headHitAction: null,
          timeToAcceptAnyKeyAfter: null,
          lastPressedActions: [],
          slideLoop: null,
          lastTrackingChange: -Infinity,
          followScale: new Prop(1),
          followAlpha: new Prop(0),
          shake: new Prop(0),
          ballRotation: 0,
          arrowRotation: new Map(),
        });
      if (h instanceof Spinner)
        this.spinnerStates.set(h, {
          history: new SpinnerSpinHistory(),
          currentRotation: 0,
          displayRotation: 0,
          lastAngle: null,
          rotationTransferred: false,
          tracking: false,
          isSpinning: false,
          completedFullSpins: 0,
          spm: new SpinnerSpmCalculator(),
          timeStarted: null,
          timeCompleted: null,
          spinLoop: null,
          spinVolume: new Prop(0),
          trackingElementInterpolation: 0,
          fillAlpha: 0.2,
          fillFlash: null,
          fillScale: 0.1,
          wholeRotationCount: 0,
          ringArcProgress: 0.31,
          ringArcRadius: 0.02,
          progressFillAlpha: 0,
          progressFill: 0,
          bonus: null,
        });
    }

    // OsuModHidden.ApplyToBeatmap (+ ModWithVisibilityAdjustment's first adjustable object).
    if (this.hidden) OsuModHidden.applyToBeatmap(this.objects);
    this.firstObject = this.hidden ? OsuModHidden.firstAdjustableObject(this.objects) : null;

    // Autoplay / Autopilot follow OsuAutoGenerator's replay.
    if (ctx.autoplay || mods.has('AP')) {
      const replay = generateOsuAutoplay(playable, ctx.rate);
      if (ctx.autoplay) {
        this.autoEvents = replay.events;
        for (const e of replay.events) if (e.k === 'm') this.autoMoves.push({ t: e.t, x: e.x, y: e.y });
      }
      this.autopilot = ctx.autoplay ? null : new OsuModAutopilot(replay);
    } else this.autopilot = null;

    if (usingLegacy) {
      const self = this;
      const host: OsuLegacyHost = {
        judge: h => self.judge.get(h)!,
        sliderTracking: s => self.sliderStates.get(s)!,
        spinner: s => {
          const st = self.spinnerStates.get(s)!;
          return { displayRotation: st.displayRotation, completedFullSpins: st.completedFullSpins, rpm: st.spm.result, progress: self.progress(s, st) };
        },
        comboColour: h => self.comboColour(h),
        hiddenAlpha: (h, time) => self.hiddenAlpha(h, time),
        hidden: this.hidden,
        hitLighting: this.hitLighting,
        snakingIn: this.snakingIn,
        snakingOut: this.snakingOut,
      };
      this.legacy = new OsuLegacySkinRenderer(ctx.skin.sources, host, ctx, playable.source.controlPoints, this.objects);
    }
  }

  get leadInTime(): number {
    return this.objects.length > 0 ? this.objects[0].timePreempt : 0;
  }

  private judgedTopLevel = 0;

  get hasCompleted(): boolean {
    return this.judgedTopLevel >= this.objects.length;
  }

  // ---------------------------------------------------------------- input

  onPressed(action: string, time: number): void {
    if (action !== 'LeftButton' && action !== 'RightButton') return;
    // OsuModRelax: osuInputManager.AllowGameplayInputs = false
    if (this.ctx.autoplay || this.relax) return;
    this.updateTo(time);
    this.press(action, time);
  }

  onReleased(action: string, time: number): void {
    if (action !== 'LeftButton' && action !== 'RightButton') return;
    if (this.ctx.autoplay || this.relax) return;
    this.updateTo(time);
    this.release(action, time);
  }

  onPointerMove(x: number, y: number, time: number): void {
    // OsuModAutopilot: inputManager.AllowUserCursorMovement = false
    if (this.ctx.autoplay || this.autopilot) return;
    this.updateTo(time);
    this.setCursor(this.toPlayfield(x, y));
  }

  onTouchStart(id: number, x: number, y: number, time: number): void {
    if (this.ctx.autoplay) return;
    // OsuTouchInputMapper: first touch moves the cursor; any touch alternates the press action.
    if (this.touchActions.size === 0 || !this.autopilot) this.onPointerMove(x, y, time);
    const action: Action = [...this.touchActions.values()].includes('LeftButton') ? 'RightButton' : 'LeftButton';
    this.touchActions.set(id, action);
    this.onPressed(action, time);
  }

  onTouchMove(id: number, x: number, y: number, time: number): void {
    // Only the most recent touch controls the cursor.
    const ids = [...this.touchActions.keys()];
    if (ids[ids.length - 1] === id) this.onPointerMove(x, y, time);
  }

  onTouchEnd(id: number, _x: number, _y: number, time: number): void {
    const action = this.touchActions.get(id);
    this.touchActions.delete(id);
    if (action) this.onReleased(action, time);
  }

  private toPlayfield(x: number, y: number): Vec2 {
    return { x: (x - this.offsetX) / this.scale, y: (y - this.offsetY) / this.scale };
  }

  private setCursor(p: Vec2): void {
    if (p.x === this.cursor.x && p.y === this.cursor.y) return;
    this.cursor = p;
    this.cursorMoved = true;
    this.addTrail(p);
  }

  /** A gameplay action press (from the user, a replay, autoplay or Relax): KeyBindingContainer → OsuCursorContainer + hit receptors. */
  private press(action: Action, time: number): void {
    if (this.pressed.has(action)) return;
    this.pressed.add(action);
    // OsuCursorContainer.OnPressed
    this.downCount++;
    this.updateExpandedState(time);
    this.handlePress(action, time);
  }

  private release(action: Action, time: number): void {
    if (!this.pressed.delete(action)) return;
    this.downCount = Math.max(0, this.downCount - 1);
    if (this.downCount === 0) this.updateExpandedState(time);
  }

  /** OsuCursorContainer.updateExpandedState → SkinnableCursor.Expand / Contract */
  private updateExpandedState(time: number): void {
    if (this.downCount > 0) {
      // OsuCursor.Expand (CursorExpand skin config, true by default)
      this.cursorExpand.to(time, 1);
      this.cursorExpand.to(time, 1.2, 400, Easing.OutElasticHalf);
    } else this.cursorExpand.to(time, 1, 400, Easing.OutQuad);
  }

  /** Routes a press to the front-most (earliest) hit receptor under the cursor which can still be hit (DrawableHitCircle.HitReceptor). */
  private handlePress(action: Action, time: number): void {
    for (let i = this.firstActiveIndex; i < this.objects.length; i++) {
      const h = this.objects[i];
      if (h.startTime - h.timePreempt > time) break;
      const circle: HitCircle | null = h instanceof HitCircle ? h : h instanceof Slider ? h.headCircle : null;
      if (!circle) continue;
      const st = this.judge.get(circle)!;
      // CanBeHit = !AllJudged
      if (st.judged) continue;
      if (time < circle.startTime - circle.timePreempt) continue;
      if (!this.isHovered(circle)) continue;
      // HitReceptor: Hit(), then HitAction ??= e.Action (set even when the hit was blocked).
      this.tryHitCircle(circle, time);
      if (circle instanceof SliderHeadCircle) {
        const ss = this.sliderStates.get(circle.slider)!;
        ss.headHitAction ??= action;
      }
      return; // input consumed even when the hit was blocked (shake)
    }
  }

  private isHovered(circle: HitCircle): boolean {
    return distanceSq(this.cursor, circle.stackedPosition) <= circle.radius * circle.radius;
  }

  /** DrawableHitCircle.CheckForResult(userTriggered: true) + StartTimeOrderedHitPolicy.CheckHittable */
  private tryHitCircle(circle: HitCircle, time: number): void {
    const timeOffset = time - circle.startTime;
    const result = circle.hitWindows.resultFor(timeOffset);
    const clickAction = this.checkHittable(circle, time, result);
    if (clickAction === 'shake') this.shake(circle, time);
    if (result === HitResult.None || clickAction !== 'hit') return;
    this.applyResult(circle, result, timeOffset);
    if (circle instanceof SliderHeadCircle) this.postProcessHeadJudgement(circle.slider, time);
  }

  /** StartTimeOrderedHitPolicy.CheckHittable */
  private checkHittable(circle: HitCircle, time: number, result: HitResult): 'hit' | 'shake' {
    let blocking: HitCircle | null = null;
    this.forEachCircleUpTo(circle.startTime, c => (blocking = c));
    const b = blocking as HitCircle | null;
    // A hit is disallowed if the last blocking hitobject has not yet been judged and the current time is before its start time.
    if (b && !this.judge.get(b)!.judged && time < b.startTime) return 'shake';
    // Generally when the user has hit way too early.
    if (result === HitResult.None) return 'shake';
    return 'hit';
  }

  /** StartTimeOrderedHitPolicy.HandleHit: miss all hitobjects prior to the hit one. */
  private handleHit(circle: HitCircle, time: number): void {
    this.forEachCircleUpTo(circle.startTime, c => {
      const s = this.judge.get(c)!;
      if (!s.judged) this.applyResult(c, HitResult.Miss, time - c.startTime);
    });
  }

  private forEachCircleUpTo(targetTime: number, fn: (c: HitCircle) => void): void {
    for (let i = this.firstActiveIndex; i < this.objects.length; i++) {
      const h = this.objects[i];
      if (h.startTime >= targetTime) break;
      if (h instanceof HitCircle) fn(h);
      else if (h instanceof Slider && h.headCircle.startTime < targetTime) fn(h.headCircle);
    }
  }

  /** DrawableHitCircle.Shake (ShakeContainer, ShakeDuration = 30); slider heads also shake the slider. */
  private shake(circle: HitCircle, time: number): void {
    let prop = this.circleShake.get(circle);
    if (!prop) this.circleShake.set(circle, (prop = new Prop(0)));
    applyShake(prop, time);
    if (circle instanceof SliderHeadCircle) applyShake(this.sliderStates.get(circle.slider)!.shake, time);
  }

  // ---------------------------------------------------------------- judging

  private applyResult(h: OsuHitObject, type: HitResult, timeOffset: number): void {
    const s = this.judge.get(h)!;
    if (s.judged) return;
    s.judged = true;
    s.result = type;
    s.judgedAt = h.endTime + timeOffset;
    s.version++;
    const parent = this.parentOf.get(h) ?? null;
    if (!parent) this.judgedTopLevel++;

    // Pending state transforms of the ShakeContainers are cleared by DrawableHitObject.UpdateState.
    if (h instanceof HitCircle) this.circleShake.get(h)?.clear(0);
    if (h instanceof Slider) this.sliderStates.get(h)!.shake.clear(0);

    const top = parent ?? h;
    this.ctx.applyResult({
      hitObject: h,
      judgement: h.judgement,
      type,
      timeOffset,
      objectEndTime: h.endTime,
      tag: h.kind,
      newCombo: top.newCombo,
      lastInCombo: top.lastInCombo,
      position: h.stackedPosition,
    });

    // OsuPlayfield.onNewResult → hitPolicy.HandleHit
    if (h instanceof HitCircle && !(h instanceof SliderRepeat || h instanceof SliderTailCircle)) this.handleHit(h, s.judgedAt);

    // DrawableHitObject.UpdateState → PlaySamples() on hit.
    if (isHit(type)) this.playObjectSamples(h);

    const slider = parent instanceof Slider ? parent : null;
    if (slider && isHit(type)) {
      // FollowCircle.updateStateTransforms (nested hit)
      const ss = this.sliderStates.get(slider)!;
      if (h instanceof SliderTailCircle) followOnSliderEnd(ss, this.hitStateUpdateTime(slider));
      else if (h instanceof SliderTick || h instanceof SliderRepeat) followOnSliderTick(ss, s.judgedAt);
    }

    // Legacy skin judgements (DrawableOsuJudgement), slider follow circle reactions and hit lighting.
    if (this.legacy) {
      this.legacy.onResult(h, type, s.judgedAt, slider);
      const displayed = !(h instanceof Slider) && !(h instanceof SpinnerTick);
      if (displayed && this.legacy.handlesJudgement(type)) return;
    }
    this.showJudgement(h, type, s.judgedAt);
  }

  /** OsuPlayfield.onNewResult → DrawableOsuJudgement (argon judgement pieces). */
  private showJudgement(h: OsuHitObject, type: HitResult, time: number): void {
    // DisplayResult: sliders (non-classic) and spinner ticks don't display results.
    if (h instanceof Slider || h instanceof SpinnerTick) return;
    let kind: ShownJudgement['kind'];
    switch (type) {
      case HitResult.Great:
      case HitResult.Ok:
      case HitResult.Meh:
      case HitResult.Miss:
        kind = 'argon';
        break;
      case HitResult.LargeTickMiss:
      case HitResult.IgnoreMiss:
        kind = 'tickMiss';
        break;
      default:
        // LargeTickHit / SliderTailHit: tick hits don't show a judgement; other results aren't pooled.
        return;
    }
    const p = h instanceof Spinner ? h.position : h.stackedPosition;
    this.judgements.push({ result: type, time, x: p.x, y: p.y, scale: h.scale, kind, particles: kind === 'argon' && isHit(type) ? createRingExplosion(type) : [] });
  }

  /** DrawableHitObject.CalculateSamplePlaybackBalance (positional hitsounds). */
  private balance(x: number): number {
    return Math.round(this.positionalHitsoundsLevel * 2 * (x / PLAYFIELD_WIDTH - 0.5) * 100) / 100;
  }

  private playObjectSamples(h: OsuHitObject): void {
    if (h instanceof SliderTailCircle) return; // tail samples are played by DrawableSlider
    if (h instanceof Slider) {
      // DrawableSlider.PlaySamples: the tail's samples, only if the tail was hit.
      if (!isHit(this.judge.get(h.tailCircle)!.result)) return;
      this.ctx.playSamples(h.tailSamples, { pan: this.balance(this.sliderCentreX(h)) });
      return;
    }
    if (h.samples.length === 0) return;
    const x = h instanceof Spinner || h instanceof SpinnerTick ? PLAYFIELD_WIDTH / 2 : h.stackedPosition.x;
    this.ctx.playSamples(h.samples, { pan: this.balance(x) });
  }

  private readonly sliderCentreCache = new Map<Slider, number>();

  /** The X centre of the slider's drawable (its body's bounding box). */
  private sliderCentreX(s: Slider): number {
    let x = this.sliderCentreCache.get(s);
    if (x == null) {
      let min = Infinity;
      let max = -Infinity;
      for (const p of s.path.path) {
        min = Math.min(min, p.x);
        max = Math.max(max, p.x);
      }
      x = s.stackedPosition.x + (min === Infinity ? 0 : (min + max) / 2);
      this.sliderCentreCache.set(s, x);
    }
    return x;
  }

  update(time: number, elapsed: number): void {
    if (this.ctx.autoplay) {
      // Autoplay: the generated replay drives the inputs at their exact times.
      const ev = this.autoEvents;
      while (this.autoEventIndex < ev.length && ev[this.autoEventIndex].t <= time) {
        const e = ev[this.autoEventIndex++];
        this.updateTo(e.t);
        if (e.k === 'm') this.setCursor({ x: e.x, y: e.y });
        else if (e.k === 'p') this.press(e.a as Action, e.t);
        else if (e.k === 'r') this.release(e.a as Action, e.t);
      }
      // OsuFramedReplayInputHandler interpolates the mouse position between frames.
      const moves = this.autoMoves;
      let i = 0;
      let lo = 0;
      let hi = moves.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (moves[mid].t <= time) {
          i = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      const a = moves[i];
      const b = moves[i + 1];
      if (a && b && a.t <= time && b.t > a.t) {
        const t = (time - a.t) / (b.t - a.t);
        this.setCursor({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      }
    }

    // OsuModAutopilot.Update (IUpdatableByPlayfield, before the hit objects update).
    if (this.autopilot) {
      const p = this.autopilot.update(time);
      if (p) this.setCursor(p);
    }

    // OsuModRelax.Update
    this.frameTime = time;
    if (this.relax) this.relax.update(this.relaxPlayfield, time);

    this.updateTo(time);

    const fl = this.flashlight;
    if (fl) {
      fl.update(time, this.ctx.combo, isBreakTime(this.playable.breaks, time, this.gameplayStartTime, this.hasCompleted));
      // OsuFlashlight.OnMouseMove (only when the mouse moved this frame)
      if (this.cursorMoved) fl.onMouseMove(this.offsetX + this.cursor.x * this.scale, this.offsetY + this.cursor.y * this.scale, elapsed);
    }
    this.cursorMoved = false;
  }

  private frameTime = -Infinity;
  private cursorMoved = false;

  private readonly relaxPlayfield: RelaxPlayfield = (() => {
    const self = this;
    return {
      get aliveObjects() {
        return self.aliveObjects();
      },
      isHit: (h: OsuHitObject) => {
        const s = self.judge.get(h)!;
        return s.judged && isHit(s.result);
      },
      isHovered: (c: HitCircle) => self.isHovered(c),
      isMouseInFollowArea: (s: Slider) => self.isMouseInFollowArea(s, self.frameTime, self.sliderStates.get(s)!.tracking),
      press: (a: Action, t: number) => self.press(a, t),
      release: (a: Action, t: number) => self.release(a, t),
    };
  })();

  private aliveObjects(): OsuHitObject[] {
    const out: OsuHitObject[] = [];
    const time = this.frameTime;
    for (let i = this.firstActiveIndex; i < this.objects.length; i++) {
      const h = this.objects[i];
      if (h.startTime - h.timePreempt > time) break;
      out.push(h);
    }
    return out;
  }

  private updateTo(time: number): void {
    if (time < this.lastUpdateTime) return;
    const elapsed = this.lastUpdateTime === -Infinity ? 0 : time - this.lastUpdateTime;
    this.lastUpdateTime = time;

    for (let i = this.firstActiveIndex; i < this.objects.length; i++) {
      const h = this.objects[i];
      if (h.startTime - h.timePreempt > time) break;
      if (h instanceof HitCircle) this.updateCircle(h, time);
      else if (h instanceof Slider) this.updateSlider(h, time);
      else if (h instanceof Spinner) this.updateSpinner(h, time, elapsed);
    }

    // Advance past fully finished objects (kept a while for their hit animations).
    while (this.firstActiveIndex < this.objects.length) {
      const h = this.objects[this.firstActiveIndex];
      const s = this.judge.get(h)!;
      if (s.judged && time > Math.max(h.endTime, s.judgedAt) + 1000) {
        const sp = h instanceof Spinner ? this.spinnerStates.get(h) : null;
        if (sp?.spinLoop) {
          sp.spinLoop.stop();
          sp.spinLoop = null;
        }
        this.firstActiveIndex++;
      } else break;
    }

    const cutoff = time - 2000;
    while (this.judgements.length > 0 && this.judgements[0].time < cutoff) this.judgements.shift();
  }

  /** DrawableHitCircle.CheckForResult(userTriggered: false) */
  private updateCircle(c: HitCircle, time: number): void {
    const s = this.judge.get(c)!;
    if (s.judged) return;
    const timeOffset = time - c.startTime;
    if (!c.hitWindows.canBeHit(timeOffset)) this.applyResult(c, HitResult.Miss, timeOffset);
  }

  private updateSlider(slider: Slider, time: number): void {
    const head = slider.headCircle;
    const ss = this.sliderStates.get(slider)!;
    const sliderJudge = this.judge.get(slider)!;

    // SliderInputManager.Update
    this.updateTracking(slider, ss, this.isMouseInFollowArea(slider, time, ss.tracking), time);

    // DrawableSliderHead.CheckForResult(false) → DrawableHitCircle + PostProcessHeadJudgement
    if (!this.judge.get(head)!.judged) {
      const timeOffset = time - head.startTime;
      if (!head.hitWindows.canBeHit(timeOffset)) {
        this.applyResult(head, HitResult.Miss, timeOffset);
        this.postProcessHeadJudgement(slider, time);
      }
    }

    // Nested ticks / repeats / tail (SliderInputManager.TryJudgeNestedObject)
    if (this.judge.get(head)!.judged) {
      for (const n of slider.nested) {
        if (n === head) continue;
        const ns = this.judge.get(n)!;
        if (ns.judged) continue;
        const timeOffset = time - n.startTime;
        if (n instanceof SliderTick || n instanceof SliderRepeat) {
          if (timeOffset < 0) break;
        } else if (n instanceof SliderTailCircle) {
          if (timeOffset < TAIL_LENIENCY) break;
          const lastTick = this.lastTickOrRepeat(slider);
          if (lastTick && !this.judge.get(lastTick)!.judged) break;
        }
        if (ss.tracking) this.applyResult(n, n.judgement.maxResult, timeOffset);
        else if (timeOffset >= 0) this.applyResult(n, n.judgement.minResult, timeOffset);
        else break;
      }
    }

    // DrawableSlider.CheckForResult: judged once the tail is judged and the end time has been reached.
    if (!sliderJudge.judged && this.judge.get(slider.tailCircle)!.judged && time >= slider.endTime) {
      const anyHit = slider.nested.some(n => isHit(this.judge.get(n)!.result));
      this.applyResult(slider, anyHit ? HitResult.IgnoreHit : HitResult.IgnoreMiss, time - slider.endTime);
    }

    // DrawableSlider.Update: sliding sample, at the ball position.
    const shouldSlide = ss.tracking && time >= slider.startTime;
    if (shouldSlide && !ss.slideLoop) {
      ss.slideLoop = slider.slidingSamples.map(s => this.ctx.startLoop(s, { volume: 1 })).filter((l): l is LoopHandle => l != null);
    } else if (!shouldSlide && ss.slideLoop) {
      for (const l of ss.slideLoop) l.stop();
      ss.slideLoop = null;
    }
    if (ss.slideLoop) {
      const pan = this.balance(slider.stackedPositionAt(this.sliderProgress(slider, time)).x);
      for (const l of ss.slideLoop) l.setPan(pan);
    }

    // OsuModFlashlight: OnSliderUpdate
    this.flashlight?.onSliderUpdate(
      slider,
      ss.tracking,
      s => time <= this.hitStateUpdateTime(s) + 240,
      s => this.sliderStates.get(s)!.tracking,
      time,
    );
  }

  private lastTickCache = new Map<Slider, OsuHitObject | null>();

  private lastTickOrRepeat(slider: Slider): OsuHitObject | null {
    let t = this.lastTickCache.get(slider);
    if (t === undefined) {
      t = null;
      for (const n of slider.nested) if (n instanceof SliderTick || n instanceof SliderRepeat) t = n;
      this.lastTickCache.set(slider, t);
    }
    return t;
  }

  private sliderProgress(slider: Slider, time: number): number {
    return clamp((time - slider.startTime) / slider.duration, 0, 1);
  }

  /** SliderInputManager.IsMouseInFollowArea */
  private isMouseInFollowArea(slider: Slider, time: number, expanded: boolean): boolean {
    const radius = slider.radius * (expanded ? FOLLOW_AREA : 1);
    const pos = slider.stackedPositionAt(this.sliderProgress(slider, time));
    return distanceSq(this.cursor, pos) <= radius * radius;
  }

  /** SliderInputManager.PostProcessHeadJudgement */
  private postProcessHeadJudgement(slider: Slider, time: number): void {
    const head = slider.headCircle;
    const hs = this.judge.get(head)!;
    if (!hs.judged || !isHit(hs.result)) return;
    if (!this.isMouseInFollowArea(slider, time, true)) return;

    // When the head is hit late:
    // - If the cursor has at all times been within range of the expanded follow area, hit all nested objects that have been passed through.
    // - If the cursor has at some point left the expanded follow area, miss those nested objects instead.
    let allTicksInRange = true;
    const radius = slider.radius * FOLLOW_AREA;
    for (const n of slider.nested) {
      if (this.judge.get(n)!.judged) continue;
      if (n.startTime > time) break;
      const objectProgress = clamp((n.startTime - slider.startTime) / slider.duration, 0, 1);
      const p = slider.stackedPositionAt(objectProgress);
      if (distanceSq(p, this.cursor) > radius * radius) {
        allTicksInRange = false;
        break;
      }
    }
    for (const n of slider.nested) {
      if (this.judge.get(n)!.judged) continue;
      if (n.startTime > time) break;
      if (allTicksInRange) this.applyResult(n, n.judgement.maxResult, time - n.startTime);
      else this.applyResult(n, n.judgement.minResult, time - n.startTime);
    }
    const ss = this.sliderStates.get(slider)!;
    this.updateTracking(slider, ss, allTicksInRange || this.isMouseInFollowArea(slider, time, false), time);
  }

  /** SliderInputManager.updateTracking */
  private updateTracking(slider: Slider, ss: SliderState, isValidTrackingPosition: boolean, time: number): void {
    const wasTracking = ss.tracking;
    const headCircleHitAction = ss.headHitAction;
    if (headCircleHitAction == null) ss.timeToAcceptAnyKeyAfter = null;

    if (headCircleHitAction != null && ss.timeToAcceptAnyKeyAfter == null) {
      const otherKey: Action = headCircleHitAction === 'RightButton' ? 'LeftButton' : 'RightButton';
      // we can start accepting any key once all other keys have been released in the previous frame.
      if (!ss.lastPressedActions.includes(otherKey)) ss.timeToAcceptAnyKeyAfter = time;
    }

    ss.lastPressedActions = [...this.pressed];
    let validTrackingAction = false;
    for (const action of this.pressed) {
      let valid: boolean;
      if (headCircleHitAction && (ss.timeToAcceptAnyKeyAfter == null || time <= ss.timeToAcceptAnyKeyAfter)) valid = action === headCircleHitAction;
      else valid = true;
      if (valid) validTrackingAction = true;
    }

    // DrawableHitObject.AllJudged: the slider itself and all of its nested objects.
    const allJudged = this.judge.get(slider)!.judged && slider.nested.every(n => this.judge.get(n)!.judged);
    ss.tracking = (!allJudged || time <= slider.endTime) && isValidTrackingPosition && validTrackingAction;
    if (wasTracking !== ss.tracking) {
      ss.lastTrackingChange = time;
      // FollowCircle: tracking changes (ignored once the slider is judged).
      if (!this.judge.get(slider)!.judged) {
        const t = Math.max(time, slider.startTime);
        if (ss.tracking) followOnSliderPress(ss, t);
        else followOnSliderRelease(ss, t);
      }
    }
  }

  /** DrawableSpinner + SpinnerRotationTracker + OsuModSpunOut + ArgonSpinnerDisc / arcs (frame-based parts). */
  private updateSpinner(spinner: Spinner, time: number, elapsed: number): void {
    const st = this.spinnerStates.get(spinner)!;
    const s = this.judge.get(spinner)!;
    const spinnable = spinner.startTime <= time && spinner.endTime > time;

    // DrawableSpinner.Update
    if (!this.spunOut) st.tracking = spinnable && !s.judged && this.pressed.size > 0;
    // OsuModSpunOut (OnUpdate)
    if (this.spunOut) {
      st.tracking = spinnable;
      this.addRotation(spinner, st, spunOutRotation(spinner, elapsed, this.ctx.rate), time);
    }

    // SpinnerRotationTracker.Update
    const centre = spinner.position;
    const thisAngle = Math.fround(-(Math.atan2(this.cursor.x - centre.x, this.cursor.y - centre.y) * 180) / Math.PI);
    let delta = st.lastAngle == null ? 0 : thisAngle - st.lastAngle;
    // Normalise the delta to -180 .. 180
    if (delta > 180) delta -= 360;
    if (delta < -180) delta += 360;
    if (st.tracking) this.addRotation(spinner, st, delta, time);
    st.lastAngle = thisAngle;

    const wasSpinning = st.isSpinning;
    st.isSpinning = spinnable && Math.abs(st.currentRotation - st.displayRotation) > 10;
    st.displayRotation = valueDamp(st.displayRotation, st.currentRotation, 0.99, Math.abs(elapsed));
    if (st.isSpinning !== wasSpinning) this.updateSpinningSample(spinner, st, time);

    // DrawableSpinner.Update: spinningSample.Frequency (SpinnerFrequencyModulate in legacy skins)
    if (st.spinLoop) {
      const modulate = this.legacy ? this.legacy.spinnerFrequencyModulate : true;
      st.spinLoop.setRate(spinningSampleFrequency(this.progressUnclamped(spinner, st), modulate));
      st.spinLoop.setVolume(st.spinVolume.at(time));
      // the looping sample is stopped once the hit state fade out completes.
      if (s.judged && time >= this.hitStateUpdateTime(spinner) + 240) {
        st.spinLoop.stop();
        st.spinLoop = null;
      }
    }

    this.updateSpinnerVisuals(spinner, st, time, elapsed);

    // DrawableHitObject.UpdateAfterChildren → CheckForResult
    if (time >= spinner.startTime && !s.judged) {
      if (this.progress(spinner, st) >= 1) st.timeCompleted ??= time;
      if (time >= spinner.endTime) {
        // Trigger a miss result for remaining ticks to avoid infinite gameplay.
        for (const t of spinner.ticks) if (!this.judge.get(t)!.judged) this.applyResult(t, t.judgement.minResult, time - t.startTime);
        const progress = this.progress(spinner, st);
        let result: HitResult;
        if (progress >= 1) result = HitResult.Great;
        else if (progress > 0.9) result = HitResult.Ok;
        else if (progress > 0.75) result = HitResult.Meh;
        else result = HitResult.Miss;
        this.applyResult(spinner, result, time - spinner.endTime);
        // skin change / hit state transforms re-trigger the spinning sample state.
        this.updateSpinningSample(spinner, st, time);
      }
    }

    // DrawableSpinner.UpdateAfterChildren
    if (st.timeStarted == null && st.tracking) st.timeStarted = time;
    // don't update after end time to avoid the rate display dropping during fade out.
    if (time <= spinner.endTime) st.spm.setRotation(st.history.totalRotation, time);
    this.updateBonusScore(spinner, st, time);
  }

  /** DrawableSpinner.updateSpinningSample */
  private updateSpinningSample(spinner: Spinner, st: SpinnerState, time: number): void {
    if (st.isSpinning) {
      if (!st.spinLoop && !this.judge.get(spinner)!.judged) {
        const sample = spinner.spinningSamples[0];
        st.spinLoop = sample ? this.ctx.startLoop(sample, { volume: 0 }) : null;
      }
      st.spinVolume.to(time, 1, 300);
    } else st.spinVolume.to(time, 0, 240);
  }

  /** SpinnerRotationTracker.AddRotation */
  private addRotation(spinner: Spinner, st: SpinnerState, delta: number, time: number): void {
    if (!(spinner.startTime <= time && spinner.endTime > time)) return;
    if (!st.rotationTransferred) {
      st.currentRotation = st.displayRotation;
      st.rotationTransferred = true;
    }
    delta = Math.fround(delta * Math.abs(this.ctx.rate));
    st.currentRotation = Math.fround(st.currentRotation + delta);
    st.history.reportDelta(time, delta);
  }

  /** DrawableSpinner.updateBonusScore */
  private updateBonusScore(spinner: Spinner, st: SpinnerState, time: number): void {
    if (spinner.ticks.length === 0) return;
    const spins = Math.trunc(st.history.totalRotation / 360);
    if (spins < st.completedFullSpins) {
      // rewinding, silently handle
      st.completedFullSpins = spins;
      return;
    }
    while (st.completedFullSpins !== spins) {
      const tick = spinner.ticks.find(t => !this.judge.get(t)!.judged);
      // tick may be null if we've hit the spin limit.
      if (!tick) {
        const ref = spinner.samples[0];
        if (ref) this.ctx.playSamples([new SpinnerBonusMaxSampleInfo(ref)], { pan: this.balance(PLAYFIELD_WIDTH / 2) });
      } else this.applyResult(tick, tick.judgement.maxResult, time - tick.startTime);
      st.completedFullSpins++;
      // ArgonSpinner: completedSpins changed → bonus counter
      const bonus = SPINNER_SCORE_PER_TICK * clamp(st.completedFullSpins - spinner.spinsRequiredForBonus, 0, spinner.maximumBonusSpins);
      if (bonus > 0) {
        const max = bonus === SPINNER_SCORE_PER_TICK * spinner.maximumBonusSpins;
        st.bonus = { text: max ? 'MAX' : String(bonus), time, max };
      }
    }
  }

  /** ArgonSpinnerDisc.Update, ArgonSpinnerRingArc.Update, ArgonSpinnerProgressArc.Update */
  private updateSpinnerVisuals(spinner: Spinner, st: SpinnerState, time: number, elapsed: number): void {
    const e = Math.abs(elapsed);
    const progress = this.progress(spinner, st);
    const complete = st.timeCompleted != null && time >= st.timeCompleted;
    if (complete) {
      const rotations = Math.trunc(st.history.totalRotation / 360);
      if (st.wholeRotationCount !== rotations) {
        st.wholeRotationCount = rotations;
        // fill.FinishTransforms(false, nameof(Alpha))
        const flash = new Prop(st.fillFlash ? st.fillFlash.finalValue : st.fillAlpha);
        const end = flash.to(time, 0.4 + 0.2, 60, Easing.OutExpo);
        flash.to(end, 0.4, 250, Easing.OutQuint);
        st.fillFlash = flash;
      }
    } else {
      st.trackingElementInterpolation = valueDamp(st.trackingElementInterpolation, st.tracking ? 1 : 0, 0.985, e);
      st.fillAlpha = st.trackingElementInterpolation * (0.4 - 0.2) + 0.2;
      st.fillFlash = null;
    }
    const targetScale = 0.1 + (0.98 - 0.1) * progress;
    st.fillScale = st.fillScale + (targetScale - st.fillScale) * clamp(e / 100, 0, 1);

    const dc = (current: number, target: number) => current + (target - current) * (1 - Math.pow(0.5, e / 40));
    st.ringArcProgress = dc(st.ringArcProgress, progress >= 1 ? 0.5 : 0.31);
    st.ringArcRadius = dc(st.ringArcRadius, progress >= 1 ? 0.02 * 2.2 : 0.02);
    st.progressFillAlpha = dc(st.progressFillAlpha, progress > 0 && progress < 1 ? 1 : 0);
    st.progressFill = dc(st.progressFill, progress >= 1 ? 0 : 0.15 * progress);
  }

  /** DrawableSpinner.Progress (clamped) */
  private progress(spinner: Spinner, st: SpinnerState): number {
    return clamp(this.progressUnclamped(spinner, st), 0, 1);
  }

  private progressUnclamped(spinner: Spinner, st: SpinnerState): number {
    // some spinners are so short they can't require an integer spin count. these become implicitly hit.
    if (spinner.spinsRequired === 0) return 1;
    return st.history.totalRotation / 360 / spinner.spinsRequired;
  }

  // ---------------------------------------------------------------- state transforms

  /** DrawableHitObject.HitStateUpdateTime (Result.TimeAbsolute ?? EndTime) */
  private hitStateUpdateTime(h: OsuHitObject): number {
    const s = this.judge.get(h)!;
    return s.judged ? s.judgedAt : h.endTime;
  }

  /** ModWithVisibilityAdjustment: the first object (and all of its nested objects) gets increased visibility. */
  private isIncreasedVisibility(h: OsuHitObject): boolean {
    if (!this.increaseFirstObjectVisibility || !this.firstObject) return false;
    return h === this.firstObject || this.parentOf.get(h) === this.firstObject;
  }

  /** DrawableHitCircle (+ DrawableOsuHitObject dim, OsuModHidden) */
  private getCircleVis(c: HitCircle): CircleVis {
    const st = this.judge.get(c)!;
    const cached = this.circleVis.get(c);
    if (cached && cached.version === st.version) return cached;

    const t0 = c.startTime - c.timePreempt;
    const alpha = new Prop(0);
    alpha.fromTo(t0, 0, 1); // DrawableHitObject.UpdateInitialTransforms: FadeInFromZero()
    const dim = new Prop(1);
    dim.to(t0, DIM);
    dim.to(t0 + c.timePreempt - 400 /* MISS_WINDOW */, 1, 100);
    const pieceAlpha = new Prop(1);
    pieceAlpha.fromTo(t0, 0, 1, c.timeFadeIn);
    const approachAlpha = new Prop(0);
    approachAlpha.to(t0, 0.9, Math.min(c.timeFadeIn * 2, c.timePreempt));
    const approachScale = new Prop(4);
    approachScale.to(t0, 1, c.timePreempt);
    // UpdateStartTimeStateTransforms: always fade out at the circle's start time (to match user expectations).
    approachAlpha.to(c.startTime, 0, 50);

    const hitTime = st.judged ? st.judgedAt : c.startTime;
    const hit = st.judged && isHit(st.result);
    // todo: temporary / arbitrary, used for lifetime optimisation.
    alpha.to(hitTime + 800, 0);
    if (hit) {
      approachAlpha.to(hitTime, 0);
      if (!this.hitAnimations) alpha.to(hitTime, 0, 60, Easing.Out);
    } else if (st.judged) alpha.to(hitTime, 0, 100);

    if (this.hidden) {
      const increased = this.isIncreasedVisibility(c);
      const p = OsuModHidden.fadeOutParameters(c);
      if (!increased) approachAlpha.to(t0, 0);
      // only fade the circle piece (not the approach circle) for the increased visibility object.
      (increased ? pieceAlpha : alpha).to(p.start, 0, p.duration);
    }

    const v: CircleVis = { version: st.version, alpha, pieceAlpha, dim, approachAlpha, approachScale, hitTime, hit };
    this.circleVis.set(c, v);
    return v;
  }

  /** DrawableSlider (+ DrawableSliderBall, ArgonSliderBall, OsuModHidden) */
  private getSliderVis(s: Slider): SliderVis {
    const st = this.judge.get(s)!;
    const headState = this.judge.get(s.headCircle)!;
    const version = st.version * 1000 + headState.version;
    const cached = this.sliderVis.get(s);
    if (cached && cached.version === version) return cached;

    const t0 = s.startTime - s.timePreempt;
    const alpha = new Prop(0);
    alpha.fromTo(t0, 0, 1);
    const dim = new Prop(1);
    dim.to(t0, DIM);
    dim.to(t0 + s.timePreempt - 400, 1, 100);
    const bodyAlpha = new Prop(1);
    bodyAlpha.fromTo(t0, 0, 1, s.timeFadeIn);
    // UpdateStartTimeStateTransforms
    const ballAlpha = new Prop(0);
    ballAlpha.to(s.startTime, 1);
    const argonBallAlpha = new Prop(1);
    const iconScale = new Prop(1);
    argonBallAlpha.fromTo(s.startTime, 0, 1, 200, Easing.OutQuint);
    iconScale.fromTo(s.startTime, 0, 1, 200, Easing.OutElasticHalf);

    const hitTime = this.hitStateUpdateTime(s);
    if (st.judged && isHit(st.result) && headState.judged && isHit(headState.result) && this.snakingOut) bodyAlpha.to(hitTime, 0, 40); // short fade to allow for any body colour to smoothly disappear.
    alpha.to(hitTime, 0, 240);
    // ArgonSliderBall: intentionally pile on an extra FadeOut to make it happen much faster
    argonBallAlpha.to(hitTime, 0, 50, Easing.OutQuint);
    iconScale.to(hitTime, 0.9, 200, Easing.OutQuint);

    if (this.hidden) {
      const p = OsuModHidden.fadeOutParameters(s);
      bodyAlpha.to(p.start, 0, p.duration, Easing.Out);
    }

    const v: SliderVis = { version, alpha, bodyAlpha, dim, ballAlpha, argonBallAlpha, iconScale };
    this.sliderVis.set(s, v);
    return v;
  }

  /** DrawableSliderTick */
  private getTickVis(t: SliderTick): TickVis {
    const st = this.judge.get(t)!;
    const cached = this.tickVis.get(t);
    if (cached && cached.version === st.version) return cached;
    const t0 = t.startTime - t.timePreempt;
    const ANIM_DURATION = 150;
    const alpha = new Prop(0);
    alpha.fromTo(t0, 0, 1, ANIM_DURATION);
    const scale = new Prop(1);
    scale.fromTo(t0, 0.5, 1, ANIM_DURATION * 4, Easing.OutElasticHalf);
    const hitTime = st.judged ? st.judgedAt : t.startTime;
    if (!st.judged) alpha.to(hitTime + t.timePreempt, 0);
    else {
      alpha.to(hitTime, 0, ANIM_DURATION, Easing.OutQuint);
      if (isHit(st.result)) scale.to(hitTime, 1.5, ANIM_DURATION, Easing.Out);
    }
    if (this.hidden) {
      const p = OsuModHidden.fadeOutParameters(t);
      alpha.to(p.start, 0, p.duration);
    }
    const v = { version: st.version, alpha, scale };
    this.tickVis.set(t, v);
    return v;
  }

  /** DrawableSliderRepeat (+ ApplyRepeatFadeIn, OsuModHidden) */
  private getRepeatVis(r: SliderRepeat): RepeatVis {
    const st = this.judge.get(r)!;
    const cached = this.repeatVis.get(r);
    if (cached && cached.version === st.version) return cached;
    const slider = r.slider;
    const t0 = r.startTime - r.timePreempt;
    const alpha = new Prop(0);
    alpha.fromTo(t0, 0, 1);
    // ApplyRepeatFadeIn(Arrow, 150): when snaking in is enabled, the first end circle needs to be delayed until the snaking completes.
    const arrowAlpha = new Prop(1);
    const delayFadeIn = this.snakingIn && r.repeatIndex === 0;
    const fadeTime = r.repeatIndex > 0 ? Math.min(slider.spanDuration, 150) : 150;
    arrowAlpha.to(t0, 0);
    arrowAlpha.to(t0 + (delayFadeIn ? slider.timePreempt / 3 : 0), 1, fadeTime);
    const hitTime = st.judged ? st.judgedAt : r.startTime;
    const animDuration = Math.min(300, slider.spanDuration);
    const hit = st.judged && isHit(st.result);
    if (!st.judged) alpha.to(hitTime + r.timePreempt, 0);
    else if (hit) alpha.to(hitTime, 0, animDuration, Easing.Out);
    else alpha.to(hitTime, 0, animDuration);
    // OsuModHidden: the reverse arrow is not affected by hidden, but disappears at the hit state time.
    if (this.hidden) alpha.to(hitTime, 0);
    const v = { version: st.version, alpha, arrowAlpha, hitTime, hit, animDuration };
    this.repeatVis.set(r, v);
    return v;
  }

  /** DrawableSpinner (+ ArgonSpinnerDisc.updateStateTransforms, OsuModHidden) */
  private getSpinnerVis(sp: Spinner): SpinnerVis {
    const st = this.judge.get(sp)!;
    const cached = this.spinnerVis.get(sp);
    if (cached && cached.version === st.version) return cached;
    const t0 = sp.startTime - sp.timePreempt;
    const p = sp.timePreempt;
    const alpha = new Prop(0);
    alpha.fromTo(t0, 0, 1);
    const hitTime = this.hitStateUpdateTime(sp);
    alpha.to(hitTime, 0, 240);
    if (this.hidden) {
      const hp = OsuModHidden.fadeOutParameters(sp);
      alpha.to(hp.start, 0, hp.duration);
    }
    const discScale = new Prop(1);
    const centreScale = new Prop(1);
    const ticksRotation = new Prop(0);
    discScale.to(t0, 0);
    centreScale.to(t0, 0);
    ticksRotation.to(t0, 0);
    // constant ambient rotation to give the spinner "spinning" character.
    ticksRotation.to(t0 + p / 2, (25 * sp.duration) / 2000, p + sp.duration);
    centreScale.to(t0 + p / 2, 0.3, p / 4, Easing.OutQuint);
    discScale.to(t0 + p / 2, 0.2, p / 4, Easing.OutQuint);
    centreScale.to(t0 + p, 0.8, p / 2, Easing.OutQuint);
    discScale.to(t0 + p, 1, p / 2, Easing.OutQuint);
    if (st.judged) {
      if (isHit(st.result)) {
        discScale.to(st.judgedAt, 1.2, 320, Easing.Out);
        ticksRotation.to(st.judgedAt, 180, 320);
      } else discScale.to(st.judgedAt, 0.8, 320, Easing.In);
    }
    const v = { version: st.version, alpha, discScale, centreScale, ticksRotation };
    this.spinnerVis.set(sp, v);
    return v;
  }

  /** The Hidden mod's fade factor (1 without Hidden), for the legacy skin renderer. */
  private hiddenAlpha(h: OsuHitObject, time: number): number {
    if (!this.hidden) return 1;
    const p = OsuModHidden.fadeOutParameters(h);
    const t = clamp((time - p.start) / Math.max(1e-6, p.duration), 0, 1);
    return 1 - (h instanceof Slider ? applyEasing(Easing.Out, t) : t);
  }

  // ---------------------------------------------------------------- rendering

  render(g: CanvasRenderingContext2D, width: number, height: number, time: number): void {
    // OsuPlayfieldAdjustmentContainer (AlignWithStoryboard)
    const transform = osuPlayfieldTransform(width, height);
    const scale = transform.scale;
    this.scale = scale;
    this.offsetX = transform.offsetX;
    this.offsetY = transform.offsetY;

    g.save();
    g.translate(this.offsetX, this.offsetY);
    g.scale(scale, scale);

    const L = this.legacy;
    L?.beginFrame(time);

    let last = this.firstActiveIndex;
    while (last < this.objects.length && this.objects[last].startTime - this.objects[last].timePreempt <= time) last++;

    // OsuPlayfield layering: spinner proxies, follow points, judgement layer, hit objects, judgements above hit objects, approach circles.
    for (let i = last - 1; i >= this.firstActiveIndex; i--) {
      const h = this.objects[i];
      if (!(h instanceof Spinner)) continue;
      if (L?.has.spinner) L.drawSpinner(g, h, time);
      else this.drawSpinner(g, h, time);
    }
    if (this.showFollowPoints) {
      if (L?.has.followPoint) L.drawFollowPoints(g, time, this.firstActiveIndex);
      else this.drawFollowPoints(g, time);
    }
    L?.drawJudgementsBelow(g, time);
    this.drawJudgements(g, time, false);

    // Later objects are drawn below earlier ones.
    const kiai = this.kiaiFlash(time);
    for (let i = last - 1; i >= this.firstActiveIndex; i--) {
      const h = this.objects[i];
      if (h instanceof Slider) this.drawSlider(g, h, time, kiai);
      else if (h instanceof HitCircle) this.drawCircleObject(g, h, time, null, kiai);
    }
    L?.drawJudgementsAbove(g, time);
    this.drawJudgements(g, time, true);

    // Approach circles go above everything (separate proxied layer in lazer).
    for (let i = last - 1; i >= this.firstActiveIndex; i--) {
      const h = this.objects[i];
      const c = h instanceof HitCircle ? h : h instanceof Slider ? h.headCircle : null;
      if (!c) continue;
      if (L?.has.approachCircle) {
        if (!this.hidden || this.isIncreasedVisibility(c)) L.drawApproachCircle(g, c, h, time);
      } else this.drawApproachCircle(g, c, h, time);
    }

    // Cursor (OsuPlayfield's cursor container)
    if (L && (L.has.cursor || L.has.cursorTrail)) {
      g.restore();
      L.drawCursor(g, this.cursor.x, this.cursor.y, this.pressed.size > 0, time, this.scale, this.offsetX, this.offsetY, this.cursorScale, this.showCursorTrail, this.cursorScale);
      g.save();
      g.translate(this.offsetX, this.offsetY);
      g.scale(scale, scale);
      if (!L.has.cursor) this.drawCursor(g, time, false);
    } else this.drawCursor(g, time, true);
    g.restore();

    // ModFlashlight: drawn in DrawableRuleset.Overlays, above the playfield.
    this.flashlight?.draw(g, width, height, time, scale);
  }

  private comboColour(h: OsuHitObject): RGB {
    const colours = this.comboColours;
    const i = h.comboIndexWithOffsets;
    return colours[((i % colours.length) + colours.length) % colours.length];
  }

  private accent(h: OsuHitObject): Colour4 {
    return fromRgb(this.comboColour(h));
  }

  /** KiaiFlash (BeatSyncedContainer, EarlyActivationMilliseconds = 80) box alpha. */
  private kiaiFlash(time: number): number {
    const cp = this.playable.source.controlPoints;
    const early = 80;
    const tp = cp.timingPointAt(time + early);
    const beatLength = tp.beatLength;
    if (!(beatLength > 0)) return 0;
    const beatIndex = Math.floor((time + early - tp.time) / beatLength);
    const beatStart = tp.time + beatIndex * beatLength;
    if (!cp.effectPointAt(beatStart).kiaiMode) return 0;
    const since = time - (beatStart - early);
    if (since < 0) return 0;
    if (since < early) return 0.25 * outQuint(since / early);
    const fade = Math.max(80, beatLength - 80);
    return 0.25 * (1 - outSine(Math.min(1, (since - early) / fade)));
  }

  /** DrawableHitCircle / DrawableSliderHead with ArgonMainCirclePiece. `slider` is the parent for slider heads. */
  private drawCircleObject(g: CanvasRenderingContext2D, c: HitCircle, time: number, slider: Slider | null, kiai: number): void {
    const colourSource = slider ?? c;
    if (this.legacy?.has.hitCircle) {
      this.legacy.drawHitCircle(g, c, time, 'all', colourSource);
      return;
    }
    const v = this.getCircleVis(c);
    const alpha = v.alpha.at(time);
    if (alpha <= 0) return;
    const pieceAlpha = v.pieceAlpha.at(time);
    if (pieceAlpha <= 0) return;
    const pos = c.stackedPosition;
    const shake = this.circleShake.get(c)?.at(time) ?? 0;
    g.save();
    g.translate(pos.x + shake * c.scale, pos.y);
    g.scale(c.scale, c.scale);
    drawMainCirclePiece(g, {
      accent: this.accent(colourSource),
      withOuterFill: slider == null,
      number: colourSource.indexInCurrentCombo + 1,
      alpha: alpha * pieceAlpha,
      dim: v.dim.at(time),
      sinceHit: v.hit && time >= v.hitTime ? time - v.hitTime : null,
      hitLighting: this.hitLighting,
      kiai,
    });
    g.restore();
  }

  private drawApproachCircle(g: CanvasRenderingContext2D, c: HitCircle, parent: OsuHitObject, time: number): void {
    const v = this.getCircleVis(c);
    let alpha = v.alpha.at(time) * v.approachAlpha.at(time);
    if (parent instanceof Slider) alpha *= this.getSliderVis(parent).alpha.at(time);
    if (alpha <= 0) return;
    const pos = c.stackedPosition;
    const shake = this.circleShake.get(c)?.at(time) ?? 0;
    g.save();
    g.translate(pos.x + shake * c.scale, pos.y);
    // LegacyColourCompatibility.DisallowZeroAlpha(accent)
    drawApproachCircle(g, v.approachScale.at(time) * c.scale, alpha, this.accent(parent));
    g.restore();
  }

  /** SnakingSliderBody.UpdateProgress (progress is 0 until the head is hit) */
  private snakedRange(slider: Slider, time: number): [number, number] {
    const head = this.judge.get(slider.headCircle)!;
    const completion = head.judged && isHit(head.result) ? this.sliderProgress(slider, time) : 0;
    const spanCount = slider.spanCount;
    const span = Math.trunc(completion * spanCount);
    const spanProgress = slider.progressAt(completion);
    let start = 0;
    let end = this.snakingIn ? clamp((time - (slider.startTime - slider.timePreempt)) / (slider.timePreempt / 3), 0, 1) : 1;
    if (span >= spanCount - 1) {
      if (Math.min(span, spanCount - 1) % 2 === 1) {
        start = 0;
        end = this.snakingOut ? spanProgress : 1;
      } else start = this.snakingOut ? spanProgress : 0;
    }
    return start > end ? [end, start] : [start, end];
  }

  private drawSlider(g: CanvasRenderingContext2D, slider: Slider, time: number, kiai: number): void {
    const v = this.getSliderVis(slider);
    const ss = this.sliderStates.get(slider)!;
    const [p0, p1] = this.snakedRange(slider, time);

    // Legacy skin providing "hitcircle": LegacySliderBody, end circles, reverse arrows, head (+ ball / ticks when provided).
    const L = this.legacy;
    if (L?.has.hitCircle) {
      const bodyAlpha = v.bodyAlpha.at(time);
      const points = bodyAlpha > 0 ? (p0 === 0 && p1 === 1 ? slider.path.path : slider.path.getPathToProgress(p0, p1)) : [];
      const sliderAlpha = v.alpha.at(time);
      L.drawSlider(g, slider, time, { points, alpha: bodyAlpha }, {
        ticks: () => this.drawSliderTicks(g, slider, time, sliderAlpha, 0),
        follow: () => this.drawProceduralFollowCircle(g, slider, time, sliderAlpha),
        ball: () => this.drawProceduralSliderBall(g, slider, time, sliderAlpha),
      });
      return;
    }

    const alpha = v.alpha.at(time);
    if (alpha <= 0) return;
    const shake = ss.shake.at(time);
    const accent = this.accent(slider);
    const dim = v.dim.at(time);

    // body
    const bodyAlpha = v.bodyAlpha.at(time) * alpha;
    if (bodyAlpha > 0 && p1 > p0) this.drawArgonBody(g, slider, p0, p1, accent, dim, bodyAlpha, shake, time);

    // ticks
    if (L?.has.sliderScorePoint) L.drawSliderTicks(g, slider, time, alpha);
    else this.drawSliderTicks(g, slider, time, alpha, shake);

    // repeats (the tail has no visual in the argon skin)
    for (const rep of slider.repeats) this.drawRepeat(g, slider, rep, time, alpha, shake, p0, p1, accent, dim);

    // head (not inside the slider's shake container)
    g.save();
    g.globalAlpha *= alpha;
    this.drawCircleObject(g, slider.headCircle, time, slider, kiai);
    g.restore();

    // slider ball + follow circle (legacy pieces when a skin provides "sliderb" / "sliderfollowcircle").
    if (L && (L.has.sliderBall || L.has.followCircle)) {
      L.drawBallAndFollowCircle(
        g,
        slider,
        time,
        alpha,
        () => this.drawProceduralFollowCircle(g, slider, time, alpha),
        () => this.drawProceduralSliderBall(g, slider, time, alpha),
      );
    } else {
      this.drawProceduralFollowCircle(g, slider, time, alpha);
      this.drawProceduralSliderBall(g, slider, time, alpha);
    }
  }

  private readonly bodyCache = new Map<Slider, { key: string; canvas: HTMLCanvasElement | OffscreenCanvas; x: number; y: number; w: number; h: number; time: number }>();
  private readonly canvasPool: (HTMLCanvasElement | OffscreenCanvas)[] = [];

  /** ArgonSliderBody (PlaySliderBody / SnakingSliderBody), rendered into a cached buffer then drawn with the body's alpha. */
  private drawArgonBody(g: CanvasRenderingContext2D, slider: Slider, p0: number, p1: number, accent: Colour4, dim: number, alpha: number, shakeX: number, time: number): void {
    const points = p0 === 0 && p1 === 1 ? slider.path.path : slider.path.getPathToProgress(p0, p1);
    if (points.length === 0) return;
    const m = typeof g.getTransform === 'function' ? g.getTransform() : null;
    const pixelScale = m && Number.isFinite(m.a) ? Math.hypot(m.a, m.b) || 1 : 1;
    const stacked = slider.stackedPosition;
    const r = ARGON_PATH_RADIUS * slider.scale;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of points) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    minX += stacked.x - r - 1;
    minY += stacked.y - r - 1;
    maxX += stacked.x + r + 1;
    maxY += stacked.y + r + 1;
    const w = maxX - minX;
    const h = maxY - minY;
    const pw = Math.min(4096, Math.ceil(w * pixelScale));
    const ph = Math.min(4096, Math.ceil(h * pixelScale));
    if (!(pw > 0 && ph > 0)) return;

    const colour: Colour4 = [accent[0] * dim, accent[1] * dim, accent[2] * dim, 1];
    const key = `${p0}|${p1}|${colour.map(c => c.toFixed(3)).join()}|${pw}x${ph}`;
    let cached = this.bodyCache.get(slider);
    if (!cached || cached.key !== key) {
      const canvas = cached?.canvas ?? this.canvasPool.pop() ?? createCanvas(pw, ph);
      if (!canvas) return;
      if (canvas.width !== pw || canvas.height !== ph) {
        canvas.width = pw;
        canvas.height = ph;
      }
      const c = canvas.getContext('2d') as CanvasRenderingContext2D | null;
      if (!c) return;
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, pw, ph);
      c.setTransform(pw / w, 0, 0, ph / h, (-minX * pw) / w, (-minY * ph) / h);
      const trace = () => {
        c.beginPath();
        c.moveTo(stacked.x + points[0].x, stacked.y + points[0].y);
        for (let i = 1; i < points.length; i++) c.lineTo(stacked.x + points[i].x, stacked.y + points[i].y);
        if (points.length === 1) c.lineTo(stacked.x + points[0].x + 0.01, stacked.y + points[0].y);
      };
      // ArgonSliderBody.BodyAlpha = 0.98 (non-pro)
      renderArgonSliderPath(c, trace, r, colour, 0.98);
      cached = { key, canvas, x: minX, y: minY, w, h, time };
      this.bodyCache.set(slider, cached);
    }
    cached.time = time;
    const prev = g.globalAlpha;
    g.globalAlpha = prev * alpha;
    g.drawImage(cached.canvas, cached.x + shakeX, cached.y, cached.w, cached.h);
    g.globalAlpha = prev;

    // recycle buffers of sliders no longer drawn
    if (this.bodyCache.size > 16) {
      for (const [s, b] of this.bodyCache) {
        if (s !== slider && Math.abs(time - b.time) > 1000) {
          this.bodyCache.delete(s);
          if (this.canvasPool.length < 8) this.canvasPool.push(b.canvas);
        }
      }
    }
  }

  /** DrawableSliderTick with ArgonSliderScorePoint */
  private drawSliderTicks(g: CanvasRenderingContext2D, slider: Slider, time: number, sliderAlpha: number, shakeX: number): void {
    const accent = this.accent(slider);
    for (const t of slider.ticks) {
      const v = this.getTickVis(t);
      const a = v.alpha.at(time) * sliderAlpha;
      if (a <= 0) continue;
      const p = t.stackedPosition;
      const sc = v.scale.at(time) * slider.scale;
      g.save();
      g.translate(p.x + shakeX, p.y);
      g.scale(sc, sc);
      drawSliderScorePoint(g, accent, a);
      g.restore();
    }
  }

  /** DrawableSliderRepeat with ArgonReverseArrow (+ UpdateSnakingPosition) */
  private drawRepeat(g: CanvasRenderingContext2D, slider: Slider, rep: SliderRepeat, time: number, sliderAlpha: number, shakeX: number, p0: number, p1: number, accent: Colour4, dim: number): void {
    const v = this.getRepeatVis(rep);
    const a = v.alpha.at(time) * v.arrowAlpha.at(time) * sliderAlpha;
    if (a <= 0) return;
    const ss = this.sliderStates.get(slider)!;
    const stacked = slider.stackedPosition;
    const isRepeatAtEnd = rep.repeatIndex % 2 === 0;
    let rel: Vec2;
    let state = ss.arrowRotation.get(rep);
    // When the repeat is hit, the arrow should fade out on spot rather than following the slider.
    if (v.hit) rel = slider.path.positionAt(rep.pathProgress);
    else {
      rel = slider.path.positionAt(isRepeatAtEnd ? p1 : p0);
      // find the next point in the (snaked) curve which is not equal to our current position to infer a rotation.
      const curve = p0 === 0 && p1 === 1 ? slider.path.path : slider.path.getPathToProgress(p0, p1);
      if (curve.length >= 2) {
        let aim: Vec2 = { x: 0, y: 0 };
        if (isRepeatAtEnd) {
          for (let i = curve.length - 1; i >= 0; i--) {
            if (Math.abs(curve[i].x - rel.x) <= 1e-3 && Math.abs(curve[i].y - rel.y) <= 1e-3) continue;
            aim = curve[i];
            break;
          }
        } else {
          for (let i = 0; i < curve.length; i++) {
            if (Math.abs(curve[i].x - rel.x) <= 1e-3 && Math.abs(curve[i].y - rel.y) <= 1e-3) continue;
            aim = curve[i];
            break;
          }
        }
        let aimRotation = (Math.atan2(aim.y - rel.y, aim.x - rel.x) * 180) / Math.PI;
        if (!state) ss.arrowRotation.set(rep, (state = { rotation: aimRotation, time }));
        else {
          while (Math.abs(aimRotation - state.rotation) > 180) aimRotation += aimRotation < state.rotation ? 360 : -360;
          // If we're already snaking, interpolate to smooth out sharp curves (linear sliders, mainly).
          const elapsed = clamp(time - state.time, 0, 100);
          state.rotation = valueAt(elapsed, state.rotation, aimRotation, 0, 50, Easing.OutQuint);
          state.time = time;
        }
      }
    }

    // ArgonReverseArrow.Update
    const loop = (t: number) => {
      const lt = (t - (rep.startTime - rep.timePreempt)) % 300;
      const main = lt < 35 ? valueAt(lt, 1, 1.3, 0, 35, Easing.Out) : valueAt(lt, 1.3, 1, 35, 35 + 250, Easing.Out);
      const side = lt < 35 ? valueAt(lt, 0, -12, 0, 35, Easing.Out) : valueAt(lt, -12, 0, 35, 35 + 250, Easing.Out);
      return [main, side];
    };
    let whole = 1;
    let main: number;
    let side: number;
    if (v.hit && time >= v.hitTime) {
      whole = valueAt(time, 1, 1.5, v.hitTime, v.hitTime + v.animDuration, Easing.Out);
      // When hit, don't animate further.
      [main, side] = loop(v.hitTime);
    } else [main, side] = loop(time);

    g.save();
    g.translate(stacked.x + rel.x + shakeX, stacked.y + rel.y);
    g.scale(rep.scale, rep.scale);
    drawReverseArrow(g, state?.rotation ?? 0, accent, a, whole, main, side, dim);
    g.restore();
  }

  /** DrawableSliderBall → ArgonSliderBall */
  private drawProceduralSliderBall(g: CanvasRenderingContext2D, slider: Slider, time: number, sliderAlpha: number): void {
    const v = this.getSliderVis(slider);
    const a = sliderAlpha * v.ballAlpha.at(time) * v.argonBallAlpha.at(time);
    if (a <= 0) return;
    const ss = this.sliderStates.get(slider)!;
    const progress = this.sliderProgress(slider, time);
    const pos = slider.stackedPositionAt(progress);
    // DrawableSliderBall.UpdateProgress: 0.1 / slider.Path.Distance is the additional progress needed to ensure the diff length is 0.1
    const checkDistance = 0.1 / slider.path.distance;
    const p1 = slider.curvePositionAt(Math.min(1 - checkDistance, progress));
    const p2 = slider.curvePositionAt(Math.min(1, progress + checkDistance));
    const dx = p1.x - p2.x;
    const dy = p1.y - p2.y;
    // Ensure the value is substantially high enough to allow for Atan2 to get a valid angle.
    if (Math.hypot(dx, dy) >= 0.01) ss.ballRotation = -90 + (-Math.atan2(dx, dy) * 180) / Math.PI;
    g.save();
    g.translate(pos.x, pos.y);
    g.scale(slider.scale, slider.scale);
    drawSliderBall(g, ss.ballRotation, this.accent(slider), a, v.iconScale.at(time));
    g.restore();
  }

  /** ArgonFollowCircle (inside DrawableSliderBall) */
  private drawProceduralFollowCircle(g: CanvasRenderingContext2D, slider: Slider, time: number, sliderAlpha: number): void {
    const v = this.getSliderVis(slider);
    const ss = this.sliderStates.get(slider)!;
    const a = sliderAlpha * v.ballAlpha.at(time) * ss.followAlpha.at(time);
    if (a <= 0) return;
    const pos = slider.stackedPositionAt(this.sliderProgress(slider, time));
    g.save();
    g.translate(pos.x, pos.y);
    drawFollowCircle(g, ss.followScale.at(time) * slider.scale, this.accent(slider), a);
    g.restore();
  }

  /** DrawableSpinner with ArgonSpinner */
  private drawSpinner(g: CanvasRenderingContext2D, spinner: Spinner, time: number): void {
    const v = this.getSpinnerVis(spinner);
    const alpha = v.alpha.at(time);
    if (alpha <= 0) return;
    const st = this.spinnerStates.get(spinner)!;
    let bonus: ArgonSpinnerState['bonus'] = null;
    if (st.bonus) {
      const since = time - st.bonus.time;
      if (since >= 0) {
        const max = st.bonus.max;
        bonus = {
          text: st.bonus.text,
          scale: valueAt(since, 1.5, max ? 2.8 : 1, 0, 1000, Easing.OutQuint),
          alpha: 1 - clamp(since / (max ? 500 : 1500), 0, 1),
          flash: max ? 1 - clamp(since / 400, 0, 1) : 0,
        };
      }
    }
    const spm = st.timeStarted != null ? { text: String(Math.trunc(st.spm.result)), alpha: clamp((time - st.timeStarted) / spinner.timeFadeIn, 0, 1) } : null;
    const state: ArgonSpinnerState = {
      alpha,
      discScale: v.discScale.at(time),
      centreScale: v.centreScale.at(time),
      centreSize: st.trackingElementInterpolation * (40 - 80) + 80,
      fillAlpha: st.fillFlash ? st.fillFlash.at(time) : st.fillAlpha,
      fillScale: st.fillScale,
      ticksRotation: v.ticksRotation.at(time) + st.displayRotation,
      ringArcProgress: st.ringArcProgress,
      ringArcRadius: st.ringArcRadius,
      progressBackgroundAlpha: this.progress(spinner, st) >= 1 ? 0 : 1,
      progressFillAlpha: st.progressFillAlpha,
      progressFill: st.progressFill,
      bonus,
      spm,
    };
    g.save();
    g.translate(spinner.position.x, spinner.position.y);
    drawArgonSpinner(g, state);
    g.restore();
  }

  /** FollowPointRenderer / FollowPointConnection with ArgonFollowPoint */
  private drawFollowPoints(g: CanvasRenderingContext2D, time: number): void {
    const objs = this.objects;
    while (this.followPointIndex < objs.length - 1 && objs[this.followPointIndex + 1].startTime + 400 < time) this.followPointIndex++;
    for (let i = this.followPointIndex; i < objs.length - 1; i++) {
      const start = objs[i];
      const end = objs[i + 1];
      // follow points can appear at most FOLLOW_POINT_PREEMPT before the start object's end time.
      if (start.startTime - FOLLOW_POINT_PREEMPT > time) break;
      // FollowPointLifetimeEntry: no connection to new combos or from / to spinners.
      if (end.newCombo || start instanceof Spinner || end instanceof Spinner) continue;
      const startTime = start.endTime;
      if (time > end.startTime + 400) continue;
      const startPosition = start.stackedEndPosition;
      const endPosition = end.stackedPosition;
      const dx = endPosition.x - startPosition.x;
      const dy = endPosition.y - startPosition.y;
      const distance = Math.trunc(Math.hypot(dx, dy));
      const rotation = Math.atan2(dy, dx);
      const duration = end.startTime - startTime;
      // Preempt time can go below 800ms (AR > 10 via mods).
      const preempt = FOLLOW_POINT_PREEMPT * Math.min(1, start.timePreempt / PREEMPT_MIN);
      for (let d = Math.trunc(FOLLOW_POINT_SPACING * 1.5); d < distance - FOLLOW_POINT_SPACING; d += FOLLOW_POINT_SPACING) {
        const fraction = Math.fround(d / distance);
        const fadeOutTime = startTime + fraction * duration;
        const fadeInTime = fadeOutTime - preempt;
        if (time < fadeInTime || time > fadeOutTime + 400) continue;
        // stable uses HitObjectManager.TimeFadeIn (a constant 400) for this.
        const fadeDuration = 400;
        // FadeIn(400), then Delay(fadeOutTime - fadeInTime).FadeOut(400) (which starts from the alpha reached by then).
        const alpha =
          time < fadeOutTime
            ? clamp((time - fadeInTime) / fadeDuration, 0, 1)
            : clamp((fadeOutTime - fadeInTime) / fadeDuration, 0, 1) * (1 - clamp((time - fadeOutTime) / fadeDuration, 0, 1));
        const move = applyEasing(Easing.Out, clamp((time - fadeInTime) / fadeDuration, 0, 1));
        const f = fraction - 0.1 + 0.1 * move;
        const sc = valueAt(time, 1.5 * end.scale, end.scale, fadeInTime, fadeInTime + fadeDuration, Easing.Out);
        g.save();
        g.translate(startPosition.x + f * dx, startPosition.y + f * dy);
        g.rotate(rotation);
        g.scale(sc, sc);
        drawArgonFollowPoint(g, alpha);
        g.restore();
      }
    }
  }

  /** DrawableOsuJudgement with ArgonJudgementPiece / ArgonJudgementPieceSliderTickMiss. */
  private drawJudgements(g: CanvasRenderingContext2D, time: number, above: boolean): void {
    for (const j of this.judgements) {
      const since = time - j.time;
      if (since < 0) continue;
      g.save();
      g.translate(j.x, j.y);
      g.scale(j.scale, j.scale);
      if (j.kind === 'tickMiss') {
        if (above) drawTickMiss(g, j.result, since);
      } else if (above) drawJudgementText(g, j.result, since);
      else drawRingExplosion(g, j.particles, j.result, since);
      g.restore();
    }
  }

  /** CursorTrail.AddTrail (interpolated parts at a fixed interval). */
  private addTrail(p: Vec2): void {
    if (!this.showCursorTrail || (this.legacy && this.legacy.has.cursorTrail)) return;
    const now = realTime();
    const last = this.lastTrailPosition;
    if (!last) {
      this.lastTrailPosition = { x: p.x, y: p.y };
      return;
    }
    const dx = p.x - last.x;
    const dy = p.y - last.y;
    const distance = Math.hypot(dx, dy);
    if (distance <= 0) return;
    // ArgonCursorTrail.IntervalMultiplier = 0.4
    const interval = ((TRAIL_TEXTURE_WIDTH * this.cursorScale) / 2.5) * 0.4;
    const expand = this.cursorExpand.at(this.lastUpdateTime);
    let x = last.x;
    let y = last.y;
    for (let d = interval; d < distance; d += interval) {
      x = last.x + (dx / distance) * d;
      y = last.y + (dy / distance) * d;
      this.trail.push({ x, y, time: now, scale: expand });
    }
    this.lastTrailPosition = { x, y };
    if (this.trail.length > 2048) this.trail.splice(0, this.trail.length - 2048);
  }

  /** OsuCursor (ArgonCursor) + ArgonCursorTrail, in playfield space. */
  private drawCursor(g: CanvasRenderingContext2D, time: number, withTrail: boolean): void {
    const size = CURSOR_SIZE * this.cursorScale;
    if (withTrail && this.showCursorTrail) {
      const now = realTime();
      while (this.trail.length > 0 && now - this.trail[0].time >= TRAIL_FADE_DURATION) this.trail.shift();
      g.save();
      g.globalCompositeOperation = 'lighter';
      for (const p of this.trail) {
        // CursorTrail shader: alpha = (1 - age)^FadeExponent (ArgonCursorTrail: 4), Alpha = 0.8
        const age = (now - p.time) / TRAIL_FADE_DURATION;
        const a = 0.8 * Math.pow(Math.max(0, 1 - age), 4);
        drawTrailPart(g, p.x, p.y, TRAIL_TEXTURE_WIDTH * 0.8 * p.scale * this.cursorScale, a);
      }
      g.restore();
    }
    g.save();
    g.translate(this.cursor.x, this.cursor.y);
    drawArgonCursor(g, size, this.cursorExpand.at(time));
    g.restore();
  }

  dispose(): void {
    this.legacy?.dispose();
    for (const ss of this.sliderStates.values()) ss.slideLoop?.forEach(l => l.stop());
    for (const st of this.spinnerStates.values()) st.spinLoop?.stop();
  }
}

/** Interpolation.Damp */
function valueDamp(start: number, final: number, base: number, exponent: number): number {
  return start + (final - start) * (1 - Math.pow(base, exponent));
}

/** DrawableExtensions.Shake(shakeDuration: 30, shakeMagnitude: 8) */
function applyShake(prop: Prop, time: number): void {
  const d = 30;
  const m = 8;
  let t = prop.to(time, m, d / 2, Easing.OutSine);
  t = prop.to(t, -m, d, Easing.InOutSine);
  t = prop.to(t, m, d, Easing.InOutSine);
  t = prop.to(t, -m, d, Easing.InOutSine);
  prop.to(t, 0, d / 2, Easing.InSine);
}

/** ArgonFollowCircle.OnSliderPress */
function followOnSliderPress(ss: SliderState, time: number): void {
  const duration = 300;
  if (Math.abs(ss.followAlpha.at(time)) < 1e-3) ss.followScale.to(time, 1);
  ss.followScale.to(time, FOLLOW_AREA, duration, Easing.OutQuint);
  ss.followAlpha.to(time, 1, duration, Easing.OutQuint);
}

/** ArgonFollowCircle.OnSliderRelease */
function followOnSliderRelease(ss: SliderState, time: number): void {
  const duration = 150;
  ss.followScale.to(time, FOLLOW_AREA * 1.2, duration, Easing.OutQuint);
  ss.followAlpha.to(time, 0, duration, Easing.OutQuint);
}

/** ArgonFollowCircle.OnSliderEnd */
function followOnSliderEnd(ss: SliderState, time: number): void {
  const duration = 300;
  ss.followScale.to(time, 1, duration, Easing.OutQuint);
  ss.followAlpha.to(time, 0, duration / 2, Easing.OutQuint);
}

/** ArgonFollowCircle.OnSliderTick */
function followOnSliderTick(ss: SliderState, time: number): void {
  if (ss.followScale.at(time) >= FOLLOW_AREA * 0.98) {
    const end = ss.followScale.to(time, FOLLOW_AREA * 1.08, 40, Easing.OutQuint);
    ss.followScale.to(end, FOLLOW_AREA, 200, Easing.OutQuint);
  }
}

/** CursorTrail runs on its own (wall-clock) FramedClock. */
function realTime(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function createCanvas(w: number, h: number): HTMLCanvasElement | OffscreenCanvas | null {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}
