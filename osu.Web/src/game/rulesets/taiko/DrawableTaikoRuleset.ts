// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Gameplay for osu!taiko. Ports the judging logic of:
//  - osu.Game.Rulesets.Taiko/Objects/Drawables/DrawableHit.cs (+ StrongNestedHit "second hit" judging)
//  - DrawableDrumRoll.cs, DrawableDrumRollTick.cs, DrawableSwell.cs, DrawableSwellTick.cs, DrawableFlyingHit.cs
//  - osu.Game.Rulesets.Taiko/UI/TaikoPlayfield.cs, DrawableTaikoRuleset.cs, DrumSamplePlayer.cs, DrumSampleTriggerSource.cs,
//    DrumTouchInputArea.cs, HitExplosion.cs, KiaiHitExplosion.cs, DrawableTaikoJudgement.cs
//  - Mods: TaikoModHidden, TaikoModFlashlight, TaikoModRelax, ModCinema; Replays: TaikoAutoGenerator / FramedReplayInputHandler.
// Visuals are drawn procedurally after the default ("triangles") taiko skin pieces (osu.Game.Rulesets.Taiko/Skinning/Default/*),
// or with legacy skin elements by TaikoLegacySkinRenderer (legacySkin.ts) when a user / beatmap skin provides them.
import { TaikoLegacySkinRenderer } from './legacySkin';

import { HIT_CLAP, HIT_FINISH, HIT_NORMAL, HIT_WHISTLE, HitSampleInfo } from '../../audio/HitSampleInfo';
import { HitResult, isHit } from '../../scoring/HitResult';
import type { DrawableRuleset, GameplayContext } from '../Ruleset';
import type { TaikoPlayableBeatmap } from './beatmap';
import {
  DEFAULT_SIZE,
  DEFAULT_STRONG_SIZE,
  DrumRoll,
  DrumRollTick,
  Hit,
  HitType,
  STRONG_SCALE,
  StrongNestedHitObject,
  Swell,
  TaikoHitObject,
  createHitSampleInfo,
} from './objects';
import {
  OverlappingScrollAlgorithm,
  TAIKO_BASE_HEIGHT,
  TaikoLayout,
  computeTaikoLayout,
  computeTaikoTimeRange,
  createMultiplierControlPoints,
} from './scrolling';
import { TAIKO_ACTIONS, TaikoAction, TaikoReplayFrame, generateTaikoAutoplay } from './TaikoAutoGenerator';

// ------------------------------------------------------------------ constants

/** TaikoPlayfield.INPUT_DRUM_WIDTH */
const INPUT_DRUM_WIDTH = 180;
/** TaikoPlayfield hit_target_offset / hit_target_width */
const HIT_TARGET_OFFSET = -24;
const HIT_TARGET_WIDTH = TAIKO_BASE_HEIGHT;
/** X (playfield units) of the hit target centre, which is also the scroll origin of the hit object container. */
const HIT_X = INPUT_DRUM_WIDTH + HIT_TARGET_OFFSET + HIT_TARGET_WIDTH / 2;
const PF_H = TAIKO_BASE_HEIGHT;
const CENTRE_Y = PF_H / 2;

/** DrawableHit.StrongNestedHit.SECOND_HIT_WINDOW: the lenience for the second key press. */
export const SECOND_HIT_WINDOW = 30;
/** DrawableSwell.ring_appear_offset */
const RING_APPEAR_OFFSET = 100;
/** DrawableDrumRoll.rolling_hits_for_engaged_colour */
const ROLLING_HITS_FOR_ENGAGED_COLOUR = 5;
/** CirclePiece constants */
const SYMBOL_SIZE = DEFAULT_SIZE;
const SYMBOL_BORDER = 8;
const PRE_BEAT_TRANSITION_TIME = 80;
const KIAI_FLASH_OPACITY = 0.15;
/** TaikoModHidden */
const HD_FADE_OUT_START_TIME = 1;
const HD_FADE_OUT_DURATION = 0.375;
/** DrumSampleTriggerSource stereo spread per sample (ApplySampleInfo: -0.05 + RNG.NextDouble(0.1)). */
const SAMPLE_BALANCE_SPREAD = 0.1;

type RGB = [number, number, number];
const COLOUR_CENTRE: RGB = Hit.COLOUR_CENTRE;
const COLOUR_RIM: RGB = Hit.COLOUR_RIM;
const YELLOW_DARK: RGB = [0xee, 0xaa, 0x00];
const YELLOW_DARKER: RGB = [0xcc, 0x66, 0x00];
const YELLOW_LIGHT: RGB = [0xff, 0xdd, 0x55];
const PINK: RGB = [0xff, 0x66, 0xaa];
const BLUE: RGB = [0x66, 0xcc, 0xff];
const PINK_DARKER: RGB = [0xbb, 0x11, 0x77];
const BLUE_DARKER: RGB = [0x22, 0x99, 0xbb];
const KIAI_GLOW_COLOUR: RGB = [255, 228, 0];

const RESULT_COLOURS: Partial<Record<HitResult, string>> = {
  [HitResult.Great]: '#66ccff',
  [HitResult.Ok]: '#88b300',
  [HitResult.Miss]: '#ed1121',
};
const RESULT_TEXT: Partial<Record<HitResult, string>> = {
  [HitResult.Great]: 'GREAT',
  [HitResult.Ok]: 'OK',
  [HitResult.Miss]: 'MISS',
};

const css = (c: RGB, a = 1): string => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
const lerpRGB = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

// Easing (osu.Framework.Graphics.Easing)
const outQuad = (t: number): number => 1 - (1 - t) * (1 - t);
const inQuad = (t: number): number => t * t;
const outQuint = (t: number): number => 1 - Math.pow(1 - t, 5);
const inQuint = (t: number): number => Math.pow(t, 5);
const outSine = (t: number): number => Math.sin((t * Math.PI) / 2);
const outElastic = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : Math.pow(2, -10 * t) * Math.sin(((t - 0.075) * (2 * Math.PI)) / 0.3) + 1);

/** Interpolation.DampContinuously */
const damp = (current: number, target: number, halfTime: number, elapsed: number): number => target + (current - target) * Math.pow(0.5, elapsed / halfTime);

const isCentreAction = (a: TaikoAction): boolean => a === 'LeftCentre' || a === 'RightCentre';
const isRimAction = (a: TaikoAction): boolean => a === 'LeftRim' || a === 'RightRim';

type TouchScheme = 'KDDK' | 'DDKK' | 'KKDD';

/** DrumTouchInputArea.getOrderedActionsForScheme: [leftRim, leftCentre, rightCentre, rightRim] segment actions. */
function actionsForScheme(scheme: TouchScheme): [TaikoAction, TaikoAction, TaikoAction, TaikoAction] {
  switch (scheme) {
    case 'DDKK':
      return ['LeftCentre', 'RightCentre', 'LeftRim', 'RightRim'];
    case 'KKDD':
      return ['LeftRim', 'RightRim', 'LeftCentre', 'RightCentre'];
    default:
      return ['LeftRim', 'LeftCentre', 'RightCentre', 'RightRim'];
  }
}

// ------------------------------------------------------------------ judgement state

/** Runtime judgement state of a hit object (the part of DrawableHitObject / its JudgementResult we need). */
class Entry {
  result: HitResult = HitResult.None;
  timeOffset = 0;
  resultTime = 0;
  readonly nested: Entry[];
  private allJudgedCache = false;
  /** Latest result time of this entry and its nested entries. */
  lastJudgeTime = -Infinity;

  // DrawableHit
  hitAction: TaikoAction | null = null;
  lastPressTime = NaN;
  explosion: Explosion | null = null;
  // DrawableSwell
  lastWasCentre: boolean | null = null;
  numHits = 0;
  swellRingScale = 1;
  swellRingAlpha = 0;
  swellRotation = 0;
  // DrawableDrumRoll
  rollingHits = 0;
  colourFrom = 0;
  colourTo = 0;
  colourChangeTime = -Infinity;
  // DrawableDrumRollTick
  judgementType: HitType = HitType.Centre;

  constructor(
    readonly obj: TaikoHitObject,
    readonly parent: Entry | null,
  ) {
    this.nested = obj.nested.map(n => new Entry(n, this));
  }

  get judged(): boolean {
    return this.result !== HitResult.None;
  }

  get isHit(): boolean {
    return this.judged && isHit(this.result);
  }

  get allJudged(): boolean {
    if (this.allJudgedCache) return true;
    if (!this.judged) return false;
    for (const n of this.nested) if (!n.allJudged) return false;
    this.allJudgedCache = true;
    return true;
  }

  get strong(): Entry | null {
    for (const n of this.nested) if (n.obj instanceof StrongNestedHitObject) return n;
    return null;
  }

  get top(): Entry {
    let e: Entry = this;
    while (e.parent) e = e.parent;
    return e;
  }
}

interface Explosion {
  time: number;
  result: HitResult;
  rim: boolean;
  secondHitTime: number | null;
}

interface KiaiExplosion {
  time: number;
  rim: boolean;
}

interface JudgementPopup {
  time: number;
  result: HitResult;
}

interface FlyingHit {
  time: number;
  rim: boolean;
  strong: boolean;
}

// ------------------------------------------------------------------ sprite cache

type SpriteCanvas = HTMLCanvasElement | OffscreenCanvas;

function createCanvas(w: number, h: number): SpriteCanvas | null {
  w = Math.max(1, Math.ceil(w));
  h = Math.max(1, Math.ceil(h));
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }
  return null;
}

// ------------------------------------------------------------------ drawable ruleset

export class DrawableTaikoRuleset implements DrawableRuleset {
  private readonly objects: TaikoHitObject[];
  private readonly entries: Entry[];
  private readonly algo: OverlappingScrollAlgorithm;
  private readonly maxLookahead: number;
  /** How far ahead (ms) objects can be visible with the slowest scroll speed. */
  private visibleAheadFactor: number;
  private readonly kiaiTimes: boolean;

  // mods
  private readonly hidden: boolean;
  private readonly flashlight: boolean;
  private readonly relax: boolean;
  private readonly cinema: boolean;

  // settings
  private readonly hitAnimations: boolean;
  private readonly rateAdjustedHitAnimations: boolean;
  private readonly drumCombo: boolean;
  private readonly touchActions: [TaikoAction, TaikoAction, TaikoAction, TaikoAction];

  // judging
  private lastTime = -Infinity;
  private firstUnjudged = 0;
  private renderStart = 0;
  private readonly pressed = new Set<TaikoAction>();

  // autoplay
  private readonly frames: TaikoReplayFrame[] = [];
  private frameIndex = 0;
  private autoPressed: TaikoAction[] = [];

  // samples (DrumSamplePlayer)
  private lastHitTime = 0;
  private lastAction: TaikoAction | null = null;
  private mostValid: Entry | null = null;

  // effects
  private readonly explosions: Explosion[] = [];
  private readonly kiaiExplosions: KiaiExplosion[] = [];
  private readonly judgements: JudgementPopup[] = [];
  private readonly flyingHits: FlyingHit[] = [];
  private readonly drumPress: Record<TaikoAction, { time: number; peak: number }> = {
    LeftRim: { time: -Infinity, peak: 0 },
    LeftCentre: { time: -Infinity, peak: 0 },
    RightCentre: { time: -Infinity, peak: 0 },
    RightRim: { time: -Infinity, peak: 0 },
  };
  private kiaiGlowAlpha = 0;
  private kiaiGlowBumpTime = -Infinity;

  // touch (DrumTouchInputArea)
  private readonly trackedTouches = new Map<number, TaikoAction>();
  private touchVisible = false;
  private touchVisibilityChangeTime = -Infinity;
  private touchAlphaAtChange = 0;
  private readonly touchSegmentState: Record<TaikoAction, { pressTime: number; releaseTime: number; alphaAtRelease: number }> = {
    LeftRim: { pressTime: -Infinity, releaseTime: -Infinity, alphaAtRelease: 0 },
    LeftCentre: { pressTime: -Infinity, releaseTime: -Infinity, alphaAtRelease: 0 },
    RightCentre: { pressTime: -Infinity, releaseTime: -Infinity, alphaAtRelease: 0 },
    RightRim: { pressTime: -Infinity, releaseTime: -Infinity, alphaAtRelease: 0 },
  };
  private realNow = 0;

  // flashlight
  private flashlightSize = -1;

  // layout
  private width = 0;
  private height = 0;
  private layout: TaikoLayout = { scale: 1, top: 0, width: 1, unit: 1 };
  private timeRange = 1000;
  private spriteScale = -1;
  private readonly sprites = new Map<string, SpriteCanvas | null>();

  readonly drawsCursor = false;

  /** Legacy skin renderer (when a user / beatmap skin is in use). */
  private readonly legacy: TaikoLegacySkinRenderer | null;

  constructor(
    private readonly playable: TaikoPlayableBeatmap,
    private readonly ctx: GameplayContext,
  ) {
    this.objects = playable.hitObjects;
    this.entries = this.objects.map(o => new Entry(o, null));
    const lastObjectTime = this.objects.length > 0 ? playable.lastObjectTime : Number.MAX_VALUE;
    this.algo = new OverlappingScrollAlgorithm(createMultiplierControlPoints(playable.controlPoints, playable.difficulty.sliderMultiplier, lastObjectTime));
    this.kiaiTimes = playable.controlPoints.effectPoints.some(e => e.kiaiMode);
    this.legacy = ctx.skin.sources && ctx.skin.sources.length > 0 ? new TaikoLegacySkinRenderer(ctx.skin.sources, playable.controlPoints) : null;

    let lookahead = 0;
    for (const o of this.objects) {
      if (o instanceof Hit) lookahead = Math.max(lookahead, o.hitWindows.windowFor(HitResult.Miss));
      else if (o instanceof DrumRoll) lookahead = Math.max(lookahead, o.tickSpacing / 2);
    }
    this.maxLookahead = lookahead + 1;
    this.visibleAheadFactor = 1 / this.algo.minimumMultiplier;

    const mods = ctx.mods;
    this.hidden = mods.has('HD');
    this.flashlight = mods.has('FL');
    this.relax = mods.has('RX');
    this.cinema = mods.has('CN');

    this.hitAnimations = ctx.settings.get('taiko.hitAnimations', true);
    this.rateAdjustedHitAnimations = ctx.settings.get('taiko.rateAdjustedHitAnimation', true);
    this.drumCombo = ctx.settings.get('taiko.drumCombo', true);
    this.touchActions = actionsForScheme(ctx.settings.get<TouchScheme>('taiko.touchControlScheme', 'KDDK'));

    if (ctx.autoplay) this.frames = generateTaikoAutoplay(this.objects);
  }

  /** DrawableRuleset.GameplayStartTime: first object start time - 2000. */
  get leadInTime(): number {
    return 2000;
  }

  get hasCompleted(): boolean {
    for (let i = this.firstUnjudged; i < this.entries.length; i++) if (!this.entries[i].allJudged) return false;
    return true;
  }

  // ================================================================ input

  onPressed(action: string, time: number): void {
    if (!this.isTaikoAction(action)) return;
    // DrumTouchInputArea: hide whenever the keyboard is used.
    this.setTouchVisible(false, time);
    if (this.ctx.autoplay) return;
    this.press(action, time);
  }

  onReleased(action: string, time: number): void {
    if (!this.isTaikoAction(action)) return;
    if (this.ctx.autoplay) return;
    this.release(action, time);
  }

  onTouchStart(id: number, x: number, y: number, time: number): void {
    this.setTouchVisible(true, time);
    if (this.ctx.autoplay) return;
    if (this.trackedTouches.has(id)) return;
    const action = this.touchActionAt(x, y);
    this.trackedTouches.set(id, action);
    this.press(action, time);
  }

  onTouchEnd(id: number, _x: number, _y: number, time: number): void {
    const action = this.trackedTouches.get(id);
    if (action === undefined) return;
    this.trackedTouches.delete(id);
    // Only release if no other touch holds the same action.
    for (const a of this.trackedTouches.values()) if (a === action) return;
    this.release(action, time);
  }

  private isTaikoAction(action: string): action is TaikoAction {
    return (TAIKO_ACTIONS as readonly string[]).includes(action);
  }

  private press(action: TaikoAction, time: number): void {
    if (this.pressed.has(action)) return;
    // Input is processed at (or after) the latest processed gameplay time.
    time = Math.max(time, this.lastTime);
    this.advance(time);
    this.pressed.add(action);
    this.onDrumVisual(action, time, true);
    this.playDrumSample(action, time);
    this.handlePress(action, time);
  }

  private release(action: TaikoAction, time: number): void {
    if (!this.pressed.has(action)) return;
    time = Math.max(time, this.lastTime);
    this.advance(time);
    this.pressed.delete(action);
    this.onDrumVisual(action, time, false);
    // DrawableHit.OnReleased: the second hit of a strong requires the first key to still be held.
    for (let i = this.firstUnjudged; i < this.entries.length; i++) {
      const e = this.entries[i];
      if (e.obj.startTime > time + this.maxLookahead) break;
      if (e.hitAction === action) e.hitAction = null;
    }
  }

  /** The keyboard input queue: earlier hitobjects receive input first; nested objects before their parents. */
  private handlePress(action: TaikoAction, time: number): void {
    for (let i = this.firstUnjudged; i < this.entries.length; i++) {
      const e = this.entries[i];
      if (e.obj.startTime > time + this.maxLookahead) break;
      if (e.allJudged && e.lastJudgeTime < time) continue;
      let handled = false;
      switch (e.obj.kind) {
        case 'hit':
          handled = this.pressHit(e, action, time);
          break;
        case 'drumroll':
          handled = this.pressDrumRoll(e, action, time);
          break;
        case 'swell':
          handled = this.pressSwell(e, action, time);
          break;
      }
      if (handled) return;
    }
  }

  private hitActionsFor(e: Entry): (a: TaikoAction) => boolean {
    // TaikoModRelax: all actions can hit.
    if (this.relax) return () => true;
    return (e.obj as Hit).type === HitType.Centre ? isCentreAction : isRimAction;
  }

  /** DrawableHit.OnPressed (+ nested StrongNestedHit.OnPressed which receives input first). */
  private pressHit(e: Entry, action: TaikoAction, time: number): boolean {
    const strong = e.strong;
    if (strong && !strong.judged && this.pressStrongHit(strong, action, time)) return true;

    if (e.lastPressTime === time) return true;
    if (e.judged) return false;

    const validActionPressed = this.hitActionsFor(e)(action);
    this.checkHit(e, time, true, validActionPressed);
    if (e.isHit) e.hitAction = action;

    // Regardless of whether we've hit or not, any secondary key presses in the same frame should be discarded
    e.lastPressTime = time;
    return e.judged;
  }

  /** DrawableHit.StrongNestedHit.OnPressed */
  private pressStrongHit(strong: Entry, action: TaikoAction, time: number): boolean {
    const parent = strong.parent!;
    // Don't process actions until the main hitobject is hit
    if (!parent.isHit) return false;
    // Don't process actions if the pressed button was released
    if (parent.hitAction === null) return false;
    // Don't handle invalid hit action presses
    if (!this.hitActionsFor(parent)(action)) return false;
    return this.checkStrongHit(strong, time, true);
  }

  private pressDrumRoll(e: Entry, action: TaikoAction, time: number): boolean {
    // Later children receive input first.
    for (let i = e.nested.length - 1; i >= 0; i--) {
      const tick = e.nested[i];
      if (!(tick.obj instanceof DrumRollTick)) continue;
      // DrawableDrumRollTick.StrongNestedHit.OnPressed => false
      // DrawableDrumRollTick.OnPressed
      tick.judgementType = isRimAction(action) ? HitType.Rim : HitType.Centre;
      if (!tick.judged && this.checkTick(tick, time, true)) return true;
    }
    // DrawableDrumRoll.OnPressed => false
    return false;
  }

  /** DrawableSwell.OnPressed */
  private pressSwell(e: Entry, action: TaikoAction, time: number): boolean {
    // Don't handle keys before the swell starts
    if (time < e.obj.startTime) return false;
    if (e.allJudged) return false;
    const isCentre = isCentreAction(action);
    // Ensure alternating centre and rim hits (TaikoModRelax: MustAlternate = false)
    if (e.lastWasCentre === isCentre && !this.relax) return false;
    // If we've already successfully judged a tick this frame, do not judge more.
    if (e.lastPressTime === time) return true;
    e.lastWasCentre = isCentre;
    e.lastPressTime = time;
    if (!e.judged) this.checkSwell(e, time, true);
    return true;
  }

  // ================================================================ judging

  private advance(time: number): void {
    if (time <= this.lastTime) return;
    this.lastTime = time;
    for (let i = this.firstUnjudged; i < this.entries.length; i++) {
      const e = this.entries[i];
      if (e.obj.startTime > time) break;
      if (!e.allJudged) this.updateEntry(e, time);
    }
    while (this.firstUnjudged < this.entries.length) {
      const e = this.entries[this.firstUnjudged];
      if (!e.allJudged || e.lastJudgeTime >= time) break;
      this.firstUnjudged++;
    }
  }

  /** UpdateAfterChildren -> UpdateResult(false): nested objects are processed before their parents. */
  private updateEntry(e: Entry, time: number): void {
    switch (e.obj.kind) {
      case 'hit': {
        const strong = e.strong;
        if (strong && !strong.judged) this.checkStrongHit(strong, time, false);
        if (!e.judged) this.checkHit(e, time, false, false);
        break;
      }
      case 'drumroll': {
        for (const n of e.nested) {
          if (n.obj instanceof DrumRollTick) {
            const strong = n.strong;
            if (strong && !strong.judged) this.checkNestedStrongOfIgnore(strong, time);
            if (!n.judged) this.checkTick(n, time, false);
          } else if (!n.judged) {
            // DrumRoll.StrongNestedHit
            this.checkNestedStrongOfIgnore(n, time);
          }
        }
        // DrawableDrumRoll.CheckForResult
        if (!e.judged && time - e.obj.endTime >= 0) this.applyResult(e, e.obj.judgement.maxResult, time);
        break;
      }
      case 'swell':
        if (!e.judged) this.checkSwell(e, time, false);
        break;
    }
  }

  /** DrawableHit.CheckForResult */
  private checkHit(e: Entry, time: number, userTriggered: boolean, validActionPressed: boolean): void {
    const hw = e.obj.hitWindows;
    const timeOffset = time - e.obj.endTime;
    if (!userTriggered) {
      if (!hw.canBeHit(timeOffset)) this.applyResult(e, e.obj.judgement.minResult, time);
      return;
    }
    const result = hw.resultFor(timeOffset);
    if (result === HitResult.None) return;
    if (!validActionPressed) this.applyResult(e, e.obj.judgement.minResult, time);
    else this.applyResult(e, result, time);
  }

  /** DrawableHit.StrongNestedHit.CheckForResult. Returns whether the strong hit is judged. */
  private checkStrongHit(strong: Entry, time: number, userTriggered: boolean): boolean {
    const parent = strong.parent!;
    if (!parent.judged) return false;
    if (!parent.isHit) {
      this.applyResult(strong, strong.obj.judgement.minResult, time);
      return true;
    }
    const timeOffset = time - strong.obj.endTime;
    if (!userTriggered) {
      if (timeOffset - parent.timeOffset > SECOND_HIT_WINDOW) this.applyResult(strong, strong.obj.judgement.minResult, time);
      return strong.judged;
    }
    if (Math.abs(timeOffset - parent.timeOffset) <= SECOND_HIT_WINDOW) this.applyResult(strong, strong.obj.judgement.maxResult, time);
    return strong.judged;
  }

  /** DrawableDrumRoll.StrongNestedHit / DrawableDrumRollTick.StrongNestedHit.CheckForResult */
  private checkNestedStrongOfIgnore(strong: Entry, time: number): void {
    const parent = strong.parent!;
    if (!parent.judged) return;
    this.applyResult(strong, parent.isHit ? strong.obj.judgement.maxResult : strong.obj.judgement.minResult, time);
  }

  /** DrawableDrumRollTick.CheckForResult. Returns whether the tick got judged. */
  private checkTick(tick: Entry, time: number, userTriggered: boolean): boolean {
    const t = tick.obj as DrumRollTick;
    const timeOffset = time - t.endTime;
    if (!userTriggered) {
      if (timeOffset > t.hitWindow) this.applyResult(tick, t.judgement.minResult, time);
      return tick.judged;
    }
    if (Math.abs(timeOffset) > t.hitWindow) return false;
    this.applyResult(tick, t.judgement.maxResult, time);
    return true;
  }

  /** DrawableSwell.CheckForResult */
  private checkSwell(e: Entry, time: number, userTriggered: boolean): void {
    const swell = e.obj as Swell;
    if (userTriggered) {
      const nextTick = e.nested.find(t => !t.judged);
      // DrawableSwellTick.TriggerResult sets the tick's start time to the current time.
      if (nextTick) this.applyResult(nextTick, nextTick.obj.judgement.maxResult, time, time);
      let numHits = 0;
      for (const t of e.nested) if (t.isHit) numHits++;
      this.updateHitProgress(e, numHits);
      if (numHits === swell.requiredHits) this.applyResult(e, swell.judgement.maxResult, time);
    } else {
      if (time - swell.endTime < 0) return;
      let numHits = 0;
      for (const t of e.nested) {
        if (t.isHit) {
          numHits++;
          continue;
        }
        if (!t.judged) this.applyResult(t, t.obj.judgement.minResult, time, time);
      }
      if (numHits === swell.requiredHits) this.applyResult(e, swell.judgement.maxResult, time);
      else this.applyResult(e, swell.judgement.minResult, time);
    }
  }

  private applyResult(e: Entry, type: HitResult, time: number, objectEndTime = e.obj.endTime): void {
    if (e.judged) return;
    e.result = type;
    e.timeOffset = time - objectEndTime;
    e.resultTime = time;
    for (let p: Entry | null = e; p; p = p.parent) p.lastJudgeTime = Math.max(p.lastJudgeTime, time);

    this.ctx.applyResult({
      hitObject: e.obj,
      judgement: e.obj.judgement,
      type,
      timeOffset: e.timeOffset,
      objectEndTime,
      tag: e.obj.kind,
      gameplayRate: this.ctx.rate,
    });

    this.onNewResult(e, type, time);
  }

  /** TaikoPlayfield.OnNewResult + DrawableDrumRoll.onNewResult + LegacyKiaiGlow.onNewJudgement */
  private onNewResult(e: Entry, type: HitResult, time: number): void {
    const hit = isHit(type);
    if (hit && this.isKiai(time)) this.kiaiGlowBumpTime = time;

    switch (e.obj.kind) {
      case 'strong':
        // TaikoStrongJudgement: visualise the second hit on the parent's explosion.
        if (hit && e.parent?.explosion) e.parent.explosion.secondHitTime = time;
        break;

      case 'drumrolltick': {
        const roll = e.parent!;
        const before = this.drumRollColourAt(roll, time);
        roll.rollingHits = Math.min(Math.max(roll.rollingHits + (hit ? 1 : -1), 0), ROLLING_HITS_FOR_ENGAGED_COLOUR);
        roll.colourFrom = before;
        roll.colourTo = roll.rollingHits / ROLLING_HITS_FOR_ENGAGED_COLOUR;
        roll.colourChangeTime = time;
        if (hit && this.hitAnimations) this.flyingHits.push({ time: e.obj.startTime + e.timeOffset, rim: e.judgementType === HitType.Rim, strong: (e.obj as DrumRollTick).isStrong });
        break;
      }

      case 'hit': {
        if (type !== HitResult.Great && type !== HitResult.Ok && type !== HitResult.Miss) break;
        this.judgements.push({ time, result: type });
        const rim = (e.obj as Hit).type === HitType.Rim;
        const explosion: Explosion = { time, result: type, rim, secondHitTime: null };
        e.explosion = explosion;
        this.explosions.push(explosion);
        if (e.obj.kiai) this.kiaiExplosions.push({ time, rim });
        break;
      }
    }
  }

  private updateHitProgress(e: Entry, numHits: number): void {
    e.numHits = numHits;
    // DefaultSwell.animateSwellProgress
    const completion = numHits / (e.obj as Swell).requiredHits;
    e.swellRingAlpha += Math.min(Math.max(completion / 16, 0.1), 0.6);
  }

  // ================================================================ samples

  /** DrumSamplePlayer.OnPressed + DrumSampleTriggerSource.Play */
  private playDrumSample(action: TaikoAction, time: number): void {
    const strong = this.checkStrongValidity(action, this.lastAction, time - this.lastHitTime);
    const hitType = isRimAction(action) ? HitType.Rim : HitType.Centre;

    const obj = this.getMostValidObject(time);
    if (obj) {
      const baseSample = createHitSampleInfo(obj.samples, hitType === HitType.Rim ? HIT_CLAP : HIT_NORMAL);
      const samples: HitSampleInfo[] = strong ? [baseSample, createHitSampleInfo(obj.samples, hitType === HitType.Rim ? HIT_WHISTLE : HIT_FINISH)] : [baseSample];
      this.ctx.playSamples(samples, { pan: -SAMPLE_BALANCE_SPREAD / 2 + Math.random() * SAMPLE_BALANCE_SPREAD });
    }

    this.lastHitTime = time;
    this.lastAction = action;
  }

  private checkStrongValidity(newAction: TaikoAction, lastAction: TaikoAction | null, timeBetweenActions: number): boolean {
    if (lastAction === null) return false;
    if (timeBetweenActions < 0 || timeBetweenActions > SECOND_HIT_WINDOW) return false;
    switch (newAction) {
      case 'LeftCentre':
        return lastAction === 'RightCentre';
      case 'RightCentre':
        return lastAction === 'LeftCentre';
      case 'LeftRim':
        return lastAction === 'RightRim';
      case 'RightRim':
        return lastAction === 'LeftRim';
    }
  }

  /** GameplaySampleTriggerSource.GetMostValidObject */
  private getMostValidObject(time: number): TaikoHitObject | null {
    if (this.entries.length === 0) return null;
    if (this.mostValid === null || this.mostValid.allJudged) {
      let candidate: Entry | null = null;
      for (let i = this.firstUnjudged; i < this.entries.length; i++) {
        if (!this.entries[i].allJudged) {
          candidate = this.entries[i];
          break;
        }
      }
      if (candidate === null) this.mostValid = this.entries[this.entries.length - 1];
      else {
        const h = candidate.obj;
        const missWindow = h instanceof Hit ? h.hitWindows.windowFor(HitResult.Miss) : 0;
        if (time >= h.startTime - missWindow * 2) this.mostValid = candidate;
        else this.mostValid ??= this.entries[0];
      }
    }
    // Nested objects share their parent's samples, so the parent's samples are used directly.
    return this.mostValid.obj;
  }

  // ================================================================ autoplay & update

  update(time: number, elapsed: number): void {
    if (this.frames.length > 0) {
      // FramedReplayInputHandler: each frame's pressed actions are applied at the frame's exact time.
      while (this.frameIndex < this.frames.length && this.frames[this.frameIndex].time <= time) {
        const frame = this.frames[this.frameIndex++];
        this.advance(frame.time);
        for (const a of this.autoPressed) if (!frame.actions.includes(a)) this.release(a, frame.time);
        for (const a of frame.actions) if (!this.autoPressed.includes(a)) this.press(a, frame.time);
        this.autoPressed = frame.actions.slice();
      }
    }
    this.advance(time);

    const dt = Math.abs(elapsed);
    this.realNow += dt / Math.max(0.01, this.ctx.rate);

    // DefaultSwell.Update
    for (let i = this.renderStart; i < this.entries.length; i++) {
      const e = this.entries[i];
      if (e.obj.startTime > time) break;
      if (!(e.obj instanceof Swell)) continue;
      if (e.judged && time > e.resultTime + 1000) continue;
      const swell = e.obj;
      const completion = e.numHits / swell.requiredHits;
      e.swellRotation = damp(e.swellRotation, (completion * swell.duration) / 8, 500, dt);
      e.swellRingScale = damp(e.swellRingScale, 1 + Math.min(4, 4 * completion * 1.3), 35, dt);
      e.swellRingAlpha = damp(e.swellRingAlpha, completion / 16, 250, dt);
    }

    // LegacyKiaiGlow.Update
    if (this.kiaiTimes && this.isKiai(time)) this.kiaiGlowAlpha = Math.min(1, this.kiaiGlowAlpha + dt / 100);
    else this.kiaiGlowAlpha = Math.max(0, this.kiaiGlowAlpha - dt / 600);

    // ModFlashlight size transitions
    if (this.flashlight) {
      const target = this.flashlightTargetSize(time);
      if (this.flashlightSize < 0) this.flashlightSize = target;
      else {
        // TaikoFlashlight.scale_animation_speed: 1.875 / 1000 per ms, relative to the default size (200).
        const step = 200 * (1.875 / 1000) * dt;
        if (Math.abs(target - this.flashlightSize) <= step) this.flashlightSize = target;
        else this.flashlightSize += Math.sign(target - this.flashlightSize) * step;
      }
    }

    // Expire finished effects.
    pruneBefore(this.explosions, time - 1000);
    pruneBefore(this.kiaiExplosions, time - 500);
    pruneBefore(this.judgements, time - 800);
    pruneBefore(this.flyingHits, time - 900);

    while (this.renderStart < this.entries.length) {
      const e = this.entries[this.renderStart];
      if (!e.allJudged || time < e.lastJudgeTime + 1200 || time < e.obj.endTime + 1200) break;
      this.renderStart++;
    }
  }

  // ================================================================ helpers

  private isKiai(time: number): boolean {
    return this.playable.controlPoints.effectPointAt(time).kiaiMode;
  }

  private drumRollColourAt(roll: Entry, time: number): number {
    const t = clamp01((time - roll.colourChangeTime) / 100);
    return roll.colourFrom + (roll.colourTo - roll.colourFrom) * t;
  }

  private flashlightTargetSize(time: number): number {
    // ModFlashlight.GetSize (default configuration: SizeMultiplier 1, ComboBasedSize true; TaikoModFlashlight.DefaultFlashlightSize 200)
    let size = 200;
    const inBreak = this.playable.breaks.some(b => time >= b.startTime && time <= b.endTime);
    if (inBreak) size *= 2.5;
    else {
      const combo = this.ctx.combo;
      if (combo >= 200) size *= 0.625;
      else if (combo >= 100) size *= 0.8125;
    }
    return size;
  }

  private setTouchVisible(visible: boolean, time: number): void {
    if (this.touchVisible === visible) return;
    this.touchAlphaAtChange = this.touchAlpha();
    this.touchVisible = visible;
    this.touchVisibilityChangeTime = this.realNow;
  }

  private touchAlpha(): number {
    const e = this.realNow - this.touchVisibilityChangeTime;
    if (this.touchVisible) return this.touchAlphaAtChange + (1 - this.touchAlphaAtChange) * outQuint(clamp01(e / 500));
    return this.touchAlphaAtChange * (1 - clamp01(e / 300));
  }

  /** Geometry of DrumTouchInputArea in CSS pixels. */
  private touchGeometry(): { cx: number; cy: number; radius: number; gap: number } {
    const u = this.layout.unit;
    const containerHeight = this.height * 0.45;
    const radius = Math.min(this.width, containerHeight);
    return { cx: this.width / 2, cy: this.height + 20 * u, radius, gap: 2 * u };
  }

  /** DrumTouchInputArea.getTaikoActionFromPosition */
  private touchActionAt(x: number, y: number): TaikoAction {
    const g = this.touchGeometry();
    const centreRadius = g.radius * 0.8;
    const leftCentreHit = Math.hypot(x - (g.cx - g.gap), y - g.cy) <= centreRadius;
    const rightCentreHit = Math.hypot(x - (g.cx + g.gap), y - g.cy) <= centreRadius;
    const centreHit = leftCentreHit || rightCentreHit;
    const leftSide = x < this.width / 2;
    const [leftRim, leftCentre, rightCentre, rightRim] = this.touchActions;
    if (leftSide) return centreHit ? leftCentre : leftRim;
    return centreHit ? rightCentre : rightRim;
  }

  private onDrumVisual(action: TaikoAction, time: number, down: boolean): void {
    const seg = this.touchSegmentState[action];
    if (down) {
      // DefaultInputDrum.TaikoHalfDrum.OnPressed
      const d = this.drumPress[action];
      this.legacy?.onDrumPressed(action, time);
      d.peak = Math.min(this.drumOverlayAlpha(action, time) + 0.5, 1);
      d.time = time;
      seg.pressTime = this.realNow;
      seg.releaseTime = Infinity;
    } else {
      seg.alphaAtRelease = this.segmentOverlayAlpha(action);
      seg.releaseTime = this.realNow;
    }
  }

  private drumOverlayAlpha(action: TaikoAction, time: number): number {
    const d = this.drumPress[action];
    const e = time - d.time;
    if (e < 0) return 0;
    const downTime = 40;
    const upTime = 1000;
    if (e < downTime) return d.peak * outQuint(e / downTime);
    return d.peak * (1 - outQuint(clamp01((e - downTime) / upTime)));
  }

  private segmentOverlayAlpha(action: TaikoAction): number {
    const s = this.touchSegmentState[action];
    if (this.realNow < s.releaseTime) return outQuint(clamp01((this.realNow - s.pressTime) / 80));
    return s.alphaAtRelease * (1 - outQuint(clamp01((this.realNow - s.releaseTime) / 1000)));
  }

  private updateLayout(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.layout = computeTaikoLayout(width, height);
    // DrawableTaikoRuleset.ComputeTimeRange (Overlapping visualisation: multiplier 1)
    this.timeRange = computeTaikoTimeRange(width, height);
  }

  private get scrollLength(): number {
    return this.layout.width - HIT_X;
  }

  /** X (playfield units) of an object starting at `time`, scrolled using the multiplier at `originTime`. */
  private xAt(time: number, now: number, originTime?: number): number {
    return HIT_X + this.algo.positionAt(time, now, this.timeRange, this.scrollLength, originTime);
  }

  /** TaikoModHidden.ApplyNormalVisibilityState for hits and drum roll ticks. */
  private hiddenAlpha(h: TaikoHitObject, now: number): number {
    if (!this.hidden) return 1;
    const preempt = this.timeRange / this.algo.controlPointAt(h.startTime).multiplier;
    const start = h.startTime - preempt * HD_FADE_OUT_START_TIME;
    const duration = preempt * HD_FADE_OUT_DURATION;
    return 1 - clamp01((now - start) / duration);
  }

  // ================================================================ rendering

  render(ctx: CanvasRenderingContext2D, width: number, height: number, time: number): void {
    this.updateLayout(width, height);
    const L = this.layout;
    const s = L.scale;
    if (s !== this.spriteScale) {
      this.sprites.clear();
      this.spriteScale = s;
    }

    if (!this.cinema) {
      ctx.save();
      ctx.translate(0, L.top);
      ctx.scale(s, s);
      this.drawPlayfield(ctx, time);
      ctx.restore();
    }

    if (this.flashlight && !this.cinema) this.drawFlashlight(ctx, width, height);
    if (this.trackedTouches.size > 0 || this.touchVisible || this.touchAlpha() > 0) this.drawTouchControls(ctx);
  }

  private drawPlayfield(ctx: CanvasRenderingContext2D, now: number): void {
    const W = this.layout.width;
    const beat = this.beatState(now);
    const legacy = this.legacy;

    // PlayfieldBackgroundRight
    if (legacy?.has.barRight) legacy.drawBackgroundRight(ctx, W, PF_H, now, this.isKiai(now));
    else {
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(0, 0, W, PF_H);
      ctx.strokeStyle = '#111';
      ctx.lineWidth = 2;
      ctx.strokeRect(1, 1, W - 2, PF_H - 2);
    }

    // PlayfieldBackgroundLeft (displayed inside LegacyInputDrum for legacy skins providing "taiko-bar-right")
    if (!legacy?.has.barRight) {
      ctx.fillStyle = '#111';
      ctx.fillRect(0, 0, INPUT_DRUM_WIDTH, PF_H);
      const shadow = ctx.createLinearGradient(INPUT_DRUM_WIDTH, 0, INPUT_DRUM_WIDTH + 10, 0);
      shadow.addColorStop(0, 'rgba(0,0,0,0.6)');
      shadow.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = shadow;
      ctx.fillRect(INPUT_DRUM_WIDTH, 0, 10, PF_H);
    }

    if (legacy?.has.inputDrum) {
      legacy.drawInputDrum(ctx, INPUT_DRUM_WIDTH, PF_H, now);
      this.drawDrumCombo(ctx);
    } else this.drawInputDrum(ctx, now);

    // Elements behind hit objects: kiai glow, hit explosions, hit target
    if (legacy?.has.kiaiGlow) legacy.drawKiaiGlow(ctx, HIT_X, CENTRE_Y, this.kiaiGlowAlpha, this.kiaiGlowBumpTime, now);
    else this.drawKiaiGlow(ctx, now);
    if (legacy?.has.explosions) {
      for (const ex of this.explosions) legacy.drawExplosion(ctx, HIT_X, CENTRE_Y, ex.result, ex.time, ex.secondHitTime, now);
    } else this.drawExplosions(ctx, now);
    if (legacy?.has.hitTarget) legacy.drawHitTarget(ctx, HIT_X, CENTRE_Y);
    else this.drawHitTarget(ctx);

    // Bar lines
    this.drawBarLines(ctx, now);

    // Masked hit objects content
    const proxied: Entry[] = [];
    ctx.save();
    ctx.beginPath();
    ctx.rect(HIT_X, 0, W - HIT_X, PF_H);
    ctx.clip();
    let end = this.renderStart;
    while (end < this.entries.length && this.entries[end].obj.startTime <= now + this.timeRange * this.visibleAheadFactor + 1000) end++;
    // Earlier objects are drawn on top.
    for (let i = end - 1; i >= this.renderStart; i--) {
      const e = this.entries[i];
      if (this.isProxied(e, now)) {
        proxied.push(e);
        continue;
      }
      this.drawEntry(ctx, e, now, beat);
    }
    ctx.restore();

    // Overlay content: kiai explosions, judgements (hidden when a legacy skin provides explosion sprites)
    if (!legacy?.has.explosions) {
      this.drawKiaiExplosions(ctx, now);
      this.drawJudgements(ctx, now);
    }

    // Top level hit objects (proxied content), earliest on top.
    for (const e of proxied) this.drawEntry(ctx, e, now, beat);

    // Drum roll flying hits (proxied above everything)
    this.drawFlyingHits(ctx, now, beat);
  }

  private isProxied(e: Entry, now: number): boolean {
    if (e.obj instanceof Hit) return e.isHit;
    if (e.obj instanceof Swell) return now >= e.obj.startTime - RING_APPEAR_OFFSET;
    return false;
  }

  private drawEntry(ctx: CanvasRenderingContext2D, e: Entry, now: number, beat: BeatState): void {
    const o = e.obj;
    if (o instanceof Hit) this.drawHit(ctx, e, o, now, beat);
    else if (o instanceof DrumRoll) this.drawDrumRoll(ctx, e, o, now, beat);
    else if (o instanceof Swell) this.drawSwell(ctx, e, o, now, beat);
  }

  private hitAnimationLength(): number {
    // Rate independent to match stable.
    return 300 * (this.rateAdjustedHitAnimations ? 1 : Math.abs(this.ctx.rate));
  }

  private drawHit(ctx: CanvasRenderingContext2D, e: Entry, h: Hit, now: number, beat: BeatState): void {
    const D = (h.isStrong ? DEFAULT_STRONG_SIZE : DEFAULT_SIZE) * PF_H;
    const x = this.xAt(h.startTime, now);
    let y = CENTRE_Y;
    let alpha = this.hiddenAlpha(h, now);
    let scale = 1;
    let flash = 0;

    if (e.judged) {
      const t = now - e.resultTime;
      if (t < 0) {
        // not yet (rewinding) - draw normally
      } else if (!e.isHit) {
        alpha *= 1 - clamp01(t / (this.hitAnimations ? 100 : 60));
      } else if (!this.hitAnimations) {
        alpha = 0;
      } else {
        // DrawableHit.UpdateHitStateTransforms(ArmedState.Hit)
        const gravityTime = this.hitAnimationLength();
        const gravityTravelHeight = 200;
        scale = 1 - 0.2 * outQuad(clamp01(t / (gravityTime * 2)));
        y += t < gravityTime ? -gravityTravelHeight * outQuad(t / gravityTime) : -gravityTravelHeight + gravityTravelHeight * 2 * inQuad(clamp01((t - gravityTime) / (gravityTime * 2)));
        alpha *= 1 - clamp01(t / 800);
        // CirclePiece: flashBox.FadeTo(0.9f).FadeOut(300)
        flash = 0.9 * (1 - clamp01(t / 300));
      }
    }
    if (alpha <= 0.001) return;
    if (x - D / 2 > this.layout.width || x + D < -200) return;

    if (!e.judged) flash = beat.flash;
    if (this.legacy?.has.hitCircle) this.legacy.drawHit(ctx, x, y, D * scale, h.type === HitType.Rim, h.isStrong, alpha, this.ctx.combo, h.startTime, now);
    else this.drawCirclePiece(ctx, x, y, D * scale, h.type === HitType.Rim ? COLOUR_RIM : COLOUR_CENTRE, h.type === HitType.Rim ? 'rim' : 'centre', alpha, flash, beat.glow);
  }

  /** CirclePiece (+ CentreHitCirclePiece / RimHitCirclePiece / SwellCirclePiece symbols). */
  private drawCirclePiece(ctx: CanvasRenderingContext2D, x: number, y: number, D: number, accent: RGB, symbol: 'centre' | 'rim' | 'swell' | 'none', alpha: number, flash: number, glowAlpha: number, rotation = 0): void {
    const r = D / 2;
    ctx.globalAlpha = alpha;

    // Glow edge effect (radius 8)
    this.drawGlowSprite(ctx, x, y, r, 8, accent, glowAlpha * alpha);

    // Background
    ctx.fillStyle = css(accent);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();

    // Ring (border 8) + flash box (additive)
    if (flash > 0) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = alpha * flash;
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = alpha;
    }
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = SYMBOL_BORDER;
    ctx.beginPath();
    ctx.arc(x, y, Math.max(0, r - SYMBOL_BORDER / 2), 0, Math.PI * 2);
    ctx.stroke();

    // Symbol
    const symbolSize = D * SYMBOL_SIZE;
    ctx.fillStyle = '#fff';
    switch (symbol) {
      case 'centre':
        ctx.beginPath();
        ctx.arc(x, y, Math.max(0, symbolSize / 2 - SYMBOL_BORDER), 0, Math.PI * 2);
        ctx.fill();
        break;
      case 'rim':
        ctx.beginPath();
        ctx.arc(x, y, Math.max(0, symbolSize / 2 - SYMBOL_BORDER / 2), 0, Math.PI * 2);
        ctx.stroke();
        break;
      case 'swell': {
        // FontAwesome asterisk, drawn as six rounded spokes.
        const len = Math.max(0, symbolSize / 2 - SYMBOL_BORDER);
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate((rotation * Math.PI) / 180);
        ctx.lineCap = 'round';
        ctx.lineWidth = Math.max(2, len * 0.42);
        ctx.beginPath();
        for (let i = 0; i < 3; i++) {
          const a = (i * Math.PI) / 3 + Math.PI / 2;
          ctx.moveTo(Math.cos(a) * len * 0.78, Math.sin(a) * len * 0.78);
          ctx.lineTo(-Math.cos(a) * len * 0.78, -Math.sin(a) * len * 0.78);
        }
        ctx.stroke();
        ctx.restore();
        break;
      }
    }
    ctx.globalAlpha = 1;
  }

  private drawGlowSprite(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, radius: number, colour: RGB, alpha: number): void {
    if (alpha <= 0.001) return;
    // Quantise the cache key so animated sizes don't create a sprite per frame.
    const key = `${colour.join(',')}|${Math.round(r / 2)}|${Math.round(radius / 2)}`;
    let sprite = this.sprites.get(key);
    const s = this.spriteScale;
    const extent = r + radius;
    if (sprite === undefined) {
      sprite = createCanvas(extent * 2 * s, extent * 2 * s);
      if (sprite) {
        const c = sprite.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
        if (c) {
          const cx = extent * s;
          const g = c.createRadialGradient(cx, cx, Math.max(0, (r - radius * 0.5) * s), cx, cx, extent * s);
          g.addColorStop(0, css(colour, 0.9));
          g.addColorStop(0.35, css(colour, 0.45));
          g.addColorStop(0.7, css(colour, 0.12));
          g.addColorStop(1, css(colour, 0));
          c.fillStyle = g;
          c.fillRect(0, 0, extent * 2 * s, extent * 2 * s);
        }
      }
      this.sprites.set(key, sprite);
    }
    const prev = ctx.globalAlpha;
    if (sprite) {
      ctx.globalAlpha = alpha;
      ctx.drawImage(sprite, x - extent, y - extent, extent * 2, extent * 2);
    }
    ctx.globalAlpha = prev;
  }

  private drawDrumRoll(ctx: CanvasRenderingContext2D, e: Entry, roll: DrumRoll, now: number, beat: BeatState): void {
    const H = (roll.isStrong ? DEFAULT_STRONG_SIZE : DEFAULT_SIZE) * PF_H;
    const x0 = this.xAt(roll.startTime, now);
    const length = this.algo.getLength(roll.startTime, roll.endTime, this.timeRange, this.scrollLength);
    const x1 = x0 + length;
    if (x0 - H / 2 > this.layout.width || x1 + H / 2 < HIT_X - H) return;

    let alpha = 1;
    if (e.judged) alpha = 1 - clamp01((now - e.resultTime) / 100);
    if (alpha <= 0.001) return;

    const colour = lerpRGB(YELLOW_DARK, YELLOW_DARKER, this.drumRollColourAt(e, now));

    if (this.legacy?.has.drumRoll) this.legacy.drawDrumRoll(ctx, x0, x1, CENTRE_Y, H, colour, roll.isStrong, alpha, this.ctx.combo, roll.startTime, now);
    else this.drawElongatedPiece(ctx, x0, x1, H, colour, alpha, e.judged, beat);

    // Ticks (TickPiece): positioned relative to the drum roll using its scroll multiplier.
    this.drawDrumRollTicks(ctx, e, roll, x0, alpha, now);
  }

  /** ElongatedCirclePiece: width = length + height, rounded ends. */
  private drawElongatedPiece(ctx: CanvasRenderingContext2D, x0: number, x1: number, H: number, colour: RGB, alpha: number, judged: boolean, beat: BeatState): void {
    ctx.globalAlpha = alpha;
    ctx.lineCap = 'round';
    // Glow (radius 8)
    for (let i = 3; i >= 1; i--) {
      ctx.strokeStyle = css(colour, (0.35 / i) * beat.glow);
      ctx.lineWidth = H + 8 * i * 0.8;
      ctx.beginPath();
      ctx.moveTo(x0, CENTRE_Y);
      ctx.lineTo(x1, CENTRE_Y);
      ctx.stroke();
    }
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = H;
    ctx.beginPath();
    ctx.moveTo(x0, CENTRE_Y);
    ctx.lineTo(x1, CENTRE_Y);
    ctx.stroke();
    ctx.strokeStyle = css(colour);
    ctx.lineWidth = H - SYMBOL_BORDER * 2;
    ctx.stroke();
    if (beat.flash > 0 && !judged) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = `rgba(255,255,255,${beat.flash})`;
      ctx.stroke();
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.lineCap = 'butt';
    ctx.globalAlpha = 1;
  }

  private drawDrumRollTicks(ctx: CanvasRenderingContext2D, e: Entry, roll: DrumRoll, x0: number, alpha: number, now: number): void {
    const pxPerMs = this.algo.controlPointAt(roll.startTime).multiplier * (this.scrollLength / this.timeRange);
    for (const n of e.nested) {
      const tick = n.obj;
      if (!(tick instanceof DrumRollTick)) continue;
      const tx = x0 + (tick.startTime - roll.startTime) * pxPerMs;
      if (tx < HIT_X - 40 || tx > this.layout.width + 40) continue;
      const tickSize = (tick.isStrong ? DEFAULT_STRONG_SIZE : DEFAULT_SIZE) * PF_H * 0.35;
      let ta = alpha * this.hiddenAlpha(tick, now);
      let ts = 1;
      if (n.isHit) {
        const t = clamp01((now - n.resultTime) / 200);
        ts = 1 + 0.4 * outQuint(t);
        ta *= 1 - outQuint(t);
      }
      if (ta <= 0.001) continue;
      if (this.legacy?.has.drumRollTick) {
        this.legacy.drawDrumRollTick(ctx, tx, CENTRE_Y, ts, ta);
        continue;
      }
      ctx.globalAlpha = ta;
      const tr = (tickSize * ts) / 2;
      ctx.beginPath();
      ctx.arc(tx, CENTRE_Y, Math.max(0, tr - 2.5), 0, Math.PI * 2);
      if (tick.firstTick) {
        ctx.fillStyle = '#fff';
        ctx.fill();
      }
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 5;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  private drawSwell(ctx: CanvasRenderingContext2D, e: Entry, swell: Swell, now: number, beat: BeatState): void {
    const D = DEFAULT_SIZE * PF_H;
    // Make the swell stop at the hit target
    const x = Math.max(HIT_X, this.xAt(swell.startTime, now));
    if (x - D / 2 > this.layout.width) return;

    let alpha = 1;
    let bodyAlpha = 1;
    let bodyScale = 1;
    if (e.judged) {
      const t = now - e.resultTime;
      // DrawableSwell: Hit -> Delay(660).FadeOut(); Miss -> Delay(300).FadeOut()
      if (t >= (e.isHit ? 660 : 300)) alpha = 0;
      // DefaultSwell.updateStateTransforms
      bodyAlpha = 1 - outQuad(clamp01(t / 300));
      bodyScale = 1 + 0.4 * clamp01(t / 300);
    }
    if (alpha <= 0) return;

    // Target ring: scales to 5x from start + 100 over 400ms (OutQuint).
    const ringT = clamp01((now - (swell.startTime + RING_APPEAR_OFFSET)) / 400);
    const targetScale = 1 + 4 * outQuint(ringT);

    ctx.save();
    ctx.globalAlpha = alpha * bodyAlpha;
    ctx.globalCompositeOperation = 'lighter';
    // Expanding ring (YellowLight, additive)
    const ringAlpha = clamp01(e.swellRingAlpha);
    if (ringAlpha > 0.001) {
      ctx.fillStyle = css(YELLOW_LIGHT, 0.65 * ringAlpha);
      ctx.beginPath();
      ctx.arc(x, CENTRE_Y, (D / 2) * e.swellRingScale * bodyScale, 0, Math.PI * 2);
      ctx.fill();
    }
    // Target ring (thick border 1.4: YellowDark @ 0.25; thin border 1: white)
    const tr = (D / 2) * targetScale * bodyScale;
    ctx.strokeStyle = css(YELLOW_DARK, 0.25);
    ctx.lineWidth = 1.4 * targetScale;
    ctx.beginPath();
    ctx.arc(x, CENTRE_Y, Math.max(0, tr - 0.7 * targetScale), 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 1 * targetScale;
    ctx.beginPath();
    ctx.arc(x, CENTRE_Y, Math.max(0, tr - 0.5 * targetScale), 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    // Centre circle (SwellCirclePiece)
    const centreAlpha = alpha * bodyAlpha;
    if (centreAlpha > 0.001) this.drawCirclePiece(ctx, x, CENTRE_Y, D * bodyScale, YELLOW_DARK, 'swell', centreAlpha, e.judged ? 0 : beat.flash, beat.glow, e.swellRotation);
  }

  private drawFlyingHits(ctx: CanvasRenderingContext2D, now: number, beat: BeatState): void {
    const gravityTime = this.hitAnimationLength();
    for (const f of this.flyingHits) {
      const t = now - f.time;
      if (t < 0 || t > 800) continue;
      const D = (f.strong ? DEFAULT_STRONG_SIZE : DEFAULT_SIZE) * PF_H;
      const x = this.xAt(f.time, now);
      const scale = 1 - 0.2 * outQuad(clamp01(t / (gravityTime * 2)));
      const y = CENTRE_Y + (t < gravityTime ? -200 * outQuad(t / gravityTime) : -200 + 400 * inQuad(clamp01((t - gravityTime) / (gravityTime * 2))));
      const alpha = 1 - clamp01(t / 800);
      if (this.legacy?.has.hitCircle) this.legacy.drawHit(ctx, x, y, D * scale, f.rim, f.strong, alpha, this.ctx.combo, f.time, now);
      else this.drawCirclePiece(ctx, x, y, D * scale, f.rim ? COLOUR_RIM : COLOUR_CENTRE, f.rim ? 'rim' : 'centre', alpha, 0.9 * (1 - clamp01(t / 300)), beat.glow);
    }
  }

  private drawBarLines(ctx: CanvasRenderingContext2D, now: number): void {
    const bars = this.playable.barLines;
    if (bars.length === 0) return;
    const W = this.layout.width;
    // Find the first bar line that may still be visible (fading out over 150ms at its start time).
    let lo = 0;
    let hi = bars.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (bars[mid].startTime < now - 150) lo = mid + 1;
      else hi = mid;
    }
    const maxAhead = this.timeRange * this.visibleAheadFactor + 100;
    ctx.fillStyle = '#fff';
    for (let i = lo; i < bars.length; i++) {
      const b = bars[i];
      if (b.startTime > now + maxAhead) break;
      const x = this.xAt(b.startTime, now);
      if (x > W + 2) continue;
      // DrawableBarLine: FadeOutFromOne(150) at StartTime
      let alpha = b.major ? 1 : 0.75;
      if (now > b.startTime) alpha *= 1 - clamp01((now - b.startTime) / 150);
      if (alpha <= 0) continue;
      if (this.legacy?.has.barLine) {
        this.legacy.drawBarLine(ctx, x, CENTRE_Y, PF_H, alpha);
        continue;
      }
      ctx.globalAlpha = alpha;
      ctx.fillRect(x - 1, 0, 2, PF_H);
      if (b.major) {
        const size = 20;
        const h = size * 0.866;
        ctx.beginPath();
        ctx.moveTo(x - size / 2, 0);
        ctx.lineTo(x + size / 2, 0);
        ctx.lineTo(x, h * 0.6);
        ctx.closePath();
        ctx.moveTo(x - size / 2, PF_H);
        ctx.lineTo(x + size / 2, PF_H);
        ctx.lineTo(x, PF_H - h * 0.6);
        ctx.closePath();
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  /** TaikoHitTarget */
  private drawHitTarget(ctx: CanvasRenderingContext2D): void {
    const borderThickness = 2.5;
    const barHeight = ((1 - DEFAULT_STRONG_SIZE) / 2) * PF_H;
    ctx.fillStyle = '#fff';
    ctx.globalAlpha = 0.1;
    ctx.fillRect(HIT_X - borderThickness / 2, 0, borderThickness, barHeight);
    ctx.fillRect(HIT_X - borderThickness / 2, PF_H - barHeight, borderThickness, barHeight);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = borderThickness;
    ctx.beginPath();
    ctx.arc(HIT_X, CENTRE_Y, (DEFAULT_STRONG_SIZE * PF_H) / 2 - borderThickness / 2, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    ctx.arc(HIT_X, CENTRE_Y, (DEFAULT_SIZE * PF_H) / 2 - borderThickness / 2, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  /** Kiai glow behind the hit target (after LegacyKiaiGlow; the default skin has none). */
  private drawKiaiGlow(ctx: CanvasRenderingContext2D, now: number): void {
    if (this.kiaiGlowAlpha <= 0.001) return;
    const bump = now - this.kiaiGlowBumpTime;
    const scale = bump >= 0 && bump < 80 ? 1 + 0.15 * (1 - outQuad(bump / 80)) : 1;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    this.drawGlowSprite(ctx, HIT_X, CENTRE_Y, 30 * scale, 70 * scale, KIAI_GLOW_COLOUR, this.kiaiGlowAlpha * 0.6);
    ctx.restore();
  }

  /** DefaultHitExplosion */
  private drawExplosions(ctx: CanvasRenderingContext2D, now: number): void {
    if (this.explosions.length === 0) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const ex of this.explosions) {
      const t = now - ex.time;
      if (t < 0 || t > 1000) continue;
      const alpha = 0.15 * (1 - clamp01(t / 500));
      if (alpha <= 0) continue;
      let size = DEFAULT_SIZE * PF_H * (1 + 2 * outQuint(t / 1000));
      if (ex.secondHitTime !== null && now >= ex.secondHitTime) size *= 1 + (STRONG_SCALE - 1) * clamp01((now - ex.secondHitTime) / 50);
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.arc(HIT_X, CENTRE_Y, size / 2, 0, Math.PI * 2);
      if (isHit(ex.result)) {
        ctx.fillStyle = css(ex.rim ? BLUE_DARKER : PINK_DARKER);
        ctx.fill();
      }
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.restore();
  }

  /** DefaultKiaiHitExplosion */
  private drawKiaiExplosions(ctx: CanvasRenderingContext2D, now: number): void {
    if (this.kiaiExplosions.length === 0) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const k of this.kiaiExplosions) {
      const t = now - k.time;
      if (t < 0 || t > 500) continue;
      const alpha = 0.25 * (1 - clamp01(t / 250));
      if (alpha <= 0) continue;
      const w = DEFAULT_SIZE * PF_H;
      const h = PF_H * (1 + 2 * outQuint(t / 500));
      const colour = k.rim ? BLUE_DARKER : PINK_DARKER;
      const g = ctx.createRadialGradient(HIT_X, CENTRE_Y, 0, HIT_X, CENTRE_Y, w / 2 + 60);
      g.addColorStop(0, css(colour, 1));
      g.addColorStop(0.5, css(colour, 0.6));
      g.addColorStop(1, css(colour, 0));
      ctx.globalAlpha = alpha;
      ctx.fillStyle = g;
      ctx.save();
      ctx.translate(HIT_X, CENTRE_Y);
      ctx.scale(1, h / (w + 120));
      ctx.translate(-HIT_X, -CENTRE_Y);
      ctx.beginPath();
      ctx.arc(HIT_X, CENTRE_Y, w / 2 + 60, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();
  }

  /** DrawableTaikoJudgement + taiko DefaultJudgementPiece animations */
  private drawJudgements(ctx: CanvasRenderingContext2D, now: number): void {
    if (this.judgements.length === 0) return;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 20px sans-serif';
    for (const j of this.judgements) {
      const t = now - j.time;
      if (t < 0 || t > 800) continue;
      const text = RESULT_TEXT[j.result];
      if (!text) continue;
      ctx.fillStyle = RESULT_COLOURS[j.result] ?? '#fff';
      ctx.save();
      if (j.result !== HitResult.Miss) {
        ctx.globalAlpha = 1 - outQuint(t / 800);
        const y = CENTRE_Y + PF_H * (-0.6 - 0.9 * clamp01(t / 500));
        const scale = 0.9 + 0.1 * outElastic(clamp01(t / 500));
        ctx.translate(HIT_X, y);
        ctx.scale(0.85 * scale, scale);
      } else {
        // DefaultJudgementPiece.PlayAnimation (miss)
        ctx.globalAlpha = 1 - clamp01(t / 800);
        const scale = 1.6 - 0.6 * inQuad(clamp01(t / 100));
        const y = CENTRE_Y + Math.min(PF_H * 2, 100 * PF_H * inQuint(clamp01(t / 800)));
        ctx.translate(HIT_X, y);
        ctx.rotate(((40 * inQuint(clamp01(t / 800))) * Math.PI) / 180);
        ctx.scale(0.85 * scale, scale);
      }
      ctx.fillText(text, 0, 0);
      ctx.restore();
    }
    ctx.restore();
  }

  /** DefaultInputDrum (procedural) + combo display. */
  private drawInputDrum(ctx: CanvasRenderingContext2D, now: number): void {
    const cx = INPUT_DRUM_WIDTH / 2;
    const cy = CENTRE_Y;
    const R = (INPUT_DRUM_WIDTH * 0.9) / 2;
    const split = (INPUT_DRUM_WIDTH * 0.9 * 0.025) / 2;
    const inner = R * 0.7;

    const half = (left: boolean, rimAction: TaikoAction, centreAction: TaikoAction): void => {
      const ox = left ? cx - split : cx + split;
      const a0 = left ? Math.PI / 2 : -Math.PI / 2;
      const a1 = left ? (Math.PI * 3) / 2 : Math.PI / 2;
      const rimAlpha = this.drumOverlayAlpha(rimAction, now);
      const centreAlpha = this.drumOverlayAlpha(centreAction, now);
      const rimScale = 1 - 0.05 * (rimAlpha > 0 ? Math.min(1, rimAlpha * 2) : 0);
      const centreScale = 1 - 0.05 * (centreAlpha > 0 ? Math.min(1, centreAlpha * 2) : 0);

      // Rim (outer)
      ctx.fillStyle = '#d9d9d9';
      ctx.beginPath();
      ctx.moveTo(ox, cy);
      ctx.arc(ox, cy, R * rimScale, a0, a1);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#2a2a2a';
      ctx.beginPath();
      ctx.moveTo(ox, cy);
      ctx.arc(ox, cy, R * rimScale - 7, a0, a1);
      ctx.closePath();
      ctx.fill();
      if (rimAlpha > 0.001) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = rimAlpha;
        ctx.fillStyle = css(BLUE);
        ctx.beginPath();
        ctx.arc(ox, cy, R * rimScale, a0, a1);
        ctx.arc(ox, cy, inner * centreScale + 4, a1, a0, true);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
      // Centre (inner)
      ctx.fillStyle = '#f2ece4';
      ctx.beginPath();
      ctx.moveTo(ox, cy);
      ctx.arc(ox, cy, inner * centreScale, a0, a1);
      ctx.closePath();
      ctx.fill();
      if (centreAlpha > 0.001) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = centreAlpha;
        ctx.fillStyle = css(PINK);
        ctx.beginPath();
        ctx.moveTo(ox, cy);
        ctx.arc(ox, cy, inner * centreScale, a0, a1);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
    };
    half(true, 'LeftRim', 'LeftCentre');
    half(false, 'RightRim', 'RightCentre');
    this.drawDrumCombo(ctx);
  }

  /** Combo display on the drum. */
  private drawDrumCombo(ctx: CanvasRenderingContext2D): void {
    const cx = INPUT_DRUM_WIDTH / 2;
    const cy = CENTRE_Y;
    if (this.drumCombo && this.ctx.combo > 0) {
      ctx.save();
      ctx.font = 'bold 34px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 5;
      ctx.strokeStyle = 'rgba(0,0,0,0.65)';
      ctx.fillStyle = '#fff';
      const text = String(this.ctx.combo);
      ctx.strokeText(text, cx, cy);
      ctx.fillText(text, cx, cy);
      ctx.restore();
    }
  }

  /** DrumTouchInputArea */
  private drawTouchControls(ctx: CanvasRenderingContext2D): void {
    const alpha = this.touchAlpha();
    if (alpha <= 0.001) return;
    const g = this.touchGeometry();
    const containerTop = this.height + 20 * this.layout.unit - this.height * 0.45;
    const [leftRim, leftCentre, rightCentre, rightRim] = this.touchActions;
    const colourFor = (a: TaikoAction): RGB => (isRimAction(a) ? BLUE : PINK);
    // circle colour: colour.Multiply(1.4f).Darken(2.8f)
    const dark = (c: RGB): RGB => [Math.min(255, (c[0] * 1.4) / 3.8), Math.min(255, (c[1] * 1.4) / 3.8), Math.min(255, (c[2] * 1.4) / 3.8)];

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, containerTop, this.width, this.height - containerTop);
    ctx.clip();
    const quarter = (left: boolean, radius: number, action: TaikoAction): void => {
      const ox = left ? g.cx - g.gap : g.cx + g.gap;
      const a0 = left ? Math.PI : (Math.PI * 3) / 2;
      const a1 = left ? (Math.PI * 3) / 2 : Math.PI * 2;
      ctx.globalAlpha = alpha * 0.8;
      ctx.fillStyle = css(dark(colourFor(action)));
      ctx.beginPath();
      ctx.moveTo(ox, g.cy);
      ctx.arc(ox, g.cy, radius, a0, a1);
      ctx.closePath();
      ctx.fill();
      const overlay = this.segmentOverlayAlpha(action);
      if (overlay > 0.001) {
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = alpha * overlay;
        ctx.fillStyle = css(colourFor(action));
        ctx.fill();
        ctx.globalCompositeOperation = 'source-over';
      }
    };
    quarter(true, g.radius, leftRim);
    quarter(false, g.radius, rightRim);
    quarter(true, g.radius * 0.8, leftCentre);
    quarter(false, g.radius * 0.8, rightCentre);
    ctx.restore();
  }

  /** TaikoModFlashlight (CircularFlashlight shader, smoothness 1.4). */
  private drawFlashlight(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    const L = this.layout;
    const u = L.unit;
    // FlashlightPosition = 208 * STABLE_MAGIC_SCALE_FACTOR (1.6) * PlayfieldAdjustmentContainer.Scale.X, in both axes.
    // In a 768-unit tall game the playfield top sits at 216 units, so the Y is expressed relative to the playfield
    // (identical in landscape, and keeps the light on the playfield on portrait screens).
    const fx = 208 * 1.6 * L.scale;
    const fy = L.top + (208 * 1.6 - (768 * 135) / 480) * L.scale;
    const radius = Math.max(1, (this.flashlightSize < 0 ? 200 : this.flashlightSize) * u);
    const g = ctx.createRadialGradient(fx, fy, radius, fx, fy, radius * 1.4);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,1)');
    ctx.save();
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
  }

  /** BeatSyncedContainer state used by CirclePiece kiai effects. */
  private beatState(now: number): BeatState {
    const out: BeatState = { flash: 0, glow: 1 };
    if (!this.kiaiTimes) return out;
    const cp = this.playable.controlPoints;
    const t = now + PRE_BEAT_TRANSITION_TIME;
    const tp = cp.timingPointAt(t);
    const bl = tp.beatLength;
    const beatIndex = Math.floor((t - tp.time) / bl);
    const beatStart = tp.time + beatIndex * bl;
    if (!cp.effectPointAt(beatStart).kiaiMode) return out;
    // flashBox.FadeTo(kiai_flash_opacity).Then().FadeOut(beatLength * 0.75, OutSine)
    out.flash = KIAI_FLASH_OPACITY * (1 - outSine(clamp01((t - beatStart) / (bl * 0.75))));
    // Bar starts: FadeEdgeEffectTo(1, 80, OutQuint).Then().FadeEdgeEffectTo(edge_alpha_kiai, beatLength * 2, OutQuint)
    const sig = Math.max(1, tp.timeSignature);
    const barIndex = Math.floor(beatIndex / sig) * sig;
    const e = t - (tp.time + barIndex * bl);
    out.glow = e < PRE_BEAT_TRANSITION_TIME ? 0.5 + 0.5 * outQuint(e / PRE_BEAT_TRANSITION_TIME) : 1 - 0.5 * outQuint(clamp01((e - PRE_BEAT_TRANSITION_TIME) / (bl * 2)));
    return out;
  }

  dispose(): void {
    this.sprites.clear();
  }

  /** Exposed for tests: the judged result of every top-level object. */
  get resultsForTesting(): HitResult[] {
    return this.entries.map(e => e.result);
  }
}

interface BeatState {
  flash: number;
  glow: number;
}

function pruneBefore<T extends { time: number }>(list: T[], time: number): void {
  let n = 0;
  while (n < list.length && list[n].time < time) n++;
  if (n > 0) list.splice(0, n);
}
