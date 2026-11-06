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

  draw(g: CanvasRenderingContext2D, w: number, h: number, now: number, dpr: number): void {
    const hudAlpha = this.hideTargetAlpha.valueAt(now);
    if (hudAlpha <= 0.001) return;
    g.save();
    g.globalAlpha *= hudAlpha;

    // --- global MainHUDComponents (positions after the DefaultSkinComponentsContainer layout callback)
    // Wedges: default (0,0) and (4,5), then += (-50, 15).
    drawWedge(g, -50, 15, 380, 72);
    drawWedge(g, -46, 20, 380, 72);

    // Health: TopLeft at (50, 20); health line (45x3, CentreLeft) at Y = health.Y + MAIN_PATH_RADIUS.
    g.save();
    g.globalAlpha *= this.healthAlpha.valueAt(now);
    this.health.draw(g, 50, 20, now, dpr);
    g.fillStyle = '#fff';
    g.beginPath();
    if (typeof g.roundRect === 'function') g.roundRect(0, 20 + MAIN_PATH_RADIUS - 1.5, 45, 3, 1.5);
    else g.rect(0, 20 + MAIN_PATH_RADIUS - 1.5, 45, 3);
    g.fill();
    g.restore();

    // Score: Origin TopRight at (50 + 200, wedge.Y + 30).
    const scoreO = this.score.options(now);
    const scoreSize = measureArgonText(g, scoreO);
    drawArgonText(g, 250 - scoreSize.width, 50, scoreO, scoreSize);

    // Accuracy: Anchor/Origin TopRight at (-20, 20).
    const acc = this.accuracy.measure(g, now);
    this.accuracy.draw(g, w - 20 - acc.width, 20, now);

    // Song progress: BottomCentre, Position (0, -10), Scale (0.9, 1).
    this.progress.draw(g, w / 2, h - 10, w * 0.9, now);

    // Key counter: BottomRight at (-(26 + 10), -(10 * 2 + 36 + 10)).
    this.keyCounter.draw(g, w - 36, h - 66, now);

    // --- ruleset MainHUDComponents
    if (this.combo) {
      // ArgonComboCounter: BottomLeft, Scale 1.3, Position (36, -66).
      const o = this.combo.options(now);
      const size = measureArgonText(g, o);
      g.save();
      g.translate(36, h - 66);
      g.scale(1.3, 1.3);
      drawArgonText(g, 0, -size.height, o, size);
      g.restore();
    }
    if (this.showHitErrorMeter) {
      if (this.barMeter) {
        const y = h / 2 - BarHitErrorMeter.HEIGHT / 2;
        this.barMeter.draw(g, 0, y, now, false);
        this.barMeter.draw(g, w - BarHitErrorMeter.WIDTH, y, now, true);
      }
      if (this.colourMeters) {
        const y = h / 2 - this.colourMeters[0].height / 2;
        this.colourMeters[0].draw(g, 0, y, now, false);
        this.colourMeters[1].draw(g, w - 8, y, now, true);
      }
    }

    // --- TopRightElements (Margin 10), placed below the lowest top-right anchored component (the accuracy counter).
    const modsTop = 20 + acc.height + 10;
    const modsW = this.modDisplay.width(now);
    this.modDisplay.draw(g, w - 10, modsTop, now);
    this.lastModRect = { x: w - 10 - modsW, y: modsTop, w: modsW, h: ModDisplay.ICON };
    g.restore();
  }
}
