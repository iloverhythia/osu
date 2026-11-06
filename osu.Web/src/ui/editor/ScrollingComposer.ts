// Composers for the scrolling rulesets (ports of ManiaHitObjectComposer, TaikoHitObjectComposer and
// CatchHitObjectComposer): the playfield scrolls with the editor clock and placement maps the pointer position to a
// beat-snapped time (and a column / x position). Tools: mania Note / Hold; taiko Hit / Drum roll / Swell (kat via
// whistle or clap, strong via finish); catch Fruit / Juice stream / Banana shower.

import { HIT_CLAP, HIT_FINISH, HIT_WHISTLE } from '../../game/audio/HitSampleInfo';
import type { ConvertHitObject } from '../../game/beatmaps/Beatmap';
import { PathTypes, SliderPath } from '../../game/objects/SliderPath';
import { h } from '../dom';
import type { Composer, ComposerHost } from './Composer';
import { beatSnapControl, inspector, sampleToolboxes, toolButton, toolbox, ternary, type SampleState } from './Toolbox';
import { comboColour } from './colours';

type Mode = 'mania' | 'taiko' | 'catch';
interface ToolDef {
  id: string;
  label: string;
  icon: string;
}

const TOOLS: Record<Mode, ToolDef[]> = {
  mania: [
    { id: 'select', label: 'Select', icon: 'select' },
    { id: 'note', label: 'Note', icon: 'circle' },
    { id: 'hold', label: 'Hold', icon: 'slider' },
  ],
  taiko: [
    { id: 'select', label: 'Select', icon: 'select' },
    { id: 'hit', label: 'Hit', icon: 'circle' },
    { id: 'drumroll', label: 'Drum Roll', icon: 'slider' },
    { id: 'swell', label: 'Swell', icon: 'spinner' },
  ],
  catch: [
    { id: 'select', label: 'Select', icon: 'select' },
    { id: 'fruit', label: 'Fruit', icon: 'circle' },
    { id: 'juice', label: 'JuiceStream', icon: 'slider' },
    { id: 'banana', label: 'BananaShower', icon: 'spinner' },
  ],
};

/** Visible time span of the playfield (ms) — the editor's fixed scroll speed. */
const SPAN = 1600;

export class ScrollingComposer implements Composer {
  readonly el: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D;
  private tool = 'select';
  private readonly toolButtons = new Map<string, HTMLElement>();
  private readonly samples: SampleState = { whistle: false, finish: false, clap: false, normalBank: null, additionBank: null };
  private newCombo = false;
  private dpr = 1;
  private width = 0;
  private height = 0;
  private readonly refreshers: (() => void)[] = [];
  private drag: { kind: 'place'; object: ConvertHitObject } | { kind: 'move'; startY: number; startX: number; origins: Map<ConvertHitObject, { time: number; x: number }> } | { kind: 'box'; x0: number; y0: number; x1: number; y1: number } | null = null;

  constructor(
    private readonly host: ComposerHost,
    private readonly mode: Mode,
  ) {
    const ed = host.editor;
    this.canvas = h('canvas', { class: 'ed-playfield-canvas' });
    this.g = this.canvas.getContext('2d')!;
    const tools = toolbox(
      'toolbox',
      TOOLS[mode].map((t, i) => {
        const b = toolButton(t.label, t.icon, `${i + 1}`, () => this.setTool(t.id));
        this.toolButtons.set(t.id, b);
        return b;
      }),
    );
    const boxes: HTMLElement[] = [tools];
    if (mode === 'catch') {
      const nc = ternary('New combo', 'Q', () => this.newCombo, () => {
        this.newCombo = !this.newCombo;
        this.refresh();
      });
      this.refreshers.push(nc.update);
      boxes.push(toolbox('toggles', [nc.el]));
    }
    const sampleBoxes = sampleToolboxes(ed, this.samples, () => this.refresh(), { toggleSample: n => host.toggleSampleOnSelection(n), setBank: (t, b) => host.setBankOnSelection(t, b) });
    this.refreshers.push(sampleBoxes.update);
    const snap = beatSnapControl(ed);
    const insp = inspector(host);
    this.refreshers.push(snap.update, insp.update);
    this.el = h('div', { class: 'ed-compose' }, h('div', { class: 'ed-toolbox-column left' }, ...boxes, ...sampleBoxes.els), h('div', { class: 'ed-playfield' }, this.canvas), h('div', { class: 'ed-toolbox-column right' }, snap.el, insp.el));
    this.bindInput();
    this.setTool('select');
  }

  refresh(): void {
    for (const r of this.refreshers) r();
  }

  private setTool(t: string): void {
    this.tool = t;
    for (const [k, b] of this.toolButtons) b.classList.toggle('active', k === t);
    this.refresh();
  }

  resize(): void {
    const r = this.canvas.parentElement!.getBoundingClientRect();
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.width = r.width;
    this.height = r.height;
    this.canvas.width = Math.max(1, Math.round(r.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * this.dpr));
  }

  // ---------------------------------------------------------------- geometry

  private get columns(): number {
    return Math.max(1, Math.round(this.host.editor.beatmap.difficulty.circleSize));
  }

  /** Playfield rectangle in canvas pixels. */
  private get area(): { x: number; y: number; w: number; h: number } {
    if (this.mode === 'mania') {
      const colW = Math.min(60, (this.width * 0.8) / this.columns);
      const w = colW * this.columns;
      return { x: (this.width - w) / 2, y: 0, w, h: this.height };
    }
    if (this.mode === 'taiko') {
      const hgt = Math.min(160, this.height * 0.35);
      return { x: 20, y: (this.height - hgt) / 2, w: this.width - 40, h: hgt };
    }
    const w = Math.min(this.width * 0.9, this.height * (512 / 384) * 0.9);
    return { x: (this.width - w) / 2, y: 0, w, h: this.height };
  }

  /** The judgement line position along the scrolling axis. */
  private get hitPosition(): number {
    const a = this.area;
    return this.mode === 'taiko' ? a.x + 80 : a.y + a.h - 60;
  }

  private get pxPerMs(): number {
    const a = this.area;
    return this.mode === 'taiko' ? (a.w - 80) / SPAN : (a.h - 60) / SPAN;
  }

  private timeToPos(t: number, now: number): number {
    return this.mode === 'taiko' ? this.hitPosition + (t - now) * this.pxPerMs : this.hitPosition - (t - now) * this.pxPerMs;
  }

  private posToTime(p: number, now: number): number {
    return this.mode === 'taiko' ? now + (p - this.hitPosition) / this.pxPerMs : now + (this.hitPosition - p) / this.pxPerMs;
  }

  private columnOf(o: ConvertHitObject): number {
    return Math.max(0, Math.min(this.columns - 1, Math.floor((o.x * this.columns) / 512)));
  }

  private columnX(col: number): number {
    return Math.floor(((col + 0.5) * 512) / this.columns);
  }

  private objectScreenX(o: ConvertHitObject): number {
    const a = this.area;
    if (this.mode === 'mania') return a.x + ((this.columnOf(o) + 0.5) * a.w) / this.columns;
    if (this.mode === 'catch') return a.x + (o.x / 512) * a.w;
    return 0;
  }

  // ---------------------------------------------------------------- input

  private bindInput(): void {
    const c = this.canvas;
    c.addEventListener('contextmenu', e => e.preventDefault());
    c.addEventListener('pointerdown', e => {
      const r = c.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      c.setPointerCapture(e.pointerId);
      this.onDown(x, y, e);
    });
    c.addEventListener('pointermove', e => {
      const r = c.getBoundingClientRect();
      this.onMove(e.clientX - r.left, e.clientY - r.top);
    });
    c.addEventListener('pointerup', () => this.onUp());
  }

  private hitTest(x: number, y: number, now: number): ConvertHitObject | null {
    const objects = this.host.editor.hitObjects;
    for (let i = objects.length - 1; i >= 0; i--) {
      const o = objects[i];
      if (this.mode === 'taiko') {
        const sx = this.timeToPos(o.startTime, now);
        const ex = this.timeToPos(o.endTime, now);
        const cy = this.area.y + this.area.h / 2;
        if (Math.abs(y - cy) < 40 && x >= sx - 30 && x <= ex + 30) return o;
      } else {
        const ox = this.objectScreenX(o);
        const sy = this.timeToPos(o.startTime, now);
        const ey = this.timeToPos(o.endTime, now);
        const half = this.mode === 'mania' ? this.area.w / this.columns / 2 : 24;
        if (o.kind === 'spinner' && this.mode === 'catch') {
          if (y <= sy + 10 && y >= ey - 10) return o;
          continue;
        }
        if (Math.abs(x - ox) <= half && y <= sy + 14 && y >= ey - 14) return o;
      }
    }
    return null;
  }

  private onDown(x: number, y: number, e: PointerEvent): void {
    const ed = this.host.editor;
    const now = this.host.clock.currentTime;
    const along = this.mode === 'taiko' ? x : y;
    const time = ed.snapTime(this.posToTime(along, now));
    if (this.tool === 'select') {
      const hit = this.hitTest(x, y, now);
      if (e.button === 2) {
        if (hit) ed.remove(hit);
        return;
      }
      if (hit) {
        if (e.ctrlKey || e.metaKey || e.shiftKey) ed.toggleSelected(hit);
        else if (!ed.selected.has(hit)) ed.select([hit]);
        ed.beginChange();
        this.drag = { kind: 'move', startX: x, startY: y, origins: new Map([...ed.selected].map(o => [o, { time: o.startTime, x: o.x }])) };
      } else {
        if (!(e.ctrlKey || e.shiftKey)) ed.clearSelection();
        this.drag = { kind: 'box', x0: x, y0: y, x1: x, y1: y };
      }
      return;
    }
    if (e.button !== 0) return;
    const samples = ed.createSamples(time, this.samples, { normal: this.samples.normalBank, addition: this.samples.additionBank });
    let o: ConvertHitObject;
    if (this.mode === 'mania') {
      const a = this.area;
      const col = Math.max(0, Math.min(this.columns - 1, Math.floor(((x - a.x) / a.w) * this.columns)));
      if (x < a.x || x > a.x + a.w) return;
      o = this.tool === 'hold' ? ed.createTimed('hold', time, time + ed.beatSnapLength(time), this.columnX(col), 192, false, samples) : ed.createCircle(time, this.columnX(col), 192, false, samples);
    } else if (this.mode === 'taiko') {
      if (this.tool === 'drumroll') {
        o = ed.createSlider(time, 256, 192, new SliderPath([{ position: { x: 0, y: 0 }, type: PathTypes.LINEAR }, { position: { x: 100, y: 0 }, type: null }]), false, samples);
      } else if (this.tool === 'swell') o = ed.createTimed('spinner', time, time + ed.beatSnapLength(time) * 4, 256, 192, false, samples);
      else o = ed.createCircle(time, 256, 192, false, samples);
    } else {
      const a = this.area;
      const px = Math.max(0, Math.min(512, ((x - a.x) / a.w) * 512));
      if (this.tool === 'banana') o = ed.createTimed('spinner', time, time + ed.beatSnapLength(time) * 4, 256, 192, true, samples);
      else if (this.tool === 'juice')
        o = ed.createSlider(time, px, 192, new SliderPath([{ position: { x: 0, y: 0 }, type: PathTypes.LINEAR }, { position: { x: 0, y: -100 }, type: null }]), this.newCombo, samples);
      else o = ed.createCircle(time, px, 192, this.newCombo, samples);
      this.newCombo = false;
    }
    ed.beginChange();
    ed.hitObjects.push(o);
    ed.updateObjects();
    ed.emit('objects');
    this.drag = { kind: 'place', object: o };
  }

  private onMove(x: number, y: number): void {
    const d = this.drag;
    if (!d) return;
    const ed = this.host.editor;
    const now = this.host.clock.currentTime;
    if (d.kind === 'place') {
      // Dragging while placing sets the duration (HoldNotePlacementBlueprint, DrumRollPlacementBlueprint…).
      const o = d.object;
      const t = ed.snapTime(this.posToTime(this.mode === 'taiko' ? x : y, now));
      if (o.kind === 'hold' || o.kind === 'spinner') o.duration = Math.max(ed.beatSnapLength(o.startTime), t - o.startTime);
      else if (o.kind === 'slider') {
        const duration = Math.max(ed.beatSnapLength(o.startTime), t - o.startTime);
        const length = duration * o.velocity;
        if (this.mode === 'catch') {
          const a = this.area;
          const px = Math.max(0, Math.min(512, ((x - a.x) / a.w) * 512));
          o.path.controlPoints[1].position = { x: px - o.x, y: -length };
        } else o.path.controlPoints[1].position = { x: length, y: 0 };
        o.path.expectedDistance = Math.hypot(o.path.controlPoints[1].position.x, o.path.controlPoints[1].position.y);
        o.path.invalidate();
        ed.snapSliderLength(o);
      }
      ed.emit('objects');
    } else if (d.kind === 'move') {
      const along = this.mode === 'taiko' ? x - d.startX : -(y - d.startY);
      const first = Math.min(...[...d.origins.values()].map(v => v.time));
      const delta = ed.snapTime(first + along / this.pxPerMs) - first;
      const a = this.area;
      for (const [o, origin] of d.origins) {
        o.startTime = Math.max(0, origin.time + delta);
        if (this.mode === 'mania') {
          const shift = Math.round(((x - d.startX) / a.w) * this.columns);
          const col = Math.max(0, Math.min(this.columns - 1, Math.floor((origin.x * this.columns) / 512) + shift));
          o.x = this.columnX(col);
        } else if (this.mode === 'catch' && o.kind !== 'spinner') o.x = Math.max(0, Math.min(512, origin.x + ((x - d.startX) / a.w) * 512));
      }
      ed.updateObjects();
      ed.emit('objects');
    } else {
      d.x1 = x;
      d.y1 = y;
      const sel = ed.hitObjects.filter(o => {
        const ox = this.mode === 'taiko' ? this.timeToPos(o.startTime, now) : this.objectScreenX(o);
        const oy = this.mode === 'taiko' ? this.area.y + this.area.h / 2 : this.timeToPos(o.startTime, now);
        return ox >= Math.min(d.x0, x) && ox <= Math.max(d.x0, x) && oy >= Math.min(d.y0, y) && oy <= Math.max(d.y0, y);
      });
      ed.select(sel);
    }
  }

  private onUp(): void {
    const d = this.drag;
    this.drag = null;
    if (!d || d.kind === 'box') return;
    this.host.editor.change(() => {});
    this.host.editor.endChange();
    if (d.kind === 'place' && this.host.view.autoSeekOnPlacement && !this.host.clock.isRunning) this.host.clock.seekBeat(1);
  }

  onKeyDown(e: KeyboardEvent): boolean {
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return false;
    const m = /^Digit([1-9])$/.exec(e.code);
    if (m) {
      const t = TOOLS[this.mode][Number(m[1]) - 1];
      if (t) {
        this.setTool(t.id);
        return true;
      }
    }
    if (e.code === 'Escape' && this.tool !== 'select') {
      this.setTool('select');
      return true;
    }
    if (e.code === 'Escape' && this.host.editor.selected.size) {
      this.host.editor.clearSelection();
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- drawing

  draw(now: number): void {
    const g = this.g;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, this.width, this.height);
    const a = this.area;
    const ed = this.host.editor;
    g.fillStyle = 'rgba(0,0,0,0.45)';
    g.fillRect(a.x, a.y, a.w, a.h);

    // Beat lines (BeatSnapGrid)
    const cp = ed.beatmap.controlPoints;
    const tp = cp.timingPointAt(now);
    const step = tp.beatLength / ed.beatDivisor;
    const tStart = now - (this.mode === 'taiko' ? 80 / this.pxPerMs : 60 / this.pxPerMs);
    const tEnd = now + SPAN;
    let k = Math.ceil((tStart - tp.time) / step);
    for (; ; k++) {
      const t = tp.time + k * step;
      if (t > tEnd) break;
      const isBeat = k % ed.beatDivisor === 0;
      g.fillStyle = isBeat ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.12)';
      const p = this.timeToPos(t, now);
      if (this.mode === 'taiko') g.fillRect(p, a.y, isBeat ? 2 : 1, a.h);
      else g.fillRect(a.x, p, a.w, isBeat ? 2 : 1);
    }

    // Columns / judgement line
    g.fillStyle = 'rgba(255,255,255,0.15)';
    if (this.mode === 'mania') for (let c = 1; c < this.columns; c++) g.fillRect(a.x + (c * a.w) / this.columns, a.y, 1, a.h);
    g.fillStyle = '#ffffff';
    if (this.mode === 'taiko') {
      g.globalAlpha = 0.6;
      g.beginPath();
      g.arc(this.hitPosition, a.y + a.h / 2, 32, 0, Math.PI * 2);
      g.strokeStyle = '#fff';
      g.lineWidth = 3;
      g.stroke();
      g.globalAlpha = 1;
    } else g.fillRect(a.x, this.hitPosition, a.w, 3);

    for (const o of ed.hitObjects) {
      if (o.endTime < tStart - 200 || o.startTime > tEnd + 200) continue;
      this.drawObject(o, now, ed.selected.has(o));
    }

    if (this.drag?.kind === 'box') {
      const d = this.drag;
      g.strokeStyle = '#fff';
      g.fillStyle = 'rgba(255,255,255,0.1)';
      g.fillRect(Math.min(d.x0, d.x1), Math.min(d.y0, d.y1), Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
      g.strokeRect(Math.min(d.x0, d.x1), Math.min(d.y0, d.y1), Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
    }
  }

  private drawObject(o: ConvertHitObject, now: number, selected: boolean): void {
    const g = this.g;
    const a = this.area;
    const ed = this.host.editor;
    const outline = () => {
      g.strokeStyle = '#ffcc22';
      g.lineWidth = 3;
      g.stroke();
    };
    if (this.mode === 'mania') {
      const colW = a.w / this.columns;
      const x = a.x + this.columnOf(o) * colW + 2;
      const sy = this.timeToPos(o.startTime, now);
      const colour = this.columnOf(o) % 2 === 0 ? '#e4e4e4' : '#5cc2ff';
      if (o.kind === 'hold') {
        const ey = this.timeToPos(o.endTime, now);
        g.fillStyle = 'rgba(255,255,255,0.35)';
        g.fillRect(x + colW * 0.15, ey, colW * 0.7 - 4, sy - ey);
        g.fillStyle = colour;
        g.fillRect(x, ey - 6, colW - 4, 12);
      }
      g.fillStyle = colour;
      g.beginPath();
      g.roundRect(x, sy - 8, colW - 4, 16, 4);
      g.fill();
      if (selected) outline();
      return;
    }
    if (this.mode === 'taiko') {
      const cy = a.y + a.h / 2;
      const sx = this.timeToPos(o.startTime, now);
      const strong = o.samples.some(s => s.name === HIT_FINISH);
      const r = strong ? 34 : 24;
      if (o.kind === 'slider') {
        const ex = this.timeToPos(o.endTime, now);
        g.fillStyle = '#fcb806';
        g.beginPath();
        g.roundRect(sx, cy - r, ex - sx, r * 2, r);
        g.fill();
        if (selected) outline();
      } else if (o.kind === 'spinner') {
        g.fillStyle = '#f5a623';
        g.beginPath();
        g.arc(sx, cy, r, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = '#fff';
        g.font = `700 11px ${getComputedStyle(document.body).fontFamily}`;
        g.textAlign = 'center';
        g.fillText('swell', sx, cy + 4);
        g.textAlign = 'start';
        if (selected) outline();
        return;
      }
      const kat = o.samples.some(s => s.name === HIT_WHISTLE || s.name === HIT_CLAP);
      g.fillStyle = o.kind === 'slider' ? '#fcb806' : kat ? '#438eac' : '#eb452c';
      g.beginPath();
      g.arc(sx, cy, r, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = '#fff';
      g.lineWidth = 4;
      g.stroke();
      if (selected) {
        g.beginPath();
        g.arc(sx, cy, r + 5, 0, Math.PI * 2);
        outline();
      }
      return;
    }
    // catch
    const sy = this.timeToPos(o.startTime, now);
    if (o.kind === 'spinner') {
      const ey = this.timeToPos(o.endTime, now);
      g.fillStyle = 'rgba(255,240,0,0.25)';
      g.fillRect(a.x, ey, a.w, sy - ey);
      g.fillStyle = '#ffe600';
      g.font = `700 13px ${getComputedStyle(document.body).fontFamily}`;
      g.fillText('banana shower', a.x + 8, sy - 6);
      if (selected) {
        g.beginPath();
        g.rect(a.x, ey, a.w, sy - ey);
        outline();
      }
      return;
    }
    const x = this.objectScreenX(o);
    const [r0, g0, b0] = comboColour(ed.beatmap, ed.comboInfo(o).comboIndex);
    const colour = `rgb(${r0},${g0},${b0})`;
    if (o.kind === 'slider') {
      const pts = o.path.path;
      g.strokeStyle = colour;
      g.lineWidth = 6;
      g.beginPath();
      for (let i = 0; i < pts.length; i++) {
        const px = a.x + ((o.x + pts[i].x) / 512) * a.w;
        const t = o.startTime + (i / Math.max(1, pts.length - 1)) * (o.duration / o.spanCount);
        const py = this.timeToPos(t, now);
        if (i === 0) g.moveTo(px, py);
        else g.lineTo(px, py);
      }
      g.stroke();
    }
    g.fillStyle = colour;
    g.beginPath();
    g.arc(x, sy, 18, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = '#fff';
    g.lineWidth = 3;
    g.stroke();
    if (selected) {
      g.beginPath();
      g.arc(x, sy, 23, 0, Math.PI * 2);
      outline();
    }
  }

  dispose(): void {}
}
