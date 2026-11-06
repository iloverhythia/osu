// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Mod select overlay (ModSelectOverlay essentials).

import { MODS, MOD_TYPE_COLOURS, ModDef, ModType } from '../../game/mods/Mods';
import { clear, h } from '../dom';
import type { Game } from '../Game';

const COLUMNS: { type: ModType; title: string }[] = [
  { type: 'reduction', title: 'Difficulty reduction' },
  { type: 'increase', title: 'Difficulty increase' },
  { type: 'conversion', title: 'Conversion' },
  { type: 'automation', title: 'Automation' },
];

const HOTKEYS: Record<string, string> = {
  KeyQ: 'EZ',
  KeyW: 'NF',
  KeyE: 'HT',
  KeyA: 'HR',
  KeyS: 'SD',
  KeyD: 'DT',
  KeyF: 'HD',
  KeyG: 'FL',
  KeyZ: 'RX',
  KeyX: 'AP',
  KeyC: 'SO',
  KeyV: 'AT',
};

export function openModSelect(game: Game): void {
  const r = game.ruleset;
  const available = MODS.filter(m => r.availableMods.includes(m.acronym) && (!m.rulesets || m.rulesets.includes(r.shortName)));
  const multiplier = h('span', { style: { fontWeight: '800', color: 'var(--yellow)' } });
  const columns = h('div', { class: 'mod-columns' });

  const toggle = (m: ModDef) => {
    game.setMods(game.mods.toggle(m.acronym));
    game.playUiSample('menu-click', 0.5);
    render();
  };

  const render = () => {
    clear(columns);
    for (const col of COLUMNS) {
      const mods = available.filter(m => m.type === col.type);
      if (mods.length === 0) continue;
      columns.appendChild(
        h(
          'div',
          { class: 'mod-column' },
          h('h4', { style: { color: MOD_TYPE_COLOURS[col.type] } }, col.title),
          mods.map(m => {
            const on = game.mods.has(m.acronym);
            const hotkey = Object.entries(HOTKEYS).find(([, a]) => a === m.acronym)?.[0]?.slice(3);
            return h(
              'button',
              { class: `mod-button${on ? ' on' : ''}`, onclick: () => toggle(m), title: hotkey ? `Hotkey: ${hotkey}` : undefined },
              h('span', { class: 'acr', style: on ? { background: MOD_TYPE_COLOURS[m.type] } : {} }, m.acronym),
              h('span', null, h('div', { class: 'name' }, m.name), h('div', { class: 'desc' }, m.description)),
            );
          }),
        ),
      );
    }
    multiplier.textContent = `${game.ruleset.scoreMultiplier(game.mods).toFixed(2)}x`;
  };
  render();

  const el = h(
    'div',
    {
      class: 'overlay center',
      onclick: (e: MouseEvent) => {
        if (e.target === el) game.closeOverlay(el);
      },
    },
    h(
      'div',
      { class: 'panel mod-select scroll-thin' },
      h(
        'div',
        { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px', gap: '12px', flexWrap: 'wrap' } },
        h('h2', { style: { margin: '0' } }, 'Mods'),
        h('div', { style: { display: 'flex', gap: '12px', alignItems: 'center' } }, 'Score multiplier: ', multiplier),
        h(
          'div',
          { style: { display: 'flex', gap: '8px' } },
          h(
            'button',
            {
              class: 'btn small ghost',
              onclick: () => {
                game.setMods(game.mods.forRuleset(r.shortName, []));
                render();
              },
            },
            'Deselect all',
          ),
          h('button', { class: 'btn small primary', onclick: () => game.closeOverlay(el) }, 'Done'),
        ),
      ),
      columns,
    ),
  );
  game.openOverlay(el, {
    onKey: e => {
      if (e.code === 'F1' || e.code === 'Enter') {
        game.closeOverlay(el);
        return true;
      }
      const acr = HOTKEYS[e.code];
      const def = acr ? available.find(m => m.acronym === acr) : undefined;
      if (def && !e.ctrlKey && !e.metaKey) {
        toggle(def);
        return true;
      }
      return false;
    },
  });
}
