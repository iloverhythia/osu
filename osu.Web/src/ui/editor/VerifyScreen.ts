// Port of osu.Game/Screens/Edit/Verify/VerifyScreen.cs (IssueList / IssueTable, IssueSettings: Interpretation and
// Visibility) with BeatmapVerifier checks: CheckBackgroundPresence, CheckAudioPresence, CheckUnsnappedObjects,
// CheckConcurrentObjects, CheckZeroLengthObjects, CheckDrainLength, CheckMutedObjects, CheckMissingGenreLanguage,
// CheckAbnormalDifficultySettings and, for osu!, CheckOffscreenObjects and CheckTooShortSpinners.
// Clicking an issue seeks to it and selects its objects.

import type { ConvertHitObject } from '../../game/beatmaps/Beatmap';
import { getClosestBeatDivisor } from '../../game/beatmaps/BeatDivisor';
import { calculateScaleFromCircleSize } from '../../game/rulesets/osu/objects';
import { h } from '../dom';
import type { EditorScreen } from './Editor';
import { formatTime } from './Editor';

type IssueType = 'Problem' | 'Warning' | 'Negligible';

interface Issue {
  type: IssueType;
  time: number | null;
  objects: ConvertHitObject[];
  message: string;
  check: string;
}

const KIND_NAMES: Record<string, string> = { circle: 'HitCircle', slider: 'Slider', spinner: 'Spinner', hold: 'HoldNote' };
const GENRES = ['rock', 'pop', 'electronic', 'metal', 'jazz', 'classical', 'hip', 'hop', 'folk', 'novelty', 'anime', 'game', 'instrumental', 'video'];
const LANGUAGES = ['english', 'japanese', 'chinese', 'instrumental', 'korean', 'french', 'german', 'swedish', 'spanish', 'italian', 'russian', 'polish'];

export class VerifyScreen {
  readonly el: HTMLElement;
  private readonly table: HTMLElement;
  private readonly visibility: Record<IssueType, boolean> = { Problem: true, Warning: true, Negligible: false };
  private interpretation = 'Insane';

  constructor(private readonly host: EditorScreen) {
    this.table = h('div', { class: 'ed-issues' });
    const interp = h(
      'select',
      { class: 'ed-select' },
      ...['Easy', 'Normal', 'Hard', 'Insane', 'Expert'].map(d => h('option', { value: d, selected: d === this.interpretation }, d)),
    ) as HTMLSelectElement;
    interp.addEventListener('change', () => {
      this.interpretation = interp.value;
      this.update();
    });
    const vis = (Object.keys(this.visibility) as IssueType[]).map(t => {
      const cb = h('input', { type: 'checkbox', checked: this.visibility[t] }) as HTMLInputElement;
      cb.addEventListener('change', () => {
        this.visibility[t] = cb.checked;
        this.update();
      });
      return h('label', { class: 'ed-verify-check' }, cb, h('span', { class: `ed-issue-type ${t.toLowerCase()}` }, t));
    });
    const settings = h(
      'div',
      { class: 'ed-verify-settings' },
      h('div', { class: 'ed-setup-section-title' }, 'Interpretation'),
      h('div', { class: 'ed-verify-note' }, 'The difficulty level this beatmap is checked against.'),
      interp,
      h('div', { class: 'ed-setup-section-title' }, 'Visibility'),
      ...vis,
      h('button', { class: 'ed-button', onclick: () => this.update() }, 'Refresh'),
    );
    this.el = h('div', { class: 'ed-verify' }, this.table, settings);
    this.update();
  }

  dispose(): void {}

  update(): void {
    const issues = this.run().filter(i => this.visibility[i.type]);
    issues.sort((a, b) => ['Problem', 'Warning', 'Negligible'].indexOf(a.type) - ['Problem', 'Warning', 'Negligible'].indexOf(b.type) || (a.time ?? -1) - (b.time ?? -1));
    const header = h('div', { class: 'ed-issue-row header' }, h('span', null, 'Type'), h('span', null, 'Time'), h('span', null, 'Message'), h('span', null, 'Category'));
    const rows = issues.map(i => {
      const row = h('div', { class: 'ed-issue-row' }, h('span', { class: `ed-issue-type ${i.type.toLowerCase()}` }, i.type), h('span', null, i.time != null ? formatTime(i.time) : ''), h('span', null, i.message), h('span', { class: 'ed-issue-check' }, i.check));
      row.addEventListener('click', () => {
        if (i.time != null) this.host.clock.seek(i.time);
        if (i.objects.length) this.host.editor.select(i.objects);
      });
      return row;
    });
    this.table.replaceChildren(header, ...(rows.length ? rows : [h('div', { class: 'ed-issues-none' }, 'No issues found! 🎉')]));
  }

  private run(): Issue[] {
    const issues: Issue[] = [];
    const ed = this.host.editor;
    const b = ed.beatmap;
    const objects = b.hitObjects;
    const name = (o: ConvertHitObject) => KIND_NAMES[o.kind] ?? o.kind;
    const files = this.host.set.files;
    const has = (f: string) => Object.keys(files).some(k => k.toLowerCase() === f.toLowerCase());

    // CheckFilePresence (background / audio)
    for (const [type, file] of [
      ['background', b.metadata.backgroundFile],
      ['audio', b.metadata.audioFile],
    ] as const) {
      if (!file) issues.push({ type: 'Problem', time: null, objects: [], message: `No ${type} has been set.`, check: `Missing ${type}` });
      else if (!has(file)) issues.push({ type: 'Problem', time: null, objects: [], message: `The ${type} file "${file}" does not exist.`, check: `Missing ${type}` });
    }

    // CheckUnsnappedObjects
    const cp = b.controlPoints;
    const closestSnapped = (t: number) => {
      const d = getClosestBeatDivisor(cp, t);
      const tp = cp.timingPointAt(t);
      const step = tp.beatLength / d;
      return tp.time + Math.round((t - tp.time) / step) * step;
    };
    if (cp.timingPoints.length > 0) {
      for (const o of objects) {
        const times: [number, string][] = [[o.startTime, o.hasDuration ? ' start' : '']];
        if (o.kind === 'slider') for (let r = 1; r <= o.repeatCount; r++) times.push([o.startTime + (o.duration / o.spanCount) * r, ' repeat']);
        if (o.hasDuration) times.push([o.endTime, ' end']);
        for (const [t, postfix] of times) {
          const unsnap = t - closestSnapped(t);
          if (Math.abs(unsnap) >= 2) issues.push({ type: 'Problem', time: t, objects: [o], message: `${name(o)}${postfix} is unsnapped by ${fmt2(Math.abs(unsnap))} ms.`, check: 'Unsnapped hitobjects' });
          else if (Math.abs(unsnap) >= 1) issues.push({ type: 'Negligible', time: t, objects: [o], message: `${name(o)}${postfix} is unsnapped by ${fmt2(Math.abs(unsnap))} ms.`, check: 'Unsnapped hitobjects' });
        }
      }
    }

    // CheckConcurrentObjects
    for (let i = 0; i < objects.length - 1; i++) {
      const o = objects[i];
      for (let j = i + 1; j < objects.length; j++) {
        const n = objects[j];
        if (b.rulesetId === 3 && n.x !== o.x) continue;
        const concurrent = n.startTime <= o.endTime + 2;
        const almost = Math.abs(n.startTime - o.endTime) < 10;
        if (concurrent) issues.push({ type: 'Problem', time: n.startTime, objects: [o, n], message: name(o) === name(n) ? `${name(o)}s are concurrent here.` : `${name(o)} and ${name(n)} are concurrent here.`, check: 'Concurrent hitobjects' });
        else if (almost) issues.push({ type: 'Problem', time: n.startTime, objects: [o, n], message: name(o) === name(n) ? `${name(o)}s are less than 10ms apart.` : `${name(o)} and ${name(n)} are less than 10ms apart.`, check: 'Concurrent hitobjects' });
        else break;
      }
    }

    // CheckZeroLengthObjects
    for (const o of objects) if (o.hasDuration && o.duration < 0.5) issues.push({ type: 'Problem', time: o.startTime, objects: [o], message: `${name(o)} has a duration of ${Math.round(o.duration)}.`, check: 'Zero-length hitobjects' });

    // CheckDrainLength
    if (objects.length > 0) {
      const drain = b.drainLength;
      if (drain < 30000) issues.push({ type: 'Problem', time: null, objects: [], message: `Less than 30 seconds of drain time, currently ${formatDuration(drain)}.`, check: 'Drain length is too short' });
    }

    // CheckMutedObjects
    for (const o of objects) {
      if (o.kind === 'spinner') continue;
      const volume = Math.max(0, ...o.samples.map(s => s.volume || cp.samplePointAt(o.startTime).sampleVolume));
      if (volume <= 5) issues.push({ type: 'Problem', time: o.startTime, objects: [o], message: `${name(o)} has a volume of ${volume}%. Clickable objects must have clearly audible feedback.`, check: 'Low volume hitobjects' });
      else if (volume <= 20) issues.push({ type: 'Warning', time: o.startTime, objects: [o], message: `${name(o)} has a volume of ${volume}%, ensure this is audible.`, check: 'Low volume hitobjects' });
    }

    // CheckMissingGenreLanguage
    const words = `${b.metadata.tags}`.toLowerCase().split(/\s+/);
    if (!GENRES.some(g => words.includes(g))) issues.push({ type: 'Problem', time: null, objects: [], message: 'Missing genre tag ("rock", "pop", "electronic", etc), ignore if none fit.', check: 'Missing Genre/Language Tags' });
    if (!LANGUAGES.some(g => words.includes(g))) issues.push({ type: 'Problem', time: null, objects: [], message: 'Missing language tag ("english", "japanese", "instrumental", etc), ignore if none fit.', check: 'Missing Genre/Language Tags' });

    // CheckAbnormalDifficultySettings
    const d = b.difficulty;
    for (const [label, v] of [
      ['Approach rate', d.approachRate],
      ['Overall difficulty', d.overallDifficulty],
      ['Circle size', d.circleSize],
      ['Drain rate', d.drainRate],
    ] as const) {
      if (Math.abs(Math.round(v * 10) - v * 10) > 1e-4) issues.push({ type: 'Problem', time: null, objects: [], message: `${label} ${v} has more than one decimal place.`, check: 'Abnormal difficulty settings' });
    }

    if (b.rulesetId === 0) {
      // CheckOffscreenObjects
      const radius = 64 * calculateScaleFromCircleSize(d.circleSize, true);
      const off = (x: number, y: number) => x - radius < -67 || x + radius > 579 || y - radius < -60 || y + radius > 428;
      for (const o of objects) {
        if (o.kind === 'circle' && off(o.x, o.y)) issues.push({ type: 'Problem', time: o.startTime, objects: [o], message: 'This circle goes offscreen on a 4:3 aspect ratio.', check: 'Offscreen hitobjects' });
        if (o.kind === 'slider') {
          for (let i = 0; i <= o.path.distance; i += 5) {
            const p = o.path.positionAt(i / Math.max(1, o.path.distance));
            if (off(o.x + p.x, o.y + p.y)) {
              issues.push({ type: 'Problem', time: o.startTime + (i / Math.max(1, o.path.distance)) * (o.duration / o.spanCount), objects: [o], message: 'This slider goes offscreen here on a 4:3 aspect ratio.', check: 'Offscreen hitobjects' });
              break;
            }
          }
        }
      }
      // CheckTooShortSpinners
      const od = d.overallDifficulty;
      const warning = 500 + (od < 5 ? (5 - od) * -21.8 : (od - 5) * 20);
      const problem = 450 + (od < 5 ? (5 - od) * -17 : (od - 5) * 17);
      for (const o of objects) {
        if (o.kind !== 'spinner') continue;
        if (o.duration < problem) issues.push({ type: 'Problem', time: o.startTime, objects: [o], message: 'This spinner is too short. Auto cannot achieve 1000 points on this.', check: 'Too short spinners' });
        else if (o.duration < warning) issues.push({ type: 'Warning', time: o.startTime, objects: [o], message: 'This spinner may be too short. Ensure auto can achieve 1000 points on this.', check: 'Too short spinners' });
      }
    }
    return issues;
  }
}

const fmt2 = (v: number) => (Math.round(v * 100) / 100).toString();

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
