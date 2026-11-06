// Port of the composer sidebars: EditorToolboxGroup, EditorRadioButton (tools), DrawableTernaryButton (toggles and
// samples), BeatDivisorControl ("beat snap") and HitObjectInspector ("inspector").

import { BANK_DRUM, BANK_NORMAL, BANK_SOFT, HIT_CLAP, HIT_FINISH, HIT_WHISTLE } from '../../game/audio/HitSampleInfo';
import { beatDivisorColour, PREDEFINED_DIVISORS } from '../../game/beatmaps/BeatDivisor';
import { h } from '../dom';
import type { ComposerHost } from './Composer';
import type { EditorBeatmap } from './EditorBeatmap';

/** EditorToolboxGroup: a collapsible group with a lowercase header. */
export function toolbox(title: string, children: HTMLElement[]): HTMLElement {
  const body = h('div', { class: 'ed-tb-body' }, ...children);
  const header = h('button', { class: 'ed-tb-header' }, h('span', null, title), h('span', { class: 'ed-tb-chevron' }, '⌄'));
  const el = h('div', { class: 'ed-tb-group' }, header, body);
  header.addEventListener('click', () => el.classList.toggle('collapsed'));
  return el;
}

const TOOL_ICONS: Record<string, string> = {
  select: '<path d="M7 3l12 9-5.5 1.2L17 20l-2.6 1.3-3.4-6.8L7 18z"/>',
  circle: '<circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="3"/>',
  slider: '<path d="M4 17c4-10 12-10 16-2" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><circle cx="4.5" cy="17" r="2.5"/>',
  spinner: '<circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2.5"/><circle cx="12" cy="12" r="2.5"/>',
};

/** EditorRadioButton (HitObjectCompositionTool). */
export function toolButton(label: string, icon: string, key: string, onClick: () => void): HTMLElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.innerHTML = TOOL_ICONS[icon] ?? '';
  return h('button', { class: 'ed-tool', title: `${label} (${key})`, onclick: onClick }, svg, h('span', { class: 'ed-tool-label' }, label), h('span', { class: 'ed-tool-key' }, key));
}

/** DrawableTernaryButton: on / off / indeterminate (some of the selection). */
export function ternary(label: string, key: string, get: () => boolean | null, toggle: () => void): { el: HTMLElement; update: () => void } {
  const box = h('span', { class: 'ed-ternary-box' });
  const el = h('button', { class: 'ed-ternary', title: `${label} (${key})`, onclick: toggle }, box, h('span', { class: 'ed-tool-label' }, label), h('span', { class: 'ed-tool-key' }, key));
  const update = () => {
    const v = get();
    el.classList.toggle('on', v === true);
    el.classList.toggle('indeterminate', v === null);
  };
  update();
  return { el, update };
}

export interface SampleState {
  whistle: boolean;
  finish: boolean;
  clap: boolean;
  normalBank: string | null;
  additionBank: string | null;
}

/** ComposeBlueprintContainer sample / bank ternaries (W/E/R, Shift+Q..R normal bank, Alt+Q..R addition bank). */
export function sampleToolboxes(ed: EditorBeatmap, state: SampleState, changed: () => void, onSelection: { toggleSample: (name: string) => void; setBank: (target: 'normal' | 'addition', bank: string | null) => void }): { els: HTMLElement[]; update: () => void } {
  const selection = () => [...ed.selected];
  const sampleGet = (name: string, key: 'whistle' | 'finish' | 'clap') => () => {
    const sel = selection();
    if (sel.length === 0) return state[key];
    const n = sel.filter(o => o.samples.some(s => s.name === name)).length;
    return n === 0 ? false : n === sel.length ? true : null;
  };
  const samples: [string, string, 'whistle' | 'finish' | 'clap', string][] = [
    ['Whistle', HIT_WHISTLE, 'whistle', 'W'],
    ['Finish', HIT_FINISH, 'finish', 'E'],
    ['Clap', HIT_CLAP, 'clap', 'R'],
  ];
  const sampleButtons = samples.map(([label, name, key, k]) =>
    ternary(label, k, sampleGet(name, key), () => {
      if (selection().length === 0) state[key] = !state[key];
      else onSelection.toggleSample(name);
      changed();
    }),
  );
  const banks: [string, string | null][] = [
    ['Auto', null],
    ['Normal', BANK_NORMAL],
    ['Soft', BANK_SOFT],
    ['Drum', BANK_DRUM],
  ];
  const bankButtons = (target: 'normal' | 'addition', mod: string) =>
    banks.map(([label, bank], i) =>
      ternary(label, `${mod}+${'QWER'[i]}`, () => (target === 'normal' ? state.normalBank : state.additionBank) === bank, () => {
        if (target === 'normal') state.normalBank = bank;
        else state.additionBank = bank;
        if (selection().length > 0) onSelection.setBank(target, bank);
        changed();
      }),
    );
  const normal = bankButtons('normal', 'Shift');
  const addition = bankButtons('addition', 'Alt');
  const all = [...sampleButtons, ...normal, ...addition];
  return {
    els: [toolbox('samples', sampleButtons.map(b => b.el)), toolbox('normal sample bank', normal.map(b => b.el)), toolbox('addition sample bank', addition.map(b => b.el))],
    update: () => all.forEach(b => b.update()),
  };
}

/** BeatDivisorControl: "1/4" with previous / next, a tick slider and the divisor type. */
export function beatSnapControl(ed: EditorBeatmap): { el: HTMLElement; update: () => void } {
  const value = h('div', { class: 'ed-snap-value' });
  const ticks = h('div', { class: 'ed-snap-ticks' });
  const prev = h('button', { class: 'ed-snap-arrow', title: 'Previous divisor', onclick: () => ed.cycleDivisor(-1) }, '‹');
  const next = h('button', { class: 'ed-snap-arrow', title: 'Next divisor', onclick: () => ed.cycleDivisor(1) }, '›');
  const update = () => {
    const d = ed.beatDivisor;
    value.textContent = `1/${d}`;
    value.style.color = `rgb(${beatDivisorColour(d).join(',')})`;
    ticks.replaceChildren(
      ...(PREDEFINED_DIVISORS as readonly number[]).map(v =>
        h('button', { class: `ed-snap-tick${v === d ? ' active' : ''}`, title: `1/${v}`, style: { background: `rgb(${beatDivisorColour(v).join(',')})` }, onclick: () => ed.setDivisor(v) }),
      ),
    );
  };
  update();
  const el = toolbox('beat snap', [h('div', { class: 'ed-snap-row' }, prev, value, next), ticks, h('div', { class: 'ed-snap-hint' }, 'Ctrl+scroll to change')]);
  return { el, update };
}

const fmt = (ms: number) => {
  const neg = ms < 0;
  ms = Math.abs(Math.round(ms));
  const m = Math.floor(ms / 60000);
  const s = Math.floor(ms / 1000) % 60;
  return `${neg ? '-' : ''}${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}:${String(ms % 1000).padStart(3, '0')}`;
};

/** HitObjectInspector */
export function inspector(host: ComposerHost): { el: HTMLElement; update: () => void } {
  const body = h('div', { class: 'ed-inspector' });
  const row = (k: string, v: string) => h('div', { class: 'ed-insp-row' }, h('span', { class: 'ed-insp-key' }, k), h('span', { class: 'ed-insp-value' }, v));
  const update = () => {
    const sel = [...host.editor.selected].sort((a, b) => a.startTime - b.startTime);
    if (sel.length === 0) {
      body.replaceChildren(h('div', { class: 'ed-insp-empty' }, 'No selection'));
      return;
    }
    const rows = [row('Selected Objects', String(sel.length)), row('Start Time', fmt(sel[0].startTime))];
    if (sel.length === 1) {
      const o = sel[0];
      if (o.hasDuration) rows.push(row('End Time', fmt(o.endTime)), row('Duration', `${Math.round(o.duration)}ms`));
      if (o.kind !== 'spinner') rows.push(row('Position', `x:${o.x.toFixed(2)} y:${o.y.toFixed(2)}`));
      if (o.kind === 'slider') rows.push(row('Path Length', o.path.distance.toFixed(2)), row('Slider Velocity', `${o.sliderVelocityMultiplier.toFixed(2)}x`), row('Repeats', String(o.repeatCount)));
      const c = host.editor.comboInfo(o);
      rows.push(row('Combo', `#${c.indexInCombo + 1}${o.newCombo ? ' (new)' : ''}`));
    } else {
      rows.push(row('End Time', fmt(Math.max(...sel.map(o => o.endTime)))));
    }
    body.replaceChildren(...rows);
  };
  update();
  return { el: toolbox('inspector', [body]), update };
}
