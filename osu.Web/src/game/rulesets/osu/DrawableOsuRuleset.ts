// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Gameplay for osu! standard. Ports the judging logic of DrawableHitCircle, DrawableSlider (+ SliderInputManager),
// DrawableSpinner (+ SpinnerRotationTracker), StartTimeOrderedHitPolicy and OsuAutoGenerator, with a procedural renderer.
// When a legacy skin (.osk / beatmap skin) provides elements, they are drawn by OsuLegacySkinRenderer (legacySkin.ts) instead.

import type { HitSampleInfo } from '../../audio/HitSampleInfo';
import { Vec2, clamp, distanceSq } from '../../../framework/math';
import { HitResult, isHit } from '../../scoring/HitResult';
import type { DrawableRuleset, GameplayContext, LoopHandle } from '../Ruleset';
import { RGB, darken, lighten, rgb, COLOURS } from '../../Skin';
import type { OsuPlayableBeatmap } from './beatmap';
import { OsuLegacySkinRenderer, type OsuLegacyHost } from './legacySkin';
import { osuPlayfieldTransform } from './playfield';
import { resolveComboColours } from '../../skinning/SkinSource';
import {
  HitCircle,
  OsuHitObject,
  PLAYFIELD_HEIGHT,
  PLAYFIELD_WIDTH,
  Slider,
  SliderHeadCircle,
  SliderRepeat,
  SliderTailCircle,
  SliderTick,
  Spinner,
  SpinnerBonusTick,
  SpinnerTick,
} from './objects';

const FOLLOW_AREA = 2.4;
const TAIL_LENIENCY = -36;
const SPIN_RADIUS = 50;
const AUTO_SPIN_RATE = 0.05; // rad/ms (~477 RPM), as per stable
const HD_FADE_IN = 0.4;
const HD_FADE_OUT = 0.3;

type Action = 'LeftButton' | 'RightButton';

interface JudgeState {
  judged: boolean;
  result: HitResult;
  judgedAt: number;
}

interface SliderState {
  tracking: boolean;
  headHitAction: Action | null;
  timeToAcceptAnyKeyAfter: number | null;
  lastPressedActions: Action[];
  slideLoop: LoopHandle[] | null;
  lastTrackingChange: number;
}

interface SpinnerState {
  totalRotation: number;
  displayRotation: number;
  lastAngle: number | null;
  completedFullSpins: number;
  rpmHistory: { time: number; rotation: number }[];
  rpm: number;
  spinLoop: LoopHandle | null;
  bonusPopTime: number;
}

interface Popup {
  x: number;
  y: number;
  result: HitResult;
  time: number;
}

export class DrawableOsuRuleset implements DrawableRuleset {
  readonly drawsCursor = true;
  readonly objects: OsuHitObject[];

  private judge = new Map<OsuHitObject, JudgeState>();
  private sliderStates = new Map<Slider, SliderState>();
  private spinnerStates = new Map<Spinner, SpinnerState>();
  private popups: Popup[] = [];

  /** Cursor in osu! playfield coordinates. */
  private cursor: Vec2 = { x: PLAYFIELD_WIDTH / 2, y: PLAYFIELD_HEIGHT / 2 };
  private cursorTrail: { x: number; y: number; t: number }[] = [];
  private pressed = new Set<Action>();
  private lastUpdateTime = -Infinity;
  private firstActiveIndex = 0;
  private touchActions = new Map<number, Action>();

  // Screen transform (updated every render)
  private scale = 1;
  private offsetX = 0;
  private offsetY = 0;

  // Autoplay
  private autoEvents: { time: number; press: boolean; action: Action }[] = [];
  private autoEventIndex = 0;

  private readonly hidden: boolean;
  private readonly flashlight: boolean;
  private readonly relax: boolean;
  private readonly autopilot: boolean;
  private readonly spunOut: boolean;
  private readonly cursorSize: number;
  private readonly showFollowPoints: boolean;
  private readonly showCursorTrail: boolean;
  private readonly hitLighting: boolean;
  private readonly bodyCache = new Map<Slider, Vec2[]>();
  /** Combo colours in effect (beatmap, then skin, then default). */
  private readonly comboColours: RGB[];
  /** Legacy skin renderer, when a user / beatmap skin is in use. */
  private readonly legacy: OsuLegacySkinRenderer | null = null;

  constructor(
    private readonly playable: OsuPlayableBeatmap,
    private readonly ctx: GameplayContext,
  ) {
    this.objects = playable.hitObjects;
    const mods = ctx.mods;
    this.hidden = mods.has('HD');
    this.flashlight = mods.has('FL');
    this.relax = mods.has('RX');
    this.autopilot = mods.has('AP');
    this.spunOut = mods.has('SO');
    this.cursorSize = ctx.settings.get('osu.cursorSize', 1);
    this.showFollowPoints = ctx.settings.get('osu.followPoints', true);
    this.showCursorTrail = ctx.settings.get('osu.cursorTrail', true);
    this.hitLighting = ctx.settings.get('osu.hitLighting', true);
    this.comboColours = resolveComboColours(ctx.skin);

    for (const h of this.objects) {
      this.judge.set(h, { judged: false, result: HitResult.None, judgedAt: 0 });
      for (const n of h.nested) this.judge.set(n, { judged: false, result: HitResult.None, judgedAt: 0 });
      if (h instanceof Slider)
        this.sliderStates.set(h, { tracking: false, headHitAction: null, timeToAcceptAnyKeyAfter: null, lastPressedActions: [], slideLoop: null, lastTrackingChange: -Infinity });
      if (h instanceof Spinner)
        this.spinnerStates.set(h, { totalRotation: 0, displayRotation: 0, lastAngle: null, completedFullSpins: 0, rpmHistory: [], rpm: 0, spinLoop: null, bonusPopTime: -Infinity });
    }

    if (this.hidden) {
      // OsuModHidden.ApplyToBeatmap: shorter fade-in for every object.
      for (const h of this.objects) {
        h.timeFadeIn = h.timePreempt * HD_FADE_IN;
        for (const n of h.nested) n.timeFadeIn = n.timePreempt * HD_FADE_IN;
      }
    }

    if (ctx.autoplay || this.relax || this.autopilot) this.generateAutoEvents();

    if (ctx.skin.sources && ctx.skin.sources.length > 0) {
      const self = this;
      const host: OsuLegacyHost = {
        judge: h => self.judge.get(h)!,
        sliderTracking: s => self.sliderStates.get(s)!,
        spinner: s => {
          const st = self.spinnerStates.get(s)!;
          return { displayRotation: st.displayRotation, completedFullSpins: st.completedFullSpins, rpm: st.rpm, progress: self.progress(s, st) };
        },
        comboColour: h => self.comboColour(h),
        hiddenAlpha: (h, time, parent) => self.hiddenAlpha(h, time, parent),
        hidden: this.hidden,
        hitLighting: this.hitLighting,
        snakingIn: ctx.settings.get('osu.snakingIn', true),
        snakingOut: ctx.settings.get('osu.snakingOut', true),
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
    if (this.ctx.autoplay || this.relax) return;
    this.updateTo(time);
    if (this.pressed.has(action)) return;
    this.pressed.add(action);
    this.handlePress(action, time);
  }

  onReleased(action: string, time: number): void {
    if (action !== 'LeftButton' && action !== 'RightButton') return;
    if (this.ctx.autoplay || this.relax) return;
    this.updateTo(time);
    this.pressed.delete(action);
  }

  onPointerMove(x: number, y: number, time: number): void {
    if (this.ctx.autoplay || this.autopilot) return;
    this.updateTo(time);
    this.cursor = this.toPlayfield(x, y);
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

  private handlePress(action: Action, time: number): void {
    // Route to the front-most (earliest) unjudged hittable circle under the cursor.
    for (let i = this.firstActiveIndex; i < this.objects.length; i++) {
      const h = this.objects[i];
      if (h.startTime - h.timePreempt > time) break;
      const circle: HitCircle | null = h instanceof HitCircle ? h : h instanceof Slider ? h.headCircle : null;
      if (!circle) continue;
      const st = this.judge.get(circle)!;
      if (st.judged) continue;
      if (time < circle.startTime - circle.timePreempt) continue;
      if (!this.relax && !this.autopilot && distanceSq(this.cursor, circle.stackedPosition) > circle.radius * circle.radius) continue;
      this.tryHitCircle(circle, time, action);
      return; // input consumed even when the hit was blocked (shake)
    }
  }

  /** DrawableHitCircle.CheckForResult(userTriggered: true) + StartTimeOrderedHitPolicy */
  private tryHitCircle(circle: HitCircle, time: number, action: Action): void {
    const timeOffset = time - circle.startTime;
    const result = circle.hitWindows.resultFor(timeOffset);

    // Blocking: an earlier circle which hasn't been judged and whose start time hasn't arrived yet.
    let blocked = false;
    this.forEachCircleUpTo(circle.startTime, c => {
      const s = this.judge.get(c)!;
      if (!s.judged && time < c.startTime) blocked = true;
    });
    if (blocked || result === HitResult.None) return; // shake

    this.applyResult(circle, result, timeOffset);
    if (circle instanceof SliderHeadCircle) {
      const ss = this.sliderStates.get(circle.slider)!;
      ss.headHitAction = action;
    }

    // HandleHit: miss every earlier unjudged circle.
    this.forEachCircleUpTo(circle.startTime, c => {
      const s = this.judge.get(c)!;
      if (!s.judged) this.applyResult(c, HitResult.Miss, time - c.startTime);
    });

    if (circle instanceof SliderHeadCircle) this.postProcessHeadJudgement(circle.slider, time);
  }

  private forEachCircleUpTo(targetTime: number, fn: (c: HitCircle) => void): void {
    for (let i = this.firstActiveIndex; i < this.objects.length; i++) {
      const h = this.objects[i];
      if (h.startTime >= targetTime) break;
      if (h instanceof HitCircle) fn(h);
      else if (h instanceof Slider && h.headCircle.startTime < targetTime) fn(h.headCircle);
    }
  }

  // ---------------------------------------------------------------- judging

  private applyResult(h: OsuHitObject, type: HitResult, timeOffset: number): void {
    const s = this.judge.get(h)!;
    if (s.judged) return;
    s.judged = true;
    s.result = type;
    s.judgedAt = h.endTime + timeOffset;
    if (h instanceof HitCircle ? !(h instanceof SliderHeadCircle || h instanceof SliderRepeat || h instanceof SliderTailCircle) : h instanceof Slider || h instanceof Spinner) this.judgedTopLevel++;

    const parent = h instanceof SliderHeadCircle || h instanceof SliderTick || h instanceof SliderRepeat || h instanceof SliderTailCircle ? this.parentSlider(h) : null;
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

    const pan = (h.stackedPosition.x / PLAYFIELD_WIDTH - 0.5) * 0.8;
    if (isHit(type)) {
      if (h instanceof SliderTailCircle) {
        // DrawableSlider plays the tail samples when the tail is hit.
        this.ctx.playSamples(h.slider.tailSamples, { pan });
      } else if (!(h instanceof Spinner) && !(h instanceof Slider) && h.samples.length > 0) {
        this.ctx.playSamples(h.samples, { pan });
      }
    }

    // Legacy skin judgements (DrawableOsuJudgement), slider follow circle reactions and hit lighting.
    const parentSlider = parent instanceof Slider ? parent : null;
    if (this.legacy) {
      this.legacy.onResult(h, type, s.judgedAt, parentSlider);
      const displayed = !(h instanceof Slider) && !(h instanceof SpinnerTick);
      if (displayed && this.legacy.handlesJudgement(type)) return;
    }

    // Judgement popups for main objects.
    if (h instanceof HitCircle && !(h instanceof SliderTailCircle) && !(h instanceof SliderRepeat)) this.addPopup(h, type);
    else if (h instanceof Spinner) this.addPopup(h, type);
    else if (type === HitResult.LargeTickMiss || (h instanceof SliderTailCircle && !isHit(type))) this.addPopup(h, HitResult.LargeTickMiss);
  }

  private parentSlider(h: OsuHitObject): Slider | null {
    if (h instanceof SliderHeadCircle || h instanceof SliderRepeat || h instanceof SliderTailCircle) return h.slider;
    // Ticks don't reference their slider; find it.
    for (let i = this.firstActiveIndex; i < this.objects.length; i++) {
      const o = this.objects[i];
      if (o instanceof Slider && o.ticks.includes(h as SliderTick)) return o;
      if (o.startTime > h.startTime) break;
    }
    return null;
  }

  private addPopup(h: OsuHitObject, result: HitResult): void {
    const p = h instanceof Spinner ? { x: PLAYFIELD_WIDTH / 2, y: PLAYFIELD_HEIGHT / 2 } : h.stackedPosition;
    this.popups.push({ x: p.x, y: p.y, result, time: this.lastUpdateTime });
  }

  update(time: number, _elapsed: number): void {
    // Autoplay / relax / autopilot drive inputs at exact times.
    if (this.autoEvents.length > 0) {
      while (this.autoEventIndex < this.autoEvents.length && this.autoEvents[this.autoEventIndex].time <= time) {
        const e = this.autoEvents[this.autoEventIndex++];
        this.updateTo(e.time);
        if (this.ctx.autoplay) this.cursor = this.autoCursorAt(e.time);
        if (e.press) {
          if (!this.pressed.has(e.action)) {
            this.pressed.add(e.action);
            this.handlePress(e.action, e.time);
          }
        } else this.pressed.delete(e.action);
      }
      if (this.ctx.autoplay || this.autopilot) this.cursor = this.autoCursorAt(time);
    }
    this.updateTo(time);
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

    // Advance past fully finished objects (keep them a while for fade-out drawing).
    while (this.firstActiveIndex < this.objects.length) {
      const h = this.objects[this.firstActiveIndex];
      const s = this.judge.get(h)!;
      if (s.judged && time > Math.max(h.endTime, s.judgedAt) + 1000) this.firstActiveIndex++;
      else break;
    }

    const cutoff = time - 800;
    while (this.popups.length > 0 && this.popups[0].time < cutoff) this.popups.shift();
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

    if (!this.judge.get(head)!.judged) {
      const timeOffset = time - head.startTime;
      if (!head.hitWindows.canBeHit(timeOffset)) {
        this.applyResult(head, HitResult.Miss, timeOffset);
        this.postProcessHeadJudgement(slider, time);
      }
    }

    this.updateTracking(slider, ss, this.isMouseInFollowArea(slider, time, ss.tracking), time);

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
          const lastTick = [...slider.nested].reverse().find(o => o instanceof SliderTick || o instanceof SliderRepeat);
          if (lastTick && !this.judge.get(lastTick)!.judged) break;
        }
        if (ss.tracking) this.applyResult(n, n.judgement.maxResult, timeOffset);
        else if (timeOffset >= 0) this.applyResult(n, n.judgement.minResult, timeOffset);
        else break;
      }
    }

    // DrawableSlider.CheckForResult: once the tail is judged, judge the slider itself.
    if (!sliderJudge.judged && this.judge.get(slider.tailCircle)!.judged) {
      const anyHit = slider.nested.some(n => isHit(this.judge.get(n)!.result));
      this.applyResult(slider, anyHit ? HitResult.IgnoreHit : HitResult.IgnoreMiss, time - slider.endTime);
    }

    // Sliding sample loop
    const shouldSlide = ss.tracking && time >= slider.startTime && time < slider.endTime;
    if (shouldSlide && !ss.slideLoop) {
      ss.slideLoop = slider.slidingSamples.map(s => this.ctx.startLoop(s, { volume: 1 })).filter((l): l is LoopHandle => l != null);
    } else if (!shouldSlide && ss.slideLoop) {
      for (const l of ss.slideLoop) l.stop();
      ss.slideLoop = null;
    }
    if (ss.slideLoop) {
      const pan = (slider.stackedPositionAt(this.sliderProgress(slider, time)).x / PLAYFIELD_WIDTH - 0.5) * 0.8;
      for (const l of ss.slideLoop) l.setPan(pan);
    }
  }

  private sliderProgress(slider: Slider, time: number): number {
    return clamp((time - slider.startTime) / slider.duration, 0, 1);
  }

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
    const headCircleHitAction = this.judge.get(slider.headCircle)!.judged ? ss.headHitAction : null;
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
    if (this.relax) validTrackingAction = true;

    const allJudged = slider.nested.every(n => this.judge.get(n)!.judged);
    ss.tracking = (!allJudged || time <= slider.endTime) && isValidTrackingPosition && validTrackingAction;
    if (wasTracking !== ss.tracking) ss.lastTrackingChange = time;
  }

  /** DrawableSpinner + SpinnerRotationTracker */
  private updateSpinner(spinner: Spinner, time: number, elapsed: number): void {
    const st = this.spinnerStates.get(spinner)!;
    const s = this.judge.get(spinner)!;
    const centre = spinner.position;
    const spinnable = time >= spinner.startTime && time <= spinner.endTime;

    const tracking = spinnable && !s.judged && (this.pressed.size > 0 || this.relax || this.spunOut || this.ctx.autoplay);

    if (this.spunOut || this.ctx.autoplay) {
      // OsuModSpunOut / autoplay spin at a fixed rate.
      if (tracking) this.addRotation(spinner, st, (AUTO_SPIN_RATE * elapsed * 180) / Math.PI / Math.max(0.0001, this.ctx.rate), time);
    } else {
      const thisAngle = -(Math.atan2(this.cursor.x - centre.x, this.cursor.y - centre.y) * 180) / Math.PI;
      let delta = st.lastAngle == null ? 0 : thisAngle - st.lastAngle;
      if (delta > 180) delta -= 360;
      if (delta < -180) delta += 360;
      if (tracking) this.addRotation(spinner, st, delta, time);
      st.lastAngle = thisAngle;
    }
    st.displayRotation += (st.totalRotation - st.displayRotation) * (1 - Math.pow(0.01, elapsed / 1000));

    // Spin loop sample
    const spinning = tracking && st.rpm > 30;
    if (spinning && !st.spinLoop) {
      const sample = spinner.spinningSamples[0];
      st.spinLoop = sample ? this.ctx.startLoop(sample, { volume: 0.6 }) : null;
    } else if (!spinning && st.spinLoop) {
      st.spinLoop.stop();
      st.spinLoop = null;
    }
    // SpinnerFrequencyModulate (skin.ini) disables the pitch change.
    if (st.spinLoop) st.spinLoop.setRate(this.legacy && !this.legacy.spinnerFrequencyModulate ? 1 : Math.min(1.6, 0.5 + this.progress(spinner, st) * 0.5));

    // CheckForResult
    if (time < spinner.startTime || s.judged) return;
    if (time < spinner.endTime) return;

    for (const t of spinner.ticks) if (!this.judge.get(t)!.judged) this.applyResult(t, HitResult.IgnoreMiss, time - t.startTime);

    const progress = this.progress(spinner, st);
    let result: HitResult;
    if (progress >= 1) result = HitResult.Great;
    else if (progress > 0.9) result = HitResult.Ok;
    else if (progress > 0.75) result = HitResult.Meh;
    else result = HitResult.Miss;
    this.applyResult(spinner, result, time - spinner.endTime);
    if (isHit(result)) this.ctx.playSamples(spinner.samples, { pan: 0 });
    if (st.spinLoop) {
      st.spinLoop.stop();
      st.spinLoop = null;
    }
  }

  private progress(spinner: Spinner, st: SpinnerState): number {
    if (spinner.spinsRequired === 0) return 1;
    return clamp(Math.abs(st.totalRotation) / 360 / spinner.spinsRequired, 0, 1);
  }

  private addRotation(spinner: Spinner, st: SpinnerState, delta: number, time: number): void {
    delta *= Math.abs(this.ctx.rate);
    st.totalRotation += delta;
    st.rpmHistory.push({ time, rotation: st.totalRotation });
    while (st.rpmHistory.length > 0 && st.rpmHistory[0].time < time - 595) st.rpmHistory.shift();
    if (st.rpmHistory.length > 1) {
      const first = st.rpmHistory[0];
      const dt = time - first.time;
      if (dt > 0) st.rpm = (Math.abs(st.totalRotation - first.rotation) / 360 / (dt / this.ctx.rate)) * 60000;
    }
    const spins = Math.floor(Math.abs(st.totalRotation) / 360);
    while (st.completedFullSpins < spins) {
      const tick = spinner.ticks.find(t => !this.judge.get(t)!.judged);
      if (!tick) break;
      this.applyResult(tick, tick.judgement.maxResult, time - tick.startTime);
      if (tick instanceof SpinnerBonusTick) {
        this.ctx.playSamples(tick.samples, { pan: 0 });
        st.bonusPopTime = time;
      }
      st.completedFullSpins++;
    }
  }

  // ---------------------------------------------------------------- autoplay

  private generateAutoEvents(): void {
    // Port of OsuAutoGenerator key timing: alternate keys when objects are close together, hold through sliders and spinners.
    const events: { time: number; press: boolean; action: Action }[] = [];
    const KEY_UP_DELAY = 50;
    let lastAction: Action = 'RightButton';
    let lastEnd = -Infinity;
    const actionFree: Record<Action, number> = { LeftButton: -Infinity, RightButton: -Infinity };
    for (const h of this.objects) {
      const start = h.startTime;
      const end = h instanceof Slider || h instanceof Spinner ? h.endTime : start;
      // Alternate if the previous key is still held or objects are close; otherwise reuse the left key.
      let action: Action = start - lastEnd < 266 ? (lastAction === 'LeftButton' ? 'RightButton' : 'LeftButton') : 'LeftButton';
      if (actionFree[action] > start) action = action === 'LeftButton' ? 'RightButton' : 'LeftButton';
      const release = Math.max(end + KEY_UP_DELAY, start + KEY_UP_DELAY);
      events.push({ time: start, press: true, action });
      events.push({ time: release, press: false, action });
      actionFree[action] = release;
      lastAction = action;
      lastEnd = end;
    }
    events.sort((a, b) => a.time - b.time || (a.press === b.press ? 0 : a.press ? 1 : -1));
    if (this.autopilot) {
      // Autopilot: only cursor movement is automated.
      this.autoEvents = [];
      this.autoEventIndex = 0;
      this.autoEvents.push({ time: Infinity, press: false, action: 'LeftButton' });
      return;
    }
    this.autoEvents = events;
  }

  /** Autoplay cursor position (OsuAutoGenerator movement with ease-out between objects). */
  private autoCursorAt(time: number): Vec2 {
    const objs = this.objects;
    // Find the object active at or next after `time`.
    let i = this.firstActiveIndex;
    while (i < objs.length && objs[i].endTime < time) i++;
    // When objects overlap in time (e.g. a circle starting exactly as a slider ends), follow the latest-starting one.
    while (i + 1 < objs.length && objs[i + 1].startTime <= time) i++;
    const next = objs[i];
    const prev = i > 0 ? objs[i - 1] : null;
    if (!next) return prev ? prev.stackedEndPosition : this.cursor;

    if (time >= next.startTime) {
      if (next instanceof Slider) return next.stackedPositionAt(this.sliderProgress(next, time));
      if (next instanceof Spinner) return this.spinPosition(next, time);
      return next.stackedPosition;
    }

    const from = prev ? (prev instanceof Spinner ? this.spinPosition(prev, prev.endTime) : prev.stackedEndPosition) : { x: PLAYFIELD_WIDTH / 2, y: PLAYFIELD_HEIGHT / 2 };
    const target = next instanceof Spinner ? this.spinPosition(next, next.startTime) : next.stackedPosition;
    const prevEnd = prev ? prev.endTime : next.startTime - next.timePreempt;
    // Begin moving at most `reactionTime` before the next object (stable uses ~ preempt-based reaction).
    const moveStart = Math.max(prevEnd, next.startTime - Math.max(100, Math.min(next.timePreempt, 400)));
    const t = clamp((time - moveStart) / Math.max(1, next.startTime - moveStart), 0, 1);
    const eased = 1 - (1 - t) * (1 - t);
    return { x: from.x + (target.x - from.x) * eased, y: from.y + (target.y - from.y) * eased };
  }

  private spinPosition(spinner: Spinner, time: number): Vec2 {
    const angle = (time - spinner.startTime) * AUTO_SPIN_RATE;
    return { x: spinner.position.x + Math.sin(angle) * SPIN_RADIUS, y: spinner.position.y - Math.cos(angle) * SPIN_RADIUS };
  }

  // ---------------------------------------------------------------- rendering

  render(g: CanvasRenderingContext2D, width: number, height: number, time: number): void {
    // OsuPlayfieldAdjustmentContainer: 4:3 playfield taking 80% of the available space, shifted down slightly like stable.
    const transform = osuPlayfieldTransform(width, height);
    const scale = transform.scale;
    this.scale = scale;
    this.offsetX = transform.offsetX;
    this.offsetY = transform.offsetY;

    g.save();
    g.translate(this.offsetX, this.offsetY);
    g.scale(scale, scale);

    const L = this.legacy;
    if (this.showFollowPoints) {
      if (L?.has.followPoint) L.drawFollowPoints(g, time, this.firstActiveIndex);
      else this.drawFollowPoints(g, time);
    }
    // judgementLayer (hit lighting, new-style judgements) is below the hit objects.
    L?.drawJudgementsBelow(g, time);

    // Later objects are drawn below earlier ones.
    let last = this.firstActiveIndex;
    while (last < this.objects.length && this.objects[last].startTime - this.objects[last].timePreempt <= time) last++;
    for (let i = last - 1; i >= this.firstActiveIndex; i--) {
      const h = this.objects[i];
      if (h instanceof Slider) this.drawSlider(g, h, time);
      else if (h instanceof Spinner) {
        if (L?.has.spinner) L.drawSpinner(g, h, time);
        else this.drawSpinner(g, h, time);
      } else if (h instanceof HitCircle) this.drawCircleObject(g, h, time, true);
    }
    // judgementAboveHitObjectLayer (old-style legacy judgements).
    L?.drawJudgementsAbove(g, time);
    // Approach circles go above everything (separate layer in lazer).
    if (!this.hidden) {
      for (let i = last - 1; i >= this.firstActiveIndex; i--) {
        const h = this.objects[i];
        const c = h instanceof HitCircle ? h : h instanceof Slider ? h.headCircle : null;
        if (!c) continue;
        if (L?.has.approachCircle) L.drawApproachCircle(g, c, h, time);
        else this.drawApproachCircle(g, c, h, time);
      }
    }
    this.drawPopups(g, time);
    g.restore();

    if (this.flashlight) this.drawFlashlight(g, width, height, time);
    if (L && (L.has.cursor || L.has.cursorTrail)) {
      L.drawCursor(g, this.cursor.x, this.cursor.y, this.pressed.size > 0, time, this.scale, this.offsetX, this.offsetY, this.cursorSize, this.showCursorTrail, this.cursorSize);
      if (!L.has.cursor) this.drawCursor(g, time, false);
    } else this.drawCursor(g, time, true);
  }

  private comboColour(h: OsuHitObject): RGB {
    const colours = this.comboColours;
    const i = h.comboIndexWithOffsets;
    return colours[((i % colours.length) + colours.length) % colours.length];
  }

  private alphaFor(h: OsuHitObject, time: number, parent: OsuHitObject = h): number {
    const appear = h.startTime - h.timePreempt;
    const a = clamp((time - appear) / Math.max(1, h.timeFadeIn), 0, 1);
    return a * this.hiddenAlpha(h, time, parent);
  }

  /** The Hidden mod's fade-out factor (1 without Hidden). */
  private hiddenAlpha(h: OsuHitObject, time: number, parent: OsuHitObject = h): number {
    if (!this.hidden) return 1;
    const fadeOutStart = h.startTime - h.timePreempt + h.timeFadeIn;
    const duration = parent instanceof Slider && h === parent ? parent.endTime - fadeOutStart : h.timePreempt * HD_FADE_OUT;
    return 1 - clamp((time - fadeOutStart) / Math.max(1, duration), 0, 1);
  }

  private drawCircleObject(g: CanvasRenderingContext2D, c: HitCircle, time: number, showNumber: boolean, parentForColour?: OsuHitObject): void {
    if (this.legacy?.has.hitCircle) {
      this.legacy.drawHitCircle(g, c, time, 'all', parentForColour ?? c);
      return;
    }
    const s = this.judge.get(c)!;
    const colourSource = parentForColour ?? c;
    const colour = this.comboColour(colourSource);
    const pos = c.stackedPosition;
    const r = c.radius;
    let alpha = this.alphaFor(c, time);
    let scale = 1;

    if (s.judged) {
      const since = time - s.judgedAt;
      if (isHit(s.result)) {
        if (this.hidden) return;
        const d = 240;
        if (since > d) return;
        alpha = 1 - since / d;
        scale = 1 + 0.4 * (since / d);
        if (this.hitLighting && since < 120 && !this.legacy?.has.lighting) {
          g.globalAlpha = (1 - since / 120) * 0.5;
          g.fillStyle = rgb(lighten(colour, 0.4));
          g.beginPath();
          g.arc(pos.x, pos.y, r * 1.6 * scale, 0, Math.PI * 2);
          g.fill();
        }
      } else {
        const d = 160;
        if (since > d) return;
        alpha *= 1 - since / d;
      }
    }
    if (alpha <= 0) return;

    g.globalAlpha = alpha;
    drawCirclePiece(g, pos.x, pos.y, r * scale, colour);
    if (showNumber && !s.judged) {
      g.fillStyle = '#fff';
      g.font = `600 ${Math.round(r * 0.75)}px "Torus", "Exo 2", system-ui, sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(String(colourSource.indexInCurrentCombo + 1), pos.x, pos.y + r * 0.04);
    }
    g.globalAlpha = 1;
  }

  private drawApproachCircle(g: CanvasRenderingContext2D, c: HitCircle, parent: OsuHitObject, time: number): void {
    const s = this.judge.get(c)!;
    if (s.judged) return;
    const appear = c.startTime - c.timePreempt;
    if (time < appear || time > c.startTime + 100) return;
    const t = clamp((time - appear) / c.timePreempt, 0, 1);
    const scale = 4 - 3 * t;
    const alpha = clamp(((time - appear) / Math.min(c.timeFadeIn * 2, c.timePreempt)) * 0.9, 0, 0.9) * (time > c.startTime ? 1 - (time - c.startTime) / 100 : 1);
    const pos = c.stackedPosition;
    g.globalAlpha = alpha;
    g.strokeStyle = rgb(lighten(this.comboColour(parent), 0.2));
    g.lineWidth = c.radius * 0.08;
    g.beginPath();
    g.arc(pos.x, pos.y, c.radius * scale, 0, Math.PI * 2);
    g.stroke();
    g.globalAlpha = 1;
  }

  private sliderBody(slider: Slider): Vec2[] {
    let body = this.bodyCache.get(slider);
    if (!body) {
      body = slider.path.path.map(p => ({ x: p.x, y: p.y }));
      this.bodyCache.set(slider, body);
    }
    return body;
  }

  private drawSlider(g: CanvasRenderingContext2D, slider: Slider, time: number): void {
    const sliderJudge = this.judge.get(slider)!;
    const colour = this.comboColour(slider);
    const r = slider.radius;
    const stacked = slider.stackedPosition;

    let alpha = this.alphaFor(slider, time, slider);
    // Fade out after the slider ends.
    const end = sliderJudge.judged ? Math.max(slider.endTime, sliderJudge.judgedAt) : slider.endTime;
    if (time > end) alpha *= 1 - clamp((time - end) / 240, 0, 1);
    if (alpha <= 0 && !(this.hidden && time < end)) return;

    // Snaking: in over the first third of preempt, out on the final span.
    const appear = slider.startTime - slider.timePreempt;
    const snakeIn = this.ctx.settings.get('osu.snakingIn', true) ? clamp((time - appear) / (slider.timePreempt / 3), 0, 1) : 1;
    let p0 = 0;
    let p1 = snakeIn;
    if (time >= slider.startTime && this.ctx.settings.get('osu.snakingOut', true)) {
      const progress = this.sliderProgress(slider, time);
      const span = Math.min(slider.spanCount - 1, Math.floor(progress * slider.spanCount));
      if (span === slider.spanCount - 1) {
        const pathProgress = slider.progressAt(progress);
        if (span % 2 === 1) p1 = pathProgress;
        else p0 = pathProgress;
      }
    }

    // Legacy skin providing "hitcircle": LegacySliderBody, end circles, reverse arrows, head (+ ball / ticks when provided).
    const L = this.legacy;
    if (L?.has.hitCircle) {
      const bodyAlpha = this.alphaFor(slider, time, slider);
      const points = bodyAlpha > 0 ? (p0 === 0 && p1 === 1 ? this.sliderBody(slider) : slider.path.getPathToProgress(p0, p1)) : [];
      L.drawSlider(g, slider, time, { points, alpha: bodyAlpha }, {
        ticks: () => this.drawSliderTicks(g, slider, time, alpha, colour),
        follow: () => this.drawProceduralFollowCircle(g, slider, time, colour),
        ball: () => this.drawProceduralSliderBall(g, slider, time, colour),
      });
      return;
    }

    if (alpha > 0) {
      const points = p0 === 0 && p1 === 1 ? this.sliderBody(slider) : slider.path.getPathToProgress(p0, p1);
      g.save();
      g.globalAlpha = alpha;
      g.translate(stacked.x, stacked.y);
      g.lineCap = 'round';
      g.lineJoin = 'round';
      const trace = () => {
        g.beginPath();
        g.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i++) g.lineTo(points[i].x, points[i].y);
      };
      if (points.length > 0) {
        trace();
        g.strokeStyle = rgb(this.ctx.skin.sliderBorder ?? [255, 255, 255]);
        g.lineWidth = r * 2 * 0.98;
        g.stroke();
        const track = this.ctx.skin.sliderTrackOverride ?? darken(colour, 0.55);
        g.strokeStyle = rgb(track);
        g.lineWidth = r * 2 * 0.84;
        g.stroke();
        g.strokeStyle = rgb(lighten(track, 0.18));
        g.lineWidth = r * 2 * 0.5;
        g.stroke();
      }
      g.restore();
    }

    // Ticks
    if (L?.has.sliderScorePoint) L.drawSliderTicks(g, slider, time);
    else this.drawSliderTicks(g, slider, time, alpha, colour);

    // Tail circle (drawn under head).
    const tail = slider.tailCircle;
    const tailState = this.judge.get(tail)!;
    if (!tailState.judged || time - tailState.judgedAt < 240) {
      const tp = tail.stackedPosition;
      let a = this.alphaFor(tail, time) * (alpha > 0 ? 1 : 0);
      if (tailState.judged) a *= 1 - (time - tailState.judgedAt) / 240;
      if (a > 0 && slider.repeatCount % 2 === 0) {
        g.globalAlpha = a * 0.85;
        drawCirclePiece(g, tp.x, tp.y, r, colour);
        g.globalAlpha = 1;
      }
    }

    // Repeat arrows
    for (const rep of slider.repeats) {
      const rs = this.judge.get(rep)!;
      if (rs.judged && time - rs.judgedAt > 200) continue;
      let a = clamp((time - (rep.startTime - rep.timePreempt)) / 150, 0, 1);
      if (rs.judged) a *= 1 - (time - rs.judgedAt) / 200;
      if (this.hidden) a *= alpha;
      if (a <= 0) continue;
      const pos = rep.stackedPosition;
      const near = slider.path.positionAt(rep.pathProgress > 0.5 ? rep.pathProgress - 0.01 : rep.pathProgress + 0.01);
      const angle = Math.atan2(stacked.y + near.y - pos.y, stacked.x + near.x - pos.x);
      g.globalAlpha = a;
      drawCirclePiece(g, pos.x, pos.y, r, colour);
      g.save();
      g.translate(pos.x, pos.y);
      g.rotate(angle);
      g.strokeStyle = '#fff';
      g.lineWidth = r * 0.14;
      g.lineCap = 'round';
      g.lineJoin = 'round';
      const pulse = 1 + 0.08 * Math.sin(time / 90);
      g.beginPath();
      g.moveTo(-r * 0.18 * pulse, -r * 0.35 * pulse);
      g.lineTo(r * 0.22 * pulse, 0);
      g.lineTo(-r * 0.18 * pulse, r * 0.35 * pulse);
      g.stroke();
      g.restore();
      g.globalAlpha = 1;
    }

    // Head circle
    this.drawCircleObject(g, slider.headCircle, time, true, slider);

    // Slider ball + follow circle (legacy pieces when a skin provides "sliderb" / "sliderfollowcircle").
    if (L && (L.has.sliderBall || L.has.followCircle)) {
      L.drawBallAndFollowCircle(
        g,
        slider,
        time,
        1,
        () => this.drawProceduralFollowCircle(g, slider, time, colour),
        () => this.drawProceduralSliderBall(g, slider, time, colour),
      );
    } else {
      this.drawProceduralSliderBall(g, slider, time, colour);
      this.drawProceduralFollowCircle(g, slider, time, colour);
    }
  }

  private drawSliderTicks(g: CanvasRenderingContext2D, slider: Slider, time: number, alpha: number, colour: RGB): void {
    const r = slider.radius;
    for (const t of slider.ticks) {
      const ts = this.judge.get(t)!;
      if (ts.judged) continue;
      const a = clamp((time - (t.startTime - t.timePreempt)) / 150, 0, 1) * (this.hidden ? alpha : 1);
      if (a <= 0) continue;
      const p = t.stackedPosition;
      g.globalAlpha = a;
      g.fillStyle = '#fff';
      g.beginPath();
      g.arc(p.x, p.y, r * 0.13, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = rgb(colour);
      g.lineWidth = r * 0.04;
      g.stroke();
    }
    g.globalAlpha = 1;
  }

  private drawProceduralSliderBall(g: CanvasRenderingContext2D, slider: Slider, time: number, colour: RGB): void {
    if (time < slider.startTime || time > slider.endTime + 150) return;
    const r = slider.radius;
    const pos = slider.stackedPositionAt(this.sliderProgress(slider, time));
    const ballAlpha = time > slider.endTime ? 1 - (time - slider.endTime) / 150 : 1;
    g.globalAlpha = ballAlpha;
    g.fillStyle = rgb(lighten(colour, 0.25));
    g.beginPath();
    g.arc(pos.x, pos.y, r * 0.82, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = '#fff';
    g.lineWidth = r * 0.12;
    g.stroke();
    g.globalAlpha = 1;
  }

  private drawProceduralFollowCircle(g: CanvasRenderingContext2D, slider: Slider, time: number, colour: RGB): void {
    if (time < slider.startTime || time > slider.endTime + 150) return;
    const r = slider.radius;
    const ss = this.sliderStates.get(slider)!;
    const pos = slider.stackedPositionAt(this.sliderProgress(slider, time));
    const ballAlpha = time > slider.endTime ? 1 - (time - slider.endTime) / 150 : 1;
    const sinceChange = time - ss.lastTrackingChange;
    const followT = clamp(sinceChange / 180, 0, 1);
    const followScale = ss.tracking ? 1 + (FOLLOW_AREA - 1) * (1 - Math.pow(1 - followT, 3)) : FOLLOW_AREA - (FOLLOW_AREA - 1) * followT;
    const followAlpha = ss.tracking ? followT : 1 - followT;
    if (followAlpha > 0) {
      g.globalAlpha = followAlpha * ballAlpha * 0.9;
      g.strokeStyle = rgb(lighten(colour, 0.5));
      g.lineWidth = r * 0.1;
      g.beginPath();
      g.arc(pos.x, pos.y, r * followScale, 0, Math.PI * 2);
      g.stroke();
      g.globalAlpha *= 0.15;
      g.fillStyle = rgb(colour);
      g.fill();
    }
    g.globalAlpha = 1;
  }

  private drawSpinner(g: CanvasRenderingContext2D, spinner: Spinner, time: number): void {
    const st = this.spinnerStates.get(spinner)!;
    const s = this.judge.get(spinner)!;
    let alpha = clamp((time - (spinner.startTime - spinner.timePreempt)) / spinner.timeFadeIn, 0, 1);
    if (s.judged) alpha *= 1 - clamp((time - s.judgedAt) / 300, 0, 1);
    if (alpha <= 0) return;

    const c = spinner.position;
    const R = 160;
    const progress = this.progress(spinner, st);
    g.save();
    g.globalAlpha = alpha;
    g.translate(c.x, c.y);

    // Background disc
    g.fillStyle = 'rgba(0,0,0,0.45)';
    g.beginPath();
    g.arc(0, 0, R, 0, Math.PI * 2);
    g.fill();

    // Progress ring
    g.strokeStyle = 'rgba(255,255,255,0.15)';
    g.lineWidth = 10;
    g.beginPath();
    g.arc(0, 0, R - 8, 0, Math.PI * 2);
    g.stroke();
    g.strokeStyle = progress >= 1 ? COLOURS.yellow : COLOURS.blue;
    g.beginPath();
    g.arc(0, 0, R - 8, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * progress);
    g.stroke();

    // Rotating segments
    g.rotate((st.displayRotation * Math.PI) / 180);
    g.strokeStyle = '#fff';
    g.lineWidth = 6;
    g.lineCap = 'round';
    for (let i = 0; i < 4; i++) {
      g.beginPath();
      g.arc(0, 0, R * 0.62, (i * Math.PI) / 2 + 0.25, (i * Math.PI) / 2 + Math.PI / 2 - 0.25);
      g.stroke();
    }
    g.rotate((-st.displayRotation * Math.PI) / 180);

    // Centre
    g.fillStyle = progress >= 1 ? COLOURS.yellow : '#fff';
    g.beginPath();
    g.arc(0, 0, 10 + 6 * progress, 0, Math.PI * 2);
    g.fill();

    g.textAlign = 'center';
    g.textBaseline = 'middle';
    if (time < spinner.startTime + 600) {
      g.globalAlpha = alpha * clamp(1 - (time - spinner.startTime) / 600, 0, 1);
      g.font = '700 28px "Torus", system-ui, sans-serif';
      g.fillStyle = '#fff';
      g.fillText('SPIN!', 0, -R * 0.35);
      g.globalAlpha = alpha;
    }
    const bonus = Math.max(0, st.completedFullSpins - spinner.spinsRequiredForBonus);
    if (bonus > 0) {
      const since = time - st.bonusPopTime;
      g.font = `700 ${Math.round(34 + 10 * clamp(1 - since / 200, 0, 1))}px "Torus", system-ui, sans-serif`;
      g.fillStyle = COLOURS.yellow;
      g.fillText(String(bonus * 1000), 0, R * 0.35);
    }
    g.font = '500 16px "Torus", system-ui, sans-serif';
    g.fillStyle = 'rgba(255,255,255,0.8)';
    g.fillText(`${Math.round(st.rpm)} RPM`, 0, R + 24);
    g.restore();
  }

  private drawFollowPoints(g: CanvasRenderingContext2D, time: number): void {
    const objs = this.objects;
    const start = Math.max(0, this.firstActiveIndex - 1);
    g.fillStyle = '#fff';
    for (let i = start; i < objs.length - 1; i++) {
      const a = objs[i];
      const b = objs[i + 1];
      if (b.startTime - b.timePreempt > time) break;
      if (b.newCombo || a instanceof Spinner || b instanceof Spinner) continue;
      const from = a.stackedEndPosition;
      const to = b.stackedPosition;
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const dist = Math.hypot(dx, dy);
      if (dist < a.radius * 2.5) continue;
      const startTime = a.endTime;
      const duration = b.startTime - startTime;
      const spacing = 32;
      const angle = Math.atan2(dy, dx);
      for (let d = a.radius * 1.5; d < dist - b.radius * 1.5; d += spacing) {
        const fraction = d / dist;
        const fadeInTime = startTime + fraction * duration - b.timePreempt;
        const fadeOutTime = startTime + fraction * duration;
        if (time < fadeInTime || time > fadeOutTime + 200) continue;
        let alpha = clamp((time - fadeInTime) / 300, 0, 1);
        if (time > fadeOutTime) alpha *= 1 - (time - fadeOutTime) / 200;
        g.globalAlpha = alpha * 0.55;
        g.save();
        g.translate(from.x + dx * fraction, from.y + dy * fraction);
        g.rotate(angle);
        g.beginPath();
        g.moveTo(-4, -4);
        g.lineTo(2, 0);
        g.lineTo(-4, 4);
        g.lineTo(-2, 0);
        g.closePath();
        g.fill();
        g.restore();
      }
    }
    g.globalAlpha = 1;
  }

  private drawPopups(g: CanvasRenderingContext2D, time: number): void {
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (const p of this.popups) {
      const since = time - p.time;
      if (since < 0 || since > 800) continue;
      let text: string;
      let colour: string;
      switch (p.result) {
        case HitResult.Great:
          continue;
        case HitResult.Ok:
          text = '100';
          colour = COLOURS.ok;
          break;
        case HitResult.Meh:
          text = '50';
          colour = COLOURS.meh;
          break;
        case HitResult.Miss:
          text = '✕';
          colour = COLOURS.miss;
          break;
        case HitResult.LargeTickMiss:
          text = '✕';
          colour = COLOURS.miss;
          break;
        default:
          continue;
      }
      const small = p.result === HitResult.LargeTickMiss;
      const alpha = since < 600 ? 1 : 1 - (since - 600) / 200;
      const rise = p.result === HitResult.Miss || small ? since * 0.02 : 0;
      const sc = since < 100 ? 0.8 + 0.2 * (since / 100) : 1;
      g.globalAlpha = alpha;
      g.font = `700 ${Math.round((small ? 18 : 30) * sc)}px "Torus", system-ui, sans-serif`;
      g.fillStyle = colour;
      g.fillText(text, p.x, p.y + rise);
    }
    g.globalAlpha = 1;
  }

  private drawFlashlight(g: CanvasRenderingContext2D, width: number, height: number, time: number): void {
    // OsuModFlashlight: radius 125 (scaled by playfield), shrinking with combo, larger during breaks.
    const combo = this.ctx.combo;
    let size = 125 * (combo >= 200 ? 0.625 : combo >= 100 ? 0.8125 : 1);
    const inBreak = this.playable.breaks.some(b => time >= b.startTime && time <= b.endTime);
    if (inBreak) size *= 2.5;
    const r = size * this.scale * 1.6;
    const cx = this.offsetX + this.cursor.x * this.scale;
    const cy = this.offsetY + this.cursor.y * this.scale;
    const grad = g.createRadialGradient(cx, cy, r * 0.7, cx, cy, r);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, 'rgba(0,0,0,1)');
    g.fillStyle = grad;
    g.fillRect(0, 0, width, height);
    // Dim during sliders (OsuModFlashlight slider dim).
    const sliding = this.objects.some(h => h instanceof Slider && time >= h.startTime && time <= h.endTime && this.sliderStates.get(h)!.tracking);
    if (sliding) {
      g.fillStyle = 'rgba(0,0,0,0.6)';
      g.fillRect(0, 0, width, height);
    }
  }

  private drawCursor(g: CanvasRenderingContext2D, time: number, withTrail = true): void {
    const x = this.offsetX + this.cursor.x * this.scale;
    const y = this.offsetY + this.cursor.y * this.scale;
    const size = 14 * this.cursorSize * Math.max(0.8, Math.min(1.4, this.scale));
    const pressed = this.pressed.size > 0;

    if (this.showCursorTrail && withTrail) {
      this.cursorTrail.push({ x, y, t: time });
      while (this.cursorTrail.length > 0 && (this.cursorTrail[0].t < time - 120 || this.cursorTrail[0].t > time)) this.cursorTrail.shift();
      for (const p of this.cursorTrail) {
        const a = 1 - (time - p.t) / 120;
        g.globalAlpha = a * 0.35;
        g.fillStyle = COLOURS.pink;
        g.beginPath();
        g.arc(p.x, p.y, size * 0.45, 0, Math.PI * 2);
        g.fill();
      }
      g.globalAlpha = 1;
    }

    const s = pressed ? size * 1.2 : size;
    g.fillStyle = 'rgba(255,102,170,0.25)';
    g.beginPath();
    g.arc(x, y, s * 1.5, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#fff';
    g.beginPath();
    g.arc(x, y, s * 0.7, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = COLOURS.pink;
    g.lineWidth = s * 0.22;
    g.stroke();
  }

  dispose(): void {
    this.legacy?.dispose();
    for (const ss of this.sliderStates.values()) ss.slideLoop?.forEach(l => l.stop());
    for (const st of this.spinnerStates.values()) st.spinLoop?.stop();
  }
}

/** Argon-style circle piece: combo coloured gradient fill with a white border. */
export function drawCirclePiece(g: CanvasRenderingContext2D, x: number, y: number, r: number, colour: RGB): void {
  const grad = g.createRadialGradient(x, y - r * 0.3, r * 0.1, x, y, r);
  grad.addColorStop(0, rgb(lighten(colour, 0.35)));
  grad.addColorStop(1, rgb(darken(colour, 0.15)));
  g.fillStyle = grad;
  g.beginPath();
  g.arc(x, y, r * 0.93, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = '#fff';
  g.lineWidth = r * 0.12;
  g.stroke();
}

export type { HitSampleInfo };
