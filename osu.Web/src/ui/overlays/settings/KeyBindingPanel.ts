// Port of KeyBindingPanel (a SettingsSubPanel): one RulesetBindingsSection per ruleset, a VariantBindingsSubsection
// per variant (mania key counts), KeyBindingRows with KeyButtons, and "Reset all bindings in section".

import { RULESET_DISPLAY_NAMES } from '../../../brand';
import { settings } from '../../../framework/Settings';
import { availableRulesets } from '../../../game/rulesets';
import type { Ruleset } from '../../../game/rulesets/Ruleset';
import { h, keyLabel } from '../../dom';
import type { Game } from '../../Game';
import { rulesetIcon } from '../../select/Icons';
import { attachTooltip } from './controls';
import { iconEl, SETTINGS_ICONS } from './icons';
import { createSidebar, SidebarEntry } from './SettingsOverlay';

interface Listening {
  ruleset: Ruleset;
  variant: string | undefined;
  action: string;
  index: number;
  finish: () => void;
}

const variantsFor = (r: Ruleset): (string | undefined)[] => (r.shortName === 'mania' ? Array.from({ length: 10 }, (_, i) => `${i + 1}K`) : [undefined]);

export function createKeyBindingPanel(game: Game, back: () => void): { el: HTMLElement; destroy: () => void; onKey: (e: KeyboardEvent) => boolean } {
  let listening: Listening | null = null;
  const refreshers: (() => void)[] = [];

  const bindingsOf = (r: Ruleset, v: string | undefined) => settings.getBindings(r.shortName, v, r.defaultBindings(v));

  const assign = (code: string | null) => {
    if (!listening) return;
    const { ruleset: r, variant, action, index } = listening;
    const current: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(bindingsOf(r, variant))) current[k] = [...v];
    // A key can only be bound to one action of a ruleset variant.
    if (code) for (const k of Object.keys(current)) if (k !== action) current[k] = current[k].filter(c => c !== code);
    const keys = current[action] ?? [];
    if (code) keys[index] = code;
    else keys.splice(index, 1);
    current[action] = keys.filter(Boolean);
    settings.setBindings(r.shortName, variant, current);
    const l = listening;
    listening = null;
    l.finish();
    refreshers.forEach(f => f());
  };

  /** KeyBindingRow */
  const row = (r: Ruleset, variant: string | undefined, action: { id: string; label: string }) => {
    const buttons = h('div', { class: 'kb-buttons' });
    const pending = h('div', { class: 'kb-pending' }, h('span', { class: 'kb-pending-text' }, 'Press a key combination to set a new binding...'), h('button', { class: 'st-button kb-small', onclick: () => cancel() }, h('span', null, 'Cancel')), h('button', { class: 'st-button dangerous kb-small', onclick: () => assign(null) }, h('span', null, 'Clear binding')));
    const bg = h('div', { class: 'sf-bg' });
    const content = h('div', { class: 'kb-content' }, bg, h('div', { class: 'kb-grid' }, h('div', { class: 'sf-caption kb-caption' }, action.label), buttons), pending);
    const revert = h('button', { class: 'st-revert', tabIndex: -1 }, iconEl(SETTINGS_ICONS.undo, 'st-revert-icon'));
    attachTooltip(revert, () => 'Revert to default');
    const el = h('div', { class: 'kb-row' }, revert, content);
    const cancel = () => {
      const l = listening;
      listening = null;
      l?.finish();
      render();
    };
    revert.addEventListener('click', () => {
      const current = { ...bindingsOf(r, variant), [action.id]: [...(r.defaultBindings(variant)[action.id] ?? [])] };
      settings.setBindings(r.shortName, variant, current);
      refreshers.forEach(f => f());
    });
    const render = () => {
      const keys = bindingsOf(r, variant)[action.id] ?? [];
      const defaults = r.defaultBindings(variant)[action.id] ?? [];
      const isListening = listening?.action === action.id && listening.ruleset === r && listening.variant === variant;
      el.classList.toggle('listening', isListening);
      content.classList.toggle('focused', isListening);
      buttons.replaceChildren(
        ...Array.from({ length: Math.max(defaults.length, keys.length, 1) }, (_, i) => {
          const selected = isListening && listening!.index === i;
          const b = h('button', { class: `kb-key${selected ? ' selected' : ''}` }, keys[i] ? keyLabel(keys[i]) : '');
          b.addEventListener('click', e => {
            e.stopPropagation();
            if (selected) return;
            const prev = listening;
            listening = { ruleset: r, variant, action: action.id, index: i, finish: render };
            prev?.finish();
            render();
          });
          // Mouse buttons can be bound by pressing them on the selected key button.
          b.addEventListener('mousedown', e => {
            if (selected && e.button !== 0) {
              e.preventDefault();
              assign(`Mouse${e.button}`);
            }
          });
          b.addEventListener('contextmenu', e => e.preventDefault());
          return b;
        }),
      );
      revert.classList.toggle('shown', JSON.stringify(keys) !== JSON.stringify(defaults));
      requestAnimationFrame(() => (revert.style.height = `${content.offsetHeight}px`));
    };
    refreshers.push(render);
    render();
    return el;
  };

  const sections: { entry: SidebarEntry; el: HTMLElement }[] = [];
  for (const r of availableRulesets()) {
    const name = RULESET_DISPLAY_NAMES[r.id] ?? r.name;
    const subs = variantsFor(r).map(variant => {
      const rows = r.actions(variant).map(a => row(r, variant, a));
      const reset = h(
        'button',
        {
          class: 'st-button dangerous',
          onclick: () => {
            settings.reset(`bindings.${r.shortName}.${variant ?? 'default'}`);
            refreshers.forEach(f => f());
          },
        },
        h('span', null, 'Reset all bindings in section'),
      );
      return h('div', { class: 'st-subsection' }, variant ? h('div', { class: 'st-subsection-header' }, variant) : null, h('div', { class: 'st-subsection-flow' }, ...rows, h('div', { class: 'st-button-item' }, reset)));
    });
    const el = h('section', { class: 'st-section current' }, h('div', { class: 'st-section-separator' }), h('div', { class: 'st-section-body' }, h('div', { class: 'st-section-header' }, name), h('div', { class: 'st-section-flow' }, ...subs)));
    sections.push({ entry: { header: name, icon: () => rulesetIcon(r.id, 20), small: false, el }, el });
  }

  const header = h('div', { class: 'st-header' }, h('div', { class: 'st-header-title' }, 'key configuration'), h('div', { class: 'st-header-subtitle' }, 'Customise your keys!'));
  const scroll = h('div', { class: 'st-scroll' }, header, h('div', { class: 'st-sections' }, ...sections.map(s => s.el)));
  const content = h('div', { class: 'st-content' }, h('div', { class: 'st-content-bg' }), scroll);
  const sidebar = createSidebar(
    sections.map(s => s.entry),
    e => scroll.scrollTo({ top: e.el.offsetTop, behavior: 'smooth' }),
    back,
  );
  const updateSelected = () => {
    const top = scroll.scrollTop + scroll.clientHeight * 0.1;
    let sel = sections[0];
    for (const s of sections) if (s.el.offsetTop <= top) sel = s;
    if (scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 2) sel = sections[sections.length - 1];
    sidebar.setSelected(sel.entry);
  };
  scroll.addEventListener('scroll', updateSelected);
  requestAnimationFrame(updateSelected);
  const el = h('div', { class: 'st-subpanel' }, content, sidebar.el);

  return {
    el,
    destroy: () => {
      listening = null;
    },
    onKey: e => {
      if (!listening) return false;
      if (e.code === 'Escape') {
        const l = listening;
        listening = null;
        l.finish();
        return true;
      }
      assign(e.code);
      return true;
    },
  };
}
