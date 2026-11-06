// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game/Screens/Menu/IntroTriangles.cs (TrianglesIntroSequence) — lazer's default intro
// (OsuConfigManager: IntroSequence.Triangles) — with the parts of IntroScreen.cs it relies on.
//
// osu!'s intro theme, "welcome" voice, ruleset icon glyphs and the "lazer" logo textures aren't available, so:
//  - the timeline runs as for a non-themed intro (a user beatmap's track starts TRACK_START_DELAY after the intro,
//    from 2600ms before its preview point, fading in over 2600ms with InCubic), with a synthesised UI sound for the voice;
//  - the ruleset icons are simple procedural glyphs; the LogoAnimation reveal of the lazer logo is reproduced by
//    stroking the JarvSU logo's ring and wiping its wordmark in with the same Progress transform;
//  - the text reads "welcome to <app name>".

import { APP_NAME } from '../../brand';
import { Anim, Easing } from './Transforms';

export const TRACK_START_DELAY = 600; // IntroCircles.TRACK_START_DELAY

const TEXT_1 = 200;
const TEXT_2 = 400;
const TEXT_3 = 700;
const TEXT_4 = 900;
const TEXT_GLITCH = 1060;
const RULESETS_1 = 1450;
const RULESETS_2 = 1650;
const RULESETS_3 = 1850;
const LOGO_SCALE_DURATION = 920;
const LOGO_1 = 2080;
export const LOGO_2 = LOGO_1 + LOGO_SCALE_DURATION;
const TIME_BETWEEN_TRIANGLES = 22;

interface GlitchTriangle {
  x: number;
  y: number;
  size: number;
  outlineOnly: boolean;
  created: number;
}

export class TrianglesIntroSequence {
  private readonly start: number;
  private readonly welcomeSpacing = new Anim(5);
  private readonly rulesetsScaleContainer = new Anim(1);
  private readonly rulesetsScale = new Anim(1);
  private readonly rulesetsSpacing = new Anim(0);
  private readonly lazerLogoScale = new Anim(1);
  private readonly lazerLogoProgress = new Anim(0);
  private readonly logoContainerScale = new Anim(1);
  private glitch: GlitchTriangle[] = [];
  private lastGenTime: number | null = null;
  private finished = false;

  constructor(
    now: number,
    /** Invoked at LOGO_2 (the lazer logo's fade-out completing): show the logo, the background, the flash and load the menu. */
    private readonly onComplete: () => void,
  ) {
    this.start = now;
    const s = now;
    this.welcomeSpacing.to(50, s + TEXT_4, 5000);
    this.rulesetsScaleContainer.to(0.8, s + RULESETS_1, 1000);
    this.rulesetsScale.to(1, s + RULESETS_1).to(2, s + RULESETS_2).to(4, s + RULESETS_3);
    this.rulesetsSpacing.to(200, s + RULESETS_1).to(30, s + RULESETS_2).to(10, s + RULESETS_3);
    this.rulesetsScaleContainer.to(1.3, s + RULESETS_3, 1000);
    const scaleStart = 1.2;
    const scaleAdjust = 0.8;
    this.lazerLogoScale.to(scaleStart, s + LOGO_1).to(scaleStart - scaleAdjust, s + LOGO_1 + LOGO_SCALE_DURATION * 0.7, LOGO_SCALE_DURATION * 0.3, Easing.InQuint);
    this.lazerLogoProgress.to(1, s + LOGO_1, LOGO_SCALE_DURATION);
    this.logoContainerScale.to(scaleStart, s + LOGO_1).to(scaleStart - scaleAdjust * 0.25, s + LOGO_1, LOGO_SCALE_DURATION, Easing.InQuad);
  }

  get done(): boolean {
    return this.finished;
  }

  update(now: number): void {
    for (const a of [this.welcomeSpacing, this.rulesetsScaleContainer, this.rulesetsScale, this.rulesetsSpacing, this.lazerLogoScale, this.lazerLogoProgress, this.logoContainerScale]) a.update(now);
    const t = now - this.start;

    // GlitchingTriangles.Update
    if (t >= TEXT_GLITCH && t < RULESETS_1) {
      if (this.lastGenTime == null || now - this.lastGenTime > TIME_BETWEEN_TRIANGLES) {
        this.lastGenTime = (this.lastGenTime ?? now) + TIME_BETWEEN_TRIANGLES;
        this.glitch.push({ x: Math.random(), y: Math.random(), size: (Math.random() + 0.2) * 80, outlineOnly: Math.random() < 0.5, created: now });
      }
    }
    this.glitch = this.glitch.filter(g => now - g.created < 120);

    if (!this.finished && t >= LOGO_2) {
      this.finished = true;
      this.onComplete();
    }
  }

  /** Normal-blended parts (text, ruleset icons, the logo reveal). */
  draw(g: CanvasRenderingContext2D, w: number, h: number, now: number): void {
    if (this.finished) return;
    const t = now - this.start;
    const cx = w / 2;
    const cy = h / 2;

    // welcomeText (Light 42, spacing animated; padding bottom 10).
    if (t >= TEXT_1 && t < RULESETS_1) {
      const text = t < TEXT_2 ? 'wel' : t < TEXT_3 ? 'welcome' : t < TEXT_4 ? 'welcome to' : `welcome to ${APP_NAME}`;
      g.fillStyle = '#fff';
      g.font = '300 42px "Exo 2", sans-serif';
      g.textBaseline = 'middle';
      drawSpacedText(g, text, cx, cy - 5, this.welcomeSpacing.value);
    }

    // RulesetFlow
    if (t >= RULESETS_1 && t < LOGO_1) {
      const outer = this.rulesetsScaleContainer.value;
      const inner = this.rulesetsScale.value;
      const spacing = this.rulesetsSpacing.value;
      const n = 4;
      const size = 30;
      const total = n * size + (n - 1) * spacing;
      g.save();
      g.translate(cx, cy);
      g.scale(outer * inner, outer * inner);
      g.strokeStyle = g.fillStyle = '#fff';
      for (let i = 0; i < n; i++) drawRulesetIcon(g, i, -total / 2 + i * (size + spacing) + size / 2, 0, size);
      g.restore();
    }

    // LazerLogo (960x960) inside logoContainerSecondary.
    if (t >= LOGO_1 && t < LOGO_2) {
      const scale = this.logoContainerScale.value * this.lazerLogoScale.value;
      const progress = this.lazerLogoProgress.value;
      const r = 960 * 0.3 * scale;
      g.save();
      // background layer (Gray 0.6) then highlight (white) — both revealed by progress.
      for (const [colour, width] of [
        ['rgb(153,153,153)', 0.075],
        ['#fff', 0.035],
      ] as const) {
        g.strokeStyle = colour;
        g.lineWidth = r * width;
        g.lineCap = 'round';
        g.beginPath();
        g.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * progress);
        g.stroke();
      }
      g.beginPath();
      g.rect(cx - r, cy - r, 2 * r * Math.min(1, progress * 1.25), 2 * r);
      g.clip();
      g.fillStyle = '#fff';
      g.font = `italic 800 ${Math.round(r * 0.4)}px "Exo 2", sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(APP_NAME, cx, cy);
      g.restore();
    }
  }

  /** Additive parts (the glitching triangles, white on black punch-outs). */
  drawAdditive(g: CanvasRenderingContext2D, w: number, h: number, now: number): void {
    if (this.finished || this.glitch.length === 0) return;
    const aw = w * 0.4;
    const ah = h * 0.16;
    const ax = (w - aw) / 2;
    const ay = (h - ah) / 2;
    for (const tri of this.glitch) {
      const alpha = 1 - (now - tri.created) / 120;
      if (alpha <= 0) continue;
      const x = ax + tri.x * aw;
      const y = ay + tri.y * ah;
      g.fillStyle = `rgba(255,255,255,${alpha})`;
      g.beginPath();
      trianglePath(g, x, y, tri.size);
      if (tri.outlineOnly) trianglePath(g, x + 2.5, y + 2.5, tri.size - 5, true);
      g.fill();
    }
  }
}

/** osu-framework Triangle: apex at the top centre of its (size × size) box. */
function trianglePath(g: CanvasRenderingContext2D, x: number, y: number, s: number, reverse = false): void {
  if (!reverse) {
    g.moveTo(x + s / 2, y);
    g.lineTo(x + s, y + s);
    g.lineTo(x, y + s);
  } else {
    g.moveTo(x + s / 2, y);
    g.lineTo(x, y + s);
    g.lineTo(x + s, y + s);
  }
  g.closePath();
}

/** Draws centred text with SpriteText-style spacing (extra px after each glyph). */
export function drawSpacedText(g: CanvasRenderingContext2D, text: string, cx: number, cy: number, spacing: number): void {
  g.textAlign = 'left';
  const widths = [...text].map(c => g.measureText(c).width);
  const total = widths.reduce((a, b) => a + b, 0) + spacing * Math.max(0, text.length - 1);
  let x = cx - total / 2;
  [...text].forEach((c, i) => {
    g.fillText(c, x, cy);
    x += widths[i] + spacing;
  });
}

/** Simple stand-ins for the four ruleset icons (osu!, taiko, catch, mania). */
function drawRulesetIcon(g: CanvasRenderingContext2D, id: number, x: number, y: number, size: number): void {
  const r = size / 2;
  g.lineWidth = size * 0.09;
  g.beginPath();
  g.arc(x, y, r - g.lineWidth / 2, 0, Math.PI * 2);
  g.stroke();
  g.beginPath();
  switch (id) {
    case 0:
      g.arc(x, y, r * 0.38, 0, Math.PI * 2);
      g.fill();
      break;
    case 1:
      g.arc(x, y, r * 0.5, 0, Math.PI * 2);
      g.stroke();
      g.beginPath();
      g.moveTo(x, y - r * 0.5);
      g.lineTo(x, y + r * 0.5);
      g.stroke();
      break;
    case 2:
      g.arc(x, y + r * 0.1, r * 0.32, 0, Math.PI * 2);
      g.fill();
      g.beginPath();
      g.moveTo(x, y - r * 0.2);
      g.quadraticCurveTo(x + r * 0.15, y - r * 0.55, x + r * 0.35, y - r * 0.5);
      g.stroke();
      break;
    default:
      for (const dx of [-0.36, -0.12, 0.12, 0.36]) g.fillRect(x + dx * r - r * 0.07, y - r * 0.45, r * 0.14, r * 0.9);
      break;
  }
}
