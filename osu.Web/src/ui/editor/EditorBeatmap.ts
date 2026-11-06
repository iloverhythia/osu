// Port of osu.Game/Screens/Edit/EditorBeatmap.cs + EditorChangeHandler.cs + BindableBeatDivisor.cs essentials:
// the edited beatmap (hit objects kept sorted with defaults applied), the selection, the beat divisor, and undo / redo
// through encoded states (EditorChangeHandler keeps up to MAX_SAVED_STATES = 50).

import { HIT_CLAP, HIT_FINISH, HIT_NORMAL, HIT_WHISTLE, HitSampleInfo } from '../../game/audio/HitSampleInfo';
import { Beatmap, ConvertHitObject } from '../../game/beatmaps/Beatmap';
import { PREDEFINED_DIVISORS } from '../../game/beatmaps/BeatDivisor';
import { LegacyBeatmapDecoder } from '../../game/beatmaps/LegacyBeatmapDecoder';
import { LegacyBeatmapEncoder } from '../../game/beatmaps/LegacyBeatmapEncoder';
import { SliderPath } from '../../game/objects/SliderPath';

export const MAX_SAVED_STATES = 50;

export interface ComboInfo {
  comboIndex: number;
  indexInCombo: number;
}

export class EditorBeatmap {
  beatmap: Beatmap;
  readonly selected = new Set<ConvertHitObject>();
  private readonly listeners = new Set<(kind: 'objects' | 'selection' | 'beatmap') => void>();
  beatDivisor: number;

  // EditorChangeHandler
  private states: string[] = [];
  private currentState = -1;
  private transactionDepth = 0;
  private savedState = '';

  constructor(beatmap: Beatmap) {
    this.beatmap = beatmap;
    this.beatDivisor = beatmap.beatDivisor || 4;
    this.updateObjects();
    this.saveState();
    this.savedState = this.states[0];
  }

  subscribe(l: (kind: 'objects' | 'selection' | 'beatmap') => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  emit(kind: 'objects' | 'selection' | 'beatmap'): void {
    for (const l of this.listeners) l(kind);
  }

  get hitObjects(): ConvertHitObject[] {
    return this.beatmap.hitObjects;
  }

  // ---------------------------------------------------------------- change tracking

  encode(): string {
    this.beatmap.beatDivisor = this.beatDivisor;
    return LegacyBeatmapEncoder.encode(this.beatmap);
  }

  /** IEditorChangeHandler.BeginChange */
  beginChange(): void {
    this.transactionDepth++;
  }

  /** IEditorChangeHandler.EndChange: saves a state when the outermost change ends. */
  endChange(): void {
    if (this.transactionDepth === 0) return;
    if (--this.transactionDepth === 0) this.saveState();
  }

  /** Runs a mutation as one undoable change. */
  change(fn: () => void): void {
    this.beginChange();
    try {
      fn();
    } finally {
      this.updateObjects();
      this.emit('objects');
      this.endChange();
    }
  }

  private saveState(): void {
    if (this.transactionDepth > 0) return;
    const state = this.encode();
    if (this.currentState >= 0 && this.states[this.currentState] === state) return;
    this.states = this.states.slice(0, this.currentState + 1);
    this.states.push(state);
    if (this.states.length > MAX_SAVED_STATES) this.states.shift();
    this.currentState = this.states.length - 1;
    this.emit('beatmap');
  }

  get canUndo(): boolean {
    return this.currentState > 0;
  }

  get canRedo(): boolean {
    return this.currentState < this.states.length - 1;
  }

  get hasUnsavedChanges(): boolean {
    return this.states[this.currentState] !== this.savedState;
  }

  markSaved(): void {
    this.savedState = this.states[this.currentState];
    this.emit('beatmap');
  }

  undo(): void {
    if (!this.canUndo) return;
    this.restore(this.states[--this.currentState]);
  }

  redo(): void {
    if (!this.canRedo) return;
    this.restore(this.states[++this.currentState]);
  }

  private restore(state: string): void {
    // LegacyEditorBeatmapPatcher: the decoded state replaces the beatmap, keeping the selection where objects survive.
    const selectedTimes = new Set([...this.selected].map(h => h.startTime));
    const decoded = LegacyBeatmapDecoder.decode(state);
    this.beatmap = decoded;
    this.beatDivisor = decoded.beatDivisor;
    this.selected.clear();
    for (const h of decoded.hitObjects) if (selectedTimes.has(h.startTime)) this.selected.add(h);
    this.updateObjects();
    this.emit('objects');
    this.emit('selection');
    this.emit('beatmap');
  }

  // ---------------------------------------------------------------- objects

  /** EditorBeatmapProcessor: sorting, defaults and combo information. */
  updateObjects(): void {
    const b = this.beatmap;
    b.hitObjects.sort((x, y) => x.startTime - y.startTime);
    for (const h of b.hitObjects) {
      if (h.kind === 'slider') h.applyDefaults(b.controlPoints, b.difficulty);
    }
    this.comboCache = null;
  }

  private comboCache: Map<ConvertHitObject, ComboInfo> | null = null;

  /** IHasComboInformation: combo index (with combo offsets) and index within the combo. */
  comboInfo(h: ConvertHitObject): ComboInfo {
    if (!this.comboCache) {
      this.comboCache = new Map();
      let comboIndex = 0;
      let indexInCombo = 0;
      let prev: ConvertHitObject | null = null;
      for (const o of this.beatmap.hitObjects) {
        const isNew = !prev || o.newCombo || prev.kind === 'spinner' || o.kind === 'spinner';
        if (prev && isNew) {
          comboIndex += 1 + (o.newCombo ? o.comboOffset : 0);
          indexInCombo = 0;
        } else if (prev) indexInCombo++;
        this.comboCache.set(o, { comboIndex, indexInCombo });
        prev = o;
      }
    }
    return this.comboCache.get(h) ?? { comboIndex: 0, indexInCombo: 0 };
  }

  add(...objects: ConvertHitObject[]): void {
    this.change(() => this.beatmap.hitObjects.push(...objects));
  }

  remove(...objects: ConvertHitObject[]): void {
    const set = new Set(objects);
    this.change(() => {
      this.beatmap.hitObjects = this.beatmap.hitObjects.filter(h => !set.has(h));
      for (const o of objects) this.selected.delete(o);
    });
    this.emit('selection');
  }

  // ---------------------------------------------------------------- selection

  select(objects: Iterable<ConvertHitObject>, additive = false): void {
    if (!additive) this.selected.clear();
    for (const o of objects) this.selected.add(o);
    this.emit('selection');
  }

  toggleSelected(o: ConvertHitObject): void {
    if (this.selected.has(o)) this.selected.delete(o);
    else this.selected.add(o);
    this.emit('selection');
  }

  clearSelection(): void {
    if (this.selected.size === 0) return;
    this.selected.clear();
    this.emit('selection');
  }

  // ---------------------------------------------------------------- snapping (BeatmapBase.SnapTime / BindableBeatDivisor)

  /** IBeatSnapProvider.SnapTime: snaps to the closest beat-divisor tick of the timing point at the reference time. */
  snapTime(time: number, referenceTime: number | null = null): number {
    const tp = this.beatmap.controlPoints.timingPointAt(referenceTime ?? time);
    const beatLength = tp.beatLength / this.beatDivisor;
    const beats = Math.round((time - tp.time) / beatLength);
    return Math.floor(tp.time + beats * beatLength);
  }

  /** Beat length divided by the beat divisor at a time. */
  beatSnapLength(time: number): number {
    return this.beatmap.controlPoints.timingPointAt(time).beatLength / this.beatDivisor;
  }

  /** BindableBeatDivisor.SelectNext / SelectPrevious through the predefined divisors. */
  cycleDivisor(direction: 1 | -1): void {
    const list = PREDEFINED_DIVISORS as readonly number[];
    let i = list.indexOf(this.beatDivisor);
    if (i < 0) i = list.findIndex(d => d > this.beatDivisor) - (direction > 0 ? 1 : 0);
    i = Math.max(0, Math.min(list.length - 1, i + direction));
    this.setDivisor(list[i]);
  }

  setDivisor(d: number): void {
    this.beatDivisor = Math.max(1, Math.min(64, Math.round(d)));
    this.beatmap.beatDivisor = this.beatDivisor;
    this.emit('beatmap');
  }

  // ---------------------------------------------------------------- object creation helpers

  /** Default samples for a new object (the sample point at its time, plus the active addition toggles). */
  createSamples(time: number, additions: { whistle: boolean; finish: boolean; clap: boolean }, banks: { normal: string | null; addition: string | null } = { normal: null, addition: null }): HitSampleInfo[] {
    const sp = this.beatmap.controlPoints.samplePointAt(time);
    const normalBank = banks.normal ?? sp.sampleBank;
    const addBank = banks.addition ?? normalBank;
    const list = [new HitSampleInfo({ name: HIT_NORMAL, bank: normalBank, volume: sp.sampleVolume, editorAutoBank: true })];
    const add = (name: string) => list.push(new HitSampleInfo({ name, bank: addBank, volume: sp.sampleVolume, editorAutoBank: banks.addition == null }));
    if (additions.whistle) add(HIT_WHISTLE);
    if (additions.finish) add(HIT_FINISH);
    if (additions.clap) add(HIT_CLAP);
    return list;
  }

  createCircle(time: number, x: number, y: number, newCombo: boolean, samples: HitSampleInfo[]): ConvertHitObject {
    const h = new ConvertHitObject('circle');
    h.startTime = time;
    h.x = x;
    h.y = y;
    h.newCombo = newCombo;
    h.samples = samples;
    return h;
  }

  createSlider(time: number, x: number, y: number, path: SliderPath, newCombo: boolean, samples: HitSampleInfo[]): ConvertHitObject {
    const h = new ConvertHitObject('slider');
    h.startTime = time;
    h.x = x;
    h.y = y;
    h.newCombo = newCombo;
    h.path = path;
    h.samples = samples;
    h.sliderVelocityMultiplier = this.beatmap.controlPoints.difficultyPointAt(time).sliderVelocity;
    h.nodeSamples = [samples.map(s => s), samples.map(s => s)];
    h.applyDefaults(this.beatmap.controlPoints, this.beatmap.difficulty);
    this.snapSliderLength(h);
    return h;
  }

  createTimed(kind: 'spinner' | 'hold', time: number, endTime: number, x: number, y: number, newCombo: boolean, samples: HitSampleInfo[]): ConvertHitObject {
    const h = new ConvertHitObject(kind);
    h.startTime = time;
    h.duration = Math.max(0, endTime - time);
    h.x = x;
    h.y = y;
    h.newCombo = newCombo;
    h.samples = samples;
    return h;
  }

  /** IDistanceSnapProvider.FindSnappedDistance(slider, distance, DistanceSnapTarget.End): the path length snaps down to whole beat-divisor ticks. */
  snapSliderLength(h: ConvertHitObject): void {
    h.applyDefaults(this.beatmap.controlPoints, this.beatmap.difficulty);
    const full = h.path.calculatedDistance;
    const step = this.beatSnapLength(h.startTime) * h.velocity;
    if (step <= 0 || !Number.isFinite(step)) {
      h.path.expectedDistance = full;
    } else {
      const ticks = Math.max(1, Math.floor(full / step + 1e-6));
      h.path.expectedDistance = Math.min(full, ticks * step);
    }
    h.path.invalidate();
    const spans = h.spanCount;
    while (h.nodeSamples.length < spans + 1) h.nodeSamples.push(h.samples.map(s => s));
    h.nodeSamples.length = spans + 1;
  }

  /** The beatmap's playable length for the summary timeline when there's no audio. */
  get lastTime(): number {
    return this.beatmap.hitObjects.reduce((m, h) => Math.max(m, h.endTime), 0);
  }

  /** BindableBeatDivisor.GetDivisorForBeatIndex */
  static divisorForBeatIndex(index: number, beatDivisor: number): number {
    const beat = ((index % beatDivisor) + beatDivisor) % beatDivisor;
    for (const d of PREDEFINED_DIVISORS) if ((beat * d) % beatDivisor === 0) return d;
    return 0;
  }
}
