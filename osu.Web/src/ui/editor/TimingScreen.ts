// Port of osu.Game/Screens/Edit/Timing/TimingScreen.cs: ControlPointList (groups with their attributes, "+ Add at
// current time" / delete) and ControlPointSettings (GroupSection: time and "Use current time"; TimingSection: BPM,
// time signature, omit first bar line, TapTimingControl with tap BPM, metronome and offset / BPM adjustments;
// EffectSection: kiai time and scroll speed). Selecting a group seeks to it.

import '../overlays/settings/settings.css';
import { EffectControlPoint, TimingControlPoint } from '../../game/beatmaps/ControlPoints';
import { h } from '../dom';
import { applyColours } from '../overlays/settings/SettingsOverlay';
import { bindValue, formCheckBox, formDropdown, formSliderBar, formTextBox, type FormControl } from '../overlays/settings/controls';
import type { EditorScreen } from './Editor';
import { formatTime } from './Editor';

export class TimingScreen {
  readonly el: HTMLElement;
  private readonly list: HTMLElement;
  private readonly settingsPanel: HTMLElement;
  private selectedTime: number | null = null;
  private controls: FormControl[] = [];
  private taps: number[] = [];
  private metronome: HTMLElement | null = null;
  private raf = 0;

  constructor(private readonly host: EditorScreen) {
    this.list = h('div', { class: 'ed-timing-list' });
    this.settingsPanel = h('div', { class: 'ed-timing-settings st-root ed-st' });
    applyColours(this.settingsPanel);
    const add = h('button', { class: 'ed-button primary', onclick: () => this.addAtCurrentTime() }, '+ Add at current time');
    const del = h('button', { class: 'ed-button danger', onclick: () => this.deleteSelected() }, 'Delete');
    this.el = h('div', { class: 'ed-timing' }, h('div', { class: 'ed-timing-left' }, this.list, h('div', { class: 'ed-timing-buttons' }, del, add)), this.settingsPanel);
    const tps = host.editor.beatmap.controlPoints.timingPoints;
    const now = host.clock.currentTime;
    this.selectedTime = [...this.groupTimes()].reverse().find(t => t <= now) ?? tps[0]?.time ?? null;
    this.lastBeatmap = host.editor.beatmap;
    this.render();
    const tick = () => {
      this.updateMetronome();
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
  }

  private lastBeatmap: unknown = null;

  update(): void {
    // Undo / redo replace the beatmap: rebuild the settings bound to its control points.
    if (this.host.editor.beatmap !== this.lastBeatmap) {
      this.lastBeatmap = this.host.editor.beatmap;
      this.render();
      return;
    }
    this.renderList();
    for (const c of this.controls) c.update();
  }

  private get cp() {
    return this.host.editor.beatmap.controlPoints;
  }

  private groupTimes(): number[] {
    const cp = this.cp;
    return [...new Set([...cp.timingPoints, ...cp.effectPoints, ...cp.samplePoints, ...cp.difficultyPoints].map(p => p.time))].sort((a, b) => a - b);
  }

  private render(): void {
    this.renderList();
    this.renderSettings();
  }

  /** ControlPointTable */
  private renderList(): void {
    const cp = this.cp;
    const times = this.groupTimes();
    const header = h('div', { class: 'ed-cp-row header' }, h('span', { class: 'ed-cp-time' }, 'Time'), h('span', null, 'Attributes'));
    const rows = times.map(t => {
      const timing = cp.timingPoints.find(p => p.time === t);
      const effect = cp.effectPoints.find(p => p.time === t);
      const sample = cp.samplePoints.find(p => p.time === t);
      const diff = cp.difficultyPoints.find(p => p.time === t);
      const attrs: HTMLElement[] = [];
      if (timing) attrs.push(h('span', { class: 'ed-cp-attr timing' }, `${(Math.round(timing.bpm * 100) / 100).toFixed(2)}bpm ${timing.timeSignature}/4`));
      if (diff && diff.sliderVelocity !== 1) attrs.push(h('span', { class: 'ed-cp-attr difficulty' }, `${diff.sliderVelocity.toFixed(2)}x`));
      if (effect) attrs.push(h('span', { class: `ed-cp-attr effect${effect.kiaiMode ? ' kiai' : ''}` }, effect.kiaiMode ? 'kiai' : `${effect.scrollSpeed.toFixed(2)}x`));
      if (sample) attrs.push(h('span', { class: 'ed-cp-attr sample' }, `${sample.sampleBank} ${sample.sampleVolume}%`));
      const row = h('div', { class: `ed-cp-row${t === this.selectedTime ? ' selected' : ''}` }, h('span', { class: 'ed-cp-time' }, formatTime(t)), h('span', { class: 'ed-cp-attrs' }, ...attrs));
      row.addEventListener('click', () => {
        this.selectedTime = t;
        this.host.clock.seek(t);
        this.render();
      });
      return row;
    });
    this.list.replaceChildren(header, ...(rows.length ? rows : [h('div', { class: 'ed-cp-empty' }, 'No control points yet. Add one at the current time to start timing the beatmap.')]));
  }

  private change(fn: () => void): void {
    this.host.editor.change(fn);
  }

  /** ControlPointSettings */
  private renderSettings(): void {
    const t = this.selectedTime;
    this.controls = [];
    const add = (c: FormControl) => (this.controls.push(c), c.el);
    if (t == null) {
      this.settingsPanel.replaceChildren(h('div', { class: 'ed-cp-empty' }, 'Select a control point group.'));
      return;
    }
    const cp = this.cp;
    const timing = () => cp.timingPoints.find(p => p.time === this.selectedTime);
    const effect = () => cp.effectPoints.find(p => p.time === this.selectedTime);

    // GroupSection
    const timeBox = add(
      formTextBox(
        'Time',
        bindValue(
          () => String(Math.round(this.selectedTime ?? 0)),
          v => {
            const nt = Number(v);
            if (!Number.isFinite(nt) || this.selectedTime == null) return;
            this.moveGroup(this.selectedTime, Math.max(0, Math.round(nt)));
          },
          '0',
        ),
        { maxLength: 12 },
      ),
    );
    const group = section('Group', [timeBox, h('button', { class: 'ed-button', onclick: () => this.selectedTime != null && this.moveGroup(this.selectedTime, Math.round(this.host.clock.currentTime)) }, 'Use current time')]);

    // TimingSection
    const tp = timing();
    const timingToggle = add(
      formCheckBox(
        'Timing',
        bindValue(
          () => timing() != null,
          v =>
            this.change(() => {
              if (v && !timing()) {
                const copy = new TimingControlPoint();
                const cur = cp.timingPointAt(t);
                copy.beatLength = cur.beatLength;
                copy.timeSignature = cur.timeSignature;
                cp.add(t, copy);
              } else if (!v) {
                const i = cp.timingPoints.findIndex(p => p.time === t);
                if (i >= 0) cp.timingPoints.splice(i, 1);
              }
              queueMicrotask(() => this.render());
            }),
          false,
        ),
      ),
    );
    const timingBody: HTMLElement[] = [timingToggle];
    if (tp) {
      timingBody.push(
        add(
          formTextBox(
            'BPM',
            bindValue(
              () => String(Math.round(tp.bpm * 1000) / 1000),
              v => {
                const bpm = Number(v);
                if (bpm > 0) this.change(() => (tp.beatLength = 60000 / bpm));
              },
              '120',
            ),
            { maxLength: 12 },
          ),
        ),
        add(
          formDropdown<number>(
            'Time Signature',
            bindValue(() => tp.timeSignature, v => this.change(() => (tp.timeSignature = v)), 4),
            [3, 4, 5, 6, 7].map(n => [n, `${n}/4`] as const),
          ),
        ),
        add(formCheckBox('Omit first bar line', bindValue(() => tp.omitFirstBarLine, v => this.change(() => (tp.omitFirstBarLine = v)), false))),
        this.tapTimingControl(tp),
      );
    }

    // EffectSection
    const ep = effect();
    const scrolling = this.host.editor.beatmap.rulesetId === 1 || this.host.editor.beatmap.rulesetId === 3;
    const ensureEffect = (): EffectControlPoint => {
      let e = effect();
      if (!e) {
        e = new EffectControlPoint();
        const cur = cp.effectPointAt(t);
        e.kiaiMode = cur.kiaiMode;
        e.scrollSpeed = cur.scrollSpeed;
        cp.add(t, e);
      }
      return e;
    };
    const effectBody = [
      add(formCheckBox('Kiai Time', bindValue(() => (ep ?? cp.effectPointAt(t)).kiaiMode, v => this.change(() => (ensureEffect().kiaiMode = v)), false))),
      scrolling
        ? add(formSliderBar('Scroll Speed', bindValue(() => (effect() ?? cp.effectPointAt(t)).scrollSpeed, v => this.change(() => (ensureEffect().scrollSpeed = v)), 1), { min: 0.01, max: 10, precision: 0.01, labelFormat: v => `${v.toFixed(2)}x` }))
        : null,
    ];

    this.settingsPanel.replaceChildren(group, section('Timing', timingBody), section('Effect', effectBody.filter((e): e is HTMLElement => e != null)));
  }

  /** TapTimingControl: metronome, tap for BPM, offset and BPM adjustments, reset. */
  private tapTimingControl(tp: TimingControlPoint): HTMLElement {
    this.metronome = h('div', { class: 'ed-metronome' }, ...Array.from({ length: tp.timeSignature }, () => h('div', { class: 'ed-metronome-beat' })));
    const adjust = (label: string, fn: () => void) => h('button', { class: 'ed-button small', onclick: fn }, label);
    const tapButton = h('button', { class: 'ed-tap', title: 'Tap to the beat (T)' }, 'Tap');
    tapButton.addEventListener('pointerdown', () => this.tap(tp));
    const offset = (d: number) => this.moveGroup(tp.time, Math.max(0, tp.time + d));
    const bpm = (d: number) => this.change(() => (tp.beatLength = 60000 / Math.max(1, tp.bpm + d)));
    return h(
      'div',
      { class: 'ed-tap-timing' },
      this.metronome,
      h(
        'div',
        { class: 'ed-tap-rows' },
        h('div', { class: 'ed-tap-row' }, h('span', null, 'Offset'), adjust('−5', () => offset(-5)), adjust('−1', () => offset(-1)), adjust('+1', () => offset(1)), adjust('+5', () => offset(5))),
        h('div', { class: 'ed-tap-row' }, h('span', null, 'BPM'), adjust('−1', () => bpm(-1)), adjust('−0.1', () => bpm(-0.1)), adjust('+0.1', () => bpm(0.1)), adjust('+1', () => bpm(1))),
      ),
      h('div', { class: 'ed-tap-row' }, adjust('Use current time', () => this.moveGroup(tp.time, Math.round(this.host.clock.currentTime))), tapButton, adjust('Reset', () => (this.taps = []))),
    );
  }

  private tap(tp: TimingControlPoint): void {
    // TapButton: BPM from the average interval of the recent taps (resets after 2s without a tap).
    const now = performance.now();
    if (this.taps.length && now - this.taps[this.taps.length - 1] > 2000) this.taps = [];
    this.taps.push(now);
    if (this.taps.length > 16) this.taps.shift();
    if (this.taps.length >= 4) {
      const intervals = this.taps.slice(1).map((x, i) => x - this.taps[i]);
      const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      this.change(() => (tp.beatLength = Math.round(avg * this.host.clock.rate * 100) / 100));
    }
  }

  private updateMetronome(): void {
    if (!this.metronome || this.selectedTime == null) return;
    const tp = this.cp.timingPointAt(this.host.clock.currentTime);
    const beat = Math.floor((this.host.clock.currentTime - tp.time) / tp.beatLength);
    const idx = ((beat % tp.timeSignature) + tp.timeSignature) % tp.timeSignature;
    const beats = this.metronome.children;
    for (let i = 0; i < beats.length; i++) beats[i].classList.toggle('active', i === idx && this.host.clock.currentTime >= tp.time);
  }

  private moveGroup(from: number, to: number): void {
    if (from === to) return;
    const cp = this.cp;
    this.change(() => {
      for (const list of [cp.timingPoints, cp.effectPoints, cp.samplePoints, cp.difficultyPoints] as { time: number }[][]) {
        const p = list.find(x => x.time === from);
        if (p) {
          list.splice(list.indexOf(p), 1);
          cp.add(to, p as never);
        }
      }
    });
    this.selectedTime = to;
    this.render();
  }

  private addAtCurrentTime(): void {
    const cp = this.cp;
    const t = Math.round(this.host.clock.currentTime);
    this.change(() => {
      if (!cp.timingPoints.some(p => p.time === t)) {
        const tp = new TimingControlPoint();
        const cur = cp.timingPoints.length ? cp.timingPointAt(t) : null;
        tp.beatLength = cur ? cur.beatLength : 500;
        tp.timeSignature = cur ? cur.timeSignature : 4;
        cp.add(t, tp);
      }
    });
    this.selectedTime = t;
    this.render();
  }

  private deleteSelected(): void {
    const t = this.selectedTime;
    if (t == null) return;
    const cp = this.cp;
    this.change(() => {
      for (const list of [cp.timingPoints, cp.effectPoints, cp.samplePoints, cp.difficultyPoints] as { time: number }[][]) {
        const i = list.findIndex(x => x.time === t);
        if (i >= 0) list.splice(i, 1);
      }
    });
    const times = this.groupTimes();
    this.selectedTime = [...times].reverse().find(x => x <= t) ?? times[0] ?? null;
    this.render();
  }

  onKeyDown(e: KeyboardEvent): boolean {
    if (e.code === 'KeyT' && this.selectedTime != null) {
      const tp = this.cp.timingPoints.find(p => p.time === this.selectedTime);
      if (tp) {
        this.tap(tp);
        return true;
      }
    }
    return false;
  }
}

function section(title: string, children: HTMLElement[]): HTMLElement {
  return h('div', { class: 'ed-setup-section' }, h('div', { class: 'ed-setup-section-title' }, title), h('div', { class: 'ed-setup-section-body' }, ...children));
}
