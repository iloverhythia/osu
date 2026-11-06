// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game/Screens/Menu/OsuLogo.cs (logo, beat pulse, ripple, flash, impact, hover/press/drag, triangles,
// visualiser). The osu! logo texture is replaced by a procedurally drawn JarvSU logo (purple disc, white ring, wordmark).

import { APP_NAME } from '../../brand';
import type { EffectControlPoint, TimingControlPoint } from '../../game/beatmaps/ControlPoints';
import type { Game } from '../Game';
import { TrianglesV2 } from '../Triangles';
import { BeatSync, type ChannelAmplitudes, type MenuBeatSource } from './BeatSync';
import { LogoVisualisation } from './LogoVisualisation';
import { Anim, damp, Easing, Scheduler } from './Transforms';

const TRANSITION_LENGTH = 300;
/** The osu! logo sprite has a shadow included in its texture; this matches the precise edge of the logo's border. */
export const SCALE_ADJUST = 0.94;
/** Draw size of the logo sprite (the 1024px @2x texture). */
export const LOGO_SIZE = 512;
const VISUALIZER_DEFAULT_ALPHA = 0.5;
const EARLY_ACTIVATION = 60;
const TRIANGLES_PAUSED_VELOCITY = 0.5;
const BEAT_SAMPLE_VARIANCE = 0.1;

// JarvSU colours in place of the osu! pink logo gradients (ff66ab → cc5289 fill, ff66ab → b6346f triangles).
const FILL_TOP = '#9b30ff';
const FILL_BOTTOM = '#7a1fd6';
const TRIANGLES_TOP = '#9b30ff';
const TRIANGLES_BOTTOM = '#5c159f';

export class OsuLogo {
  /** Relative (0..1) position of the logo centre on screen (RelativePositionAxes = Both). */
  readonly x = new Anim(0.5);
  readonly y = new Anim(0.5);
  readonly scale = new Anim(1);
  readonly alpha = new Anim(1);

  private readonly hoverScale = new Anim(1);
  private readonly hoverAlpha = new Anim(1);
  private readonly bounceScale = new Anim(1);
  private readonly bounceX = new Anim(0);
  private readonly bounceY = new Anim(0);
  private amplitudeScale = 1;
  private readonly beatScale = new Anim(1);
  private readonly rippleScale = new Anim(1);
  private readonly rippleAlpha = new Anim(0);
  private readonly rippleContainerAlpha = new Anim(1);
  private readonly trianglesAlpha = new Anim(1);
  private readonly flashAlpha = new Anim(0);
  private readonly visualiserAlpha = new Anim(VISUALIZER_DEFAULT_ALPHA);
  private readonly impactAlpha = new Anim(0);
  private readonly impactScale = new Anim(1);

  private readonly triangles = new TrianglesV2();
  private readonly visualiser: LogoVisualisation;
  private readonly beat: BeatSync;
  readonly scheduler = new Scheduler();

  /** Return value decides whether the logo should play its own sample for the click action. */
  action: (() => boolean) | null = null;
  isTracking = false;
  /** Screen pixels per logical pixel (the menu's UI scale). */
  uiScale = 1;

  /** The circular hit area (`.logo`), positioned over the logo each frame. */
  readonly el: HTMLButtonElement;

  private hovered = false;
  private lastBeatIndex = 0;
  private sprite: HTMLCanvasElement | null = null;
  private spriteRes = 0;
  private dragStart: { x: number; y: number } | null = null;
  private dragging = false;
  private pointerDown = false;
  private time = 0;

  constructor(
    private readonly game: Game,
    private readonly source: MenuBeatSource,
  ) {
    this.triangles.thickness = 0.009;
    this.triangles.scaleAdjust = 3;
    this.triangles.spawnRatio = 1.4;
    this.visualiser = new LogoVisualisation(source);
    this.beat = new BeatSync((i, tp, ep, amps, t) => this.onNewBeat(i, tp, ep, amps, t));
    this.beat.earlyActivationMilliseconds = EARLY_ACTIVATION;

    this.el = document.createElement('button');
    this.el.className = 'logo';
    this.el.setAttribute('aria-label', APP_NAME);
    this.el.addEventListener('pointerenter', () => this.onHover());
    this.el.addEventListener('pointerleave', () => this.onHoverLost());
    this.el.addEventListener('pointerdown', e => this.onMouseDown(e));
    window.addEventListener('pointermove', e => this.onPointerMove(e));
    window.addEventListener('pointerup', e => this.onMouseUp(e));
    this.el.addEventListener('click', e => {
      e.preventDefault();
      this.onClick();
    });
    this.el.addEventListener('keydown', e => {
      // Keyboard is handled by the button system (ButtonSystem.OnKeyDown); don't let the browser "click" the focused logo.
      if (e.code === 'Enter' || e.code === 'Space') e.preventDefault();
    });
  }

  set showTriangles(v: boolean) {
    this.trianglesAlpha.to(v ? 1 : 0, this.time, TRANSITION_LENGTH, Easing.OutQuint);
  }

  set showRipple(v: boolean) {
    this.rippleContainerAlpha.to(v ? 1 : 0, this.time, TRANSITION_LENGTH, Easing.OutQuint);
  }

  /** SizeForFlow: the logo sprite size with respect to the bounce and hover scale (not the logo's own scale). */
  get sizeForFlow(): number {
    return LOGO_SIZE * this.bounceScale.value * this.hoverScale.value;
  }

  private get handlesPositionalInput(): boolean {
    return this.alpha.value > 0.2 && this.hoverAlpha.value > 0;
  }

  // ---------------------------------------------------------------- beat

  private onNewBeat(beatIndex: number, timingPoint: TimingControlPoint, effectPoint: EffectControlPoint, amplitudes: ChannelAmplitudes, t: number): void {
    this.lastBeatIndex = beatIndex;
    const beatLength = timingPoint.beatLength;
    const amplitudeAdjust = Math.min(1, 0.4 + amplitudes.maximum);

    if (beatIndex < 0) return;

    if (this.action && this.hovered) {
      this.scheduler.add(t + EARLY_ACTIVATION, () => {
        if (beatIndex % timingPoint.timeSignature === 0) this.playSample('metronomelow', 0.5, 0.8);
        else this.playSample('metronomelow', 0.35, 1 - BEAT_SAMPLE_VARIANCE / 2 + Math.random() * BEAT_SAMPLE_VARIANCE);
      });
    }

    this.beatScale.to(1 - 0.02 * amplitudeAdjust, t, EARLY_ACTIVATION, Easing.Out).to(1, t + EARLY_ACTIVATION, beatLength * 2, Easing.OutQuint);

    this.rippleScale.clear().to(this.amplitudeScale, t).to(this.amplitudeScale * (1 + 0.04 * amplitudeAdjust), t, beatLength, Easing.OutQuint);
    this.rippleAlpha.clear().to(0.15 * amplitudeAdjust, t).to(0, t, beatLength, Easing.OutQuint);

    if (effectPoint.kiaiMode && this.flashAlpha.value < 0.4) {
      this.flashAlpha.clear().to(0.2 * amplitudeAdjust, t, EARLY_ACTIVATION, Easing.Out).to(0, t + EARLY_ACTIVATION, beatLength);
      this.visualiserAlpha
        .clear()
        .to(VISUALIZER_DEFAULT_ALPHA * 1.8 * amplitudeAdjust, t, EARLY_ACTIVATION, Easing.Out)
        .to(VISUALIZER_DEFAULT_ALPHA, t + EARLY_ACTIVATION, beatLength);
    }

    this.scheduler.add(t + EARLY_ACTIVATION, () => {
      this.triangles.velocity += amplitudeAdjust * (effectPoint.kiaiMode ? 6 : 3);
    });
  }

  private playSample(name: string, volume: number, rate = 1): void {
    const audio = this.game.audio;
    const b = audio?.getDefaultSample(name);
    if (audio && b) audio.play(b, { volume, rate });
  }

  // ---------------------------------------------------------------- input

  private onHover(): void {
    this.hovered = true;
    if (!this.handlesPositionalInput) return;
    if (this.action) this.hoverScale.to(1.1, this.time, 500, Easing.OutElastic);
  }

  private onHoverLost(): void {
    this.hovered = false;
    this.hoverScale.to(1, this.time, 500, Easing.OutElastic);
  }

  private onMouseDown(e: PointerEvent): void {
    if (e.button !== 0 || !this.handlesPositionalInput) return;
    this.pointerDown = true;
    this.dragStart = { x: e.clientX, y: e.clientY };
    this.dragging = false;
    this.bounceScale.to(0.9, this.time, 1000, Easing.Out);
  }

  private onPointerMove(e: PointerEvent): void {
    if (!this.pointerDown || !this.dragStart) return;
    let dx = (e.clientX - this.dragStart.x) / this.uiScale;
    let dy = (e.clientY - this.dragStart.y) / this.uiScale;
    const len = Math.hypot(dx, dy);
    if (!this.dragging && len < 10) return;
    this.dragging = true;
    // Diminish the drag distance as we go further to simulate "rubber band" feeling.
    const k = len <= 0 ? 0 : Math.pow(len, 0.6) / len;
    dx *= k;
    dy *= k;
    // MoveTo in the bounce container's parent space.
    const s = this.scale.value * this.hoverScale.value || 1;
    this.bounceX.set(dx / s);
    this.bounceY.set(dy / s);
  }

  private onMouseUp(e: PointerEvent): void {
    if (e.button !== 0 || !this.pointerDown) return;
    this.pointerDown = false;
    this.bounceScale.to(1, this.time, 500, Easing.OutElastic);
    if (this.dragging) {
      this.bounceX.to(0, this.time, 800, Easing.OutElastic);
      this.bounceY.to(0, this.time, 800, Easing.OutElastic);
    }
    this.dragging = false;
    this.dragStart = null;
  }

  /** OnClick / TriggerClick. */
  triggerClick(): void {
    this.onClick(true);
  }

  private onClick(force = false): void {
    if (!force && !this.handlesPositionalInput) return;
    this.flashAlpha.clear().set(0.4).to(0, this.time, 1500, Easing.OutExpo);
    if (this.action?.() === true) this.playSample('menu-confirm', 0.6);
  }

  impact(): void {
    this.impactAlpha.clear().set(1).to(0, this.time, 250, Easing.In);
    this.impactScale.clear().set(SCALE_ADJUST).to(1.12, this.time, 250);
  }

  /** PlayIntro-less equivalent used by the intro: hides the logo's content until it is faded in. */
  hide(): void {
    this.alpha.set(0);
  }

  // ---------------------------------------------------------------- frame

  update(now: number, elapsed: number, frame: number): void {
    this.time = now;
    this.scheduler.update(now);
    this.beat.update(now, this.source, frame);

    for (const a of [this.x, this.y, this.scale, this.alpha, this.hoverScale, this.hoverAlpha, this.bounceScale, this.bounceX, this.bounceY, this.beatScale, this.rippleScale, this.rippleAlpha, this.rippleContainerAlpha, this.trianglesAlpha, this.flashAlpha, this.visualiserAlpha, this.impactAlpha, this.impactScale])
      a.update(now);

    const scaleAdjustCutoff = 0.4;
    if (this.source.running) {
      const maxAmplitude = this.lastBeatIndex >= 0 ? this.source.currentAmplitudes(frame).maximum : 0;
      this.amplitudeScale = damp(this.amplitudeScale, 1 - Math.max(0, maxAmplitude - scaleAdjustCutoff) * 0.04, 0.9, elapsed);
      this.triangles.velocity = damp(this.triangles.velocity, TRIANGLES_PAUSED_VELOCITY * (this.beat.isKiaiTime ? 4 : 2), 0.995, elapsed);
    } else {
      this.triangles.velocity = damp(this.triangles.velocity, TRIANGLES_PAUSED_VELOCITY, 0.9, elapsed);
    }

    this.triangles.update(elapsed, LOGO_SIZE, LOGO_SIZE);
    this.visualiser.update(now, elapsed, frame);
  }

  /** Total scale of the logo elements (logo · hover · bounce · amplitude · beat). */
  private get elementScale(): number {
    return this.scale.value * this.hoverScale.value * this.bounceScale.value * this.amplitudeScale * this.beatScale.value;
  }

  private centre(w: number, h: number): [number, number] {
    const s = this.scale.value * this.hoverScale.value;
    return [this.x.value * w + this.bounceX.value * s, this.y.value * h + this.bounceY.value * s];
  }

  /** Positions the hit area over the logo circle (logoContainer). */
  layoutHitArea(w: number, h: number): void {
    const [cx, cy] = this.centre(w, h);
    const r = (LOGO_SIZE / 2) * SCALE_ADJUST * this.elementScale;
    const st = this.el.style;
    st.left = `${cx - r}px`;
    st.top = `${cy - r}px`;
    st.width = st.height = `${Math.max(0, 2 * r)}px`;
    st.pointerEvents = this.handlesPositionalInput ? 'auto' : 'none';
    st.visibility = this.alpha.value > 0 ? 'visible' : 'hidden';
  }

  /** Additive layer behind the logo: the visualiser and the ripple. */
  drawAdditive(g: CanvasRenderingContext2D, w: number, h: number): void {
    const alpha = this.alpha.value * this.hoverAlpha.value;
    if (alpha <= 0) return;
    const [cx, cy] = this.centre(w, h);
    const s = this.elementScale;
    const vSize = LOGO_SIZE * SCALE_ADJUST * s;
    this.visualiser.draw(g, cx, cy, vSize, s, alpha * this.visualiserAlpha.value);

    const ra = alpha * this.rippleContainerAlpha.value * this.rippleAlpha.value;
    if (ra > 0) {
      const rs = this.scale.value * this.hoverScale.value * this.bounceScale.value * this.rippleScale.value;
      const sprite = this.getSprite(LOGO_SIZE * rs);
      const size = LOGO_SIZE * rs;
      g.globalAlpha = ra;
      g.drawImage(sprite, cx - size / 2, cy - size / 2, size, size);
      g.globalAlpha = 1;
    }
  }

  /** The logo itself (normal blending). */
  draw(g: CanvasRenderingContext2D, w: number, h: number): void {
    const alpha = this.alpha.value * this.hoverAlpha.value;
    if (alpha <= 0) return;
    const [cx, cy] = this.centre(w, h);
    const s = this.elementScale;
    const r = (LOGO_SIZE / 2) * SCALE_ADJUST * s;
    g.save();
    g.globalAlpha = alpha;

    // logoContainer (circular mask) → colour + triangles, flash layer.
    g.save();
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.clip();
    const fill = g.createLinearGradient(0, cy - r, 0, cy + r);
    fill.addColorStop(0, FILL_TOP);
    fill.addColorStop(1, FILL_BOTTOM);
    const ct = this.trianglesAlpha.value;
    if (ct > 0) {
      g.globalAlpha = alpha * ct;
      g.fillStyle = fill;
      g.fillRect(cx - r, cy - r, 2 * r, 2 * r);
      g.save();
      const k = SCALE_ADJUST * s;
      g.translate(cx - (LOGO_SIZE / 2) * k, cy - (LOGO_SIZE / 2) * k);
      g.scale(k, k);
      const tg = g.createLinearGradient(0, 0, 0, LOGO_SIZE);
      tg.addColorStop(0, TRIANGLES_TOP);
      tg.addColorStop(1, TRIANGLES_BOTTOM);
      this.triangles.draw(g, LOGO_SIZE, LOGO_SIZE, tg);
      g.restore();
    }
    const fl = this.flashAlpha.value;
    if (fl > 0) {
      g.globalAlpha = alpha * fl;
      g.globalCompositeOperation = 'lighter';
      g.fillStyle = '#fff';
      g.fillRect(cx - r, cy - r, 2 * r, 2 * r);
      g.globalCompositeOperation = 'source-over';
    }
    g.restore();

    // The logo sprite.
    const size = LOGO_SIZE * s;
    g.globalAlpha = alpha;
    g.drawImage(this.getSprite(size), cx - size / 2, cy - size / 2, size, size);

    // Impact ring (CircularContainer, BorderThickness = 10, relative to the beat container).
    const ia = this.impactAlpha.value;
    if (ia > 0) {
      const is = s * this.impactScale.value;
      const ir = (LOGO_SIZE / 2) * is;
      const bw = 10 * is;
      g.globalAlpha = alpha * ia;
      g.strokeStyle = '#fff';
      g.lineWidth = bw;
      g.beginPath();
      g.arc(cx, cy, ir - bw / 2, 0, Math.PI * 2);
      g.stroke();
    }
    g.restore();
  }

  /** Renders (and caches) the logo sprite: white ring, wordmark and the drop shadow the osu! texture includes. */
  private getSprite(displaySize: number): HTMLCanvasElement {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const res = Math.min(2048, Math.max(64, Math.ceil((displaySize * dpr) / 128) * 128));
    if (this.sprite && this.spriteRes >= res) return this.sprite;
    const c = document.createElement('canvas');
    c.width = c.height = res;
    const g = c.getContext('2d')!;
    const k = res / LOGO_SIZE;
    g.scale(k, k);
    const cx = LOGO_SIZE / 2;
    const r = (LOGO_SIZE / 2) * SCALE_ADJUST;
    const ring = 2 * r * 0.045;
    g.save();
    g.shadowColor = 'rgba(0,0,0,0.35)';
    g.shadowBlur = 12;
    g.shadowOffsetY = 3;
    g.strokeStyle = '#fff';
    g.lineWidth = ring;
    g.beginPath();
    g.arc(cx, cx, r - ring / 2, 0, Math.PI * 2);
    g.stroke();
    g.restore();
    g.save();
    g.shadowColor = 'rgba(0,0,0,0.25)';
    g.shadowBlur = 14;
    g.shadowOffsetY = 4;
    g.fillStyle = '#fff';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `italic 800 ${Math.round(2 * r * 0.2)}px "Exo 2", sans-serif`;
    g.fillText(APP_NAME, cx, cx + 2);
    g.restore();
    this.sprite = c;
    this.spriteRes = res;
    return c;
  }

  /** Invalidates the cached sprite (e.g. once the web font has loaded). */
  invalidateSprite(): void {
    this.sprite = null;
    this.spriteRes = 0;
  }
}
