// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Ports of osu.Game/Graphics/Backgrounds/Triangles.cs (filled, shaded triangles: DrawableRank, buttons, the
// global background) and osu.Game/Graphics/Backgrounds/TrianglesV2.cs (outlined triangles: the menu logo).
//
// Canvas 2D approximation of the TriangleBorder shader: TrianglesV2 draws each triangle as an outline whose width is
// `Thickness` of the triangle height (anti-aliasing is left to the canvas instead of the shader's texel smoothing).

const TRIANGLE_SIZE = 100;
const BASE_VELOCITY = 50;
/** sqrt(3) / 2 */
const EQUILATERAL_TRIANGLE_RATIO = 0.866;

type Rng = () => number;

/** System.Random(seed).NextDouble isn't reproduced exactly; a seeded mulberry32 gives stable layouts. */
export function seededRandom(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box–Muller normal(mean 0.5, stdDev 0.16), clamped to >= 0.1 (CreateTriangle in both classes). */
function randomNormalScale(next: Rng): number {
  const u1 = 1 - next();
  const u2 = 1 - next();
  const randStdNormal = Math.sqrt(-2.0 * Math.log(u1)) * Math.sin(2.0 * Math.PI * u2);
  return 0.5 + 0.16 * randStdNormal;
}

export type RGB = [number, number, number];

export function hexToRgb(hex: string): RGB {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.replace(/./g, c => c + c) : h;
  return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
}

interface Particle {
  x: number;
  y: number;
  shade: number;
  colour: RGB;
  scale: number;
}

/** Triangles.cs: shaded triangles rising at a size-dependent speed. Draws into a rectangle of any canvas. */
export class TrianglesV1 {
  colourLight: RGB = [255, 255, 255];
  colourDark: RGB = [0, 0, 0];
  spawnRatio = 1;
  triangleScale = 1;
  velocity = 1;
  hideAlphaDiscrepancies = true;
  createNewTriangles = true;

  private parts: Particle[] = [];
  private w = 0;
  private h = 0;
  private readonly next: Rng;

  constructor(seed?: number) {
    this.next = seed != null ? seededRandom(seed) : Math.random;
  }

  /** Triangles.Reset: re-initialises for the current draw size. */
  reset(w: number, h: number): void {
    this.w = w;
    this.h = h;
    const aimCount = Math.floor(Math.min(65535 / 6, (w * h * 0.002) / (this.triangleScale * this.triangleScale) * this.spawnRatio));
    this.parts = [];
    for (let i = 0; i < aimCount; i++) this.parts.push(this.createTriangle(true));
    // Largest first so that smaller triangles are drawn on top (TriangleParticle.CompareTo).
    this.parts.sort((a, b) => b.scale - a.scale);
  }

  setColours(dark: RGB, light: RGB): void {
    this.colourDark = dark;
    this.colourLight = light;
    for (const p of this.parts) p.colour = this.shade(p.shade);
  }

  private shade(s: number): RGB {
    const d = this.colourDark;
    const l = this.colourLight;
    return [d[0] + (l[0] - d[0]) * s, d[1] + (l[1] - d[1]) * s, d[2] + (l[2] - d[2]) * s];
  }

  private createTriangle(randomY: boolean): Particle {
    const scale = Math.max(this.triangleScale * randomNormalScale(this.next), 0.1);
    const pos = this.randomPosition(randomY, scale);
    const shade = this.next();
    return { x: pos[0], y: pos[1], shade, colour: this.shade(shade), scale };
  }

  private randomPosition(randomY: boolean, scale: number): [number, number] {
    let y = 1;
    if (randomY) {
      const maxOffset = (TRIANGLE_SIZE * scale * EQUILATERAL_TRIANGLE_RATIO) / this.h;
      y = -maxOffset + (1 + maxOffset) * this.next();
    }
    return [this.next(), y];
  }

  update(elapsedMs: number, w: number, h: number): void {
    if (w !== this.w || h !== this.h) this.reset(w, h);
    const elapsedSeconds = elapsedMs / 1000;
    if (elapsedSeconds === 0 || h === 0) return;
    const movedDistance = (-elapsedSeconds * this.velocity * BASE_VELOCITY) / (h * this.triangleScale);
    for (let i = this.parts.length - 1; i >= 0; i--) {
      const p = this.parts[i];
      const newY = p.y + Math.max(0.5, p.scale) * movedDistance;
      const bottomY = newY + (TRIANGLE_SIZE * p.scale * EQUILATERAL_TRIANGLE_RATIO) / h;
      if (bottomY < 0) {
        if (!this.createNewTriangles) {
          this.parts.splice(i, 1);
          continue;
        }
        const pos = this.randomPosition(false, p.scale);
        p.x = pos[0];
        p.y = pos[1];
      } else p.y = newY;
    }
  }

  /** Draws into (x, y, w, h) of `g`; `alpha` is the drawable's own alpha (DrawColourInfo alpha). */
  draw(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, alpha = 1): void {
    if (w !== this.w || h !== this.h) this.reset(w, h);
    const a = this.hideAlphaDiscrepancies ? Math.pow(alpha, 3) : 1;
    if (a <= 0) return;
    g.save();
    g.beginPath();
    g.rect(x, y, w, h);
    g.clip();
    for (const p of this.parts) {
      const tw = TRIANGLE_SIZE * p.scale;
      const th = tw * EQUILATERAL_TRIANGLE_RATIO;
      const tx = x + p.x * w;
      const ty = y + p.y * h;
      const c = p.colour;
      g.fillStyle = `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a * alpha})`;
      g.beginPath();
      g.moveTo(tx, ty);
      g.lineTo(tx + tw / 2, ty + th);
      g.lineTo(tx - tw / 2, ty + th);
      g.closePath();
      g.fill();
    }
    g.restore();
  }
}

interface ParticleV2 {
  x: number;
  y: number;
  speedMultiplier: number;
}

/** TrianglesV2.cs: equally sized outlined triangles, used by the menu logo. */
export class TrianglesV2 {
  thickness = 0.02;
  scaleAdjust = 1;
  spawnRatio = 1;
  velocity = 1;
  createNewTriangles = true;

  private parts: ParticleV2[] = [];
  private w = 0;
  private h = 0;
  private readonly next: Rng;

  constructor(seed?: number) {
    this.next = seed != null ? seededRandom(seed) : Math.random;
  }

  reset(w: number, h: number): void {
    this.w = w;
    this.h = h;
    this.parts = [];
    this.addTriangles(true);
  }

  private aimCount(): number {
    return Math.floor(Math.min(Math.max(this.w * 0.02 * this.spawnRatio, 1), 65535 / 6));
  }

  private addTriangles(randomY: boolean): void {
    const aim = this.aimCount();
    const current = this.parts.length;
    for (let i = 0; i < aim - current; i++) this.parts.push(this.createTriangle(randomY));
  }

  private createTriangle(randomY: boolean): ParticleV2 {
    const speedMultiplier = Math.max(randomNormalScale(this.next), 0.1);
    let y = 1;
    if (randomY) {
      const maxOffset = (TRIANGLE_SIZE * this.scaleAdjust * EQUILATERAL_TRIANGLE_RATIO) / this.h;
      y = -maxOffset + (1 + maxOffset) * this.next();
    }
    return { x: this.next(), y, speedMultiplier };
  }

  update(elapsedMs: number, w: number, h: number): void {
    if (w !== this.w || h !== this.h) this.reset(w, h);
    if (this.createNewTriangles) this.addTriangles(false);
    const elapsedSeconds = elapsedMs / 1000;
    if (elapsedSeconds === 0 || h === 0) return;
    const movedDistance = (-elapsedSeconds * this.velocity * BASE_VELOCITY) / h;
    for (let i = 0; i < this.parts.length; i++) {
      const p = this.parts[i];
      p.y += Math.max(0.5, p.speedMultiplier) * movedDistance;
      const bottomPos = p.y + (TRIANGLE_SIZE * this.scaleAdjust * EQUILATERAL_TRIANGLE_RATIO) / h;
      if (bottomPos < 0) this.parts.splice(i, 1);
    }
  }

  /**
   * Draws in local space (0, 0, w, h) of the current transform. `fill` is the drawable's colour (a vertical gradient
   * across the whole drawable, as DrawColourInfo.Colour.Interpolate(triangleQuad) does).
   */
  draw(g: CanvasRenderingContext2D, w: number, h: number, fill: string | CanvasGradient): void {
    if (w !== this.w || h !== this.h) this.reset(w, h);
    if (this.thickness === 0) return;
    const tw = TRIANGLE_SIZE * this.scaleAdjust;
    const th = tw * EQUILATERAL_TRIANGLE_RATIO;
    // Inset of the inner (hole) triangle: thickness is relative to the triangle height. The incircle radius is th / 3.
    const r = th / 3;
    const k = Math.max(0, (r - this.thickness * th) / r);
    g.save();
    g.beginPath();
    g.rect(0, 0, w, h);
    g.clip();
    g.fillStyle = fill;
    g.beginPath();
    for (const p of this.parts) {
      const tx = p.x * w;
      const ty = p.y * h;
      g.moveTo(tx, ty);
      g.lineTo(tx + tw / 2, ty + th);
      g.lineTo(tx - tw / 2, ty + th);
      g.closePath();
      // Inner triangle around the incentre (counter-wound so nonzero filling punches it out).
      const cx = tx;
      const cy = ty + (2 * th) / 3;
      g.moveTo(cx + (tx - cx) * k, cy + (ty - cy) * k);
      g.lineTo(cx + (tx - tw / 2 - cx) * k, cy + (ty + th - cy) * k);
      g.lineTo(cx + (tx + tw / 2 - cx) * k, cy + (ty + th - cy) * k);
      g.closePath();
    }
    g.fill();
    g.restore();
  }
}

/**
 * The full-screen triangles backdrop the game shows behind some screens (a `Triangles` drawable with the app's dark
 * palette, TriangleScale 5 so the particle count stays canvas-friendly).
 */
export class Triangles {
  readonly canvas: HTMLCanvasElement;
  private readonly tris = new TrianglesV1();
  private raf = 0;
  private last = performance.now();
  /** 0..1 extra velocity kick (e.g. on beat). */
  kick = 0;
  running = true;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'triangles';
    this.tris.triangleScale = 5;
    this.tris.setColours(hexToRgb('#241c2c'), hexToRgb('#4a3d5a'));
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      if (this.running) this.frame();
    };
    this.raf = requestAnimationFrame(loop);
  }

  private frame(): void {
    const now = performance.now();
    const elapsed = Math.min(100, now - this.last);
    this.last = now;
    const c = this.canvas;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (w === 0 || h === 0) return;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    this.tris.velocity = 1 + this.kick * 4;
    this.kick *= Math.pow(0.02, elapsed / 1000);
    this.tris.update(elapsed, w, h);
    this.tris.draw(g, 0, 0, w, h, 1);
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
  }
}
