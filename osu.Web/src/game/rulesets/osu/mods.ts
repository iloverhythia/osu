// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Ports of osu.Game.Rulesets.Osu/Mods/OsuModRelax.cs and OsuModAutopilot.cs (their IUpdatableByPlayfield logic),
// OsuModHidden.cs (+ osu.Game/Rulesets/Mods/ModWithVisibilityAdjustment.cs), OsuModSpunOut.cs,
// and OsuModFlashlight.cs (+ osu.Game/Rulesets/Mods/ModFlashlight.cs, CircularFlashlight shader).

import type { BreakPeriod } from '../../beatmaps/Beatmap';
import type { Replay } from '../../replays/Replay';
import { HitCircle, OsuHitObject, Slider, SliderRepeat, SliderTailCircle, SliderTick, Spinner } from './objects';
import { Easing, Prop, valueAt } from './transforms';

/** What OsuModRelax needs from the playfield. */
export interface RelaxPlayfield {
  /** Alive top-level objects in start-time order (HitObjectContainer.AliveObjects). */
  readonly aliveObjects: readonly OsuHitObject[];
  /** DrawableHitObject.IsHit */
  isHit(h: OsuHitObject): boolean;
  /** circle.HitArea.IsHovered */
  isHovered(circle: HitCircle): boolean;
  /** SliderInputManager.IsMouseInFollowArea(slider.Tracking.Value) */
  isMouseInFollowArea(slider: Slider): boolean;
  press(action: 'LeftButton' | 'RightButton', time: number): void;
  release(action: 'LeftButton' | 'RightButton', time: number): void;
}

export class OsuModRelax {
  static readonly RELAX_LENIENCY = 12;
  private static readonly KEY_UP_DELAY = 50; // AutoGenerator.KEY_UP_DELAY

  private isDownState = false;
  private wasLeft = false;
  private lastStateChangeTime = 0;
  private held: 'LeftButton' | 'RightButton' | null = null;

  /** OsuModRelax.Update(Playfield) */
  update(playfield: RelaxPlayfield, time: number): void {
    let requiresHold = false;
    let requiresHit = false;

    const handleHitCircle = (circle: HitCircle) => {
      if (!playfield.isHovered(circle)) return;
      requiresHit ||= circle.hitWindows.canBeHit(time - circle.startTime);
    };

    for (const h of playfield.aliveObjects) {
      // we are not yet close enough to the object.
      if (time < h.startTime - OsuModRelax.RELAX_LENIENCY) break;
      // already hit or beyond the hittable end time.
      if (playfield.isHit(h) || ((h instanceof Slider || h instanceof Spinner) && time > h.endTime)) continue;
      if (h instanceof HitCircle) handleHitCircle(h);
      else if (h instanceof Slider) {
        // Handles cases like "2B" beatmaps, where sliders may be overlapping and simply holding is not enough.
        if (!playfield.isHit(h.headCircle)) handleHitCircle(h.headCircle);
        requiresHold ||= playfield.isMouseInFollowArea(h);
      } else if (h instanceof Spinner) requiresHold ||= h.spinsRequired > 0;
    }

    const changeState = (down: boolean) => {
      if (this.isDownState === down) return;
      this.isDownState = down;
      this.lastStateChangeTime = time;
      // PressHandler: a new ReplayState with no actions is applied, then the press adds exactly one action.
      if (this.held) {
        playfield.release(this.held, time);
        this.held = null;
      }
      if (down) {
        this.held = this.wasLeft ? 'LeftButton' : 'RightButton';
        playfield.press(this.held, time);
        this.wasLeft = !this.wasLeft;
      }
    };

    if (requiresHit) {
      changeState(false);
      changeState(true);
    }
    if (requiresHold) changeState(true);
    else if (this.isDownState && time - this.lastStateChangeTime > OsuModRelax.KEY_UP_DELAY) changeState(false);
  }
}

/** OsuModAutopilot: the cursor follows the autoplay replay's frames (snapping to the nearest frame); the player clicks. */
export class OsuModAutopilot {
  private readonly frames: { t: number; x: number; y: number }[];
  private currentFrame = -1;

  constructor(autoplay: Replay) {
    this.frames = [];
    for (const e of autoplay.events) if (e.k === 'm') this.frames.push({ t: e.t, x: e.x, y: e.y });
  }

  /** OsuModAutopilot.Update — returns the new cursor position (gamefield coordinates) when it changes. */
  update(time: number): { x: number; y: number } | null {
    const frames = this.frames;
    if (this.currentFrame === frames.length - 1) return null;
    if (this.currentFrame < 0 || Math.abs(frames[this.currentFrame + 1].t - time) <= Math.abs(frames[this.currentFrame].t - time)) {
      this.currentFrame++;
      return { x: frames[this.currentFrame].x, y: frames[this.currentFrame].y };
    }
    return null;
  }
}

// ------------------------------------------------------------------------------------------------ Hidden

/** OsuModHidden */
export const OsuModHidden = {
  FADE_IN_DURATION_MULTIPLIER: 0.4,
  FADE_OUT_DURATION_MULTIPLIER: 0.3,

  /** OsuModHidden.ApplyToBeatmap: sliders retain their default TimeFadeIn to match stable; everything else (incl. nested) fades in faster. */
  applyToBeatmap(objects: readonly OsuHitObject[]): void {
    const apply = (h: OsuHitObject) => {
      if (!(h instanceof Slider)) h.timeFadeIn = h.timePreempt * OsuModHidden.FADE_IN_DURATION_MULTIPLIER;
      for (const n of h.nested) apply(n);
    };
    for (const h of objects) apply(h);
  },

  /** ModWithVisibilityAdjustment.ApplyToBeatmap with OsuModHidden.IsFirstAdjustableObject (spinners and their ticks are skipped). */
  firstAdjustableObject(objects: readonly OsuHitObject[]): OsuHitObject | null {
    const find = (list: readonly OsuHitObject[]): OsuHitObject | null => {
      for (const h of list) {
        if (!(h instanceof Spinner || h.kind === 'spinnerTick' || h.kind === 'spinnerBonusTick')) return h;
        const nested = find(h.nested);
        if (nested) return nested;
      }
      return null;
    };
    return find(objects);
  },

  /** OsuModHidden.getFadeOutParameters → (fadeStartTime, fadeDuration). */
  fadeOutParameters(h: OsuHitObject): { start: number; duration: number } {
    // Slider tails and repeats use the same fade sequence as the slider head.
    if (h instanceof SliderTailCircle || h instanceof SliderRepeat) return OsuModHidden.parameters(h.slider.headCircle);
    return OsuModHidden.parameters(h);
  },

  parameters(h: OsuHitObject): { start: number; duration: number } {
    const fadeOutStartTime = h.startTime - h.timePreempt + h.timeFadeIn;
    const fadeOutDuration = h.timePreempt * OsuModHidden.FADE_OUT_DURATION_MULTIPLIER;
    // new duration from completed fade in to end (before fading out)
    const longFadeDuration = h.endTime - fadeOutStartTime;
    if (h instanceof Slider) return { start: fadeOutStartTime, duration: longFadeDuration };
    if (h instanceof SliderTick) {
      const tickFadeOutDuration = Math.min(h.timePreempt - 150 /* DrawableSliderTick.ANIM_DURATION */, 1000);
      return { start: h.startTime - tickFadeOutDuration, duration: tickFadeOutDuration };
    }
    if (h instanceof Spinner) return { start: fadeOutStartTime + longFadeDuration, duration: fadeOutDuration };
    return { start: fadeOutStartTime, duration: fadeOutDuration };
  },
};

// ------------------------------------------------------------------------------------------------ Spun Out

/**
 * OsuModSpunOut.onSpinnerUpdate: the rotation (degrees, before SpinnerRotationTracker.AddRotation applies the rate) to add
 * this frame. The 1.01 factor ensures the spinner is completed despite minor decimal loss.
 */
export function spunOutRotation(spinner: Spinner, elapsedFrameTime: number, rate: number): number {
  // early-return if we were paused to avoid division-by-zero in the subsequent calculations.
  if (Math.abs(rate) < 1e-6) return 0;
  // for spinners we want the real (wall clock) elapsed time; to achieve that, unapply the clock rate locally here.
  const rateIndependentElapsedTime = elapsedFrameTime / rate;
  const rotationSpeed = Math.fround((1.01 * spinner.spinsRequired) / spinner.duration);
  return Math.fround(((Math.fround(rateIndependentElapsedTime) * rotationSpeed * Math.PI * 2) * 180) / Math.PI);
}

// ------------------------------------------------------------------------------------------------ Flashlight

/** BreakOverlay.BREAK_FADE_DURATION (BreakPeriod.MIN_BREAK_DURATION / 2) */
export const BREAK_FADE_DURATION = 325;

/**
 * BreakTracker.IsBreakTime: inside a break with an effect (shortened by the break fade), before the gameplay start time,
 * or once every judgement has been made.
 */
export function isBreakTime(breaks: readonly BreakPeriod[], time: number, gameplayStartTime: number, hasCompleted: boolean): boolean {
  for (const b of breaks) {
    // BreakPeriod.HasEffect
    if (b.endTime - b.startTime < 650) continue;
    if (time >= b.startTime && time <= b.endTime - BREAK_FADE_DURATION) return true;
  }
  return time < gameplayStartTime || hasCompleted;
}

/** OsuModFlashlight.OsuFlashlight (with ModFlashlight.Flashlight). Sizes are in osu! playfield units. */
export class OsuFlashlight {
  static readonly DEFAULT_FLASHLIGHT_SIZE = 125;
  static readonly DEFAULT_FOLLOW_DELAY = 120;
  // stable's animation speed is 0.1 "units" per 1 frame at 60 fps: (0.1 / 3.2) * (1 / 60 [s]) = 1.875 [1 / s]
  private static readonly SCALE_ANIMATION_SPEED = 1.875 / 1000;

  readonly smoothness = 1.4;
  /** FlashlightSize.Y */
  private readonly size: Prop;
  /** FlashlightPosition, in screen (CSS pixel) space; (0, 0) until the mouse first moves. */
  position: { x: number; y: number } = { x: 0, y: 0 };
  /** FlashlightDim */
  dim = 0;
  private activeSlider: Slider | null = null;

  private combo = 0;
  private breakTime = false;
  private readonly pending: number[] = [];

  constructor(
    readonly sizeMultiplier = 1,
    readonly comboBasedSize = true,
    readonly followDelay = OsuFlashlight.DEFAULT_FOLLOW_DELAY,
  ) {
    this.size = new Prop(this.getSize());
  }

  /** ModFlashlight.Flashlight.GetSize */
  getSize(): number {
    let size = OsuFlashlight.DEFAULT_FLASHLIGHT_SIZE * this.sizeMultiplier;
    if (this.breakTime) size *= 2.5; // BreakTimeScale = 8.0 / 3.2
    else if (this.comboBasedSize) size *= OsuFlashlight.comboScaleFor(this.combo);
    return size;
  }

  /** ModFlashlight.Flashlight.GetComboScaleFor (all sizings match stable) */
  static comboScaleFor(combo: number): number {
    if (combo >= 200) return 0.625; // = 2.0 / 3.2
    if (combo >= 100) return 0.8125; // = 2.6 / 3.2
    return 1;
  }

  /** OsuFlashlight.UpdateFlashlightSize */
  private updateFlashlightSize(time: number): void {
    const target = this.getSize();
    const relativeDelta = Math.abs(this.size.at(time) - target) / OsuFlashlight.DEFAULT_FLASHLIGHT_SIZE;
    this.size.to(time, target, relativeDelta / OsuFlashlight.SCALE_ANIMATION_SPEED);
  }

  /** Per-frame update: combo / break bindings and scheduled size updates. */
  update(time: number, combo: number, breakTime: boolean): void {
    if (combo !== this.combo) {
      this.combo = combo;
      this.updateFlashlightSize(time);
    }
    if (breakTime !== this.breakTime) {
      this.breakTime = breakTime;
      // `player.IsBreakTime` will exit out of break *before* the actual specified time instant in the .osu;
      // to match stable, delay the animation in case of exiting break to the exact time specified in the .osu
      this.pending.push(time + (breakTime ? 0 : BREAK_FADE_DURATION));
    }
    for (let i = 0; i < this.pending.length; i++) {
      if (this.pending[i] <= time) {
        this.pending.splice(i--, 1);
        this.updateFlashlightSize(time);
      }
    }
  }

  /** OsuFlashlight.OnMouseMove (position follows the cursor with a delay). */
  onMouseMove(x: number, y: number, elapsedFrameTime: number): void {
    const t = Math.min(Math.abs(elapsedFrameTime), this.followDelay);
    this.position = {
      x: valueAt(t, this.position.x, x, 0, this.followDelay, Easing.Out),
      y: valueAt(t, this.position.y, y, 0, this.followDelay, Easing.Out),
    };
  }

  /**
   * OsuFlashlight.OnSliderUpdate, called for every alive slider each frame.
   * Only one slider is considered "active"; it stops dimming as soon as it is no longer tracking.
   */
  onSliderUpdate(slider: Slider, tracking: boolean, inUse: (s: Slider) => boolean, trackingOf: (s: Slider) => boolean, time: number): void {
    if (tracking) this.activeSlider = slider;
    const a = this.activeSlider;
    this.dim = a != null && inUse(a) && time >= a.startTime && trackingOf(a) ? 0.8 : 0;
  }

  /** Flashlight radius in playfield units at `time`. */
  sizeAt(time: number): number {
    return this.size.at(time);
  }

  /**
   * Draws the flashlight over the whole screen (FlashlightDrawNode + CircularFlashlight shader):
   * alpha = smoothstep(radius, radius * smoothness, distance), then mixed towards opaque black by `dim`.
   * The smoothstep is approximated with gradient stops.
   */
  draw(g: CanvasRenderingContext2D, width: number, height: number, time: number, playfieldScale: number): void {
    const p = this.position;
    // scale the flashlight based on the playfield to match gameplay components scale.
    const r = Math.max(0.01, this.sizeAt(time) * playfieldScale);
    const outer = r * this.smoothness;
    const dim = this.dim;
    const grad = g.createRadialGradient(p.x, p.y, r, p.x, p.y, outer);
    const STOPS = 12;
    for (let i = 0; i <= STOPS; i++) {
      const t = i / STOPS;
      const s = t * t * (3 - 2 * t);
      const a = s * (1 - dim) + dim;
      grad.addColorStop(t, `rgba(0,0,0,${a})`);
    }
    g.save();
    // inside the radius the gradient's first stop applies (alpha = dim).
    // workaround for 1px gaps on the edges of the playfield (Padding = -1)
    g.fillStyle = grad;
    g.fillRect(-1, -1, width + 2, height + 2);
    g.restore();
  }
}
