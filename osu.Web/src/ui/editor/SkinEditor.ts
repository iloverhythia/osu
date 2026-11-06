// Port of osu.Game/Overlays/SkinEditor/SkinEditor.cs (+ SkinEditorOverlay, SkinBlueprintContainer, SkinSelectionHandler,
// SkinComponentToolbox, SkinSettingsToolbox, SkinEditorChangeHandler) for the gameplay HUD layer: the menu bar (File:
// Save, Revert to default, Exit; Edit: Undo, Redo), the "Skin editor / Currently editing" header, the components
// toolbox (left), the selected component's settings (right) and the scaled gameplay preview in the middle, where
// components can be selected, dragged, scaled and rotated (selection box handles), nudged with the arrow keys and
// re-anchored ("Closest" anchor, or a fixed anchor / origin from the context menu). Layouts are stored per skin.

import './editor.css';
import './skineditor.css';
import { APP_NAME } from '../../brand';
import { settings } from '../../framework/Settings';
import { ModSet } from '../../game/mods/Mods';
import { HitResult } from '../../game/scoring/HitResult';
import { ACTIVE_SKIN_SETTING, listSkins } from '../../game/skinning';
import { popupDialog } from '../confirm';
import { h } from '../dom';
import type { Game } from '../Game';
import { HUDOverlay } from '../hud/HUDOverlay';
import { ANCHORS, COMPONENT_NAMES, closestAnchor, DEFAULT_LAYOUT, loadLayout, resetLayout, saveLayout, anchorFraction, type Anchor, type ComponentLayout, type HudComponentId } from '../hud/SkinLayout';
import { showContextMenu, type MenuItem } from '../select/Components';
import { editorMenuBar } from './MenuBar';

const MAX_STATES = 50;

let openInstance: SkinEditor | null = null;

export function openSkinEditor(game: Game): void {
  if (openInstance) {
    openInstance.close();
    return;
  }
  openInstance = new SkinEditor(game);
}

class SkinEditor {
  private readonly el: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D;
  private readonly hud: HUDOverlay;
  private layout: Record<HudComponentId, ComponentLayout>;
  private readonly selected = new Set<HudComponentId>();
  private readonly settingsBody: HTMLElement;
  private readonly componentsBody: HTMLElement;
  private readonly menu: { el: HTMLElement; update: () => void };
  private readonly skinName: HTMLElement;
  private raf = 0;
  private states: string[] = [];
  private stateIndex = -1;
  private savedState = '';
  private dpr = 1;
  private sceneW = 0;
  private sceneH = 0;
  /** The preview is drawn at the game's size and scaled down to fit (SkinEditorOverlay scales the screen). */
  private viewScale = 1;
  private viewX = 0;
  private viewY = 0;
  private drag: { kind: 'move'; start: { x: number; y: number }; origins: Map<HudComponentId, { x: number; y: number }> } | { kind: 'scale'; start: { x: number; y: number }; origins: Map<HudComponentId, ComponentLayout>; centre: { x: number; y: number } } | { kind: 'rotate'; centre: { x: number; y: number }; startAngle: number; origins: Map<HudComponentId, number> } | null = null;
  private readonly startedAt = performance.now();

  constructor(private readonly game: Game) {
    this.layout = loadLayout();
    this.hud = new HUDOverlay(
      {
        rulesetShortName: game.ruleset.shortName,
        mods: new ModSet([]),
        actionCount: game.ruleset.shortName === 'mania' ? 4 : 2,
        hitWindows: [
          { result: HitResult.Great, length: 30 },
          { result: HitResult.Ok, length: 70 },
          { result: HitResult.Meh, length: 110 },
        ],
        objectTimes: Array.from({ length: 40 }, (_, i) => ({ start: i * 1500, end: i * 1500 + 300 })),
        replayLoaded: true,
        drainingHealth: true,
        initialHealth: 1,
        showHealthBar: true,
      },
      performance.now(),
      'always',
    );
    this.hud.layout = this.layout;

    this.canvas = h('canvas', { class: 'se-canvas' });
    this.g = this.canvas.getContext('2d')!;
    this.menu = editorMenuBar(() => [
      {
        title: 'File',
        items: [
          { text: 'Save', hotkey: 'Ctrl+S', action: () => this.save() },
          { text: 'Export', disabled: true },
          { spacer: true },
          { text: 'Revert to default', type: 'destructive', action: () => void this.revert() },
          { spacer: true },
          { text: 'Exit', action: () => this.close() },
        ],
      },
      {
        title: 'Edit',
        items: [
          { text: 'Undo', hotkey: 'Ctrl+Z', disabled: this.stateIndex <= 0, action: () => this.undo() },
          { text: 'Redo', hotkey: 'Ctrl+Y', disabled: this.stateIndex >= this.states.length - 1, action: () => this.redo() },
        ],
      },
    ]);
    this.skinName = h('span', { class: 'se-skin-name' });
    const header = h(
      'div',
      { class: 'se-header' },
      h('div', { class: 'se-header-title' }, h('b', null, 'Skin editor'), ' ', h('span', { class: 'se-header-sub' }, 'Currently editing '), this.skinName),
      h('div', { class: 'se-header-desc' }, 'All layout elements for layers in the current screen can be edited.'),
    );
    this.componentsBody = h('div', { class: 'se-components' });
    this.settingsBody = h('div', { class: 'se-settings' });
    const left = h(
      'div',
      { class: 'se-sidebar left' },
      h('div', { class: 'se-section-title' }, 'Current working layer'),
      h('select', { class: 'se-select' }, h('option', null, 'HUD'), h('option', { disabled: true }, 'Playfield')),
      h('div', { class: 'se-section-title' }, 'Components'),
      this.componentsBody,
    );
    const right = h('div', { class: 'se-sidebar right' }, this.settingsBody);
    const scene = h('div', { class: 'se-scene' }, this.canvas);
    this.el = h('div', { class: 'se-root' }, h('div', { class: 'se-topbar' }, this.menu.el, header), h('div', { class: 'se-body' }, left, scene, right));
    document.body.appendChild(this.el);
    requestAnimationFrame(() => this.el.classList.add('shown'));
    game.openOverlay(this.el, { capture: true, onKey: e => this.onKey(e), onClose: () => this.dispose() });

    void listSkins().then(skins => {
      const id = settings.get<string | null>(ACTIVE_SKIN_SETTING, null);
      this.skinName.textContent = id ? (skins.find(s => s.id === id)?.name ?? 'unknown') : `argon (${APP_NAME})`;
    });
    this.saveState();
    this.savedState = this.states[0];
    this.bindInput();
    this.renderComponents();
    this.renderSettings();
    new ResizeObserver(() => this.resize()).observe(scene);
    const loop = () => {
      this.draw();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  // ---------------------------------------------------------------- lifecycle

  close(): void {
    const changed = this.states[this.stateIndex] !== this.savedState;
    if (changed) {
      // SkinEditor.Hide saves the skin (lazer saves on exit too).
      this.save();
    }
    this.game.closeOverlay(this.el);
  }

  private dispose(): void {
    cancelAnimationFrame(this.raf);
    this.el.classList.remove('shown');
    setTimeout(() => this.el.remove(), 300);
    openInstance = null;
  }

  private save(): void {
    saveLayout(this.layout);
    this.savedState = this.states[this.stateIndex];
    this.game.toast('Skin saved', 'success', 2000);
    this.menu.update();
  }

  private async revert(): Promise<void> {
    const i = await popupDialog(this.game, {
      icon: 'warning',
      header: 'Revert to default',
      body: 'All layout elements for layers in the current screen will be reset to defaults.',
      buttons: [
        { text: 'Revert', type: 'danger' },
        { text: 'Cancel', type: 'cancel' },
      ],
    });
    if (i !== 0) return;
    resetLayout();
    this.layout = loadLayout();
    this.hud.layout = this.layout;
    this.selected.clear();
    this.changed();
  }

  // ---------------------------------------------------------------- change handler (SkinEditorChangeHandler)

  private saveState(): void {
    const s = JSON.stringify(this.layout);
    if (this.states[this.stateIndex] === s) return;
    this.states = this.states.slice(0, this.stateIndex + 1);
    this.states.push(s);
    if (this.states.length > MAX_STATES) this.states.shift();
    this.stateIndex = this.states.length - 1;
  }

  private changed(): void {
    this.saveState();
    this.renderComponents();
    this.renderSettings();
    this.menu.update();
  }

  private undo(): void {
    if (this.stateIndex <= 0) return;
    this.layout = JSON.parse(this.states[--this.stateIndex]);
    this.hud.layout = this.layout;
    this.renderComponents();
    this.renderSettings();
    this.menu.update();
  }

  private redo(): void {
    if (this.stateIndex >= this.states.length - 1) return;
    this.layout = JSON.parse(this.states[++this.stateIndex]);
    this.hud.layout = this.layout;
    this.renderComponents();
    this.renderSettings();
    this.menu.update();
  }

  // ---------------------------------------------------------------- sidebars

  /** SkinComponentToolbox: every HUD component; hidden ones can be added back. */
  private renderComponents(): void {
    this.componentsBody.replaceChildren(
      ...this.hud.componentIds().map(id => {
        const l = this.layout[id];
        const b = h('button', { class: `se-component${l.visible ? '' : ' hidden'}${this.selected.has(id) ? ' selected' : ''}` }, h('span', null, COMPONENT_NAMES[id]), h('span', { class: 'se-component-state' }, l.visible ? '' : '+ add'));
        b.addEventListener('click', () => {
          if (!l.visible) {
            l.visible = true;
            this.changed();
          }
          this.select([id]);
        });
        return b;
      }),
    );
  }

  /** SkinSettingsToolbox: layout of the selected component. */
  private renderSettings(): void {
    const ids = [...this.selected];
    if (ids.length !== 1) {
      this.settingsBody.replaceChildren(h('div', { class: 'se-section-title' }, 'Settings'), h('div', { class: 'se-empty' }, ids.length ? `${ids.length} components selected` : 'Select a component to change its settings.'));
      return;
    }
    const id = ids[0];
    const l = this.layout[id];
    const num = (label: string, get: () => number, set: (v: number) => void, step: number, min = -10000, max = 10000) => {
      const input = h('input', { class: 'se-input', type: 'number', step: String(step), min: String(min), max: String(max), value: String(Math.round(get() * 1000) / 1000) }) as HTMLInputElement;
      input.addEventListener('keydown', e => e.stopPropagation());
      input.addEventListener('change', () => {
        const v = Number(input.value);
        if (Number.isFinite(v)) {
          set(Math.max(min, Math.min(max, v)));
          this.changed();
        }
      });
      return h('label', { class: 'se-field' }, h('span', null, label), input);
    };
    const anchorSelect = (label: string, get: () => Anchor | 'Closest', set: (v: Anchor | 'Closest') => void, closest: boolean) => {
      const sel = h('select', { class: 'se-select' }, ...(closest ? ['Closest' as const] : []).concat(ANCHORS as never[]).map(a => h('option', { value: a, selected: a === get() }, splitWords(a)))) as HTMLSelectElement;
      sel.addEventListener('change', () => {
        set(sel.value as Anchor | 'Closest');
        this.changed();
      });
      return h('label', { class: 'se-field' }, h('span', null, label), sel);
    };
    const usesClosest = !(l as ComponentLayout & { fixedAnchor?: boolean }).fixedAnchor;
    this.settingsBody.replaceChildren(
      h('div', { class: 'se-section-title' }, `Settings (${COMPONENT_NAMES[id]})`),
      anchorSelect('Anchor', () => (usesClosest ? 'Closest' : l.anchor), v => this.applyAnchor(id, v), true),
      anchorSelect('Origin', () => l.origin, v => this.applyOrigin(id, v as Anchor), false),
      num('X', () => l.x, v => (l.x = v), 1),
      num('Y', () => l.y, v => (l.y = v), 1),
      num('Scale X', () => l.scaleX, v => (l.scaleX = v), 0.05, 0.1, 10),
      num('Scale Y', () => l.scaleY, v => (l.scaleY = v), 0.05, 0.1, 10),
      num('Rotation', () => l.rotation, v => (l.rotation = v), 1, -360, 360),
      h(
        'div',
        { class: 'se-buttons' },
        h('button', { class: 'se-button', onclick: () => this.resetProperty(id, 'position') }, 'Reset position'),
        h('button', { class: 'se-button', onclick: () => this.resetProperty(id, 'rotation') }, 'Reset rotation'),
        h('button', { class: 'se-button', onclick: () => this.resetProperty(id, 'scale') }, 'Reset scale'),
        h('button', { class: 'se-button danger', onclick: () => this.deleteSelected() }, 'Delete'),
      ),
    );
  }

  private resetProperty(id: HudComponentId, what: 'position' | 'rotation' | 'scale'): void {
    const d = DEFAULT_LAYOUT[id];
    const l = this.layout[id];
    if (what === 'position') Object.assign(l, { anchor: d.anchor, origin: d.origin, x: d.x, y: d.y });
    else if (what === 'rotation') l.rotation = 0;
    else Object.assign(l, { scaleX: d.scaleX, scaleY: d.scaleY });
    this.changed();
  }

  private deleteSelected(): void {
    for (const id of this.selected) this.layout[id].visible = false;
    this.selected.clear();
    this.changed();
  }

  /** SkinSelectionHandler.applyAnchor: keeps the component where it is on screen. */
  private applyAnchor(id: HudComponentId, anchor: Anchor | 'Closest'): void {
    const l = this.layout[id] as ComponentLayout & { fixedAnchor?: boolean };
    const w = this.sceneW;
    const hgt = this.sceneH;
    const before = anchorFraction(l.anchor);
    const px = before.x * w + l.x;
    const py = before.y * hgt + l.y;
    let target: Anchor;
    if (anchor === 'Closest') {
      l.fixedAnchor = false;
      target = closestAnchor(px, py, w, hgt);
    } else {
      l.fixedAnchor = true;
      target = anchor;
    }
    const a = anchorFraction(target);
    l.anchor = target;
    l.x = px - a.x * w;
    l.y = py - a.y * hgt;
  }

  /** SkinSelectionHandler.applyOrigin: keeps the component where it is on screen. */
  private applyOrigin(id: HudComponentId, origin: Anchor): void {
    const l = this.layout[id];
    const size = this.hud.componentSize(id, this.g, this.sceneW, performance.now());
    const o0 = anchorFraction(l.origin);
    const o1 = anchorFraction(origin);
    const r = (l.rotation * Math.PI) / 180;
    const dx = (o1.x - o0.x) * size.w * l.scaleX;
    const dy = (o1.y - o0.y) * size.h * l.scaleY;
    l.x += dx * Math.cos(r) - dy * Math.sin(r);
    l.y += dx * Math.sin(r) + dy * Math.cos(r);
    l.origin = origin;
  }

  // ---------------------------------------------------------------- scene

  private resize(): void {
    const scene = this.canvas.parentElement!;
    const r = scene.getBoundingClientRect();
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.max(1, Math.round(r.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * this.dpr));
    // The scene keeps the game's aspect ratio (SkinEditorOverlay scales the target screen into the free space).
    this.sceneW = innerWidth;
    this.sceneH = innerHeight;
    this.viewScale = Math.min((r.width - 20) / this.sceneW, (r.height - 20) / this.sceneH);
    this.viewX = (r.width - this.sceneW * this.viewScale) / 2;
    this.viewY = (r.height - this.sceneH * this.viewScale) / 2;
  }

  private toScene(clientX: number, clientY: number): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: (clientX - r.left - this.viewX) / this.viewScale, y: (clientY - r.top - this.viewY) / this.viewScale };
  }

  private bounds(id: HudComponentId) {
    return this.hud.componentBounds(id, this.g, this.sceneW, this.sceneH, performance.now());
  }

  private hitTest(p: { x: number; y: number }): HudComponentId | null {
    const ids = this.hud.componentIds().filter(id => this.layout[id].visible);
    for (let i = ids.length - 1; i >= 0; i--) {
      const b = this.bounds(ids[i]);
      if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) return ids[i];
    }
    return null;
  }

  private selectionBounds(): { x: number; y: number; w: number; h: number } | null {
    const ids = [...this.selected];
    if (!ids.length) return null;
    const bs = ids.map(id => this.bounds(id));
    const x0 = Math.min(...bs.map(b => b.x));
    const y0 = Math.min(...bs.map(b => b.y));
    const x1 = Math.max(...bs.map(b => b.x + b.w));
    const y1 = Math.max(...bs.map(b => b.y + b.h));
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  private select(ids: HudComponentId[], additive = false): void {
    if (!additive) this.selected.clear();
    for (const id of ids) this.selected.add(id);
    this.renderComponents();
    this.renderSettings();
  }

  private bindInput(): void {
    const c = this.canvas;
    c.addEventListener('contextmenu', e => e.preventDefault());
    c.addEventListener('pointerdown', e => {
      const p = this.toScene(e.clientX, e.clientY);
      c.setPointerCapture(e.pointerId);
      const sb = this.selectionBounds();
      if (sb && e.button === 0) {
        // SelectionBox handles: corners scale, the top handle rotates.
        const handle = 8 / this.viewScale;
        const corners = [
          [sb.x, sb.y],
          [sb.x + sb.w, sb.y],
          [sb.x, sb.y + sb.h],
          [sb.x + sb.w, sb.y + sb.h],
        ];
        const centre = { x: sb.x + sb.w / 2, y: sb.y + sb.h / 2 };
        if (Math.hypot(p.x - centre.x, p.y - (sb.y - 30 / this.viewScale)) <= handle * 1.5) {
          this.drag = { kind: 'rotate', centre, startAngle: Math.atan2(p.y - centre.y, p.x - centre.x), origins: new Map([...this.selected].map(id => [id, this.layout[id].rotation])) };
          return;
        }
        if (corners.some(([cx, cy]) => Math.abs(p.x - cx) <= handle && Math.abs(p.y - cy) <= handle)) {
          this.drag = { kind: 'scale', start: p, centre, origins: new Map([...this.selected].map(id => [id, { ...this.layout[id] }])) };
          return;
        }
      }
      const hit = this.hitTest(p);
      if (e.button === 2) {
        if (hit && !this.selected.has(hit)) this.select([hit]);
        if (this.selected.size) this.contextMenu(e.clientX, e.clientY);
        return;
      }
      if (!hit) {
        this.select([]);
        return;
      }
      if (e.ctrlKey || e.shiftKey) {
        if (this.selected.has(hit)) this.selected.delete(hit);
        else this.selected.add(hit);
        this.select([...this.selected]);
      } else if (!this.selected.has(hit)) this.select([hit]);
      this.drag = { kind: 'move', start: p, origins: new Map([...this.selected].map(id => [id, { x: this.layout[id].x, y: this.layout[id].y }])) };
    });
    c.addEventListener('pointermove', e => {
      const d = this.drag;
      const p = this.toScene(e.clientX, e.clientY);
      if (!d) {
        c.style.cursor = this.hitTest(p) ? 'move' : 'default';
        return;
      }
      if (d.kind === 'move') {
        for (const [id, o] of d.origins) {
          this.layout[id].x = Math.round(o.x + p.x - d.start.x);
          this.layout[id].y = Math.round(o.y + p.y - d.start.y);
        }
      } else if (d.kind === 'scale') {
        const d0 = Math.hypot(d.start.x - d.centre.x, d.start.y - d.centre.y) || 1;
        const f = Math.max(0.1, Math.hypot(p.x - d.centre.x, p.y - d.centre.y) / d0);
        for (const [id, o] of d.origins) {
          this.layout[id].scaleX = Math.round(o.scaleX * f * 100) / 100;
          this.layout[id].scaleY = Math.round(o.scaleY * f * 100) / 100;
        }
      } else {
        let delta = ((Math.atan2(p.y - d.centre.y, p.x - d.centre.x) - d.startAngle) * 180) / Math.PI;
        // SkinSelectionRotationHandler: Shift snaps to 15° increments.
        if (e.shiftKey) delta = Math.round(delta / 15) * 15;
        for (const [id, r] of d.origins) this.layout[id].rotation = Math.round(((r + delta + 540) % 360) - 180);
      }
    });
    c.addEventListener('pointerup', () => {
      if (!this.drag) return;
      if (this.drag.kind === 'move') {
        // "Closest" anchors follow the component.
        for (const id of this.drag.origins.keys()) {
          const l = this.layout[id] as ComponentLayout & { fixedAnchor?: boolean };
          if (!l.fixedAnchor) this.applyAnchor(id, 'Closest');
        }
      }
      this.drag = null;
      this.changed();
    });
  }

  private contextMenu(x: number, y: number): void {
    const ids = [...this.selected];
    const one = ids.length === 1 ? (this.layout[ids[0]] as ComponentLayout & { fixedAnchor?: boolean }) : null;
    const items: MenuItem[] = [
      {
        text: 'Anchor',
        items: [
          { text: 'Closest', checked: !!one && !one.fixedAnchor, action: () => (ids.forEach(id => this.applyAnchor(id, 'Closest')), this.changed()) },
          ...ANCHORS.map(a => ({ text: splitWords(a), checked: !!one && one.fixedAnchor === true && one.anchor === a, action: () => (ids.forEach(id => this.applyAnchor(id, a)), this.changed()) })),
        ],
      },
      { text: 'Origin', items: ANCHORS.map(a => ({ text: splitWords(a), checked: one?.origin === a, action: () => (ids.forEach(id => this.applyOrigin(id, a)), this.changed()) })) },
      { spacer: true, text: '' },
      { text: 'Reset position', action: () => ids.forEach(id => this.resetProperty(id, 'position')) },
      { text: 'Reset rotation', action: () => ids.forEach(id => this.resetProperty(id, 'rotation')) },
      { text: 'Reset scale', action: () => ids.forEach(id => this.resetProperty(id, 'scale')) },
      { spacer: true, text: '' },
      { text: 'Delete', type: 'destructive', action: () => this.deleteSelected() },
    ];
    showContextMenu(x, y, items);
  }

  private onKey(e: KeyboardEvent): boolean {
    const ctrl = e.ctrlKey || e.metaKey;
    if (e.code === 'Escape') {
      if (this.selected.size) this.select([]);
      else this.close();
      return true;
    }
    if (ctrl && e.code === 'KeyS' && !e.shiftKey) {
      this.save();
      return true;
    }
    if (ctrl && e.shiftKey && e.code === 'KeyS') {
      this.close();
      return true;
    }
    if (ctrl && e.code === 'KeyZ') {
      if (e.shiftKey) this.redo();
      else this.undo();
      return true;
    }
    if (ctrl && e.code === 'KeyY') {
      this.redo();
      return true;
    }
    if (ctrl && e.code === 'KeyA') {
      this.select(this.hud.componentIds().filter(id => this.layout[id].visible));
      return true;
    }
    if ((e.code === 'Delete' || e.code === 'Backspace') && this.selected.size) {
      this.deleteSelected();
      return true;
    }
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (arrows[e.code] && this.selected.size) {
      // SkinSelectionHandler: arrow keys nudge by one pixel.
      const [dx, dy] = arrows[e.code];
      for (const id of this.selected) {
        this.layout[id].x += dx;
        this.layout[id].y += dy;
      }
      this.changed();
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- drawing

  private draw(): void {
    const g = this.g;
    const now = performance.now();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (!this.sceneW) return;
    g.setTransform(this.dpr * this.viewScale, 0, 0, this.dpr * this.viewScale, this.dpr * this.viewX, this.dpr * this.viewY);
    // The gameplay screen behind the HUD (dimmed beatmap background).
    g.fillStyle = '#0c0a10';
    g.fillRect(0, 0, this.sceneW, this.sceneH);
    g.strokeStyle = 'rgba(255,255,255,0.15)';
    g.lineWidth = 2 / this.viewScale;
    g.strokeRect(0, 0, this.sceneW, this.sceneH);
    // A playfield outline for reference.
    const pw = Math.min(this.sceneW * 0.8, this.sceneH * 0.8 * (4 / 3));
    const ph = (pw * 3) / 4;
    g.strokeStyle = 'rgba(255,255,255,0.08)';
    g.strokeRect((this.sceneW - pw) / 2, (this.sceneH - ph) / 2 + 8, pw, ph);

    // Sample gameplay state so every counter shows something.
    const t = (now - this.startedAt) / 1000;
    this.hud.update(now, {
      totalScore: Math.floor((t * 23456) % 1000000),
      accuracy: 0.97 + 0.02 * Math.sin(t / 3),
      combo: Math.floor(t * 4) % 300,
      health: 0.6 + 0.3 * Math.sin(t / 2),
      time: (t * 1000) % 60000,
      clockStartTime: 0,
      isPlaying: true,
      keyOverlay: true,
      fadePlayfieldWhenHealthLow: false,
      showHitErrorMeter: true,
    });
    if (Math.random() < 0.08) this.hud.onJudgement({ isHit: true, type: Math.random() < 0.8 ? HitResult.Great : HitResult.Ok, timeOffset: (Math.random() - 0.5) * 60, ignoreHit: false, scorable: true, bonus: false, missWindowZero: false, healthIncrease: 0 }, now);
    this.hud.draw(g, this.sceneW, this.sceneH, now, this.dpr * this.viewScale);

    // Blueprints (SkinBlueprint): every component gets a faint outline, the selection a highlighted one.
    for (const id of this.hud.componentIds()) {
      if (!this.layout[id].visible) continue;
      const b = this.bounds(id);
      const sel = this.selected.has(id);
      g.strokeStyle = sel ? '#ffcc22' : 'rgba(255,255,255,0.25)';
      g.lineWidth = (sel ? 2 : 1) / this.viewScale;
      g.setLineDash(sel ? [] : [4 / this.viewScale, 4 / this.viewScale]);
      g.strokeRect(b.x, b.y, b.w, b.h);
      g.setLineDash([]);
      if (sel) {
        // Anchor line (SkinBlueprint anchor / origin indicators).
        const l = this.layout[id];
        const a = anchorFraction(l.anchor);
        const ax = a.x * this.sceneW;
        const ay = a.y * this.sceneH;
        g.strokeStyle = 'rgba(255,204,34,0.6)';
        g.beginPath();
        g.moveTo(ax, ay);
        g.lineTo(ax + l.x, ay + l.y);
        g.stroke();
        g.fillStyle = '#ff66aa';
        g.beginPath();
        g.arc(ax + l.x, ay + l.y, 4 / this.viewScale, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = '#ffcc22';
        g.font = `600 ${12 / this.viewScale}px ${getComputedStyle(document.body).fontFamily}`;
        g.fillText(COMPONENT_NAMES[id], b.x, b.y - 6 / this.viewScale);
      }
    }
    // SelectionBox handles
    const sb = this.selectionBounds();
    if (sb) {
      const hs = 8 / this.viewScale;
      g.fillStyle = '#ffcc22';
      for (const [cx, cy] of [
        [sb.x, sb.y],
        [sb.x + sb.w, sb.y],
        [sb.x, sb.y + sb.h],
        [sb.x + sb.w, sb.y + sb.h],
      ])
        g.fillRect(cx - hs / 2, cy - hs / 2, hs, hs);
      const rx = sb.x + sb.w / 2;
      const ry = sb.y - 30 / this.viewScale;
      g.strokeStyle = '#ffcc22';
      g.beginPath();
      g.moveTo(rx, sb.y);
      g.lineTo(rx, ry);
      g.stroke();
      g.beginPath();
      g.arc(rx, ry, hs * 0.75, 0, Math.PI * 2);
      g.fill();
    }
  }
}

const splitWords = (a: string) => a.replace(/([a-z])([A-Z])/g, '$1 $2');
