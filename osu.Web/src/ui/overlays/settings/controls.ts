// Ports of the settings form controls: FormControlBackground, FormFieldCaption, FormCheckBox (+ SwitchButton),
// FormSliderBar, FormDropdown, FormTextBox, SettingsButtonV2 / DangerousSettingsButtonV2, SettingsNote and the
// SettingsItemV2 wrapper with its SettingsRevertToDefaultButton.

import { DEFAULT_SETTINGS, settings } from '../../../framework/Settings';
import { h } from '../../dom';
import { iconEl, SETTINGS_ICONS } from './icons';

// ------------------------------------------------------------------ bindables

export interface Bindable<T> {
  get(): T;
  set(v: T): void;
  readonly default: T;
  disabled?: () => boolean;
}

/** A bindable stored in the settings store. `also` keys receive the same value (one lazer setting backing several of ours). */
export function bindSetting<T>(key: string, also: string[] = [], fallback?: T): Bindable<T> {
  const def = (key in DEFAULT_SETTINGS ? DEFAULT_SETTINGS[key as keyof typeof DEFAULT_SETTINGS] : fallback) as T;
  return {
    get: () => settings.get<T>(key, def),
    set: v => {
      settings.set(key, v);
      for (const k of also) settings.set(k, v);
    },
    default: def,
  };
}

/** A bindable that isn't backed by storage (e.g. platform state such as fullscreen). */
export function bindValue<T>(get: () => T, set: (v: T) => void, def: T): Bindable<T> {
  return { get, set, default: def };
}

// ------------------------------------------------------------------ shared pieces

export interface FormControl {
  el: HTMLElement;
  /** Element the revert button is sized against (MainDrawHeight). */
  main: HTMLElement;
  terms: string[];
  isDefault(): boolean;
  setDefault(): void;
  isDisabled(): boolean;
  update(): void;
}

export interface CommonOptions {
  hint?: string;
  /** Disabled with this explanation shown as a note (features not available in the browser version). */
  unavailable?: string;
}

const tooltip = (() => {
  let el: HTMLDivElement | null = null;
  return {
    show(text: string, x: number, y: number) {
      if (!el) {
        el = h('div', { class: 'st-tooltip' });
        document.body.appendChild(el);
      }
      el.textContent = text;
      el.style.display = 'block';
      const w = el.offsetWidth;
      el.style.left = `${Math.min(window.innerWidth - w - 8, x + 12)}px`;
      el.style.top = `${y + 16}px`;
    },
    hide() {
      if (el) el.style.display = 'none';
    },
  };
})();

export function attachTooltip(target: HTMLElement, text: () => string): void {
  target.addEventListener('pointermove', e => {
    const t = text();
    if (t && e.pointerType === 'mouse') tooltip.show(t, e.clientX, e.clientY);
  });
  target.addEventListener('pointerleave', () => tooltip.hide());
  target.addEventListener('pointerdown', () => tooltip.hide());
}

export const hideTooltip = () => tooltip.hide();

/** FormControlBackground: normal / hovered / focused / disabled styles plus the commit flash. */
function background(): { el: HTMLElement; flash: () => void } {
  const flashLayer = h('div', { class: 'sf-flash' });
  const el = h('div', { class: 'sf-bg' }, flashLayer);
  return {
    el,
    flash: () => flashLayer.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 800, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }),
  };
}

/** FormFieldCaption (caption text, with a question mark icon when there's a tooltip). */
function caption(text: string, hint?: string): HTMLElement {
  const el = h('div', { class: 'sf-caption' }, text);
  if (hint) {
    el.append(' ', iconEl(SETTINGS_ICONS.question, 'sf-hint-icon'));
    attachTooltip(el, () => hint);
  }
  return el;
}

// ------------------------------------------------------------------ FormCheckBox

export function formCheckBox(text: string, bind: Bindable<boolean>, opts: CommonOptions = {}): FormControl {
  const bg = background();
  const fill = h('div', { class: 'switch-fill' });
  const sw = h('div', { class: 'switch' }, h('div', { class: 'switch-inner' }, fill));
  const el = h('div', { class: 'sf sf-checkbox' }, bg.el, h('div', { class: 'sf-row' }, h('div', { class: 'sf-text' }, caption(text, opts.hint)), sw));
  const disabled = () => !!opts.unavailable || !!bind.disabled?.();
  const update = () => {
    el.classList.toggle('disabled', disabled());
    sw.classList.toggle('on', !!bind.get());
  };
  el.addEventListener('click', () => {
    if (disabled()) return;
    bind.set(!bind.get());
    bg.flash();
    update();
  });
  update();
  return { el, main: el, terms: [text, opts.hint ?? ''], isDefault: () => bind.get() === bind.default, setDefault: () => bind.set(bind.default), isDisabled: disabled, update };
}

// ------------------------------------------------------------------ FormSliderBar

export interface SliderOptions extends CommonOptions {
  min: number;
  max: number;
  /** Bindable precision. */
  precision: number;
  keyboardStep?: number;
  displayAsPercentage?: boolean;
  labelFormat?: (v: number) => string;
}

/** ToStandardFormattedString(5, asPercentage) */
export function standardFormat(v: number, percent = false): string {
  if (percent) return `${+(v * 100).toFixed(3)}%`;
  return String(+v.toFixed(5));
}

export function formSliderBar(text: string, bind: Bindable<number>, o: SliderOptions): FormControl {
  const bg = background();
  const label = h('div', { class: 'sf-value' });
  const input = h('input', { class: 'sf-input', type: 'text', inputMode: 'decimal' }) as HTMLInputElement;
  const valueWrap = h('div', { class: 'sf-value-wrap' }, input, label);
  const left = h('div', { class: 'sf-slider-left' }, caption(text, o.hint), valueWrap);
  const leftBox = h('div', { class: 'sb-left' });
  const nub = h('div', { class: 'sb-nub' });
  const defaultLine = h('div', { class: 'sb-default' });
  const track = h('div', { class: 'sb-track', tabIndex: 0 }, h('div', { class: 'sb-boxes' }, leftBox, h('div', { class: 'sb-right' })), h('div', { class: 'sb-range' }, defaultLine, nub));
  const el = h('div', { class: 'sf sf-slider' }, bg.el, h('div', { class: 'sf-slider-row' }, left, track));
  const disabled = () => !!o.unavailable || !!bind.disabled?.();
  const format = (v: number) => (o.labelFormat ? o.labelFormat(v) : standardFormat(v, o.displayAsPercentage));
  const snap = (v: number) => {
    const p = o.precision;
    const s = Math.round((v - o.min) / p) * p + o.min;
    return Math.min(o.max, Math.max(o.min, +s.toFixed(6)));
  };
  const norm = (v: number) => (o.max === o.min ? 0 : (v - o.min) / (o.max - o.min));
  let editing = false;
  const update = () => {
    const v = bind.get();
    el.classList.toggle('disabled', disabled());
    // The nub sits inside a range padded by half its width (RangePadding = NUB_WIDTH / 2).
    nub.style.left = `${norm(v) * 100}%`;
    leftBox.style.width = `calc(5px + (100% - 10px) * ${norm(v)})`;
    defaultLine.style.left = `${norm(bind.default) * 100}%`;
    defaultLine.classList.toggle('is-default', Math.abs(v - bind.default) < o.precision / 2);
    label.textContent = format(v);
    if (!editing) input.value = o.displayAsPercentage ? String(+(v * 100).toFixed(3)) : String(+v.toFixed(5));
  };
  const setFromPointer = (clientX: number) => {
    const r = track.getBoundingClientRect();
    const t = Math.min(1, Math.max(0, (clientX - r.left - 5) / Math.max(1, r.width - 10)));
    const v = snap(o.min + t * (o.max - o.min));
    if (v !== bind.get()) bind.set(v);
    update();
  };
  let dragging = false;
  track.addEventListener('pointerdown', e => {
    if (disabled()) return;
    e.preventDefault();
    e.stopPropagation();
    track.focus();
    dragging = true;
    el.classList.add('dragging');
    track.setPointerCapture(e.pointerId);
    setFromPointer(e.clientX);
  });
  track.addEventListener('pointermove', e => {
    if (dragging) setFromPointer(e.clientX);
  });
  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    el.classList.remove('dragging');
    bg.flash();
  };
  track.addEventListener('pointerup', endDrag);
  track.addEventListener('pointercancel', endDrag);
  track.addEventListener('click', e => e.stopPropagation());
  nub.addEventListener('dblclick', () => {
    if (!disabled()) bind.set(bind.default), update();
  });
  track.addEventListener('keydown', e => {
    if (disabled()) return;
    const step = o.keyboardStep ?? o.precision;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') bind.set(snap(bind.get() - step));
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') bind.set(snap(bind.get() + step));
    else return;
    e.preventDefault();
    e.stopPropagation();
    update();
  });
  track.addEventListener('focus', () => el.classList.add('focused'));
  track.addEventListener('blur', () => el.classList.remove('focused'));
  attachTooltip(track, () => format(bind.get()));
  // Clicking the control focuses the text box for typing a value.
  el.addEventListener('click', () => {
    if (disabled()) return;
    input.focus();
    input.select();
  });
  input.addEventListener('focus', () => {
    editing = true;
    el.classList.add('focused', 'editing');
  });
  const commit = () => {
    const parsed = parseFloat(input.value);
    if (Number.isFinite(parsed)) bind.set(snap(o.displayAsPercentage ? parsed / 100 : parsed));
    else bg.el.animate([{ boxShadow: 'inset 0 0 0 2.5px #f00' }, { boxShadow: 'none' }], { duration: 200 });
    editing = false;
    update();
    bg.flash();
  };
  input.addEventListener('blur', () => {
    el.classList.remove('focused', 'editing');
    if (editing) commit();
  });
  input.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') {
      editing = false;
      input.blur();
      update();
    }
  });
  update();
  return { el, main: el, terms: [text, o.hint ?? ''], isDefault: () => Math.abs(bind.get() - bind.default) < o.precision / 2, setDefault: () => bind.set(bind.default), isDisabled: disabled, update };
}

// ------------------------------------------------------------------ FormDropdown

export function formDropdown<T extends string | number>(text: string, bind: Bindable<T>, items: readonly (readonly [T, string])[], opts: CommonOptions = {}): FormControl {
  const bg = background();
  const label = h('div', { class: 'sf-label' });
  const chevron = iconEl(SETTINGS_ICONS.chevronDown, 'sf-chevron');
  const header = h('div', { class: 'sf sf-dropdown' }, bg.el, h('div', { class: 'sf-stack' }, text ? caption(text, opts.hint) : null, label), chevron);
  const menu = h('div', { class: 'sf-menu' });
  const el = h('div', { class: 'sf-dropdown-wrap' }, header, menu);
  const disabled = () => !!opts.unavailable || !!bind.disabled?.();
  let open = false;
  let hover = -1;
  const renderMenu = () => {
    menu.replaceChildren(
      ...items.map(([v, name], i) =>
        h(
          'div',
          {
            class: `sf-menu-item${v === bind.get() ? ' selected' : ''}${i === hover ? ' hover' : ''}`,
            onclick: (e: MouseEvent) => {
              e.stopPropagation();
              choose(v);
            },
            onpointerenter: () => {
              hover = i;
              markHover();
            },
          },
          name,
        ),
      ),
    );
  };
  const markHover = () => [...menu.children].forEach((c, i) => c.classList.toggle('hover', i === hover));
  const outside = (e: PointerEvent) => {
    if (!el.contains(e.target as Node)) setOpen(false);
  };
  const setOpen = (o: boolean) => {
    open = o && !disabled();
    header.classList.toggle('focused', open);
    el.classList.toggle('open', open);
    if (open) {
      hover = items.findIndex(([v]) => v === bind.get());
      renderMenu();
      document.addEventListener('pointerdown', outside, true);
    } else document.removeEventListener('pointerdown', outside, true);
  };
  const choose = (v: T) => {
    bind.set(v);
    setOpen(false);
    bg.flash();
    update();
  };
  header.tabIndex = 0;
  header.addEventListener('click', () => setOpen(!open));
  header.addEventListener('keydown', e => {
    if (disabled()) return;
    if (e.key === 'Enter' || e.key === ' ') {
      if (open && hover >= 0) choose(items[hover][0]);
      else setOpen(!open);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!open) setOpen(true);
      hover = Math.max(0, Math.min(items.length - 1, hover + (e.key === 'ArrowDown' ? 1 : -1)));
      markHover();
    } else if (e.key === 'Escape' && open) setOpen(false);
    else return;
    e.preventDefault();
    e.stopPropagation();
  });
  const update = () => {
    header.classList.toggle('disabled', disabled());
    label.textContent = items.find(([v]) => v === bind.get())?.[1] ?? String(bind.get());
    if (open) renderMenu();
  };
  update();
  return { el, main: header, terms: [text, opts.hint ?? '', ...items.map(i => i[1])], isDefault: () => bind.get() === bind.default, setDefault: () => bind.set(bind.default), isDisabled: disabled, update };
}

// ------------------------------------------------------------------ FormTextBox

export function formTextBox(text: string, bind: Bindable<string>, opts: CommonOptions & { placeholder?: string; maxLength?: number } = {}): FormControl {
  const bg = background();
  const input = h('input', { class: 'sf-textbox', type: 'text', placeholder: opts.placeholder ?? '', maxLength: opts.maxLength ?? 64 }) as HTMLInputElement;
  const el = h('div', { class: 'sf sf-text-control' }, bg.el, h('div', { class: 'sf-stack' }, caption(text, opts.hint), input));
  const disabled = () => !!opts.unavailable;
  input.addEventListener('focus', () => el.classList.add('focused'));
  input.addEventListener('blur', () => {
    el.classList.remove('focused');
    const v = input.value.trim();
    if (v !== bind.get()) {
      bind.set(v || bind.default);
      bg.flash();
    }
    update();
  });
  input.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter' || e.key === 'Escape') input.blur();
  });
  el.addEventListener('click', () => input.focus());
  const update = () => {
    if (document.activeElement !== input) input.value = bind.get();
    input.disabled = disabled();
    el.classList.toggle('disabled', disabled());
  };
  update();
  return { el, main: el, terms: [text], isDefault: () => bind.get() === bind.default, setDefault: () => bind.set(bind.default), isDisabled: disabled, update };
}

// ------------------------------------------------------------------ SettingsNote

export type NoteType = 'informational' | 'warning' | 'critical';

export function settingsNote(text: string, type: NoteType = 'informational'): HTMLElement {
  return h('div', { class: `st-note ${type}` }, h('div', { class: 'st-note-inner' }, text));
}

// ------------------------------------------------------------------ SettingsItemV2

export interface SettingsItem {
  el: HTMLElement;
  terms: string[];
  update(): void;
}

export function settingsItem(control: FormControl, opts: { keywords?: string[]; note?: () => { text: string; type?: NoteType } | null; unavailable?: string; showRevert?: boolean } = {}): SettingsItem {
  const revert = h('button', { class: 'st-revert', tabIndex: -1, 'aria-label': 'Revert to default' }, iconEl(SETTINGS_ICONS.undo, 'st-revert-icon'));
  attachTooltip(revert, () => 'Revert to default');
  revert.addEventListener('click', e => {
    e.stopPropagation();
    if (!control.isDisabled()) control.setDefault();
    control.update();
    update();
  });
  const noteWrap = h('div', { class: 'st-note-wrap' });
  const el = h('div', { class: 'st-item' }, h('div', { class: 'st-item-control' }, revert, h('div', { class: 'st-item-inner' }, control.el)), noteWrap);
  let lastNote = '';
  const update = () => {
    control.update();
    const show = opts.showRevert !== false && !control.isDefault() && !control.isDisabled();
    revert.classList.toggle('shown', show);
    revert.style.height = `${control.main.offsetHeight || 0}px`;
    const note = opts.unavailable ? { text: opts.unavailable, type: 'informational' as NoteType } : opts.note?.() ?? null;
    const key = note ? `${note.type}|${note.text}` : '';
    if (key !== lastNote) {
      lastNote = key;
      noteWrap.replaceChildren(...(note ? [settingsNote(note.text, note.type)] : []));
    }
  };
  // Size the revert button once laid out.
  requestAnimationFrame(update);
  update();
  return { el, terms: [...control.terms, ...(opts.keywords ?? [])], update };
}

// ------------------------------------------------------------------ SettingsButtonV2

export function settingsButton(text: string, action: () => void, opts: { dangerous?: boolean; tooltip?: string; unavailable?: string; keywords?: string[] } = {}): SettingsItem {
  const button = h('button', { class: `st-button${opts.dangerous ? ' dangerous' : ''}` }, h('span', null, text));
  if (opts.tooltip) attachTooltip(button, () => opts.tooltip!);
  button.disabled = !!opts.unavailable;
  button.addEventListener('click', e => {
    e.stopPropagation();
    if (!button.disabled) action();
  });
  const el = h('div', { class: 'st-button-item' }, button, opts.unavailable ? settingsNote(opts.unavailable) : null);
  return { el, terms: [text, opts.tooltip ?? '', ...(opts.keywords ?? [])], update: () => {} };
}

/** An arbitrary element taking part in search (for composite rows such as the skin buttons). */
export function customItem(el: HTMLElement, terms: string[], update: () => void = () => {}): SettingsItem {
  return { el, terms, update };
}
