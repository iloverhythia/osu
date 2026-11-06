// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of DrawableStoryboard.StoryboardResourceLookupStore + Storyboard.GetStoragePathFromStoryboardPath (texture lookups for storyboard
// paths, case-insensitive like BeatmapSetInfo.GetPathForFile), backed by lazily decoded ImageBitmaps instead of osu-framework's TextureStore.
// Colour tinting (Drawable.Colour, which multiplies the texture on the GPU in lazer) is emulated exactly: static colours use an LRU cache of
// per-pixel tinted copies; colours that are mid-fade use a per-channel decomposition of the texture (see `getChannels`), and single-colour
// textures (e.g. 1x1 "pixel.png") are drawn as filled rectangles.

import type { Storyboard } from './Storyboard';

export enum TextureState {
  None,
  Loading,
  Ready,
  Failed,
}

export class StoryboardTexture {
  state = TextureState.None;
  bitmap: ImageBitmap | null = null;
  width = 0;
  height = 0;
  /**
   * Set when every pixel of the (small) texture has the same colour (e.g. the ubiquitous 1x1 "pixel.png"): it can then be drawn as a
   * filled rectangle, which makes tinting free. Unpremultiplied r, g, b, a in 0..1.
   */
  solid: Float32Array | null = null;
  /**
   * Lazily built per-channel copies (black silhouette, red-only, green-only, blue-only, each with the texture's alpha) used to draw
   * colour fades exactly without creating a tinted copy per frame: tint(c) = silhouette erase + Σ channel_i · c_i (additively).
   */
  channels: DrawSource[] | null = null;
  /** Unpremultiplied RGBA pixels, read back lazily for tinting. */
  pixels: Uint8ClampedArray | null = null;
  /** The latest time any element using this texture is displayed until (used for eviction). */
  lastUseEnd = -Infinity;

  constructor(
    readonly id: number,
    readonly file: string,
    readonly blob: Blob,
  ) {}
}

type Canvas2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

/** Turns a finished offscreen canvas into an ImageBitmap (much cheaper to draw repeatedly than an OffscreenCanvas source). */
function finish(c: OffscreenCanvas | HTMLCanvasElement): ImageBitmap | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== 'undefined' && c instanceof OffscreenCanvas) return c.transferToImageBitmap();
  return c as HTMLCanvasElement;
}

type DrawSource = ImageBitmap | HTMLCanvasElement;

function createCanvas(w: number, h: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

interface TintEntry {
  canvas: DrawSource;
  pixels: number;
}

function closeSource(s: DrawSource): void {
  if (typeof ImageBitmap !== 'undefined' && s instanceof ImageBitmap) s.close();
}

const MAX_CONCURRENT_DECODES = 6;
/** Budget for cached tinted copies, in pixels (≈ 4 bytes each). */
const TINT_CACHE_PIXEL_BUDGET = 24 * 1024 * 1024;

export class StoryboardTextureStore {
  private readonly files = new Map<string, { name: string; blob: Blob }>();
  private readonly byPath = new Map<string, StoryboardTexture | null>();
  private readonly byFile = new Map<string, StoryboardTexture>();
  readonly textures: StoryboardTexture[] = [];

  private readonly queue: StoryboardTexture[] = [];
  private readonly waiters = new Map<StoryboardTexture, (() => void)[]>();
  private decoding = 0;
  private disposed = false;

  private readonly tintCache = new Map<number, TintEntry>();
  private tintPixels = 0;
  private readonly fillStyles = new Map<number, string>();

  constructor(
    setFiles: Record<string, Blob>,
    private readonly storyboard: Storyboard,
  ) {
    for (const [name, blob] of Object.entries(setFiles)) {
      const standardised = name.replace(/\\/g, '/');
      const key = standardised.toLowerCase();
      if (!this.files.has(key)) this.files.set(key, { name: standardised, blob });
    }
  }

  /** BeatmapSetInfo.GetPathForFile (case-insensitive). */
  getPathForFile = (filename: string): string | null => this.files.get(filename.replace(/\\/g, '/').toLowerCase())?.name ?? null;

  getBlob(file: string): Blob | null {
    return this.files.get(file.toLowerCase())?.blob ?? null;
  }

  /** TextureStore.Get(path): the texture for a storyboard path, or null if the file doesn't exist in the beatmap set. */
  get(path: string): StoryboardTexture | null {
    let tex = this.byPath.get(path);
    if (tex !== undefined) return tex;

    tex = null;
    const file = this.storyboard.getStoragePathFromStoryboardPath(path, this.getPathForFile);
    if (file) {
      const key = file.toLowerCase();
      tex = this.byFile.get(key) ?? null;
      if (!tex) {
        const blob = this.getBlob(file);
        if (blob) {
          tex = new StoryboardTexture(this.textures.length, file, blob);
          this.textures.push(tex);
          this.byFile.set(key, tex);
        }
      }
    }
    this.byPath.set(path, tex);
    return tex;
  }

  /** Queues a texture for decoding (no-op if it is loaded, loading or failed). */
  request(tex: StoryboardTexture): void {
    if (tex.state !== TextureState.None || this.disposed) return;
    tex.state = TextureState.Loading;
    this.queue.push(tex);
    this.pump();
  }

  /** Resolves once the texture has finished loading (or failed). */
  load(tex: StoryboardTexture): Promise<void> {
    this.request(tex);
    if (tex.state !== TextureState.Loading) return Promise.resolve();
    return new Promise(resolve => {
      const list = this.waiters.get(tex);
      if (list) list.push(resolve);
      else this.waiters.set(tex, [resolve]);
    });
  }

  private pump(): void {
    while (this.decoding < MAX_CONCURRENT_DECODES && this.queue.length > 0) {
      const tex = this.queue.shift()!;
      this.decoding++;
      void this.decode(tex).finally(() => {
        this.decoding--;
        const list = this.waiters.get(tex);
        if (list) {
          this.waiters.delete(tex);
          for (const r of list) r();
        }
        this.pump();
      });
    }
  }

  private async decode(tex: StoryboardTexture): Promise<void> {
    try {
      const bitmap = await createImageBitmap(tex.blob);
      if (this.disposed || tex.state !== TextureState.Loading) {
        bitmap.close();
        return;
      }
      tex.bitmap = bitmap;
      tex.width = bitmap.width;
      tex.height = bitmap.height;
      tex.solid = detectSolid(bitmap);
      tex.state = TextureState.Ready;
    } catch {
      tex.state = TextureState.Failed;
    }
  }

  /** Releases decoded textures which no element will display after `time` (they are decoded again if needed after a rewind). */
  evict(time: number): void {
    for (const tex of this.textures) {
      if (tex.state === TextureState.Ready && tex.lastUseEnd < time) this.release(tex);
    }
  }

  private release(tex: StoryboardTexture): void {
    tex.bitmap?.close();
    tex.bitmap = null;
    tex.channels?.forEach(closeSource);
    tex.channels = null;
    tex.pixels = null;
    tex.state = TextureState.None;
    for (const [key, entry] of this.tintCache) {
      if (Math.floor(key / 16777216) === tex.id) {
        this.tintCache.delete(key);
        this.tintPixels -= entry.pixels;
        closeSource(entry.canvas);
      }
    }
  }

  /** A copy of the texture multiplied by the given colour (0..255 per channel), cached (LRU) per texture and colour. */
  getTinted(tex: StoryboardTexture, r: number, g: number, b: number): DrawSource | null {
    const bitmap = tex.bitmap;
    if (!bitmap) return null;
    const rgb = (r << 16) | (g << 8) | b;
    const key = tex.id * 16777216 + rgb;
    const hit = this.tintCache.get(key);
    if (hit) {
      // move to the most-recently-used end
      this.tintCache.delete(key);
      this.tintCache.set(key, hit);
      return hit.canvas;
    }

    const pixels = tex.width * tex.height;
    if (pixels > TINT_CACHE_PIXEL_BUDGET) return bitmap;
    const data = this.getPixels(tex);
    if (!data) return bitmap;

    // Exact multiplicative tint (as the GPU does in lazer): rgb * colour, alpha unchanged.
    const img = new ImageData(tex.width, tex.height);
    const out = img.data;
    for (let i = 0; i < data.length; i += 4) {
      out[i] = (data[i] * r + 127) / 255;
      out[i + 1] = (data[i + 1] * g + 127) / 255;
      out[i + 2] = (data[i + 2] * b + 127) / 255;
      out[i + 3] = data[i + 3];
    }
    const canvas = createCanvas(tex.width, tex.height);
    const cx = canvas.getContext('2d') as Canvas2D | null;
    if (!cx) return bitmap;
    cx.putImageData(img, 0, 0);

    const source = finish(canvas);
    this.tintCache.set(key, { canvas: source, pixels });
    this.tintPixels += pixels;
    for (const [k, entry] of this.tintCache) {
      if (this.tintPixels <= TINT_CACHE_PIXEL_BUDGET) break;
      if (k === key) continue;
      this.tintCache.delete(k);
      this.tintPixels -= entry.pixels;
      closeSource(entry.canvas);
    }
    return source;
  }

  /** Reads back the texture's (unpremultiplied) pixels, cached on the texture. */
  private getPixels(tex: StoryboardTexture): Uint8ClampedArray | null {
    if (tex.pixels) return tex.pixels;
    const bitmap = tex.bitmap;
    if (!bitmap) return null;
    try {
      const src = createCanvas(tex.width, tex.height);
      const sx = src.getContext('2d', { willReadFrequently: true } as CanvasRenderingContext2DSettings) as Canvas2D | null;
      if (!sx) return null;
      sx.drawImage(bitmap, 0, 0);
      tex.pixels = sx.getImageData(0, 0, tex.width, tex.height).data;
      return tex.pixels;
    } catch {
      return null;
    }
  }

  /** The per-channel decomposition of a texture (see `StoryboardTexture.channels`), or null if it can't be built. */
  getChannels(tex: StoryboardTexture): DrawSource[] | null {
    if (tex.channels) return tex.channels;
    const bitmap = tex.bitmap;
    const w = tex.width;
    const h = tex.height;
    if (!bitmap || w * h > 4096 * 4096) return null;
    try {
      const data = this.getPixels(tex);
      if (!data) return null;
      const result: DrawSource[] = [];
      for (let channel = -1; channel < 3; channel++) {
        const img = new ImageData(w, h);
        const out = img.data;
        for (let i = 0; i < data.length; i += 4) {
          if (channel >= 0) out[i + channel] = data[i + channel];
          out[i + 3] = data[i + 3];
        }
        const c = createCanvas(w, h);
        (c.getContext('2d') as Canvas2D).putImageData(img, 0, 0);
        result.push(finish(c));
      }
      tex.channels = result;
      return result;
    } catch {
      return null;
    }
  }

  /** Cached `rgb(r,g,b)` strings (0..255 ints) to avoid per-frame string allocation. */
  fillStyle(r: number, g: number, b: number): string {
    const key = (r << 16) | (g << 8) | b;
    let s = this.fillStyles.get(key);
    if (s === undefined) {
      s = `rgb(${r},${g},${b})`;
      if (this.fillStyles.size > 65536) this.fillStyles.clear();
      this.fillStyles.set(key, s);
    }
    return s;
  }

  dispose(): void {
    this.disposed = true;
    for (const tex of this.textures) {
      tex.bitmap?.close();
      tex.bitmap = null;
      tex.channels?.forEach(closeSource);
      tex.channels = null;
      tex.pixels = null;
      tex.state = TextureState.None;
    }
    for (const entry of this.tintCache.values()) closeSource(entry.canvas);
    this.queue.length = 0;
    for (const list of this.waiters.values()) for (const r of list) r();
    this.waiters.clear();
    this.tintCache.clear();
    this.tintPixels = 0;
  }
}

/** Checks small textures for being a single solid colour. */
function detectSolid(bitmap: ImageBitmap): Float32Array | null {
  const w = bitmap.width;
  const h = bitmap.height;
  if (w * h > 4096 || w === 0 || h === 0) return null;
  try {
    const canvas = createCanvas(w, h);
    const cx = canvas.getContext('2d', { willReadFrequently: true } as CanvasRenderingContext2DSettings) as Canvas2D | null;
    if (!cx) return null;
    cx.drawImage(bitmap, 0, 0);
    const data = cx.getImageData(0, 0, w, h).data;
    const r = data[0];
    const g = data[1];
    const b = data[2];
    const a = data[3];
    for (let i = 4; i < data.length; i += 4) {
      if (data[i] !== r || data[i + 1] !== g || data[i + 2] !== b || data[i + 3] !== a) return null;
    }
    return new Float32Array([r / 255, g / 255, b / 255, a / 255]);
  } catch {
    return null;
  }
}
