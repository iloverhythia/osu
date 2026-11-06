// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Ports of osu.Game/Screens/Ranking/Expanded/Accuracy/AccuracyCircle.cs, GradedCircles.cs, RankBadge.cs, RankText.cs.
//
// Every visual is a pure function of the time since the component loaded (its LoadComplete), using the same delays,
// durations and easings. Without flair (autoplay, or a score other than the one just set) the final state is shown, as
// ExpandedPanelMiddleContent's FinishTransforms(true) does. Approximations: BufferedContainer blurs (RankText flash /
// super flash, GlowingSpriteText) use canvas filters / gradients; Venera is replaced by Exo 2 ExtraBold. Results samples
// are mapped to the synthesised UI sounds.

import { applyEasing, Easing } from '../../game/storyboard/Easing';
import type { ScoreRank } from '../../game/scoring/ScoreRank';
import { DrawableRank } from './DrawableRank';
import {
  ACCURACY_CIRCLE_RADIUS,
  ACCURACY_TRANSFORM_DELAY,
  ACCURACY_TRANSFORM_DURATION,
  ACCURACY_TRANSFORM_EASING,
  accuracyCircleTarget,
  accuracyCutoffFromRank,
  APPEAR_DURATION,
  badgeAppearDelay,
  failedSTarget,
  GRADE_SPACING_PERCENTAGE,
  RANK_CIRCLE_RADIUS,
  RANK_CIRCLE_TRANSFORM_DELAY,
  RANK_CIRCLE_TRANSFORM_DURATION,
  rankBadges,
  rankColour,
  rankLetter,
  rankValue,
  TEXT_APPEAR_DELAY,
  VIRTUAL_SS_PERCENTAGE,
  type BadgeDef,
} from './RankingLogic';

export type PlaySample = (name: string, volume: number, rate?: number) => void;

const ease = (e: Easing, t: number): number => applyEasing(e, Math.min(1, Math.max(0, t)));
/** A transform from `from` to `to` starting at `start` (ms) over `duration`, evaluated at `t`. */
const tween = (t: number, start: number, duration: number, from: number, to: number, e: Easing = Easing.None): number =>
  t < start ? from : duration <= 0 || t >= start + duration ? to : from + (to - from) * applyEasing(e, (t - start) / duration);

const SUPPORTS_FILTER = typeof CanvasRenderingContext2D !== 'undefined' && 'filter' in CanvasRenderingContext2D.prototype;

/** Margin around the 230px circle so badges and flashes can draw outside of it. */
const MARGIN = 150;

interface Badge extends BadgeDef {
  appearAt: number | null;
  drawable: DrawableRank;
}

export class AccuracyCircle {
  readonly el: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly additive: HTMLCanvasElement;
  private readonly target: number;
  private readonly badges: Badge[];
  private readonly isFailedSDueToMisses: boolean;
  private readonly start: number;
  private readonly grades: { start: number; end: number; colour: string }[];
  private lastFrame = 0;

  // flair sound state
  private isTicking = false;
  private lastTickPlaybackTime = -Infinity;
  private readonly cues: { time: number; fn: () => void; done?: boolean }[] = [];

  constructor(
    accuracy: number,
    private readonly rank: ScoreRank,
    private readonly withFlair: boolean,
    now: number,
    private readonly playSample: PlaySample,
    private readonly playApplause: (rank: ScoreRank) => void,
  ) {
    this.start = now;
    this.el = document.createElement('div');
    this.el.className = 'accuracy-circle';
    this.canvas = document.createElement('canvas');
    this.additive = document.createElement('canvas');
    this.additive.className = 'additive';
    this.el.append(this.canvas, this.additive);

    const x = accuracyCutoffFromRank('X');
    const s = accuracyCutoffFromRank('S');
    const a = accuracyCutoffFromRank('A');
    const b = accuracyCutoffFromRank('B');
    const c = accuracyCutoffFromRank('C');
    this.isFailedSDueToMisses = accuracy >= s && rank === 'A';
    this.target = accuracyCircleTarget(accuracy, rank);

    const silver = rank === 'SH' || rank === 'XH';
    const adjust = (r: ScoreRank): ScoreRank => (silver && r === 'S' ? 'SH' : silver && r === 'X' ? 'XH' : r);
    this.badges = rankBadges(adjust).map(def => ({
      ...def,
      drawable: new DrawableRank(def.rank),
      appearAt: rank !== 'F' && rankValue(def.rank) <= rankValue(rank) ? ACCURACY_TRANSFORM_DELAY + badgeAppearDelay(def.accuracy, this.target) : null,
    }));

    const g = GRADE_SPACING_PERCENTAGE * 0.5;
    this.grades = [
      { start: 0, end: c, colour: rankColour('D') },
      { start: c, end: b, colour: rankColour('C') },
      { start: b, end: a, colour: rankColour('B') },
      { start: a, end: s, colour: rankColour('A') },
      { start: s, end: x - VIRTUAL_SS_PERCENTAGE, colour: rankColour('S') },
      { start: x - VIRTUAL_SS_PERCENTAGE, end: 1, colour: rankColour('X') },
    ].map(gc => ({ start: gc.start + g, end: gc.end - g, colour: gc.colour }));

    if (withFlair) this.setupCues();
  }

  private setupCues(): void {
    const cue = (time: number, fn: () => void) => this.cues.push({ time, fn });
    cue(443, () => this.playSample('menu-hover', 0.4, 0.5)); // Results/swoosh-up
    cue(ACCURACY_TRANSFORM_DELAY, () => (this.isTicking = true));
    let badgeNum = 0;
    for (const badge of this.badges) {
      if (badge.appearAt == null) continue;
      cue(badge.appearAt, () => {
        const isMax = badgeNum >= this.badges.length - 1;
        // Results/badge-dink(-max), FrequencyTo(1 + badgeNum * 0.05)
        if (isMax) this.playSample('menu-confirm', 0.6, 1 + badgeNum * 0.05);
        else this.playSample('metronomelow', 0.6, 1 + badgeNum * 0.05);
        badgeNum++;
      });
    }
    cue(ACCURACY_TRANSFORM_DELAY + TEXT_APPEAR_DELAY, () => {
      this.isTicking = false;
      // Results/rank-impact-*
      const r = rankValue(this.rank);
      if (r >= rankValue('A')) this.playSample('menu-confirm', 0.8, r >= rankValue('X') ? 1.25 : 1);
      else this.playSample('menu-back', 0.8, r <= rankValue('D') ? 0.6 : 0.8);
    });
    cue(ACCURACY_TRANSFORM_DELAY + TEXT_APPEAR_DELAY + 545, () => this.playApplause(this.rank));
  }

  /** Time since load, or "the end" when shown without flair. */
  private elapsed(now: number): number {
    return this.withFlair ? now - this.start : 1e9;
  }

  update(now: number): void {
    const e = this.elapsed(now);
    for (const c of this.cues) {
      if (!c.done && e >= c.time) {
        c.done = true;
        c.fn();
      }
    }
    if (this.isTicking) {
      // tickPlaybackRate: 18 → 300 over the fill (OutSine); score-tick frequency 1 → 1 + target, volume 0.6 → 1.
      const p = ease(Easing.OutSine, (e - ACCURACY_TRANSFORM_DELAY) / ACCURACY_TRANSFORM_DURATION);
      const rate = 18 + (300 - 18) * p;
      if (now - this.lastTickPlaybackTime >= rate) {
        this.playSample('menu-hover', 0.3 * (0.6 + 0.4 * p), 1 + this.target * p);
        this.lastTickPlaybackTime = now;
      }
    }
    const elapsed = Math.min(100, now - (this.lastFrame || now));
    this.lastFrame = now;
    for (const b of this.badges) b.drawable.update(elapsed);
    this.draw(now);
  }

  private setupCanvas(c: HTMLCanvasElement, size: number): CanvasRenderingContext2D {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const px = Math.round(size * dpr);
    if (c.width !== px || c.height !== px) c.width = c.height = px;
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, size, size);
    return g;
  }

  private accuracyProgress(e: number): number {
    let p = tween(e, ACCURACY_TRANSFORM_DELAY, ACCURACY_TRANSFORM_DURATION, 0, this.target, ACCURACY_TRANSFORM_EASING);
    if (this.isFailedSDueToMisses) {
      const at = ACCURACY_TRANSFORM_DELAY + TEXT_APPEAR_DELAY;
      if (e >= at) {
        const from = this.target * ease(ACCURACY_TRANSFORM_EASING, TEXT_APPEAR_DELAY / ACCURACY_TRANSFORM_DURATION);
        p = tween(e, at, 70, from, failedSTarget(), Easing.OutQuint);
      }
    }
    return p;
  }

  private draw(now: number): void {
    const e = this.elapsed(now);
    const size = this.el.clientWidth || 230;
    const full = size + MARGIN * 2;
    const g = this.setupCanvas(this.canvas, full);
    const ga = this.setupCanvas(this.additive, full);
    ga.globalCompositeOperation = 'lighter';
    const cx = full / 2;
    const cy = full / 2;

    // this.ScaleTo(0).Then().ScaleTo(1, APPEAR_DURATION, OutQuint)
    const scale = tween(e, 0, APPEAR_DURATION, 0, 1, Easing.OutQuint);
    if (scale <= 0) return;
    for (const ctx of [g, ga]) {
      ctx.translate(cx, cy);
      ctx.scale(scale, scale);
      ctx.translate(-size / 2, -size / 2);
    }
    const R = size / 2;

    // Background circle: Gray(47) at 0.5 alpha, InnerRadius 0.21, full.
    ring(g, R, R, R, ACCURACY_CIRCLE_RADIUS + 0.01, 0, 1, 'rgba(47,47,47,0.5)');

    // Accuracy circle (vertical gradient #7CF6FF → #BAFFA9).
    const grad = g.createLinearGradient(0, 0, 0, size);
    grad.addColorStop(0, '#7CF6FF');
    grad.addColorStop(1, '#BAFFA9');
    ring(g, R, R, R, ACCURACY_CIRCLE_RADIUS, 0, this.accuracyProgress(e), grad);

    // Graded circles (0.8 size, 2.5 padding).
    const gradedProgress = tween(e, RANK_CIRCLE_TRANSFORM_DELAY, RANK_CIRCLE_TRANSFORM_DURATION, 0, 1, ACCURACY_TRANSFORM_EASING);
    const gr = size * 0.4 - 2.5;
    for (const c of this.grades) {
      const p = Math.min(Math.max(gradedProgress, c.start), c.end) - c.start;
      if (p > 0) ring(g, R, R, gr, RANK_CIRCLE_RADIUS, c.start, p, c.colour);
    }

    // Badges (container padding: vertical -15, horizontal -20).
    const bw = size + 40;
    const bh = size + 30;
    for (const b of this.badges) {
      if (b.appearAt == null || e < b.appearAt) continue;
      let alpha = tween(e, b.appearAt, 50, 0, 1);
      if (this.isFailedSDueToMisses && (b.rank === 'S' || b.rank === 'SH')) alpha *= tween(e, ACCURACY_TRANSFORM_DELAY + TEXT_APPEAR_DELAY, 70, 1, 0, Easing.OutQuint);
      const t = -Math.PI / 2 - (1 - b.displayPosition) * Math.PI * 2;
      const x = -20 + bw / 2 + (Math.cos(t) * bw) / 2;
      const y = -15 + bh / 2 + (Math.sin(t) * bh) / 2;
      b.drawable.draw(g, x, y, 28, alpha);
      // Glow overlay: FadeIn().FadeOut(500, In); EdgeEffect glow radius 10 at 0.2 opacity of the rank colour.
      const glow = tween(e, b.appearAt, 500, 1, 0, Easing.In) * alpha;
      if (glow > 0) {
        ga.save();
        ga.globalAlpha = glow;
        ga.shadowColor = hexAlpha(rankColour(b.rank), 0.2);
        ga.shadowBlur = 20;
        ga.fillStyle = hexAlpha(rankColour(b.rank), 0.2);
        ga.beginPath();
        ga.roundRect(x - 14, y - 7, 28, 14, 7);
        ga.fill();
        ga.restore();
      }
    }

    // Rank text.
    const textAt = ACCURACY_TRANSFORM_DELAY + TEXT_APPEAR_DELAY;
    if (e >= textAt) this.drawRankText(g, ga, R, R, e - textAt, this.rank, false);
    if (this.isFailedSDueToMisses && e >= textAt - 200) this.drawRankText(g, ga, R, R, e - (textAt - 200), 'S', true);
  }

  /** RankText (+ the failed-S variant's transforms). `t` is the time since Appear (or since the failed-S fade in). */
  private drawRankText(g: CanvasRenderingContext2D, ga: CanvasRenderingContext2D, x: number, y: number, t: number, rank: ScoreRank, failedS: boolean): void {
    const colour = rankColour(rank);
    let alpha = 1;
    let dy = 0;
    let rotation = 0;
    let textScale = 1;
    let flash = 0;
    let superFlash = 0;
    let textColour = '#ffffff';

    if (failedS) {
      alpha = tween(t, 0, 200, 0, 1);
      const t2 = t - 200;
      if (t2 >= 0) {
        textColour = mixHex('#ffffff', '#ff0000', ease(Easing.Out, t2 / 800));
        rotation = tween(t2, 0, 1000, 0, 10, Easing.Out);
        dy = tween(t2, 0, 1000, 0, 100, Easing.In);
        alpha = tween(t2, 0, 800, 1, 0, Easing.Out);
      }
    } else if (rankValue(rank) < rankValue('A')) {
      // MoveToOffset(0, -20).MoveToOffset(0, 20, 200, OutBounce); D: Delay(700).RotateTo(5, 150, In).MoveToOffset(0, 3, 150, In)
      dy = tween(t, 0, 200, -20, 0, Easing.OutBounce);
      if (rankValue(rank) <= rankValue('D')) {
        rotation = tween(t, 700, 150, 0, 5, Easing.In);
        dy += tween(t, 700, 150, 0, 3, Easing.In);
      }
      alpha = tween(t, 0, 200, 0, 1, Easing.OutQuint);
    } else {
      if (rankValue(rank) >= rankValue('S')) textScale = tween(t, 0, 3000, 1.05, 1, Easing.OutQuint);
      if (rankValue(rank) >= rankValue('X')) {
        flash = tween(t, 0, 3000, 1, 0);
        superFlash = tween(t, 0, 800, 1, 0, Easing.OutQuint);
      } else flash = tween(t, 0, 1200, 1, 0, Easing.OutQuint);
    }
    if (alpha <= 0) return;
    const letter = rankLetter(rank);
    const font = '800 76px "Exo 2", sans-serif';

    // superFlash: a 150px white box blurred with sigma 85 inside a 600px buffer (additive).
    if (superFlash > 0) {
      const sf = ga.createRadialGradient(x, y, 0, x, y, 300);
      sf.addColorStop(0, `rgba(255,255,255,${0.55 * superFlash})`);
      sf.addColorStop(0.4, `rgba(255,255,255,${0.25 * superFlash})`);
      sf.addColorStop(1, 'rgba(255,255,255,0)');
      ga.fillStyle = sf;
      ga.fillRect(x - 300, y - 300, 600, 600);
    }

    for (const [ctx, isFlash] of [
      [g, false],
      [ga, true],
    ] as const) {
      if (isFlash && flash <= 0) continue;
      ctx.save();
      ctx.translate(x, y + dy);
      ctx.rotate((rotation * Math.PI) / 180);
      ctx.font = font;
      ctx.textBaseline = 'middle';
      if (isFlash) {
        // flash: the letter in the rank colour, blurred (sigma 35), scaled 1.8, additive.
        ctx.scale(1.8, 1.8);
        ctx.globalAlpha = flash * alpha;
        ctx.fillStyle = colour;
        if (SUPPORTS_FILTER) ctx.filter = 'blur(20px)';
        else {
          ctx.shadowColor = colour;
          ctx.shadowBlur = 40;
        }
      } else {
        ctx.scale(textScale, textScale);
        ctx.globalAlpha = alpha;
        // GlowingSpriteText: the rank colour glow behind white text.
        ctx.shadowColor = colour;
        ctx.shadowBlur = 16;
        ctx.fillStyle = textColour;
      }
      // Spacing -15 is tuned for Venera's wide glyphs; Exo 2 is narrower.
      spacedText(ctx, letter, 0, 4, -5);
      ctx.restore();
    }
  }
}

/** CircularProgress: a ring of thickness innerRadius·R starting at `start` (fraction, clockwise from the top). */
function ring(g: CanvasRenderingContext2D, cx: number, cy: number, r: number, innerRadius: number, start: number, progress: number, fill: string | CanvasGradient): void {
  if (progress <= 0) return;
  const a0 = -Math.PI / 2 + start * Math.PI * 2;
  const a1 = a0 + Math.min(1, progress) * Math.PI * 2;
  const inner = r * (1 - innerRadius);
  g.beginPath();
  g.arc(cx, cy, r, a0, a1);
  g.arc(cx, cy, inner, a1, a0, true);
  g.closePath();
  g.fillStyle = fill;
  g.fill();
}

function spacedText(g: CanvasRenderingContext2D, text: string, cx: number, cy: number, spacing: number): void {
  g.textAlign = 'left';
  const widths = [...text].map(c => g.measureText(c).width);
  const total = widths.reduce((a, b) => a + b, 0) + spacing * (text.length - 1);
  let x = cx - total / 2;
  [...text].forEach((c, i) => {
    g.fillText(c, x, cy);
    x += widths[i] + spacing;
  });
}

function hexAlpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function mixHex(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (s: number) => Math.round(((pa >> s) & 255) + (((pb >> s) & 255) - ((pa >> s) & 255)) * t);
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}
