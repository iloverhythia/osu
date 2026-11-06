// Port of osu.Game/Screens/Edit/Components/Timelines/Summary/SummaryTimeline.cs and its parts: the whole track at a
// glance with control points (timing red, kiai orange), breaks, bookmarks, the preview point and the current position
// marker (MarkerPart). Clicking or dragging seeks.

import { h } from '../dom';
import type { EditorBeatmap } from './EditorBeatmap';
import type { EditorClock } from './EditorClock';

export class SummaryTimeline {
  readonly el: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D;
  private dpr = 1;
  private width = 0;
  private height = 0;

  constructor(
    private readonly editor: EditorBeatmap,
    private readonly clock: EditorClock,
  ) {
    this.canvas = h('canvas', { class: 'ed-summary-canvas' });
    this.g = this.canvas.getContext('2d')!;
    this.el = h('div', { class: 'ed-summary' }, this.canvas);
    let dragging = false;
    const seek = (e: PointerEvent) => {
      const r = this.canvas.getBoundingClientRect();
      const p = Math.max(0, Math.min(1, (e.clientX - r.left - 10) / (r.width - 20)));
      this.clock.seek(p * this.clock.trackLengthMs);
    };
    this.canvas.addEventListener('pointerdown', e => {
      dragging = true;
      this.canvas.setPointerCapture(e.pointerId);
      seek(e);
    });
    this.canvas.addEventListener('pointermove', e => dragging && seek(e));
    this.canvas.addEventListener('pointerup', () => (dragging = false));
  }

  resize(): void {
    const r = this.el.getBoundingClientRect();
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.width = r.width;
    this.height = r.height;
    this.canvas.width = Math.max(1, Math.round(r.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * this.dpr));
  }

  draw(): void {
    const g = this.g;
    const w = this.width;
    const hgt = this.height;
    if (w <= 0) return;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, w, hgt);
    const len = this.clock.trackLengthMs || 1;
    const x = (t: number) => 10 + (t / len) * (w - 20);
    const b = this.editor.beatmap;
    const mid = hgt / 2;

    // Centre line
    g.fillStyle = 'rgba(255,255,255,0.3)';
    g.fillRect(10, mid - 0.5, w - 20, 1);

    // BreakPart
    for (const br of b.breaks) {
      g.fillStyle = 'rgba(255,255,255,0.25)';
      g.fillRect(x(br.startTime), mid - 4, Math.max(1, x(br.endTime) - x(br.startTime)), 8);
    }
    // Hit object density (lazer shows objects in the timing summary area as a light strip).
    g.fillStyle = 'rgba(255,255,255,0.45)';
    for (const o of this.editor.hitObjects) g.fillRect(x(o.startTime), mid + 6, Math.max(1, x(o.endTime) - x(o.startTime)), 3);

    // ControlPointPart: timing points (red), kiai (orange)
    for (const tp of b.controlPoints.timingPoints) {
      g.fillStyle = '#ff3355';
      g.fillRect(x(tp.time) - 1, 4, 2, mid - 6);
    }
    const eps = b.controlPoints.effectPoints;
    for (let i = 0; i < eps.length; i++) {
      if (!eps[i].kiaiMode) continue;
      const end = eps.slice(i + 1).find(p => !p.kiaiMode)?.time ?? len;
      g.fillStyle = 'rgba(255,153,0,0.8)';
      g.fillRect(x(eps[i].time), mid - 7, Math.max(1, x(end) - x(eps[i].time)), 3);
    }
    // BookmarkPart
    g.fillStyle = '#4a9eff';
    for (const bm of b.bookmarks) g.fillRect(x(bm) - 1, mid + 2, 2, mid - 4);
    // PreviewTimePart
    if (b.metadata.previewTime >= 0) {
      g.fillStyle = '#88ff66';
      g.fillRect(x(b.metadata.previewTime) - 1, 2, 2, hgt - 4);
    }

    // MarkerPart
    const mx = x(this.clock.currentTime);
    g.fillStyle = '#ff3355';
    g.fillRect(mx - 1, 0, 2, hgt);
    g.beginPath();
    g.moveTo(mx - 6, 0);
    g.lineTo(mx + 6, 0);
    g.lineTo(mx, 7);
    g.closePath();
    g.fill();
  }
}
