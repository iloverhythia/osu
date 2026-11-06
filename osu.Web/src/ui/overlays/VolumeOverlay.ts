// Port of osu.Game/Overlays/VolumeOverlay.cs, Volume/VolumeMeter.cs, Volume/MasterVolumeMeter.cs and Volume/MuteButton.cs:
// master / music / effect / hitsound meters at the left edge, adjusted with the mouse wheel (ScrollAdjustsVolume),
// Alt+Up / Alt+Down, Alt+Left / Alt+Right to change meter and Ctrl+F4 to mute.

import './volume.css';
import { settings } from '../../framework/Settings';
import { h } from '../dom';
import type { Game } from '../Game';

const OFFSET = 10;
const ADJUST_STEP = 0.01;
const MAX_ACCELERATION = 5;
const ACCELERATION_MULTIPLIER = 1.8;
const PROGRESS_START_RADIUS = 0.75;
const PROGRESS_SIZE = 0.03;
const PINK_DARKER = '#bb1177';
const BLUE_DARKER = '#2299bb';
const GRAY1 = '#111111';

class VolumeMeter {
  readonly el: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly text: HTMLDivElement;
  private displayVolume: number;
  private displayFrom = 0;
  private displayTarget = 0;
  private displayStart = 0;
  private displayVolumeInt: number | null = null;
  private lastTick = 0;
  private scrollAccumulation = 0;
  private acceleration = 1;
  private accelerationTimer = 0;
  private dragY: number | null = null;
  private dragDelta = 0;
  selected = false;

  constructor(
    private readonly game: Game,
    readonly label: string,
    readonly size: number,
    readonly colour: string,
    readonly key: string,
    private readonly onInteract: (m: VolumeMeter) => void,
  ) {
    this.canvas = h('canvas', { class: 'vm-canvas' }) as HTMLCanvasElement;
    this.text = h('div', { class: 'vm-text', style: { fontSize: `${0.16 * size}px` } });
    const circle = h('div', { class: 'vm-circle', style: { width: `${size}px`, height: `${size}px` } }, this.canvas, this.text);
    circle.style.setProperty('--vm-colour', colour);
    this.el = h('div', { class: 'volume-meter' }, circle, h('div', { class: 'vm-label', style: { marginLeft: `${OFFSET}px` } }, label));
    this.displayVolume = this.volume;
    this.displayTarget = this.volume;
    this.el.addEventListener('pointermove', () => this.onInteract(this));
    this.el.addEventListener('pointerenter', () => this.onInteract(this));
    this.el.addEventListener('wheel', e => {
      e.preventDefault();
      e.stopPropagation();
      this.onInteract(this);
      this.adjust(-Math.sign(e.deltaY) * (e.deltaMode === 0 && Math.abs(e.deltaY) < 50 ? Math.abs(e.deltaY) / 50 : 1), e.deltaMode === 0 && Math.abs(e.deltaY) < 50);
    }, { passive: false });
    // OnDrag: vertical drag adjusts, 200px per full range.
    this.el.addEventListener('pointerdown', e => {
      e.stopPropagation();
      this.dragY = e.clientY;
      this.dragDelta = 0;
      this.el.setPointerCapture(e.pointerId);
    });
    this.el.addEventListener('pointermove', e => {
      if (this.dragY == null) return;
      this.dragDelta += (e.clientY - this.dragY) / 200;
      this.dragY = e.clientY;
      if (Math.abs(this.dragDelta) < 0.01) return;
      this.volume = this.volume - this.dragDelta;
      this.dragDelta = 0;
    });
    const endDrag = () => (this.dragY = null);
    this.el.addEventListener('pointerup', endDrag);
    this.el.addEventListener('pointercancel', endDrag);
    this.draw();
  }

  get volume(): number {
    return settings.get<number>(this.key, 1);
  }

  set volume(v: number) {
    const clamped = Math.round(Math.min(1, Math.max(0, v)) * 100) / 100;
    if (clamped !== this.volume) settings.set(this.key, clamped);
  }

  setSelected(v: boolean): void {
    if (v === this.selected) return;
    this.selected = v;
    this.el.classList.toggle('selected', v);
    if (v) this.game.playUiSample('menu-hover', 0.5);
  }

  /** VolumeMeter.adjust with acceleration (reset after 150ms of inactivity). */
  adjust(delta: number, isPrecise: boolean): void {
    if (delta === 0) return;
    clearTimeout(this.accelerationTimer);
    this.accelerationTimer = window.setTimeout(() => (this.acceleration = 1), 150);
    delta *= this.acceleration;
    this.acceleration = Math.min(MAX_ACCELERATION, this.acceleration * ACCELERATION_MULTIPLIER);
    const precision = 0.01;
    if (isPrecise) {
      this.scrollAccumulation += delta * ADJUST_STEP;
      let v = this.volume;
      while (Math.abs(this.scrollAccumulation) >= precision - 1e-9) {
        v += Math.sign(this.scrollAccumulation) * precision;
        this.scrollAccumulation = this.scrollAccumulation < 0 ? Math.min(0, this.scrollAccumulation + precision) : Math.max(0, this.scrollAccumulation - precision);
      }
      this.volume = v;
    } else this.volume = this.volume + Math.sign(delta) * Math.max(precision, Math.abs(delta * ADJUST_STEP));
  }

  /** Bindable change → TransformTo(DisplayVolume, value, 400, OutQuint). */
  update(now: number): void {
    const target = this.volume;
    if (target !== this.displayTarget) {
      this.displayFrom = this.displayVolume;
      this.displayTarget = target;
      this.displayStart = now;
    }
    const t = Math.min(1, (now - this.displayStart) / 400);
    const v = this.displayFrom + (this.displayTarget - this.displayFrom) * (1 - Math.pow(1 - t, 5));
    if (v !== this.displayVolume || this.displayVolumeInt == null) {
      this.displayVolume = t >= 1 ? this.displayTarget : v;
      this.draw();
      const intValue = Math.round(this.displayVolume * 100);
      if (intValue !== this.displayVolumeInt) {
        const first = this.displayVolumeInt == null;
        this.displayVolumeInt = intValue;
        if (!first) this.playTick(now);
      }
    }
  }

  private playTick(now: number): void {
    if (now - this.lastTick <= 30) return;
    let rate = 0.99 + Math.random() * 0.02 + this.displayVolume * 0.1;
    if (this.displayVolumeInt === 0 || this.displayVolumeInt === 100) rate -= 0.5;
    this.game.playUiSample('notch-tick', 1, rate);
    this.lastTick = now;
  }

  private draw(): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const s = this.size;
    if (this.canvas.width !== s * dpr) {
      this.canvas.width = this.canvas.height = s * dpr;
      this.canvas.style.width = this.canvas.style.height = `${s}px`;
    }
    const g = this.canvas.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, s, s);
    const c = s / 2;
    g.fillStyle = GRAY1;
    g.beginPath();
    g.arc(c, c, c, 0, Math.PI * 2);
    g.fill();
    // CircularProgress rotated 180°: starts at the bottom and sweeps clockwise, 0.75 of a turn at full volume.
    const r0 = (s * PROGRESS_START_RADIUS) / 2;
    const r1 = (s * (PROGRESS_START_RADIUS + PROGRESS_SIZE)) / 2;
    const start = Math.PI / 2;
    const sweep = this.displayVolume * 0.75 * Math.PI * 2;
    if (sweep > 0) {
      // Glow (GlowEffect, BlurSigma 5, Strength 5)
      g.save();
      g.shadowColor = this.colour;
      g.shadowBlur = 10;
      g.strokeStyle = this.colour;
      g.lineWidth = (r1 - r0) * 0.8;
      g.beginPath();
      g.arc(c, c, (r0 + r1) / 2, start, start + sweep);
      g.stroke();
      g.restore();
      g.fillStyle = '#fff';
      g.beginPath();
      g.arc(c, c, r1, start, start + sweep);
      g.arc(c, c, r0, start + sweep, start, true);
      g.closePath();
      g.fill();
    }
    const max = this.displayVolume >= 0.995;
    this.text.textContent = max ? 'MAX' : String(Math.round(this.displayVolume * 100));
    this.text.classList.toggle('max', max);
  }
}

export class VolumeOverlay {
  readonly el: HTMLDivElement;
  private readonly meters: VolumeMeter[];
  private readonly muteButton: HTMLButtonElement;
  private visible = false;
  private hovered = false;
  private hideTimer = 0;
  private selectedIndex = 0;
  muted = false;

  constructor(private readonly game: Game) {
    const select = (m: VolumeMeter) => this.select(this.meters.indexOf(m));
    this.meters = [
      new VolumeMeter(game, 'MASTER', 140, PINK_DARKER, 'audio.master', select),
      new VolumeMeter(game, 'MUSIC', 100, BLUE_DARKER, 'audio.music', select),
      new VolumeMeter(game, 'EFFECT', 100, BLUE_DARKER, 'audio.effects', select),
      new VolumeMeter(game, 'HITSOUND', 100, BLUE_DARKER, 'audio.hitsound', select),
    ];
    // MuteButton on the master meter (X = CircleSize / 2, Y = CircleSize × 0.23 from the vertical centre).
    this.muteButton = h('button', { class: 'vm-mute', title: 'Mute (Ctrl+F4)' }, '🔊') as HTMLButtonElement;
    this.muteButton.addEventListener('click', e => {
      e.stopPropagation();
      this.toggleMute();
    });
    this.meters[0].el.querySelector('.vm-circle')!.appendChild(this.muteButton);
    this.el = h('div', { class: 'volume-overlay' }, h('div', { class: 'vo-bg' }), h('div', { class: 'vo-meters' }, ...this.meters.map(m => m.el)));
    this.el.addEventListener('pointerenter', () => {
      this.hovered = true;
      this.schedulePopOut();
    });
    this.el.addEventListener('pointerleave', () => {
      this.hovered = false;
      this.schedulePopOut();
    });
    this.el.addEventListener('pointermove', () => this.schedulePopOut());
    settings.subscribe(k => {
      if (this.meters.some(m => m.key === k)) this.show();
    });
    const loop = () => {
      if (this.visible || this.el.style.opacity !== '0') for (const m of this.meters) m.update(performance.now());
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    this.el.style.opacity = '0';
    this.el.style.pointerEvents = 'none';
  }

  private select(i: number): void {
    if (i < 0) return;
    this.selectedIndex = i;
    this.meters.forEach((m, j) => m.setSelected(j === i));
  }

  show(): void {
    if (!this.visible) this.select(0); // FocusMasterVolume
    this.visible = true;
    this.el.style.transition = 'opacity 100ms';
    this.el.style.opacity = '1';
    this.el.style.pointerEvents = 'auto';
    this.schedulePopOut();
  }

  hide(): void {
    this.visible = false;
    this.el.style.opacity = '0';
    this.el.style.pointerEvents = 'none';
    this.meters.forEach(m => m.setSelected(false));
  }

  private schedulePopOut(): void {
    clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => {
      if (!this.hovered) this.hide();
      else this.schedulePopOut();
    }, 1000);
  }

  toggleMute(): void {
    this.show();
    this.muted = !this.muted;
    this.muteButton.textContent = this.muted ? '🔇' : '🔊';
    this.muteButton.classList.toggle('muted', this.muted);
    this.game.applyMute(this.muted);
  }

  /** VolumeOverlay.Adjust */
  adjust(action: 'increase' | 'decrease' | 'next' | 'previous', amount = 1, isPrecise = false): boolean {
    switch (action) {
      case 'increase':
      case 'decrease':
        if (!this.visible) this.show();
        else this.meters[this.selectedIndex].adjust(action === 'increase' ? amount : -amount, isPrecise);
        this.show();
        return true;
      case 'next':
      case 'previous':
        if (!this.visible) return false;
        this.select((this.selectedIndex + (action === 'next' ? 1 : this.meters.length - 1)) % this.meters.length);
        this.show();
        return true;
    }
  }
}
