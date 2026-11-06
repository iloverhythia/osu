// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Gameplay screen. Port of the essentials of Player / PlayerLoader / GameplayClockContainer / HUDOverlay /
// BreakOverlay / PauseOverlay / FailOverlay / SkipOverlay.

import type { AudioEngine, LoopingSample, Track } from '../../framework/audio/AudioEngine';
import { GameplayClock } from '../../framework/audio/GameplayClock';
import { settings } from '../../framework/Settings';
import { HitSampleInfo } from '../../game/audio/HitSampleInfo';
import type { Beatmap } from '../../game/beatmaps/Beatmap';
import type { WorkingBeatmap } from '../../game/beatmaps/WorkingBeatmap';
import type { ModSet } from '../../game/mods/Mods';
import type { HealthProcessor } from '../../game/scoring/HealthProcessor';
import { HitResult, affectsAccuracy, affectsCombo, breaksCombo, isBasic, isHit } from '../../game/scoring/HitResult';
import type { HitWindows } from '../../game/scoring/HitWindows';
import type { JudgementResult } from '../../game/scoring/Judgement';
import type { ScoreProcessor } from '../../game/scoring/ScoreProcessor';
import type { ScoreRank } from '../../game/scoring/ScoreRank';
import { createSkin } from '../../game/Skin';
import { loadActiveSkin, loadBeatmapSkin, type LoadedSkin } from '../../game/skinning';
import { loadStoryboard, type StoryboardPlayer } from '../../game/storyboard';
import type { DrawableRuleset, GameplayContext, LoopHandle, PlayableBeatmap, Ruleset } from '../../game/rulesets/Ruleset';
import { h, keyLabel } from '../dom';
import type { Game } from '../Game';
import { Screen } from '../Screen';
import { ResultsScreen, type PlayResult } from './Results';
import { ReplayRecorder, type Replay } from '../../game/replays/Replay';
import { osuPlayfieldTransform } from '../../game/rulesets/osu/playfield';

const COMPLETION_DELAY = 1000;

export class PlayerScreen extends Screen {
  private canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private loaderEl: HTMLElement;
  private skipButton: HTMLButtonElement;

  private audio!: AudioEngine;
  private beatmap!: Beatmap;
  private playable!: PlayableBeatmap;
  private drawable!: DrawableRuleset;
  private scoreProcessor!: ScoreProcessor;
  private healthProcessor!: HealthProcessor;
  private track!: Track;
  private clock!: GameplayClock;
  private background: HTMLImageElement | null = null;
  private storyboard: StoryboardPlayer | null = null;
  private skins: LoadedSkin[] = [];
  private sampleResolver: (name: string) => AudioBuffer | null | undefined = () => undefined;

  private raf = 0;
  private loaded = false;
  private disposed = false;
  private paused = false;
  private failed = false;
  private completedAt: number | null = null;
  private resultsShown = false;
  private lastFrameReal = 0;
  private lastFrameGameTime = 0;
  private startTime = 0;
  private skipTarget: number | null = null;
  private firstObjectTime = 0;
  private lastObjectTime = 0;
  private easyLives = 2;
  private failAnimationStart = 0;
  private pauseOverlay: HTMLElement | null = null;
  private gameplayStarted = false;

  // input
  private bindings = new Map<string, string>(); // code -> action
  private actionCounts = new Map<string, number>();
  private heldActions = new Map<string, number>(); // action -> hold count
  private actions: { id: string; label: string }[] = [];
  private readonly disableMouseButtons = settings.get('gameplay.disableMouseButtons', false);

  // HUD state
  private displayedScore = 0;
  private comboPop = 0;
  private hitErrors: { offset: number; time: number; result: HitResult }[] = [];
  private hitWindows: { result: HitResult; length: number }[] = [];
  private loops = new Set<LoopingSample>();

  // Replays
  private recorder: ReplayRecorder | null = null;
  private replayIndex = 0;
  private viewW = 1;
  private viewH = 1;

  constructor(
    game: Game,
    private readonly working: WorkingBeatmap,
    private readonly ruleset: Ruleset,
    private readonly mods: ModSet,
    /** When set, the play is driven by this replay instead of user input. */
    private readonly replay: Replay | null = null,
  ) {
    super(game, 'player');
    this.showTriangles = false;
    this.backgroundDim = 1;
    this.canvas = h('canvas', { class: 'game' });
    this.g = this.canvas.getContext('2d', { alpha: false, desynchronized: true } as CanvasRenderingContext2DSettings) as CanvasRenderingContext2D;
    const e = working.entry;
    this.loaderEl = h(
      'div',
      { class: 'loader' },
      h('div', { class: 'meta-title' }, e.title),
      h('div', { class: 'meta-artist' }, `${e.artist} · [${e.difficultyName}]`),
      h('div', { class: 'meta-artist', style: { fontSize: '15px' } }, `mapped by ${e.creator}${mods.isEmpty ? '' : ` · ${mods.list.join(' ')}`}`),
      replay ? h('div', { class: 'meta-artist', style: { fontSize: '15px', color: 'var(--blue)' } }, `Watching ${replay.player}'s replay`) : null,
      h('div', { class: 'spinner' }),
    );
    this.skipButton = h('button', { class: 'btn primary skip-button', style: { display: 'none' }, onclick: () => this.skip() }, 'Skip ', h('span', { class: 'kbd' }, 'Space'));
    this.el.append(this.canvas, this.loaderEl, this.skipButton);
  }

  onEnter(): void {
    this.game.stopPreview();
    void this.load().catch(err => {
      console.error(err);
      this.game.toast(`Couldn't load beatmap: ${err instanceof Error ? err.message : String(err)}`, 'error', 6000);
      this.game.pop();
    });
  }

  // ------------------------------------------------------------------ loading

  private async load(): Promise<void> {
    this.audio = await this.game.ensureAudio();
    await this.audio.loadDefaultSamples();
    this.beatmap = await this.working.getBeatmap();
    if (!this.ruleset.canConvert(this.beatmap)) throw new Error(`This beatmap can't be played in ${this.ruleset.name}`);

    this.playable = this.ruleset.createPlayable(this.beatmap, this.mods);
    if (this.playable.objectTimes.length === 0) throw new Error('Beatmap has no hit objects');

    const track = this.working.createTrack(this.audio);
    if (!track) throw new Error(`Missing audio file "${this.working.entry.audioFile}"`);
    this.track = track;
    this.track.preservePitch = this.mods.preservePitch;

    const [bg, resolver, storyboard, userSkin, beatmapSkin] = await Promise.all([
      this.working.loadBackgroundImage(),
      this.working.preloadSamples(this.audio, this.collectSampleLookups()),
      settings.get('gameplay.storyboard', true) ? loadStoryboard(this.working, this.beatmap, this.audio).catch(() => null) : Promise.resolve(null),
      loadActiveSkin(this.audio).catch(() => null),
      settings.get('skin.beatmapSkins', true) ? loadBeatmapSkin(this.working.set, this.audio).catch(() => null) : Promise.resolve(null),
      track.ready,
    ]);
    this.background = bg;
    this.storyboard = storyboard;
    // Beatmap skin elements take priority over the user's skin (LegacyBeatmapSkin above LegacySkin).
    this.skins = [beatmapSkin, userSkin].filter((x): x is LoadedSkin => x != null);
    this.sampleResolver = resolver;
    if (this.disposed) return;

    this.setupProcessors();
    this.setupInput();
    if (!this.replay && !this.mods.isAutoplay) this.recorder = new ReplayRecorder();

    const ctx = this.createContext();
    this.drawable = this.ruleset.createDrawableRuleset(this.playable, ctx);

    this.firstObjectTime = Math.min(...this.playable.objectTimes.map(t => t.start));
    this.lastObjectTime = Math.max(...this.playable.objectTimes.map(t => t.end));

    // GameplayClockContainer start time: leave enough time to read the first object.
    const leadIn = Math.max(this.drawable.leadInTime ?? 0, 1500);
    this.startTime = Math.min(0, this.firstObjectTime - leadIn - 600) - this.beatmap.audioLeadIn;
    // Allow skipping long intros (SkipOverlay).
    const skipTo = this.firstObjectTime - leadIn - 400;
    this.skipTarget = skipTo - this.startTime > 2500 ? skipTo : null;

    this.clock = new GameplayClock(this.track, this.mods.rate);
    this.clock.offset = settings.get('audio.offset', 0) + (settings.get('audio.compensateLatency', true) ? this.audio.outputLatency : 0);
    this.clock.seek(this.startTime);

    this.loaded = true;
    this.loaderEl.style.opacity = '0';
    setTimeout(() => (this.loaderEl.style.display = 'none'), 500);
    this.resize();
    this.lastFrameReal = performance.now();
    this.clock.start();
    this.gameplayStarted = true;
    this.raf = requestAnimationFrame(this.frame);
  }

  private collectSampleLookups(): Set<string> {
    const names = new Set<string>();
    const extra = ['slidertick', 'sliderslide', 'sliderwhistle', 'spinnerspin', 'spinnerbonus'];
    const add = (s: HitSampleInfo) => {
      for (const n of s.lookupNames) names.add(n);
      for (const e of extra) for (const n of s.with({ name: e }).lookupNames) names.add(n);
    };
    for (const h of this.beatmap.hitObjects) {
      h.samples.forEach(add);
      h.nodeSamples.forEach(n => n.forEach(add));
    }
    return names;
  }

  private setupProcessors(): void {
    const p = this.playable;
    this.scoreProcessor = this.ruleset.createScoreProcessor(p);
    this.scoreProcessor.scoreMultiplier = this.ruleset.scoreMultiplier(this.mods, p);
    this.scoreProcessor.applyBeatmap(p.perfectResults());
    if (this.mods.has('HD') || this.mods.has('FL') || this.mods.has('FI')) {
      this.scoreProcessor.rankAdjusters.push((rank: ScoreRank) => (rank === 'X' ? 'XH' : rank === 'S' ? 'SH' : rank));
    }

    const drainStart = p.objectTimes.length > 0 ? Math.min(...p.objectTimes.map(t => t.start)) : 0;
    this.healthProcessor = this.ruleset.createHealthProcessor(p, drainStart);
    this.healthProcessor.applyBeatmap(p.perfectResults(), p.difficulty.drainRate, p.breaks, Math.max(...p.objectTimes.map(t => t.end)), p.objectTimes);
    const hp = this.healthProcessor;
    hp.noFail = this.mods.has('NF') || this.mods.isAutoplay;
    // ModSuddenDeath.FailCondition
    if (this.mods.has('SD')) hp.failConditions.push(r => affectsCombo(r.type) && !isHit(r.type));
    // ModPerfect.FailCondition (osu!mania adds its own ManiaModPerfect condition, which allows Great hits).
    const relevant = (x: HitResult) => affectsAccuracy(x) || affectsCombo(x);
    if (this.mods.has('PF') && this.ruleset.shortName !== 'mania')
      hp.failConditions.push(r => (relevant(r.judgement.minResult) || relevant(r.judgement.maxResult) || relevant(r.type)) && r.type !== r.judgement.maxResult);
    hp.onFail = () => this.onFail();

    // Hit windows for the hit error meter.
    const withWindows = (p.hitObjects as { hitWindows?: HitWindows | null }[]).find(o => o && o.hitWindows && typeof o.hitWindows.getAllAvailableWindows === 'function');
    if (withWindows?.hitWindows) {
      try {
        this.hitWindows = withWindows.hitWindows.getAllAvailableWindows().filter(w => w.result !== HitResult.Miss && w.length > 0);
      } catch {
        this.hitWindows = [];
      }
    }
  }

  private setupInput(): void {
    const variant = this.playable.variant;
    this.actions = this.ruleset.actions(variant);
    const bindings = settings.getBindings(this.ruleset.shortName, variant, this.ruleset.defaultBindings(variant));
    for (const [action, codes] of Object.entries(bindings)) for (const code of codes) this.bindings.set(code, action);

    const c = this.canvas;
    c.addEventListener('pointerdown', this.onPointerDown);
    c.addEventListener('pointermove', this.onPointerMove);
    c.addEventListener('pointerup', this.onPointerUp);
    c.addEventListener('pointercancel', this.onPointerUp);
    c.addEventListener('contextmenu', e => e.preventDefault());
    window.addEventListener('resize', this.resize);
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('visibilitychange', this.onBlur);
  }

  private createContext(): GameplayContext {
    const self = this;
    const skin = createSkin(this.beatmap.comboColours.length > 0 ? this.beatmap.comboColours : null, this.beatmap.customColours, this.skins);
    return {
      mods: this.mods,
      skin,
      settings: { get: <T,>(key: string, fallback: T) => settings.get<T>(key, fallback) },
      autoplay: this.mods.isAutoplay,
      rate: this.mods.rate,
      applyResult: (r: JudgementResult) => this.applyResult(r),
      playSamples: (samples, opts) => {
        for (const s of samples) this.playSample(s, opts?.pan ?? 0, opts?.volume ?? 1, opts?.rate ?? 1);
      },
      startLoop: (sample, opts) => this.startLoop(sample, opts?.pan ?? 0, opts?.volume ?? 1),
      isPressed: action => (this.heldActions.get(action) ?? 0) > 0,
      get combo() {
        return self.scoreProcessor.combo;
      },
      get health() {
        return self.healthProcessor.health;
      },
    };
  }

  private resolveSample(s: HitSampleInfo): AudioBuffer | null {
    for (const name of s.lookupNames) {
      if (name.startsWith('beatmap:')) {
        if (this.working.isSilenced(name)) return null;
        const b = this.sampleResolver(name);
        if (b) return b;
        continue;
      }
      const plain = name.startsWith('Gameplay/') ? name.slice('Gameplay/'.length) : name;
      for (const skin of this.skins) {
        const sk = skin.getSample(plain);
        if (sk) return sk;
      }
      const d = this.audio.getDefaultSample(plain);
      if (d) return d;
    }
    return null;
  }

  private playSample(s: HitSampleInfo, pan: number, volume: number, rate = 1): void {
    const buffer = this.resolveSample(s);
    if (!buffer) return;
    const v = (s.volume > 0 ? s.volume : 100) / 100;
    this.audio.play(buffer, { pan, volume: v * volume, rate });
  }

  private startLoop(s: HitSampleInfo, pan: number, volume: number): LoopHandle | null {
    const buffer = this.resolveSample(s);
    if (!buffer) return null;
    const v = (s.volume > 0 ? s.volume : 100) / 100;
    const loop = this.audio.loop(buffer, { pan, volume: v * volume });
    this.loops.add(loop);
    return {
      setPan: p => loop.setPan(p),
      setRate: r => loop.setRate(r),
      setVolume: x => loop.setVolume(x * v),
      stop: () => {
        loop.stop();
        this.loops.delete(loop);
      },
    };
  }

  // ------------------------------------------------------------------ judgements

  private applyResult(r: JudgementResult): void {
    if (this.failed) return;
    const comboBefore = this.scoreProcessor.combo;
    r.gameplayRate = this.mods.rate;
    this.scoreProcessor.applyResult(r);
    this.healthProcessor.applyResult(r);

    if (this.scoreProcessor.combo > comboBefore) this.comboPop = 1;
    if (breaksCombo(r.type) && comboBefore >= 20 && settings.get('gameplay.comboBreakSound', true)) this.game.playUiSample('combobreak', 0.8);

    if (isBasic(r.judgement.maxResult) && isHit(r.type) && r.type !== HitResult.IgnoreHit) {
      this.hitErrors.push({ offset: r.timeOffset, time: this.lastFrameGameTime, result: r.type });
      if (this.hitErrors.length > 40) this.hitErrors.shift();
    }
  }

  private onFail(): void {
    if (this.failed || this.healthProcessor.noFail) return;
    // ModEasyWithExtraLives (osu! and osu!catch; TaikoModEasy has no extra lives, ManiaHealthProcessor handles its own).
    const hasExtraLives = this.ruleset.shortName === 'osu' || this.ruleset.shortName === 'fruits';
    if (hasExtraLives && this.mods.has('EZ') && this.easyLives > 0 && !this.mods.has('SD') && !this.mods.has('PF')) {
      // ModEasy: extra lives.
      this.easyLives--;
      this.healthProcessor.failed = false;
      this.healthProcessor.health = 1;
      return;
    }
    this.failed = true;
    this.scoreProcessor.fail();
    this.failAnimationStart = performance.now();
    this.game.playUiSample('fail', 0.8);
    for (const l of this.loops) l.stop();
    setTimeout(() => {
      if (!this.disposed) this.showFailOverlay();
    }, 1600);
  }

  // ------------------------------------------------------------------ input handlers

  private eventTime(timeStamp: number): number {
    // Map the event timestamp onto the gameplay timeline for sub-frame precision.
    const t = this.lastFrameGameTime + (timeStamp - this.lastFrameReal) * this.mods.rate;
    return Math.max(this.lastFrameGameTime, Math.min(t, this.lastFrameGameTime + 50));
  }

  private get inputBlocked(): boolean {
    return !this.loaded || this.paused || this.failed || this.mods.isAutoplay || this.replay != null;
  }

  private press(action: string, time: number): void {
    const held = this.heldActions.get(action) ?? 0;
    this.heldActions.set(action, held + 1);
    if (held === 0) {
      this.actionCounts.set(action, (this.actionCounts.get(action) ?? 0) + 1);
      this.recorder?.press(time, action);
      this.drawable.onPressed(action, time);
    }
  }

  private release(action: string, time: number): void {
    const held = this.heldActions.get(action) ?? 0;
    if (held <= 0) return;
    this.heldActions.set(action, held - 1);
    if (held === 1) {
      this.recorder?.release(time, action);
      this.drawable.onReleased(action, time);
    }
  }

  private releaseAll(): void {
    for (const [action, n] of this.heldActions)
      if (n > 0) {
        this.recorder?.release(this.lastFrameGameTime, action);
        this.drawable?.onReleased(action, this.lastFrameGameTime);
      }
    this.heldActions.clear();
  }

  onKeyDown(e: KeyboardEvent): boolean {
    if (!this.loaded) return false;
    if (e.code === 'Backquote' && !e.repeat) {
      this.retry();
      return true;
    }
    if (this.paused || this.failed) {
      if (e.code === 'Enter' && this.pauseOverlay) {
        (this.pauseOverlay.querySelector('.btn') as HTMLButtonElement | null)?.click();
        return true;
      }
      return false;
    }
    if (e.code === 'Space' && this.skipTarget != null && !this.bindings.has('Space') && !e.repeat) {
      this.skip();
      return true;
    }
    if (e.code === 'Space' && this.skipTarget != null && this.lastFrameGameTime < this.skipTarget && this.bindings.has('Space') && !e.repeat) {
      this.skip();
      return true;
    }
    const action = this.bindings.get(e.code);
    if (action) {
      if (!e.repeat && !this.inputBlocked) this.press(action, this.eventTime(e.timeStamp));
      return true;
    }
    return false;
  }

  onKeyUp(e: KeyboardEvent): boolean {
    const action = this.bindings.get(e.code);
    if (action && this.loaded && !this.mods.isAutoplay && !this.replay) {
      this.release(action, this.eventTime(e.timeStamp));
      return true;
    }
    return false;
  }

  private localPos(e: PointerEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (this.inputBlocked) return;
    e.preventDefault();
    const p = this.localPos(e);
    const t = this.eventTime(e.timeStamp);
    if (e.pointerType === 'touch' || e.pointerType === 'pen') {
      this.canvas.setPointerCapture?.(e.pointerId);
      this.recordTouch('ts', e.pointerId, p, t);
      if (this.drawable.onTouchStart) this.drawable.onTouchStart(e.pointerId, p.x, p.y, t);
      return;
    }
    this.recordMove(p, t);
    this.drawable.onPointerMove?.(p.x, p.y, t);
    if (this.disableMouseButtons) return;
    const action = this.bindings.get(`Mouse${e.button}`);
    if (action) this.press(action, t);
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.loaded || this.paused || this.replay) return;
    const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [e];
    for (const ev of events.length > 0 ? events : [e]) {
      const p = this.localPos(ev);
      const t = this.eventTime(ev.timeStamp);
      if (e.pointerType === 'touch' || e.pointerType === 'pen') {
        this.recordTouch('tm', e.pointerId, p, t);
        this.drawable.onTouchMove?.(e.pointerId, p.x, p.y, t);
      } else {
        this.recordMove(p, t);
        this.drawable.onPointerMove?.(p.x, p.y, t);
      }
    }
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (!this.loaded || this.replay) return;
    const p = this.localPos(e);
    const t = this.eventTime(e.timeStamp);
    if (e.pointerType === 'touch' || e.pointerType === 'pen') {
      this.recordTouch('te', e.pointerId, p, t);
      this.drawable.onTouchEnd?.(e.pointerId, p.x, p.y, t);
      return;
    }
    if (this.disableMouseButtons) return;
    const action = this.bindings.get(`Mouse${e.button}`);
    if (action) this.release(action, t);
  };

  // ------------------------------------------------------------------ replays

  /** osu! replays store cursor positions in playfield coordinates (like osu!stable); other rulesets use screen fractions. */
  private get replaySpace(): 'gamefield' | 'screen' {
    return this.ruleset.id === 0 ? 'gamefield' : 'screen';
  }

  private recordMove(p: { x: number; y: number }, t: number): void {
    if (!this.recorder) return;
    if (this.replaySpace === 'gamefield') {
      const tr = osuPlayfieldTransform(this.viewW, this.viewH);
      this.recorder.move(t, (p.x - tr.offsetX) / tr.scale, (p.y - tr.offsetY) / tr.scale);
    } else this.recorder.move(t, p.x / this.viewW, p.y / this.viewH);
  }

  private recordTouch(k: 'ts' | 'tm' | 'te', id: number, p: { x: number; y: number }, t: number): void {
    // Touches also move the osu! cursor, so record them in the ruleset's space alongside the touch itself.
    this.recorder?.touch(t, k, id, p.x / this.viewW, p.y / this.viewH);
  }

  /** Feeds replay events up to `time` into the ruleset. */
  private playReplayTo(time: number): void {
    const replay = this.replay;
    if (!replay) return;
    const ev = replay.events;
    while (this.replayIndex < ev.length && ev[this.replayIndex].t <= time) {
      const e = ev[this.replayIndex++];
      switch (e.k) {
        case 'p':
          this.press(e.a, e.t);
          break;
        case 'r':
          this.release(e.a, e.t);
          break;
        case 'm': {
          let x = e.x * this.viewW;
          let y = e.y * this.viewH;
          if (replay.space === 'gamefield') {
            const tr = osuPlayfieldTransform(this.viewW, this.viewH);
            x = tr.offsetX + e.x * tr.scale;
            y = tr.offsetY + e.y * tr.scale;
          }
          this.drawable.onPointerMove?.(x, y, e.t);
          break;
        }
        case 'ts':
          this.drawable.onTouchStart?.(e.id, e.x * this.viewW, e.y * this.viewH, e.t);
          break;
        case 'tm':
          this.drawable.onTouchMove?.(e.id, e.x * this.viewW, e.y * this.viewH, e.t);
          break;
        case 'te':
          this.drawable.onTouchEnd?.(e.id, e.x * this.viewW, e.y * this.viewH, e.t);
          break;
      }
    }
  }

  private onBlur = (): void => {
    if (document.visibilityState === 'hidden' || !document.hasFocus()) {
      if (this.loaded && !this.paused && !this.failed && !this.resultsShown && !this.mods.isAutoplay && !this.replay) this.pause();
    }
  };

  private resize = (): void => {
    const dpr = Math.min(3, (window.devicePixelRatio || 1) * settings.get('graphics.renderScale', 1));
    const w = this.canvas.clientWidth || window.innerWidth;
    const hgt = this.canvas.clientHeight || window.innerHeight;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(hgt * dpr);
    this.viewW = w;
    this.viewH = hgt;
  };

  // ------------------------------------------------------------------ flow

  private skip(): void {
    if (this.skipTarget == null || !this.loaded) return;
    if (this.lastFrameGameTime < this.skipTarget) {
      this.clock.seek(this.skipTarget);
      this.lastFrameGameTime = this.skipTarget;
      this.clock.stop();
      this.clock.start();
    }
    this.skipTarget = null;
    this.skipButton.style.display = 'none';
  }

  private pause(): void {
    if (this.paused || this.failed || !this.loaded) return;
    this.paused = true;
    this.clock.stop();
    this.releaseAll();
    for (const l of this.loops) l.setVolume(0);
    this.el.classList.add('show-cursor');
    this.showPauseOverlay();
  }

  private resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.closePauseOverlay();
    this.el.classList.remove('show-cursor');
    this.lastFrameReal = performance.now();
    this.clock.start();
  }

  onBack(): boolean {
    if (!this.loaded) return true;
    if (this.resultsShown) return true;
    if (this.failed) return true;
    if (this.paused) {
      this.resume();
      return false;
    }
    if (this.mods.isAutoplay || this.replay) return true;
    this.pause();
    return false;
  }

  private retry(): void {
    this.game.replace(new PlayerScreen(this.game, this.working, this.ruleset, this.mods, this.replay));
  }

  private quit(): void {
    this.game.pop();
  }

  private showPauseOverlay(): void {
    this.closePauseOverlay();
    const el = h(
      'div',
      { class: 'overlay center' },
      h(
        'div',
        { class: 'pause-menu' },
        h('h2', null, 'Paused'),
        h('button', { class: 'btn primary', onclick: () => this.resume() }, 'Continue'),
        h('button', { class: 'btn', onclick: () => this.retry() }, 'Retry'),
        h('button', { class: 'btn danger', onclick: () => this.quit() }, 'Quit'),
      ),
    );
    this.pauseOverlay = el;
    this.el.appendChild(el);
  }

  private showFailOverlay(): void {
    this.closePauseOverlay();
    this.el.classList.add('show-cursor');
    const el = h(
      'div',
      { class: 'overlay center' },
      h(
        'div',
        { class: 'pause-menu' },
        h('h2', { style: { color: 'var(--red)' } }, 'Failed'),
        h('button', { class: 'btn primary', onclick: () => this.retry() }, 'Retry'),
        h('button', { class: 'btn danger', onclick: () => this.quit() }, 'Quit'),
      ),
    );
    this.pauseOverlay = el;
    this.el.appendChild(el);
  }

  private closePauseOverlay(): void {
    this.pauseOverlay?.remove();
    this.pauseOverlay = null;
  }

  private showResults(): void {
    if (this.resultsShown) return;
    this.resultsShown = true;
    const sp = this.scoreProcessor;
    const result: PlayResult = {
      working: this.working,
      ruleset: this.ruleset,
      mods: this.mods,
      playable: this.playable,
      totalScore: sp.totalScore,
      accuracy: sp.accuracy,
      maxCombo: sp.highestCombo,
      maximumCombo: sp.maximumCombo,
      rank: sp.rank,
      statistics: new Map(sp.statistics),
      maximumStatistics: new Map(sp.maximumStatistics),
      hitEvents: [...sp.hitEvents],
      date: Date.now(),
      passed: !this.failed,
      replay: this.recorder
        ? { rulesetId: this.ruleset.id, space: this.replaySpace, events: this.recorder.events, player: settings.get('ui.username', 'Guest'), mods: this.mods.list }
        : this.replay,
      isReplay: this.replay != null,
    };
    this.game.replace(new ResultsScreen(this.game, result));
  }

  onExit(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.resize);
    window.removeEventListener('blur', this.onBlur);
    document.removeEventListener('visibilitychange', this.onBlur);
    for (const l of this.loops) l.stop();
    this.drawable?.dispose?.();
    this.storyboard?.dispose();
    this.track?.dispose();
    if (this.gameplayStarted && !this.resultsShown) void this.game.startPreview();
  }

  // ------------------------------------------------------------------ frame loop

  private frame = (): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.frame);
    const now = performance.now();

    if (this.failed) {
      // Fail animation: slow the track down like FailAnimation.
      const t = Math.min(1, (now - this.failAnimationStart) / 1500);
      this.track.rate = Math.max(0.05, this.mods.rate * (1 - t));
      this.track.element.volume = Math.max(0, 1 - t);
      if (t >= 1) this.track.stop();
    }

    let elapsed = 0;
    if (!this.paused && !this.failed) elapsed = this.clock.update();
    const time = this.clock.currentTime;
    this.lastFrameReal = now;
    this.lastFrameGameTime = time;

    if (!this.paused && !this.failed) {
      this.playReplayTo(time);
      this.drawable.update(time, elapsed);
      this.healthProcessor.update(time, elapsed);
      if (this.skipTarget != null) {
        const showSkip = time < this.skipTarget;
        this.skipButton.style.display = showSkip ? '' : 'none';
        if (!showSkip) this.skipTarget = null;
      }
      if (this.completedAt == null && this.drawable.hasCompleted && time >= this.lastObjectTime) {
        this.completedAt = time;
        if (this.healthProcessor.checkFailAtEnd()) this.healthProcessor.triggerFailure();
      }
      if (this.completedAt != null && !this.failed && time - this.completedAt > COMPLETION_DELAY * this.mods.rate) this.showResults();
    }

    this.render(time);
  };

  private render(time: number): void {
    const g = this.g;
    const dpr = this.canvas.width / (this.canvas.clientWidth || 1);
    const w = this.canvas.width / dpr;
    const hgt = this.canvas.height / dpr;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#000';
    g.fillRect(0, 0, w, hgt);

    const inBreak = this.playable.breaks.some(b => time >= b.startTime && time <= b.endTime && b.endTime - b.startTime >= 650);
    const sbState = { passing: this.healthProcessor.health >= 0.5 || this.healthProcessor.noFail, running: !this.paused && !this.failed, rate: this.mods.rate };
    // Background
    if (this.background && !this.storyboard?.replacesBackground) {
      const img = this.background;
      const s = Math.max(w / img.width, hgt / img.height);
      const iw = img.width * s;
      const ih = img.height * s;
      g.drawImage(img, (w - iw) / 2, (hgt - ih) / 2, iw, ih);
      let dim = settings.get('gameplay.backgroundDim', 0.75);
      if (inBreak || time < this.firstObjectTime - 1500) dim *= 0.7;
      if (this.mods.has('CN')) dim = 0;
      g.fillStyle = `rgba(0,0,0,${dim})`;
      g.fillRect(0, 0, w, hgt);
    }

    if (this.storyboard) {
      g.save();
      this.storyboard.drawUnder(g, w, hgt, time, sbState);
      g.restore();
      // Apply the background dim on top of the storyboard as well.
      let dim = settings.get('gameplay.backgroundDim', 0.75);
      if (inBreak || time < this.firstObjectTime - 1500) dim *= 0.7;
      if (this.mods.has('CN')) dim = 0;
      g.fillStyle = `rgba(0,0,0,${dim})`;
      g.fillRect(0, 0, w, hgt);
    }

    if (this.mods.has('CN')) {
      if (this.storyboard) this.storyboard.drawOver(g, w, hgt, time, sbState);
      return;
    }

    g.save();
    this.drawable.render(g, w, hgt, time);
    g.restore();

    if (this.storyboard) {
      g.save();
      this.storyboard.drawOver(g, w, hgt, time, sbState);
      g.restore();
    }

    if (settings.get('gameplay.showHud', true)) this.drawHud(g, w, hgt, time, inBreak);
    if (inBreak) this.drawBreak(g, w, hgt, time);
  }

  // ------------------------------------------------------------------ HUD

  private drawHud(g: CanvasRenderingContext2D, w: number, hgt: number, time: number, inBreak: boolean): void {
    const sp = this.scoreProcessor;
    const font = '"Exo 2", system-ui, sans-serif';
    const ui = Math.max(0.7, Math.min(1.3, Math.min(w, hgt) / 800));

    // Rolling score counter.
    this.displayedScore += (sp.totalScore - this.displayedScore) * 0.25;
    if (Math.abs(sp.totalScore - this.displayedScore) < 1) this.displayedScore = sp.totalScore;

    g.textBaseline = 'top';
    g.textAlign = 'right';
    g.fillStyle = '#fff';
    g.font = `700 ${Math.round(38 * ui)}px ${font}`;
    g.fillText(String(Math.round(this.displayedScore)).padStart(8, '0'), w - 16, 12);
    g.font = `600 ${Math.round(22 * ui)}px ${font}`;
    g.fillStyle = 'rgba(255,255,255,0.85)';
    g.fillText(`${(sp.accuracy * 100).toFixed(2)}%`, w - 16, 12 + 44 * ui);

    // Health bar (top-left).
    const hp = this.healthProcessor.health;
    const barW = Math.min(w * 0.4, 420);
    g.fillStyle = 'rgba(0,0,0,0.4)';
    roundRect(g, 16, 16, barW, 10 * ui, 5 * ui);
    g.fill();
    g.fillStyle = hp < 0.3 ? '#ff5a5a' : '#ff66aa';
    roundRect(g, 16, 16, Math.max(0, barW * hp), 10 * ui, 5 * ui);
    g.fill();

    // Combo (bottom-left).
    this.comboPop *= 0.85;
    g.textAlign = 'left';
    g.textBaseline = 'bottom';
    g.font = `800 ${Math.round(46 * ui * (1 + this.comboPop * 0.12))}px ${font}`;
    g.fillStyle = '#fff';
    // osu!mania draws its combo inside the playfield (like lazer's mania skin layout).
    if (this.ruleset.shortName !== 'mania') g.fillText(`${sp.combo}x`, 16, hgt - 22);

    // Mods (top-right under accuracy).
    if (!this.mods.isEmpty) {
      g.font = `700 ${Math.round(14 * ui)}px ${font}`;
      g.textAlign = 'right';
      g.textBaseline = 'top';
      g.fillStyle = 'rgba(255,255,255,0.7)';
      g.fillText(this.mods.list.join(' '), w - 16, 12 + 74 * ui);
    }

    // Song progress (bottom bar).
    const start = this.firstObjectTime;
    const end = this.lastObjectTime;
    const progress = Math.max(0, Math.min(1, (time - start) / Math.max(1, end - start)));
    g.fillStyle = 'rgba(255,255,255,0.12)';
    g.fillRect(0, hgt - 5, w, 5);
    g.fillStyle = time < start ? 'rgba(102,204,255,0.8)' : 'rgba(255,255,255,0.85)';
    g.fillRect(0, hgt - 5, w * (time < start ? Math.max(0, 1 - (start - time) / Math.max(1, start - this.startTime)) : progress), 5);
    g.font = `600 ${Math.round(13 * ui)}px ${font}`;
    g.textBaseline = 'bottom';
    g.textAlign = 'right';
    g.fillStyle = 'rgba(255,255,255,0.75)';
    const remaining = Math.max(0, (end - time) / this.mods.rate);
    g.fillText(`-${Math.floor(remaining / 60000)}:${String(Math.floor((remaining % 60000) / 1000)).padStart(2, '0')}`, w - 12, hgt - 9);

    // Hit error meter (bottom centre).
    if (settings.get('gameplay.hitErrorMeter', true) && this.hitWindows.length > 0 && !inBreak) {
      const maxWindow = Math.max(...this.hitWindows.map(x => x.length));
      const meterW = Math.min(w * 0.5, 320) * ui;
      const cx = w / 2;
      const y = hgt - 26;
      const colourFor = (r: HitResult) =>
        r === HitResult.Perfect ? '#99eeff' : r === HitResult.Great ? '#66ccff' : r === HitResult.Good ? '#b3d944' : r === HitResult.Ok ? '#88b300' : '#ffcc22';
      for (const win of [...this.hitWindows].sort((a, b) => b.length - a.length)) {
        const ww = (win.length / maxWindow) * meterW;
        g.fillStyle = colourFor(win.result);
        g.globalAlpha = 0.6;
        g.fillRect(cx - ww / 2, y, ww, 4);
      }
      g.globalAlpha = 1;
      for (const e of this.hitErrors) {
        const age = time - e.time;
        const a = Math.max(0, 1 - age / 4000);
        if (a <= 0) continue;
        const x = cx + (e.offset / maxWindow) * (meterW / 2);
        g.globalAlpha = a;
        g.fillStyle = colourFor(e.result);
        g.fillRect(x - 1.5, y - 10, 3, 24);
      }
      g.globalAlpha = 1;
      g.fillStyle = '#fff';
      g.fillRect(cx - 1, y - 12, 2, 28);
    }

    // Key counter (right side).
    if (settings.get('gameplay.showKeyCounter', true) && this.actions.length <= 6 && !this.mods.isAutoplay) {
      const size = 36 * ui;
      const x = w - size - 12;
      let y = hgt / 2 - (this.actions.length * (size + 6)) / 2;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      for (const a of this.actions) {
        const held = (this.heldActions.get(a.id) ?? 0) > 0;
        g.fillStyle = held ? '#ff66aa' : 'rgba(0,0,0,0.45)';
        roundRect(g, x, y, size, size, 8);
        g.fill();
        g.fillStyle = '#fff';
        g.font = `700 ${Math.round(13 * ui)}px ${font}`;
        const count = this.actionCounts.get(a.id) ?? 0;
        const key = [...this.bindings.entries()].find(([, act]) => act === a.id)?.[0];
        g.fillText(count > 0 ? String(count) : key ? keyLabel(key) : a.label.slice(0, 2), x + size / 2, y + size / 2);
        y += size + 6;
      }
    }

    if (this.mods.isAutoplay || this.replay) {
      g.textAlign = 'center';
      g.textBaseline = 'top';
      g.font = `700 ${Math.round(16 * ui)}px ${font}`;
      g.fillStyle = 'rgba(255,255,255,0.6)';
      g.fillText(this.replay ? `REPLAY · ${this.replay.player.toUpperCase()}` : 'AUTOPLAY', w / 2, 14);
    }
  }

  private drawBreak(g: CanvasRenderingContext2D, w: number, hgt: number, time: number): void {
    const b = this.playable.breaks.find(x => time >= x.startTime && time <= x.endTime);
    if (!b) return;
    const remaining = b.endTime - time;
    const total = b.endTime - b.startTime;
    const fadeIn = Math.min(1, (time - b.startTime) / 300);
    const fadeOut = Math.min(1, remaining / 300);
    const a = Math.min(fadeIn, fadeOut);
    g.globalAlpha = a;
    const cx = w / 2;
    const cy = hgt / 2;
    const barW = Math.min(w * 0.6, 500) * (remaining / total);
    g.fillStyle = 'rgba(255,255,255,0.8)';
    g.fillRect(cx - barW / 2, cy - 1, barW, 2);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = '700 34px "Exo 2", system-ui, sans-serif';
    g.fillStyle = '#fff';
    g.fillText(String(Math.ceil(remaining / 1000 / this.mods.rate)), cx, cy - 34);
    g.font = '600 16px "Exo 2", system-ui, sans-serif';
    g.fillStyle = 'rgba(255,255,255,0.7)';
    g.fillText(`${(this.scoreProcessor.accuracy * 100).toFixed(2)}% · ${this.scoreProcessor.rank.replace('X', 'SS').replace('H', '')}`, cx, cy + 30);
    g.globalAlpha = 1;
  }
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  if (typeof g.roundRect === 'function') g.roundRect(x, y, w, h, Math.min(r, h / 2, w / 2));
  else g.rect(x, y, w, h);
}
