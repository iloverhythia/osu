// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game/Screens/Play/HUDOverlay.cs (visibility modes, hide targets, top-right element placement) with the default
// layout of osu.Game/Skinning/ArgonSkin.cs (MainHUDComponents, global + ruleset containers) and the ruleset overrides in
// CatchArgonSkinTransformer (ColourHitErrorMeter) and ManiaArgonSkinTransformer (combo counter drawn by the mania playfield here).

import type { ModSet } from '../../game/mods/Mods';
import type { HitResult } from '../../game/scoring/HitResult';
import { Anim, Easing } from './anim';
import { ArgonAccuracyCounter, ArgonComboCounter, ArgonScoreCounter, drawArgonText, measureArgonText } from './ArgonCounter';
import { ArgonHealthDisplay, MAIN_PATH_RADIUS } from './ArgonHealthDisplay';
import { ArgonKeyCounterDisplay, ArgonSongProgress, BarHitErrorMeter, ColourHitErrorMeter, FailingLayer, ModDisplay, drawWedge } from './HudComponents';
import { anchorFraction, loadLayout, type ComponentLayout, type HudComponentId } from './SkinLayout';

/** HUDVisibilityMode */
export type HUDVisibilityMode = 'never' | 'hideDuringGameplay' | 'always';

export const HUD_FADE_DURATION = 300;

export interface HUDOptions {
  rulesetShortName: string;
  mods: ModSet;
  actionCount: number;
  hitWindows: { result: HitResult; length: number }[];
  objectTimes: readonly { start: number; end: number }[];
  replayLoaded: boolean;
  /** HealthProcessor is DrainingHealthProcessor (FailingLayer only shows then). */
  drainingHealth: boolean;
  initialHealth: number;
  /** ModNoFail binds ShowHealthBar to ShowHealthDisplayWhenCantFail. */
  showHealthBar: boolean;
}

export interface HUDFrameState {
  totalScore: number;
  accuracy: number;
  combo: number;
  health: number;
  time: number;
  clockStartTime: number;
  /** Player.LocalUserPlaying (not paused, not in a break, not failed / passed, no replay). */
  isPlaying: boolean;
  keyOverlay: boolean;
  fadePlayfieldWhenHealthLow: boolean;
  showHitErrorMeter: boolean;
}

export class HUDOverlay {
  readonly score = new ArgonScoreCounter();
  readonly accuracy = new ArgonAccuracyCounter();
  readonly combo: ArgonComboCounter | null;
  readonly health = new ArgonHealthDisplay();
  readonly progress = new ArgonSongProgress();
  readonly barMeter: BarHitErrorMeter | null;
  readonly colourMeters: [ColourHitErrorMeter, ColourHitErrorMeter] | null;
  readonly keyCounter: ArgonKeyCounterDisplay;
  readonly modDisplay: ModDisplay;
  readonly failingLayer = new FailingLayer();

  /** ShowHud (disabled for Cinema / rulesets without gameplay overlays). */
  showHud = false;
  showHudDisabled = false;
  holdingForHUD = false;
  mode: HUDVisibilityMode;
  private readonly hideTargetAlpha = new Anim(0);
  private readonly healthAlpha = new Anim(1);
  private lastCombo = 0;
  private lastNow = 0;
  private readonly replayLoaded: boolean;
  private readonly drainingHealth: boolean;
  private readonly showHealthBar: boolean;
  private hoverPos: { x: number; y: number } | null = null;
  /** SkinLayoutInfo for the HUD (editable in the skin editor). */
  layout: Record<HudComponentId, ComponentLayout> = loadLayout();
  private lastModRect: { x: number; y: number; w: number; h: number } | null = null;

  constructor(o: HUDOptions, now: number, mode: HUDVisibilityMode) {
    this.mode = mode;
    this.replayLoaded = o.replayLoaded;
    this.drainingHealth = o.drainingHealth;
    this.showHealthBar = o.showHealthBar;
    // ArgonSkin MainHUDComponents: health width 300, bar height 30, UseRelativeSize false.
    this.health.width = 300;
    this.health.barHeight = 30;
    this.health.start(o.initialHealth, now);
    this.progress.setObjects(o.objectTimes, now);
    this.combo = o.rulesetShortName === 'mania' ? null : new ArgonComboCounter();
    this.colourMeters = o.rulesetShortName === 'fruits' ? [new ColourHitErrorMeter(), new ColourHitErrorMeter()] : null;
    this.barMeter = this.colourMeters ? null : new BarHitErrorMeter(o.hitWindows, now);
    this.keyCounter = new ArgonKeyCounterDisplay(o.actionCount);
    this.modDisplay = new ModDisplay(o.mods, now);
    // HUDOverlay.replayLoaded: ModDisplay.FadeIn(1000) when a replay is loaded, otherwise Delay(2000).FadeOut(200).
    if (o.replayLoaded) this.modDisplay.alpha.to(1, 1000, Easing.OutQuint, now);
    else this.modDisplay.alpha.to(0, 200, Easing.None, now + 2000);
    this.healthAlpha.set(o.showHealthBar ? 1 : 0, now);
    this.updateVisibility(now, false);
  }

  /** HUDOverlay.updateVisibility */
  updateVisibility(now: number, isPlaying: boolean): void {
    if (this.showHudDisabled) return;
    let show: boolean;
    if (this.holdingForHUD) show = true;
    else if (this.mode === 'never') show = false;
    else if (this.mode === 'hideDuringGameplay') show = this.replayLoaded || !isPlaying;
    else show = true;
    this.setShowHud(show, now);
  }

  /** The hide-target alpha (HUD components fade with it). */
  hudAlpha(now: number): number {
    return this.hideTargetAlpha.valueAt(now);
  }

  setShowHud(show: boolean, now: number): void {
    if (show === this.showHud) return;
    this.showHud = show;
    this.hideTargetAlpha.to(show ? 1 : 0, HUD_FADE_DURATION, Easing.OutQuint, now);
  }

  /** Shift+Tab (ToggleInGameInterface) cycles Never → HideDuringGameplay → Always → Never. */
  cycleMode(): HUDVisibilityMode {
    this.mode = this.mode === 'never' ? 'hideDuringGameplay' : this.mode === 'hideDuringGameplay' ? 'always' : 'never';
    return this.mode;
  }

  setPointer(p: { x: number; y: number } | null): void {
    this.hoverPos = p;
  }

  /** ScoreProcessor.NewJudgement → HUD components. */
  onJudgement(r: { isHit: boolean; type: HitResult; timeOffset: number; ignoreHit: boolean; scorable: boolean; bonus: boolean; missWindowZero: boolean; healthIncrease: number }, now: number): void {
    this.health.onNewJudgement(r.isHit, r.ignoreHit, r.healthIncrease);
    if (r.scorable && !r.bonus) {
      if (this.barMeter && r.isHit && !r.missWindowZero) this.barMeter.onNewJudgement(r.timeOffset, r.type, now);
      if (this.colourMeters) for (const m of this.colourMeters) m.onNewJudgement(r.type, now);
    }
  }

  update(now: number, s: HUDFrameState): void {
    const elapsed = this.lastNow === 0 ? 0 : now - this.lastNow;
    this.lastNow = now;
    this.updateVisibility(now, s.isPlaying);
    this.score.rolling.set(s.totalScore, now);
    this.accuracy.rolling.set(s.accuracy, now);
    if (this.combo && s.combo !== this.lastCombo) this.combo.onComboChanged(this.lastCombo, s.combo, now);
    this.lastCombo = s.combo;
    this.health.update(now, elapsed, s.health);
    this.progress.update(s.time, s.clockStartTime, elapsed);
    this.keyCounter.setVisible(this.replayLoaded || s.keyOverlay, now);
    this.modDisplay.update(now);
    this.failingLayer.setShown(this.drainingHealth && s.fadePlayfieldWhenHealthLow && this.showHealthBar, now);
    this.failingLayer.update(s.health, elapsed);
    const r = this.lastModRect;
    const p = this.hoverPos;
    this.modDisplay.setHovered(!!(r && p && p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h), now);
    this.showHitErrorMeter = s.showHitErrorMeter;
  }

  private showHitErrorMeter = true;

  /** The failing layer sits below the main components and isn't affected by HUD visibility. */
  drawFailingLayer(g: CanvasRenderingContext2D, w: number, h: number, now: number): void {
    this.failingLayer.draw(g, w, h, now);
  }

  /** Components present for this ruleset, in draw order. */
  componentIds(): HudComponentId[] {
    const ids: HudComponentId[] = ['wedge1', 'wedge2', 'health', 'score', 'accuracy', 'progress', 'keyCounter'];
    if (this.combo) ids.push('combo');
    if (this.barMeter || this.colourMeters) ids.push('hitErrorLeft', 'hitErrorRight');
    return ids;
  }

  /** The component's unscaled size (its DrawSize). */
  componentSize(id: HudComponentId, g: CanvasRenderingContext2D, w: number, now: number): { w: number; h: number } {
    switch (id) {
      case 'wedge1':
      case 'wedge2':
        return { w: 380, h: 72 };
      case 'health':
        return { w: this.health.width, h: this.health.barHeight + MAIN_PATH_RADIUS * 2 };
      case 'score': {
        const m = measureArgonText(g, this.score.options(now));
        return { w: m.width, h: m.height };
      }
      case 'accuracy': {
        const m = this.accuracy.measure(g, now);
        return { w: m.width, h: m.height };
      }
      case 'combo': {
        if (!this.combo) return { w: 0, h: 0 };
        const m = measureArgonText(g, this.combo.options(now));
        return { w: m.width, h: m.height };
      }
      case 'progress':
        // RelativeSizeAxes.X: the width follows the screen (scaled by its X scale).
        return { w, h: this.progress.height };
      case 'keyCounter':
        return { w: Math.max(this.keyCounter.width, 1), h: ArgonKeyCounterDisplay.KEY_H };
      case 'hitErrorLeft':
      case 'hitErrorRight':
        return this.colourMeters ? { w: 8, h: this.colourMeters[0].height } : { w: BarHitErrorMeter.WIDTH, h: BarHitErrorMeter.HEIGHT };
    }
  }

  /** Screen-space transform for a component: the anchor point plus position, then rotation and scale about the origin. */
  componentTransform(id: HudComponentId, g: CanvasRenderingContext2D, w: number, h: number, now: number): { x: number; y: number; size: { w: number; h: number }; l: ComponentLayout } {
    const l = this.layout[id];
    const a = anchorFraction(l.anchor);
    return { x: a.x * w + l.x, y: a.y * h + l.y, size: this.componentSize(id, g, w, now), l };
  }

  /** The component's axis-aligned screen bounds (for the skin editor). */
  componentBounds(id: HudComponentId, g: CanvasRenderingContext2D, w: number, h: number, now: number): { x: number; y: number; w: number; h: number } {
    const t = this.componentTransform(id, g, w, h, now);
    const o = anchorFraction(t.l.origin);
    const cw = t.size.w * t.l.scaleX;
    const ch = t.size.h * t.l.scaleY;
    const corners = [
      [-o.x * cw, -o.y * ch],
      [(1 - o.x) * cw, -o.y * ch],
      [-o.x * cw, (1 - o.y) * ch],
      [(1 - o.x) * cw, (1 - o.y) * ch],
    ].map(([px, py]) => {
      const r = (t.l.rotation * Math.PI) / 180;
      return [t.x + px * Math.cos(r) - py * Math.sin(r), t.y + px * Math.sin(r) + py * Math.cos(r)];
    });
    const xs = corners.map(c => c[0]);
    const ys = corners.map(c => c[1]);
    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  }

  /** Draws one component with its top-left at (0, 0) of the current transform. */
  private drawComponent(id: HudComponentId, g: CanvasRenderingContext2D, size: { w: number; h: number }, now: number, dpr: number): void {
    switch (id) {
      case 'wedge1':
      case 'wedge2':
        drawWedge(g, 0, 0, 380, 72);
        return;
      case 'health':
        g.save();
        g.globalAlpha *= this.healthAlpha.valueAt(now);
        this.health.draw(g, 0, 0, now, dpr);
        // The health line (45x3, CentreLeft) left of the bar.
        g.fillStyle = '#fff';
        g.beginPath();
        if (typeof g.roundRect === 'function') g.roundRect(-50, MAIN_PATH_RADIUS - 1.5, 45, 3, 1.5);
        else g.rect(-50, MAIN_PATH_RADIUS - 1.5, 45, 3);
        g.fill();
        g.restore();
        return;
      case 'score': {
        const o = this.score.options(now);
        drawArgonText(g, 0, 0, o, measureArgonText(g, o));
        return;
      }
      case 'accuracy':
        this.accuracy.draw(g, 0, 0, now);
        return;
      case 'combo': {
        if (!this.combo) return;
        const o = this.combo.options(now);
        drawArgonText(g, 0, 0, o, measureArgonText(g, o));
        return;
      }
      case 'progress':
        this.progress.draw(g, size.w / 2, size.h, size.w, now);
        return;
      case 'keyCounter':
        this.keyCounter.draw(g, size.w, size.h, now);
        return;
      case 'hitErrorLeft':
      case 'hitErrorRight': {
        if (!this.showHitErrorMeter) return;
        const mirror = id === 'hitErrorRight';
        if (this.barMeter) this.barMeter.draw(g, 0, 0, now, mirror);
        else if (this.colourMeters) this.colourMeters[mirror ? 1 : 0].draw(g, 0, 0, now, mirror);
        return;
      }
    }
  }

  draw(g: CanvasRenderingContext2D, w: number, h: number, now: number, dpr: number): void {
    const hudAlpha = this.hideTargetAlpha.valueAt(now);
    if (hudAlpha <= 0.001) return;
    g.save();
    g.globalAlpha *= hudAlpha;

    for (const id of this.componentIds()) {
      const t = this.componentTransform(id, g, w, h, now);
      if (!t.l.visible) continue;
      const o = anchorFraction(t.l.origin);
      g.save();
      g.translate(t.x, t.y);
      if (t.l.rotation) g.rotate((t.l.rotation * Math.PI) / 180);
      g.scale(t.l.scaleX, t.l.scaleY);
      // Relative-width components (song progress) keep their width relative to the screen.
      const size = id === 'progress' ? { w: t.size.w, h: t.size.h } : t.size;
      g.translate(-o.x * size.w, -o.y * size.h);
      this.drawComponent(id, g, size, now, dpr);
      g.restore();
    }

    // --- TopRightElements (Margin 10), placed below the lowest top-right anchored component (the accuracy counter).
    const accBounds = this.layout.accuracy.anchor === 'TopRight' && this.layout.accuracy.visible ? this.componentBounds('accuracy', g, w, h, now) : null;
    const modsTop = (accBounds ? accBounds.y + accBounds.h : 0) + 10;
    const modsW = this.modDisplay.width(now);
    this.modDisplay.draw(g, w - 10, modsTop, now);
    this.lastModRect = { x: w - 10 - modsW, y: modsTop, w: modsW, h: ModDisplay.ICON };
    g.restore();
  }
}
