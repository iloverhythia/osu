// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Gameplay screen. Port of osu.Game/Screens/Play/Player.cs (+ SoloPlayer / ReplayPlayer essentials) together with the
// PlayerLoader stage (PlayerLoader.cs), MasterGameplayClockContainer / GameplayClockContainer start-time and skip logic,
// BreakTracker, ComboEffects, FailAnimationContainer and the HUD (HUDOverlay + the Argon default layout). The HUD and overlay
// components live in src/ui/hud.

import { getDisplayScore } from '../../game/scoring/DisplayScore';
import type { AudioEngine, LoopingSample, Track } from '../../framework/audio/AudioEngine';
import { GameplayClock } from '../../framework/audio/GameplayClock';
import { settings } from '../../framework/Settings';
import { HitSampleInfo } from '../../game/audio/HitSampleInfo';
import type { Beatmap } from '../../game/beatmaps/Beatmap';
import type { WorkingBeatmap } from '../../game/beatmaps/WorkingBeatmap';
import { applyDifficultyAdjust, type ModSet } from '../../game/mods/Mods';
import type { HealthProcessor } from '../../game/scoring/HealthProcessor';
import { DrainingHealthProcessor } from '../../game/scoring/HealthProcessor';
import { HitResult, affectsAccuracy, affectsCombo, isBasic, isBonus, isHit, isScorable } from '../../game/scoring/HitResult';
import type { HitWindows } from '../../game/scoring/HitWindows';
import type { JudgementResult } from '../../game/scoring/Judgement';
import type { ScoreProcessor } from '../../game/scoring/ScoreProcessor';
import type { ScoreRank } from '../../game/scoring/ScoreRank';
import { createSkin } from '../../game/Skin';
import { loadActiveSkin, loadBeatmapSkin, resolveSkinHitSample, restrictBeatmapSkin, type LoadedSkin } from '../../game/skinning';
import { loadStoryboard, type StoryboardPlayer } from '../../game/storyboard';
import type { DrawableRuleset, GameplayContext, LoopHandle, PlayableBeatmap, Ruleset } from '../../game/rulesets/Ruleset';
import { h } from '../dom';
import type { Game } from '../Game';
import { Screen } from '../Screen';
import { ResultsScreen, type PlayResult } from './Results';
import { ReplayRecorder, type Replay } from '../../game/replays/Replay';
import { osuPlayfieldTransform } from '../../game/rulesets/osu/playfield';
import { Anim, Easing } from '../hud/anim';
import { formatAccuracy } from '../hud/ArgonCounter';
import { BreakTracker, PAUSE_COOLDOWN_DURATION, RESULTS_DISPLAY_DELAY, findEarliestStartTime, gameplayStartTime, skipTarget, type Period } from '../hud/clock';
import { GameplayMenuOverlay, HoldForMenuButton, HoldToConfirmOverlay, OsuResumeOverlay, SkipOverlay } from '../hud/DomOverlays';
import { BreakOverlay, DelayedResumeOverlay, FailAnimation, KiaiFountains, drawLetterbox } from '../hud/GameplayOverlays';
import { HUDOverlay, type HUDVisibilityMode } from '../hud/HUDOverlay';
import { PlayerLoaderView } from '../hud/PlayerLoader';

/** Passed by a retrying player to its replacement (PlayerLoader.OnResuming / prepareForRestart). */
export interface PlayerRestartInfo {
  restartCount: number;
  quick: boolean;
}

/** PlayerLoader.BACKGROUND_BLUR */
const LOADER_BACKGROUND_BLUR = 15;
/** UserDimContainer.BREAK_LIGHTEN_AMOUNT / BACKGROUND_FADE_DURATION */
const BREAK_LIGHTEN_AMOUNT = 0.3;
const BACKGROUND_FADE_DURATION = 800;

export class PlayerScreen extends Screen {
  private canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private readonly loader: PlayerLoaderView;
  private readonly replayLabel: HTMLDivElement;

  private audio!: AudioEngine;
  private beatmap!: Beatmap;
  private playable!: PlayableBeatmap;
  private drawable!: DrawableRuleset;
  private scoreProcessor!: ScoreProcessor;
  private healthProcessor!: HealthProcessor;
  private track!: Track;
  private clock!: GameplayClock;
  private background: HTMLImageElement | null = null;
  private readonly bgCanvas: HTMLCanvasElement;
  private readonly bgDimEl: HTMLDivElement;
  private bgDimOpacity = -1;
  private bgBlur = 0;

  /** Player.BackgroundParallaxAmount */
  get backgroundParallaxAmount(): number {
    return 0.1;
  }
  private beatmapHitsounds = true;
  /** Key of what's currently drawn on the background layer (image + size), to redraw only when it changes. */
  private bgCanvasKey = '';
  private storyboard: StoryboardPlayer | null = null;
  private skins: LoadedSkin[] = [];
  private sampleResolver: (name: string) => AudioBuffer | null | undefined = () => undefined;

  private raf = 0;
  /** Player (and its beatmap) finished loading. */
  private loaded = false;
  /** The player has been "pushed" (gameplay started). */
  private gameplayStarted = false;
  private disposed = false;
  private paused = true;
  private failed = false;
  private hasPassed = false;
  private hasQuit = false;
  private isRestarting = false;
  private resultsAt: number | null = null;
  private resultsShown = false;
  private lastFrameReal = 0;
  private lastFrameGameTime = 0;
  /** GameplayClockContainer.StartTime */
  private startTime = 0;
  /** DrawableRuleset.GameplayStartTime */
  private gameplayStart = 0;
  private firstObjectTime = 0;
  private lastObjectTime = 0;
  private easyLives = 2;
  private completed = false;
  private firstComboBreakTime: number | null = null;

  // PlayerLoader stage
  private loaderEnteredAt = 0;
  private pushAt: number | null = null;
  private readonly lowPass = new Anim(22049);
  private previewStopped = false;

  // Player.OnEntering transitions
  private enteredAt = 0;
  private readonly bgDim = new Anim(0.2);
  private bgDimTarget = -1;

  // input
  private bindings = new Map<string, string>(); // code -> action
  private heldActions = new Map<string, number>(); // action -> hold count
  private actions: { id: string; label: string }[] = [];
  private readonly disableMouseButtons = settings.get('gameplay.disableMouseButtons', false);
  private loops = new Set<LoopingSample>();
  private holdVolume = 1;

  // Replays / autoplay
  private recorder: ReplayRecorder | null = null;
  /** The replay driving input: an external replay, or the ruleset's generated autoplay. */
  private playback: Replay | null;
  private autoplayInternal = false;
  private replayIndex = 0;
  private replayPaused = false;
  private viewW = 1;
  private viewH = 1;
  private dpr = 1;

  // HUD and overlays
  private hud: HUDOverlay | null = null;
  private breakTracker!: BreakTracker;
  private lastBreakPeriod: Period | null = null;
  private wasBreakTime = true;
  private readonly breakOverlay = new BreakOverlay();
  private readonly failAnimation = new FailAnimation();
  private readonly fountains = new KiaiFountains();
  private failCanvas: HTMLCanvasElement | null = null;
  private skipIntro: SkipOverlay | null = null;
  private skipOutro: SkipOverlay | null = null;
  private autoSkipQueued = false;
  private nextAutoSkipAt = 0;
  private readonly pauseMenu: GameplayMenuOverlay;
  private readonly failMenu: GameplayMenuOverlay;
  private readonly holdForMenu: HoldForMenuButton;
  private readonly retryOverlay: HoldToConfirmOverlay;
  private readonly exitOverlay: HoldToConfirmOverlay;
  private readonly osuResume = new OsuResumeOverlay();
  private delayedResume: DelayedResumeOverlay | null = null;
  private isResuming = false;
  private lastPauseActionTime: number | null = null;
  private focusLost = false;
  private pauseLoop: LoopingSample | null = null;

  /** Last pointer position (CSS px), used by the osu! resume overlay. */
  private lastPointer: { x: number; y: number } | null = null;

  constructor(
    game: Game,
    private readonly working: WorkingBeatmap,
    private readonly ruleset: Ruleset,
    private readonly mods: ModSet,
    /** When set, the play is driven by this replay instead of user input. */
    private readonly replay: Replay | null = null,
    private readonly restart: PlayerRestartInfo | null = null,
  ) {
    super(game, 'player');
    this.showTriangles = false;
    this.backgroundDim = 0.2;
    this.playback = replay;
    this.canvas = h('canvas', { class: 'game' });
    this.canvas.style.visibility = 'hidden';
    // The beatmap background lives on its own layer below the game canvas and is only redrawn on resize:
    // re-scaling a full-screen image into the game canvas every frame is very expensive at high resolutions.
    this.bgCanvas = h('canvas', { class: 'game game-bg' });
    this.bgCanvas.style.visibility = 'hidden';
    // UserDimContainer's dim is a black layer composited by the browser (no per-frame full-screen fill).
    this.bgDimEl = h('div', { class: 'game-bg-dim' });
    this.g = this.canvas.getContext('2d', { alpha: true, desynchronized: true } as CanvasRenderingContext2DSettings) as CanvasRenderingContext2D;
    const e = working.entry;
    const unicode = settings.get('ui.preferUnicode', false);
    this.loader = new PlayerLoaderView({
      title: unicode && e.titleUnicode ? e.titleUnicode : e.title,
      artist: unicode && e.artistUnicode ? e.artistUnicode : e.artist,
      version: e.difficultyName,
      source: e.source,
      mapper: e.creator,
      stars: e.rulesetId === ruleset.id && mods.isEmpty ? e.stars : undefined,
      backgroundUrl: working.getBackgroundUrl(),
      mods,
      epilepsyWarning: false,
      watching: replay ? `Watching ${replay.player}'s replay` : undefined,
    });
    this.replayLabel = h('div', { class: 'player-replay-label', style: { display: 'none' } });

    const holdDelay = settings.get('ui.holdActivationDelay', 200);
    this.pauseMenu = new GameplayMenuOverlay('pause', { onResume: () => this.resume(), onRetry: () => this.retry(false), onQuit: () => this.performExitWithConfirmation() });
    this.failMenu = new GameplayMenuOverlay('fail', { onRetry: () => this.retry(false), onQuit: () => this.performExitWithConfirmation() });
    this.holdForMenu = new HoldForMenuButton(holdDelay);
    this.holdForMenu.hold.onConfirm = () => {
      this.holdForMenu.confirmed(performance.now());
      this.performExitWithConfirmation();
    };
    this.retryOverlay = new HoldToConfirmOverlay(holdDelay);
    this.retryOverlay.hold.onConfirm = () => this.retry(true);
    this.exitOverlay = new HoldToConfirmOverlay(holdDelay);
    this.exitOverlay.hold.onConfirm = () => this.performExit();
    this.osuResume.onResume = () => this.completeResume();

    this.el.classList.add('player-loading');
    this.el.append(
      this.bgCanvas,
      this.bgDimEl,
      this.canvas,
      this.replayLabel,
      this.holdForMenu.el,
      this.osuResume.el,
      this.pauseMenu.el,
      this.failMenu.el,
      this.loader.el,
      this.retryOverlay.el,
      this.exitOverlay.el,
    );
  }

  onEnter(): void {
    this.game.setBackgroundDim(0.2, LOADER_BACKGROUND_BLUR);
    this.loaderEnteredAt = performance.now();
    this.loader.enter(this.restart ? (this.restart.quick ? 'quick' : 'restart') : 'first');
    // A retry comes back to the loader after the initial push delay has already passed.
    if (this.restart) this.loaderEnteredAt -= 1e6;
    this.raf = requestAnimationFrame(this.frame);
    void this.load().catch(err => {
      console.error(err);
      this.game.toast(`Couldn't load beatmap: ${err instanceof Error ? err.message : String(err)}`, 'error', 6000);
      this.game.pop();
    });
  }

  // ------------------------------------------------------------------ loading

  private async load(): Promise<void> {
    this.audio = await this.game.ensureAudio();
    // PlayerLoader.contentIn: low pass the music to 1000Hz over 650ms (OutQuint).
    const max = Math.min(22049, this.audio.ctx.sampleRate / 2);
    this.lowPass.set(max, performance.now()).to(1000, 650, Easing.OutQuint, performance.now());
    await this.audio.loadDefaultSamples();
    this.beatmap = await this.working.getBeatmap();
    // PlayerLoader: the epilepsy disclaimer (hidden when storyboards are disabled), which also extends PlayerPushDelay.
    if (this.beatmap.epilepsyWarning && settings.get('gameplay.storyboard', true)) this.loader.addEpilepsyWarning();
    if (!this.ruleset.canConvert(this.beatmap)) throw new Error(`This beatmap can't be played in ${this.ruleset.name}`);

    this.playable = this.ruleset.createPlayable(applyDifficultyAdjust(this.beatmap, this.mods), this.mods);
    if (this.playable.objectTimes.length === 0) throw new Error('Beatmap has no hit objects');

    const track = this.working.createTrack(this.audio);
    if (!track) throw new Error(`Missing audio file "${this.working.entry.audioFile}"`);
    this.track = track;
    this.track.preservePitch = this.mods.preservePitch;

    // OsuSetting.BeatmapSkins / BeatmapColours / BeatmapHitsounds
    const beatmapSkinAllow = { skins: settings.get('skin.beatmapSkins', true), colours: settings.get('skin.beatmapColours', true), hitsounds: settings.get('skin.beatmapHitsounds', true) };
    this.beatmapHitsounds = beatmapSkinAllow.hitsounds;
    const [bg, resolver, storyboard, userSkin, beatmapSkin] = await Promise.all([
      this.working.loadBackgroundImage(),
      this.working.preloadSamples(this.audio, this.collectSampleLookups()),
      settings.get('gameplay.storyboard', true) ? loadStoryboard(this.working, this.beatmap, this.audio).catch(() => null) : Promise.resolve(null),
      loadActiveSkin(this.audio).catch(() => null),
      beatmapSkinAllow.skins || beatmapSkinAllow.colours || beatmapSkinAllow.hitsounds
        ? loadBeatmapSkin(this.working.set, this.audio, this.working.entry.filename).then(s => restrictBeatmapSkin(s, beatmapSkinAllow)).catch(() => null)
        : Promise.resolve(null),
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

    // Autoplay is a generated replay fed through the normal input path (lazer's ReplayInputHandler), when the ruleset can make one.
    if (this.mods.isAutoplay && this.ruleset.generateAutoplay && !this.replay) this.playback = this.ruleset.generateAutoplay(this.playable);
    this.autoplayInternal = this.mods.isAutoplay && this.playback == null;
    if (!this.playback && !this.mods.isAutoplay) this.recorder = new ReplayRecorder();

    const ctx = this.createContext();
    this.drawable = this.ruleset.createDrawableRuleset(this.playable, ctx);

    this.firstObjectTime = Math.min(...this.playable.objectTimes.map(t => t.start));
    this.lastObjectTime = Math.max(...this.playable.objectTimes.map(t => t.end));

    // DrawableRuleset.GameplayStartTime and MasterGameplayClockContainer.findEarliestStartTime.
    this.gameplayStart = gameplayStartTime(this.ruleset.shortName, this.firstObjectTime, this.ruleset.shortName === 'osu' ? (this.drawable.leadInTime ?? 0) : 0);
    this.startTime = findEarliestStartTime(this.gameplayStart, this.firstObjectTime, this.beatmap.audioLeadIn, this.storyboard?.earliestEventTime ?? null);
    this.breakTracker = new BreakTracker(this.gameplayStart, this.playable.breaks);

    this.clock = new GameplayClock(this.track, this.mods.rate);
    this.clock.offset = settings.get('audio.offset', 0) + (settings.get('audio.compensateLatency', true) ? this.audio.outputLatency : 0);
    this.clock.seek(this.startTime);
    this.lastFrameGameTime = this.startTime;

    this.loaded = true;
    this.loader.setLoading(false);
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
    // ModAccuracyChallenge (AccuracyMode.MaximumAchievable, the default): fail once the minimum can no longer be reached.
    if (this.mods.has('AC')) {
      const minimum = this.mods.setting<number>('AC', 'minimumAccuracy');
      this.scoreProcessor.onChange.push(() => {
        if (this.scoreProcessor.maximumAchievableAccuracy < minimum) hp.triggerFailure();
      });
    }
  }

  /** DrawableRuleset.FirstAvailableHitWindows → the windows shown by the hit error meter. */
  private hitWindows(): { result: HitResult; length: number }[] {
    const withWindows = (this.playable.hitObjects as { hitWindows?: HitWindows | null }[]).find(o => o && o.hitWindows && typeof o.hitWindows.getAllAvailableWindows === 'function');
    if (!withWindows?.hitWindows) return [];
    try {
      return withWindows.hitWindows.getAllAvailableWindows().filter(w => w.result !== HitResult.Miss && w.length > 0);
    } catch {
      return [];
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
    window.addEventListener('focus', this.onFocus);
    document.addEventListener('visibilitychange', this.onBlur);
  }

  private createContext(): GameplayContext {
    const self = this;
    // Beatmap [Colours] come through the beatmap skin's colour lookups (BeatmapColours).
    const beatmapColours = settings.get('skin.beatmapColours', true);
    const skin = createSkin(beatmapColours && this.beatmap.comboColours.length > 0 ? this.beatmap.comboColours : null, beatmapColours ? this.beatmap.customColours : {}, this.skins);
    return {
      mods: this.mods,
      skin,
      settings: { get: <T,>(key: string, fallback: T) => settings.get<T>(key, fallback) },
      autoplay: this.autoplayInternal,
      rate: this.mods.rate,
      applyResult: (r: JudgementResult) => this.applyResult(r),
      playSamples: (samples, opts) => {
        this.storyboard?.onSamplesPlayed?.(samples);
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

  /** As in lazer: beatmap samples first, then each skin across all lookup names, then the default samples. */
  private resolveSample(s: HitSampleInfo): AudioBuffer | null {
    for (const name of s.lookupNames) {
      if (!name.startsWith('beatmap:') || !this.beatmapHitsounds) continue;
      if (this.working.isSilenced(name)) return null;
      const b = this.sampleResolver(name);
      if (b) return b;
    }
    const sk = resolveSkinHitSample(this.skins, s, undefined, this.ruleset.shortName === 'taiko' ? 'taiko-' : undefined);
    if (sk) return sk;
    for (const name of s.lookupNames) {
      if (name.startsWith('beatmap:')) continue;
      const plain = name.startsWith('Gameplay/') ? name.slice('Gameplay/'.length) : name;
      const d = this.audio.getDefaultSample(plain);
      if (d) return d;
    }
    return null;
  }

  /** SkinnableSound for non-hitobject gameplay samples (combobreak, failsound, pause-loop, ...): skin first, then a default. */
  private gameplaySample(skinName: string, fallback?: string): AudioBuffer | null {
    for (const skin of this.skins) {
      const b = skin.getSample(skinName);
      if (b) return b;
    }
    return (this.audio?.getDefaultSample(fallback ?? skinName) ?? null) as AudioBuffer | null;
  }

  private playGameplaySample(skinName: string, fallback?: string, volume = 1, rate = 1): void {
    const b = this.audio ? this.gameplaySample(skinName, fallback) : null;
    if (b) this.audio.play(b, { volume: volume * this.holdVolume, rate });
  }

  private playSample(s: HitSampleInfo, pan: number, volume: number, rate = 1): void {
    const buffer = this.resolveSample(s);
    if (!buffer) return;
    const v = (s.volume > 0 ? s.volume : 100) / 100;
    // OsuSetting.HitsoundVolume applies to gameplay hitsounds only.
    this.audio.play(buffer, { pan, volume: v * volume * this.holdVolume * settings.get('audio.hitsound', 0.6), rate });
  }

  private startLoop(s: HitSampleInfo, pan: number, volume: number): LoopHandle | null {
    const buffer = this.resolveSample(s);
    if (!buffer) return null;
    const v = ((s.volume > 0 ? s.volume : 100) / 100) * settings.get('audio.hitsound', 0.6);
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
    const healthBefore = this.healthProcessor.health;
    r.gameplayRate = this.mods.rate;
    this.healthProcessor.applyResult(r);
    this.scoreProcessor.applyResult(r);
    this.storyboard?.onJudgement?.(r);

    // ComboEffects: combobreak when the combo resets from above 20, or on the first break when AlwaysPlayFirstComboBreak is set.
    const combo = this.scoreProcessor.combo;
    if (combo !== comboBefore && combo === 0 && comboBefore > 0) {
      if (comboBefore > 20 || (settings.get('gameplay.alwaysPlayFirstComboBreak', true) && this.firstComboBreakTime == null)) {
        this.firstComboBreakTime = this.lastFrameGameTime;
        if (settings.get('gameplay.comboBreakSound', true)) this.playGameplaySample('combobreak');
      }
    }

    const hw = (r.hitObject as { hitWindows?: HitWindows | null } | null)?.hitWindows;
    const missWindowZero = hw && typeof hw.windowFor === 'function' ? hw.windowFor(HitResult.Miss) === 0 : !isBasic(r.judgement.maxResult);
    this.hud?.onJudgement(
      {
        isHit: isHit(r.type),
        type: r.type,
        timeOffset: r.timeOffset,
        ignoreHit: r.type === HitResult.IgnoreHit,
        scorable: isScorable(r.type),
        bonus: isBonus(r.type),
        missWindowZero,
        healthIncrease: this.healthProcessor.health - healthBefore,
      },
      performance.now(),
    );
  }

  private onFail(): void {
    if (this.failed || this.healthProcessor.noFail || this.hasQuit) return;
    // ModEasyWithExtraLives (osu! and osu!catch; TaikoModEasy has no extra lives, ManiaHealthProcessor handles its own).
    const hasExtraLives = this.ruleset.shortName === 'osu' || this.ruleset.shortName === 'fruits';
    if (hasExtraLives && this.mods.has('EZ') && this.easyLives > 0 && !this.mods.has('SD') && !this.mods.has('PF')) {
      this.easyLives--;
      this.healthProcessor.failed = false;
      this.healthProcessor.health = 1;
      return;
    }
    if (this.replay) {
      // ReplayPlayer: replays may only fail once their frames are exhausted, and show a fail indicator instead of the animation.
      const last = this.replay.events[this.replay.events.length - 1]?.t ?? 0;
      if (this.lastFrameGameTime < last) {
        this.healthProcessor.failed = false;
        return;
      }
      this.scoreProcessor.fail();
      return;
    }
    this.performFail();
  }

  /** Player.PerformFail */
  private performFail(): void {
    this.failed = true;
    this.scoreProcessor.fail();
    if (this.pauseMenu.visible) this.pauseMenu.hide();
    this.cancelResume();
    const now = performance.now();
    this.failAnimation.start(now);
    this.track.preservePitch = false;
    this.playGameplaySample('failsound', 'fail', 0.8);
    for (const l of this.loops) l.stop();
    this.releaseAll();
  }

  /** FailAnimationContainer.OnComplete → Player.onFailComplete */
  private onFailComplete(): void {
    this.clock.stop();
    this.paused = true;
    this.el.classList.add('show-cursor');
    this.failMenu.show(this.menuInfo());
    this.startPauseLoop();
  }

  // ------------------------------------------------------------------ input handlers

  private eventTime(timeStamp: number): number {
    // Map the event timestamp onto the gameplay timeline for sub-frame precision.
    const t = this.lastFrameGameTime + (timeStamp - this.lastFrameReal) * this.mods.rate;
    return Math.max(this.lastFrameGameTime, Math.min(t, this.lastFrameGameTime + 50));
  }

  private get inputBlocked(): boolean {
    return !this.gameplayStarted || this.paused || this.failed || this.autoplayInternal || this.playback != null;
  }

  private actionIndex(action: string): number {
    return this.actions.findIndex(a => a.id === action);
  }

  private press(action: string, time: number): void {
    const held = this.heldActions.get(action) ?? 0;
    this.heldActions.set(action, held + 1);
    if (held === 0) {
      this.hud?.keyCounter.activate(this.actionIndex(action), performance.now());
      this.recorder?.press(time, action);
      this.drawable.onPressed(action, time);
    }
  }

  private release(action: string, time: number): void {
    const held = this.heldActions.get(action) ?? 0;
    if (held <= 0) return;
    this.heldActions.set(action, held - 1);
    if (held === 1) {
      this.hud?.keyCounter.deactivate(this.actionIndex(action), performance.now());
      this.recorder?.release(time, action);
      this.drawable.onReleased(action, time);
    }
  }

  private releaseAll(): void {
    for (const [action, n] of this.heldActions)
      if (n > 0) {
        this.hud?.keyCounter.deactivate(this.actionIndex(action), performance.now());
        this.recorder?.release(this.lastFrameGameTime, action);
        this.drawable?.onReleased(action, this.lastFrameGameTime);
      }
    this.heldActions.clear();
  }

  onKeyDown(e: KeyboardEvent): boolean {
    if (!this.gameplayStarted) return false;
    const now = performance.now();
    // HotkeyExitOverlay (Ctrl+Tilde) / HotkeyRetryOverlay (Tilde, Ctrl+R).
    if (e.code === 'Backquote' && e.ctrlKey) {
      if (!e.repeat) this.exitOverlay.hold.begin(now);
      return true;
    }
    if ((e.code === 'Backquote' && !e.ctrlKey) || (e.code === 'KeyR' && e.ctrlKey)) {
      if (!e.repeat) this.retryOverlay.hold.begin(now);
      return true;
    }
    // HUDOverlay: Shift+Tab toggles the in-game interface; Control is held for the HUD.
    if (e.code === 'Tab' && e.shiftKey) {
      if (!e.repeat && this.hud) settings.set('gameplay.hudVisibilityMode', this.hud.cycleMode());
      return true;
    }
    if ((e.code === 'ControlLeft' || e.code === 'ControlRight') && this.hud && !e.repeat) this.hud.holdingForHUD = true;

    const menu = this.pauseMenu.visible ? this.pauseMenu : this.failMenu.visible ? this.failMenu : null;
    if (menu) return menu.onKey(e.code);

    if (this.osuResume.visible) {
      const action = this.bindings.get(e.code);
      if (action && !e.repeat && (action === 'LeftButton' || action === 'RightButton')) this.osuResume.tryResumeFromAction();
      return !!action;
    }
    if (this.paused && !this.replayPaused) return false;

    // SkipCutscene (Space) takes priority while a skip is available.
    if (e.code === 'Space' && !e.repeat) {
      if (this.skipIntro?.click() || this.skipOutro?.click()) return true;
      // ReplayPlayer: TogglePauseReplay.
      if (this.playback && !this.autoplayInternal) {
        this.toggleReplayPause();
        return true;
      }
    }
    const action = this.bindings.get(e.code);
    if (action) {
      if (!e.repeat && !this.inputBlocked) this.press(action, this.eventTime(e.timeStamp));
      return true;
    }
    return false;
  }

  onKeyUp(e: KeyboardEvent): boolean {
    const now = performance.now();
    if (e.code === 'Backquote' || e.code === 'KeyR' || e.code === 'ControlLeft' || e.code === 'ControlRight') {
      this.retryOverlay.hold.abort(now);
      this.exitOverlay.hold.abort(now);
    }
    if ((e.code === 'ControlLeft' || e.code === 'ControlRight') && this.hud) this.hud.holdingForHUD = false;
    const action = this.bindings.get(e.code);
    if (action && this.gameplayStarted && !this.autoplayInternal && !this.playback) {
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
    const now = performance.now();
    this.holdForMenu.setTouchActive(e.pointerType === 'touch' || e.pointerType === 'pen', now);
    // GlobalAction.PauseGameplay (middle mouse) / TogglePauseReplay.
    if (e.button === 1 && e.pointerType === 'mouse') {
      e.preventDefault();
      if (this.pauseMenu.visible) this.pauseMenu.pauseGameplayAction();
      else if (this.playback && !this.autoplayInternal) this.toggleReplayPause();
      else if (!this.playback && !this.failed) this.performExitWithConfirmation();
      return;
    }
    if (this.inputBlocked) return;
    e.preventDefault();
    const p = this.localPos(e);
    this.lastPointer = p;
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
    if (e.pointerType === 'mouse' && (e.movementX !== 0 || e.movementY !== 0)) this.holdForMenu.setTouchActive(false, performance.now());
    if (e.pointerType === 'mouse') this.hud?.setPointer(this.localPos(e));
    if (!this.gameplayStarted || this.paused || this.playback || this.failed) return;
    const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [e];
    for (const ev of events.length > 0 ? events : [e]) {
      const p = this.localPos(ev);
      const t = this.eventTime(ev.timeStamp);
      if (e.pointerType === 'touch' || e.pointerType === 'pen') {
        this.recordTouch('tm', e.pointerId, p, t);
        this.drawable.onTouchMove?.(e.pointerId, p.x, p.y, t);
      } else {
        this.lastPointer = p;
        this.recordMove(p, t);
        this.drawable.onPointerMove?.(p.x, p.y, t);
      }
    }
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (!this.gameplayStarted || this.playback) return;
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
    const replay = this.playback;
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

  private toggleReplayPause(): void {
    if (this.failed || this.resultsShown) return;
    this.replayPaused = !this.replayPaused;
    this.paused = this.replayPaused;
    if (this.replayPaused) this.clock.stop();
    else {
      this.lastFrameReal = performance.now();
      this.clock.start();
    }
  }

  private onBlur = (): void => {
    if (document.visibilityState === 'hidden' || !document.hasFocus()) this.focusLost = true;
  };

  private onFocus = (): void => {
    this.focusLost = false;
  };

  private resize = (): void => {
    const w = this.canvas.clientWidth || window.innerWidth;
    const hgt = this.canvas.clientHeight || window.innerHeight;
    let dpr = Math.min(3, (window.devicePixelRatio || 1) * settings.get('graphics.renderScale', 1));
    // Canvas 2D cost grows with pixel count; cap the backing store at ~4.2 megapixels (2560×1640) so
    // high-density / 4K screens stay smooth. The render resolution setting can still lower it further.
    const MAX_PIXELS = 2560 * 1640;
    if (w * hgt * dpr * dpr > MAX_PIXELS) dpr = Math.sqrt(MAX_PIXELS / (w * hgt));
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(hgt * dpr);
    this.viewW = w;
    this.viewH = hgt;
    this.dpr = dpr;
  };

  // ------------------------------------------------------------------ flow

  /** Player.OnEntering + StartGameplay (the PlayerLoader pushing the loaded player). */
  private startGameplay(now: number): void {
    this.gameplayStarted = true;
    this.loader.contentOut();
    setTimeout(() => this.loader.el.remove(), 700);
    // PlayerLoader.OnSuspending: the (preview) track is stopped; ContentOut restores the low pass over 300ms.
    this.game.stopPreview();
    this.previewStopped = true;
    this.lowPass.to(Math.min(22049, this.audio.ctx.sampleRate / 2), 300, Easing.None, now);
    this.el.classList.remove('player-loading');
    this.canvas.style.visibility = '';
    this.bgCanvas.style.visibility = '';
    this.game.setBackgroundDim(1, 0);
    this.resize();
    this.enteredAt = now;
    this.bgDim.set(0.2, now);

    const cinema = this.mods.has('CN');
    const hudMode = settings.get<HUDVisibilityMode | null>('gameplay.hudVisibilityMode', null) ?? (settings.get('gameplay.showHud', true) ? 'always' : 'never');
    this.hud = new HUDOverlay(
      {
        rulesetShortName: this.ruleset.shortName,
        mods: this.mods,
        actionCount: this.actions.length,
        hitWindows: this.hitWindows(),
        objectTimes: [...this.playable.objectTimes].sort((a, b) => a.start - b.start),
        replayLoaded: this.playback != null || this.autoplayInternal,
        drainingHealth: this.healthProcessor instanceof DrainingHealthProcessor,
        initialHealth: this.healthProcessor.health,
        showHealthBar: !this.mods.has('NF') || settings.get('gameplay.showHealthDisplayWhenCantFail', true),
      },
      now,
      hudMode,
    );
    this.hud.keyCounter.isCounting = false;
    if (cinema) {
      this.hud.setShowHud(false, now);
      this.hud.showHudDisabled = true;
      this.breakOverlay.hidden = true;
    }
    if (this.playback || this.autoplayInternal) {
      this.replayLabel.textContent = this.replay ? `Watching ${this.replay.player} play ${this.working.entry.title}` : 'AUTOPLAY';
      this.replayLabel.style.display = cinema ? 'none' : '';
    }

    // SkipOverlay (intro) and the storyboard outro skip.
    this.skipIntro = new SkipOverlay(this.gameplayStart);
    this.skipIntro.requestSkip = () => this.performIntroSkip();
    this.skipIntro.playConfirm = () => this.game.playUiSample('menu-confirm', 0.8);
    this.el.insertBefore(this.skipIntro.el, this.holdForMenu.el);
    if (!this.skipIntro.load(this.startTime, now) || cinema) this.skipIntro.expire();
    const latest = this.storyboard?.latestEventTime ?? null;
    if (latest != null && !cinema) {
      this.skipOutro = new SkipOverlay(latest);
      this.skipOutro.requestSkip = () => this.progressToResults(false);
      this.el.insertBefore(this.skipOutro.el, this.holdForMenu.el);
      if (!this.skipOutro.load(this.startTime, now, false)) this.skipOutro = null;
    }

    // GameplayClockContainer.Reset(startClock: true)
    this.clock.seek(this.startTime);
    this.lastFrameGameTime = this.startTime;
    this.lastFrameReal = now;
    this.paused = false;
    this.clock.start();
    // PlayerConfiguration.AutomaticallySkipIntro |= QuickRestart → SkipOverlay.SkipWhenReady
    if (this.restart?.quick) {
      this.autoSkipQueued = true;
      this.nextAutoSkipAt = now + 200;
    }
  }

  private performIntroSkip(): void {
    const target = skipTarget(this.clock.currentTime, this.gameplayStart, this.startTime);
    if (target == null) return;
    const wasRunning = !this.paused;
    this.clock.stop();
    this.clock.seek(target);
    this.lastFrameGameTime = target;
    if (wasRunning) this.clock.start();
  }

  private get pausingSupportedByCurrentState(): boolean {
    return this.loaded && this.gameplayStarted && !this.hasPassed && this.playback == null && !this.autoplayInternal && !this.failed;
  }

  private get localUserPlaying(): boolean {
    return this.playback == null && !this.autoplayInternal && !this.hasPassed && !this.failed && !(this.breakTracker?.isBreakTime || this.paused);
  }

  private get pauseCooldownActive(): boolean {
    return this.localUserPlaying && this.lastPauseActionTime != null && this.clock.currentTime < this.lastPauseActionTime + PAUSE_COOLDOWN_DURATION;
  }

  /** Player.Pause */
  private pause(): boolean {
    if (!this.pausingSupportedByCurrentState) return false;
    if (!this.isResuming && this.pauseCooldownActive) return false;
    if (this.isResuming) this.cancelResume();
    this.paused = true;
    this.clock.stop();
    this.releaseAll();
    for (const l of this.loops) l.setVolume(0);
    this.el.classList.add('show-cursor');
    this.pauseMenu.show(this.menuInfo());
    this.startPauseLoop();
    this.lastPauseActionTime = this.clock.currentTime;
    return true;
  }

  private menuInfo(): { retries: number; progress: number | null; accuracy: string } {
    const length = this.lastObjectTime - this.firstObjectTime;
    const progress = length === 0 ? 0 : Math.floor(Math.max(0, Math.min(1, (this.clock.currentTime - this.firstObjectTime) / length)) * 100);
    return { retries: this.restart?.restartCount ?? 0, progress, accuracy: formatAccuracy(this.scoreProcessor.accuracy) };
  }

  private startPauseLoop(): void {
    this.stopPauseLoop();
    const b = this.gameplaySample('pause-loop');
    if (b && this.audio) this.pauseLoop = this.audio.loop(b, { volume: 1 });
  }

  private stopPauseLoop(): void {
    this.pauseLoop?.stop();
    this.pauseLoop = null;
  }

  /** Player.Resume */
  private resume(): void {
    if (!this.paused || this.failed || this.isResuming) return;
    this.isResuming = true;
    this.pauseMenu.hide();
    this.stopPauseLoop();
    // breaks and time-based conditions may allow instant resume.
    if (this.breakTracker.isBreakTime) {
      this.completeResume();
      return;
    }
    // DrawableRuleset.RequestResume: OsuResumeOverlay (osu!, unless Autopilot / Touch Device) or DelayedResumeOverlay.
    const now = performance.now();
    if (this.ruleset.shortName === 'osu' && !this.mods.has('AP') && !this.mods.has('TD')) {
      const p = this.lastPointer;
      // Can't display if the cursor is outside the window.
      if (!p || p.x < 0 || p.y < 0 || p.x > this.viewW || p.y > this.viewH) {
        this.completeResume();
        return;
      }
      this.osuResume.show(p.x, p.y);
      return;
    }
    const scale = this.ruleset.shortName === 'fruits' || this.ruleset.shortName === 'osu' ? 0.65 : 1;
    this.delayedResume = new DelayedResumeOverlay(scale);
    this.delayedResume.onResume = () => this.completeResume();
    this.delayedResume.onCount = count => this.game.playUiSample('menu-click', count === 0 ? 0.4 : 0.6);
    this.delayedResume.show(now);
  }

  private completeResume(): void {
    if (!this.paused) return;
    this.isResuming = false;
    this.osuResume.hide();
    this.paused = false;
    this.el.classList.remove('show-cursor');
    this.lastFrameReal = performance.now();
    this.clock.start();
  }

  private cancelResume(): void {
    if (!this.isResuming) return;
    this.isResuming = false;
    this.osuResume.hide();
    this.delayedResume?.hide(performance.now());
  }

  onBack(): boolean {
    if (!this.gameplayStarted) return true;
    if (this.resultsShown) return true;
    const menu = this.pauseMenu.visible ? this.pauseMenu : this.failMenu.visible ? this.failMenu : null;
    if (menu) {
      menu.back();
      return false;
    }
    // HoldForMenuButton: GlobalAction.Back confirms immediately (not a dangerous action, AlwaysRequireHoldingForPause off).
    this.holdForMenu.hold.confirm();
    return false;
  }

  /** Player.PerformExitWithConfirmation */
  private performExitWithConfirmation(): boolean {
    const dialogVisible = this.pauseMenu.visible || this.failMenu.visible;
    if (!dialogVisible) {
      // if the fail animation is currently in progress, accelerate it (it will show the fail dialog on completion).
      if (!this.hasPassed && this.failed) {
        this.failAnimation.finishNow(performance.now());
        return false;
      }
      if (this.pausingSupportedByCurrentState) {
        this.pause();
        return false;
      }
    }
    return this.performExit();
  }

  /** Player.PerformExit */
  private performExit(): boolean {
    // Matching osu!stable behaviour, if the results screen is pending and the user requests an exit, show the results instead.
    if (this.hasPassed && !this.isRestarting) {
      this.progressToResults(false);
      return false;
    }
    if (!this.hasPassed && !this.failed) this.hasQuit = true;
    if (this.game.currentScreen === this) this.game.pop();
    return true;
  }

  /** Player.Restart → PlayerLoader.prepareForRestart. */
  private retry(quick: boolean): void {
    if (this.isRestarting || this.disposed) return;
    this.isRestarting = true;
    this.track?.stop();
    this.game.replace(new PlayerScreen(this.game, this.working, this.ruleset, this.mods, this.replay, { restartCount: (this.restart?.restartCount ?? 0) + 1, quick }));
  }

  /** Player.checkScoreCompleted */
  private checkScoreCompleted(now: number): void {
    if (this.failed) return;
    this.hasPassed = true;
    this.cancelResume();
    const sb = this.storyboard;
    const storyboardStillRunning = sb != null && sb.latestEventTime != null && this.currentDim() < 1 && this.clock.currentTime < sb.latestEventTime;
    if (storyboardStillRunning && this.skipOutro) {
      this.skipOutro.show(now);
      return;
    }
    this.progressToResults(true);
  }

  private progressToResults(withDelay: boolean): void {
    if (this.resultsShown) return;
    const at = performance.now() + (withDelay ? RESULTS_DISPLAY_DELAY : 0);
    this.resultsAt = this.resultsAt == null ? at : Math.min(this.resultsAt, at);
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
      passed: !this.failed && !sp.failed,
      replay: this.recorder
        ? { rulesetId: this.ruleset.id, space: this.replaySpace, events: this.recorder.events, player: settings.get('ui.username', 'Guest'), mods: this.mods.list, modSettings: this.mods.settings }
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
    window.removeEventListener('focus', this.onFocus);
    document.removeEventListener('visibilitychange', this.onBlur);
    for (const l of this.loops) l.stop();
    this.stopPauseLoop();
    if (this.audio) this.audio.musicFilter.frequency.value = this.audio.ctx.sampleRate / 2;
    this.drawable?.dispose?.();
    this.storyboard?.dispose();
    this.track?.dispose();
    if (this.previewStopped && !this.resultsShown && !this.isRestarting) void this.game.startPreview();
  }

  // ------------------------------------------------------------------ frame loop

  private frame = (): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.frame);
    const now = performance.now();
    if (this.audio) this.audio.musicFilter.frequency.value = this.failAnimation.started ? this.failAnimation.lowPassCutoff(now, this.audio.ctx.sampleRate) : this.lowPass.valueAt(now);

    if (!this.gameplayStarted) {
      this.loaderFrame(now);
      return;
    }
    const realElapsed = now - this.lastFrameReal;

    // Hotkey overlays (volume ducking follows their progress).
    const retryVolume = this.retryOverlay.update(now);
    const exitVolume = this.exitOverlay.update(now);
    this.holdVolume = Math.min(retryVolume, exitVolume);
    this.holdForMenu.update(now);

    // FailAnimationContainer: track frequency → 0 (the gameplay clock follows), volume 0.5.
    let trackVolume = this.holdVolume;
    if (this.failAnimation.started) {
      const freq = this.failAnimation.trackFrequency(now);
      this.clock.rate = this.mods.rate * freq;
      const r = this.mods.rate * freq;
      if (r < 0.07) this.track.stop();
      else this.track.rate = r;
      trackVolume *= 0.5;
      if (this.failAnimation.update(now)) this.onFailComplete();
    }
    this.track.volume = trackVolume;

    let elapsed = 0;
    if (!this.paused) elapsed = this.clock.update();
    const time = this.clock.currentTime;
    this.lastFrameReal = now;
    this.lastFrameGameTime = time;

    if (!this.paused) {
      this.playReplayTo(time);
      this.drawable.update(time, elapsed);
      if (!this.failed) this.healthProcessor.update(time, elapsed);
    }

    // BreakTracker
    const scoreCompleted = this.completed;
    this.breakTracker.update(time, scoreCompleted);
    if (this.breakTracker.currentPeriod) {
      this.lastBreakPeriod = this.breakTracker.currentPeriod;
      this.breakOverlay.setCurrentPeriod(this.breakTracker.currentPeriod);
    }
    this.breakOverlay.update(time, this.breakTracker.currentPeriod, realElapsed * (this.paused ? 0 : 1));
    if (this.breakTracker.isBreakTime !== this.wasBreakTime) {
      this.wasBreakTime = this.breakTracker.isBreakTime;
      if (this.hud) this.hud.keyCounter.isCounting = !this.breakTracker.isBreakTime;
    }

    // Player.updatePauseOnFocusLostState (retried every frame until the pause cooldown allows it).
    if (this.focusLost && !this.paused && !this.breakTracker.isBreakTime && this.pausingSupportedByCurrentState) this.pause();

    // Skip overlays
    this.skipIntro?.update(time, now, realElapsed);
    this.skipOutro?.update(time, now, realElapsed);
    if (this.autoSkipQueued && now >= this.nextAutoSkipAt) {
      if (!this.skipIntro?.click()) this.autoSkipQueued = false;
      else this.nextAutoSkipAt = now + 200;
    }

    // ScoreProcessor.HasCompleted → checkScoreCompleted
    if (!this.paused && !this.completed && !this.failed && this.drawable.hasCompleted && time >= this.lastObjectTime) {
      this.completed = true;
      if (this.healthProcessor.checkFailAtEnd()) this.healthProcessor.triggerFailure();
      this.checkScoreCompleted(now);
    }
    // Storyboard outro: progress once the storyboard has ended.
    if (this.hasPassed && this.resultsAt == null && this.skipOutro && this.storyboard?.latestEventTime != null && time >= this.storyboard.latestEventTime) this.progressToResults(true);
    if (this.resultsAt != null && now >= this.resultsAt && !this.failed) this.showResults();

    // Resume overlays
    this.delayedResume?.update(now);

    // HUD
    if (this.hud) {
      this.hud.update(now, {
        // GameplayScoreCounter: ScoreProcessor.GetDisplayScore(OsuSetting.ScoreDisplayMode)
        totalScore: getDisplayScore(this.ruleset.id, this.scoreProcessor.totalScore, this.scoreProcessor.maximumStatistics),
        accuracy: this.scoreProcessor.accuracy,
        combo: this.scoreProcessor.combo,
        health: this.healthProcessor.health,
        time,
        clockStartTime: this.startTime,
        isPlaying: this.localUserPlaying,
        keyOverlay: settings.get('gameplay.showKeyCounter', false),
        fadePlayfieldWhenHealthLow: settings.get('gameplay.fadePlayfieldWhenHealthLow', true),
        showHitErrorMeter: settings.get('gameplay.hitErrorMeter', true),
      });
    }

    this.render(time, now);
  };

  /** PlayerLoader.pushWhenLoaded (checked every frame after PlayerPushDelay). */
  private loaderFrame(now: number): void {
    if (this.pushAt == null) {
      const ready = this.loaded && now >= this.loaderEnteredAt + this.loader.pushDelay && document.visibilityState === 'visible';
      if (ready) this.pushAt = now + (this.restart?.quick && this.loader.contentHidden ? 0 : 500);
    } else if (now >= this.pushAt) this.startGameplay(now);
  }

  private currentDim(): number {
    if (this.mods.has('CN')) return 0; // ModCinema: IgnoreUserSettings → DimWhenUserSettingsIgnored (0)
    const lighten = settings.get('gameplay.lightenDuringBreaks', true) && this.breakTracker.isBreakTime ? BREAK_LIGHTEN_AMOUNT : 0;
    return Math.max(settings.get('gameplay.backgroundDim', 0.7) - lighten, 0);
  }

  /** Draws the (cover-fitted) background onto its own layer; only when the image or canvas size changes. */
  private updateBackgroundLayer(img: HTMLImageElement | null): void {
    const c = this.bgCanvas;
    const key = img ? `${img.src}|${this.canvas.width}x${this.canvas.height}` : `none|${this.canvas.width}x${this.canvas.height}`;
    if (key === this.bgCanvasKey) return;
    this.bgCanvasKey = key;
    c.width = this.canvas.width;
    c.height = this.canvas.height;
    c.style.visibility = this.canvas.style.visibility;
    const bg = c.getContext('2d', { alpha: false })!;
    bg.fillStyle = '#000';
    bg.fillRect(0, 0, c.width, c.height);
    if (img) {
      const s = Math.max(c.width / img.width, c.height / img.height);
      const iw = img.width * s;
      const ih = img.height * s;
      bg.imageSmoothingQuality = 'high';
      bg.drawImage(img, (c.width - iw) / 2, (c.height - ih) / 2, iw, ih);
    }
  }

  private render(time: number, now: number): void {
    const g = this.g;
    const dpr = this.canvas.width / (this.canvas.clientWidth || 1);
    const w = this.canvas.width / dpr;
    const hgt = this.canvas.height / dpr;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);

    // UserDimContainer: FadeColour(Gray(1 - DimLevel), 800, OutQuint) whenever the dim level changes.
    const target = this.currentDim();
    if (target !== this.bgDimTarget) {
      this.bgDimTarget = target;
      this.bgDim.to(target, BACKGROUND_FADE_DURATION, Easing.OutQuint, now);
    }
    const dim = this.bgDim.valueAt(now);
    const sbState = { passing: this.healthProcessor.health >= 0.5 || this.healthProcessor.noFail, running: !this.paused && !this.failed, rate: this.mods.rate };

    // Background (BackgroundScreenBeatmap): dimmed here unless a storyboard is drawn (then a single dim is applied after it).
    const failBg = this.failAnimation.backgroundColour(now);
    const showBackground = this.background != null && !this.storyboard?.replacesBackground;
    this.updateBackgroundLayer(showBackground ? this.background : null);
    const layerDim = showBackground && !this.storyboard ? 1 - (1 - dim) * failBg : 0;
    if (Math.abs(layerDim - this.bgDimOpacity) > 0.001) {
      this.bgDimOpacity = layerDim;
      this.bgDimEl.style.opacity = String(layerDim);
    }
    // OsuSetting.BlurLevel × BackgroundScreenBeatmap.BACKGROUND_BLUR (20), on the cached background layer.
    const blur = Math.round(settings.get('gameplay.backgroundBlur', 0) * 20 * (window.innerHeight / 768) * 10) / 10;
    if (blur !== this.bgBlur) {
      this.bgBlur = blur;
      this.bgCanvas.style.filter = blur > 0 ? `blur(${blur}px)` : '';
    }

    // Player.OnEntering: ScaleTo(0.7) → 1 over 750 (OutQuint), Delay(250).FadeIn(250); GameplayClockContainer.FadeInFromZero(750, OutQuint).
    const sinceEnter = now - this.enteredAt;
    const enterScale = valueAt(sinceEnter, 0.7, 1, 750);
    const enterAlpha = Math.max(0, Math.min(1, (sinceEnter - 250) / 250)) * valueAt(sinceEnter, 0, 1, 750);
    const fail = this.failAnimation.contentTransform(now);

    g.save();
    g.globalAlpha = enterAlpha;
    g.translate(w / 2, hgt / 2);
    g.scale(enterScale * fail.scale, enterScale * fail.scale);
    if (this.failAnimation.started) {
      g.rotate((fail.rotation * Math.PI) / 180);
      g.beginPath();
      g.rect(-w / 2, -hgt / 2, w, hgt);
      g.clip();
    }
    g.translate(-w / 2, -hgt / 2);
    if (this.failAnimation.started) {
      // Content.Masking + a black box behind the content.
      g.fillStyle = '#000';
      g.fillRect(0, 0, w, hgt);
    }

    // --- underlay: storyboard (dimmed), letterbox, kiai fountains
    if (this.storyboard) {
      g.save();
      this.storyboard.drawUnder(g, w, hgt, time, sbState);
      g.restore();
      g.fillStyle = `rgba(0,0,0,${1 - (1 - dim) * failBg})`;
      g.fillRect(0, 0, w, hgt);
    }
    if (this.beatmap.letterboxInBreaks) drawLetterbox(g, w, hgt, time, this.lastBreakPeriod);
    this.fountains.update(now, time, this.playable.source.controlPoints.effectPointAt(time), settings.get('gameplay.starFountains', true));
    this.fountains.draw(g, w, hgt, now);

    // --- gameplay
    if (!this.mods.has('CN')) {
      if (this.failAnimation.started) {
        // HitObjectContainer.FadeOut(duration / 2): rulesets set globalAlpha themselves, so composite their output instead.
        const a = this.failAnimation.hitObjectAlpha(now);
        if (a > 0) {
          const off = (this.failCanvas ??= document.createElement('canvas'));
          if (off.width !== this.canvas.width || off.height !== this.canvas.height) {
            off.width = this.canvas.width;
            off.height = this.canvas.height;
          }
          const og = off.getContext('2d')!;
          og.setTransform(1, 0, 0, 1, 0, 0);
          og.clearRect(0, 0, off.width, off.height);
          og.setTransform(dpr, 0, 0, dpr, 0, 0);
          this.drawable.render(og, w, hgt, time);
          g.save();
          g.globalAlpha *= a;
          g.drawImage(off, 0, 0, w, hgt);
          g.restore();
        }
      } else {
        g.save();
        this.drawable.render(g, w, hgt, time);
        g.restore();
      }
    }

    // --- overlay components: storyboard overlay layer, HUD, break overlay, resume overlay
    if (this.storyboard) {
      g.save();
      this.storyboard.drawOver(g, w, hgt, time, { ...sbState, dim });
      g.restore();
    }
    if (this.hud) {
      this.hud.drawFailingLayer(g, w, hgt, now);
      this.hud.draw(g, w, hgt, now, this.dpr);
    }
    this.breakOverlay.draw(g, w, hgt, time, this.scoreProcessor.accuracy, this.scoreProcessor.rank, this.dpr);
    this.delayedResume?.draw(g, w, hgt, now);

    // Content.FadeColour(Gray, duration)
    if (this.failAnimation.started && fail.colour < 1) {
      g.fillStyle = `rgba(0,0,0,${1 - fail.colour})`;
      g.fillRect(0, 0, w, hgt);
    }
    g.restore();

    // redFlashLayer (outside the content, additive)
    const flash = settings.get('gameplay.fadePlayfieldWhenHealthLow', true) ? this.failAnimation.redFlash(now) : 0;
    if (flash > 0) {
      g.save();
      g.globalCompositeOperation = 'lighter';
      g.fillStyle = `rgba(255,0,0,${flash})`;
      g.fillRect(0, 0, w, hgt);
      g.restore();
    }
  }
}

/** OutQuint interpolation from `from` to `to` over `duration` ms. */
function valueAt(t: number, from: number, to: number, duration: number): number {
  if (t <= 0) return from;
  if (t >= duration) return to;
  const p = t / duration - 1;
  return from + (to - from) * (p * p * p * p * p + 1);
}
