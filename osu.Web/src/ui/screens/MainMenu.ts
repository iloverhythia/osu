// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game/Screens/Menu/MainMenu.cs, with the startup flow of IntroScreen.cs / IntroTriangles.cs in front of it
// (browsers need a user gesture before audio can start, so a "click to start" gate precedes the intro).
//
// Layers (back to front): ButtonSystem (DOM, in the parallax container), the logo's additive layer (visualiser,
// ripple, side flashes, fountains, intro glitch triangles), the logo layer, the song ticker / tips, the logo hit area.

import { settings } from '../../framework/Settings';
import { APP_NAME, ATTRIBUTION } from '../../brand';
import type { Game } from '../Game';
import { MenuBeatSource } from '../menu/BeatSync';
import { ButtonSystem, ButtonSystemState } from '../menu/ButtonSystem';
import { TrianglesIntroSequence, TRACK_START_DELAY } from '../menu/IntroTriangles';
import { KiaiMenuFountains } from '../menu/KiaiMenuFountains';
import { MenuSideFlashes } from '../menu/MenuSideFlashes';
import { OsuLogo } from '../menu/OsuLogo';
import { MenuTipDisplay, SongTicker } from '../menu/SongTicker';
import { Anim, Easing, now as clockNow } from '../menu/Transforms';
import '../menu/menu.css';
import { openSettings } from '../overlays/Settings';
import { openChartGenerator } from '../overlays/ChartGenerator';
import { Screen } from '../Screen';
import { SongSelectScreen } from './SongSelect';
import { applyEasing } from '../../game/storyboard/Easing';

export const FADE_IN_DURATION = 300;
export const FADE_OUT_DURATION = 400;
const IDLE_TIME = 6000;

type Phase = 'gate' | 'intro' | 'menu';

export class MainMenuScreen extends Screen {
  private readonly source: MenuBeatSource;
  private readonly logo: OsuLogo;
  private readonly buttons: ButtonSystem;
  private readonly sideFlashes: MenuSideFlashes;
  private readonly fountains: KiaiMenuFountains;
  private readonly songTicker: SongTicker;
  private readonly tips: MenuTipDisplay;
  private readonly additive: HTMLCanvasElement;
  private readonly logoLayer: HTMLCanvasElement;
  private readonly gate: HTMLDivElement;
  private readonly flash: HTMLDivElement;
  private readonly footer: HTMLDivElement;
  /** Everything but the gate, in logical (UI-scaled) pixels. */
  private readonly content: HTMLDivElement;
  private readonly bottomAlpha = new Anim(1);
  private readonly bottomScale = new Anim(1);

  private phase: Phase = 'gate';
  private intro: TrianglesIntroSequence | null = null;
  private readonly flashAlpha = new Anim(0);
  private trackFade: { track: NonNullable<Game['previewTrack']>; start: number } | null = null;
  private raf = 0;
  private last = 0;
  private frame = 0;
  private lastInput = clockNow();
  private readonly onInput = () => (this.lastInput = clockNow());

  /** ScrollAdjustsVolume */
  get scrollAdjustsVolume(): boolean {
    return true;
  }

  constructor(game: Game) {
    super(game, 'menu main-menu');
    this.backgroundDim = 1;
    this.showTriangles = false;

    this.source = new MenuBeatSource(game);
    this.logo = new OsuLogo(game, this.source);
    this.buttons = new ButtonSystem(game, this.source);
    this.sideFlashes = new MenuSideFlashes(this.source);
    this.fountains = new KiaiMenuFountains(this.source);
    this.songTicker = new SongTicker(game);
    this.tips = new MenuTipDisplay();

    this.buttons.onSolo = () => this.loadSongSelect();
    this.buttons.onSettings = () => openSettings(this.game);
    this.buttons.onBeatmapListing = () => this.game.openFilePicker();
    this.buttons.onEdit = () =>
      openChartGenerator(this.game, {
        onPlay: () => {
          const select = new SongSelectScreen(this.game);
          this.game.push(select);
          setTimeout(() => select.startSelected(), 700);
        },
      });
    this.buttons.onStateChanged = s => {
      // MainMenu: Buttons.StateChanged → background colour (Gray(1) at the logo, Gray(0.8) otherwise).
      if (this.phase !== 'menu') return;
      this.game.setBackgroundDim(s === ButtonSystemState.Initial || s === ButtonSystemState.Exit ? 0 : 0.2);
    };

    this.additive = document.createElement('canvas');
    this.additive.className = 'menu-canvas additive';
    this.logoLayer = document.createElement('canvas');
    this.logoLayer.className = 'menu-canvas';
    this.flash = document.createElement('div');
    this.flash.className = 'menu-game-flash';

    this.gate = document.createElement('div');
    this.gate.className = 'intro-gate';
    const hint = document.createElement('div');
    hint.className = 'intro-gate-hint';
    hint.textContent = 'Click anywhere to start';
    this.gate.appendChild(hint);
    this.gate.addEventListener('click', () => void this.startIntro());

    this.footer = document.createElement('div');
    this.footer.className = 'menu-attribution';
    this.footer.textContent = `${APP_NAME} · ${ATTRIBUTION}`;

    const bottom = document.createElement('div');
    bottom.className = 'menu-bottom';
    bottom.appendChild(this.tips.el);

    this.content = document.createElement('div');
    this.content.className = 'menu-scale';
    this.content.append(this.buttons.el, this.additive, this.logoLayer, this.songTicker.el, bottom, this.footer, this.logo.el);
    this.el.append(this.content, this.flash, this.gate);
    this.logo.hide();
    this.buttons.alpha.set(0);
    this.footer.style.opacity = '0';
    this.tips.el.style.opacity = '0';
  }

  onEnter(): void {
    for (const ev of ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart'] as const) window.addEventListener(ev, this.onInput, { passive: true });
    void document.fonts?.ready.then(() => this.logo.invalidateSprite());
    this.startLoop();
  }

  onExit(): void {
    cancelAnimationFrame(this.raf);
    for (const ev of ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart'] as const) window.removeEventListener(ev, this.onInput);
  }

  onSuspend(): void {
    // OnSuspending: Buttons.State = EnteringMode; the logo leaves (LogoSuspending: FadeOut/ScaleTo 0.2 over 300 InSine).
    const t = clockNow();
    this.buttons.state = ButtonSystemState.EnteringMode;
    this.buttons.containerX.to(-800, t, FADE_OUT_DURATION, Easing.InSine);
    this.sideFlashes.alpha.to(0, t, 64, Easing.OutQuint);
    this.bottomScale.to(0.9, t, 1000, Easing.OutQuint);
    this.bottomAlpha.to(0, t, 500, Easing.OutQuint);
    this.logo.alpha.to(0, t, 300, Easing.InSine);
    this.logo.scale.to(0.2, t, 300, Easing.InSine);
    this.buttons.setOsuLogo(null);
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  onResume(): void {
    // OnResuming + LogoArriving(resuming: true).
    const t = clockNow();
    this.lastInput = t;
    this.game.setBackgroundDim(0.2);
    if (!this.game.previewTrack?.isRunning) void this.game.startPreview();
    this.logo.alpha.clear().set(0).to(1, t, 100, Easing.OutQuint);
    this.logo.scale.finish();
    this.buttons.setOsuLogo(this.logo);
    this.buttons.state = ButtonSystemState.TopLevel;
    this.buttons.containerX.to(0, t, FADE_IN_DURATION, Easing.OutQuint);
    this.sideFlashes.alpha.to(1, t + FADE_IN_DURATION, 64, Easing.InQuint);
    if (settings.get('ui.menuTips', true)) this.tips.showNextTip(t);
    this.bottomScale.to(1, t, 1000, Easing.OutQuint);
    this.bottomAlpha.to(1, t, 1000, Easing.OutQuint);
    this.startLoop();
  }

  // ---------------------------------------------------------------- intro

  private async startIntro(): Promise<void> {
    if (this.phase !== 'gate') return;
    this.phase = 'intro';
    this.gate.remove();
    const audio = await this.game.ensureAudio();
    await this.game.library.load();
    const t = clockNow();

    // IntroScreen.LogoArriving (not resuming): logo at the centre, scale 1, hidden; no triangles / ripple.
    this.logo.x.set(0.5);
    this.logo.y.set(0.5);
    this.logo.scale.set(1);
    this.logo.hide();
    this.logo.showTriangles = false;
    this.logo.showRipple = false;

    // Pick a random beatmap for the menu music (MenuMusic off / no theme track available).
    const sets = this.game.library.sets;
    if (!this.game.working && sets.length > 0) {
      const s = sets[Math.floor(Math.random() * sets.length)];
      this.game.select(s, s.beatmaps[0], false);
    }

    this.intro = new TrianglesIntroSequence(t, () => this.onIntroComplete());
    // Non-themed intro: the intro voice (synthesised stand-in), then StartTrack after TRACK_START_DELAY.
    this.game.playUiSample('menu-confirm', 0.6);
    setTimeout(() => void this.startTrack(audio), TRACK_START_DELAY);
  }

  /** IntroScreen.StartTrack (non-themed): PrepareTrackForPreview(false, -2600), VolumeTo(0) → VolumeTo(1, 2600, InCubic). */
  private async startTrack(audio: NonNullable<Game['audio']>): Promise<void> {
    const working = this.game.working;
    if (!working || this.game.previewTrack) return;
    const track = working.createTrack(audio);
    if (!track) return;
    this.game.previewTrack = track;
    await track.ready;
    if (this.game.previewTrack !== track) return;
    const preview = working.entry.previewTime;
    track.currentTime = Math.max(0, (preview >= 0 ? preview : track.length * 0.4) - 2600);
    track.loop = false;
    track.volume = 0;
    await track.start();
    this.trackFade = { track, start: clockNow() };
  }

  private onIntroComplete(): void {
    const t = clockNow();
    // lazerLogo.FadeOut().OnComplete: logo.FadeIn(); showBackgroundAction(); game.Add(new GameWideFlash()); LoadMenu();
    this.logo.alpha.set(1);
    this.flashAlpha.set(1).to(0, t, 1000, Easing.Out);
    this.intro = null;
    this.phase = 'menu';
    this.game.setBackgroundDim(0);

    // MainMenu.OnEntering + LogoArriving(resuming: false).
    this.buttons.alpha.set(0).to(1, t, 500);
    this.logo.showTriangles = true;
    this.logo.showRipple = true;
    this.buttons.setOsuLogo(this.logo);
    if (settings.get('ui.menuTips', true)) this.tips.showNextTip(t);
    this.footer.style.opacity = '';
    this.lastInput = t;
    if (!this.game.previewTrack?.isRunning) void this.game.startPreview();
  }

  // ---------------------------------------------------------------- frame loop

  private startLoop(): void {
    if (this.raf) return;
    this.last = clockNow();
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      this.tick();
    };
    this.raf = requestAnimationFrame(loop);
  }

  private resize(c: HTMLCanvasElement, w: number, h: number, dpr: number): CanvasRenderingContext2D {
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    return g;
  }

  private tick(): void {
    const t = clockNow();
    const elapsed = Math.min(1000, t - this.last);
    this.last = t;
    this.frame++;
    const sw = this.el.clientWidth;
    const sh = this.el.clientHeight;
    if (sw === 0 || sh === 0) return;
    // Lazer lays the menu out in fixed "osu! pixels" at UI scale 1; scale it down on small (phone) screens.
    const uiScale = Math.min(1, sw / 960, sh / 560);
    const w = sw / uiScale;
    const h = sh / uiScale;
    this.content.style.width = `${w}px`;
    this.content.style.height = `${h}px`;
    this.content.style.transform = uiScale === 1 ? '' : `scale(${uiScale})`;
    this.logo.uiScale = this.buttons.uiScale = uiScale;

    this.source.update();
    if (this.trackFade) {
      const p = Math.min(1, (t - this.trackFade.start) / 2600);
      if (this.game.previewTrack === this.trackFade.track) this.trackFade.track.volume = applyEasing(Easing.InCubic, p);
      if (p >= 1 || this.game.previewTrack !== this.trackFade.track) this.trackFade = null;
    }
    this.ensurePlayingSomething();

    if (this.phase === 'menu' && this.game.currentScreen === this && !this.game.hasOverlay && t - this.lastInput > IDLE_TIME) {
      this.lastInput = t;
      this.buttons.onIdle();
    }

    this.intro?.update(t);
    this.buttons.update(t, elapsed, this.frame);
    this.logo.update(t, elapsed, this.frame);
    this.buttons.layout();
    this.sideFlashes.update(t, this.frame);
    this.fountains.update(t, this.frame);
    this.flashAlpha.update(t);
    this.bottomAlpha.update(t);
    this.bottomScale.update(t);
    this.songTicker.update(t, this.phase === 'menu');
    this.tips.update(t, this.bottomAlpha.value, this.bottomScale.value);
    this.flash.style.opacity = String(this.flashAlpha.value);
    this.flash.style.display = this.flashAlpha.value > 0 ? '' : 'none';

    const dpr = Math.min(2, window.devicePixelRatio || 1) * uiScale;
    const ga = this.resize(this.additive, w, h, dpr);
    ga.globalCompositeOperation = 'lighter';
    this.logo.drawAdditive(ga, w, h);
    if (this.phase === 'menu') {
      this.sideFlashes.draw(ga, w, h);
      this.fountains.draw(ga, w, h, t);
    }
    this.intro?.drawAdditive(ga, w, h, t);

    const gl = this.resize(this.logoLayer, w, h, dpr);
    this.intro?.draw(gl, w, h, t);
    this.logo.draw(gl, w, h);
    this.logo.layoutHitArea(w, h);
  }

  /** MusicController.EnsurePlayingSomething / next track when the current one ends. */
  private ensurePlayingSomething(): void {
    if (this.phase !== 'menu' || this.game.currentScreen !== this) return;
    const track = this.game.previewTrack;
    if (!track || !track.hasEnded) return;
    const sets = this.game.library.sets;
    if (sets.length > 1) {
      const others = sets.filter(s => s.id !== this.game.working?.set.id);
      const s = others[Math.floor(Math.random() * others.length)];
      this.game.select(s, s.beatmaps[0], true);
    } else void this.game.startPreview(true);
  }

  private loadSongSelect(): void {
    this.game.push(new SongSelectScreen(this.game));
  }

  // ---------------------------------------------------------------- input

  onKeyDown(e: KeyboardEvent): boolean {
    if (this.phase === 'gate') {
      if (!e.repeat && !e.ctrlKey && !e.altKey && !e.metaKey && e.code !== 'Escape' && !/^F\d+$/.test(e.code)) {
        void this.startIntro();
        return true;
      }
      return false;
    }
    if (this.phase !== 'menu') return false;
    if (e.ctrlKey && e.code === 'KeyO') {
      openSettings(this.game);
      return true;
    }
    return this.buttons.onKeyDown(e);
  }

  /** GlobalAction.Back: ButtonSystem.goBack (the main menu itself never exits: AllowUserExit = false). */
  onBack(): boolean {
    if (this.phase === 'menu') this.buttons.goBack();
    return false;
  }
}
