// Port of osu.Game/Screens/Edit/Editor.cs: the top bar (EditorMenuBar with File / Edit / View / Timing menus and the
// EditorScreenSwitcherControl), the screen container (Compose, Design, Timing, Setup, Verify), the BottomBar
// (TimeInfoContainer, SummaryTimeline, PlaybackControl, TestGameplayButton), global editor keys (GlobalAction.Editor*),
// the clipboard (Cut / Copy / Paste / Clone), saving, exporting, difficulty creation / switching / deletion, and
// PromptForSaveDialog on exit.

import './editor.css';
import { settings } from '../../framework/Settings';
import { HIT_NORMAL, HitSampleInfo } from '../../game/audio/HitSampleInfo';
import { Beatmap, ConvertHitObject } from '../../game/beatmaps/Beatmap';
import { LegacyBeatmapDecoder } from '../../game/beatmaps/LegacyBeatmapDecoder';
import { LegacyBeatmapEncoder } from '../../game/beatmaps/LegacyBeatmapEncoder';
import { WorkingBeatmap } from '../../game/beatmaps/WorkingBeatmap';
import { SliderPath } from '../../game/objects/SliderPath';
import { Profiles } from '../../game/Profiles';
import { availableRulesets, getRuleset } from '../../game/rulesets';
import type { BeatmapEntry, BeatmapSetRecord } from '../../game/storage/Database';
import { popupDialog } from '../confirm';
import { h } from '../dom';
import type { Game } from '../Game';
import { Screen } from '../Screen';
import type { Composer, ComposerHost, ViewOptions } from './Composer';
import { EditorBeatmap } from './EditorBeatmap';
import { EditorClock } from './EditorClock';
import { createComposer } from './composers';
import { SetupScreen } from './SetupScreen';
import { saveBeatmap, exportSet } from './EditorStorage';
import { SummaryTimeline } from './SummaryTimeline';
import { computeWaveform, Timeline } from './Timeline';
import { TimingScreen } from './TimingScreen';
import { VerifyScreen } from './VerifyScreen';
import { editorMenuBar, type EditorMenu } from './MenuBar';

export type EditorScreenMode = 'setup' | 'compose' | 'design' | 'timing' | 'verify';

const MODE_NAMES: [EditorScreenMode, string][] = [
  ['setup', 'Setup'],
  ['compose', 'Compose'],
  ['design', 'Design'],
  ['timing', 'Timing'],
  ['verify', 'Verify'],
];

export interface EditorTarget {
  set: BeatmapSetRecord;
  /** The difficulty to edit; null creates a new difficulty in the set (or a new beatmap when the set is new). */
  entry: BeatmapEntry | null;
  /** For a brand new beatmap. */
  isNew?: boolean;
  /** Ruleset for a new difficulty. */
  rulesetId?: number;
  /** Beatmap text to start from (a copy of another difficulty). */
  template?: Beatmap | null;
}

interface ClipboardContent {
  objects: string;
}

let clipboard: ClipboardContent | null = null;

export class EditorScreen extends Screen implements ComposerHost {
  editor: EditorBeatmap;
  readonly clock: EditorClock;
  set: BeatmapSetRecord;
  /** The .osu file this difficulty is saved to (null until first saved). */
  filename: string | null;
  private mode: EditorScreenMode;
  private readonly screenContainer: HTMLElement;
  private readonly switcher: HTMLElement;
  private composer: Composer | null = null;
  private timeline: Timeline | null = null;
  private readonly summary: SummaryTimeline;
  private readonly timeText: HTMLElement;
  private readonly bpmText: HTMLElement;
  private readonly playButton: HTMLElement;
  private readonly rateButtons: HTMLElement[] = [];
  private modeView: { el: HTMLElement; update?: () => void; dispose?: () => void; onKeyDown?: (e: KeyboardEvent) => boolean } | null = null;
  private raf = 0;
  private disposed = false;
  private resizeObserver: ResizeObserver | null = null;
  private waveformPeaks: Float32Array | null = null;
  private waveformDuration = 0;
  readonly view: ViewOptions & { waveformOpacity: number; showTicks: boolean; showTimingChanges: boolean; backgroundDim: number };
  private menu: { el: HTMLElement; update: () => void };

  constructor(game: Game, target: EditorTarget) {
    super(game, 'editor-screen');
    this.backgroundDim = settings.get<number>('editor.backgroundDim', 0.25);
    this.showTriangles = false;
    this.set = target.set;
    this.filename = target.entry?.filename ?? null;
    this.view = {
      autoSeekOnPlacement: settings.get('editor.autoSeekOnPlacement', true),
      showHitMarkers: settings.get('editor.showHitMarkers', true),
      waveformOpacity: settings.get('editor.waveformOpacity', 0.25),
      showTicks: settings.get('editor.timelineShowTicks', true),
      showTimingChanges: settings.get('editor.timelineShowTimingChanges', true),
      backgroundDim: this.backgroundDim,
    };

    const beatmap = target.template ?? new Beatmap();
    if (!target.template && !target.entry) {
      // A new beatmap: blank metadata with the local player as the creator.
      beatmap.rulesetId = target.rulesetId ?? game.ruleset.id;
      beatmap.metadata.creator = Profiles.current().username;
      beatmap.difficultyName = 'New difficulty';
      const audio = Object.keys(target.set.files).find(f => /\.(mp3|ogg|wav|flac|m4a)$/i.test(f));
      if (audio) beatmap.metadata.audioFile = audio;
    }
    this.editor = new EditorBeatmap(beatmap);
    this.clock = new EditorClock(this.editor);
    this.mode = target.isNew || !target.entry ? 'setup' : 'compose';

    // ---------------------------------------------------------------- top bar
    this.menu = editorMenuBar(() => this.menus());
    this.switcher = h('div', { class: 'ed-switcher' });
    for (const [m, label] of MODE_NAMES)
      this.switcher.appendChild(
        h('button', { class: 'ed-switch', 'data-mode': m, onclick: () => this.setMode(m) }, label),
      );
    const topBar = h('div', { class: 'ed-topbar' }, this.menu.el, this.switcher);

    // ---------------------------------------------------------------- bottom bar
    this.timeText = h('div', { class: 'ed-time' }, '00:00:000');
    this.bpmText = h('div', { class: 'ed-bpm' }, '');
    this.summary = new SummaryTimeline(this.editor, this.clock);
    this.playButton = h('button', { class: 'ed-play', title: 'Play / pause (Space)', onclick: () => this.clock.togglePause() });
    for (const r of [0.25, 0.5, 0.75, 1]) {
      const b = h('button', { class: 'ed-rate', onclick: () => this.setRate(r) }, `${r * 100}%`);
      b.dataset.rate = String(r);
      this.rateButtons.push(b);
    }
    const bottomBar = h(
      'div',
      { class: 'ed-bottombar' },
      h('div', { class: 'ed-timeinfo' }, this.timeText, this.bpmText),
      this.summary.el,
      h('div', { class: 'ed-playback' }, this.playButton, h('div', { class: 'ed-rates' }, ...this.rateButtons)),
      h('button', { class: 'ed-test', title: 'Test gameplay (F5)', onclick: () => void this.testGameplay() }, 'Test!'),
    );
    this.screenContainer = h('div', { class: 'ed-screen-container' });
    this.el.append(h('div', { class: 'ed-root' }, this.screenContainer, topBar, bottomBar));

    this.editor.subscribe(kind => {
      if (kind === 'beatmap' || kind === 'objects') this.menu.update();
      this.composer?.refresh();
      this.modeView?.update?.();
    });
    this.clock.subscribe(() => this.updatePlayButton());
    this.setRate(1);
  }

  get trackLoops(): boolean {
    return false;
  }

  get allowTrackControl(): boolean {
    return false;
  }

  get scrollAdjustsVolume(): boolean {
    return false;
  }

  get blocksWheel(): boolean {
    return true;
  }

  // ---------------------------------------------------------------- lifecycle

  onEnter(): void {
    this.game.stopPreview();
    this.loadTrack();
    this.setMode(this.mode);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.el);
    this.el.addEventListener('wheel', this.onWheel, { passive: false });
    this.applyBackground();
    const loop = () => {
      if (this.disposed) return;
      this.frame();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  onSuspend(): void {
    this.clock.stop();
  }

  onResume(): void {
    this.applyBackground();
    this.game.stopPreview();
    this.resize();
  }

  onExit(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.resizeObserver?.disconnect();
    this.composer?.dispose();
    this.modeView?.dispose?.();
    this.clock.dispose();
    void this.game.startPreview();
  }

  private applyBackground(): void {
    const working = this.workingFor();
    this.game.setBackground(working?.getBackgroundUrl() ?? null);
    this.game.setBackgroundDim(this.view.backgroundDim);
  }

  private workingFor(): WorkingBeatmap | null {
    const entry = this.currentEntryStub();
    return entry ? new WorkingBeatmap(this.set, entry) : null;
  }

  /** A minimal entry describing the current state (for the track / background). */
  private currentEntryStub(): BeatmapEntry {
    const b = this.editor.beatmap;
    return {
      hash: '',
      filename: this.filename ?? '',
      rulesetId: b.rulesetId,
      difficultyName: b.difficultyName,
      title: b.metadata.title,
      titleUnicode: b.metadata.titleUnicode,
      artist: b.metadata.artist,
      artistUnicode: b.metadata.artistUnicode,
      creator: b.metadata.creator,
      source: b.metadata.source,
      tags: b.metadata.tags,
      audioFile: b.metadata.audioFile,
      backgroundFile: b.metadata.backgroundFile,
      previewTime: b.metadata.previewTime,
      bpm: 0,
      length: 0,
      objectCount: b.hitObjects.length,
      circleSize: b.difficulty.circleSize,
      approachRate: b.difficulty.approachRate,
      overallDifficulty: b.difficulty.overallDifficulty,
      drainRate: b.difficulty.drainRate,
      onlineId: -1,
    };
  }

  /** Reloads the track (after the audio file changes in Setup). */
  loadTrack(): void {
    const working = this.workingFor();
    const audio = this.game.audio;
    const time = this.clock.currentTime;
    if (!working || !audio || !this.editor.beatmap.metadata.audioFile) {
      void this.clock.attach(null);
      return;
    }
    const track = working.createTrack(audio);
    void this.clock.attach(track).then(() => this.clock.seek(time));
    // Waveform
    const blob = working.audioBlob;
    if (blob)
      void blob
        .arrayBuffer()
        .then(data => audio.decode(data))
        .then(buffer => {
          if (!buffer) return;
          this.waveformPeaks = computeWaveform(buffer);
          this.waveformDuration = buffer.duration * 1000;
          this.timeline?.setWaveform(this.waveformPeaks, this.waveformDuration);
        })
        .catch(() => {});
  }

  applyBackgroundFromSetup(): void {
    this.applyBackground();
  }

  // ---------------------------------------------------------------- modes

  setMode(mode: EditorScreenMode): void {
    this.mode = mode;
    for (const b of this.switcher.children) b.classList.toggle('active', (b as HTMLElement).dataset.mode === mode);
    this.composer?.dispose();
    this.composer = null;
    this.modeView?.dispose?.();
    this.modeView = null;
    this.timeline = null;
    this.screenContainer.replaceChildren();

    const withTimeline = mode === 'compose' || mode === 'timing';
    let content: HTMLElement;
    if (withTimeline) {
      this.timeline = new Timeline(this.editor, this.clock, { showObjects: mode === 'compose' });
      this.timeline.viewSettings = () => this.view;
      if (this.waveformPeaks) this.timeline.setWaveform(this.waveformPeaks, this.waveformDuration);
    }
    switch (mode) {
      case 'compose': {
        if (this.editor.beatmap.controlPoints.timingPoints.length === 0) {
          content = h(
            'div',
            { class: 'ed-message' },
            h('div', { class: 'ed-message-title' }, 'No timing points'),
            h('div', null, 'This beatmap has no timing points yet. Add one in the timing screen before placing objects.'),
            h('button', { class: 'ed-button', onclick: () => this.setMode('timing') }, 'Go to timing screen'),
          );
        } else {
          this.composer = createComposer(this);
          content = this.composer.el;
        }
        break;
      }
      case 'design':
        // DesignScreen: ScreenWhiteBox.UnderConstructionMessage("Design mode")
        content = h('div', { class: 'ed-message' }, h('div', { class: 'ed-message-icon' }, '🚧'), h('div', { class: 'ed-message-title' }, 'Design mode'), h('div', null, 'is not yet ready for use!'), h('div', { class: 'ed-message-sub' }, 'please check back a bit later.'));
        break;
      case 'timing': {
        const t = new TimingScreen(this);
        this.modeView = t;
        content = t.el;
        break;
      }
      case 'setup': {
        const s = new SetupScreen(this);
        this.modeView = s;
        content = s.el;
        break;
      }
      case 'verify': {
        const v = new VerifyScreen(this);
        this.modeView = v;
        content = v.el;
        break;
      }
    }
    if (this.timeline) this.screenContainer.append(h('div', { class: 'ed-timeline-area' }, this.timeline.el));
    this.screenContainer.append(h('div', { class: `ed-mode-content ed-mode-${mode}` }, content));
    requestAnimationFrame(() => this.resize());
  }

  private resize(): void {
    this.timeline?.resize();
    this.composer?.resize();
    this.summary.resize();
  }

  private frame(): void {
    this.clock.update();
    const now = this.clock.currentTime;
    this.timeline?.draw();
    this.composer?.draw(now);
    this.summary.draw();
    this.timeText.textContent = formatTime(now);
    const tp = this.editor.beatmap.controlPoints.timingPointAt(now);
    this.bpmText.textContent = this.editor.beatmap.controlPoints.timingPoints.length ? `${Math.round(tp.bpm * 100) / 100} BPM` : '';
  }

  private updatePlayButton(): void {
    this.playButton.textContent = this.clock.isRunning ? '❚❚' : '▶';
  }

  private setRate(r: number): void {
    this.clock.rate = r;
    for (const b of this.rateButtons) b.classList.toggle('active', Number(b.dataset.rate) === r);
  }

  // ---------------------------------------------------------------- input

  private readonly onWheel = (e: WheelEvent): void => {
    if ((e.target as Element).closest('.ed-setup, .ed-timing-list, .ed-verify, .ed-menu-popup, .ed-toolbox-column, .ss-context-menu')) return;
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      // EditorCycleNextBeatSnapDivisor / Previous
      this.editor.cycleDivisor(e.deltaY < 0 ? 1 : -1);
      return;
    }
    if (e.altKey) return;
    // Editor.OnScroll: seek by the beat snap (always snapped while paused).
    this.clock.seekBeat(e.deltaY > 0 ? 1 : -1);
  };

  onKeyDown(e: KeyboardEvent): boolean {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) return false;
    const ctrl = e.ctrlKey || e.metaKey;
    const ed = this.editor;

    if (this.composer?.onKeyDown(e)) return true;
    if (this.modeView?.onKeyDown?.(e)) return true;

    if (!ctrl && !e.altKey && !e.shiftKey) {
      switch (e.code) {
        case 'F1':
          this.setMode('compose');
          return true;
        case 'F2':
          this.setMode('design');
          return true;
        case 'F3':
          this.setMode('timing');
          return true;
        case 'F4':
          this.setMode('setup');
          return true;
        case 'F5':
          void this.testGameplay();
          return true;
        case 'Space':
          this.clock.togglePause();
          return true;
        case 'Delete':
        case 'Backspace':
          if (ed.selected.size > 0) ed.remove(...ed.selected);
          return true;
        case 'KeyJ':
        case 'KeyK':
          this.nudge(e.code === 'KeyK' ? 1 : -1);
          return true;
        case 'KeyW':
          this.toggleSampleOnSelection('hitwhistle');
          return ed.selected.size > 0;
        case 'KeyE':
          this.toggleSampleOnSelection('hitfinish');
          return ed.selected.size > 0;
        case 'KeyR':
          this.toggleSampleOnSelection('hitclap');
          return ed.selected.size > 0;
      }
    }
    if ((e.shiftKey || e.altKey) && !ctrl && /^Key[QWER]$/.test(e.code) && ed.selected.size > 0) {
      const bank = [null, 'normal', 'soft', 'drum'][['KeyQ', 'KeyW', 'KeyE', 'KeyR'].indexOf(e.code)];
      this.setBankOnSelection(e.shiftKey ? 'normal' : 'addition', bank);
      return true;
    }
    if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
      const dir = e.code === 'ArrowRight' ? 1 : -1;
      if (ctrl && e.shiftKey) return true;
      if (ctrl) this.clock.seekToHitObject(dir);
      else this.clock.seekBeat(dir, e.shiftKey ? 4 : 1);
      return true;
    }
    if (e.code === 'ArrowUp' || e.code === 'ArrowDown') {
      this.clock.seekToTimingPoint(e.code === 'ArrowDown' ? 1 : -1);
      return true;
    }
    if (ctrl) {
      switch (e.code) {
        case 'KeyS':
          void this.save();
          return true;
        case 'KeyZ':
          if (e.shiftKey) ed.redo();
          else ed.undo();
          return true;
        case 'KeyY':
          ed.redo();
          return true;
        case 'KeyC':
          this.copy();
          return true;
        case 'KeyX':
          this.cut();
          return true;
        case 'KeyV':
          this.paste();
          return true;
        case 'KeyD':
          this.clone();
          return true;
        case 'KeyA':
          if (e.shiftKey) {
            this.setMode('verify');
            return true;
          }
          ed.select(ed.hitObjects);
          return true;
        case 'KeyB':
          if (e.shiftKey) this.removeClosestBookmark();
          else this.addBookmark();
          return true;
      }
    }
    if (e.code === 'Home') {
      this.clock.seek(0);
      return true;
    }
    if (e.code === 'End') {
      this.clock.seek(this.editor.lastTime);
      return true;
    }
    return false;
  }

  onBack(): boolean {
    // Escape is handled by the composer first (cancel placement / deselect).
    if (this.composer?.onKeyDown(new KeyboardEvent('keydown', { code: 'Escape' }))) return false;
    void this.attemptExit();
    return false;
  }

  // ---------------------------------------------------------------- ComposerHost

  toggleSampleOnSelection(name: string): void {
    const sel = [...this.editor.selected];
    if (sel.length === 0) return;
    const allHave = sel.every(o => o.samples.some(s => s.name === name));
    this.editor.change(() => {
      for (const o of sel) {
        const apply = (list: HitSampleInfo[]) => {
          if (allHave) return list.filter(s => s.name !== name);
          if (list.some(s => s.name === name)) return list;
          const normal = list.find(s => s.name === HIT_NORMAL) ?? list[0];
          return [...list, new HitSampleInfo({ name, bank: normal?.bank, volume: normal?.volume ?? 0, editorAutoBank: true, customSampleBank: normal?.customSampleBank ?? 0 })];
        };
        o.samples = apply(o.samples);
        o.nodeSamples = o.nodeSamples.map(apply);
      }
    });
  }

  setBankOnSelection(target: 'normal' | 'addition', bank: string | null): void {
    const sel = [...this.editor.selected];
    if (sel.length === 0) return;
    this.editor.change(() => {
      for (const o of sel) {
        const apply = (list: HitSampleInfo[]) => {
          const normalBank = list.find(s => s.name === HIT_NORMAL)?.bank ?? 'normal';
          return list.map(s => {
            if (target === 'normal' && s.name === HIT_NORMAL) return new HitSampleInfo({ name: s.name, bank: bank ?? this.editor.beatmap.controlPoints.samplePointAt(o.startTime).sampleBank, volume: s.volume, editorAutoBank: s.editorAutoBank, customSampleBank: s.customSampleBank });
            if (target === 'addition' && s.name !== HIT_NORMAL) return new HitSampleInfo({ name: s.name, bank: bank ?? normalBank, volume: s.volume, editorAutoBank: bank == null, customSampleBank: s.customSampleBank });
            return s;
          });
        };
        o.samples = apply(o.samples);
        o.nodeSamples = o.nodeSamples.map(apply);
      }
    });
  }

  private nudge(direction: 1 | -1): void {
    // EditorNudgeLeft / Right: move the selection by one beat snap tick.
    const sel = [...this.editor.selected];
    if (sel.length === 0) return;
    const delta = this.editor.beatSnapLength(sel[0].startTime) * direction;
    this.editor.change(() => sel.forEach(o => (o.startTime = Math.max(0, o.startTime + delta))));
  }

  // ---------------------------------------------------------------- clipboard (EditorClipboard)

  private copy(): void {
    const sel = [...this.editor.selected].sort((a, b) => a.startTime - b.startTime);
    if (sel.length === 0) return;
    clipboard = { objects: serialiseObjects(this.editor.beatmap, sel) };
    // Editor.Copy also puts a timestamp ("00:01:234 (1,2,3) - ") on the system clipboard.
    const text = `${formatTime(sel[0].startTime)} (${sel.map(o => this.editor.comboInfo(o).indexInCombo + 1).join(',')}) - `;
    navigator.clipboard?.writeText(text).catch(() => {});
  }

  private cut(): void {
    this.copy();
    if (this.editor.selected.size) this.editor.remove(...this.editor.selected);
  }

  private paste(at = this.editor.snapTime(this.clock.currentTime)): void {
    if (!clipboard) return;
    const objects = deserialiseObjects(this.editor.beatmap, clipboard.objects);
    if (objects.length === 0) return;
    const first = Math.min(...objects.map(o => o.startTime));
    for (const o of objects) o.startTime += at - first;
    this.editor.add(...objects);
    this.editor.select(objects);
  }

  private clone(): void {
    // EditorCloneSelection: the copy is placed right after the selection.
    const sel = [...this.editor.selected];
    if (sel.length === 0) return;
    this.copy();
    const end = Math.max(...sel.map(o => o.endTime));
    this.paste(this.editor.snapTime(end + this.editor.beatSnapLength(end)));
  }

  // ---------------------------------------------------------------- bookmarks (BookmarkController)

  private addBookmark(): void {
    const t = Math.round(this.clock.currentTime);
    const b = this.editor.beatmap;
    if (b.bookmarks.includes(t)) return;
    this.editor.change(() => {
      b.bookmarks = [...b.bookmarks, t].sort((x, y) => x - y);
    });
  }

  private removeClosestBookmark(): void {
    const b = this.editor.beatmap;
    if (b.bookmarks.length === 0) return;
    const t = this.clock.currentTime;
    const closest = b.bookmarks.reduce((best, x) => (Math.abs(x - t) < Math.abs(best - t) ? x : best));
    this.editor.change(() => {
      b.bookmarks = b.bookmarks.filter(x => x !== closest);
    });
  }

  private seekBookmark(direction: 1 | -1): void {
    const t = this.clock.currentTime;
    const list = this.editor.beatmap.bookmarks;
    const target = direction > 0 ? list.find(x => x > t + 1) : [...list].reverse().find(x => x < t - 1);
    if (target != null) this.clock.seek(target);
  }

  // ---------------------------------------------------------------- menus

  private menus(): EditorMenu[] {
    const ed = this.editor;
    const set = this.set;
    const others = set.beatmaps.filter(b => b.filename !== this.filename);
    const toggle = (key: string, prop: keyof typeof this.view, label: string) => ({
      text: label,
      checked: !!this.view[prop],
      action: () => {
        (this.view as unknown as Record<string, unknown>)[prop] = !this.view[prop];
        settings.set(key, this.view[prop]);
        if (prop === 'autoSeekOnPlacement') this.composer?.refresh();
      },
    });
    return [
      {
        title: 'File',
        items: [
          {
            text: 'Create new difficulty',
            items: availableRulesets().map(r => ({ text: r.name, action: () => void this.createNewDifficulty(r.id) })),
          },
          {
            text: 'Change difficulty',
            items: others.length ? others.map(o => ({ text: o.difficultyName || o.filename, action: () => void this.switchDifficulty(o) })) : [{ text: 'No other difficulties', disabled: true }],
          },
          { spacer: true },
          { text: 'Delete difficulty', type: 'destructive', disabled: !this.filename || set.beatmaps.length < 2, action: () => void this.deleteDifficulty() },
          { spacer: true },
          { text: 'Save', hotkey: 'Ctrl+S', action: () => void this.save() },
          { text: 'Discard unsaved changes', type: 'destructive', disabled: !ed.hasUnsavedChanges, action: () => void this.discardChanges() },
          { spacer: true },
          {
            text: 'Export',
            items: [
              { text: 'For editing (.olz)', action: () => void this.export('olz') },
              { text: 'For compatibility (.osz)', action: () => void this.export('osz') },
            ],
          },
          { spacer: true },
          { text: 'Exit', action: () => void this.attemptExit() },
        ],
      },
      {
        title: 'Edit',
        items: [
          { text: 'Undo', hotkey: 'Ctrl+Z', disabled: !ed.canUndo, action: () => ed.undo() },
          { text: 'Redo', hotkey: 'Ctrl+Y', disabled: !ed.canRedo, action: () => ed.redo() },
          { spacer: true },
          { text: 'Cut', hotkey: 'Ctrl+X', disabled: ed.selected.size === 0, action: () => this.cut() },
          { text: 'Copy', hotkey: 'Ctrl+C', disabled: ed.selected.size === 0, action: () => this.copy() },
          { text: 'Paste', hotkey: 'Ctrl+V', disabled: !clipboard, action: () => this.paste() },
          { text: 'Clone', hotkey: 'Ctrl+D', disabled: ed.selected.size === 0, action: () => this.clone() },
        ],
      },
      {
        title: 'View',
        items: [
          {
            text: 'Timeline',
            items: [
              {
                text: 'Waveform opacity',
                items: [0, 0.25, 0.5, 0.75, 1].map(v => ({
                  text: `${v * 100}%`,
                  checked: this.view.waveformOpacity === v,
                  action: () => {
                    this.view.waveformOpacity = v;
                    settings.set('editor.waveformOpacity', v);
                  },
                })),
              },
              toggle('editor.timelineShowTimingChanges', 'showTimingChanges', 'Show timing changes'),
              toggle('editor.timelineShowTicks', 'showTicks', 'Show ticks'),
            ],
          },
          { spacer: true },
          {
            text: 'Background dim',
            items: [0, 0.25, 0.5, 0.75].map(v => ({
              text: `${v * 100}%`,
              checked: this.view.backgroundDim === v,
              action: () => {
                this.view.backgroundDim = v;
                this.backgroundDim = v;
                settings.set('editor.backgroundDim', v);
                this.game.setBackgroundDim(v);
              },
            })),
          },
          { spacer: true },
          toggle('editor.showHitMarkers', 'showHitMarkers', 'Show hit markers'),
          toggle('editor.autoSeekOnPlacement', 'autoSeekOnPlacement', 'Auto-seek after placement'),
        ],
      },
      {
        title: 'Timing',
        items: [
          {
            text: 'Set preview point to current time',
            action: () =>
              ed.change(() => {
                ed.beatmap.metadata.previewTime = Math.round(this.clock.currentTime);
              }),
          },
          { text: 'Snap all notes to current beat snap divisor', type: 'destructive', action: () => void this.snapAllNotes() },
          { spacer: true },
          {
            text: 'Bookmarks',
            items: [
              { text: 'Add bookmark', hotkey: 'Ctrl+B', action: () => this.addBookmark() },
              { text: 'Remove closest bookmark', hotkey: 'Ctrl+Shift+B', disabled: ed.beatmap.bookmarks.length === 0, action: () => this.removeClosestBookmark() },
              { text: 'Seek to previous bookmark', disabled: ed.beatmap.bookmarks.length === 0, action: () => this.seekBookmark(-1) },
              { text: 'Seek to next bookmark', disabled: ed.beatmap.bookmarks.length === 0, action: () => this.seekBookmark(1) },
              { spacer: true },
              {
                text: 'Reset bookmarks',
                type: 'destructive',
                disabled: ed.beatmap.bookmarks.length === 0,
                action: () =>
                  ed.change(() => {
                    ed.beatmap.bookmarks = [];
                  }),
              },
            ],
          },
        ],
      },
    ];
  }

  private async snapAllNotes(): Promise<void> {
    const i = await popupDialog(this.game, {
      icon: 'warning',
      header: 'Are you sure you want to snap all notes?',
      body: `All notes will be snapped to 1/${this.editor.beatDivisor}.`,
      buttons: [
        { text: 'Yes', type: 'danger' },
        { text: 'No', type: 'cancel' },
      ],
    });
    if (i !== 0) return;
    const ed = this.editor;
    ed.change(() => {
      for (const o of ed.hitObjects) {
        const end = o.endTime;
        o.startTime = ed.snapTime(o.startTime);
        if (o.kind === 'spinner' || o.kind === 'hold') o.duration = Math.max(0, ed.snapTime(end) - o.startTime);
      }
    });
  }

  // ---------------------------------------------------------------- saving

  async save(): Promise<boolean> {
    const b = this.editor.beatmap;
    if (!b.difficultyName.trim()) b.difficultyName = 'New difficulty';
    try {
      const result = await saveBeatmap(this.game, this.set, this.filename, this.editor.encode(), b);
      this.set = result.set;
      this.filename = result.filename;
      this.editor.markSaved();
      this.game.toast('Beatmap saved', 'success', 2000);
      this.menu.update();
      return true;
    } catch (e) {
      this.game.toast(`Saving failed: ${e instanceof Error ? e.message : String(e)}`, 'error', 6000);
      return false;
    }
  }

  private async discardChanges(): Promise<void> {
    const i = await popupDialog(this.game, {
      icon: 'warning',
      header: 'Are you sure you want to discard all unsaved changes?',
      body: 'You will not be able to undo this action.',
      buttons: [
        { text: 'Yes', type: 'danger' },
        { text: 'No, continue editing', type: 'cancel' },
      ],
    });
    if (i !== 0) return;
    if (!this.filename) {
      this.exit();
      return;
    }
    const entry = this.set.beatmaps.find(x => x.filename === this.filename);
    if (entry) this.game.replace(new EditorScreen(this.game, { set: this.set, entry }));
  }

  private async export(kind: 'osz' | 'olz'): Promise<void> {
    if (this.editor.hasUnsavedChanges && !(await this.saveRequired())) return;
    exportSet(this.game, this.set, kind);
  }

  /** SaveRequiredPopupDialog */
  private async saveRequired(): Promise<boolean> {
    const i = await popupDialog(this.game, {
      icon: 'save',
      header: 'The beatmap will be saved in order to continue with this operation.',
      buttons: [
        { text: 'Sure! Go ahead.', type: 'ok' },
        { text: 'Oops, continue editing', type: 'cancel' },
      ],
    });
    return i === 0 && (await this.save());
  }

  private async attemptExit(): Promise<void> {
    if (this.editor.hasUnsavedChanges || !this.filename) {
      // PromptForSaveDialog
      const i = await popupDialog(this.game, {
        icon: 'save',
        header: 'Did you want to save your changes?',
        buttons: [
          { text: 'Save my masterpiece!', type: 'ok' },
          { text: 'Forget all changes', type: 'danger' },
          { text: 'Oops, continue editing', type: 'cancel' },
        ],
      });
      if (i === 0) {
        if (!(await this.save())) return;
      } else if (i !== 1) return;
    }
    this.exit();
  }

  private exit(): void {
    if (this.game.currentScreen === this) this.game.pop();
  }

  // ---------------------------------------------------------------- difficulties

  private async createNewDifficulty(rulesetId: number): Promise<void> {
    if (this.editor.hasUnsavedChanges && !(await this.saveRequired())) return;
    // CreateNewDifficultyDialog
    const sameRuleset = rulesetId === this.editor.beatmap.rulesetId;
    const buttons = [{ text: "Yeah, let's start from scratch!", type: 'ok' as const }];
    if (sameRuleset) buttons.push({ text: 'No, create an exact copy of this difficulty', type: 'ok' as const });
    const i = await popupDialog(this.game, {
      icon: 'question',
      header: 'Would you like to create a blank difficulty?',
      body: 'Yeah, let\'s start from scratch! creates a blank difficulty with the same metadata and timing.',
      buttons: [...buttons, { text: 'I changed my mind, I want to keep editing this difficulty', type: 'cancel' }],
    });
    if (i < 0 || i >= buttons.length) return;
    const copy = LegacyBeatmapDecoder.decode(this.editor.encode());
    copy.difficultyName = `${copy.difficultyName} (copy)`;
    if (i === 0) {
      // BeatmapManager.CreateNewDifficulty: metadata, timing points and audio carry over; everything else is new.
      copy.hitObjects = [];
      copy.breaks = [];
      copy.bookmarks = [];
      copy.rulesetId = rulesetId;
      copy.difficultyName = 'New difficulty';
      copy.controlPoints.difficultyPoints.length = 0;
      copy.controlPoints.samplePoints.length = 0;
    }
    this.game.replace(new EditorScreen(this.game, { set: this.set, entry: null, template: copy, rulesetId }));
  }

  private async switchDifficulty(entry: BeatmapEntry): Promise<void> {
    if (this.editor.hasUnsavedChanges) {
      const i = await popupDialog(this.game, {
        icon: 'save',
        header: 'Did you want to save your changes?',
        buttons: [
          { text: 'Save my masterpiece!', type: 'ok' },
          { text: 'Forget all changes', type: 'danger' },
          { text: 'Oops, continue editing', type: 'cancel' },
        ],
      });
      if (i === 0 && !(await this.save())) return;
      if (i !== 0 && i !== 1) return;
    }
    const fresh = this.set.beatmaps.find(b => b.filename === entry.filename) ?? entry;
    await openEditor(this.game, this.set, fresh, true);
  }

  private async deleteDifficulty(): Promise<void> {
    const i = await popupDialog(this.game, {
      icon: 'trash',
      header: `Delete difficulty "${this.editor.beatmap.difficultyName}"?`,
      body: 'This difficulty will be removed from the beatmap set.',
      buttons: [
        { text: 'Yes, delete it', type: 'danger' },
        { text: 'Cancel', type: 'cancel' },
      ],
    });
    if (i !== 0 || !this.filename) return;
    const { deleteDifficulty } = await import('./EditorStorage');
    const set = await deleteDifficulty(this.game, this.set, this.filename);
    const next = set.beatmaps[0];
    if (next) await openEditor(this.game, set, next, true);
    else this.exit();
  }

  // ---------------------------------------------------------------- test play (EditorPlayer)

  private async testGameplay(): Promise<void> {
    if ((this.editor.hasUnsavedChanges || !this.filename) && !(await this.saveRequired())) return;
    const entry = this.set.beatmaps.find(b => b.filename === this.filename);
    if (!entry) return;
    const startTime = this.clock.currentTime;
    this.clock.stop();
    const { PlayerScreen } = await import('../screens/Player');
    const { ModSet } = await import('../../game/mods/Mods');
    const working = new EditorTestWorkingBeatmap(this.set, entry, startTime);
    const ruleset = getRuleset(this.editor.beatmap.rulesetId);
    this.game.push(new PlayerScreen(this.game, working, ruleset, new ModSet([]), null, { restartCount: 0, quick: true, editorTest: true }));
  }
}

/** EditorPlayer: gameplay starts from the editor's time (objects before it are left out). */
class EditorTestWorkingBeatmap extends WorkingBeatmap {
  constructor(
    set: BeatmapSetRecord,
    entry: BeatmapEntry,
    private readonly startTime: number,
  ) {
    super(set, entry);
  }

  override getBeatmap(): Promise<Beatmap> {
    return super.getBeatmap().then(b => {
      const copy = LegacyBeatmapDecoder.decode(saveText(b));
      copy.hitObjects = copy.hitObjects.filter(o => o.startTime >= this.startTime - 1);
      if (copy.hitObjects.length > 0) copy.hitObjects[0].newCombo = true;
      return copy;
    });
  }
}

const saveText = (b: Beatmap) => LegacyBeatmapEncoder.encode(b);

// ------------------------------------------------------------------ helpers

export function formatTime(ms: number): string {
  const neg = ms < 0;
  ms = Math.abs(Math.floor(ms));
  const m = Math.floor(ms / 60000);
  const s = Math.floor(ms / 1000) % 60;
  return `${neg ? '-' : ''}${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}:${String(ms % 1000).padStart(3, '0')}`;
}

/** Hit objects to text through the encoder (ClipboardContent). */
function serialiseObjects(b: Beatmap, objects: ConvertHitObject[]): string {
  const tmp = LegacyBeatmapDecoder.decode(LegacyBeatmapEncoder.encode(b));
  const set = new Set(objects.map(o => b.hitObjects.indexOf(o)));
  tmp.hitObjects = tmp.hitObjects.filter((_, i) => set.has(i));
  return LegacyBeatmapEncoder.encode(tmp);
}

function deserialiseObjects(b: Beatmap, text: string): ConvertHitObject[] {
  const decoded = LegacyBeatmapDecoder.decode(text);
  return decoded.hitObjects.map(o => {
    o.applyDefaults(b.controlPoints, b.difficulty);
    if (o.kind === 'slider') o.path = new SliderPath(o.path.controlPoints.map(c => ({ position: { ...c.position }, type: c.type })), o.path.expectedDistance);
    return o;
  });
}

/** Opens the editor for a difficulty of a set (EditorLoader). */
export async function openEditor(game: Game, set: BeatmapSetRecord, entry: BeatmapEntry, replace = false): Promise<void> {
  const working = new WorkingBeatmap(set, entry);
  let beatmap: Beatmap;
  try {
    beatmap = await working.getBeatmap();
    // Work on a private copy.
    beatmap = LegacyBeatmapDecoder.decode(LegacyBeatmapEncoder.encode(beatmap));
  } catch (e) {
    game.toast(`Couldn't open the beatmap: ${e instanceof Error ? e.message : String(e)}`, 'error', 6000);
    return;
  }
  const screen = new EditorScreen(game, { set, entry, template: beatmap });
  if (replace) game.replace(screen);
  else game.push(screen);
}

/** A new, empty beatmap set (Editor with a DummyWorkingBeatmap). */
export function newBeatmap(game: Game): void {
  const set: BeatmapSetRecord = { id: `new-${Date.now().toString(36)}`, onlineId: -1, addedAt: Date.now(), files: {}, beatmaps: [] };
  game.push(new EditorScreen(game, { set, entry: null, isNew: true, rulesetId: game.ruleset.id }));
}

