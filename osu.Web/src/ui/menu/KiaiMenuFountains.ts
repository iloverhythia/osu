// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Ports of osu.Game/Screens/Menu/KiaiMenuFountains.cs, StarFountain.cs (StarFountainSpewer) and
// osu.Game/Graphics/ParticleSpewer.cs. The "Menu/fountain-star" texture is replaced by a procedurally drawn star,
// and the fountain shoot sounds (StarFountainSounds) are not played (no such synthesised sample).

import { BeatSync, type MenuBeatSource } from './BeatSync';

const PARTICLE_DURATION_MIN = 300;
const PARTICLE_DURATION_MAX = 1000;
const PER_SECOND = 240;
const GRAVITY = 800;
const SHOOT_DURATION = 800;
/** Display size of the star texture (logical px). */
const STAR_SIZE = 16;

interface FallingParticle {
  startTime: number;
  startX: number;
  startY: number;
  velX: number;
  velY: number;
  duration: number;
  startAngle: number;
  endAngle: number;
  endScale: number;
}

const variance = (v: number): number => (Math.random() * 2 - 1) * v;

class StarFountainSpewer {
  private readonly particles: (FallingParticle | null)[];
  private currentIndex = 0;
  private lastParticleAdded: number | null = null;
  private readonly timeBetweenSpawns = 1000 / PER_SECOND;
  private active = false;
  private deactivateAt = 0;
  private lastShootTime = 0;
  private lastShootDirection = 0;

  constructor() {
    this.particles = new Array(PER_SECOND * Math.ceil(PARTICLE_DURATION_MAX / 1000)).fill(null);
  }

  shoot(direction: number, now: number): void {
    if (!this.active) this.lastParticleAdded = null;
    this.active = true;
    this.deactivateAt = now + SHOOT_DURATION;
    this.lastShootTime = now;
    this.lastShootDirection = direction;
  }

  private currentAngle(now: number): number {
    return this.lastShootDirection * 500 * (1 - (2 * (now - this.lastShootTime)) / SHOOT_DURATION) + variance(60);
  }

  private spawn(time: number, now: number): void {
    this.particles[this.currentIndex] = {
      startTime: time,
      startX: 0,
      startY: 50,
      duration: PARTICLE_DURATION_MIN + Math.random() * (PARTICLE_DURATION_MAX - PARTICLE_DURATION_MIN),
      startAngle: variance(4),
      endAngle: variance(2),
      endScale: 2.2 + variance(0.4),
      velX: this.currentAngle(now),
      velY: -1400 + variance(100),
    };
    this.currentIndex = (this.currentIndex + 1) % this.particles.length;
  }

  update(now: number): void {
    if (this.active && now >= this.deactivateAt) this.active = false;
    if (!this.active) return;
    if (this.lastParticleAdded == null) {
      this.lastParticleAdded = now;
      this.spawn(now, now);
      return;
    }
    const timeElapsed = now - this.lastParticleAdded;
    if (Math.abs(timeElapsed) > PARTICLE_DURATION_MAX) {
      this.lastParticleAdded = now;
      this.spawn(now, now);
      return;
    }
    for (let i = 0; i < timeElapsed / this.timeBetweenSpawns; i++) {
      this.lastParticleAdded += this.timeBetweenSpawns;
      this.spawn(this.lastParticleAdded, now);
    }
  }

  get hasActiveParticles(): boolean {
    return this.active || (this.lastParticleAdded ?? -Infinity) + PARTICLE_DURATION_MAX > performance.now();
  }

  draw(g: CanvasRenderingContext2D, originX: number, originY: number, now: number, star: HTMLCanvasElement): void {
    if (!this.hasActiveParticles) return;
    for (const p of this.particles) {
      if (!p) continue;
      const t = now - p.startTime;
      if (t < 0) continue;
      const progress = Math.min(1, Math.max(0, t / p.duration));
      const alpha = 1 - progress;
      if (alpha <= 0) continue;
      const gravity = (GRAVITY * p.duration) / PARTICLE_DURATION_MAX * progress;
      const x = originX + p.startX + (p.velX * t) / PARTICLE_DURATION_MAX;
      const y = originY + p.startY + ((p.velY + gravity) * t) / PARTICLE_DURATION_MAX;
      const scale = 1 + (p.endScale - 1) * progress;
      const angle = p.startAngle + (p.endAngle - p.startAngle) * progress;
      const size = STAR_SIZE * scale;
      g.save();
      g.globalAlpha = alpha;
      g.translate(x, y);
      g.rotate(-angle);
      g.drawImage(star, -size / 2, -size / 2, size, size);
      g.restore();
    }
  }
}

function createStarTexture(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  const res = 64;
  c.width = c.height = res;
  const g = c.getContext('2d')!;
  const cx = res / 2;
  const glow = g.createRadialGradient(cx, cx, 0, cx, cx, cx);
  glow.addColorStop(0, 'rgba(255,255,255,0.9)');
  glow.addColorStop(0.25, 'rgba(255,236,170,0.45)');
  glow.addColorStop(1, 'rgba(255,220,120,0)');
  g.fillStyle = glow;
  g.fillRect(0, 0, res, res);
  g.fillStyle = '#fff';
  g.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? res * 0.32 : res * 0.13;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    g.lineTo(cx + Math.cos(a) * r, cx + Math.sin(a) * r);
  }
  g.closePath();
  g.fill();
  return c;
}

export class KiaiMenuFountains {
  private readonly left = new StarFountainSpewer();
  private readonly right = new StarFountainSpewer();
  private readonly beat: BeatSync;
  private isTriggered = false;
  private star: HTMLCanvasElement | null = null;

  constructor(private readonly source: MenuBeatSource) {
    this.beat = new BeatSync(() => {});
  }

  update(now: number, frame: number): void {
    this.beat.update(now, this.source, frame);
    const ep = this.beat.effectPoint;
    if (ep.kiaiMode && !this.isTriggered) {
      const isNearEffectPoint = Math.abs(this.source.currentTime - ep.time) < 500;
      if (isNearEffectPoint) this.shoot(now);
    }
    this.isTriggered = ep.kiaiMode;
    this.left.update(now);
    this.right.update(now);
  }

  shoot(now: number): void {
    const direction = Math.floor(Math.random() * 3) - 1;
    switch (direction) {
      case -1:
        this.left.shoot(1, now);
        this.right.shoot(-1, now);
        break;
      case 0:
        this.left.shoot(0, now);
        this.right.shoot(0, now);
        break;
      case 1:
        this.left.shoot(-1, now);
        this.right.shoot(1, now);
        break;
    }
  }

  /** Additive. Fountains sit at the bottom corners, 250px in from each side. */
  draw(g: CanvasRenderingContext2D, w: number, h: number, now: number): void {
    if (!this.left.hasActiveParticles && !this.right.hasActiveParticles) return;
    this.star ??= createStarTexture();
    this.left.draw(g, 250, h - STAR_SIZE, now, this.star);
    this.right.draw(g, w - 250, h - STAR_SIZE, now, this.star);
  }
}
