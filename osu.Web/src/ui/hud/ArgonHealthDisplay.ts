// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game/Screens/Play/HUD/HealthDisplay.cs + ArgonHealthDisplay.cs + ArgonHealthDisplayParts/*.
//
// The ArgonBarPath / ArgonBarPathBackground shaders live in osu-resources; they are reproduced here from the path the component
// used before the shaders existed (a straight bar dipping down by BarHeight near its end, rendered with SmoothPath colour
// profiles): the background is rasterised once from a distance field, the bars are drawn as additive concentric strokes that sum
// to the same radial profile.

import { applyEasing } from '../../game/storyboard/Easing';
import { Anim, ColourAnim, Easing, dampContinuously, hex, lerp, lighten, opacity, type RGBA } from './anim';

export const MAIN_PATH_RADIUS = 10;
const PADDING = MAIN_PATH_RADIUS * 2;
const GLOW_PATH_RADIUS = 40;
const MAIN_PATH_GLOW_PORTION = 0.6;
const GLOW_BAR_GLOW_PORTION = (GLOW_PATH_RADIUS - MAIN_PATH_RADIUS * (1 - MAIN_PATH_GLOW_PORTION)) / GLOW_PATH_RADIUS;

const MAIN_BAR_COLOUR: RGBA = [1, 1, 1, 1];
const MAIN_BAR_GLOW_COLOUR: RGBA = opacity(hex('7ED7FD'), 0.5);

type Pt = [number, number];

function quad(out: Pt[], a: Pt, b: Pt, c: Pt, steps = 8): void {
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    out.push([u * u * a[0] + 2 * u * t * b[0] + t * t * c[0], u * u * a[1] + 2 * u * t * b[1] + t * t * c[1]]);
  }
}

/** The bar's centre line in content space (content is DrawWidth x (BarHeight + PADDING)). */
export function healthBarPath(drawWidth: number, barHeight: number): Pt[] {
  const barLength = drawWidth - MAIN_PATH_RADIUS * 2;
  const curveStart = barLength - 70;
  const curveEnd = barLength - 40;
  const smooth = 10;
  const dx = curveEnd - curveStart;
  const len = Math.hypot(dx, barHeight) || 1;
  const d: Pt = [dx / len, barHeight / len];
  const pts: Pt[] = [[0, 0], [curveStart - smooth, 0]];
  quad(pts, [curveStart - smooth, 0], [curveStart, 0], [curveStart + d[0] * smooth, d[1] * smooth]);
  pts.push([curveEnd - d[0] * smooth, barHeight - d[1] * smooth]);
  quad(pts, [curveEnd - d[0] * smooth, barHeight - d[1] * smooth], [curveEnd, barHeight], [curveEnd + smooth, barHeight]);
  pts.push([barLength, barHeight]);
  return pts.map(p => [p[0] + MAIN_PATH_RADIUS, p[1] + MAIN_PATH_RADIUS] as Pt);
}

function cumulative(pts: Pt[]): number[] {
  const out = [0];
  for (let i = 1; i < pts.length; i++) out.push(out[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return out;
}

/** Path.GetPathToProgress-like sub path between two progress values. */
function subPath(pts: Pt[], lengths: number[], from: number, to: number): Pt[] {
  const total = lengths[lengths.length - 1];
  const a = Math.max(0, Math.min(1, from)) * total;
  const b = Math.max(0, Math.min(1, to)) * total;
  const at = (l: number): Pt => {
    for (let i = 1; i < pts.length; i++) {
      if (lengths[i] >= l) {
        const seg = lengths[i] - lengths[i - 1] || 1;
        const t = (l - lengths[i - 1]) / seg;
        return [lerp(pts[i - 1][0], pts[i][0], t), lerp(pts[i - 1][1], pts[i][1], t)];
      }
    }
    return pts[pts.length - 1];
  };
  const out: Pt[] = [at(a)];
  for (let i = 1; i < pts.length - 1; i++) if (lengths[i] > a && lengths[i] < b) out.push(pts[i]);
  out.push(at(b));
  return out;
}

function strokePath(g: CanvasRenderingContext2D, pts: Pt[]): void {
  g.beginPath();
  g.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
  g.stroke();
}

const rgbaCss = (c: RGBA, a: number) => `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${Math.max(0, Math.min(1, a))})`;

/**
 * ArgonHealthDisplayBar: a round-capped path whose colour at radial position p (0 = edge, 1 = centre) is the bar colour for
 * p >= glowPortion and InQuint(transparent → glow colour) outside it. Drawn additively.
 */
function drawBar(g: CanvasRenderingContext2D, pts: Pt[], radius: number, glowPortion: number, bar: RGBA, glow: RGBA, alpha: number): void {
  if (pts.length < 2 || alpha <= 0) return;
  g.save();
  g.globalCompositeOperation = 'lighter';
  g.lineCap = 'round';
  g.lineJoin = 'round';
  const steps = Math.max(4, Math.round(radius * glowPortion / 2));
  let prev = 0;
  for (let k = 0; k < steps; k++) {
    const p = (k / steps) * glowPortion;
    const pm = ((k + 0.5) / steps) * glowPortion;
    const target = glow[3] * applyEasing(Easing.InQuint, pm / glowPortion);
    const da = target - prev;
    prev = target;
    if (da <= 0.001) continue;
    g.lineWidth = 2 * radius * (1 - p);
    g.strokeStyle = rgbaCss(glow, da * alpha);
    strokePath(g, pts);
  }
  g.lineWidth = 2 * radius * (1 - glowPortion);
  g.strokeStyle = rgbaCss(bar, bar[3] * alpha);
  strokePath(g, pts);
  g.restore();
}

/** ArgonHealthDisplayBackground: SmoothPath colouring — white 0.8 at the rim, OutQuint towards black 0.2 inside. */
function backgroundColourAt(p: number): RGBA {
  const a: RGBA = [1, 1, 1, 0.8];
  const b: RGBA = [0, 0, 0, 0.2];
  if (p <= 0.16) return a;
  const t = applyEasing(Easing.OutQuint, (p + 0.5) / 1.5);
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t), lerp(a[3], b[3], t)];
}

function rasteriseBackground(pts: Pt[], width: number, height: number, scale: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(width * scale));
  c.height = Math.max(1, Math.ceil(height * scale));
  const g = c.getContext('2d')!;
  const img = g.createImageData(c.width, c.height);
  for (let py = 0; py < c.height; py++) {
    for (let px = 0; px < c.width; px++) {
      const x = (px + 0.5) / scale;
      const y = (py + 0.5) / scale;
      let best = Infinity;
      for (let i = 1; i < pts.length; i++) {
        const [ax, ay] = pts[i - 1];
        const [bx, by] = pts[i];
        const vx = bx - ax;
        const vy = by - ay;
        const l2 = vx * vx + vy * vy || 1;
        const t = Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / l2));
        const dx = x - (ax + vx * t);
        const dy = y - (ay + vy * t);
        best = Math.min(best, dx * dx + dy * dy);
      }
      const dist = Math.sqrt(best);
      // 1px anti-aliased edge.
      const edge = Math.max(0, Math.min(1, MAIN_PATH_RADIUS - dist + 0.5));
      if (edge <= 0) continue;
      const col = backgroundColourAt(1 - Math.min(1, dist / MAIN_PATH_RADIUS));
      const o = (py * c.width + px) * 4;
      img.data[o] = col[0] * 255;
      img.data[o + 1] = col[1] * 255;
      img.data[o + 2] = col[2] * 255;
      img.data[o + 3] = col[3] * edge * 255;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

export class ArgonHealthDisplay {
  width = 300;
  barHeight = 20;

  /** HealthDisplay.Current (the displayed health, animated at the start). */
  private current = 0;
  private readonly currentAnim = new Anim(0);
  private initialPlaying = false;
  private initialHealthValue = 0;
  private nextIncreaseAt = 0;
  private increaseTarget = 0;
  private lastValue = 0;

  private healthBarValue = 0;
  private glowBarValue = 0;
  private mainAlpha = 0;
  private glowAlpha = 0;
  private resetMissAt: number | null = null;
  private pendingMissAnimation = false;
  private flashPending = false;

  private readonly glowBarColour = new ColourAnim([1, 1, 1, 1]);
  private readonly glowGlowColour = new ColourAnim(MAIN_BAR_GLOW_COLOUR);

  private path: Pt[] = [];
  private lengths: number[] = [];
  private background: HTMLCanvasElement | null = null;
  private layoutKey = '';

  /** HealthDisplay.LoadComplete. */
  start(health: number, now: number, playInitialIncreaseAnimation = true): void {
    this.initialHealthValue = health;
    if (playInitialIncreaseAnimation && this.current < health) {
      this.initialPlaying = true;
      this.increaseTarget = this.current;
      this.nextIncreaseAt = now + 150;
    } else this.current = health;
  }

  /** HealthDisplay.onNewJudgement + ArgonHealthDisplay.onNewJudgement. */
  onNewJudgement(isHitResult: boolean, isIgnoreHit: boolean, healthIncrease: number): void {
    if (isHitResult && !isIgnoreHit) this.flashPending = true;
    this.pendingMissAnimation ||= !isHitResult && healthIncrease < 0;
  }

  get displayingMiss(): boolean {
    return this.resetMissAt != null;
  }

  update(now: number, elapsed: number, health: number): void {
    // initialIncrease scheduled delegate (every 150ms).
    while (this.initialPlaying && now >= this.nextIncreaseAt) {
      const newValue = Math.min(this.increaseTarget + 0.05, health);
      this.currentAnim.to(newValue, 150, Easing.None, this.nextIncreaseAt);
      this.increaseTarget = newValue;
      this.flashPending = true;
      this.nextIncreaseAt += 150;
      if (newValue >= health) this.finishInitialAnimation(health);
    }
    if (this.initialPlaying) this.current = this.currentAnimValue(now);

    // HealthDisplay.Update
    if (!this.initialPlaying || health !== this.initialHealthValue) {
      this.current = health;
      if (this.initialPlaying) this.finishInitialAnimation(health);
    }
    if (Math.abs(this.lastValue - this.current) > 0.001) {
      this.healthChanged(now);
      this.lastValue = this.current;
    }
    if (this.flashPending) {
      this.flashPending = false;
      this.flash(now);
    }
    if (this.resetMissAt != null && now >= this.resetMissAt) this.finishMissDisplay(now);

    // ArgonHealthDisplay.Update
    this.healthBarValue = dampContinuously(this.healthBarValue, this.current, 50, elapsed);
    if (!this.displayingMiss) this.glowBarValue = dampContinuously(this.glowBarValue, this.current, 50, elapsed);
    this.mainAlpha = dampContinuously(this.mainAlpha, this.current > 0 ? 1 : 0, 40, elapsed);
    this.glowAlpha = dampContinuously(this.glowAlpha, this.glowBarValue > 0 ? 1 : 0, 40, elapsed);
  }

  private currentAnimValue(now: number): number {
    return this.currentAnim.valueAt(now);
  }

  private finishInitialAnimation(value: number): void {
    if (!this.initialPlaying) return;
    this.initialPlaying = false;
    this.current = value;
  }

  private healthChanged(now: number): void {
    if (this.current >= this.glowBarValue) this.finishMissDisplay(now);
    if (this.pendingMissAnimation) {
      this.triggerMissDisplay(now);
      this.pendingMissAnimation = false;
    }
  }

  private flash(now: number): void {
    if (this.displayingMiss) return;
    this.glowGlowColour.to([1, 1, 1, 1], 30, Easing.OutQuint, now).then(MAIN_BAR_GLOW_COLOUR, 300, Easing.OutQuint);
  }

  private triggerMissDisplay(now: number): void {
    this.resetMissAt = now + 500;
    this.glowBarColour.to([1, 147 / 255, 147 / 255, 1], 100, Easing.OutQuint, now).then([1, 93 / 255, 93 / 255, 1], 800, Easing.OutQuint);
    this.glowGlowColour.set(lighten([253 / 255, 0, 0, 1], 0.2), now).to([253 / 255, 0, 0, 1], 800, Easing.OutQuint, now);
  }

  private finishMissDisplay(now: number): void {
    if (!this.displayingMiss) return;
    if (this.current > 0) {
      this.glowBarColour.to(MAIN_BAR_COLOUR, 300, Easing.In, now);
      this.glowGlowColour.to(MAIN_BAR_GLOW_COLOUR, 300, Easing.In, now);
    }
    this.resetMissAt = null;
  }

  /** Draw with the component's top-left at (x, y). */
  draw(g: CanvasRenderingContext2D, x: number, y: number, now: number, dpr: number): void {
    const contentH = this.barHeight + PADDING;
    const key = `${this.width}:${this.barHeight}:${dpr}`;
    if (key !== this.layoutKey) {
      this.layoutKey = key;
      this.path = healthBarPath(this.width, this.barHeight);
      this.lengths = cumulative(this.path);
      this.background = rasteriseBackground(this.path, this.width, contentH, dpr);
    }
    g.save();
    g.translate(x, y);
    if (this.background) g.drawImage(this.background, 0, 0, this.width, contentH);

    const glowFrom = this.healthBarValue;
    const glowTo = Math.max(this.glowBarValue, this.healthBarValue);
    if (glowTo - glowFrom > 0.0005)
      drawBar(g, subPath(this.path, this.lengths, glowFrom, glowTo), GLOW_PATH_RADIUS, GLOW_BAR_GLOW_PORTION, this.glowBarColour.valueAt(now), this.glowGlowColour.valueAt(now), this.glowAlpha * 0.9);
    if (this.healthBarValue > 0.0005) drawBar(g, subPath(this.path, this.lengths, 0, this.healthBarValue), MAIN_PATH_RADIUS, MAIN_PATH_GLOW_PORTION, MAIN_BAR_COLOUR, MAIN_BAR_GLOW_COLOUR, this.mainAlpha);
    g.restore();
  }
}
