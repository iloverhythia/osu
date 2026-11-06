// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Procedural drawing of the default (Argon) osu!catch skin pieces. Ports:
//  - osu.Game.Rulesets.Catch/Skinning/Argon/ArgonFruitPiece.cs, ArgonDropletPiece.cs, ArgonBananaPiece.cs
//  - osu.Game.Rulesets.Catch/Skinning/Argon/ArgonCatcher.cs, ArgonHitExplosion.cs
// No textures are used. osu-framework's CircularBlob (a seeded noise shader) is approximated with seeded wobbly rings;
// EdgeEffect glows follow the masking shader's falloff (see ../taiko/argonDraw.ts).

import type { RGB } from '../../Skin';
import { Easing, applyEasing } from '../../storyboard/Easing';
import { drawRoundRectGlow, roundRectPath } from '../taiko/argonDraw';

const DEG = Math.PI / 180;
const TWO_PI = Math.PI * 2;
const BLOB_POINTS = 64;
/** CircularBlob defaults (osu-framework): Frequency 1.5, Amplitude 0.3. */
const BLOB_AMPLITUDE = 0.3;

/** Catcher.DEFAULT_HYPER_DASH_COLOUR (Color4.Red) */
export const HYPER_DASH_COLOUR: RGB = [255, 0, 0];
/** Catcher.ALLOWED_CATCH_RANGE */
const ALLOWED_CATCH_RANGE = 0.8;

const ringCache = new Map<string, Path2D>();

/** Deterministic small PRNG for blob shapes. */
function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BLOB_TEMPLATES = 16;

/**
 * A unit-radius CircularBlob ring: the outer edge is pushed in by up to Amplitude by low-frequency angular noise,
 * and InnerRadius is the ring's thickness relative to the (noisy) radius (1 = filled). Fill with evenodd.
 */
function blobRing(template: number, innerRadius: number): Path2D {
  const key = `${template}:${innerRadius}`;
  let p = ringCache.get(key);
  if (p) return p;

  const rnd = mulberry(template * 7919 + 17);
  const harmonics = [
    { k: 1, a: 0.55, ph: rnd() * TWO_PI },
    { k: 2, a: 0.3, ph: rnd() * TWO_PI },
    { k: 3, a: 0.15, ph: rnd() * TWO_PI },
  ];
  const radiusAt = (theta: number) => {
    let n = 0;
    for (const h of harmonics) n += h.a * Math.sin(h.k * theta + h.ph);
    // noise in [0, 1]
    return 1 - BLOB_AMPLITUDE * (0.5 + 0.5 * n);
  };

  p = new Path2D();
  const inner = Math.max(0, 1 - innerRadius);
  for (let i = 0; i <= BLOB_POINTS; i++) {
    const th = (i / BLOB_POINTS) * TWO_PI;
    const r = radiusAt(th);
    if (i === 0) p.moveTo(Math.cos(th) * r, Math.sin(th) * r);
    else p.lineTo(Math.cos(th) * r, Math.sin(th) * r);
  }
  p.closePath();
  if (inner > 0) {
    for (let i = BLOB_POINTS; i >= 0; i--) {
      const th = (i / BLOB_POINTS) * TWO_PI;
      const r = radiusAt(th) * inner;
      if (i === BLOB_POINTS) p.moveTo(Math.cos(th) * r, Math.sin(th) * r);
      else p.lineTo(Math.cos(th) * r, Math.sin(th) * r);
    }
    p.closePath();
  }
  ringCache.set(key, p);
  return p;
}

const rgba = (c: RGB, a: number): string => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
const mul = (a: RGB, b: RGB): RGB => [(a[0] * b[0]) / 255, (a[1] * b[1]) / 255, (a[2] * b[2]) / 255];
const WHITE: RGB = [255, 255, 255];

/** Draws an additive CircularBlob of the given radius (half its draw size) and rotation. */
function fillBlob(g: CanvasRenderingContext2D, template: number, inner: number, radius: number, rotationDeg: number, colour: string): void {
  g.save();
  g.rotate(rotationDeg * DEG);
  g.scale(radius, radius);
  g.fillStyle = colour;
  g.fill(blobRing(template % BLOB_TEMPLATES, inner), 'evenodd');
  g.restore();
}

export interface PieceParams {
  /** Centre in canvas pixels. */
  x: number;
  y: number;
  /** Radius of the piece (OBJECT_RADIUS * display scale) in pixels. */
  radius: number;
  /** Rotation of the whole piece (ScalingContainer.Rotation) in degrees. */
  rotation: number;
  /** AccentColour (combo colour / banana colour). */
  colour: RGB;
  hyper: boolean;
  alpha: number;
  /** Seed choosing the blob shapes (stands in for RNG.Next() blob seeds). */
  seed: number;
  /** Time-driven layer rotation (degrees). */
  layerRotation: number;
  /** Colour multiplied into everything (the Catcher's colour for caught objects; white otherwise). */
  tint?: RGB;
}

function fruitLayers(g: CanvasRenderingContext2D, p: PieceParams): void {
  const tint = p.tint ?? WHITE;
  const accent = mul(p.colour, tint);
  const t0 = p.seed >>> 0;
  // new Circle { Size = 20 } (white, below the additive layers)
  g.fillStyle = rgba(tint, 1);
  g.beginPath();
  g.arc(0, 0, p.radius * (10 / 64), 0, TWO_PI);
  g.fill();

  g.globalCompositeOperation = 'lighter';
  // Layers are ordered from largest to smallest. Layer i rotates by i * 2 * elapsed * 0.02 * randomness, alternating direction.
  fillBlob(g, t0, 0.5, p.radius * 1.1, 0, rgba(accent, 0.15));
  fillBlob(g, t0 + 5, 0.2, p.radius, p.layerRotation * 2, rgba(accent, 0.5));
  fillBlob(g, t0 + 11, 0.05, p.radius, -p.layerRotation * 4, rgba(accent, 1));
  // hyperBorderPiece: Catcher.DEFAULT_HYPER_DASH_COLOUR, InnerRadius 0.08, Size 1.15, same seed as the large blob
  if (p.hyper) fillBlob(g, t0, 0.08, p.radius * 1.15, 0, rgba(mul(HYPER_DASH_COLOUR, tint), 1));
  g.globalCompositeOperation = 'source-over';
}

/** ArgonFruitPiece */
export function drawFruit(g: CanvasRenderingContext2D, p: PieceParams): void {
  if (p.alpha <= 0) return;
  g.save();
  g.translate(p.x, p.y);
  g.rotate(p.rotation * DEG);
  g.globalAlpha *= p.alpha;
  fruitLayers(g, p);
  g.restore();
}

/** ArgonDropletPiece (`coreRadius` is the 20 unit white circle, in pixels). */
export function drawDroplet(g: CanvasRenderingContext2D, p: PieceParams, coreRadius: number): void {
  if (p.alpha <= 0) return;
  const tint = p.tint ?? WHITE;
  const accent = mul(p.colour, tint);
  const t0 = p.seed >>> 0;
  const r = p.radius * 0.7; // droplet_scale_down
  g.save();
  g.translate(p.x, p.y);
  g.rotate(p.rotation * DEG);
  g.globalAlpha *= p.alpha;

  g.fillStyle = rgba(tint, 1);
  g.beginPath();
  g.arc(0, 0, coreRadius, 0, TWO_PI);
  g.fill();

  g.globalCompositeOperation = 'lighter';
  // layers[i].Rotation -= elapsed * 0.4 * randomness * (i % 2 == 1 ? 0.5 : 1)
  fillBlob(g, t0, 0.5, r, p.layerRotation, rgba(accent, 0.15));
  fillBlob(g, t0 + 5, 0.4, r * 0.7, p.layerRotation * 0.5, rgba(accent, 0.5));
  // hyperBorderPiece: Scale 0.7, InnerRadius 0.5; CatchHitObjectPiece sets its Alpha to 1 while HyperDash.
  if (p.hyper) fillBlob(g, t0, 0.5, r, 0, rgba(mul(HYPER_DASH_COLOUR, tint), 1));
  g.globalCompositeOperation = 'source-over';
  g.restore();
}

/**
 * ArgonBananaPiece: an ArgonFruitPiece plus the "lens flare" content (fadeContent), which fades out between 30% and 80%
 * of the time on screen (`flareAlpha`). The flare is kept horizontal (stabilisedPieceContainer.Rotation = -DisplayRotation)
 * and partially un-scaled horizontally.
 */
export function drawBanana(g: CanvasRenderingContext2D, p: PieceParams, flareAlpha: number, displayScale: number): void {
  if (p.alpha <= 0) return;
  const tint = p.tint ?? WHITE;
  // piece units -> px
  const u = p.radius / 64;
  g.save();
  g.translate(p.x, p.y);
  g.rotate(p.rotation * DEG);
  g.globalAlpha *= p.alpha;
  fruitLayers(g, p);

  if (flareAlpha > 0.001) {
    const base = g.globalAlpha;
    g.globalAlpha = base * flareAlpha;
    g.save();
    // stabilisedPieceContainer
    g.rotate(-p.rotation * DEG);
    const s = 0.4 + (1 - 0.4) * (1 / Math.max(1e-6, displayScale));
    g.scale(s, 1);
    g.globalCompositeOperation = 'lighter';
    // Circle 8x8 scaled (25, 1), white @ 0.4
    g.fillStyle = rgba(tint, 0.4);
    g.beginPath();
    g.ellipse(0, 0, 100 * u, 4 * u, 0, 0, TWO_PI);
    g.fill();
    // Box: Origin CentreRight, Width 1.6 (of 128), Height 2, gradient transparent -> white @ 0.8
    const w = 1.6 * 128 * u;
    const left = g.createLinearGradient(-w, 0, 0, 0);
    left.addColorStop(0, rgba(tint, 0));
    left.addColorStop(1, rgba(tint, 0.8));
    g.fillStyle = left;
    g.fillRect(-w, -u, w, 2 * u);
    // Circle: Origin CentreLeft, Width 1.6, Height 2, gradient white @ 0.8 -> transparent
    const right = g.createLinearGradient(0, 0, w, 0);
    right.addColorStop(0, rgba(tint, 0.8));
    right.addColorStop(1, rgba(tint, 0));
    g.fillStyle = right;
    g.beginPath();
    roundRectPath(g, 0, -u, w, 2 * u, u);
    g.fill();
    g.restore();

    // Circle Size 1.2 (transparent fill): Glow (white @ 0.1, radius 50, not hollow) + 3 unit border (white @ 0.1)
    const R = 1.2 * 64 * u;
    const glow = g.createRadialGradient(0, 0, 0, 0, 0, R + 50 * u);
    const inner = R / (R + 50 * u);
    glow.addColorStop(0, rgba(tint, 0.1));
    glow.addColorStop(inner, rgba(tint, 0.1));
    for (let i = 1; i <= 5; i++) {
      const f = i / 5;
      glow.addColorStop(inner + (1 - inner) * f, rgba(tint, 0.1 * (1 - f) * (1 - f)));
    }
    g.fillStyle = glow;
    g.beginPath();
    g.arc(0, 0, R + 50 * u, 0, TWO_PI);
    g.fill();
    g.fillStyle = rgba(tint, 0.1);
    g.beginPath();
    g.arc(0, 0, R, 0, TWO_PI);
    g.arc(0, 0, Math.max(0, R - 3 * u), 0, TWO_PI, true);
    g.fill();
    g.globalAlpha = base;
  }
  g.restore();
}

/**
 * ArgonCatcher: a 10 unit tall pill (Width = ALLOWED_CATCH_RANGE), two bumpers (4 tall) and the 20x-wide long lines
 * (alpha 0.25), centred on the catcher's top. `width` is BASE_SIZE * scale in px, `scale` px per catcher unit.
 */
export function drawCatcherPlate(g: CanvasRenderingContext2D, x: number, y: number, width: number, scale: number, colour: RGB, alpha: number): void {
  const h = 10 * scale;
  const half = width / 2;
  const prev = g.globalAlpha;
  g.globalAlpha = prev * alpha;
  // long lines (Width = 20 relative, Height = 1.8)
  g.fillStyle = rgba(colour, 0.25);
  const lh = 1.8 * scale;
  g.fillRect(x - half - width * 20, y - lh / 2, width * 20, lh);
  g.fillRect(x + half, y - lh / 2, width * 20, lh);
  g.fillStyle = rgba(colour, 1);
  g.beginPath();
  // centre plate (Width = ALLOWED_CATCH_RANGE)
  roundRectPath(g, x - half * ALLOWED_CATCH_RANGE, y - h / 2, width * ALLOWED_CATCH_RANGE, h, h / 2);
  // bumpers (Width = (1 - ALLOWED_CATCH_RANGE) / 2, Height = 4)
  const bw = (width * (1 - ALLOWED_CATCH_RANGE)) / 2;
  const bh = 4 * scale;
  roundRectPath(g, x - half, y - bh / 2, bw, bh, bh / 2);
  roundRectPath(g, x + half - bw, y - bh / 2, bw, bh, bh / 2);
  g.fill();
  g.globalAlpha = prev;
}

/**
 * ArgonHitExplosion: a 20x20 drawable (Anchor/Origin BottomCentre on the plate, Scale = hit object scale), containing
 * - tallExplosion: Width 0.1, Glow (accent, radius 15, roundness 15), ScaleTo((1.1, 20 * comboScale), 200, OutQuint).Then().ScaleTo((1.1, 1), 600, In)
 * - largeFaint: Glow (accent lerped 20% towards white, radius 50)
 * all faded out over 400ms. `unit` = px per explosion unit, `tint` = the Catcher's colour.
 */
export function drawHitExplosion(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  unit: number,
  colour: RGB,
  elapsed: number,
  tall: boolean,
  comboScale: number,
  tint: RGB = WHITE,
): void {
  const alpha = 1 - elapsed / 400;
  if (alpha <= 0 || elapsed < 0) return;
  const accent = mul(colour, tint);
  const cy = y - 10 * unit;
  g.save();
  g.globalAlpha *= alpha;

  if (tall) {
    let sx: number;
    let sy: number;
    const target = 20 * comboScale;
    if (elapsed < 200) {
      const t = applyEasing(Easing.OutQuint, elapsed / 200);
      sx = 1 + 0.1 * t;
      sy = 1 + (target - 1) * t;
    } else {
      sx = 1.1;
      sy = target + (1 - target) * applyEasing(Easing.In, Math.min(1, (elapsed - 200) / 600));
    }
    // The glow of a 2x20 box with corner radius 30 (= roundness + radius) and blend range 15 reaches ~15.6 units
    // horizontally and ~21.5 vertically from the centre, falling off roughly as (1 - d)^2; it scales with the drawable.
    g.save();
    g.translate(x, cy);
    g.scale(15.6 * sx * unit, 21.5 * sy * unit);
    const grad = g.createRadialGradient(0, 0, 0, 0, 0, 1);
    for (let i = 0; i <= 6; i++) {
      const f = i / 6;
      grad.addColorStop(f, rgba(accent, (1 - f) * (1 - f)));
    }
    g.fillStyle = grad;
    g.beginPath();
    g.arc(0, 0, 1, 0, TWO_PI);
    g.fill();
    g.restore();
  }

  // largeFaint: Interpolation.ValueAt(0.2f, colour, Color4.White, 0, 1)
  const faint: RGB = [accent[0] + (tint[0] - accent[0]) * 0.2, accent[1] + (tint[1] - accent[1]) * 0.2, accent[2] + (tint[2] - accent[2]) * 0.2];
  drawRoundRectGlow(g, x - 10 * unit, cy - 10 * unit, 20 * unit, 20 * unit, 0, 50 * unit, faint, 1);
  g.restore();
}
