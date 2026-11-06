// Port of osu.Game/Graphics/Cursor/MenuCursorContainer.cs: the in-game menu cursor with its press animation, additive
// highlight, drag rotation (OsuSetting.CursorRotation), size (OsuSetting.MenuCursorSize) and tap samples. The cursor
// artwork is an original arrow (the menu-cursor textures are part of osu-resources).

import { settings } from '../framework/Settings';
import { h } from './dom';
import type { Game } from './Game';

const outQuint = (t: number) => 1 - Math.pow(1 - t, 5);
const outElastic = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1);
const outElasticQuarter = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : Math.pow(2, -10 * t) * Math.sin((0.25 * t * 10 - 0.75) * ((2 * Math.PI) / 3) * 4) + 1);
const easeIn = (t: number) => t * t;

/** A one-property transform: value(t) eases from `from` to `to` over [start, start + duration]. */
class Tween {
  from = 0;
  to = 0;
  start = 0;
  duration = 0;
  ease: (t: number) => number = outQuint;
  constructor(public value: number) {
    this.from = this.to = value;
  }
  go(to: number, duration: number, ease: (t: number) => number, now: number): void {
    this.from = this.value;
    this.to = to;
    this.start = now;
    this.duration = duration;
    this.ease = ease;
  }
  set(v: number): void {
    this.value = this.from = this.to = v;
    this.duration = 0;
  }
  update(now: number): number {
    if (this.duration <= 0) return (this.value = this.to);
    const t = Math.min(1, Math.max(0, (now - this.start) / this.duration));
    this.value = this.from + (this.to - this.from) * this.ease(t);
    return this.value;
  }
}

const ARROW = 'M2 2 L2 27 L8.5 21 L13 31 L17.5 29 L13 19.5 L22 19.5 Z';

export class MenuCursor {
  readonly el: HTMLDivElement;
  private readonly inner: HTMLDivElement;
  private readonly additive: SVGElement;
  private x = -100;
  private y = -100;
  private readonly alpha = new Tween(0);
  private readonly scale = new Tween(1);
  private readonly rotation = new Tween(0);
  private readonly additiveAlpha = new Tween(0);
  private dragState: 'none' | 'started' | 'rotating' = 'none';
  private mouseDown = { x: 0, y: 0 };
  private lastMove = { x: 0, y: 0 };
  private lastInputWasMouse = false;
  private visible = false;
  private lastFrame = performance.now();

  constructor(private readonly game: Game) {
    const svg = (cls: string, fill: string, stroke: string) =>
      `<svg class="${cls}" viewBox="0 0 34 34" width="34" height="34" aria-hidden="true"><path d="${ARROW}" fill="${fill}" stroke="${stroke}" stroke-width="2" stroke-linejoin="round"/></svg>`;
    this.inner = h('div', { class: 'menu-cursor-inner' });
    this.inner.innerHTML = svg('mc-base', '#fff', 'rgba(0,0,0,0.65)') + svg('mc-additive', '#c77dff', 'transparent');
    this.additive = this.inner.querySelector('.mc-additive') as SVGElement;
    this.el = h('div', { class: 'menu-cursor' }, this.inner);
    window.addEventListener('pointermove', this.onMove, { passive: true });
    window.addEventListener('pointerdown', this.onDown, { passive: true });
    window.addEventListener('pointerup', this.onUp, { passive: true });
    window.addEventListener('keydown', e => {
      if (!e.repeat) this.lastInputWasMouse = false;
    });
    document.documentElement.addEventListener('pointerleave', () => (this.outside = true));
    document.documentElement.addEventListener('pointerenter', () => (this.outside = false));
    requestAnimationFrame(this.frame);
  }

  private outside = false;

  private readonly onMove = (e: PointerEvent): void => {
    this.lastInputWasMouse = e.pointerType === 'mouse';
    this.x = e.clientX;
    this.y = e.clientY;
    if (this.dragState === 'none') return;
    this.lastMove = { x: e.clientX, y: e.clientY };
    const distance = Math.hypot(this.lastMove.x - this.mouseDown.x, this.lastMove.y - this.mouseDown.y);
    if (this.dragState === 'started' && distance > 80) this.dragState = 'rotating';
    if (this.dragState === 'rotating' && distance > 0) {
      const ox = this.lastMove.x - this.mouseDown.x;
      const oy = this.lastMove.y - this.mouseDown.y;
      let degrees = (Math.atan2(-ox, oy) * 180) / Math.PI + 24.3;
      let diff = (degrees - this.rotation.value) % 360;
      if (diff < -180) diff += 360;
      if (diff > 180) diff -= 360;
      degrees = this.rotation.value + diff;
      this.rotation.go(degrees, 120, outQuint, performance.now());
    }
  };

  private readonly onDown = (e: PointerEvent): void => {
    this.lastInputWasMouse = e.pointerType === 'mouse';
    if (!this.lastInputWasMouse) return;
    const now = performance.now();
    if (this.visible) {
      this.scale.set(1);
      this.scale.go(0.9, 800, outQuint, now);
      this.additiveAlpha.set(0);
      this.additiveAlpha.go(1, 800, outQuint, now);
      if (settings.get('ui.cursorRotation', true) && this.dragState !== 'rotating') {
        this.dragState = 'started';
        this.mouseDown = { x: e.clientX, y: e.clientY };
      }
      this.playTap(1);
    }
  };

  private readonly onUp = (e: PointerEvent): void => {
    if (e.pointerType !== 'mouse' || e.buttons !== 0) return;
    const now = performance.now();
    this.additiveAlpha.set(1);
    this.additiveAlpha.go(0, 500, outQuint, now);
    this.scale.go(1, 500, outElastic, now);
    if (this.dragState !== 'none') {
      this.rotation.go(0, 400 * (0.5 + Math.abs(this.rotation.value / 960)), outElasticQuarter, now);
      this.dragState = 'none';
    }
    if (this.visible) this.playTap(0.8);
  };

  /** playTapSample: frequency jitter ±1%, panned by position (SFX_STEREO_STRENGTH 0.75). */
  private playTap(base: number): void {
    this.game.playUiSample('cursor-tap', base, base - 0.01 + Math.random() * 0.02);
  }

  private readonly frame = (): void => {
    const now = performance.now();
    const elapsed = now - this.lastFrame;
    this.lastFrame = now;
    const screen = this.game.currentScreen;
    const want = (screen ? screen.cursorVisible : true) && this.lastInputWasMouse && !this.outside;
    if (want !== this.visible) {
      this.visible = want;
      document.documentElement.classList.toggle('menu-cursor-active', want);
      if (want) {
        this.alpha.go(1, 250, outQuint, now);
        this.scale.go(1, 400, outQuint, now);
      } else {
        this.alpha.go(0, 250, outQuint, now);
        this.scale.go(0.6, 250, easeIn, now);
      }
      if (this.dragState === 'none') this.rotation.go(0, 400, outQuint, now);
    }
    // Floating rotation centre once far enough from the press position.
    if (this.dragState !== 'none' && Math.hypot(this.mouseDown.x - this.lastMove.x, this.mouseDown.y - this.lastMove.y) > 60) {
      const t = Math.min(1, elapsed / 1000) * 0.04 * 60;
      this.mouseDown = { x: this.mouseDown.x + (this.lastMove.x - this.mouseDown.x) * Math.min(1, t), y: this.mouseDown.y + (this.lastMove.y - this.mouseDown.y) * Math.min(1, t) };
    }
    const a = this.alpha.update(now);
    const s = this.scale.update(now) * settings.get('ui.menuCursorSize', 1);
    const r = this.rotation.update(now);
    this.el.style.opacity = String(a);
    this.el.style.transform = `translate(${this.x}px, ${this.y}px)`;
    this.inner.style.transform = `rotate(${r}deg) scale(${s})`;
    this.additive.style.opacity = String(this.additiveAlpha.update(now));
    requestAnimationFrame(this.frame);
  };
}
