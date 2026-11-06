// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Texture model for legacy skins: osu-framework's Texture (ScaleAdjust / DisplayWidth / Crop) as needed by
// LegacySkin.GetTexture and LegacySkinExtensions.WithMaximumSize, plus Canvas 2D drawing helpers which emulate
// sprite colour multiplication (Drawable.Colour) and additive blending (BlendingParameters.Additive).

export interface SkinTexture {
  /** The decoded image. */
  readonly image: CanvasImageSource;
  /** Source rectangle in image pixels (a crop, see WithMaximumSize). */
  readonly sx: number;
  readonly sy: number;
  readonly sw: number;
  readonly sh: number;
  /** Texture.ScaleAdjust: 2 for "@2x" textures. */
  readonly scaleAdjust: number;
}

let nextTextureId = 1;
const textureIds = new WeakMap<SkinTexture, number>();

export function createTexture(image: CanvasImageSource, width: number, height: number, scaleAdjust = 1): SkinTexture {
  return { image, sx: 0, sy: 0, sw: width, sh: height, scaleAdjust };
}

/** Texture.DisplayWidth */
export const displayWidth = (t: SkinTexture): number => t.sw / t.scaleAdjust;
/** Texture.DisplayHeight */
export const displayHeight = (t: SkinTexture): number => t.sh / t.scaleAdjust;

/** A texture with a different ScaleAdjust (e.g. NonPlayfieldSprite multiplying by STABLE_MAGIC_SCALE_FACTOR). */
export function withScaleAdjust(t: SkinTexture, scaleAdjust: number): SkinTexture {
  return { ...t, scaleAdjust };
}

/** LegacySkinExtensions.WithMaximumSize: crops (centred) textures larger than the given display size. */
export function withMaximumSize(texture: SkinTexture, maxWidth: number, maxHeight: number): SkinTexture {
  if (displayWidth(texture) <= maxWidth && displayHeight(texture) <= maxHeight) return texture;

  maxWidth *= texture.scaleAdjust;
  maxHeight *= texture.scaleAdjust;

  // Importantly, check per-axis for the minimum dimension to avoid accidentally inflating
  // textures with weird aspect ratios.
  const newWidth = Math.min(texture.sw, maxWidth);
  const newHeight = Math.min(texture.sh, maxHeight);

  return {
    image: texture.image,
    sx: texture.sx + texture.sw / 2 - newWidth / 2,
    sy: texture.sy + texture.sh / 2 - newHeight / 2,
    sw: newWidth,
    sh: newHeight,
    scaleAdjust: texture.scaleAdjust,
  };
}

// ------------------------------------------------------------------------------------------------ colour multiplication

type Canvas = HTMLCanvasElement | OffscreenCanvas;

function createCanvas(w: number, h: number): Canvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

const tintCache = new WeakMap<SkinTexture, Map<number, Canvas>>();
const MAX_TINTS_PER_TEXTURE = 48;

/**
 * Returns the texture's pixels multiplied by an RGB colour (osu-framework's Drawable.Colour), cached per colour.
 * Canvas 2D has no multiplicative tint, so this is done once per (texture, colour) on the CPU.
 */
export function tintedImage(t: SkinTexture, r: number, g: number, b: number): CanvasImageSource {
  r = Math.round(r);
  g = Math.round(g);
  b = Math.round(b);
  if (r >= 255 && g >= 255 && b >= 255) return t.image;
  const key = (r << 16) | (g << 8) | b;
  let map = tintCache.get(t);
  if (!map) tintCache.set(t, (map = new Map()));
  let canvas = map.get(key);
  if (canvas) return canvas;

  const w = Math.max(1, Math.round(t.sw));
  const h = Math.max(1, Math.round(t.sh));
  canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) return t.image;
  ctx.drawImage(t.image, t.sx, t.sy, t.sw, t.sh, 0, 0, w, h);
  try {
    const data = ctx.getImageData(0, 0, w, h);
    const px = data.data;
    const fr = r / 255;
    const fg = g / 255;
    const fb = b / 255;
    for (let i = 0; i < px.length; i += 4) {
      px[i] = px[i] * fr;
      px[i + 1] = px[i + 1] * fg;
      px[i + 2] = px[i + 2] * fb;
    }
    ctx.putImageData(data, 0, 0);
  } catch {
    return t.image;
  }
  if (map.size >= MAX_TINTS_PER_TEXTURE) map.clear();
  map.set(key, canvas);
  return canvas;
}

/** Grayscale conversion as done by LegacyTextureLoaderStore (BT.601 luma, matching stable's 0.299r + 0.587g + 0.114b). */
export function grayscaleImageData(data: ImageData): void {
  const px = data.data;
  for (let i = 0; i < px.length; i += 4) {
    const y = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    px[i] = px[i + 1] = px[i + 2] = y;
  }
}

// ------------------------------------------------------------------------------------------------ drawing

export interface SpriteOptions {
  /** Uniform scale (Drawable.Scale). */
  scale?: number;
  scaleX?: number;
  scaleY?: number;
  /** Rotation in degrees, clockwise (osu-framework convention). */
  rotation?: number;
  alpha?: number;
  /** Origin within the sprite, 0..1 (0.5 = centre). */
  originX?: number;
  originY?: number;
  /** Colour multiplier as 0..255 RGB. */
  colour?: readonly [number, number, number] | readonly number[];
  additive?: boolean;
}

/** Draws a sprite at its natural display size (texture size / ScaleAdjust) times scale, positioned by its origin. */
export function drawSprite(g: CanvasRenderingContext2D, t: SkinTexture | null | undefined, x: number, y: number, o: SpriteOptions = {}): void {
  if (!t) return;
  const alpha = o.alpha ?? 1;
  if (alpha <= 0) return;
  const sx = (o.scaleX ?? 1) * (o.scale ?? 1);
  const sy = (o.scaleY ?? 1) * (o.scale ?? 1);
  if (sx === 0 || sy === 0) return;
  const w = displayWidth(t);
  const h = displayHeight(t);
  const ox = o.originX ?? 0.5;
  const oy = o.originY ?? 0.5;

  const prevAlpha = g.globalAlpha;
  const prevOp = g.globalCompositeOperation;
  g.globalAlpha = prevAlpha * Math.min(1, alpha);
  if (o.additive) g.globalCompositeOperation = 'lighter';

  const c = o.colour;
  const tinted = c && (c[0] < 255 || c[1] < 255 || c[2] < 255);
  const img = tinted ? tintedImage(t, c[0], c[1], c[2]) : t.image;
  const fromTint = tinted && img !== t.image;

  g.save();
  g.translate(x, y);
  if (o.rotation) g.rotate((o.rotation * Math.PI) / 180);
  g.scale(sx, sy);
  if (fromTint) g.drawImage(img, 0, 0, Math.round(t.sw) || 1, Math.round(t.sh) || 1, -ox * w, -oy * h, w, h);
  else g.drawImage(img, t.sx, t.sy, t.sw, t.sh, -ox * w, -oy * h, w, h);
  g.restore();

  g.globalAlpha = prevAlpha;
  g.globalCompositeOperation = prevOp;
}

/** Draws only the top part of a sprite starting at a given display-space y (used for masking, e.g. the old-style spinner metre). */
export function drawSpriteRegion(
  g: CanvasRenderingContext2D,
  t: SkinTexture,
  x: number,
  y: number,
  scale: number,
  fromDisplayY: number,
  alpha = 1,
): void {
  const h = displayHeight(t);
  const w = displayWidth(t);
  if (fromDisplayY >= h || alpha <= 0) return;
  const from = Math.max(0, fromDisplayY);
  const srcFrom = (from / h) * t.sh;
  const prev = g.globalAlpha;
  g.globalAlpha = prev * alpha;
  g.drawImage(t.image, t.sx, t.sy + srcFrom, t.sw, t.sh - srcFrom, x, y + from * scale, w * scale, (h - from) * scale);
  g.globalAlpha = prev;
}

export function textureId(t: SkinTexture): number {
  let id = textureIds.get(t);
  if (id == null) textureIds.set(t, (id = nextTextureId++));
  return id;
}
