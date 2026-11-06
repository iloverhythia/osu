// Port of osu.Game.Rulesets.Osu/Edit/OsuHitObjectComposer.cs over osu.Game/Rulesets/Edit/HitObjectComposer.cs:
// left toolbox (tools: Select, HitCircle, Slider, Spinner; toggles: new combo, grid snap; samples / banks), right
// toolbox (beat snap, inspector, grid), and the playfield with placement blueprints (HitCirclePlacementBlueprint,
// SliderPlacementBlueprint, SpinnerPlacementBlueprint) and selection blueprints (drag box, moving, slider control
// point editing, OsuSelectionHandler flip / rotate). Objects are drawn with the gameplay Argon pieces.

import { ConvertHitObject } from '../../game/beatmaps/Beatmap';
import { difficultyRange } from '../../game/beatmaps/Difficulty';
import { PathTypes, SliderPath, type PathControlPoint, type PathType } from '../../game/objects/SliderPath';
import { drawApproachCircle, drawMainCirclePiece, drawReverseArrow, renderArgonSliderPath, ARGON_PATH_RADIUS } from '../../game/rulesets/osu/argon';
import { calculateScaleFromCircleSize } from '../../game/rulesets/osu/objects';
import { fromRgb } from '../../game/rulesets/osu/transforms';
import { h } from '../dom';
import { showContextMenu, type MenuItem } from '../select/Components';
import type { Composer, ComposerHost } from './Composer';
import { beatSnapControl, inspector, sampleToolboxes, toolButton, toolbox, ternary, type SampleState } from './Toolbox';
import { comboColour } from './colours';

const PLAYFIELD_W = 512;
const PLAYFIELD_H = 384;
const GRID_SIZES = [4, 8, 16, 32];

type Tool = 'select' | 'circle' | 'slider' | 'spinner';

interface Vec {
  x: number;
  y: number;
}

export class OsuComposer implements Composer {
  readonly el: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D;
  private readonly scratch: HTMLCanvasElement;
  private tool: Tool = 'select';
  private readonly toolButtons = new Map<Tool, HTMLElement>();
  private newCombo: boolean | null = false;
  private gridSnap = false;
  private readonly samples: SampleState;
  private dpr = 1;
  private width = 0;
  private height = 0;
  /** Playfield → screen transform. */
  private scale = 1;
  private ox = 0;
  private oy = 0;
  private mouse: Vec | null = null;
  private placement: { kind: 'slider'; time: number; points: Vec[]; newCombo: boolean } | { kind: 'spinner'; time: number; newCombo: boolean } | null = null;
  private drag:
    | { kind: 'box'; from: Vec; to: Vec; additive: boolean }
    | { kind: 'move'; from: Vec; origins: Map<ConvertHitObject, Vec> }
    | { kind: 'cp'; slider: ConvertHitObject; index: number; from: Vec; original: Vec[]; head: Vec }
    | null = null;
  private readonly refreshers: (() => void)[] = [];

  constructor(private readonly host: ComposerHost) {
    const ed = host.editor;
    this.canvas = h('canvas', { class: 'ed-playfield-canvas' });
    this.g = this.canvas.getContext('2d')!;
    this.scratch = document.createElement('canvas');
    this.samples = { whistle: false, finish: false, clap: false, normalBank: null, additionBank: null };

    const tools: [Tool, string, string][] = [
      ['select', 'Select', 'select'],
      ['circle', 'HitCircle', 'circle'],
      ['slider', 'Slider', 'slider'],
      ['spinner', 'Spinner', 'spinner'],
    ];
    const toolsBox = toolbox(
      'toolbox',
      tools.map(([t, label, icon], i) => {
        const b = toolButton(label, icon, `${i + 1}`, () => this.setTool(t));
        this.toolButtons.set(t, b);
        return b;
      }),
    );
    const ncToggle = ternary('New combo', 'Q', () => this.newComboState(), () => this.toggleNewCombo());
    const gridToggle = ternary('Grid snap', 'Y', () => this.gridSnap, () => {
      this.gridSnap = !this.gridSnap;
      this.refresh();
    });
    const togglesBox = toolbox('toggles', [ncToggle.el, gridToggle.el]);
    this.refreshers.push(ncToggle.update, gridToggle.update);
    const sampleBoxes = sampleToolboxes(ed, this.samples, () => this.refresh(), { toggleSample: n => host.toggleSampleOnSelection(n), setBank: (t, b) => host.setBankOnSelection(t, b) });
    this.refreshers.push(sampleBoxes.update);

    const snap = beatSnapControl(ed);
    const insp = inspector(host);
    const gridBox = toolbox('grid', [
      h(
        'div',
        { class: 'ed-grid-sizes' },
        ...GRID_SIZES.map(s =>
          h(
            'button',
            {
              class: 'ed-chip',
              'data-size': String(s),
              onclick: () => {
                host.editor.beatmap.gridSize = s;
                this.refresh();
              },
            },
            String(s),
          ),
        ),
      ),
    ]);
    this.refreshers.push(snap.update, insp.update, () => {
      for (const b of gridBox.querySelectorAll<HTMLElement>('.ed-chip')) b.classList.toggle('active', Number(b.dataset.size) === host.editor.beatmap.gridSize);
    });

    const left = h('div', { class: 'ed-toolbox-column left' }, toolsBox, togglesBox, ...sampleBoxes.els);
    const right = h('div', { class: 'ed-toolbox-column right' }, snap.el, insp.el, gridBox);
    this.el = h('div', { class: 'ed-compose' }, left, h('div', { class: 'ed-playfield' }, this.canvas), right);
    this.bindInput();
    this.setTool('select');
  }

  refresh(): void {
    for (const r of this.refreshers) r();
  }

  private setTool(t: Tool): void {
    this.placement = null;
    this.tool = t;
    for (const [k, b] of this.toolButtons) b.classList.toggle('active', k === t);
    if (t !== 'select') this.host.editor.clearSelection();
    this.refresh();
  }

  private newComboState(): boolean | null {
    const sel = [...this.host.editor.selected];
    if (sel.length === 0) return this.newCombo;
    const n = sel.filter(o => o.newCombo).length;
    return n === 0 ? false : n === sel.length ? true : null;
  }

  private toggleNewCombo(): void {
    const ed = this.host.editor;
    const sel = [...ed.selected];
    if (sel.length === 0) {
      this.newCombo = !this.newCombo;
    } else {
      const target = this.newComboState() !== true;
      ed.change(() => sel.forEach(o => (o.newCombo = target)));
    }
    this.refresh();
  }

  // ---------------------------------------------------------------- layout

  resize(): void {
    const r = this.canvas.parentElement!.getBoundingClientRect();
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.width = r.width;
    this.height = r.height;
    this.canvas.width = Math.max(1, Math.round(r.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * this.dpr));
    // OsuPlayfieldAdjustmentContainer: 4:3 playfield at 80% of the available height.
    this.scale = Math.min((r.width * 0.9) / PLAYFIELD_W, (r.height * 0.8) / PLAYFIELD_H);
    this.ox = (r.width - PLAYFIELD_W * this.scale) / 2;
    this.oy = (r.height - PLAYFIELD_H * this.scale) / 2;
    this.scratch.width = this.canvas.width;
    this.scratch.height = this.canvas.height;
    this.refresh();
  }

  private toPlayfield(clientX: number, clientY: number): Vec {
    const r = this.canvas.getBoundingClientRect();
    return { x: (clientX - r.left - this.ox) / this.scale, y: (clientY - r.top - this.oy) / this.scale };
  }

  private snapPosition(p: Vec): Vec {
    let { x, y } = p;
    if (this.gridSnap) {
      const s = this.host.editor.beatmap.gridSize || 32;
      x = Math.round(x / s) * s;
      y = Math.round(y / s) * s;
    }
    return { x: Math.max(0, Math.min(PLAYFIELD_W, x)), y: Math.max(0, Math.min(PLAYFIELD_H, y)) };
  }

  // ---------------------------------------------------------------- geometry

  private get circleRadius(): number {
    return 64 * calculateScaleFromCircleSize(this.host.editor.beatmap.difficulty.circleSize, true);
  }

  private get preempt(): number {
    return difficultyRange(this.host.editor.beatmap.difficulty.approachRate, 1800, 1200, 450);
  }

  private visible(now: number): ConvertHitObject[] {
    const preempt = this.preempt;
    return this.host.editor.hitObjects.filter(o => now >= o.startTime - preempt && now <= o.endTime + 700);
  }

  private sliderPoints(o: ConvertHitObject): Vec[] {
    return o.path.path.map(p => ({ x: o.x + p.x, y: o.y + p.y }));
  }

  private hitTest(p: Vec, now: number): ConvertHitObject | null {
    const r = this.circleRadius;
    const objects = this.visible(now);
    // Earliest objects are drawn on top.
    for (const o of objects) {
      if (Math.hypot(p.x - o.x, p.y - o.y) <= r) return o;
      if (o.kind === 'slider') {
        const pts = this.sliderPoints(o);
        for (let i = 1; i < pts.length; i++) if (distToSegment(p, pts[i - 1], pts[i]) <= r * 0.8) return o;
      }
      if (o.kind === 'spinner' && Math.hypot(p.x - 256, p.y - 192) <= 100) return o;
    }
    return null;
  }

  // ---------------------------------------------------------------- input

  private bindInput(): void {
    const c = this.canvas;
    c.addEventListener('contextmenu', e => e.preventDefault());
    c.addEventListener('pointerdown', e => this.onPointerDown(e));
    c.addEventListener('pointermove', e => {
      this.mouse = this.toPlayfield(e.clientX, e.clientY);
      this.onPointerMove(e);
    });
    c.addEventListener('pointerleave', () => (this.mouse = null));
    c.addEventListener('pointerup', () => this.onPointerUp());
    c.addEventListener('dblclick', () => {
      if (this.placement?.kind === 'slider') this.finishSlider();
    });
  }

  private onPointerDown(e: PointerEvent): void {
    const ed = this.host.editor;
    const clock = this.host.clock;
    const p = this.toPlayfield(e.clientX, e.clientY);
    const now = clock.currentTime;
    this.canvas.setPointerCapture(e.pointerId);

    if (this.tool === 'circle' && e.button === 0) {
      const pos = this.snapPosition(p);
      const time = ed.snapTime(now);
      const o = ed.createCircle(time, pos.x, pos.y, !!this.consumeNewCombo(), this.newSamples(time));
      ed.add(o);
      this.afterPlacement();
      return;
    }
    if (this.tool === 'slider') {
      if (e.button === 2) {
        if (this.placement?.kind === 'slider') this.finishSlider();
        return;
      }
      if (e.button !== 0) return;
      const pos = this.snapPosition(p);
      if (!this.placement || this.placement.kind !== 'slider') {
        this.placement = { kind: 'slider', time: ed.snapTime(now), points: [pos], newCombo: !!this.consumeNewCombo() };
      } else {
        const last = this.placement.points[this.placement.points.length - 1];
        if (Math.hypot(pos.x - last.x, pos.y - last.y) > 1) this.placement.points.push(pos);
      }
      return;
    }
    if (this.tool === 'spinner' && e.button === 0) {
      if (!this.placement || this.placement.kind !== 'spinner') {
        this.placement = { kind: 'spinner', time: ed.snapTime(now), newCombo: !!this.consumeNewCombo() };
      } else {
        const end = Math.max(this.placement.time, ed.snapTime(now));
        if (end > this.placement.time) {
          const t = this.placement.time;
          ed.add(ed.createTimed('spinner', t, end, 256, 192, true, this.newSamples(end)));
          this.placement = null;
        }
      }
      return;
    }
    if (this.tool !== 'select') return;

    // Slider control points of a single selected slider.
    const sel = [...ed.selected];
    if (sel.length === 1 && sel[0].kind === 'slider') {
      const s = sel[0];
      const cps = s.path.controlPoints;
      for (let i = 0; i < cps.length; i++) {
        const cp = { x: s.x + cps[i].position.x, y: s.y + cps[i].position.y };
        if (Math.hypot(p.x - cp.x, p.y - cp.y) <= 8 / this.scale + 4) {
          if (e.button === 2) {
            // PathControlPointVisualiser: right click → delete (keep at least two points).
            if (cps.length > 2) {
              ed.change(() => {
                if (i === 0) {
                  const shift = cps[1].position;
                  s.x += shift.x;
                  s.y += shift.y;
                  cps.splice(0, 1);
                  for (const q of cps) q.position = { x: q.position.x - shift.x, y: q.position.y - shift.y };
                  if (!cps[0].type) cps[0].type = PathTypes.BEZIER;
                } else cps.splice(i, 1);
                s.path.invalidate();
                ed.snapSliderLength(s);
              });
            }
            return;
          }
          ed.beginChange();
          this.drag = { kind: 'cp', slider: s, index: i, from: p, original: cps.map(q => ({ ...q.position })), head: { x: s.x, y: s.y } };
          return;
        }
      }
      // Ctrl+click on the path adds a control point.
      if ((e.ctrlKey || e.metaKey) && e.button === 0) {
        const pts = cps.map(q => ({ x: s.x + q.position.x, y: s.y + q.position.y }));
        let best = -1;
        let bestD = Infinity;
        for (let i = 1; i < pts.length; i++) {
          const d = distToSegment(p, pts[i - 1], pts[i]);
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        }
        if (best > 0 && bestD < this.circleRadius) {
          ed.change(() => {
            cps.splice(best, 0, { position: { x: p.x - s.x, y: p.y - s.y }, type: null });
            s.path.invalidate();
            ed.snapSliderLength(s);
          });
          return;
        }
      }
    }

    const hit = this.hitTest(p, now);
    if (e.button === 2) {
      if (hit && !ed.selected.has(hit)) ed.select([hit]);
      if (ed.selected.size > 0) this.openContextMenu(e.clientX, e.clientY);
      return;
    }
    if (hit) {
      if (e.ctrlKey || e.metaKey || e.shiftKey) ed.toggleSelected(hit);
      else if (!ed.selected.has(hit)) ed.select([hit]);
      if (ed.selected.has(hit)) {
        ed.beginChange();
        this.drag = { kind: 'move', from: p, origins: new Map([...ed.selected].map(o => [o, { x: o.x, y: o.y }])) };
      }
    } else {
      this.drag = { kind: 'box', from: p, to: p, additive: e.ctrlKey || e.metaKey || e.shiftKey };
      if (!this.drag.additive) ed.clearSelection();
    }
  }

  private onPointerMove(e: PointerEvent): void {
    const d = this.drag;
    if (!d) return;
    const ed = this.host.editor;
    const p = this.toPlayfield(e.clientX, e.clientY);
    if (d.kind === 'box') {
      d.to = p;
      const x0 = Math.min(d.from.x, p.x);
      const x1 = Math.max(d.from.x, p.x);
      const y0 = Math.min(d.from.y, p.y);
      const y1 = Math.max(d.from.y, p.y);
      const inBox = this.visible(this.host.clock.currentTime).filter(o => o.x >= x0 && o.x <= x1 && o.y >= y0 && o.y <= y1);
      ed.select(inBox, d.additive);
    } else if (d.kind === 'move') {
      // OsuSelectionHandler.HandleMovement: the whole selection stays within the playfield.
      let dx = p.x - d.from.x;
      let dy = p.y - d.from.y;
      if (this.gridSnap) {
        const first = d.origins.values().next().value!;
        const snapped = this.snapPosition({ x: first.x + dx, y: first.y + dy });
        dx = snapped.x - first.x;
        dy = snapped.y - first.y;
      }
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const [o, origin] of d.origins) {
        const pts = o.kind === 'slider' ? this.sliderPoints(o).map(q => ({ x: q.x - o.x + origin.x, y: q.y - o.y + origin.y })) : [origin];
        for (const q of pts) {
          minX = Math.min(minX, q.x);
          maxX = Math.max(maxX, q.x);
          minY = Math.min(minY, q.y);
          maxY = Math.max(maxY, q.y);
        }
      }
      dx = Math.max(-minX, Math.min(PLAYFIELD_W - maxX, dx));
      dy = Math.max(-minY, Math.min(PLAYFIELD_H - maxY, dy));
      for (const [o, origin] of d.origins) {
        if (o.kind === 'spinner') continue;
        o.x = origin.x + dx;
        o.y = origin.y + dy;
      }
      ed.emit('objects');
    } else if (d.kind === 'cp') {
      const s = d.slider;
      const cps = s.path.controlPoints;
      const pos = this.snapPosition(p);
      if (d.index === 0) {
        // Moving the head moves the slider and keeps the other points in place.
        const dx = pos.x - d.head.x;
        const dy = pos.y - d.head.y;
        s.x = d.head.x + dx;
        s.y = d.head.y + dy;
        cps.forEach((q, i) => (q.position = i === 0 ? { x: 0, y: 0 } : { x: d.original[i].x - dx, y: d.original[i].y - dy }));
      } else cps[d.index].position = { x: pos.x - s.x, y: pos.y - s.y };
      s.path.invalidate();
      ed.snapSliderLength(s);
      ed.emit('objects');
    }
  }

  private onPointerUp(): void {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    if (d.kind === 'move' || d.kind === 'cp') {
      this.host.editor.change(() => {});
      this.host.editor.endChange();
    }
  }

  private consumeNewCombo(): boolean {
    const v = !!this.newCombo;
    this.newCombo = false;
    this.refresh();
    return v;
  }

  private newSamples(time: number) {
    const s = this.samples;
    return this.host.editor.createSamples(time, s, { normal: s.normalBank, addition: s.additionBank });
  }

  private finishSlider(): void {
    const pl = this.placement;
    if (!pl || pl.kind !== 'slider') return;
    const pts = [...pl.points];
    if (this.mouse) {
      const m = this.snapPosition(this.mouse);
      const last = pts[pts.length - 1];
      if (Math.hypot(m.x - last.x, m.y - last.y) > 4 && pts.length < 2) pts.push(m);
    }
    this.placement = null;
    if (pts.length < 2) return;
    const ed = this.host.editor;
    const head = pts[0];
    const path = new SliderPath(pts.map((q, i) => ({ position: { x: q.x - head.x, y: q.y - head.y }, type: i === 0 ? autoPathType(pts.length) : null })));
    const o = ed.createSlider(pl.time, head.x, head.y, path, pl.newCombo, this.newSamples(pl.time));
    if (o.path.distance <= 0) return;
    ed.add(o);
    this.afterPlacement();
  }

  private afterPlacement(): void {
    // EditorAutoSeekOnPlacement: seek one beat-snap tick forward.
    if (this.host.view.autoSeekOnPlacement && !this.host.clock.isRunning) this.host.clock.seekBeat(1);
  }

  private openContextMenu(x: number, y: number): void {
    const ed = this.host.editor;
    const sel = [...ed.selected];
    const has = (name: string) => sel.every(o => o.samples.some(s => s.name === name));
    const toggleSample = (name: string) => this.host.toggleSampleOnSelection(name);
    const items: MenuItem[] = [
      { text: 'New combo', checked: this.newComboState() === true, action: () => this.toggleNewCombo() },
      {
        text: 'Sound',
        items: [
          { text: 'Whistle', checked: has('hitwhistle'), action: () => toggleSample('hitwhistle') },
          { text: 'Finish', checked: has('hitfinish'), action: () => toggleSample('hitfinish') },
          { text: 'Clap', checked: has('hitclap'), action: () => toggleSample('hitclap') },
        ],
      },
    ];
    if (sel.length === 1 && sel[0].kind === 'slider') {
      const s = sel[0];
      const setType = (t: PathType) =>
        ed.change(() => {
          for (const cp of s.path.controlPoints) cp.type = null;
          s.path.controlPoints[0].type = t;
          s.path.invalidate();
          ed.snapSliderLength(s);
        });
      items.push({
        text: 'Curve type',
        items: [
          { text: 'Bezier', action: () => setType(PathTypes.BEZIER) },
          { text: 'Perfect curve', action: () => setType(PathTypes.PERFECT_CURVE) },
          { text: 'Linear', action: () => setType(PathTypes.LINEAR) },
          { text: 'Catmull', action: () => setType(PathTypes.CATMULL) },
        ],
      });
    }
    items.push({ spacer: true, text: '' }, { text: 'Delete', type: 'destructive', action: () => ed.remove(...sel) });
    showContextMenu(x, y, items);
  }

  // ---------------------------------------------------------------- keys

  onKeyDown(e: KeyboardEvent): boolean {
    const ed = this.host.editor;
    const ctrl = e.ctrlKey || e.metaKey;
    if (!ctrl && !e.altKey && !e.shiftKey && /^Digit[1-4]$/.test(e.code)) {
      this.setTool((['select', 'circle', 'slider', 'spinner'] as Tool[])[Number(e.code.slice(5)) - 1]);
      return true;
    }
    if (!ctrl && !e.altKey && !e.shiftKey && e.code === 'KeyQ') {
      this.toggleNewCombo();
      return true;
    }
    if (!ctrl && !e.altKey && !e.shiftKey && e.code === 'KeyY') {
      this.gridSnap = !this.gridSnap;
      this.refresh();
      return true;
    }
    if (!ctrl && !e.altKey && !e.shiftKey && e.code === 'KeyG') {
      // EditorCycleGridSpacing
      const i = GRID_SIZES.indexOf(ed.beatmap.gridSize);
      ed.beatmap.gridSize = GRID_SIZES[(i + 1) % GRID_SIZES.length];
      this.refresh();
      return true;
    }
    if (e.code === 'Escape') {
      if (this.placement) {
        if (this.placement.kind === 'slider') this.finishSlider();
        this.placement = null;
        return true;
      }
      if (this.tool !== 'select') {
        this.setTool('select');
        return true;
      }
      if (ed.selected.size > 0) {
        ed.clearSelection();
        return true;
      }
      return false;
    }
    if (e.code === 'Enter' && this.placement?.kind === 'slider') {
      this.finishSlider();
      return true;
    }
    const sel = [...ed.selected].filter(o => o.kind !== 'spinner');
    if (ctrl && (e.code === 'KeyH' || e.code === 'KeyJ') && sel.length > 0) {
      // OsuSelectionHandler.HandleFlip (around the selection's centre).
      const horizontal = e.code === 'KeyH';
      const pts = sel.flatMap(o => (o.kind === 'slider' ? this.sliderPoints(o) : [{ x: o.x, y: o.y }]));
      const cx = (Math.min(...pts.map(q => q.x)) + Math.max(...pts.map(q => q.x))) / 2;
      const cy = (Math.min(...pts.map(q => q.y)) + Math.max(...pts.map(q => q.y))) / 2;
      ed.change(() => {
        for (const o of sel) {
          if (horizontal) o.x = 2 * cx - o.x;
          else o.y = 2 * cy - o.y;
          if (o.kind === 'slider') {
            for (const cp of o.path.controlPoints) cp.position = horizontal ? { x: -cp.position.x, y: cp.position.y } : { x: cp.position.x, y: -cp.position.y };
            o.path.invalidate();
          }
        }
      });
      return true;
    }
    if (ctrl && (e.code === 'Comma' || e.code === 'Period') && sel.length > 0) {
      // Rotate by 90° (EditorRotateSelection).
      const dir = e.code === 'Period' ? 1 : -1;
      const pts = sel.flatMap(o => (o.kind === 'slider' ? this.sliderPoints(o) : [{ x: o.x, y: o.y }]));
      const cx = (Math.min(...pts.map(q => q.x)) + Math.max(...pts.map(q => q.x))) / 2;
      const cy = (Math.min(...pts.map(q => q.y)) + Math.max(...pts.map(q => q.y))) / 2;
      const rot = (v: Vec): Vec => (dir > 0 ? { x: -v.y, y: v.x } : { x: v.y, y: -v.x });
      ed.change(() => {
        for (const o of sel) {
          const r = rot({ x: o.x - cx, y: o.y - cy });
          o.x = Math.max(0, Math.min(PLAYFIELD_W, cx + r.x));
          o.y = Math.max(0, Math.min(PLAYFIELD_H, cy + r.y));
          if (o.kind === 'slider') {
            for (const cp of o.path.controlPoints) cp.position = rot(cp.position);
            o.path.invalidate();
          }
        }
      });
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- drawing

  draw(now: number): void {
    const g = this.g;
    const dpr = this.dpr;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, this.width, this.height);

    // Playfield area + border (PlayfieldBorder in the editor is always a full box).
    g.save();
    g.translate(this.ox, this.oy);
    g.scale(this.scale, this.scale);
    g.fillStyle = 'rgba(0,0,0,0.25)';
    g.fillRect(0, 0, PLAYFIELD_W, PLAYFIELD_H);
    g.strokeStyle = 'rgba(255,255,255,0.35)';
    g.lineWidth = 1 / this.scale;
    g.strokeRect(0, 0, PLAYFIELD_W, PLAYFIELD_H);
    if (this.gridSnap) {
      // RectangularPositionSnapGrid
      const s = this.host.editor.beatmap.gridSize || 32;
      g.strokeStyle = 'rgba(255,255,255,0.12)';
      g.beginPath();
      for (let x = 0; x <= PLAYFIELD_W; x += s) {
        g.moveTo(x, 0);
        g.lineTo(x, PLAYFIELD_H);
      }
      for (let y = 0; y <= PLAYFIELD_H; y += s) {
        g.moveTo(0, y);
        g.lineTo(PLAYFIELD_W, y);
      }
      g.stroke();
      g.strokeStyle = 'rgba(255,255,255,0.35)';
      g.beginPath();
      g.moveTo(PLAYFIELD_W / 2, 0);
      g.lineTo(PLAYFIELD_W / 2, PLAYFIELD_H);
      g.moveTo(0, PLAYFIELD_H / 2);
      g.lineTo(PLAYFIELD_W, PLAYFIELD_H / 2);
      g.stroke();
    }
    g.restore();

    const ed = this.host.editor;
    const visible = this.visible(now);
    const preempt = this.preempt;
    const fadeIn = 400 * Math.min(1, preempt / 450);
    const radius = this.circleRadius;
    const objScale = radius / 64;

    // Later objects first (earlier objects end up on top).
    for (let i = visible.length - 1; i >= 0; i--) {
      const o = visible[i];
      const combo = ed.comboInfo(o);
      const accent = fromRgb(comboColour(ed.beatmap, combo.comboIndex));
      let alpha = Math.min(1, Math.max(0, (now - (o.startTime - preempt)) / fadeIn));
      if (now > o.endTime) alpha *= Math.max(0, 1 - (now - o.endTime) / 700);
      if (alpha <= 0) continue;

      g.save();
      g.translate(this.ox, this.oy);
      g.scale(this.scale, this.scale);
      if (o.kind === 'spinner') {
        g.globalAlpha = alpha;
        g.strokeStyle = 'rgba(255,255,255,0.8)';
        g.lineWidth = 6;
        g.beginPath();
        g.arc(256, 192, 140, 0, Math.PI * 2);
        g.stroke();
        g.fillStyle = 'rgba(255,255,255,0.15)';
        g.fill();
        g.fillStyle = '#fff';
        g.beginPath();
        g.arc(256, 192, 10, 0, Math.PI * 2);
        g.fill();
        if (now < o.startTime) {
          const p = Math.max(0, (o.startTime - now) / preempt);
          g.globalAlpha = alpha * 0.6;
          g.beginPath();
          g.arc(256, 192, 140 * (1 - p * 0.5), 0, Math.PI * 2);
          g.stroke();
        }
      } else {
        if (o.kind === 'slider') {
          this.drawSliderBody(o, accent, alpha);
          // Reverse arrows
          if (o.repeatCount > 0) {
            const pts = this.sliderPoints(o);
            const end = pts[pts.length - 1];
            const prev = pts[Math.max(0, pts.length - 2)];
            g.save();
            g.translate(end.x, end.y);
            g.scale(objScale, objScale);
            drawReverseArrow(g, (Math.atan2(prev.y - end.y, prev.x - end.x) * 180) / Math.PI, accent, alpha, 1, 1, 1);
            g.restore();
          }
          // Tail circle
          const tail = o.path.positionAt(1);
          if (o.repeatCount % 2 === 0) {
            g.save();
            g.translate(o.x + tail.x, o.y + tail.y);
            g.scale(objScale, objScale);
            g.globalAlpha = alpha;
            g.strokeStyle = 'rgba(255,255,255,0.9)';
            g.lineWidth = 6;
            g.beginPath();
            g.arc(0, 0, 54, 0, Math.PI * 2);
            g.stroke();
            g.restore();
          }
        }
        g.save();
        g.translate(o.x, o.y);
        g.scale(objScale, objScale);
        drawMainCirclePiece(g, { accent, withOuterFill: o.kind !== 'slider', number: combo.indexInCombo + 1, alpha, dim: 1, sinceHit: null, hitLighting: false, kiai: 0 });
        if (now < o.startTime) {
          const p = (o.startTime - now) / preempt;
          drawApproachCircle(g, 1 + 3 * p, Math.min(0.9, alpha * 0.9), accent);
        }
        g.restore();
      }
      // Selection blueprint
      if (ed.selected.has(o)) this.drawSelectionOutline(o, radius);
      g.restore();
    }

    // Slider control points of a single selected slider (PathControlPointVisualiser).
    const sel = [...ed.selected];
    if (sel.length === 1 && sel[0].kind === 'slider') this.drawControlPoints(sel[0]);

    this.drawPlacement(now, radius, objScale);

    // Drag box
    if (this.drag?.kind === 'box') {
      const a = this.toScreen(this.drag.from);
      const b = this.toScreen(this.drag.to);
      g.fillStyle = 'rgba(255,255,255,0.1)';
      g.strokeStyle = '#fff';
      g.lineWidth = 2;
      g.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(a.x - b.x), Math.abs(a.y - b.y));
      g.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(a.x - b.x), Math.abs(a.y - b.y));
    }
  }

  private toScreen(p: Vec): Vec {
    return { x: this.ox + p.x * this.scale, y: this.oy + p.y * this.scale };
  }

  private drawSliderBody(o: ConvertHitObject, accent: [number, number, number, number], alpha: number): void {
    const pts = this.sliderPoints(o);
    if (pts.length < 2) return;
    const s = this.scratch;
    const c = s.getContext('2d')!;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, s.width, s.height);
    c.setTransform(this.dpr * this.scale, 0, 0, this.dpr * this.scale, this.dpr * this.ox, this.dpr * this.oy);
    const radius = ARGON_PATH_RADIUS * (this.circleRadius / 64);
    renderArgonSliderPath(
      c,
      () => {
        c.beginPath();
        c.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) c.lineTo(pts[i].x, pts[i].y);
      },
      radius,
      accent,
      0.7,
    );
    const g = this.g;
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = alpha;
    g.drawImage(s, 0, 0);
    g.restore();
  }

  private drawSelectionOutline(o: ConvertHitObject, radius: number): void {
    const g = this.g;
    g.strokeStyle = '#ffcc22';
    g.lineWidth = 3 / this.scale;
    if (o.kind === 'spinner') {
      g.beginPath();
      g.arc(256, 192, 146, 0, Math.PI * 2);
      g.stroke();
      return;
    }
    if (o.kind === 'slider') {
      const pts = this.sliderPoints(o);
      g.save();
      g.lineCap = 'round';
      g.lineJoin = 'round';
      g.lineWidth = radius * 2 + 6 / this.scale;
      g.strokeStyle = 'rgba(255,204,34,0.35)';
      g.beginPath();
      g.moveTo(pts[0].x, pts[0].y);
      for (const q of pts) g.lineTo(q.x, q.y);
      g.stroke();
      g.restore();
    }
    g.beginPath();
    g.arc(o.x, o.y, radius + 2 / this.scale, 0, Math.PI * 2);
    g.stroke();
  }

  private drawControlPoints(s: ConvertHitObject): void {
    const g = this.g;
    const cps = s.path.controlPoints;
    const pts = cps.map(q => this.toScreen({ x: s.x + q.position.x, y: s.y + q.position.y }));
    g.strokeStyle = 'rgba(255,255,255,0.5)';
    g.lineWidth = 1;
    g.beginPath();
    pts.forEach((q, i) => (i ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y)));
    g.stroke();
    pts.forEach((q, i) => {
      const type = cps[i].type;
      // PathControlPointPiece colours: typed points (segment starts) are coloured by their curve type.
      g.fillStyle = pathTypeColour(type);
      g.strokeStyle = '#fff';
      g.lineWidth = 2;
      g.beginPath();
      g.arc(q.x, q.y, 6, 0, Math.PI * 2);
      g.fill();
      g.stroke();
    });
  }

  private drawPlacement(now: number, radius: number, objScale: number): void {
    const g = this.g;
    const ed = this.host.editor;
    const m = this.mouse ? this.snapPosition(this.mouse) : null;
    g.save();
    g.translate(this.ox, this.oy);
    g.scale(this.scale, this.scale);
    const nextCombo = ed.hitObjects.filter(o => o.startTime <= now).length;
    const accent = fromRgb(comboColour(ed.beatmap, ed.comboInfo(ed.hitObjects[Math.max(0, nextCombo - 1)] ?? ({} as ConvertHitObject)).comboIndex + (this.newCombo ? 1 : 0)));
    if (this.tool === 'circle' && m) {
      g.globalAlpha = 0.6;
      g.translate(m.x, m.y);
      g.scale(objScale, objScale);
      drawMainCirclePiece(g, { accent, withOuterFill: true, number: 1, alpha: 1, dim: 1, sinceHit: null, hitLighting: false, kiai: 0 });
    } else if (this.placement?.kind === 'slider') {
      const pts = [...this.placement.points, ...(m ? [m] : [])];
      if (pts.length >= 2) {
        const head = pts[0];
        const path = new SliderPath(pts.map((q, i) => ({ position: { x: q.x - head.x, y: q.y - head.y }, type: i === 0 ? autoPathType(pts.length) : null })));
        const tmp = new ConvertHitObject('slider');
        tmp.x = head.x;
        tmp.y = head.y;
        tmp.path = path;
        g.restore();
        this.drawSliderBody(tmp, accent, 0.7);
        g.save();
        g.translate(this.ox, this.oy);
        g.scale(this.scale, this.scale);
      }
      g.save();
      g.translate(pts[0].x, pts[0].y);
      g.scale(objScale, objScale);
      drawMainCirclePiece(g, { accent, withOuterFill: false, number: 1, alpha: 1, dim: 1, sinceHit: null, hitLighting: false, kiai: 0 });
      g.restore();
      g.restore();
      // control points
      for (const q of this.placement.points) {
        const s = this.toScreen(q);
        g.fillStyle = '#fff';
        g.fillRect(s.x - 5, s.y - 5, 10, 10);
      }
      return;
    } else if (this.tool === 'spinner') {
      g.globalAlpha = this.placement ? 0.8 : 0.3;
      g.strokeStyle = '#fff';
      g.lineWidth = 6;
      g.beginPath();
      g.arc(256, 192, 140, 0, Math.PI * 2);
      g.stroke();
      if (this.placement?.kind === 'spinner') {
        g.globalAlpha = 1;
        g.fillStyle = '#fff';
        g.font = `600 18px ${getComputedStyle(document.body).fontFamily}`;
        g.textAlign = 'center';
        const dur = Math.max(0, ed.snapTime(now) - this.placement.time);
        g.fillText(`${Math.round(dur)}ms — click again to finish`, 256, 192 + 175);
      }
    }
    g.restore();
    void radius;
  }

  dispose(): void {
    this.placement = null;
  }
}

function distToSegment(p: Vec, a: Vec, b: Vec): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** SliderPlacementBlueprint.updatePathType: 2 points linear, 3 points perfect curve, more bezier. */
function autoPathType(count: number): PathType {
  if (count <= 2) return PathTypes.LINEAR;
  if (count === 3) return PathTypes.PERFECT_CURVE;
  return PathTypes.BEZIER;
}

/** PathControlPointPiece.getColourFromNodeType */
function pathTypeColour(t: PathType | null): string {
  if (!t) return '#ffcc22'; // Yellow
  switch (t.type) {
    case 'Catmull':
      return '#05ffa2'; // SeaFoam
    case 'BSpline':
      if (t.degree == null) return '#ffddee'; // PinkLighter
      return ['#bb1177', '#cc3378', '#ff66aa', '#ff99c7'][Math.max(0, Math.min(3, t.degree))];
    case 'PerfectCurve':
      return '#6644cc'; // PurpleDark
    default:
      return '#ed1121'; // Red
  }
}

export type { PathControlPoint };
