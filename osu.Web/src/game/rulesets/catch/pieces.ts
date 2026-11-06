// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Procedural drawing of catch pieces, modelled after osu.Game.Rulesets.Catch/Skinning/Argon/*
// (ArgonFruitPiece, ArgonDropletPiece, ArgonBananaPiece, ArgonCatcher, ArgonHitExplosion).
// No textures are used: "CircularBlob" layers are approximated with seeded wobbly rings.

import type { RGB } from '../../Skin';

const DEG = Math.PI / 180;
const TWO_PI = Math.PI * 2;
const BLOB_TEMPLATES = 8;
const BLOB_POINTS = 48;

export const HYPER_DASH_COLOUR: RGB = [255, 0, 0];

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

/** A unit-radius wobbly ring ("CircularBlob") with the given relative thickness, as a Path2D (fill with evenodd). */
function blobRing(template: number, innerRadius: number): Path2D {
  const key = `${template}:${innerRadius}`;
  let p = ringCache.get(key);
  if (p) return p;

  const rnd = mulberry(template * 7919 + 17);
  const harmonics = [2, 3, 5].map(k => ({ k, a: 0.025 + rnd() * 0.03, ph: rnd() * TWO_PI }));
  const radiusAt = (theta: number) => {
    let r = 1;
    for (const h of harmonics) r += h.a * Math.sin(h.k * theta + h.ph);
    return r / 1.08;
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

function fillBlob(g: CanvasRenderingContext2D, template: number, inner: number, radius: number, rotationDeg: number, colour: string): void {
  g.save();
  g.rotate(rotationDeg * DEG);
  g.scale(radius, radius);
  g.fillStyle = colour;
  g.fill(blobRing(template, inner), 'evenodd');
  g.restore();
}

export interface PieceParams {
  /** Centre in canvas pixels. */
  x: number;
  y: number;
  /** Radius of the piece (OBJECT_RADIUS * display scale) in pixels. */
  radius: number;
  /** Rotation of the whole piece in degrees. */
  rotation: number;
  colour: RGB;
  hyper: boolean;
  alpha: number;
  /** Seed choosing the blob shapes. */
  seed: number;
  /** Time-driven layer rotation (degrees per layer step). */
  layerRotation: number;
}

/** ArgonFruitPiece */
export function drawFruit(g: CanvasRenderingContext2D, p: PieceParams): void {
  if (p.alpha <= 0) return;
  const t0 = (p.seed >>> 0) % BLOB_TEMPLATES;
  g.save();
  g.translate(p.x, p.y);
  g.rotate(p.rotation * DEG);
  g.globalAlpha = p.alpha;
  g.globalCompositeOperation = 'lighter';

  // Layers are ordered from largest to smallest. Smaller layers rotate more, alternating direction.
  fillBlob(g, t0, 0.5, p.radius * 1.1, 0, rgba(p.colour, 0.15));
  fillBlob(g, (t0 + 3) % BLOB_TEMPLATES, 0.2, p.radius, p.layerRotation * 2, rgba(p.colour, 0.5));
  fillBlob(g, (t0 + 5) % BLOB_TEMPLATES, 0.05, p.radius, -p.layerRotation * 4, rgba(p.colour, 1));

  if (p.hyper) fillBlob(g, t0, 0.08, p.radius * 1.15, 0, rgba(HYPER_DASH_COLOUR, 1));

  g.globalCompositeOperation = 'source-over';
  g.fillStyle = '#fff';
  g.beginPath();
  g.arc(0, 0, p.radius * (10 / 64), 0, TWO_PI);
  g.fill();
  g.restore();
}

/** ArgonDropletPiece (`coreScale` keeps the absolute-size white core of the argon piece). */
export function drawDroplet(g: CanvasRenderingContext2D, p: PieceParams, coreRadius: number): void {
  if (p.alpha <= 0) return;
  const t0 = (p.seed >>> 0) % BLOB_TEMPLATES;
  const r = p.radius * 0.7; // droplet_scale_down
  g.save();
  g.translate(p.x, p.y);
  g.rotate(p.rotation * DEG);
  g.globalAlpha = p.alpha;
  g.globalCompositeOperation = 'lighter';

  fillBlob(g, t0, 0.5, r, p.layerRotation, rgba(p.colour, 0.35));
  fillBlob(g, (t0 + 3) % BLOB_TEMPLATES, 0.4, r * 0.7, p.layerRotation * 0.5, rgba(p.colour, 0.8));

  if (p.hyper) fillBlob(g, t0, 0.5, r, 0, rgba(HYPER_DASH_COLOUR, 0.5));

  g.globalCompositeOperation = 'source-over';
  g.fillStyle = '#fff';
  g.beginPath();
  g.arc(0, 0, coreRadius, 0, TWO_PI);
  g.fill();
  g.restore();
}

/**
 * Banana: a crescent in the banana colour plus the argon "lens flare" streak, which fades out while falling
 * (`flareAlpha`). Argon itself only draws the flare; the crescent keeps bananas visible for the whole fall.
 */
export function drawBanana(g: CanvasRenderingContext2D, p: PieceParams, flareAlpha: number): void {
  if (p.alpha <= 0) return;
  const r = p.radius;
  g.save();
  g.translate(p.x, p.y);
  g.globalAlpha = p.alpha;

  if (flareAlpha > 0.01) {
    g.globalCompositeOperation = 'lighter';
    const w = r * 1.6;
    const grad = g.createLinearGradient(-w, 0, w, 0);
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(0.5, `rgba(255,255,255,${0.8 * flareAlpha})`);
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(-w, -r * (1 / 64), w * 2, r * (2 / 64));
    g.fillStyle = `rgba(255,255,255,${0.4 * flareAlpha})`;
    const sw = r * (100 / 64);
    g.beginPath();
    g.ellipse(0, 0, sw, r * (4 / 64), 0, 0, TWO_PI);
    g.fill();
    g.strokeStyle = `rgba(255,255,255,${0.15 * flareAlpha})`;
    g.lineWidth = r * (3 / 64);
    g.beginPath();
    g.arc(0, 0, r * 1.2, 0, TWO_PI);
    g.stroke();
    g.globalCompositeOperation = 'source-over';
  }

  g.rotate(p.rotation * DEG);
  // crescent
  g.fillStyle = rgba(p.colour, 1);
  g.beginPath();
  g.arc(0, 0, r * 0.62, -0.95 * Math.PI, 0.15 * Math.PI, false);
  g.arc(r * 0.18, -r * 0.2, r * 0.5, 0.2 * Math.PI, -0.9 * Math.PI, true);
  g.closePath();
  g.fill();
  g.fillStyle = 'rgba(120,80,0,0.9)';
  g.beginPath();
  g.arc(-r * 0.6, -r * 0.08, r * 0.07, 0, TWO_PI);
  g.fill();
  g.restore();
}

/** ArgonCatcher: the plate. `width` is the catcher's full width (BASE_SIZE * scale) in px. */
export function drawCatcherPlate(g: CanvasRenderingContext2D, x: number, y: number, width: number, scale: number, colour: RGB, alpha: number, canvasWidth: number, drawLines: boolean): void {
  const h = 10 * scale;
  const half = width / 2;
  g.globalAlpha = alpha;
  if (drawLines) {
    g.fillStyle = rgba(colour, 0.25);
    const lh = 1.8 * scale;
    g.fillRect(0, y - lh / 2, Math.max(0, x - half), lh);
    g.fillRect(x + half, y - lh / 2, Math.max(0, canvasWidth - (x + half)), lh);
  }
  g.fillStyle = rgba(colour, 1);
  // centre plate (Width = ALLOWED_CATCH_RANGE)
  roundRect(g, x - half * 0.8, y - h / 2, width * 0.8, h);
  // bumpers
  const bw = (width * (1 - 0.8)) / 2;
  const bh = 4 * scale;
  roundRect(g, x - half, y - bh / 2, bw, bh);
  roundRect(g, x + half - bw, y - bh / 2, bw, bh);
  g.globalAlpha = 1;
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  const r = Math.min(h / 2, w / 2);
  g.beginPath();
  g.moveTo(x + r, y);
  g.lineTo(x + w - r, y);
  g.arc(x + w - r, y + r, r, -Math.PI / 2, Math.PI / 2);
  g.lineTo(x + r, y + h);
  g.arc(x + r, y + r, r, Math.PI / 2, (Math.PI * 3) / 2);
  g.closePath();
  g.fill();
}

/**
 * ArgonHitExplosion. `progress` is ms since the catch, `unit` = px per catcher-local unit
 * (hit object scale * catcher scale * playfield scale).
 */
export function drawHitExplosion(g: CanvasRenderingContext2D, x: number, y: number, unit: number, colour: RGB, elapsed: number, tall: boolean, comboScale: number): void {
  const alpha = 1 - elapsed / 400;
  if (alpha <= 0) return;
  g.save();
  g.globalCompositeOperation = 'lighter';
  g.globalAlpha = alpha;

  // large faint glow (20x20 box with a 50 radius glow, colour lerped 20% towards white)
  const faint: RGB = [colour[0] + (255 - colour[0]) * 0.2, colour[1] + (255 - colour[1]) * 0.2, colour[2] + (255 - colour[2]) * 0.2];
  const cy = y - 10 * unit;
  const gr = 60 * unit;
  const rad = g.createRadialGradient(x, cy, 0, x, cy, gr);
  rad.addColorStop(0, rgba(faint, 0.5));
  rad.addColorStop(1, rgba(faint, 0));
  g.fillStyle = rad;
  g.fillRect(x - gr, cy - gr, gr * 2, gr * 2);

  if (tall) {
    // .ScaleTo((1.1, 20 * scale), 200, OutQuint).Then().ScaleTo((1.1, 1), 600, In)
    let sy: number;
    const target = 20 * comboScale;
    if (elapsed < 200) {
      const t = elapsed / 200;
      sy = 1 + (target - 1) * (1 - Math.pow(1 - t, 5));
    } else {
      const t = Math.min(1, (elapsed - 200) / 600);
      sy = target + (1 - target) * t * t;
    }
    const halfH = 10 * sy * unit + 15 * unit;
    const halfW = 1.1 * unit + 15 * unit;
    const lin = g.createLinearGradient(x - halfW, 0, x + halfW, 0);
    lin.addColorStop(0, rgba(colour, 0));
    lin.addColorStop(0.5, rgba(colour, 0.9));
    lin.addColorStop(1, rgba(colour, 0));
    g.fillStyle = lin;
    g.fillRect(x - halfW, cy - halfH, halfW * 2, halfH * 2);
  }
  g.restore();
}
