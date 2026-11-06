// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Ports of osu.Game.Rulesets.Osu/Mods/OsuModRelax.cs and OsuModAutopilot.cs (their IUpdatableByPlayfield logic).

import type { Replay } from '../../replays/Replay';
import { HitCircle, OsuHitObject, Slider, Spinner } from './objects';

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
