// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Canvas-drawn gameplay overlays, ported from:
//  - osu.Game/Screens/Play/BreakOverlay.cs, Break/BreakArrows.cs, Break/BreakInfo.cs, Break/BreakInfoLine.cs,
//    Break/RemainingTimeCounter.cs, Break/GlowIcon.cs, Break/BlurredIcon.cs, LetterboxOverlay.cs
//  - osu.Game/Screens/Play/FailAnimationContainer.cs
//  - osu.Game/Screens/Play/KiaiGameplayFountains.cs + osu.Game/Screens/Menu/StarFountain.cs + osu.Game/Graphics/ParticleSpewer.cs
//  - osu.Game/Screens/Play/DelayedResumeOverlay.cs

import type { ScoreRank } from '../../game/scoring/ScoreRank';
import { Anim, ColourAnim, Easing, FONT, OsuColour, PurpleProvider, css, dampContinuously, gray, valueAt } from './anim';
import { BREAK_FADE_DURATION, type Period } from './clock';
import { formatAccuracy } from './ArgonCounter';
import { drawChevronRight } from './HudComponents';

// ------------------------------------------------------------------------------------------------ break overlay

const RANK_NAMES: Record<string, string> = { XH: 'Silver SS', X: 'SS', SH: 'Silver S', S: 'S', A: 'A', B: 'B', C: 'C', D: 'D', F: 'F' };

interface IconImage {
  canvas: HTMLCanvasElement;
  /** Offset from the icon box's top-left to the image's top-left. */
  pad: number;
}

function renderChevron(size: number, sigma: number, drawOriginal: boolean, dpr: number): IconImage {
  const pad = Math.ceil(sigma * 3);
  const c = document.createElement('canvas');
  c.width = Math.ceil((size + pad * 2) * dpr);
  c.height = Math.ceil((size + pad * 2) * dpr);
  const g = c.getContext('2d')!;
  g.scale(dpr, dpr);
  const glow = css(OsuColour.BlueLighter);
  const supportsFilter = typeof (g as { filter?: string }).filter === 'string';
  if (supportsFilter) {
    g.filter = `blur(${sigma}px)`;
    g.fillStyle = glow;
    drawChevronRight(g, pad + size / 2, pad + size / 2, size);
    g.filter = 'none';
  } else {
    g.shadowColor = glow;
    g.shadowBlur = sigma * 2;
    g.shadowOffsetX = 10000;
    g.fillStyle = glow;
    g.translate(-10000, 0);
    drawChevronRight(g, pad + size / 2, pad + size / 2, size);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.shadowColor = 'transparent';
  }
  if (drawOriginal) {
    g.fillStyle = '#fff';
    drawChevronRight(g, pad + size / 2, pad + size / 2, size);
  }
  return { canvas: c, pad };
}

export class BreakOverlay {
  /** The most recent break period (transforms are kept after it ends: RemoveCompletedTransforms = false). */
  private period: Period | null = null;
  private remainingBoxWidth = 0;
  private icons: { glow: IconImage; blurred: IconImage; dpr: number } | null = null;
  hidden = false;

  /** BreakTracker.CurrentPeriod changed. */
  setCurrentPeriod(p: Period | null): void {
    if (p) this.period = p;
  }

  update(time: number, currentPeriod: Period | null, elapsed: number): void {
    const remaining = currentPeriod == null ? 0 : Math.max(0, (currentPeriod.end - time - BREAK_FADE_DURATION) / (currentPeriod.end - currentPeriod.start));
    this.remainingBoxWidth = dampContinuously(this.remainingBoxWidth, remaining, 40, Math.abs(elapsed));
  }

  draw(g: CanvasRenderingContext2D, w: number, h: number, time: number, accuracy: number, rank: ScoreRank, dpr: number): void {
    const b = this.period;
    if (!b || this.hidden) return;
    const duration = b.end - b.start;
    const t = time - b.start;
    if (t < 0 || t > duration + BREAK_FADE_DURATION) return;
    // fadeContainer.FadeIn(BREAK_FADE_DURATION) ... Delay(duration).FadeOut(BREAK_FADE_DURATION)
    const alpha = t < duration ? Math.min(1, t / BREAK_FADE_DURATION) : Math.max(0, 1 - (t - duration) / BREAK_FADE_DURATION);
    if (alpha <= 0) return;
    const cx = w / 2;
    const cy = h / 2;
    g.save();
    g.globalAlpha *= alpha;

    // 80x4 circular container with a shadow edge effect (radius 260, Gray(0.2) @ 0.8, roundness 12).
    const shadow = g.createRadialGradient(cx, cy, 0, cx, cy, 300);
    shadow.addColorStop(0, css(gray(0.2), 0.8));
    shadow.addColorStop(0.35, css(gray(0.2), 0.55));
    shadow.addColorStop(1, css(gray(0.2), 0));
    g.fillStyle = shadow;
    g.fillRect(cx - 300, cy - 300, 600, 600);

    // Arrows (BreakArrows.Show / Hide over BREAK_FADE_DURATION, OutQuint). Parallax is not reproduced.
    const show = (from: number, to: number) =>
      t < duration ? valueAt(t, from, to, 0, BREAK_FADE_DURATION, Easing.OutQuint) : valueAt(t - duration, to, from, 0, BREAK_FADE_DURATION, Easing.OutQuint);
    if (!this.icons || this.icons.dpr !== dpr) this.icons = { glow: renderChevron(60, 10, true, dpr), blurred: renderChevron(130, 20, false, dpr), dpr };
    const glowX = show(0.6, 0.22) * w;
    const blurX = show(0.7, 0.38) * w;
    const drawIcon = (img: IconImage, size: number, x: number, mirrored: boolean, additive: boolean, a: number) => {
      g.save();
      if (additive) g.globalCompositeOperation = 'lighter';
      g.globalAlpha *= a;
      const full = size + img.pad * 2;
      g.translate(x, cy);
      if (mirrored) g.scale(-1, 1);
      // Origin CentreRight for the left icon (pointing right) → the box ends at x.
      g.drawImage(img.canvas, -size - img.pad, -size / 2 - img.pad, full, full);
      g.restore();
    };
    drawIcon(this.icons.blurred, 130, cx - blurX, false, true, 0.7);
    drawIcon(this.icons.blurred, 130, cx + blurX, true, true, 0.7);
    drawIcon(this.icons.glow, 60, cx - glowX, false, false, 1);
    drawIcon(this.icons.glow, 60, cx + glowX, true, false, 1);

    // Remaining time bar: adjustment box width 0 → 0.3 over BREAK_FADE_DURATION (OutQuint), reset to 0 at the end.
    const adjust = t < duration ? valueAt(t, 0, 0.3, 0, BREAK_FADE_DURATION, Easing.OutQuint) : 0;
    const boxW = adjust * w * this.remainingBoxWidth;
    if (boxW > 0) {
      const boxH = Math.min(8, boxW);
      g.fillStyle = '#fff';
      g.beginPath();
      if (typeof g.roundRect === 'function') g.roundRect(cx - boxW / 2, cy - boxH / 2, boxW, boxH, boxH / 2);
      else g.rect(cx - boxW / 2, cy - boxH / 2, boxW, boxH);
      g.fill();
    }

    // RemainingTimeCounter: CountTo(duration + fade) then CountTo(0, duration + fade); MoveToX(-50) → 0.
    const total = duration + BREAK_FADE_DURATION;
    const count = Math.max(0, total - Math.min(t, total));
    const counterX = valueAt(t, -50, 0, 0, BREAK_FADE_DURATION, Easing.OutQuint);
    g.textAlign = 'center';
    g.textBaseline = 'bottom';
    g.font = `400 33px ${FONT}`;
    g.fillStyle = '#fff';
    g.fillText(String(Math.ceil(count / 1000)), cx + counterX, cy - 15);

    // BreakInfo: "CURRENT PROGRESS" (bold 15) then Accuracy / Grade lines (17, Yellow / bold YellowLight), MoveToX(50) → 0.
    const infoX = cx + valueAt(t, 50, 0, 0, BREAK_FADE_DURATION, Easing.OutQuint);
    let y = cy + 15;
    g.textBaseline = 'top';
    g.font = `700 15px ${FONT}`;
    g.fillText('CURRENT PROGRESS', infoX, y);
    y += 15 + 5;
    const line = (name: string, value: string) => {
      g.font = `400 17px ${FONT}`;
      g.textAlign = 'right';
      g.fillStyle = css(OsuColour.Yellow);
      g.fillText(name, infoX - 2, y);
      g.font = `700 17px ${FONT}`;
      g.textAlign = 'left';
      g.fillStyle = css(OsuColour.YellowLight);
      g.fillText(value, infoX + 2, y);
      y += 17;
    };
    line('Accuracy', formatAccuracy(accuracy));
    line('Grade', RANK_NAMES[rank] ?? rank);
    g.restore();
  }
}

/** LetterboxOverlay: black bars (12.5% each) fading with the break period. */
export function drawLetterbox(g: CanvasRenderingContext2D, w: number, h: number, time: number, period: Period | null): void {
  if (!period) return;
  const duration = period.end - period.start;
  const t = time - period.start;
  if (t < 0 || t > duration + BREAK_FADE_DURATION) return;
  const a = t < duration ? Math.min(1, t / BREAK_FADE_DURATION) : Math.max(0, 1 - (t - duration) / BREAK_FADE_DURATION);
  if (a <= 0) return;
  g.fillStyle = `rgba(0,0,0,${a})`;
  g.fillRect(0, 0, w, h * 0.125);
  g.fillRect(0, h - h * 0.125, w, h * 0.125);
}

// ------------------------------------------------------------------------------------------------ fail animation

export const FAIL_DURATION = 2500;
/** AudioFilter.MAX_LOWPASS_CUTOFF */
const MAX_LOWPASS_CUTOFF = 22049;

/** FailAnimationContainer: playfield/content transforms, track frequency + volume adjustments and the low-pass sweep. */
export class FailAnimation {
  startedAt: number | null = null;
  private finishedAt: number | null = null;
  completed = false;

  start(now: number): void {
    if (this.startedAt != null) return;
    this.startedAt = now;
  }

  get started(): boolean {
    return this.startedAt != null;
  }

  /** FinishTransforms(true): jump to the end state (triggers completion on the next update). */
  finishNow(now: number): void {
    if (this.startedAt == null || this.completed) return;
    this.finishedAt = now;
  }

  private elapsed(now: number): number {
    if (this.startedAt == null) return 0;
    if (this.finishedAt != null) return FAIL_DURATION;
    return Math.min(FAIL_DURATION, now - this.startedAt);
  }

  /** Returns true once, when the animation completes (OnComplete). */
  update(now: number): boolean {
    if (this.startedAt == null || this.completed) return false;
    if (this.elapsed(now) >= FAIL_DURATION) {
      this.completed = true;
      return true;
    }
    return false;
  }

  /** trackFreq: TransformBindableTo(0, duration) (linear). Not reset on completion. */
  trackFrequency(now: number): number {
    return this.startedAt == null ? 1 : 1 - this.elapsed(now) / FAIL_DURATION;
  }

  /** failLowPassFilter.CutoffTo(300, duration, OutCubic); the filters are removed on completion. */
  lowPassCutoff(now: number, sampleRate: number): number {
    const max = Math.min(MAX_LOWPASS_CUTOFF, sampleRate / 2);
    if (this.startedAt == null || this.completed) return max;
    return valueAt(this.elapsed(now), max, 300, 0, FAIL_DURATION, Easing.OutCubic);
  }

  /** Content.ScaleTo(0.85, OutQuart), RotateTo(1, OutQuart), FadeColour(Gray, linear). */
  contentTransform(now: number): { scale: number; rotation: number; colour: number } {
    const t = this.elapsed(now);
    return {
      scale: valueAt(t, 1, 0.85, 0, FAIL_DURATION, Easing.OutQuart),
      rotation: valueAt(t, 0, 1, 0, FAIL_DURATION, Easing.OutQuart),
      colour: valueAt(t, 1, 128 / 255, 0, FAIL_DURATION, Easing.None),
    };
  }

  /** Playfield.HitObjectContainer.FadeOut(duration / 2). */
  hitObjectAlpha(now: number): number {
    return Math.max(0, 1 - this.elapsed(now) / (FAIL_DURATION / 2));
  }

  /** redFlashLayer.FadeOutFromOne(1000) (Red @ 0.6, additive). */
  redFlash(now: number): number {
    return this.startedAt == null ? 0 : 0.6 * Math.max(0, 1 - this.elapsed(now) / 1000);
  }

  /** Background.FadeColour(Gray(0.3), 60). */
  backgroundColour(now: number): number {
    return this.startedAt == null ? 1 : valueAt(this.elapsed(now), 1, 0.3, 0, 60, Easing.None);
  }
}

// ------------------------------------------------------------------------------------------------ kiai fountains

interface Particle {
  startTime: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  duration: number;
  startAngle: number;
  endAngle: number;
  endScale: number;
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const variance = (v: number) => rand(-v, v);

/** StarFountainSpewer with GameplayStarFountainSpewer's overrides (180/s, shoot 400ms, x velocity 450..600). */
class Spewer {
  private readonly particles: (Particle | null)[];
  private index = 0;
  private lastAdded: number | null = null;
  private active = false;
  private deactivateAt = 0;
  private direction = 0;
  private readonly timeBetween = 1000 / 180;
  private readonly maxDuration = 1000;

  constructor() {
    this.particles = new Array(180 * Math.ceil(this.maxDuration / 1000)).fill(null);
  }

  shoot(direction: number, now: number): void {
    if (!this.active) this.lastAdded = null;
    this.active = true;
    this.deactivateAt = now + 400;
    this.direction = direction;
  }

  update(now: number): void {
    if (this.active && now >= this.deactivateAt) this.active = false;
    if (!this.active) return;
    if (this.lastAdded == null) {
      this.lastAdded = now;
      this.spawn();
      return;
    }
    const elapsed = now - this.lastAdded;
    if (Math.abs(elapsed) > this.maxDuration) {
      this.lastAdded = now;
      this.spawn();
      return;
    }
    for (let i = 0; i < elapsed / this.timeBetween; i++) {
      this.lastAdded += this.timeBetween;
      this.spawn();
    }
  }

  private spawn(): void {
    this.particles[this.index] = {
      startTime: this.lastAdded!,
      x: 0,
      y: 50,
      vx: this.direction * rand(450, 600),
      vy: -1400 + variance(100),
      duration: rand(300, 1000),
      startAngle: variance(4),
      endAngle: variance(2),
      endScale: 2.2 + variance(0.4),
    };
    this.index = (this.index + 1) % this.particles.length;
  }

  draw(g: CanvasRenderingContext2D, ox: number, oy: number, now: number, star: HTMLCanvasElement, size: number): void {
    for (const p of this.particles) {
      if (!p) continue;
      const since = now - p.startTime;
      if (since < 0) continue;
      const progress = Math.max(0, Math.min(1, since / p.duration));
      const alpha = 1 - progress;
      if (alpha <= 0) continue;
      const gy = 800 * (p.duration / this.maxDuration) * progress;
      const x = ox + p.x + (p.vx * since) / this.maxDuration;
      const y = oy + p.y + ((p.vy + gy) * since) / this.maxDuration;
      const scale = 1 + (p.endScale - 1) * progress;
      const angle = p.startAngle + (p.endAngle - p.startAngle) * progress;
      const s = size * scale;
      g.save();
      g.globalAlpha = alpha;
      g.translate(x, y);
      g.rotate(-angle);
      g.drawImage(star, -s / 2, -s / 2, s, s);
      g.restore();
    }
  }
}

/** KiaiGameplayFountains: shoots both fountains when a kiai section starts (within 500ms of its effect point). */
export class KiaiFountains {
  private readonly left = new Spewer();
  private readonly right = new Spewer();
  private isTriggered = false;
  private star: HTMLCanvasElement | null = null;
  /** Approximate display size of the "Menu/fountain-star" texture (not redistributable; drawn procedurally). */
  static readonly STAR_SIZE = 24;

  update(now: number, gameplayTime: number, effect: { time: number; kiaiMode: boolean }, enabled: boolean): void {
    this.left.update(now);
    this.right.update(now);
    if (!enabled) return;
    if (effect.kiaiMode && !this.isTriggered && Math.abs(gameplayTime - effect.time) < 500) {
      this.left.shoot(1, now);
      this.right.shoot(-1, now);
    }
    this.isTriggered = effect.kiaiMode;
  }

  draw(g: CanvasRenderingContext2D, w: number, h: number, now: number): void {
    if (!this.star) this.star = renderStar(KiaiFountains.STAR_SIZE * 2);
    const size = KiaiFountains.STAR_SIZE;
    g.save();
    g.globalCompositeOperation = 'lighter';
    this.left.draw(g, 75, h - size, now, this.star, size);
    this.right.draw(g, w - 75 - size, h - size, now, this.star, size);
    g.restore();
  }
}

function renderStar(px: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = px;
  const g = c.getContext('2d')!;
  const r = px / 2;
  const grad = g.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0, 'rgba(255,255,255,0.9)');
  grad.addColorStop(0.25, 'rgba(255,240,200,0.45)');
  grad.addColorStop(1, 'rgba(255,220,150,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, px, px);
  g.fillStyle = 'rgba(255,255,255,0.95)';
  g.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    const rr = i % 2 === 0 ? r * 0.95 : r * 0.22;
    g.lineTo(r + Math.cos(a) * rr, r + Math.sin(a) * rr);
  }
  g.closePath();
  g.fill();
  return c;
}

// ------------------------------------------------------------------------------------------------ delayed resume overlay

/** DelayedResumeOverlay: a 3-2-1 countdown (2000ms, starting 200ms after appearing) before gameplay resumes. */
export class DelayedResumeOverlay {
  private shownAt: number | null = null;
  private hiddenAt: number | null = null;
  private countdownStartTime = 0;
  private countdownCount: number | null = null;
  private countdownComplete = false;
  private alpha = 1;
  private text = '';
  private readonly textScale = new Anim(1);
  private readonly outerScale = new Anim(0);
  private readonly innerScale = new Anim(0);
  private readonly componentsAlpha = new Anim(0);
  private readonly bgColour = new ColourAnim(PurpleProvider.background4);
  private progress = 0;
  onResume: (() => void) | null = null;
  onCount: ((count: number) => void) | null = null;

  constructor(private readonly scale = 1) {}

  get visible(): boolean {
    return this.shownAt != null && this.hiddenAt == null;
  }

  show(now: number): void {
    this.shownAt = now;
    this.hiddenAt = null;
    this.outerScale.set(0, now).to(1, 200, Easing.OutQuint, now);
    this.innerScale.set(0, now).to(1, 400, Easing.OutElasticHalf, now);
    this.componentsAlpha.set(0, now).to(1, 100, Easing.None, now + 50);
    this.progress = 0;
    this.text = '';
    this.countdownComplete = false;
    this.countdownCount = null;
    this.countdownStartTime = now + 200;
  }

  hide(now: number): void {
    if (this.shownAt == null || this.hiddenAt != null) return;
    this.hiddenAt = now;
  }

  update(now: number): void {
    if (!this.visible || this.countdownComplete || now < this.countdownStartTime) return;
    const amount = Math.max(0, Math.min(2000, (now - this.countdownStartTime) / 2000));
    const newCount = Math.max(0, Math.min(3, 3 - Math.floor(amount * 3)));
    this.progress = amount;
    this.alpha = 0.2 + (0.8 * newCount) / 3;
    if (this.countdownCount !== newCount) {
      if (newCount > 0) {
        this.text = String(Math.max(1, newCount));
        this.textScale.set(0.25, now).to(1, 200, Easing.OutQuint, now);
        this.outerScale.to(1, 0, Easing.None, now).then(1.05, 100, Easing.None, 25).then(1, 200, Easing.Out);
        this.bgColour.set(PurpleProvider.background3, now).to(PurpleProvider.background4, 400, Easing.Out, now);
      }
      this.onCount?.(newCount);
    }
    this.countdownCount = newCount;
    if (newCount === 0) {
      this.countdownComplete = true;
      this.hiddenAt = now;
      this.onResume?.();
    }
  }

  draw(g: CanvasRenderingContext2D, w: number, h: number, now: number): void {
    if (this.shownAt == null) return;
    const alpha = this.alpha;
    let contentVisible = true;
    let progressScale = 1;
    let progressAlpha = 1;
    if (this.hiddenAt != null) {
      const t = now - this.hiddenAt;
      if (t > 300) return; // Delay(300).FadeOut()
      contentVisible = false;
      if (this.countdownComplete) {
        progressScale = valueAt(t, 1, 2, 0, 300, Easing.OutQuint);
        progressAlpha = valueAt(t, 1, 0, 0, 300, Easing.OutQuint);
      } else progressAlpha = 0;
    }
    const cx = w / 2;
    const cy = h / 2;
    g.save();
    g.globalAlpha *= alpha;
    g.translate(cx, cy);
    g.scale(this.scale, this.scale);
    if (contentVisible) {
      const os = this.outerScale.valueAt(now);
      g.fillStyle = css(PurpleProvider.background6);
      g.beginPath();
      g.arc(0, 0, 100 * os, 0, Math.PI * 2);
      g.fill();
    }
    const is = this.innerScale.valueAt(now);
    g.scale(is, is);
    if (contentVisible) {
      g.fillStyle = css(this.bgColour.valueAt(now));
      g.beginPath();
      g.arc(0, 0, 75, 0, Math.PI * 2);
      g.fill();
    }
    const ca = this.componentsAlpha.valueAt(now);
    g.globalAlpha *= ca;
    // CircularProgress: size 153.5, stroke 7, rounded caps.
    if (progressAlpha > 0 && this.progress > 0) {
      g.save();
      g.globalAlpha *= progressAlpha;
      g.strokeStyle = '#fff';
      g.lineCap = 'round';
      g.lineWidth = 7;
      const r = (153.5 * progressScale) / 2 - 3.5;
      g.beginPath();
      g.arc(0, 0, r, -Math.PI / 2, -Math.PI / 2 + Math.min(1, this.progress) * Math.PI * 2);
      g.stroke();
      g.restore();
    }
    if (contentVisible && this.text) {
      const ts = this.textScale.valueAt(now);
      g.scale(ts, ts);
      g.fillStyle = '#fff';
      g.font = `300 70px ${FONT}`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(this.text, 0, 3);
    }
    g.restore();
  }
}

