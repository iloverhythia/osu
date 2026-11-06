// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Gameplay for osu!taiko. Ports the judging logic of:
//  - osu.Game.Rulesets.Taiko/Objects/Drawables/DrawableHit.cs (+ StrongNestedHit "second hit" judging)
//  - DrawableDrumRoll.cs, DrawableDrumRollTick.cs, DrawableSwell.cs, DrawableSwellTick.cs, DrawableFlyingHit.cs
//  - osu.Game.Rulesets.Taiko/UI/TaikoPlayfield.cs, DrawableTaikoRuleset.cs, DrumSamplePlayer.cs, DrumSampleTriggerSource.cs,
//    DrumTouchInputArea.cs, HitExplosion.cs, KiaiHitExplosion.cs, DrawableTaikoJudgement.cs
//  - Mods: TaikoModHidden, TaikoModFlashlight, TaikoModRelax, ModCinema; Replays: TaikoAutoGenerator / FramedReplayInputHandler.
// Visuals are drawn procedurally after the default (Argon) taiko skin pieces (osu.Game.Rulesets.Taiko/Skinning/Argon/*:
// ArgonCirclePiece + Centre/Rim/Elongated/Swell pieces, RingPiece, ArgonTickPiece, ArgonBarLine, ArgonHitTarget, ArgonHitExplosion,
// ArgonInputDrum, ArgonJudgementPiece, ArgonPlayfieldBackgroundLeft/Right, ArgonSwell -> Default/DefaultSwell),
// or with legacy skin elements by TaikoLegacySkinRenderer (legacySkin.ts) when a user / beatmap skin provides them.
import { TaikoLegacySkinRenderer } from './legacySkin';
import { Easing, applyEasing } from '../../storyboard/Easing';
import {
  FA_ANGLE_LEFT,
  FA_ASTERISK,
  type Glyph,
  clamp01,
  css,
  drawCircleGlow,
  drawIcon,
  drawSpacedText,
  fillCircle,
  fillPillBorder,
  roundRectPath,
  seededRandom,
} from './argonDraw';

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
const PRE_BEAT_TRANSITION_TIME = 80;
const KIAI_FLASH_OPACITY = 0.15;
/** TaikoModHidden */
const HD_FADE_OUT_START_TIME = 1;
const HD_FADE_OUT_DURATION = 0.375;
/** DrumSampleTriggerSource stereo spread per sample (ApplySampleInfo: -0.05 + RNG.NextDouble(0.1)). */
const SAMPLE_BALANCE_SPREAD = 0.1;
/** DrawableHit gravity_time / gravity_travel_height */
const GRAVITY_TIME = 300;
const GRAVITY_TRAVEL_HEIGHT = 200;
/** DrawableBarLine tracker_width, ArgonBarLine major_extension */
const BAR_LINE_WIDTH = 2;
const BAR_LINE_MAJOR_EXTENSION = 10;

type RGB = [number, number, number];
const YELLOW_DARK: RGB = [0xee, 0xaa, 0x00];
const YELLOW_DARKER: RGB = [0xcc, 0x66, 0x00];
const YELLOW_LIGHT: RGB = [0xff, 0xdd, 0x55];
const PINK: RGB = [0xff, 0x66, 0xaa];
const BLUE: RGB = [0x66, 0xcc, 0xff];
const WHITE: RGB = [255, 255, 255];

// ---- Argon skin (osu.Game.Rulesets.Taiko/Skinning/Argon/*)
/** ArgonCirclePiece.ICON_SIZE */
const ARGON_ICON_SIZE = 20 / 70;
/** ArgonTickPiece tick_size */
const ARGON_TICK_SIZE = (1 / DEFAULT_SIZE) * ARGON_ICON_SIZE;
/** ColourInfo.GradientVertical accents of ArgonCentreCirclePiece / ArgonRimCirclePiece / ArgonElongatedCirclePiece / ArgonSwellCirclePiece */
const ARGON_CENTRE: readonly [RGB, RGB] = [
  [241, 0, 0],
  [167, 0, 0],
];
const ARGON_RIM: readonly [RGB, RGB] = [
  [0, 161, 241],
  [0, 111, 167],
];
const ARGON_DRUM_ROLL: readonly [RGB, RGB] = [
  [241, 161, 0],
  [167, 111, 0],
];
const ARGON_SWELL: readonly [RGB, RGB] = [
  [240, 201, 0],
  [167, 139, 0],
];
/** ArgonInputDrum */
const RIM_HIT_GRADIENT: readonly [RGB, RGB] = [
  [227, 248, 255],
  [198, 245, 255],
];
const RIM_HIT_GLOW: RGB = [126, 215, 253];
const CENTRE_HIT_GRADIENT: readonly [RGB, RGB] = [
  [255, 227, 236],
  [255, 198, 211],
];
const CENTRE_HIT_GLOW: RGB = [255, 147, 199];
const RIM_SIZE = 0.3;
const MIDDLE_SPLIT = 6;
const GRAY_38: RGB = [38, 38, 38];
const GRAY_48: RGB = [48, 48, 48];
const GRAY_51: RGB = [51, 51, 51];
const GRAY_64: RGB = [64, 64, 64];

/** OsuColour.ForHitResult */
const RESULT_COLOURS: Partial<Record<HitResult, RGB>> = {
  [HitResult.Great]: [0x66, 0xcc, 0xff],
  [HitResult.Ok]: [0x88, 0xb3, 0x00],
  [HitResult.Miss]: [0xed, 0x11, 0x21],
};
/** HitResult.GetDescription().ToUpperInvariant() */
const RESULT_TEXT: Partial<Record<HitResult, string>> = {
  [HitResult.Great]: 'GREAT',
  [HitResult.Ok]: 'OK',
  [HitResult.Miss]: 'MISS',
};
/** Torus is substituted by the app font. */
const FONT = '"Exo 2", system-ui, sans-serif';

const lerpRGB = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const outQuint = (t: number): number => 1 - Math.pow(1 - t, 5);
const horizontalGradient = (ctx: CanvasRenderingContext2D, x0: number, x1: number, colours: readonly [RGB, RGB]): CanvasGradient => {
  const g = ctx.createLinearGradient(x0, 0, x1, 0);
  g.addColorStop(0, css(colours[0]));
  g.addColorStop(1, css(colours[1]));
  return g;
};

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

interface JudgementPopup {
  time: number;
  result: HitResult;
  /** Seed for the RingExplosion's random directions / distances. */
  seed: number;
}

interface FlyingHit {
  time: number;
  rim: boolean;
  strong: boolean;
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
  private readonly judgements: JudgementPopup[] = [];
  private readonly flyingHits: FlyingHit[] = [];
  private readonly drumPress: Record<TaikoAction, { time: number; from: number; peak: number }> = {
    LeftRim: { time: -Infinity, from: 0, peak: 0 },
    LeftCentre: { time: -Infinity, from: 0, peak: 0 },
    RightCentre: { time: -Infinity, from: 0, peak: 0 },
    RightRim: { time: -Infinity, from: 0, peak: 0 },
  };
  private kiaiGlowAlpha = 0;
  private kiaiGlowBumpTime = -Infinity;

  // touch (DrumTouchInputArea)
  private readonly trackedTouches = new Map<number, TaikoAction>();
  private touchVisible = false;
  private touchVisibilityChangeTime = -Infinity;
  private touchAlphaAtChange = 0;
  private readonly touchSegmentState: Record<TaikoAction, { pressTime: number; releaseTime: number; alphaAtRelease: number }> = {
    LeftRim: {
      pressTime: -Infinity,
      releaseTime: -Infinity,
      alphaAtRelease: 0,
    },
    LeftCentre: {
      pressTime: -Infinity,
      releaseTime: -Infinity,
      alphaAtRelease: 0,
    },
    RightCentre: {
      pressTime: -Infinity,
      releaseTime: -Infinity,
      alphaAtRelease: 0,
    },
    RightRim: {
      pressTime: -Infinity,
      releaseTime: -Infinity,
      alphaAtRelease: 0,
    },
  };
  private realNow = 0;

  // flashlight
  private flashlightSize = -1;

  // layout
  private width = 0;
  private height = 0;
  private layout: TaikoLayout = { scale: 1, top: 0, width: 1, unit: 1 };
  private timeRange = 1000;

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
        if (hit && this.hitAnimations)
          this.flyingHits.push({
            time: e.obj.startTime + e.timeOffset,
            rim: e.judgementType === HitType.Rim,
            strong: (e.obj as DrumRollTick).isStrong,
          });
        break;
      }

      case 'hit': {
        if (type !== HitResult.Great && type !== HitResult.Ok && type !== HitResult.Miss) break;
        this.judgements.push({
          time,
          result: type,
          seed: Math.round(time * 16) ^ (e.obj.startTime | 0),
        });
        const rim = (e.obj as Hit).type === HitType.Rim;
        const explosion: Explosion = {
          time,
          result: type,
          rim,
          secondHitTime: null,
        };
        e.explosion = explosion;
        this.explosions.push(explosion);
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
      const samples: HitSampleInfo[] = strong
        ? [baseSample, createHitSampleInfo(obj.samples, hitType === HitType.Rim ? HIT_WHISTLE : HIT_FINISH)]
        : [baseSample];
      this.ctx.playSamples(samples, {
        pan: -SAMPLE_BALANCE_SPREAD / 2 + Math.random() * SAMPLE_BALANCE_SPREAD,
      });
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
  private touchGeometry(): {
    cx: number;
    cy: number;
    radius: number;
    gap: number;
  } {
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
      // ArgonInputDrum.TaikoHalfDrum.OnPressed: FadeTo(Math.Min(Alpha + 0.5, 1), 40, OutQuint).Then().FadeOut(750, OutQuint)
      const d = this.drumPress[action];
      this.legacy?.onDrumPressed(action, time);
      const current = this.drumOverlayAlpha(action, time);
      d.from = current;
      d.peak = Math.min(current + 0.5, 1);
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
    const upTime = 750;
    if (e < downTime) return d.from + (d.peak - d.from) * outQuint(e / downTime);
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

    // PlayfieldBackgroundRight (ArgonPlayfieldBackgroundRight: black box, alpha 0.7)
    if (legacy?.has.barRight) legacy.drawBackgroundRight(ctx, W, PF_H, now, this.isKiai(now));
    else {
      ctx.fillStyle = 'rgba(0,0,0,0.7)';
      ctx.fillRect(0, 0, W, PF_H);
    }

    // "Left overlay": PlayfieldBackgroundLeft (ArgonPlayfieldBackgroundLeft: black box) + the proxied input drum.
    // (Legacy skins providing "taiko-bar-right" display the left background inside LegacyInputDrum.)
    if (!legacy?.has.barRight) {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, INPUT_DRUM_WIDTH, PF_H);
    }

    if (legacy?.has.inputDrum) legacy.drawInputDrum(ctx, INPUT_DRUM_WIDTH, PF_H, now);
    else this.drawInputDrum(ctx, now);
    this.drawDrumCombo(ctx);

    // "Elements behind hit objects": kiai glow (argon: none), hit explosions, hit target
    if (legacy?.has.kiaiGlow) legacy.drawKiaiGlow(ctx, HIT_X, CENTRE_Y, this.kiaiGlowAlpha, this.kiaiGlowBumpTime, now);
    if (legacy?.has.explosions) {
      for (const ex of this.explosions) legacy.drawExplosion(ctx, HIT_X, CENTRE_Y, ex.result, ex.time, ex.secondHitTime, now);
    } else this.drawExplosions(ctx, now);
    if (legacy?.has.hitTarget) legacy.drawHitTarget(ctx, HIT_X, CENTRE_Y);
    else this.drawHitTarget(ctx);

    // "Bar line content" (not masked)
    this.drawBarLines(ctx, now);

    // "Masked hit objects content"
    const proxied: Entry[] = [];
    ctx.save();
    ctx.beginPath();
    ctx.rect(HIT_X, -PF_H, W - HIT_X, PF_H * 3);
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

    // "Overlay content": judgements (hidden when a legacy skin provides explosion sprites).
    // TaikoExplosionKiai is an expired empty drawable in the argon skin.
    if (!legacy?.has.explosions) this.drawJudgements(ctx, now);

    // "Top level hit objects" (proxied content), earliest on top.
    for (const e of proxied) this.drawEntry(ctx, e, now, beat);

    // Drum roll flying hits (DrumRollHitContainer proxy, above everything)
    this.drawFlyingHits(ctx, now);
  }

  private isProxied(e: Entry, now: number): boolean {
    if (e.obj instanceof Hit) return e.isHit && this.hitAnimations;
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
    return GRAVITY_TIME * (this.rateAdjustedHitAnimations ? 1 : Math.abs(this.ctx.rate));
  }

  /**
   * DrawableHit.UpdateHitStateTransforms(ArmedState.Hit), relative to the hit time:
   * ScaleTo(0.8, length * 2, OutQuad); MoveToY(-200, length, Out).Then().MoveToY(400, length * 2, In); FadeOut(800).
   */
  private hitGravity(t: number): { y: number; scale: number; alpha: number } {
    const length = this.hitAnimationLength();
    const scale = 1 - 0.2 * applyEasing(Easing.OutQuad, clamp01(t / (length * 2)));
    const y =
      t < length
        ? -GRAVITY_TRAVEL_HEIGHT * applyEasing(Easing.Out, t / length)
        : -GRAVITY_TRAVEL_HEIGHT + GRAVITY_TRAVEL_HEIGHT * 3 * applyEasing(Easing.In, clamp01((t - length) / (length * 2)));
    return { y, scale, alpha: 1 - clamp01(t / 800) };
  }

  private drawHit(ctx: CanvasRenderingContext2D, e: Entry, h: Hit, now: number, beat: BeatState): void {
    const D = (h.isStrong ? DEFAULT_STRONG_SIZE : DEFAULT_SIZE) * PF_H;
    const x = this.xAt(h.startTime, now);
    let y = CENTRE_Y;
    let alpha = this.hiddenAlpha(h, now);
    let scale = 1;
    let flash = beat.flash;

    if (e.judged) {
      const t = now - e.resultTime;
      if (t < 0) {
        // not yet (rewinding) - draw normally
      } else if (!e.isHit) {
        // ArmedState.Miss: FadeOut(hitAnimations ? 100 : 60). The flash layer keeps its last kiai pulse.
        alpha *= 1 - clamp01(t / (this.hitAnimations ? 100 : 60));
      } else if (!this.hitAnimations) {
        alpha = 0;
      } else {
        const g = this.hitGravity(t);
        scale = g.scale;
        y += g.y;
        alpha *= g.alpha;
        // ArgonCirclePiece: flash.FadeTo(0.9f).FadeOut(500, Easing.OutQuint)
        flash = 0.9 * (1 - applyEasing(Easing.OutQuint, clamp01(t / 500)));
      }
    }
    if (alpha <= 0.001) return;
    if (x - D / 2 > this.layout.width || x + D < -200) return;

    const rim = h.type === HitType.Rim;
    if (this.legacy?.has.hitCircle) this.legacy.drawHit(ctx, x, y, D * scale, rim, h.isStrong, alpha, this.ctx.combo, h.startTime, now);
    else
      this.drawArgonCirclePiece(
        ctx,
        x - (D * scale) / 2,
        y - (D * scale) / 2,
        D * scale,
        D * scale,
        rim ? ARGON_RIM : ARGON_CENTRE,
        FA_ANGLE_LEFT,
        alpha,
        flash,
      );
  }

  /**
   * ArgonCirclePiece (+ ArgonCentreCirclePiece / ArgonRimCirclePiece / ArgonElongatedCirclePiece / ArgonSwellCirclePiece):
   * a black (alpha 190/255) circle, a 20/70 ring of the accent gradient at half opacity, a 5/70 ring of the accent gradient,
   * an additive white flash layer and a white FontAwesome icon (ICON_SIZE, scale (0.8, 1)).
   */
  private drawArgonCirclePiece(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    accent: readonly [RGB, RGB],
    icon: Glyph | null,
    alpha: number,
    flash: number,
    rotation = 0,
  ): void {
    if (h <= 0) return;
    const r = h / 2;
    const prev = ctx.globalAlpha;
    ctx.globalAlpha = prev * alpha;

    ctx.fillStyle = 'rgba(0,0,0,0.7451)';
    ctx.beginPath();
    roundRectPath(ctx, x, y, w, h, r);
    ctx.fill();

    const gradient = (a: number): CanvasGradient => {
      const g = ctx.createLinearGradient(0, y, 0, y + h);
      g.addColorStop(0, css(accent[0], a));
      g.addColorStop(1, css(accent[1], a));
      return g;
    };
    ctx.fillStyle = gradient(0.5);
    fillPillBorder(ctx, x, y, w, h, (20 / 70) * h);
    ctx.fillStyle = gradient(1);
    fillPillBorder(ctx, x, y, w, h, (5 / 70) * h);

    if (flash > 0.001) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = prev * alpha * flash;
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      roundRectPath(ctx, x, y, w, h, r);
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = prev * alpha;
    }

    if (icon) {
      ctx.fillStyle = '#fff';
      // The icon is centred in the piece, which is square for hits and swells.
      drawIcon(ctx, icon, x + w / 2, y + h / 2, ARGON_ICON_SIZE * h, 0.8, 1, rotation);
    }
    ctx.globalAlpha = prev;
  }

  private drawDrumRoll(ctx: CanvasRenderingContext2D, e: Entry, roll: DrumRoll, now: number, beat: BeatState): void {
    const H = (roll.isStrong ? DEFAULT_STRONG_SIZE : DEFAULT_SIZE) * PF_H;
    const x0 = this.xAt(roll.startTime, now);
    const length = this.algo.getLength(roll.startTime, roll.endTime, this.timeRange, this.scrollLength);
    const x1 = x0 + length;
    if (x0 - H / 2 > this.layout.width || x1 + H < HIT_X - H) return;

    // ArmedState.Hit / Miss: FadeOut(100)
    let alpha = 1;
    if (e.judged) alpha = 1 - clamp01((now - e.resultTime) / 100);
    if (alpha <= 0.001) return;

    if (this.legacy?.has.drumRoll) {
      const colour = lerpRGB(YELLOW_DARK, YELLOW_DARKER, this.drumRollColourAt(e, now));
      this.legacy.drawDrumRoll(ctx, x0, x1, CENTRE_Y, H, colour, roll.isStrong, alpha, this.ctx.combo, roll.startTime, now);
    } else {
      // DrawableDrumRoll: the content starts at the start time (Content.X = DrawHeight / 2 with origin DrawHeight / 2);
      // ArgonElongatedCirclePiece: Width = content width + DrawHeight. ArgonCirclePiece has no IHasAccentColour,
      // so rolling hits don't change its colour; the hit flash only applies to Hits.
      this.drawArgonCirclePiece(ctx, x0, CENTRE_Y - H / 2, length + H, H, ARGON_DRUM_ROLL, null, alpha, e.judged ? 0 : beat.flash);
    }

    this.drawDrumRollTicks(ctx, e, roll, x0, length, H, alpha, now);
  }

  /** DrawableDrumRollTick + ArgonTickPiece, positioned relative to the drum roll using its scroll multiplier. */
  private drawDrumRollTicks(ctx: CanvasRenderingContext2D, e: Entry, roll: DrumRoll, x0: number, length: number, H: number, alpha: number, now: number): void {
    const pxPerMs = this.algo.controlPointAt(roll.startTime).multiplier * (this.scrollLength / this.timeRange);
    const prev = ctx.globalAlpha;
    for (const n of e.nested) {
      const tick = n.obj;
      if (!(tick instanceof DrumRollTick)) continue;
      const tx = x0 + (tick.startTime - roll.startTime) * pxPerMs;
      if (tx < HIT_X - 80 || tx > this.layout.width + 80) continue;
      // Size = (DEFAULT_STRONG_SIZE or DEFAULT_SIZE) relative to the tick container (length x H), FillMode.Fit.
      const tickBox = (tick.isStrong ? DEFAULT_STRONG_SIZE : DEFAULT_SIZE) * Math.min(Math.max(0, length), H);
      let ta = alpha * this.hiddenAlpha(tick, now);
      let ts = 1;
      if (n.isHit) {
        // ScaleTo(1.4f, 200, OutQuint); FadeOut(200, OutQuint)
        const t = clamp01((now - n.resultTime) / 200);
        const eased = applyEasing(Easing.OutQuint, t);
        ts = 1 + 0.4 * eased;
        ta *= 1 - eased;
      }
      if (ta <= 0.001) continue;
      if (this.legacy?.has.drumRollTick) {
        this.legacy.drawDrumRollTick(ctx, tx, CENTRE_Y, ts, ta);
        continue;
      }
      // ArgonTickPiece: Size = 1 / DEFAULT_SIZE * ICON_SIZE (FillMode.Fit)
      const size = tickBox * ARGON_TICK_SIZE * ts;
      ctx.globalAlpha = prev * ta;
      ctx.fillStyle = '#fff';
      if (tick.firstTick) fillCircle(ctx, tx, CENTRE_Y, size / 2);
      else drawIcon(ctx, FA_ANGLE_LEFT, tx, CENTRE_Y, size, 0.8, 1);
    }
    ctx.globalAlpha = prev;
  }

  /** DrawableSwell + ArgonSwell (DefaultSwell with an ArgonSwellCirclePiece). */
  private drawSwell(ctx: CanvasRenderingContext2D, e: Entry, swell: Swell, now: number, beat: BeatState): void {
    const D = DEFAULT_SIZE * PF_H;
    // Make the swell stop at the hit target (X = Math.Max(0, X))
    const x = Math.max(HIT_X, this.xAt(swell.startTime, now));
    if (x - (D / 2) * 5 > this.layout.width) return;

    let alpha = 1;
    let bodyAlpha = 1;
    let bodyScale = 1;
    let centreAlpha = 1;
    if (e.judged) {
      const t = now - e.resultTime;
      // DrawableSwell: Hit -> Delay(660).FadeOut(); Miss -> Delay(300).FadeOut()
      if (t >= (e.isHit ? 660 : 300)) alpha = 0;
      // DefaultSwell.updateStateTransforms: bodyContainer.FadeOut(300, OutQuad) + ScaleTo(1.4, 300); centreCircle.FadeOut(300, OutQuad)
      if (t >= 0) {
        bodyAlpha = 1 - applyEasing(Easing.OutQuad, clamp01(t / 300));
        bodyScale = 1 + 0.4 * clamp01(t / 300);
        centreAlpha = bodyAlpha;
      }
    }
    if (alpha <= 0 || bodyAlpha <= 0.001) return;

    // targetRing.Delay(ring_appear_offset).ScaleTo(target_ring_scale, 400, OutQuint) at the swell's start time.
    const targetScale = 1 + 4 * applyEasing(Easing.OutQuint, clamp01((now - (swell.startTime + RING_APPEAR_OFFSET)) / 400));

    const prev = ctx.globalAlpha;
    ctx.save();
    ctx.globalAlpha = prev * alpha * bodyAlpha;
    ctx.globalCompositeOperation = 'lighter';
    // Expanding ring (YellowLight box at inner_ring_alpha, additive)
    const ringAlpha = clamp01(e.swellRingAlpha);
    if (ringAlpha > 0.001 && now >= swell.startTime) {
      ctx.fillStyle = css(YELLOW_LIGHT, 0.65 * ringAlpha);
      fillCircle(ctx, x, CENTRE_Y, (D / 2) * e.swellRingScale * bodyScale);
    }
    // Target ring: thick border (1.4, YellowDark @ 0.25) containing a thin white border (1), both additive.
    const tr = (D / 2) * targetScale * bodyScale;
    const k = targetScale * bodyScale;
    ctx.fillStyle = css(YELLOW_DARK, 0.25);
    fillPillBorder(ctx, x - tr, CENTRE_Y - tr, tr * 2, tr * 2, 1.4 * k);
    ctx.fillStyle = '#fff';
    fillPillBorder(ctx, x - tr, CENTRE_Y - tr, tr * 2, tr * 2, 1 * k);
    ctx.restore();

    // Centre circle (ArgonSwellCirclePiece: Asterisk icon, rotated by DefaultSwell.Update)
    const cd = D * bodyScale;
    const a = alpha * bodyAlpha * centreAlpha;
    if (a > 0.001)
      this.drawArgonCirclePiece(ctx, x - cd / 2, CENTRE_Y - cd / 2, cd, cd, ARGON_SWELL, FA_ASTERISK, a, e.judged ? 0 : beat.flash, e.swellRotation);
  }

  /** DrawableFlyingHit: a DrawableHit judged (and animated) when the drum roll tick was hit. */
  private drawFlyingHits(ctx: CanvasRenderingContext2D, now: number): void {
    for (const f of this.flyingHits) {
      const t = now - f.time;
      if (t < 0 || t > 800) continue;
      const D = (f.strong ? DEFAULT_STRONG_SIZE : DEFAULT_SIZE) * PF_H;
      const x = this.xAt(f.time, now);
      const g = this.hitGravity(t);
      const y = CENTRE_Y + g.y;
      const d = D * g.scale;
      if (this.legacy?.has.hitCircle) this.legacy.drawHit(ctx, x, y, d, f.rim, f.strong, g.alpha, this.ctx.combo, f.time, now);
      else
        this.drawArgonCirclePiece(
          ctx,
          x - d / 2,
          y - d / 2,
          d,
          d,
          f.rim ? ARGON_RIM : ARGON_CENTRE,
          FA_ANGLE_LEFT,
          g.alpha,
          0.9 * (1 - applyEasing(Easing.OutQuint, clamp01(t / 500))),
        );
    }
  }

  /** DrawableBarLine + ArgonBarLine */
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
    const prev = ctx.globalAlpha;
    for (let i = lo; i < bars.length; i++) {
      const b = bars[i];
      if (b.startTime > now + maxAhead) break;
      const x = this.xAt(b.startTime, now);
      if (x > W + 2) continue;
      // FadeOutFromOne(150) at StartTime
      let alpha = 1;
      if (now > b.startTime) alpha = 1 - clamp01((now - b.startTime) / 150);
      if (alpha <= 0) continue;
      if (this.legacy?.has.barLine) {
        this.legacy.drawBarLine(ctx, x, CENTRE_Y, PF_H, alpha);
        continue;
      }
      // Main line: alpha 1 (major) / 0.5 (minor), tracker_width 2.
      ctx.globalAlpha = prev * alpha * (b.major ? 1 : 0.5);
      ctx.fillStyle = '#fff';
      ctx.fillRect(x - BAR_LINE_WIDTH / 2, 0, BAR_LINE_WIDTH, PF_H);
      if (b.major) {
        // Top / bottom anchors: major_extension (10) tall additive gradients at mainLine.Alpha * 0.3.
        ctx.globalAlpha = prev * alpha * 0.3;
        ctx.globalCompositeOperation = 'lighter';
        const top = ctx.createLinearGradient(0, -BAR_LINE_MAJOR_EXTENSION, 0, 0);
        top.addColorStop(0, 'rgba(255,255,255,0)');
        top.addColorStop(1, '#fff');
        ctx.fillStyle = top;
        ctx.fillRect(x - BAR_LINE_WIDTH / 2, -BAR_LINE_MAJOR_EXTENSION, BAR_LINE_WIDTH, BAR_LINE_MAJOR_EXTENSION);
        const bottom = ctx.createLinearGradient(0, PF_H, 0, PF_H + BAR_LINE_MAJOR_EXTENSION);
        bottom.addColorStop(0, '#fff');
        bottom.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = bottom;
        ctx.fillRect(x - BAR_LINE_WIDTH / 2, PF_H, BAR_LINE_WIDTH, BAR_LINE_MAJOR_EXTENSION);
        ctx.globalCompositeOperation = 'source-over';
      }
    }
    ctx.globalAlpha = prev;
  }

  /** ArgonHitTarget (200x200, masked, centred on the hit position) */
  private drawHitTarget(ctx: CanvasRenderingContext2D): void {
    const t = 4; // border_thickness
    const barHeight = (1 - DEFAULT_STRONG_SIZE) * PF_H;
    const prev = ctx.globalAlpha;
    ctx.save();
    ctx.beginPath();
    ctx.rect(HIT_X - HIT_TARGET_WIDTH / 2, 0, HIT_TARGET_WIDTH, PF_H);
    ctx.clip();
    ctx.fillStyle = '#fff';
    // Bar upper (Y = -border_thickness) / bar lower (Y = +border_thickness): Circles (rounded ends)
    ctx.beginPath();
    roundRectPath(ctx, HIT_X - t / 2, -t, t, barHeight, t / 2);
    roundRectPath(ctx, HIT_X - t / 2, PF_H - barHeight + t, t, barHeight, t / 2);
    ctx.fill();
    // Outer / inner circles: white, additive, alpha 0.1
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = prev * 0.1;
    fillCircle(ctx, HIT_X, CENTRE_Y, (DEFAULT_SIZE * PF_H) / 2);
    fillCircle(ctx, HIT_X, CENTRE_Y, (DEFAULT_SIZE * 0.85 * PF_H) / 2);
    ctx.restore();
    ctx.globalAlpha = prev;
  }

  /** HitExplosion (DEFAULT_SIZE, centred on the hit target) + ArgonHitExplosion */
  private drawExplosions(ctx: CanvasRenderingContext2D, now: number): void {
    if (this.explosions.length === 0) return;
    const D = DEFAULT_SIZE * PF_H;
    const prev = ctx.globalAlpha;
    for (const ex of this.explosions) {
      const t = now - ex.time;
      if (t < 0) continue;
      let alpha: number;
      if (ex.result === HitResult.Great) {
        // FadeIn(30, In).Then().FadeOut(450, OutQuint)
        alpha = t < 30 ? applyEasing(Easing.In, t / 30) : 1 - applyEasing(Easing.OutQuint, clamp01((t - 30) / 450));
      } else if (ex.result === HitResult.Ok) {
        // FadeTo(0.2f, 30, In).Then().FadeOut(200, OutQuint)
        alpha = t < 30 ? 0.2 * applyEasing(Easing.In, t / 30) : 0.2 * (1 - applyEasing(Easing.OutQuint, clamp01((t - 30) / 200)));
      } else alpha = 0; // Miss: FadeOut()
      if (alpha <= 0.001) continue;

      // AnimateSecondHit: outer.ResizeTo(STRONG_SCALE, 500, OutQuint)
      let outerScale = 1;
      if (ex.secondHitTime !== null && now >= ex.secondHitTime)
        outerScale = 1 + (STRONG_SCALE - 1) * applyEasing(Easing.OutQuint, clamp01((now - ex.secondHitTime) / 500));

      const gradient = ex.rim ? RIM_HIT_GRADIENT : CENTRE_HIT_GRADIENT;
      const glow = ex.rim ? RIM_HIT_GLOW : CENTRE_HIT_GLOW;
      ctx.globalAlpha = prev * alpha;
      const ro = (D * outerScale) / 2;
      const g = ctx.createLinearGradient(HIT_X - ro, 0, HIT_X + ro, 0);
      g.addColorStop(0, css(gradient[0]));
      g.addColorStop(1, css(gradient[1]));
      ctx.fillStyle = g;
      fillCircle(ctx, HIT_X, CENTRE_Y, ro);
      const ri = (D * 0.85) / 2;
      drawCircleGlow(ctx, HIT_X, CENTRE_Y, ri, 45, glow, 0.5);
      ctx.fillStyle = '#fff';
      fillCircle(ctx, HIT_X, CENTRE_Y, ri);
    }
    ctx.globalAlpha = prev;
  }

  /** DrawableTaikoJudgement (200x200 centred on the hit target) + taiko ArgonJudgementPiece */
  private drawJudgements(ctx: CanvasRenderingContext2D, now: number): void {
    if (this.judgements.length === 0) return;
    const duration = 800;
    const prev = ctx.globalAlpha;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `400 20px ${FONT}`;
    for (const j of this.judgements) {
      const t = now - j.time;
      if (t < 0 || t > 1000) continue;
      const text = RESULT_TEXT[j.result];
      if (!text) continue;
      const colour = RESULT_COLOURS[j.result] ?? WHITE;
      // this.FadeOutFromOne(duration, OutQuint)
      const pieceAlpha = 1 - applyEasing(Easing.OutQuint, clamp01(t / duration));
      if (pieceAlpha <= 0.001) continue;
      ctx.save();
      ctx.translate(HIT_X, CENTRE_Y);
      let textY: number;
      let textScale = 1;
      if (j.result !== HitResult.Miss) {
        // JudgementText.MoveToY(-0.6f).MoveToY(-1.0f, duration, OutQuint) (relative to the 200 tall piece); ScaleTo(1.4f, duration, OutQuint)
        const e = applyEasing(Easing.OutQuint, clamp01(t / duration));
        textY = (-0.6 - 0.4 * e) * PF_H;
        textScale = 1 + 0.4 * e;
      } else {
        // this.ScaleTo(1.6f).ScaleTo(1, 100, In); JudgementText.MoveToOffset((0, 100), duration, InQuint) (relative); this.RotateTo(40, duration, InQuint)
        const s = 1.6 - 0.6 * applyEasing(Easing.In, clamp01(t / 100));
        const e = applyEasing(Easing.InQuint, clamp01(t / duration));
        ctx.rotate((40 * e * Math.PI) / 180);
        ctx.scale(s, s);
        textY = 100 * PF_H * e;
      }
      ctx.globalAlpha = prev * pieceAlpha;
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = css(colour);
      ctx.save();
      ctx.translate(0, textY);
      ctx.scale(textScale, textScale);
      drawSpacedText(ctx, text, 0, 0, 10);
      ctx.restore();

      // RingExplosion (hits only): rings moving out from 0.6 to 1 of a random distance (600, OutQuint), FadeOutFromOne(1000, OutQuint)
      if (j.result !== HitResult.Miss) {
        const ringAlpha = 1 - applyEasing(Easing.OutQuint, clamp01(t / 1000));
        if (ringAlpha > 0.001) {
          ctx.globalAlpha = prev * pieceAlpha * ringAlpha;
          ctx.fillStyle = css(colour);
          const travel = j.result === HitResult.Great ? 58 : 58 * 0.6;
          const countSmall = 4;
          const countLarge = j.result === HitResult.Great ? 4 : 0;
          const rnd = seededRandom(j.seed);
          const move = applyEasing(Easing.OutQuint, clamp01(t / 600));
          for (let i = 0; i < countSmall + countLarge; i++) {
            const size = i < countSmall ? 9 : 14;
            // RNG.NextSingle(0, 360) is passed straight to MathF.Cos / MathF.Sin.
            const direction = rnd() * 360;
            const distance = travel / 2 + rnd() * (travel / 2);
            const d = distance * (0.6 + 0.4 * move);
            const rx = Math.cos(direction) * d;
            const ry = Math.sin(direction) * d;
            fillPillBorder(ctx, rx - size / 2, ry - size / 2, size, size, 4);
          }
        }
      }
      ctx.restore();
    }
    ctx.restore();
    ctx.globalAlpha = prev;
  }

  /** InputDrum (180 x 200) + ArgonInputDrum (AspectContainer 180 x 180, centred; contents scaled 0.9) */
  private drawInputDrum(ctx: CanvasRenderingContext2D, now: number): void {
    const cx = INPUT_DRUM_WIDTH / 2;
    const cy = CENTRE_Y;
    const size = INPUT_DRUM_WIDTH * 0.9;
    const R = size / 2;
    const prev = ctx.globalAlpha;

    const half = (left: boolean, rimAction: TaikoAction, centreAction: TaikoAction): void => {
      ctx.save();
      // TaikoHalfDrum: Masking, width = drum size, height = 2 * drum size, anchored at the drum centre.
      ctx.beginPath();
      ctx.rect(left ? cx - size : cx, cy - size, size, size * 2);
      ctx.clip();
      ctx.fillStyle = css(GRAY_51);
      fillCircle(ctx, cx, cy, R);
      const rimAlpha = this.drumOverlayAlpha(rimAction, now);
      if (rimAlpha > 0.001) {
        ctx.globalAlpha = prev * rimAlpha;
        drawCircleGlow(ctx, cx, cy, R, 50, RIM_HIT_GLOW, 0.66);
        ctx.fillStyle = horizontalGradient(ctx, cx - R, cx + R, RIM_HIT_GRADIENT);
        fillCircle(ctx, cx, cy, R);
        ctx.globalAlpha = prev;
      }
      ctx.fillStyle = css(GRAY_64);
      fillCircle(ctx, cx, cy, R * (1 - RIM_SIZE));
      const centreAlpha = this.drumOverlayAlpha(centreAction, now);
      if (centreAlpha > 0.001) {
        ctx.globalAlpha = prev * centreAlpha;
        const rc = R * (1 - RIM_SIZE);
        drawCircleGlow(ctx, cx, cy, rc, 50, CENTRE_HIT_GLOW, 1);
        ctx.fillStyle = horizontalGradient(ctx, cx - rc, cx + rc, CENTRE_HIT_GRADIENT);
        fillCircle(ctx, cx, cy, rc);
        ctx.globalAlpha = prev;
      }
      ctx.restore();
    };
    half(true, 'LeftRim', 'LeftCentre');
    half(false, 'RightRim', 'RightCentre');

    // Middle split (masked by the drum circle)
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = css(GRAY_38);
    ctx.fillRect(cx - (MIDDLE_SPLIT * 0.9) / 2, cy - R, MIDDLE_SPLIT * 0.9, size);
    ctx.fillStyle = css(GRAY_48);
    ctx.fillRect(cx - (MIDDLE_SPLIT * 0.9) / 2, cy - R * (1 - RIM_SIZE), MIDDLE_SPLIT * 0.9, size * (1 - RIM_SIZE));
    ctx.restore();
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

  /**
   * BeatSyncedContainer (EarlyActivationMilliseconds = pre_beat_transition_time, MinimumBeatLength 50) driving
   * ArgonCirclePiece.OnNewBeat: in kiai, flash.FadeTo(kiai_flash_opacity).Then().FadeOut(beatLength * 0.75, OutSine).
   */
  private beatState(now: number): BeatState {
    const out: BeatState = { flash: 0 };
    if (!this.kiaiTimes) return out;
    const cp = this.playable.controlPoints;
    const t = now + PRE_BEAT_TRANSITION_TIME;
    const tp = cp.timingPointAt(t);
    let bl = tp.beatLength;
    if (!(bl > 0)) return out;
    while (bl < 50) bl *= 2;
    const beatIndex = Math.floor((t - tp.time) / bl);
    const beatStart = tp.time + beatIndex * bl;
    if (!cp.effectPointAt(beatStart).kiaiMode) return out;
    out.flash = KIAI_FLASH_OPACITY * (1 - applyEasing(Easing.OutSine, clamp01((t - beatStart) / (tp.beatLength * 0.75))));
    return out;
  }

  dispose(): void {}

  /** Exposed for tests: the judged result of every top-level object. */
  get resultsForTesting(): HitResult[] {
    return this.entries.map(e => e.result);
  }
}

interface BeatState {
  flash: number;
}

function pruneBefore<T extends { time: number }>(list: T[], time: number): void {
  let n = 0;
  while (n < list.length && list[n].time < time) n++;
  if (n > 0) list.splice(0, n);
}
