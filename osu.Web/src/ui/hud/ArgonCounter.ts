// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game/Screens/Play/HUD/ArgonCounterTextComponent.cs and the Argon counters built on it:
// ArgonScoreCounter.cs, ArgonAccuracyCounter.cs, ArgonComboCounter.cs (+ RollingCounter / ScoreCounter / PercentageCounter rolling).
//
// The "argon-counter" font is a texture font from osu-resources (not redistributable), so the glyphs are drawn procedurally as a
// segmented display: lit segments for the text and outlined segments for the "wireframe" template behind it. Glyph boxes are
// 20x32 (digits, '%', 'x') and 8x32 ('.'), with the font's -2 spacing; the 32px height matches the layout maths in
// ArgonAccuracyCounter (fraction margin 12 * 2 + 4 at half scale).

import { Anim, ColourAnim, Easing, FONT, OsuColour, css, type RGBA } from './anim';

export const GLYPH_HEIGHT = 32;
const DIGIT_WIDTH = 20;
const DOT_WIDTH = 8;
const SPACING = -2;

const glyphWidth = (c: string): number => (c === '.' ? DOT_WIDTH : DIGIT_WIDTH);

export function measureGlyphs(text: string): number {
  if (text.length === 0) return 0;
  let w = 0;
  for (const c of text) w += glyphWidth(c);
  return w + SPACING * (text.length - 1);
}

// Segment layout inside a 20x32 glyph box.
const L = 3.5;
const R = 16.5;
const T = 5;
const M = 17.5;
const B = 30;
const TH = 3;
const GAP = 0.7;

type Seg = [number, number, number, number, boolean]; // x1,y1,x2,y2,horizontal
const SEGMENTS: Record<string, Seg> = {
  a: [L, T, R, T, true],
  b: [R, T, R, M, false],
  c: [R, M, R, B, false],
  d: [L, B, R, B, true],
  e: [L, M, L, B, false],
  f: [L, T, L, M, false],
  g: [L, M, R, M, true],
};
const DIGITS: Record<string, string> = {
  '0': 'abcdef',
  '1': 'bc',
  '2': 'abged',
  '3': 'abgcd',
  '4': 'fgbc',
  '5': 'afgcd',
  '6': 'afgedc',
  '7': 'abc',
  '8': 'abcdefg',
  '9': 'abcdfg',
};

function segPath(g: CanvasRenderingContext2D, x: number, y: number, s: Seg): void {
  const [x1, y1, x2, y2, horizontal] = s;
  const h = TH / 2;
  if (horizontal) {
    const a = x + x1 + GAP;
    const b = x + x2 - GAP;
    const cy = y + y1;
    g.moveTo(a, cy);
    g.lineTo(a + h, cy - h);
    g.lineTo(b - h, cy - h);
    g.lineTo(b, cy);
    g.lineTo(b - h, cy + h);
    g.lineTo(a + h, cy + h);
  } else {
    const a = y + y1 + GAP;
    const b = y + y2 - GAP;
    const cx = x + x1;
    g.moveTo(cx, a);
    g.lineTo(cx + h, a + h);
    g.lineTo(cx + h, b - h);
    g.lineTo(cx, b);
    g.lineTo(cx - h, b - h);
    g.lineTo(cx - h, a + h);
  }
  g.closePath();
}

function glyphPath(g: CanvasRenderingContext2D, c: string, x: number, y: number, wireframe: boolean): void {
  if (c === '.') {
    g.rect(x + 2, y + B - TH, TH + 1, TH + 1);
    return;
  }
  if (wireframe) {
    for (const s of Object.values(SEGMENTS)) segPath(g, x, y, s);
    return;
  }
  const lit = DIGITS[c];
  if (lit) {
    for (const k of lit) segPath(g, x, y, SEGMENTS[k]);
    return;
  }
  if (c === '%') {
    g.rect(x + L - 1, y + T, 4.5, 4.5);
    g.rect(x + R - 3.5, y + B - 4.5, 4.5, 4.5);
    g.moveTo(x + R - 1, y + T);
    g.lineTo(x + R + 1.5, y + T);
    g.lineTo(x + L + 1, y + B);
    g.lineTo(x + L - 1.5, y + B);
    g.closePath();
    return;
  }
  if (c === 'x') {
    const top = y + M - 5;
    const bot = y + B;
    g.moveTo(x + L, top);
    g.lineTo(x + L + 3, top);
    g.lineTo(x + R, bot);
    g.lineTo(x + R - 3, bot);
    g.closePath();
    g.moveTo(x + R, top);
    g.lineTo(x + R - 3, top);
    g.lineTo(x + L, bot);
    g.lineTo(x + L + 3, bot);
    g.closePath();
  }
}

function drawGlyphRun(g: CanvasRenderingContext2D, text: string, right: number, y: number, wireframe: boolean): void {
  let x = right - measureGlyphs(text);
  g.beginPath();
  for (const c of text) {
    glyphPath(g, c, x, y, wireframe && c !== '.');
    x += glyphWidth(c) + SPACING;
  }
  if (wireframe) g.stroke();
  else g.fill();
}

export interface ArgonTextOptions {
  text: string;
  wireframeTemplate: string;
  wireframeOpacity: number;
  /** Label (upper-cased) shown above the digits when set. */
  label?: string;
  colour?: RGBA;
  labelColour?: RGBA;
  /** NumberContainer scale (combo counter bump), applied around the number container's anchor. */
  numberScale?: number;
  anchorRight: boolean;
}

/** Size of an ArgonCounterTextComponent (AutoSizeAxes.Both). */
export function measureArgonText(g: CanvasRenderingContext2D, o: ArgonTextOptions): { width: number; height: number; numberWidth: number } {
  const numberWidth = Math.max(measureGlyphs(o.text), measureGlyphs(o.wireframeTemplate));
  let width = numberWidth;
  if (o.label) {
    g.font = `700 12px ${FONT}`;
    width = Math.max(width, 2.5 + g.measureText(o.label).width);
  }
  return { width, height: (o.label ? 12 : 0) + GLYPH_HEIGHT, numberWidth };
}

/** Draws an ArgonCounterTextComponent with its top-left at (x, y). */
export function drawArgonText(g: CanvasRenderingContext2D, x: number, y: number, o: ArgonTextOptions, size = measureArgonText(g, o)): void {
  const colour = o.colour ?? [1, 1, 1, 1];
  if (o.label) {
    g.font = `700 12px ${FONT}`;
    g.textBaseline = 'top';
    g.textAlign = 'left';
    g.fillStyle = css(o.labelColour ?? OsuColour.Blue0);
    g.fillText(o.label, x + 2.5, y);
  }
  const ny = y + (o.label ? 12 : 0);
  // NumberContainer is placed at the component's anchor (TopLeft / TopRight) and scales around it.
  const nx = o.anchorRight ? x + size.width - size.numberWidth : x;
  const s = o.numberScale ?? 1;
  g.save();
  const ox = o.anchorRight ? nx + size.numberWidth : nx;
  g.translate(ox, ny);
  g.scale(s, s);
  g.translate(-ox, -ny);
  const right = nx + size.numberWidth;
  if (o.wireframeOpacity > 0) {
    g.strokeStyle = css(colour, o.wireframeOpacity * 0.8);
    g.lineWidth = 0.8;
    drawGlyphRun(g, o.wireframeTemplate, right, ny, true);
  }
  g.fillStyle = css(colour);
  drawGlyphRun(g, o.text, right, ny, false);
  g.restore();
}

/** RollingCounter<T>.TransformCount: TransformTo(DisplayedCount, value, duration, easing), in real time. */
export class RollingValue {
  private readonly anim: Anim;
  private target: number;

  constructor(
    initial: number,
    private readonly duration: number,
    private readonly easing: Easing,
  ) {
    this.anim = new Anim(initial);
    this.target = initial;
  }

  set(value: number, now: number): void {
    if (value === this.target) return;
    this.target = value;
    this.anim.to(value, this.duration, this.easing, now);
  }

  get current(): number {
    return this.target;
  }

  displayed(now: number): number {
    return this.anim.valueAt(now);
  }
}

/** PercentageCounter.FormatCount → FormatUtils.FormatAccuracy: floor to 4 decimal digits, "0.00%". */
export function formatAccuracy(accuracy: number): string {
  const floored = Math.floor(accuracy * 10000 + 1e-9) / 10000;
  return `${(floored * 100).toFixed(2)}%`;
}

/** ArgonScoreCounter (ShowLabel = false in the default layout, RequiredDisplayDigits 6 for standardised scoring). */
export class ArgonScoreCounter {
  readonly rolling = new RollingValue(0, 250, Easing.Out);
  wireframeOpacity = 0.25;
  showLabel = false;
  requiredDisplayDigits = 6;

  options(now: number): ArgonTextOptions {
    const count = Math.round(this.rolling.displayed(now));
    const digits = Math.max(this.requiredDisplayDigits, String(count).length);
    return { text: String(count), wireframeTemplate: '#'.repeat(digits), wireframeOpacity: this.wireframeOpacity, label: this.showLabel ? 'SCORE' : undefined, anchorRight: true };
  }
}

/** ArgonAccuracyCounter (+ ArgonAccuracyTextComponent layout). */
export class ArgonAccuracyCounter {
  // PercentageCounter starts at 100%.
  readonly rolling = new RollingValue(1, 250, Easing.OutQuad);
  wireframeOpacity = 0.25;
  showLabel = true;

  private parts(now: number) {
    const text = formatAccuracy(this.rolling.displayed(now)).replace('%', '');
    const [whole, fraction] = text.split('.');
    const label = this.showLabel ? 'ACCURACY' : undefined;
    const wholeO: ArgonTextOptions = { text: whole, wireframeTemplate: '###', wireframeOpacity: this.wireframeOpacity, label, anchorRight: true };
    const fracO: ArgonTextOptions = { text: `.${fraction}`, wireframeTemplate: '.##', wireframeOpacity: this.wireframeOpacity, anchorRight: false };
    const pctO: ArgonTextOptions = { text: '%', wireframeTemplate: '#', wireframeOpacity: this.wireframeOpacity, anchorRight: false };
    return { wholeO, fracO, pctO };
  }

  measure(g: CanvasRenderingContext2D, now: number): { width: number; height: number } {
    const { wholeO, fracO, pctO } = this.parts(now);
    const w = measureArgonText(g, wholeO);
    const f = measureArgonText(g, fracO);
    const p = measureArgonText(g, pctO);
    const fracTop = this.showLabel ? 12 * 2 + 4 : 4;
    const pctTop = this.showLabel ? 12 : 0;
    return { width: w.width + f.width * 0.5 + p.width, height: Math.max(w.height, fracTop + f.height * 0.5, pctTop + p.height) };
  }

  draw(g: CanvasRenderingContext2D, x: number, y: number, now: number): void {
    const { wholeO, fracO, pctO } = this.parts(now);
    const w = measureArgonText(g, wholeO);
    drawArgonText(g, x, y, wholeO, w);
    x += w.width;
    const f = measureArgonText(g, fracO);
    g.save();
    const fy = y + (this.showLabel ? 12 * 2 + 4 : 4);
    g.translate(x, fy);
    g.scale(0.5, 0.5);
    drawArgonText(g, 0, 0, fracO, f);
    g.restore();
    x += f.width * 0.5;
    drawArgonText(g, x, y + (this.showLabel ? 12 : 0), pctO);
  }
}

/** ArgonComboCounter: rolling count, wireframe sized to the digits + "x", and the increase / break transforms. */
export class ArgonComboCounter {
  // ComboCounter keeps RollingCounter's OutQuad easing; IsRollingProportional is false.
  readonly rolling = new RollingValue(0, 250, Easing.OutQuad);
  wireframeOpacity = 0.25;
  showLabel = true;
  private readonly numberScale = new Anim(1);
  private readonly colour = new ColourAnim([1, 1, 1, 1]);

  /** Current.BindValueChanged handler. */
  onComboChanged(oldValue: number, newValue: number, now: number): void {
    if (oldValue === newValue) return;
    this.rolling.set(newValue, now);
    const wasIncrease = newValue > oldValue;
    const wasMiss = oldValue > 1 && newValue === 0;
    const newScale = Math.min(1.4, Math.max(0.6, this.numberScale.valueAt(now) * (wasIncrease ? 1.1 : 0.8)));
    const duration = wasMiss ? 2000 : 500;
    this.numberScale.set(newScale, now).then(1, duration, Easing.OutQuint);
    // FlashColour(Red, duration, OutQuint): jump to red, then back to the original colour.
    if (wasMiss) this.colour.set([1, 0, 0, 1], now).then([1, 1, 1, 1], duration, Easing.OutQuint);
  }

  options(now: number): ArgonTextOptions {
    const count = Math.round(this.rolling.displayed(now));
    const colour = this.colour.valueAt(now);
    return {
      text: `${count}x`,
      // one for the single presumed starting digit, one for the "x" at the end.
      wireframeTemplate: '#'.repeat(1 + String(count).length),
      wireframeOpacity: this.wireframeOpacity,
      label: this.showLabel ? 'COMBO' : undefined,
      colour,
      labelColour: mul(OsuColour.Blue0, colour),
      numberScale: this.numberScale.valueAt(now),
      anchorRight: false,
    };
  }
}

const mul = (a: RGBA, b: RGBA): RGBA => [a[0] * b[0], a[1] * b[1], a[2] * b[2], a[3] * b[3]];
