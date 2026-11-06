// Port of osu.Game/Screens/Edit/Compose/Components/Timeline/* (Timeline, TimelineTickDisplay, TimelineTimingChangeDisplay,
// TimelineBreakDisplay, TimelineHitObjectBlueprint, CentreMarker, ZoomableScrollContainer) drawn on one canvas:
// the waveform, beat-divisor ticks, timing changes, breaks and hit objects scroll past the centre marker.
// Dragging empty space scrubs, Ctrl+wheel zooms, clicking selects and dragging moves objects in time
// (dragging an object's end changes a slider's repeats or a spinner / hold's duration).

import type { ConvertHitObject } from '../../game/beatmaps/Beatmap';
import { beatDivisorColour } from '../../game/beatmaps/BeatDivisor';
import { h } from '../dom';
import { EditorBeatmap } from './EditorBeatmap';
import type { EditorClock } from './EditorClock';
import { comboColour } from './colours';

/** ZoomableScrollContainer bounds (timeline zoom multiplier). */
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 6;
/** Pixels per ms at zoom 1. */
const BASE_PX_PER_MS = 0.18;

export interface TimelineOptions {
  showObjects: boolean;
  /** Called after the user seeks by interacting with the timeline. */
  onSeek?: () => void;
}

export class Timeline {
  readonly el: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D;
  private zoom: number;
  private waveform: Float32Array | null = null;
  private waveformDuration = 0;
  private dpr = 1;
  private width = 0;
  private height = 0;

  constructor(
    private readonly editor: EditorBeatmap,
    private readonly clock: EditorClock,
    private readonly opts: TimelineOptions,
  ) {
    this.canvas = h('canvas', { class: 'ed-timeline-canvas' });
    this.g = this.canvas.getContext('2d')!;
    this.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, editor.beatmap.timelineZoom || 1));
    const zoomIn = h('button', { class: 'ed-tl-zoom', title: 'Zoom in', onclick: () => this.setZoom(this.zoom * 1.25) }, '+');
    const zoomOut = h('button', { class: 'ed-tl-zoom', title: 'Zoom out', onclick: () => this.setZoom(this.zoom / 1.25) }, '−');
    this.el = h('div', { class: 'ed-timeline' }, this.canvas, h('div', { class: 'ed-tl-buttons' }, zoomIn, zoomOut));
    this.bindInput();
  }

  setWaveform(peaks: Float32Array, durationMs: number): void {
    this.waveform = peaks;
    this.waveformDuration = durationMs;
  }

  setZoom(z: number): void {
    this.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
    this.editor.beatmap.timelineZoom = this.zoom;
  }

  private get pxPerMs(): number {
    return BASE_PX_PER_MS * this.zoom;
  }

  private timeAt(x: number, now: number): number {
    return now + (x - this.width / 2) / this.pxPerMs;
  }

  private xAt(time: number, now: number): number {
    return this.width / 2 + (time - now) * this.pxPerMs;
  }

  resize(): void {
    const r = this.el.getBoundingClientRect();
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.width = r.width;
    this.height = r.height;
    this.canvas.width = Math.max(1, Math.round(r.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * this.dpr));
  }

  // ---------------------------------------------------------------- input

  private drag: { kind: 'scrub'; startX: number; startTime: number } | { kind: 'move'; objects: ConvertHitObject[]; origin: number; startTimes: number[] } | { kind: 'end'; object: ConvertHitObject } | null = null;

  private objectRowY(): number {
    return this.height * 0.62;
  }

  private hitTest(x: number, y: number, now: number): { object: ConvertHitObject; part: 'body' | 'end' } | null {
    if (!this.opts.showObjects) return null;
    const rowY = this.objectRowY();
    const radius = Math.min(18, this.height * 0.22);
    if (Math.abs(y - rowY) > radius + 4) return null;
    const objects = this.editor.hitObjects;
    for (let i = objects.length - 1; i >= 0; i--) {
      const o = objects[i];
      const sx = this.xAt(o.startTime, now);
      const ex = this.xAt(o.endTime, now);
      if (o.hasDuration && Math.abs(x - ex) <= 8 && ex - sx > 12) return { object: o, part: 'end' };
      if (x >= sx - radius && x <= Math.max(ex, sx) + radius) return { object: o, part: 'body' };
    }
    return null;
  }

  private bindInput(): void {
    const c = this.canvas;
    c.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      const r = c.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      const now = this.clock.currentTime;
      const hit = this.hitTest(x, y, now);
      c.setPointerCapture(e.pointerId);
      if (hit) {
        const o = hit.object;
        if (e.ctrlKey || e.metaKey || e.shiftKey) this.editor.toggleSelected(o);
        else if (!this.editor.selected.has(o)) this.editor.select([o]);
        if (hit.part === 'end') {
          this.editor.beginChange();
          this.drag = { kind: 'end', object: o };
        } else {
          const objects = [...this.editor.selected];
          this.editor.beginChange();
          this.drag = { kind: 'move', objects, origin: this.timeAt(x, now), startTimes: objects.map(h => h.startTime) };
        }
        return;
      }
      if (!(e.ctrlKey || e.shiftKey)) this.editor.clearSelection();
      this.clock.stop();
      this.drag = { kind: 'scrub', startX: x, startTime: now };
    });
    c.addEventListener('pointermove', e => {
      const r = c.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      const d = this.drag;
      const now = this.clock.currentTime;
      if (!d) {
        const hit = this.hitTest(x, y, now);
        c.style.cursor = hit ? (hit.part === 'end' ? 'ew-resize' : 'pointer') : 'grab';
        return;
      }
      if (d.kind === 'scrub') {
        this.clock.seek(d.startTime - (x - d.startX) / this.pxPerMs);
        this.opts.onSeek?.();
      } else if (d.kind === 'move') {
        // TimelineBlueprintContainer: moves the selection by a snapped time delta.
        const first = Math.min(...d.startTimes);
        const target = this.editor.snapTime(first + (this.timeAt(x, now) - d.origin));
        const delta = target - first;
        d.objects.forEach((o, i) => (o.startTime = Math.max(0, d.startTimes[i] + delta)));
        this.editor.updateObjects();
        this.editor.emit('objects');
      } else {
        // TimelineHitObjectBlueprint drag handle.
        const o = d.object;
        const t = this.editor.snapTime(this.timeAt(x, now), o.startTime);
        if (o.kind === 'slider') {
          const span = o.duration / o.spanCount;
          const spans = Math.max(1, Math.round((t - o.startTime) / span));
          if (spans !== o.spanCount) {
            o.repeatCount = spans - 1;
            while (o.nodeSamples.length < spans + 1) o.nodeSamples.push(o.samples.map(s => s));
            o.nodeSamples.length = spans + 1;
          }
        } else {
          o.duration = Math.max(this.editor.beatSnapLength(o.startTime), t - o.startTime);
        }
        this.editor.updateObjects();
        this.editor.emit('objects');
      }
    });
    const end = () => {
      if (this.drag && this.drag.kind !== 'scrub') this.editor.change(() => {});
      if (this.drag && this.drag.kind !== 'scrub') this.editor.endChange();
      this.drag = null;
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener(
      'wheel',
      e => {
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          e.stopPropagation();
          this.setZoom(this.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
        }
      },
      { passive: false },
    );
  }

  // ---------------------------------------------------------------- drawing

  draw(): void {
    const g = this.g;
    const w = this.width;
    const hgt = this.height;
    if (w <= 0) return;
    const now = this.clock.currentTime;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, w, hgt);
    g.fillStyle = 'rgba(0,0,0,0.35)';
    g.fillRect(0, 0, w, hgt);

    const t0 = this.timeAt(0, now);
    const t1 = this.timeAt(w, now);
    const b = this.editor.beatmap;

    // Breaks (TimelineBreak)
    for (const br of b.breaks) {
      if (br.endTime < t0 || br.startTime > t1) continue;
      const x0 = this.xAt(br.startTime, now);
      const x1 = this.xAt(br.endTime, now);
      g.fillStyle = 'rgba(255,255,255,0.08)';
      g.fillRect(x0, 0, x1 - x0, hgt);
      g.fillStyle = 'rgba(255,255,255,0.5)';
      g.font = `600 11px ${getComputedStyle(document.body).fontFamily}`;
      g.fillText('break', x0 + 4, 12);
    }

    // Kiai (effect points)
    const eps = b.controlPoints.effectPoints;
    for (let i = 0; i < eps.length; i++) {
      if (!eps[i].kiaiMode) continue;
      const end = eps.slice(i + 1).find(p => !p.kiaiMode)?.time ?? Infinity;
      const x0 = Math.max(0, this.xAt(eps[i].time, now));
      const x1 = Math.min(w, this.xAt(end, now));
      if (x1 > x0) {
        g.fillStyle = 'rgba(255,153,0,0.12)';
        g.fillRect(x0, 0, x1 - x0, 4);
      }
    }

    // Waveform (TimelineArea waveform, opacity from View → Waveform opacity)
    const waveOpacity = this.waveformOpacity;
    if (this.waveform && waveOpacity > 0) {
      const peaks = this.waveform;
      const perMs = peaks.length / this.waveformDuration;
      g.fillStyle = `rgba(100,140,255,${0.55 * waveOpacity})`;
      const mid = hgt / 2;
      for (let x = 0; x < w; x += 2) {
        const t = this.timeAt(x, now);
        if (t < 0 || t > this.waveformDuration) continue;
        const v = peaks[Math.min(peaks.length - 1, Math.floor(t * perMs))] ?? 0;
        const amp = v * hgt * 0.45;
        g.fillRect(x, mid - amp, 2, amp * 2);
      }
    }

    // Ticks (TimelineTickDisplay)
    if (this.showTicks) {
      const divisor = this.editor.beatDivisor;
      const tps = b.controlPoints.timingPoints.length ? b.controlPoints.timingPoints : [b.controlPoints.timingPointAt(0)];
      for (let i = 0; i < tps.length; i++) {
        const tp = tps[i];
        const segEnd = tps[i + 1]?.time ?? Infinity;
        const step = tp.beatLength / divisor;
        if (step * this.pxPerMs < 2) continue;
        let k = Math.max(0, Math.floor((Math.max(t0, tp.time) - tp.time) / step));
        for (; ; k++) {
          const t = tp.time + k * step;
          if (t > Math.min(t1, segEnd - 1)) break;
          const d = EditorBeatmap.divisorForBeatIndex(k, divisor);
          const isBar = k % (divisor * tp.timeSignature) === 0;
          const size = isBar ? 1 : d === 1 ? 0.7 : d === 2 ? 0.55 : d <= 4 ? 0.45 : 0.35;
          const [r, gg, bb] = beatDivisorColour(d);
          const x = Math.round(this.xAt(t, now)) + 0.5;
          g.fillStyle = `rgb(${r},${gg},${bb})`;
          const len = (hgt * size) / 2;
          g.fillRect(x - (isBar ? 1 : 0.5), 0, isBar ? 2 : 1, len);
          g.fillRect(x - (isBar ? 1 : 0.5), hgt - len, isBar ? 2 : 1, len);
        }
      }
    }

    // Timing changes (TimelineTimingChangeDisplay)
    if (this.showTimingChanges) {
      g.font = `700 11px ${getComputedStyle(document.body).fontFamily}`;
      for (const tp of b.controlPoints.timingPoints) {
        if (tp.time < t0 - 100 || tp.time > t1) continue;
        const x = this.xAt(tp.time, now);
        g.fillStyle = '#ff6060';
        g.fillRect(x - 1, 0, 2, hgt);
        const label = `${Math.round(tp.bpm * 100) / 100}bpm`;
        g.fillStyle = 'rgba(0,0,0,0.6)';
        g.fillRect(x + 2, 2, g.measureText(label).width + 8, 15);
        g.fillStyle = '#ff9a9a';
        g.fillText(label, x + 6, 13);
      }
    }

    // Bookmarks / preview point
    for (const bm of b.bookmarks) {
      if (bm < t0 || bm > t1) continue;
      g.fillStyle = '#4a9eff';
      g.fillRect(this.xAt(bm, now) - 1, hgt - 10, 2, 10);
    }
    if (b.metadata.previewTime >= 0 && b.metadata.previewTime >= t0 && b.metadata.previewTime <= t1) {
      g.fillStyle = '#88ff66';
      g.fillRect(this.xAt(b.metadata.previewTime, now) - 1, 0, 2, hgt);
    }

    // Hit objects (TimelineHitObjectBlueprint)
    if (this.opts.showObjects) this.drawObjects(now, t0, t1);

    // CentreMarker
    const cx = Math.round(w / 2);
    g.fillStyle = '#ff3355';
    g.fillRect(cx - 1, 0, 2, hgt);
    g.beginPath();
    g.moveTo(cx - 7, 0);
    g.lineTo(cx + 7, 0);
    g.lineTo(cx, 8);
    g.closePath();
    g.fill();
    g.beginPath();
    g.moveTo(cx - 7, hgt);
    g.lineTo(cx + 7, hgt);
    g.lineTo(cx, hgt - 8);
    g.closePath();
    g.fill();
  }

  private drawObjects(now: number, t0: number, t1: number): void {
    const g = this.g;
    const rowY = this.objectRowY();
    const radius = Math.min(18, this.height * 0.22);
    const objects = this.editor.hitObjects;
    const font = getComputedStyle(document.body).fontFamily;
    for (let i = 0; i < objects.length; i++) {
      const o = objects[i];
      if (o.endTime < t0 - 200 || o.startTime > t1 + 200) continue;
      const sx = this.xAt(o.startTime, now);
      const ex = this.xAt(o.endTime, now);
      const combo = this.editor.comboInfo(o);
      const [r, gg, bb] = comboColour(this.editor.beatmap, combo.comboIndex);
      const colour = `rgb(${r},${gg},${bb})`;
      const selected = this.editor.selected.has(o);
      if (o.hasDuration && ex > sx) {
        // Duration body
        g.fillStyle = `rgba(${r},${gg},${bb},0.6)`;
        g.beginPath();
        g.roundRect(sx, rowY - radius, ex - sx, radius * 2, radius);
        g.fill();
        if (o.kind === 'slider') {
          // Repeat points
          for (let s = 1; s < o.spanCount; s++) {
            const rx = this.xAt(o.startTime + (s * o.duration) / o.spanCount, now);
            g.strokeStyle = '#fff';
            g.lineWidth = 2;
            g.beginPath();
            g.arc(rx, rowY, radius * 0.45, 0, Math.PI * 2);
            g.stroke();
          }
        }
        g.fillStyle = colour;
        g.beginPath();
        g.arc(ex, rowY, radius * 0.75, 0, Math.PI * 2);
        g.fill();
      }
      g.fillStyle = colour;
      g.beginPath();
      g.arc(sx, rowY, radius, 0, Math.PI * 2);
      g.fill();
      g.lineWidth = 3;
      g.strokeStyle = selected ? '#ffcc22' : '#fff';
      g.stroke();
      if (selected && o.hasDuration) {
        g.strokeStyle = '#ffcc22';
        g.lineWidth = 2;
        g.beginPath();
        g.roundRect(sx - radius, rowY - radius - 3, ex - sx + radius * 2, radius * 2 + 6, radius + 3);
        g.stroke();
      }
      if (o.kind !== 'spinner') {
        g.fillStyle = '#fff';
        g.font = `700 ${Math.round(radius * 0.9)}px ${font}`;
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText(String(combo.indexInCombo + 1), sx, rowY + 1);
        g.textAlign = 'start';
        g.textBaseline = 'alphabetic';
      }
    }
  }

  get waveformOpacity(): number {
    return this.viewSettings().waveformOpacity;
  }

  get showTicks(): boolean {
    return this.viewSettings().showTicks;
  }

  get showTimingChanges(): boolean {
    return this.viewSettings().showTimingChanges;
  }

  viewSettings: () => { waveformOpacity: number; showTicks: boolean; showTimingChanges: boolean } = () => ({ waveformOpacity: 0.25, showTicks: true, showTimingChanges: true });
}

/** Waveform peaks (one value per bucket of `bucketMs`) from a decoded audio buffer. */
export function computeWaveform(buffer: AudioBuffer, bucketMs = 5): Float32Array {
  const channel = buffer.getChannelData(0);
  const perBucket = Math.max(1, Math.floor((buffer.sampleRate * bucketMs) / 1000));
  const out = new Float32Array(Math.ceil(channel.length / perBucket));
  for (let i = 0; i < out.length; i++) {
    let peak = 0;
    const start = i * perBucket;
    const end = Math.min(channel.length, start + perBucket);
    for (let j = start; j < end; j += 4) {
      const v = Math.abs(channel[j]);
      if (v > peak) peak = v;
    }
    out[i] = peak;
  }
  return out;
}
