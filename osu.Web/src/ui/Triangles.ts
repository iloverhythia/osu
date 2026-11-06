// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Animated rising triangles background (a nod to osu!lazer's Triangles drawable).

interface Tri {
  x: number;
  y: number;
  s: number;
  speed: number;
  shade: number;
}

export class Triangles {
  readonly canvas: HTMLCanvasElement;
  private tris: Tri[] = [];
  private raf = 0;
  private last = performance.now();
  /** 0..1 extra brightness kick (e.g. on beat). */
  kick = 0;
  running = true;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'triangles';
    for (let i = 0; i < 60; i++) this.tris.push(this.make(Math.random()));
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      if (this.running) this.frame();
    };
    this.raf = requestAnimationFrame(loop);
  }

  private make(y: number): Tri {
    return { x: Math.random(), y, s: 0.03 + Math.random() * 0.1, speed: 0.02 + Math.random() * 0.04, shade: Math.random() };
  }

  private frame(): void {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    const c = this.canvas;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = c.clientWidth;
    const hgt = c.clientHeight;
    if (w === 0 || hgt === 0) return;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(hgt * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(hgt * dpr);
    }
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, hgt);
    const speedMul = 1 + this.kick * 4;
    this.kick *= Math.pow(0.02, dt);
    const unit = Math.max(w, hgt);
    for (const t of this.tris) {
      t.y -= t.speed * dt * speedMul;
      if (t.y < -t.s) Object.assign(t, this.make(1 + t.s));
      const size = t.s * unit;
      const x = t.x * w;
      const y = t.y * hgt;
      const l = 22 + t.shade * 18;
      g.fillStyle = `hsla(${300 + t.shade * 40}, 35%, ${l}%, ${0.25 + this.kick * 0.3})`;
      g.beginPath();
      g.moveTo(x, y - size * 0.58);
      g.lineTo(x + size * 0.5, y + size * 0.29);
      g.lineTo(x - size * 0.5, y + size * 0.29);
      g.closePath();
      g.fill();
    }
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
  }
}
