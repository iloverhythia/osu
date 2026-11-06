// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Canvas helpers shared by the Argon skin ports of osu!taiko, osu!catch and osu!mania.
//  - FontAwesome glyphs drawn like osu-framework's SpriteIcon (the glyph's bounds fitted into the icon box, FillMode.Fit).
//  - EdgeEffectType.Glow drawn like osu-framework's masking shader (linear fade over the radius, AlphaExponent 2).
//  - Circle / CircularContainer borders as filled annuli.

export type RGB = readonly [number, number, number];

export const css = (c: RGB, a = 1): string => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** A FontAwesome (Free 5, solid) glyph: SVG path data + its tight bounds in glyph units. */
export interface Glyph {
  readonly d: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

// FontAwesome Free 5 (Font: SIL OFL 1.1, Icons: CC BY 4.0) glyph outlines.
export const FA_ANGLE_LEFT: Glyph = {
  d: 'M31.7 239l136-136c9.4-9.4 24.6-9.4 33.9 0l22.6 22.6c9.4 9.4 9.4 24.6 0 33.9L127.9 256l96.4 96.4c9.4 9.4 9.4 24.6 0 33.9L201.7 409c-9.4 9.4-24.6 9.4-33.9 0l-136-136c-9.5-9.4-9.5-24.6-.1-34z',
  x: 24.7,
  y: 96,
  w: 206.5,
  h: 320,
};

export const FA_ASTERISK: Glyph = {
  d: 'M478.21 334.093L336 256l142.21-78.093c11.795-6.477 15.961-21.384 9.232-33.037l-19.48-33.741c-6.728-11.653-21.72-15.499-33.227-8.523L296 186.718l3.475-162.204C299.763 11.061 288.937 0 275.48 0h-38.96c-13.456 0-24.283 11.061-23.994 24.514L216 186.718 77.265 102.607c-11.506-6.976-26.499-3.13-33.227 8.523l-19.48 33.741c-6.728 11.653-2.562 26.56 9.233 33.037L176 256 33.79 334.093c-11.795 6.477-15.961 21.384-9.232 33.037l19.48 33.741c6.728 11.653 21.721 15.499 33.227 8.523L216 325.282l-3.475 162.204C212.237 500.939 223.064 512 236.52 512h38.961c13.456 0 24.283-11.061 23.995-24.514L296 325.282l138.735 84.111c11.506 6.976 26.499 3.13 33.227-8.523l19.48-33.741c6.728-11.653 2.563-26.559-9.232-33.036z',
  x: 22.3,
  y: 0,
  w: 467.4,
  h: 512,
};

export const FA_ANGLE_DOWN: Glyph = {
  d: 'M143 352.3L7 216.3c-9.4-9.4-9.4-24.6 0-33.9l22.6-22.6c9.4-9.4 24.6-9.4 33.9 0l96.4 96.4 96.4-96.4c9.4-9.4 24.6-9.4 33.9 0l22.6 22.6c9.4 9.4 9.4 24.6 0 33.9l-136 136c-9.2 9.4-24.4 9.4-33.8 0z',
  x: 0,
  y: 152.8,
  w: 320,
  h: 206.6,
};

const glyphPaths = new Map<Glyph, Path2D | null>();

function glyphPath(g: Glyph): Path2D | null {
  let p = glyphPaths.get(g);
  if (p === undefined) {
    p = typeof Path2D !== 'undefined' ? new Path2D(g.d) : null;
    glyphPaths.set(g, p);
  }
  return p;
}

/**
 * SpriteIcon: the glyph is fitted (preserving its aspect ratio) into a `size` x `size` box centred at (cx, cy),
 * then scaled by (scaleX, scaleY) and rotated (degrees) around the centre. Uses the current fillStyle / globalAlpha.
 */
export function drawIcon(
  ctx: CanvasRenderingContext2D,
  g: Glyph,
  cx: number,
  cy: number,
  size: number,
  scaleX = 1,
  scaleY = 1,
  rotation = 0,
  boxH = size,
): void {
  const p = glyphPath(g);
  if (!p || size <= 0) return;
  const fit = Math.min(size / g.w, boxH / g.h);
  ctx.save();
  ctx.translate(cx, cy);
  if (rotation !== 0) ctx.rotate((rotation * Math.PI) / 180);
  ctx.scale(scaleX * fit, scaleY * fit);
  ctx.translate(-(g.x + g.w / 2), -(g.y + g.h / 2));
  ctx.fill(p);
  ctx.restore();
}

/**
 * EdgeEffectType.Glow around a circle of radius `r`: the masking shader fades linearly from the shape to `r + radius`
 * and raises the result to AlphaExponent = 2.
 */
export function drawCircleGlow(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, radius: number, colour: RGB, alpha: number): void {
  if (alpha <= 0.001 || radius <= 0) return;
  const outerR = r + radius;
  const sprite = glowSprite(ctx, `c|${q(r)}|${q(radius)}|${colour.join(',')}`, outerR * 2, outerR * 2, g => drawCircleGlowDirect(g, outerR, outerR, r, radius, colour, 1));
  stamp(ctx, sprite, cx - outerR, cy - outerR, outerR * 2, outerR * 2, alpha);
}

function drawCircleGlowDirect(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, radius: number, colour: RGB, alpha: number): void {
  const outer = r + radius;
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, outer);
  const inner = Math.max(0, r) / outer;
  g.addColorStop(0, css(colour, alpha));
  if (inner > 0) g.addColorStop(inner, css(colour, alpha));
  const steps = 6;
  for (let i = 1; i <= steps; i++) {
    const f = i / steps;
    g.addColorStop(inner + (1 - inner) * f, css(colour, alpha * (1 - f) * (1 - f)));
  }
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, outer, 0, Math.PI * 2);
  ctx.fill();
}

/** Adds a rounded rectangle to the current path. */
export function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number, ccw = false): void {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  if (!ccw) {
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
  } else {
    ctx.moveTo(x + r, y);
    ctx.arcTo(x, y, x, y + r, r);
    ctx.lineTo(x, y + h - r);
    ctx.arcTo(x, y + h, x + r, y + h, r);
    ctx.lineTo(x + w - r, y + h);
    ctx.arcTo(x + w, y + h, x + w, y + h - r, r);
    ctx.lineTo(x + w, y + r);
    ctx.arcTo(x + w, y, x + w - r, y, r);
  }
  ctx.closePath();
}

/**
 * EdgeEffectType.Glow around a rounded rectangle (corner radius `cr`): approximated with concentric rounded-rect strokes
 * following the masking shader's falloff ((1 - d / radius)^2).
 */
export function drawRoundRectGlow(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  cr: number,
  radius: number,
  colour: RGB,
  alpha: number,
): void {
  if (alpha <= 0.001 || radius <= 0) return;
  // Pre-rendered once per (size, radius, colour) and stamped with globalAlpha: the glow's alpha is linear in `alpha`,
  // so this matches drawing it directly, but costs one drawImage instead of up to 16 stroke passes per frame.
  const pad = radius + 1;
  const sw = w + pad * 2;
  const sh = h + pad * 2;
  const sprite = glowSprite(ctx, `r|${q(w)}|${q(h)}|${q(cr)}|${q(radius)}|${colour.join(',')}`, sw, sh, g =>
    drawRoundRectGlowDirect(g, pad, pad, w, h, cr, radius, colour, 1),
  );
  stamp(ctx, sprite, x - pad, y - pad, sw, sh, alpha);
}

function drawRoundRectGlowDirect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, cr: number, radius: number, colour: RGB, alpha: number): void {
  const steps = Math.max(4, Math.min(16, Math.ceil(radius / 2)));
  const step = radius / steps;
  ctx.save();
  ctx.lineWidth = step + 0.5;
  for (let i = 0; i < steps; i++) {
    const d = (i + 0.5) * step;
    const f = 1 - d / radius;
    ctx.strokeStyle = css(colour, alpha * f * f);
    ctx.beginPath();
    roundRectPath(ctx, x - d, y - d, w + 2 * d, h + 2 * d, cr + d);
    ctx.stroke();
  }
  ctx.fillStyle = css(colour, alpha);
  ctx.beginPath();
  roundRectPath(ctx, x, y, w, h, cr);
  ctx.fill();
  ctx.restore();
}

/** A border of `thickness` inside a pill / circle (CircularContainer with BorderThickness), filled with the current fillStyle. */
export function fillPillBorder(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, thickness: number): void {
  const r = Math.min(w, h) / 2;
  ctx.beginPath();
  roundRectPath(ctx, x, y, w, h, r);
  const t = Math.min(thickness, r);
  if (t < r) roundRectPath(ctx, x + t, y + t, w - 2 * t, h - 2 * t, r - t, true);
  ctx.fill('evenodd');
}

/** Fills a circle with the current fillStyle. */
export function fillCircle(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
  if (r <= 0) return;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
}

/** Mulberry32: a small deterministic PRNG so that replays / seeking produce the same "random" visuals. */
export function seededRandom(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * SpriteText with Spacing.X: glyphs are laid out with `spacing` between each pair, and the line is centred on `x`
 * (Anchor/Origin Centre). Uses the current font / fillStyle; textBaseline should be 'middle'.
 */
export function drawSpacedText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, spacing: number): void {
  if (spacing === 0) {
    const prevAlign = ctx.textAlign;
    ctx.textAlign = 'center';
    ctx.fillText(text, x, y);
    ctx.textAlign = prevAlign;
    return;
  }
  const prevAlign = ctx.textAlign;
  ctx.textAlign = 'left';
  let total = spacing * (text.length - 1);
  const widths: number[] = [];
  for (const ch of text) {
    const w = ctx.measureText(ch).width;
    widths.push(w);
    total += w;
  }
  let cx = x - total / 2;
  let i = 0;
  for (const ch of text) {
    ctx.fillText(ch, cx, y);
    cx += widths[i++] + spacing;
  }
  ctx.textAlign = prevAlign;
}

// ---------------------------------------------------------------- glow sprite cache

/** Quantise sizes so animated radii reuse a handful of sprites (0.5 css px steps). */
const q = (v: number) => Math.round(v * 2) / 2;

interface Sprite {
  canvas: HTMLCanvasElement;
  /** Device pixels per css pixel the sprite was rendered at. */
  scale: number;
}

const sprites = new Map<string, Sprite>();
const MAX_SPRITES = 256;

function glowSprite(ctx: CanvasRenderingContext2D, key: string, w: number, h: number, draw: (g: CanvasRenderingContext2D) => void): Sprite {
  const t = ctx.getTransform();
  // Render at the current device scale (quantised) so stamped glows stay sharp.
  const scale = Math.max(0.25, Math.round(Math.hypot(t.a, t.b) * 4) / 4);
  const fullKey = `${key}|${scale}`;
  let s = sprites.get(fullKey);
  if (s) {
    // LRU: move to the end.
    sprites.delete(fullKey);
    sprites.set(fullKey, s);
    return s;
  }
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w * scale));
  c.height = Math.max(1, Math.ceil(h * scale));
  const g = c.getContext('2d')!;
  g.scale(scale, scale);
  draw(g);
  s = { canvas: c, scale };
  sprites.set(fullKey, s);
  if (sprites.size > MAX_SPRITES) sprites.delete(sprites.keys().next().value!);
  return s;
}

function stamp(ctx: CanvasRenderingContext2D, s: Sprite, x: number, y: number, w: number, h: number, alpha: number): void {
  const prev = ctx.globalAlpha;
  ctx.globalAlpha = prev * Math.min(1, alpha);
  ctx.drawImage(s.canvas, x, y, s.canvas.width / s.scale, s.canvas.height / s.scale);
  ctx.globalAlpha = prev;
  void w;
  void h;
}
