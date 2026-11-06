// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// The top-level game (OsuGame equivalent): screen stack, background, global audio, overlays and import handling.

import { VolumeOverlay } from './overlays/VolumeOverlay';
import { MenuCursor } from './MenuCursor';
import { APP_NAME } from '../brand';
import { AudioEngine, Track } from '../framework/audio/AudioEngine';
import { settings } from '../framework/Settings';
import type { Beatmap } from '../game/beatmaps/Beatmap';
import { WorkingBeatmap } from '../game/beatmaps/WorkingBeatmap';
import { BeatmapLibrary } from '../game/BeatmapLibrary';
import { ModSet } from '../game/mods/Mods';
import { getRuleset } from '../game/rulesets';
import type { Ruleset } from '../game/rulesets/Ruleset';
import { Database, type BeatmapEntry, type BeatmapSetRecord } from '../game/storage/Database';
import { importFiles } from '../game/storage/Importer';
import { importSkin } from '../game/skinning';
import { decodeOsr, legacyFramesToReplay } from '../game/replays/LegacyReplay';
import { md5 } from '../game/replays/md5';
import { findFile } from '../game/storage/Importer';
import { h } from './dom';
import type { Screen } from './Screen';
import { Triangles } from './Triangles';

export class Game {
  readonly root: HTMLElement;
  readonly library = new BeatmapLibrary();
  audio: AudioEngine | null = null;

  private readonly bgA: HTMLDivElement;
  private readonly bgB: HTMLDivElement;
  private readonly bgParallax: HTMLDivElement;
  readonly volume: VolumeOverlay;
  private readonly menuCursor: MenuCursor;
  private muted = false;
  private parallax = { x: 0, y: 0, scale: 1, mouse: null as { x: number; y: number } | null };
  private bgFront: 'A' | 'B' = 'A';
  private readonly bgDim: HTMLDivElement;
  private readonly triangles: Triangles;
  private readonly screenLayer: HTMLDivElement;
  readonly overlayLayer: HTMLDivElement;
  private readonly toastLayer: HTMLDivElement;
  private readonly fileInput: HTMLInputElement;
  private readonly folderInput: HTMLInputElement;
  private readonly fpsEl: HTMLDivElement;

  private stack: Screen[] = [];
  private overlays: { el: HTMLElement; onKey?: (e: KeyboardEvent) => boolean; onClose?: () => void; capture?: boolean }[] = [];

  // Selection state (Bindable<WorkingBeatmap> / Bindable<RulesetInfo> / Bindable<Mods> in lazer)
  working: WorkingBeatmap | null = null;
  ruleset: Ruleset;
  mods = new ModSet();
  private listeners = new Set<() => void>();

  // Menu / preview music
  previewTrack: Track | null = null;
  private previewBeatmap: Beatmap | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    this.ruleset = getRuleset(settings.get('ui.ruleset', 0));

    this.bgA = h('div', { class: 'bg-image' });
    this.bgB = h('div', { class: 'bg-image', style: { opacity: '0' } });
    this.bgDim = h('div', { class: 'bg-dim', style: { opacity: '0.6' } });
    this.triangles = new Triangles();
    this.screenLayer = h('div', { class: 'layer' });
    this.overlayLayer = h('div', { class: 'layer', style: { pointerEvents: 'none' } });
    this.toastLayer = h('div', { class: 'toasts' });
    this.fpsEl = h('div', { class: 'fps' });
    this.fileInput = h('input', { type: 'file', accept: '.osz,.osu,.osk,.osr,.zip', multiple: true, style: { display: 'none' } });
    this.folderInput = h('input', { type: 'file', multiple: true, style: { display: 'none' } });
    this.folderInput.setAttribute('webkitdirectory', '');

    root.append(
      h('div', { class: 'layer' }, (this.bgParallax = h('div', { class: 'bg-parallax' }, this.bgA, this.bgB)), this.bgDim),
      this.triangles.canvas,
      this.screenLayer,
      this.overlayLayer,
      this.toastLayer,
      this.fpsEl,
      h('div', { class: 'drop-hint' }, 'Drop .osz files or beatmap folders to import'),
      this.fileInput,
      this.folderInput,
    );

    this.fileInput.addEventListener('change', () => {
      if (this.fileInput.files) void this.importFiles([...this.fileInput.files]);
      this.fileInput.value = '';
    });
    this.folderInput.addEventListener('change', () => {
      if (this.folderInput.files) void this.importFiles([...this.folderInput.files]);
      this.folderInput.value = '';
    });

    window.addEventListener('keydown', e => this.handleKeyDown(e));
    window.addEventListener('keyup', e => this.stack[this.stack.length - 1]?.onKeyUp(e));
    this.setupDragDrop();
    this.setupFps();

    settings.subscribe(key => {
      if (key.startsWith('audio.')) this.applyVolumes();
    });
    window.addEventListener('blur', () => this.applyVolumes());
    window.addEventListener('focus', () => this.applyVolumes());
    document.addEventListener('visibilitychange', () => this.applyVolumes());
    this.library.subscribe(() => this.scheduleStarBackfill());
    this.volume = new VolumeOverlay(this);
    root.appendChild(this.volume.el);
    this.menuCursor = new MenuCursor(this);
    root.appendChild(this.menuCursor.el);
    window.addEventListener('wheel', this.onWheel, { passive: false });
  }

  // ------------------------------------------------------------------ audio

  /** Creates the audio engine (must be called from a user gesture). */
  async ensureAudio(): Promise<AudioEngine> {
    if (!this.audio) {
      this.audio = new AudioEngine();
      this.applyVolumes();
      void this.audio.loadDefaultSamples();
    }
    await this.audio.resume();
    return this.audio;
  }

  private applyVolumes(): void {
    // OsuSetting.VolumeInactive scales the master volume while the window doesn't have focus.
    const inactive = typeof document !== 'undefined' && (document.hidden || !document.hasFocus());
    const master = this.muted ? 0 : settings.get('audio.master', 1) * (inactive ? settings.get('audio.masterInactive', 0.25) : 1);
    this.audio?.setVolumes(master, settings.get('audio.music', 1), settings.get('audio.effects', 1));
  }

  playUiSample(name: string, volume = 1, rate = 1): void {
    const b = this.audio?.getDefaultSample(name);
    if (b) this.audio!.play(b, { volume, rate });
  }

  /**
   * ScreenshotManager.TakeScreenshotAsync: captures the screen's canvases (gameplay is fully canvas-drawn) and saves it
   * as OsuSetting.ScreenshotFormat.
   */
  async takeScreenshot(): Promise<void> {
    const layers = this.currentScreen?.screenshotLayers?.() ?? [];
    if (layers.length === 0) {
      this.toast('Screenshots can only be taken during gameplay in the browser version.', 'error');
      return;
    }
    const w = layers[0].width;
    const hgt = layers[0].height;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = hgt;
    const g = c.getContext('2d')!;
    g.fillStyle = '#000';
    g.fillRect(0, 0, w, hgt);
    for (const l of layers) g.drawImage(l, 0, 0, w, hgt);
    const png = settings.get<string>('graphics.screenshotFormat', 'jpg') === 'png';
    const blob = await new Promise<Blob | null>(r => c.toBlob(r, png ? 'image/png' : 'image/jpeg', 0.92));
    if (!blob) return;
    const d = new Date();
    const p2 = (n: number) => String(n).padStart(2, '0');
    const name = `${APP_NAME.toLowerCase()}_${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}_${p2(d.getHours())}-${p2(d.getMinutes())}-${p2(d.getSeconds())}.${png ? 'png' : 'jpg'}`;
    try {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      this.playUiSample('menu-confirm', 0.4);
      this.toast(`Screenshot ${name} saved!`, 'success');
    } catch {
      this.toast('Downloads are blocked here.', 'error');
    }
  }

  /** MasterVolumeMeter mute: a zero volume adjustment on the audio manager. */
  applyMute(muted: boolean): void {
    this.muted = muted;
    this.applyVolumes();
  }

  /**
   * ScrollAdjustsVolume: Alt+wheel anywhere (OsuGame), plain wheel on screens that have one (main menu, song select,
   * player loader, gameplay unless MouseDisableWheel) when nothing scrollable is under the pointer.
   */
  private readonly onWheel = (e: WheelEvent): void => {
    if (e.deltaY === 0 || e.ctrlKey) return;
    const target = e.target as HTMLElement | null;
    let allowed = false;
    if (e.altKey && !e.shiftKey && !e.metaKey) allowed = true;
    else if (!e.altKey && !e.shiftKey && !e.metaKey && !this.hasOverlay && this.currentScreen?.scrollAdjustsVolume) {
      allowed = true;
      for (let el = target; el && el !== document.body; el = el.parentElement) {
        if (el.closest('.volume-overlay')) return;
        const st = getComputedStyle(el);
        if ((st.overflowY === 'auto' || st.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 1) {
          allowed = false;
          break;
        }
        if (el.dataset.blockScrollVolume != null) {
          allowed = false;
          break;
        }
      }
    }
    if (!allowed) {
      if (this.currentScreen?.blocksWheel && !e.altKey) e.preventDefault();
      return;
    }
    e.preventDefault();
    const precise = e.deltaMode === 0 && Math.abs(e.deltaY) < 50;
    const amount = precise ? Math.abs(e.deltaY) / 50 : 1;
    this.volume.adjust(e.deltaY < 0 ? 'increase' : 'decrease', amount, precise);
  };

  // ------------------------------------------------------------------ selection

  subscribe(l: () => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  setRuleset(r: Ruleset): void {
    if (r === this.ruleset) return;
    this.ruleset = r;
    settings.set('ui.ruleset', r.id);
    this.mods = this.mods.forRuleset(r.shortName, r.availableMods);
    this.emit();
  }

  setMods(m: ModSet): void {
    this.mods = m;
    this.emit();
  }

  /** Selects a beatmap, updating the background and preview music. */
  select(set: BeatmapSetRecord, entry: BeatmapEntry, playPreview = true): void {
    if (this.working && this.working.set.id === set.id && this.working.entry.hash === entry.hash) return;
    const previousSet = this.working?.set.id;
    const previousAudio = this.working?.entry.audioFile;
    const old = this.working;
    this.working = new WorkingBeatmap(set, entry);
    this.setBackground(this.working.getBackgroundUrl());
    if (playPreview && (previousSet !== set.id || previousAudio !== entry.audioFile)) void this.startPreview();
    // Keep the old working beatmap's object URLs alive while the track may still be playing from it.
    if (old && old.set.id !== set.id) setTimeout(() => old.dispose(), 2000);
    this.emit();
  }

  async startPreview(fromStart = false): Promise<void> {
    const working = this.working;
    if (!working || !this.audio) return;
    this.stopPreview();
    const track = working.createTrack(this.audio);
    if (!track) return;
    this.previewTrack = track;
    await track.ready;
    if (this.previewTrack !== track) return;
    const preview = working.entry.previewTime;
    track.currentTime = fromStart ? 0 : preview > 0 ? preview : track.length * 0.4;
    track.loop = true;
    track.volume = 0;
    await track.start();
    // Fade in.
    const startAt = performance.now();
    const fade = () => {
      if (this.previewTrack !== track) return;
      const t = Math.min(1, (performance.now() - startAt) / 800);
      track.volume = t;
      if (t < 1) requestAnimationFrame(fade);
    };
    fade();
    working
      .getBeatmap()
      .then(b => {
        if (this.working === working) this.previewBeatmap = b;
      })
      .catch(() => undefined);
  }

  stopPreview(): void {
    if (this.previewTrack) {
      this.previewTrack.dispose();
      this.previewTrack = null;
    }
  }

  /** Beat phase (0..1) of the preview track, for menu animations. Returns null if unknown. */
  beatPhase(): { phase: number; beatLength: number; kiai: boolean } | null {
    const track = this.previewTrack;
    const b = this.previewBeatmap;
    if (!track || !b || !track.isRunning) return null;
    const t = track.currentTime;
    const tp = b.controlPoints.timingPointAt(t);
    const phase = (((t - tp.time) % tp.beatLength) + tp.beatLength) % tp.beatLength;
    return { phase: phase / tp.beatLength, beatLength: tp.beatLength, kiai: b.controlPoints.effectPointAt(t).kiaiMode };
  }

  // ------------------------------------------------------------------ background

  /** OsuScreenStack's ParallaxContainer around the background stack (DEFAULT_PARALLAX_AMOUNT × screen amount × MenuParallaxScale). */
  private updateParallax(elapsed: number): void {
    const p = this.parallax;
    const amount = 0.02 * (this.currentScreen?.backgroundParallaxAmount ?? 1) * settings.get('ui.parallax', 1);
    if (amount === 0 && p.x === 0 && p.y === 0 && p.scale === 1) return;
    const w = window.innerWidth;
    const hgt = window.innerHeight;
    let ox = 0;
    let oy = 0;
    if (p.mouse) {
      const damp = (v: number) => 1 - Math.pow(0.999, v);
      const rx = p.mouse.x - w / 2;
      const ry = p.mouse.y - hgt / 2;
      ox = Math.sign(rx) * damp(Math.abs(rx)) * (w / 2) * amount;
      oy = Math.sign(ry) * damp(Math.abs(ry)) * (hgt / 2) * amount;
    }
    const outQuint = (t: number) => 1 - Math.pow(1 - t, 5);
    const tPos = outQuint(Math.min(1, elapsed / 100));
    const tScale = outQuint(Math.min(1, elapsed / 1000));
    p.x = Math.abs(p.x - ox) < 1e-3 ? ox : p.x + (ox - p.x) * tPos;
    p.y = Math.abs(p.y - oy) < 1e-3 ? oy : p.y + (oy - p.y) * tPos;
    const target = 1 + Math.abs(amount);
    p.scale = Math.abs(p.scale - target) < 1e-4 ? target : p.scale + (target - p.scale) * tScale;
    this.bgParallax.style.transform = `translate(${p.x.toFixed(2)}px, ${p.y.toFixed(2)}px) scale(${p.scale.toFixed(4)})`;
  }

  setBackground(url: string | null): void {
    const next = this.bgFront === 'A' ? this.bgB : this.bgA;
    const prev = this.bgFront === 'A' ? this.bgA : this.bgB;
    next.style.backgroundImage = url ? `url("${url}")` : 'none';
    next.style.opacity = url ? '1' : '0';
    prev.style.opacity = '0';
    this.bgFront = this.bgFront === 'A' ? 'B' : 'A';
  }

  setBackgroundDim(dim: number, blur = 0): void {
    this.bgDim.style.opacity = String(dim);
    this.root.style.setProperty('--bg-blur', `${blur}px`);
  }

  // ------------------------------------------------------------------ screens

  get currentScreen(): Screen | undefined {
    return this.stack[this.stack.length - 1];
  }

  push(screen: Screen): void {
    const prev = this.currentScreen;
    if (prev) {
      prev.onSuspend();
      this.hideScreen(prev);
    }
    this.stack.push(screen);
    this.showScreen(screen);
    screen.onEnter();
  }

  /** Replaces the current screen. */
  replace(screen: Screen): void {
    const prev = this.stack.pop();
    if (prev) {
      prev.onExit();
      this.removeScreen(prev);
    }
    this.stack.push(screen);
    this.showScreen(screen);
    screen.onEnter();
  }

  pop(): void {
    if (this.stack.length <= 1) return;
    const prev = this.stack.pop()!;
    prev.onExit();
    this.removeScreen(prev);
    const cur = this.currentScreen!;
    this.showScreen(cur);
    cur.onResume();
  }

  /** Pops screens until the given predicate matches. */
  popTo(match: (s: Screen) => boolean): void {
    while (this.stack.length > 1 && !match(this.currentScreen!)) this.pop();
  }

  private showScreen(s: Screen): void {
    s.el.classList.remove('leaving');
    if (!s.el.isConnected) this.screenLayer.appendChild(s.el);
    s.el.style.display = '';
    this.setBackgroundDim(s.backgroundDim, s.backgroundBlur);
    this.triangles.running = s.showTriangles;
    this.triangles.canvas.style.display = s.showTriangles ? '' : 'none';
  }

  private hideScreen(s: Screen): void {
    s.el.style.display = 'none';
  }

  private removeScreen(s: Screen): void {
    s.el.classList.add('leaving');
    setTimeout(() => s.el.remove(), 250);
  }

  back(): void {
    if (this.overlays.length > 0) {
      this.closeOverlay();
      return;
    }
    const cur = this.currentScreen;
    if (cur && cur.onBack() && this.stack.length > 1) {
      this.playUiSample('menu-back', 0.6);
      this.pop();
    }
  }

  // ------------------------------------------------------------------ overlays

  openOverlay(el: HTMLElement, opts: { onKey?: (e: KeyboardEvent) => boolean; onClose?: () => void; capture?: boolean } = {}): void {
    el.style.pointerEvents = 'auto';
    this.overlayLayer.appendChild(el);
    this.overlays.push({ el, ...opts });
  }

  closeOverlay(el?: HTMLElement): void {
    const idx = el ? this.overlays.findIndex(o => o.el === el) : this.overlays.length - 1;
    if (idx < 0) return;
    const [o] = this.overlays.splice(idx, 1);
    o.el.remove();
    o.onClose?.();
  }

  get hasOverlay(): boolean {
    return this.overlays.length > 0;
  }

  toast(message: string, kind: 'info' | 'error' | 'success' = 'info', duration = 3500): void {
    const el = h('div', { class: `toast ${kind}` }, message);
    this.toastLayer.appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity 0.3s';
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 300);
    }, duration);
  }

  private handleKeyDown(e: KeyboardEvent): void {
    const target = e.target as HTMLElement | null;
    const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') && (target as HTMLInputElement).type !== 'range' && (target as HTMLInputElement).type !== 'checkbox';
    // GlobalActionContainer: Alt+Up / Alt+Down (volume), Alt+Left / Alt+Right (volume meter), Ctrl+F4 (mute).
    if (e.altKey && !e.ctrlKey && !e.metaKey && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
      const action = e.code === 'ArrowUp' ? 'increase' : e.code === 'ArrowDown' ? 'decrease' : e.code === 'ArrowRight' ? 'next' : 'previous';
      if (this.volume.adjust(action)) {
        e.preventDefault();
        return;
      }
    }
    // GlobalAction.TakeScreenshot (F12)
    if (e.code === 'F12' && !e.repeat) {
      e.preventDefault();
      void this.takeScreenshot();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.code === 'F4' && !e.repeat) {
      e.preventDefault();
      this.volume.toggleMute();
      return;
    }
    const top = this.overlays[this.overlays.length - 1];
    if (top?.onKey && top.onKey(e)) {
      e.preventDefault();
      return;
    }
    // Modal overlays (settings) keep keys away from the screen underneath, without blocking typing in their inputs.
    if (top?.capture) return;
    if (e.code === 'Escape') {
      e.preventDefault();
      if (typing) (target as HTMLInputElement).blur();
      this.back();
      return;
    }
    // Navigation, function keys (F1 mods, F2 random…) and the Ctrl+O / Ctrl+G shortcuts still work while the search box has focus.
    if (typing && e.code !== 'Enter' && e.code !== 'ArrowUp' && e.code !== 'ArrowDown' && !/^F\d+$/.test(e.code) && !((e.ctrlKey || e.metaKey) && /^Key[GO]$/.test(e.code))) return;
    if (this.currentScreen?.onKeyDown(e)) e.preventDefault();
  }

  // ------------------------------------------------------------------ import

  openFilePicker(): void {
    this.fileInput.click();
  }

  openFolderPicker(): void {
    this.folderInput.click();
  }

  private backfillScheduled = false;

  /** Computes missing nomod star ratings in the background (e.g. the generated demo set, or sets imported before ratings existed). */
  private scheduleStarBackfill(): void {
    if (this.backfillScheduled) return;
    this.backfillScheduled = true;
    const idle = (cb: () => void) => ((window as Window & { requestIdleCallback?: (cb: () => void) => void }).requestIdleCallback ?? ((f: () => void) => setTimeout(f, 50)))(cb);
    const step = async () => {
      for (const set of this.library.sets) {
        const entry = set.beatmaps.find(b => b.stars === undefined);
        if (!entry) continue;
        try {
          const blob = (await import('../game/storage/Importer')).findFile(set.files, entry.filename);
          const { LegacyBeatmapDecoder } = await import('../game/beatmaps/LegacyBeatmapDecoder');
          entry.stars = blob ? this.starRater(LegacyBeatmapDecoder.decode(await blob.text())) : 0;
        } catch {
          entry.stars = 0;
        }
        if (set.beatmaps.every(b => b.stars !== undefined) && !set.builtIn) void Database.putSet(set).catch(() => undefined);
        idle(() => void step());
        return;
      }
      this.backfillScheduled = false;
      this.emit();
    };
    idle(() => void step());
  }

  /** Star rating for a native (nomod) beatmap, used when importing. */
  starRater = (beatmap: Beatmap): number => {
    const r = getRuleset(beatmap.rulesetId);
    if (!r.starRating) return 0;
    return r.starRating(r.createPlayable(beatmap, new ModSet()));
  };

  async importFiles(files: File[]): Promise<void> {
    const skins = files.filter(f => f.name.toLowerCase().endsWith('.osk'));
    const replays = files.filter(f => f.name.toLowerCase().endsWith('.osr'));
    files = files.filter(f => !f.name.toLowerCase().endsWith('.osk') && !f.name.toLowerCase().endsWith('.osr'));
    for (const r of replays) await this.openReplayFile(r);
    // A loose folder with a skin.ini and no beatmaps is a skin, not a beatmap set.
    const isLooseSkin = files.length > 0 && files.some(f => f.name.toLowerCase() === 'skin.ini') && !files.some(f => /\.(osu|osz)$/i.test(f.name));
    if (isLooseSkin) {
      try {
        const name = await importSkin(files);
        this.toast(`Imported skin "${name}"`, 'success');
      } catch (e) {
        this.toast(`Skin import failed: ${e instanceof Error ? e.message : String(e)}`, 'error', 6000);
      }
      return;
    }
    for (const skin of skins) {
      try {
        const name = await importSkin([skin]);
        this.toast(`Imported skin "${name}"`, 'success');
      } catch (e) {
        this.toast(`${skin.name}: ${e instanceof Error ? e.message : String(e)}`, 'error', 6000);
      }
    }
    if (files.length === 0) return;
    this.toast(`Importing ${files.length > 1 ? `${files.length} files` : files[0].name}…`);
    try {
      const result = await importFiles(files, this.starRater);
      if (result.imported.length > 0) {
        this.library.add(result.imported);
        const count = result.imported.reduce((a, s) => a + s.beatmaps.length, 0);
        this.toast(`Imported ${result.imported.length} beatmap set${result.imported.length > 1 ? 's' : ''} (${count} difficulties)`, 'success');
        const first = result.imported[0];
        this.select(first, first.beatmaps[0]);
      }
      for (const err of result.errors.slice(0, 3)) this.toast(err, 'error', 6000);
      if (result.imported.length === 0 && result.errors.length === 0) this.toast('No beatmaps found in the selected files', 'error');
    } catch (e) {
      this.toast(`Import failed: ${e instanceof Error ? e.message : String(e)}`, 'error', 6000);
    }
  }

  /** Finds a beatmap by the MD5 of its .osu file (computing and caching hashes for older imports). */
  async findBeatmapByMD5(hash: string): Promise<{ set: BeatmapSetRecord; entry: BeatmapEntry } | null> {
    await this.library.load();
    for (const set of this.library.sets) for (const entry of set.beatmaps) if (entry.md5 === hash) return { set, entry };
    for (const set of this.library.sets) {
      for (const entry of set.beatmaps) {
        if (entry.md5) continue;
        const blob = findFile(set.files, entry.filename);
        if (!blob) continue;
        entry.md5 = md5(new Uint8Array(await blob.arrayBuffer()));
        if (entry.md5 === hash) return { set, entry };
      }
    }
    return null;
  }

  /** Opens an osu!stable / lazer .osr replay (LegacyScoreDecoder) and starts playback. */
  async openReplayFile(file: File): Promise<void> {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const decoded = decodeOsr(bytes);
      const found = await this.findBeatmapByMD5(decoded.beatmapMD5);
      if (!found) throw new Error("the replay's beatmap isn't imported yet. Import the beatmap first.");
      const replay = legacyFramesToReplay(decoded);
      const { getRuleset } = await import('../game/rulesets');
      const ruleset = getRuleset(decoded.rulesetId);
      const { ModSet } = await import('../game/mods/Mods');
      const mods = new ModSet(decoded.mods).forRuleset(ruleset.shortName, ruleset.availableMods);
      await this.ensureAudio();
      this.select(found.set, found.entry, false);
      const { PlayerScreen } = await import('./screens/Player');
      this.toast(`Watching ${decoded.playerName}'s replay`);
      this.push(new PlayerScreen(this, this.working!, ruleset, mods, replay));
    } catch (e) {
      this.toast(`${file.name}: ${e instanceof Error ? e.message : String(e)}`, 'error', 6000);
    }
  }

  private setupDragDrop(): void {
    let depth = 0;
    window.addEventListener('dragenter', e => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      depth++;
      this.root.classList.add('dragging');
    });
    window.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) this.root.classList.remove('dragging');
    });
    window.addEventListener('dragover', e => e.preventDefault());
    window.addEventListener('drop', async e => {
      e.preventDefault();
      depth = 0;
      this.root.classList.remove('dragging');
      const items = e.dataTransfer?.items;
      if (!items) return;
      const files = await collectDroppedFiles(items);
      void this.importFiles(files);
    });
  }

  private setupFps(): void {
    let frames = 0;
    let last = performance.now();
    window.addEventListener('pointermove', e => (this.parallax.mouse = { x: e.clientX, y: e.clientY }), { passive: true });
    let lastFrame = performance.now();
    const loop = () => {
      frames++;
      const now = performance.now();
      this.updateParallax(Math.min(100, Math.max(0, now - lastFrame)));
      lastFrame = now;
      if (now - last >= 500) {
        if (settings.get('graphics.showFps', false)) this.fpsEl.textContent = `${Math.round((frames * 1000) / (now - last))} fps`;
        else this.fpsEl.textContent = '';
        frames = 0;
        last = now;
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
}

/** Reads dropped files, recursing into dropped directories (so a whole Songs folder can be dropped). */
async function collectDroppedFiles(items: DataTransferItemList): Promise<File[]> {
  const out: File[] = [];
  const entries: FileSystemEntry[] = [];
  for (const item of [...items]) {
    const entry = item.webkitGetAsEntry?.();
    if (entry) entries.push(entry);
    else {
      const f = item.getAsFile();
      if (f) out.push(f);
    }
  }
  const walk = async (entry: FileSystemEntry, path: string): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
      Object.defineProperty(file, 'relativePath', { value: path + file.name });
      out.push(file);
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      let batch: FileSystemEntry[];
      do {
        batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        for (const e of batch) await walk(e, `${path}${entry.name}/`);
      } while (batch.length > 0);
    }
  };
  for (const e of entries) await walk(e, '');
  return out;
}
