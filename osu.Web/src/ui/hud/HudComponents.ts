// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Ports of the remaining default (Argon) HUD components:
//  - osu.Game/Screens/Play/HUD/ArgonWedgePiece.cs
//  - osu.Game/Screens/Play/HUD/SongProgress.cs, ArgonSongProgress.cs, ArgonSongProgressBar.cs, ArgonSongProgressGraph.cs,
//    SongProgressInfo.cs, osu.Game/Graphics/UserInterface/SegmentedGraph.cs
//  - osu.Game/Screens/Play/HUD/HitErrorMeters/BarHitErrorMeter.cs, ColourHitErrorMeter.cs (+ OsuColour.ForHitResult)
//  - osu.Game/Screens/Play/ArgonKeyCounter.cs, ArgonKeyCounterDisplay.cs, HUD/KeyCounterDisplay.cs, HUD/InputTrigger.cs
//  - osu.Game/Screens/Play/HUD/ModDisplay.cs + osu.Game/Rulesets/UI/ModIcon.cs (OsuColour.ForModType)
//  - osu.Game/Screens/Play/HUD/FailingLayer.cs

import { HitResult } from '../../game/scoring/HitResult';
import { MOD_BY_ACRONYM, type ModSet, type ModType } from '../../game/mods/Mods';
import { Anim, ColourAnim, Easing, FONT, OsuColour, css, darken, gray, hex, lerp, valueAt, type RGBA } from './anim';

// ------------------------------------------------------------------------------------------------ colours

/** OsuColour.ForHitResult */
export function colourForHitResult(r: HitResult): RGBA {
  switch (r) {
    case HitResult.IgnoreMiss:
    case HitResult.SmallTickMiss:
      return [128 / 255, 128 / 255, 128 / 255, 1]; // Color4.Gray
    case HitResult.Miss:
    case HitResult.LargeTickMiss:
    case HitResult.ComboBreak:
      return OsuColour.Red;
    case HitResult.Meh:
      return OsuColour.Yellow;
    case HitResult.Ok:
      return OsuColour.Green;
    case HitResult.Good:
      return OsuColour.GreenLight;
    case HitResult.SmallTickHit:
    case HitResult.LargeTickHit:
    case HitResult.SliderTailHit:
    case HitResult.Great:
      return OsuColour.Blue;
    default:
      return OsuColour.BlueLight;
  }
}

/** OsuColour.ForModType */
export function colourForModType(t: ModType): RGBA {
  switch (t) {
    case 'automation':
      return OsuColour.Blue1;
    case 'increase':
      return OsuColour.Red1;
    case 'reduction':
      return OsuColour.Lime1;
    case 'conversion':
      return OsuColour.Purple1;
    default:
      return OsuColour.Pink1;
  }
}

// ------------------------------------------------------------------------------------------------ wedge

/** ArgonWedgePiece: sheared (0.8, 0), corner radius 10, vertical gradient of the accent colour from 0 to 0.25 alpha. */
export function drawWedge(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, accent: RGBA = hex('66CCFF')): void {
  g.save();
  g.translate(x, y);
  // osu-framework applies -Shear: x' = x - 0.8 * y around the origin (top-left).
  g.transform(1, 0, -0.8, 1, 0, 0);
  const grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, css(accent, 0));
  grad.addColorStop(1, css(accent, 0.25));
  g.fillStyle = grad;
  g.beginPath();
  if (typeof g.roundRect === 'function') g.roundRect(0, 0, w, h, 10);
  else g.rect(0, 0, w, h);
  g.fill();
  g.restore();
}

// ------------------------------------------------------------------------------------------------ song progress

const formatTime = (ms: number): string => {
  const neg = ms < 0;
  const total = Math.abs(ms);
  // TimeSpan.Duration().TotalMinutes floored / .Seconds
  const minutes = Math.floor(total / 60000);
  const seconds = Math.floor((total % 60000) / 1000);
  return `${neg ? '-' : ''}${minutes}:${String(seconds).padStart(2, '0')}`;
};

export class ArgonSongProgress {
  static readonly BAR_HEIGHT = 10;
  static readonly INFO_HEIGHT = 18;
  firstHitTime = 0;
  lastHitTime = 0;
  private playfieldLength = 0;
  private segments: { tier: number; start: number; end: number }[] = [];
  private readonly alpha = new Anim(0);
  private readonly background = new Anim(0);
  private timeCurrent = '';
  private timeLeft = '';
  private previousSecond: number | null = null;

  /** SongProgress.Objects setter + ArgonSongProgressGraph.Objects (display_granularity 200, 5 tiers). */
  setObjects(objects: readonly { start: number; end: number }[], now: number): void {
    if (objects.length === 0) return;
    this.firstHitTime = objects[0].start;
    this.lastHitTime = Math.max(...objects.map(o => o.end));
    const granularity = 200;
    const values = new Array<number>(granularity).fill(0);
    let lastHit = this.lastHitTime;
    if (lastHit === 0) lastHit = objects[objects.length - 1].start;
    const interval = (lastHit - this.firstHitTime + 1) / granularity;
    for (const h of objects) {
      const startRange = Math.floor((h.start - this.firstHitTime) / interval);
      const endRange = Math.floor((h.end - this.firstHitTime) / interval);
      for (let i = startRange; i <= endRange; i++) if (i >= 0 && i < granularity) values[i]++;
    }
    this.segments = segmentedGraph(values, 5);
    // SongProgress.LoadComplete → Show() → PopIn: FadeIn(500, OutQuint); bar background FadeTo(0.3, 200, In).
    this.alpha.to(1, 500, Easing.OutQuint, now);
    this.background.to(0.3, 200, Easing.In, now);
  }

  update(time: number, clockStartTime: number, elapsed: number): void {
    // SongProgress.Update
    const currentTime = Math.min(time, this.lastHitTime);
    let progress: number;
    if (currentTime < this.firstHitTime) {
      progress = 0; // UpdateProgress(.., isIntro: true) → bar.Progress = 0
      void clockStartTime;
    } else {
      const duration = this.lastHitTime - this.firstHitTime;
      progress = duration === 0 ? 0 : (currentTime - this.firstHitTime) / duration;
    }
    this.playfieldLength = lerp(this.playfieldLength, progress, Math.max(0, Math.min(1, elapsed / 40)));

    // SongProgressInfo.Update (ShowProgress = false)
    const songCurrentTime = time - this.firstHitTime;
    const songLength = this.lastHitTime - this.firstHitTime;
    const currentSecond = Math.floor(songCurrentTime / 1000);
    if (currentSecond !== this.previousSecond && songCurrentTime < songLength) {
      this.timeCurrent = formatTime(currentSecond * 1000);
      this.timeLeft = formatTime(this.lastHitTime - time);
      this.previousSecond = currentSecond;
    }
  }

  get height(): number {
    return ArgonSongProgress.BAR_HEIGHT * 2 + ArgonSongProgress.INFO_HEIGHT;
  }

  /** Draws with the bottom-centre at (cx, bottom). Width is the (already scaled) drawable width. */
  draw(g: CanvasRenderingContext2D, cx: number, bottom: number, width: number, now: number): void {
    const a = this.alpha.valueAt(now);
    if (a <= 0) return;
    const left = cx - width / 2;
    const top = bottom - this.height;
    g.save();
    g.globalAlpha *= a;
    // info: Torus 18 bold, white
    g.font = `700 18px ${FONT}`;
    g.fillStyle = '#fff';
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    g.fillText(this.timeCurrent, left, top + ArgonSongProgress.INFO_HEIGHT / 2);
    g.textAlign = 'right';
    g.fillText(this.timeLeft, left + width, top + ArgonSongProgress.INFO_HEIGHT / 2);

    const barTop = bottom - ArgonSongProgress.BAR_HEIGHT;
    const h = ArgonSongProgress.BAR_HEIGHT;
    g.save();
    g.beginPath();
    rounded(g, left, barTop, width, h, 5);
    g.clip();
    g.fillStyle = css(gray(0.2), this.background.valueAt(now));
    g.fillRect(left, barTop, width, h);
    // Difficulty graph: tiers of OsuColour.Gray(0.2) @ 0.1, additive.
    g.globalCompositeOperation = 'lighter';
    g.fillStyle = css(gray(0.2), 0.1);
    for (const s of this.segments) if ((s.end - s.start) * width > 1) g.fillRect(left + s.start * width, barTop, (s.end - s.start) * width, h);
    g.globalCompositeOperation = 'source-over';
    // Playfield bar (Gray 0.9). The audio bar tracks the same time here so is drawn underneath and hidden.
    const len = this.playfieldLength * width;
    if (len > 0) {
      g.beginPath();
      rounded(g, left, barTop, len, h, Math.min(5, len / 2));
      g.fillStyle = css(gray(0.9));
      g.fill();
    }
    g.restore();
    g.restore();
  }
}

function rounded(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  if (typeof g.roundRect === 'function') g.roundRect(x, y, w, h, Math.max(0, Math.min(r, w / 2, h / 2)));
  else g.rect(x, y, w, h);
}

/** SegmentedGraph.recalculateTiers + recalculateSegments. */
export function segmentedGraph(values: number[], tierCount: number): { tier: number; start: number; end: number }[] {
  if (values.length === 0) return [{ tier: 0, start: 0, end: 1 }];
  const max = Math.max(...values);
  const tiers = values.map(v => (max > 0 ? Math.floor((v / max) * tierCount) : 0));
  const out: { tier: number; start: number; end: number }[] = [];
  const pending: (number | null)[] = new Array(tierCount).fill(null);
  for (let i = 0; i < tiers.length; i++) {
    for (let tier = 0; tier < tierCount; tier++) {
      if (tiers[i] >= tier) {
        if (pending[tier] == null) pending[tier] = i / tiers.length;
      } else if (pending[tier] != null) {
        out.push({ tier, start: pending[tier]!, end: i / tiers.length });
        pending[tier] = null;
      }
    }
  }
  for (let tier = 0; tier < tierCount; tier++) if (pending[tier] != null) out.push({ tier, start: pending[tier]!, end: 1 });
  out.sort((a, b) => (a.tier !== b.tier ? a.tier - b.tier : a.start - b.start));
  return out;
}

// ------------------------------------------------------------------------------------------------ hit error meters

interface JudgementLine {
  y: number;
  colour: RGBA;
  born: number;
  /** Set when a quick fade was forced (max_concurrent_judgements). */
  quickFadeAt?: number;
  quickFadeFrom?: number;
}

/** BarHitErrorMeter, with the default settings (thickness 4, colour bars, moving average, circle centre marker, icon labels). */
export class BarHitErrorMeter {
  static readonly WIDTH = 2 + 8 + 14 + 2;
  static readonly HEIGHT = 200 + 4;
  private readonly windows: { result: HitResult; length: number }[];
  private readonly maxHitWindow: number;
  private readonly lines: JudgementLine[] = [];
  private floatingAverage = 0;
  private readonly arrowY = new Anim(0.5);
  private readonly loadedAt: number;
  judgementLineThickness = 4;

  constructor(windows: { result: HitResult; length: number }[], now: number) {
    // hitWindows = HitWindows.GetAllAvailableWindows().Where(w => w.result.IsHit()) — ordered largest window first.
    this.windows = windows.filter(w => w.result !== HitResult.Miss && w.result !== HitResult.None);
    this.maxHitWindow = Math.max(1, this.windows[0]?.length ?? 0);
    this.loadedAt = now;
  }

  get hasWindows(): boolean {
    return this.windows.length > 0;
  }

  private relative(value: number): number {
    return Math.max(0, Math.min(1, (value / this.maxHitWindow + 1) / 2));
  }

  onNewJudgement(timeOffset: number, type: HitResult, now: number): void {
    const QUICK_FADE = 100;
    const alive = this.lines.filter(l => this.lineAlpha(l, now) > 0 || now < l.born + 100);
    if (alive.length > 50) {
      const old = alive.find(l => l.quickFadeAt == null && l.born + 5100 > now + QUICK_FADE * 1.1);
      if (old) {
        old.quickFadeFrom = this.lineAlpha(old, now);
        old.quickFadeAt = now;
      }
    }
    this.lines.push({ y: this.relative(timeOffset), colour: colourForHitResult(type), born: now });
    this.floatingAverage = this.floatingAverage * 0.9 + timeOffset * 0.1;
    this.arrowY.to(this.relative(this.floatingAverage), 800, Easing.OutQuint, now);
    // Drop expired lines.
    while (this.lines.length > 0 && now > this.lines[0].born + 5100 + 1) this.lines.shift();
  }

  clear(): void {
    this.lines.length = 0;
  }

  /** JudgementLine.PrepareForUse transforms. */
  private lineAlpha(l: JudgementLine, now: number): number {
    if (l.quickFadeAt != null) return Math.max(0, (l.quickFadeFrom ?? 0.6) * (1 - (now - l.quickFadeAt) / 100));
    const t = now - l.born;
    if (t < 100) return valueAt(t, 0, 0.6, 0, 100, Easing.OutQuint);
    return Math.max(0, valueAt(t, 0.6, 0, 100, 5100, Easing.None));
  }

  private lineWidth(l: JudgementLine, now: number): number {
    const t = now - l.born;
    if (t < 100) return valueAt(t, 0, 1, 0, 100, Easing.OutQuint);
    return valueAt(t, 1, 0, 100, 5100, Easing.InQuint);
  }

  /** Draws with the top-left of the meter at (x, y); `mirror` implements Scale = (-1, 1) with the origin flipped. */
  draw(g: CanvasRenderingContext2D, x: number, y: number, now: number, mirror: boolean): void {
    if (!this.hasWindows) return;
    const since = now - this.loadedAt;
    g.save();
    g.translate(x, y);
    if (mirror) {
      g.translate(BarHitErrorMeter.WIDTH, 0);
      g.scale(-1, 1);
    }
    g.translate(2, 2); // Margin(2)
    const barH = 200;
    // colourBars: X = chevron_size (8), width 14, height animates 0 → 1 over 800ms OutQuint (around the centre).
    const heightScale = valueAt(since, 0, 1, 0, 800, Easing.OutQuint);
    const colH = barH * heightScale;
    const colTop = (barH - colH) / 2;
    const colX = 8;
    const centreX = colX + 7;
    const centreY = barH / 2;

    // Colour bars (2px wide) early (upwards) and late (downwards), fading in over 500ms.
    const barsAlpha = valueAt(since, 0, 1, 0, 500, Easing.OutQuint);
    if (barsAlpha > 0) {
      g.save();
      g.globalAlpha *= barsAlpha;
      for (let i = 0; i < this.windows.length; i++) {
        const w = this.windows[i];
        const frac = w.length / this.maxHitWindow;
        const c = colourForHitResult(w.result);
        const half = (colH / 2) * frac;
        for (const dir of [-1, 1]) {
          if (i === 0) {
            const solid = half * 0.8;
            g.fillStyle = css(c);
            g.fillRect(centreX - 1, dir < 0 ? centreY - solid : centreY, 2, solid);
            // gradient part: Y = 0.8 (relative), height = frac * 0.2
            const gy0 = centreY + dir * (colH / 2) * 0.8;
            const gy1 = gy0 + dir * half * 0.2;
            const grad = g.createLinearGradient(0, gy0, 0, gy1);
            grad.addColorStop(0, css(c));
            grad.addColorStop(1, css(c, 0));
            g.fillStyle = grad;
            g.fillRect(centreX - 1, Math.min(gy0, gy1), 2, Math.abs(gy1 - gy0));
          } else {
            g.fillStyle = css(c);
            g.fillRect(centreX - 1, dir < 0 ? centreY - half : centreY, 2, half);
          }
        }
      }
      g.restore();
    }

    // Centre marker (circle style): back circle 8px in the smallest window's colour, front 4px darkened.
    const markerScale = valueAt(since, 0, 1, 0, 1000, Easing.OutElasticHalf);
    const markerAlpha = valueAt(since, 0, 1, 0, 500, Easing.OutQuint);
    const last = colourForHitResult(this.windows[this.windows.length - 1].result);
    if (markerScale > 0) {
      g.save();
      g.globalAlpha *= markerAlpha;
      g.fillStyle = css(last);
      g.beginPath();
      g.arc(centreX, centreY, 4 * markerScale, 0, Math.PI * 2);
      g.fill();
      g.restore();
    }

    // Judgement lines (additive circles, width relative to 14px, thickness 4).
    g.save();
    g.globalCompositeOperation = 'lighter';
    for (const l of this.lines) {
      const a = this.lineAlpha(l, now);
      const w = this.lineWidth(l, now) * 14;
      if (a <= 0 || w <= 0) continue;
      const ly = colTop + l.y * colH;
      const th = this.judgementLineThickness;
      g.fillStyle = css(l.colour, a);
      g.beginPath();
      rounded(g, centreX - w / 2, ly - th / 2, w, th, th / 2);
      g.fill();
    }
    g.restore();

    // Front centre marker (depth MinValue → above the judgements).
    if (markerScale > 0) {
      g.save();
      g.globalAlpha *= markerAlpha;
      g.fillStyle = css(darken(last, 0.3));
      g.beginPath();
      g.arc(centreX, centreY, 2 * markerScale, 0, Math.PI * 2);
      g.fill();
      g.restore();
    }

    // Labels (hare above, tortoise below), fading in over 500ms; kept upright when mirrored.
    const labelAlpha = Math.min(1, since / 500);
    g.save();
    g.globalAlpha *= labelAlpha;
    g.fillStyle = '#fff';
    drawHare(g, centreX, colTop - 10, mirror);
    drawTortoise(g, centreX, colTop + colH + 10, mirror);
    g.restore();

    // Average chevron: appears after 450ms (fade + x-scale over 250ms OutQuint), moves over 800ms OutQuint.
    const arrowT = since - 450;
    if (arrowT > 0) {
      const s = valueAt(arrowT, 0, 1, 0, 250, Easing.OutQuint);
      g.save();
      g.globalAlpha *= s;
      const ay = colTop + this.arrowY.valueAt(now) * colH;
      // arrowContainer: Anchor CentreLeft, Origin CentreRight, X = 8, width 8 → spans x 0..8, scaled around its right edge.
      g.translate(8, ay);
      g.scale(s, 1);
      g.fillStyle = '#fff';
      drawChevronRight(g, -4, 0, 8);
      g.restore();
    }
    g.restore();
  }
}

/** FontAwesome.Solid.ChevronRight approximation centred at (cx, cy) in a size x size box. */
export function drawChevronRight(g: CanvasRenderingContext2D, cx: number, cy: number, size: number): void {
  const w = size * 0.6;
  const h = size;
  const t = size * 0.32;
  g.beginPath();
  g.moveTo(cx - w / 2, cy - h / 2 + t * 0.4);
  g.lineTo(cx - w / 2 + t * 0.7, cy - h / 2);
  g.lineTo(cx + w / 2, cy);
  g.lineTo(cx - w / 2 + t * 0.7, cy + h / 2);
  g.lineTo(cx - w / 2, cy + h / 2 - t * 0.4);
  g.lineTo(cx + w / 2 - t * 1.1, cy);
  g.closePath();
  g.fill();
}

// OsuIcon.Hare / OsuIcon.Tortoise are osu-resources glyphs; these are simple 14px vector stand-ins.
function drawHare(g: CanvasRenderingContext2D, cx: number, cy: number, mirror: boolean): void {
  g.save();
  g.translate(cx, cy);
  if (mirror) g.scale(-1, 1);
  g.beginPath();
  g.ellipse(-1, 2, 5, 3.5, 0, 0, Math.PI * 2);
  g.ellipse(4, -1, 2.6, 2.4, 0, 0, Math.PI * 2);
  g.ellipse(3.5, -5, 1, 3, -0.3, 0, Math.PI * 2);
  g.ellipse(5.5, -5, 1, 3, 0.3, 0, Math.PI * 2);
  g.fill();
  g.restore();
}

function drawTortoise(g: CanvasRenderingContext2D, cx: number, cy: number, mirror: boolean): void {
  g.save();
  g.translate(cx, cy);
  if (mirror) g.scale(-1, 1);
  g.beginPath();
  g.ellipse(-0.5, 0.5, 5, 4, 0, Math.PI, 0);
  g.rect(-6, 0.5, 11, 1.5);
  g.ellipse(5.5, 0, 1.8, 1.6, 0, 0, Math.PI * 2);
  g.rect(-4.5, 2, 2, 2.5);
  g.rect(2, 2, 2, 2.5);
  g.fill();
  g.restore();
}

/** ColourHitErrorMeter (osu!catch's default layout: 28 judgements, spacing 1.25, square shape). */
export class ColourHitErrorMeter {
  judgementCount = 28;
  judgementSpacing = 1.25;
  shape: 'circle' | 'square' = 'square';
  private readonly shapes: { colour: RGBA; born: number; removedAt?: number }[] = [];

  get height(): number {
    return this.judgementCount * (8 + this.judgementSpacing) - this.judgementSpacing;
  }

  onNewJudgement(type: HitResult, now: number): void {
    this.shapes.push({ colour: colourForHitResult(type), born: now });
    const remaining = this.shapes.filter(s => s.removedAt == null);
    while (remaining.length > this.judgementCount) remaining.shift()!.removedAt = now;
    // Expire shapes whose fade-out has completed.
    for (let i = this.shapes.length - 1; i >= 0; i--) if (this.shapes[i].removedAt != null && now - this.shapes[i].removedAt! > 200) this.shapes.splice(i, 1);
  }

  clear(): void {
    this.shapes.length = 0;
  }

  /** Draw with the flow's top-left at (x, y). Flow order is reversed: newest first (top). */
  draw(g: CanvasRenderingContext2D, x: number, y: number, now: number, mirror: boolean): void {
    g.save();
    g.translate(x, y);
    if (mirror) {
      g.translate(8, 0);
      g.scale(-1, 1);
    }
    const step = 8 + this.judgementSpacing;
    const n = this.shapes.length;
    for (let i = n - 1; i >= 0; i--) {
      const s = this.shapes[i];
      if (s.removedAt != null && now - s.removedAt > 200) continue;
      const index = n - 1 - i;
      const age = now - s.born;
      let alpha = valueAt(age, 0, 1, 0, 200, Easing.OutQuint);
      if (s.removedAt != null) alpha *= valueAt(now - s.removedAt, 1, 0, 0, 200, Easing.OutQuint);
      // content moves from -8 to 0 over 200ms; layout positions transition over 200ms OutQuint (approximated by the content move).
      const dy = valueAt(age, -8, 0, 0, 200, Easing.OutQuint);
      g.fillStyle = css(s.colour, alpha);
      const sy = index * step + dy;
      if (this.shape === 'square') g.fillRect(0, sy, 8, 8);
      else {
        g.beginPath();
        g.arc(4, sy + 4, 4, 0, Math.PI * 2);
        g.fill();
      }
    }
    g.restore();
  }
}

// ------------------------------------------------------------------------------------------------ key counter

class ArgonKeyCounter {
  count = 0;
  active = false;
  readonly indicatorY = new Anim(0);
  readonly indicatorAlpha = new Anim(0.5);
  readonly nameColour = new ColourAnim(OsuColour.Blue0);

  constructor(readonly name: string) {}

  activate(now: number, counting: boolean): void {
    if (counting) this.count++;
    this.active = true;
    this.nameColour.to([1, 1, 1, 1], 10, Easing.OutQuint, now);
    this.indicatorAlpha.to(1, 10, Easing.OutQuint, now);
    this.indicatorY.set(0, now).then(4, 60, Easing.OutQuint);
  }

  deactivate(now: number): void {
    this.active = false;
    this.nameColour.to(OsuColour.Blue0, 200, Easing.OutQuart, now);
    this.indicatorY.to(0, 250, Easing.OutQuart, now);
    this.indicatorAlpha.to(0.5, 250, Easing.OutQuart, now);
  }
}

/** ArgonKeyCounterDisplay: horizontal flow (spacing 2) of 52.5 x 45 counters named B1, B2, ... */
export class ArgonKeyCounterDisplay {
  static readonly SCALE_FACTOR = 1.5;
  static readonly KEY_W = 35 * 1.5;
  static readonly KEY_H = 30 * 1.5;
  readonly counters: ArgonKeyCounter[];
  /** KeyCounterDisplay.Content alpha (FadeTo(visible, 100)). */
  private readonly contentAlpha = new Anim(0);
  private visible = false;
  isCounting = true;

  constructor(actionCount: number) {
    this.counters = Array.from({ length: actionCount }, (_, i) => new ArgonKeyCounter(`B${i + 1}`));
  }

  setVisible(v: boolean, now: number): void {
    if (v === this.visible) return;
    this.visible = v;
    this.contentAlpha.to(v ? 1 : 0, 100, Easing.None, now);
  }

  get width(): number {
    const n = this.counters.length;
    return n === 0 ? 0 : n * ArgonKeyCounterDisplay.KEY_W + (n - 1) * 2;
  }

  activate(i: number, now: number): void {
    this.counters[i]?.activate(now, this.isCounting);
  }

  deactivate(i: number, now: number): void {
    this.counters[i]?.deactivate(now);
  }

  /** Draw with the bottom-right corner at (right, bottom). */
  draw(g: CanvasRenderingContext2D, right: number, bottom: number, now: number): void {
    const a = this.contentAlpha.valueAt(now);
    if (a <= 0) return;
    const W = ArgonKeyCounterDisplay.KEY_W;
    const H = ArgonKeyCounterDisplay.KEY_H;
    let x = right - this.width;
    const y = bottom - H;
    g.save();
    g.globalAlpha *= a;
    for (const c of this.counters) {
      const lineH = 3 * 1.5;
      g.fillStyle = css([1, 1, 1, 1], c.indicatorAlpha.valueAt(now));
      g.beginPath();
      rounded(g, x, y + c.indicatorY.valueAt(now), W, lineH, lineH / 2);
      g.fill();
      const top = y + lineH + 4;
      g.textAlign = 'left';
      g.textBaseline = 'top';
      g.font = `700 ${10 * 1.5}px ${FONT}`;
      g.fillStyle = css(c.nameColour.valueAt(now));
      g.fillText(c.name, x, top);
      g.textBaseline = 'bottom';
      g.font = `700 ${14 * 1.5}px ${FONT}`;
      g.fillStyle = '#fff';
      g.fillText(c.count.toLocaleString('en-US'), x, y + H);
      x += W + 2;
    }
    g.restore();
  }
}

// ------------------------------------------------------------------------------------------------ mod display

/** ModDisplay (HUD instance: ExpansionMode.AlwaysExpanded for 1200ms, then ExpandOnHover) with ModIcons at MOD_ICON_SCALE 0.6. */
export class ModDisplay {
  static readonly ICON = 80 * 0.6;
  private readonly spacing: Anim;
  readonly alpha = new Anim(1);
  private readonly acronyms: { acronym: string; type: ModType; adjusted: boolean }[];
  private expandOnHoverFrom: number;
  private hovered = false;

  constructor(mods: ModSet, now: number) {
    const order: ModType[] = ['reduction', 'increase', 'conversion', 'automation', 'fun'];
    // Mod.AsOrdered(): by type, then acronym.
    this.acronyms = mods.list
      .map(a => ({ acronym: a, type: MOD_BY_ACRONYM.get(a)?.type ?? 'fun', adjusted: Object.keys(mods.settings[a] ?? {}).length > 0 }))
      .sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type) || a.acronym.localeCompare(b.acronym));
    this.spacing = new Anim(5); // updateExpansionMode(0) → expanded
    this.expandOnHoverFrom = now + 1200;
  }

  get isEmpty(): boolean {
    return this.acronyms.length === 0;
  }

  setHovered(h: boolean, now: number): void {
    if (h === this.hovered) return;
    this.hovered = h;
    if (now >= this.expandOnHoverFrom) this.spacing.to(h ? 5 : -25, 500, Easing.OutQuint, now);
  }

  update(now: number): void {
    if (this.expandOnHoverFrom !== Infinity && now >= this.expandOnHoverFrom) {
      this.spacing.to(this.hovered ? 5 : -25, 500, Easing.OutQuint, this.expandOnHoverFrom);
      this.expandOnHoverFrom = Infinity;
    }
  }

  width(now: number): number {
    const n = this.acronyms.length;
    return n === 0 ? 0 : n * ModDisplay.ICON + (n - 1) * this.spacing.valueAt(now);
  }

  /** Draw with the top-right at (right, top). */
  draw(g: CanvasRenderingContext2D, right: number, top: number, now: number): void {
    const a = this.alpha.valueAt(now);
    if (a <= 0 || this.acronyms.length === 0) return;
    const sp = this.spacing.valueAt(now);
    const total = this.width(now);
    g.save();
    g.globalAlpha *= a;
    // ReverseChildIDFillFlowContainer: earlier icons are drawn above later ones.
    for (let i = this.acronyms.length - 1; i >= 0; i--) {
      const x = right - total + i * (ModDisplay.ICON + sp);
      drawModIcon(g, x, top, this.acronyms[i].acronym, this.acronyms[i].type, this.acronyms[i].adjusted, 0.6);
    }
    g.restore();
  }
}

/** ModIcon at the given scale with its top-left at (x, y). The hexagonal "mod-icon" texture is drawn as a path. */
export function drawModIcon(g: CanvasRenderingContext2D, x: number, y: number, acronym: string, type: ModType, adjusted: boolean, scale: number): void {
  const bg = colourForModType(type);
  const size = 80 * scale;
  const cx = x + size / 2;
  const cy = y + size / 2;
  // Hexagon flush area: 131/135 x 92/135 of the square.
  const hw = (size * 131) / 135 / 2;
  const hh = (size * 92) / 135 / 2;
  g.beginPath();
  g.moveTo(cx - hw, cy);
  g.lineTo(cx - hw * 0.55, cy - hh);
  g.lineTo(cx + hw * 0.55, cy - hh);
  g.lineTo(cx + hw, cy);
  g.lineTo(cx + hw * 0.55, cy + hh);
  g.lineTo(cx - hw * 0.55, cy + hh);
  g.closePath();
  g.fillStyle = css(bg);
  g.fill();
  const fg: RGBA = [bg[0] * 0.1, bg[1] * 0.1, bg[2] * 0.1, 1];
  g.fillStyle = css(fg);
  g.font = `900 ${22 * scale}px ${FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(acronym, cx, cy + 1);
  if (adjusted) {
    // adjustment marker: circle at (64, 14), size 20.
    g.beginPath();
    g.arc(x + 64 * scale, y + 14 * scale, 10 * scale, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = css(bg);
    g.lineWidth = 2 * scale;
    g.beginPath();
    g.arc(x + 64 * scale, y + 14 * scale, 4 * scale, 0, Math.PI * 2);
    g.stroke();
  }
}

// ------------------------------------------------------------------------------------------------ failing layer

/** FailingLayer: red additive gradients on both sides (20% width each), alpha up to 0.4 below 20% health. */
export class FailingLayer {
  private boxesAlpha = 0;
  readonly alpha = new Anim(0);
  private shown: boolean | null = null;

  setShown(show: boolean, now: number): void {
    if (show === this.shown) return;
    this.shown = show;
    this.alpha.to(show ? 1 : 0, 400, Easing.OutQuint, now);
  }

  update(health: number, elapsed: number): void {
    const target = Math.max(0, Math.min(0.4, 0.4 * (1 - health / 0.2)));
    this.boxesAlpha = lerp(this.boxesAlpha, target, Math.min(1, elapsed * 0.01));
  }

  draw(g: CanvasRenderingContext2D, w: number, h: number, now: number): void {
    const a = this.alpha.valueAt(now) * this.boxesAlpha;
    if (a <= 0.002) return;
    const gw = w * 0.2;
    g.save();
    g.globalCompositeOperation = 'lighter';
    const red = OsuColour.Red;
    let grad = g.createLinearGradient(0, 0, gw, 0);
    grad.addColorStop(0, css(red, a));
    grad.addColorStop(1, css(red, 0));
    g.fillStyle = grad;
    g.fillRect(0, 0, gw, h);
    grad = g.createLinearGradient(w - gw, 0, w, 0);
    grad.addColorStop(0, css(red, 0));
    grad.addColorStop(1, css(red, a));
    g.fillStyle = grad;
    g.fillRect(w - gw, 0, gw, h);
    g.restore();
  }
}

