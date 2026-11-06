// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game/Screens/Menu/MenuSideFlashes.cs (additive blue gradients flashing on beats from both screen edges).

import { BeatSync, type ChannelAmplitudes, type MenuBeatSource } from './BeatSync';
import { Anim, Easing } from './Transforms';

const AMPLITUDE_DEAD_ZONE = 0.25;
const ALPHA_MULTIPLIER = (1 - AMPLITUDE_DEAD_ZONE) / 0.55;
const KIAI_MULTIPLIER = (1 - AMPLITUDE_DEAD_ZONE * 0.95) / 0.8;
const BOX_FADE_IN_TIME = 65;
const BOX_WIDTH = 200;
const INTENSITY = 2;

// OsuColour.Blue (#66ccff).ToLinear(), at 0.6 alpha for the light end of the gradient.
const srgbToLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const BASE = [0x66, 0xcc, 0xff].map(v => Math.round(srgbToLinear(v / 255) * 255));
const LIGHT = `rgba(${BASE[0]},${BASE[1]},${BASE[2]},0.6)`;
const DARK = `rgba(${BASE[0]},${BASE[1]},${BASE[2]},0)`;

export class MenuSideFlashes {
  private readonly leftAlpha = new Anim(0);
  private readonly rightAlpha = new Anim(0);
  /** Whole-container alpha (MainMenu fades the flashes on suspend/resume). */
  readonly alpha = new Anim(1);
  private readonly beat: BeatSync;

  constructor(private readonly source: MenuBeatSource) {
    this.beat = new BeatSync((i, tp, ep, amps, t) => {
      if (i < 0) return;
      const kiai = ep.kiaiMode;
      if (kiai ? i % 2 === 0 : i % tp.timeSignature === 0) this.flash(this.leftAlpha, true, tp.beatLength, kiai, amps, t);
      if (kiai ? i % 2 === 1 : i % tp.timeSignature === 0) this.flash(this.rightAlpha, false, tp.beatLength, kiai, amps, t);
    });
    this.beat.earlyActivationMilliseconds = BOX_FADE_IN_TIME;
  }

  private flash(a: Anim, left: boolean, beatLength: number, kiai: boolean, amps: ChannelAmplitudes, t: number): void {
    const level = left ? amps.left : amps.right;
    const target = Math.min(1, Math.max(0.1, 0.1 + (level - AMPLITUDE_DEAD_ZONE) / (kiai ? KIAI_MULTIPLIER : ALPHA_MULTIPLIER)));
    a.to(target, t, BOX_FADE_IN_TIME).to(0, t + BOX_FADE_IN_TIME, beatLength, Easing.In);
  }

  update(now: number, frame: number): void {
    this.beat.update(now, this.source, frame);
    this.leftAlpha.update(now);
    this.rightAlpha.update(now);
    this.alpha.update(now);
  }

  /** Draws on an additive canvas. */
  draw(g: CanvasRenderingContext2D, w: number, h: number): void {
    const width = BOX_WIDTH * INTENSITY;
    const height = h * 1.5;
    const top = (h - height) / 2;
    const la = this.leftAlpha.value * this.alpha.value;
    const ra = this.rightAlpha.value * this.alpha.value;
    if (la > 0) {
      const x = -BOX_WIDTH;
      const grad = g.createLinearGradient(x, 0, x + width, 0);
      grad.addColorStop(0, LIGHT);
      grad.addColorStop(1, DARK);
      g.globalAlpha = la;
      g.fillStyle = grad;
      g.fillRect(x, top, width, height);
    }
    if (ra > 0) {
      const x = w + BOX_WIDTH - width;
      const grad = g.createLinearGradient(x, 0, x + width, 0);
      grad.addColorStop(0, DARK);
      grad.addColorStop(1, LIGHT);
      g.globalAlpha = ra;
      g.fillStyle = grad;
      g.fillRect(x, top, width, height);
    }
    g.globalAlpha = 1;
  }
}
