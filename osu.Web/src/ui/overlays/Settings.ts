// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Settings overlay (SettingsOverlay essentials) including key binding configuration.

import { settings } from '../../framework/Settings';
import { availableRulesets } from '../../game/rulesets';
import type { Ruleset } from '../../game/rulesets/Ruleset';
import { clear, h, keyLabel } from '../dom';
import type { Game } from '../Game';
import { ATTRIBUTION, RULESET_DISPLAY_NAMES } from '../../brand';
import { skinSettingsSection } from './SkinSettings';
import { confirmDialog } from '../confirm';

function slider(label: string, key: string, min: number, max: number, step: number, format: (v: number) => string, hint?: string): HTMLElement {
  const value = h('span', { class: 'value' }, format(settings.get(key, 0)));
  const input = h('input', { type: 'range', min, max, step, value: String(settings.get(key, 0)) });
  input.addEventListener('input', () => {
    settings.set(key, parseFloat(input.value));
    value.textContent = format(parseFloat(input.value));
  });
  return h('div', { class: 'setting' }, h('label', null, label, hint ? h('div', { class: 'hint' }, hint) : null), h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center' } }, input, value));
}

function toggle(label: string, key: string, hint?: string): HTMLElement {
  const input = h('input', { type: 'checkbox', class: 'toggle' });
  input.checked = settings.get(key, false);
  input.addEventListener('change', () => settings.set(key, input.checked));
  return h('div', { class: 'setting' }, h('label', null, label, hint ? h('div', { class: 'hint' }, hint) : null), input);
}

function choice(label: string, key: string, options: [string, string][]): HTMLElement {
  const sel = h('select', { class: 'sort' }, options.map(([v, l]) => h('option', { value: v }, l)));
  sel.value = String(settings.get(key, options[0][0]));
  sel.addEventListener('change', () => settings.set(key, sel.value));
  return h('div', { class: 'setting' }, h('label', null, label), sel);
}

function text(label: string, key: string): HTMLElement {
  const input = h('input', { class: 'search', style: { maxWidth: '200px' }, value: settings.get(key, '') });
  input.addEventListener('change', () => settings.set(key, input.value.trim() || 'Guest'));
  return h('div', { class: 'setting' }, h('label', null, label), input);
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

export function openSettings(game: Game): void {
  let listening: { ruleset: Ruleset; variant: string | undefined; action: string; index: number; el: HTMLElement } | null = null;
  const bindingsWrap = h('div');
  const rulesetSelect = h('select', { class: 'sort' }, availableRulesets().map(r => h('option', { value: String(r.id) }, r.name)));
  rulesetSelect.value = String(game.ruleset.id);
  const variantSelect = h('select', { class: 'sort' });

  const variantsFor = (r: Ruleset): (string | undefined)[] => (r.shortName === 'mania' ? Array.from({ length: 10 }, (_, i) => `${i + 1}K`) : [undefined]);

  const renderBindings = () => {
    clear(bindingsWrap);
    const r = availableRulesets().find(x => String(x.id) === rulesetSelect.value) ?? game.ruleset;
    const variants = variantsFor(r);
    clear(variantSelect);
    for (const v of variants) variantSelect.appendChild(h('option', { value: v ?? '' }, v ?? 'Default'));
    if (!variants.includes(variantSelect.dataset.v || undefined)) variantSelect.dataset.v = variants[r.shortName === 'mania' ? 3 : 0] ?? '';
    variantSelect.value = variantSelect.dataset.v ?? '';
    variantSelect.style.display = variants.length > 1 ? '' : 'none';
    const variant = variantSelect.value || undefined;
    const defaults = r.defaultBindings(variant);
    const current = settings.getBindings(r.shortName, variant, defaults);
    for (const a of r.actions(variant)) {
      const keys = current[a.id] ?? [];
      const row = h('div', { class: 'binding-row' }, h('span', null, a.label));
      const keysEl = h('div', { class: 'binding-keys' });
      for (let i = 0; i < Math.max(2, keys.length); i++) {
        const btn = h('button', { class: 'binding-key' }, keys[i] ? keyLabel(keys[i]) : '—');
        btn.addEventListener('click', () => {
          listening?.el.classList.remove('listening');
          listening = { ruleset: r, variant, action: a.id, index: i, el: btn };
          btn.classList.add('listening');
          btn.textContent = 'press…';
        });
        btn.addEventListener('mousedown', e => {
          if (listening?.el === btn && e.button !== 0) {
            e.preventDefault();
            assign(`Mouse${e.button}`);
          }
        });
        btn.addEventListener('contextmenu', e => e.preventDefault());
        keysEl.appendChild(btn);
      }
      row.appendChild(keysEl);
      bindingsWrap.appendChild(row);
    }
    bindingsWrap.appendChild(
      h(
        'button',
        {
          class: 'btn small ghost',
          style: { marginTop: '8px' },
          onclick: () => {
            settings.reset(`bindings.${r.shortName}.${variant ?? 'default'}`);
            renderBindings();
          },
        },
        'Reset to defaults',
      ),
    );
  };

  const assign = (code: string | null) => {
    if (!listening) return;
    const { ruleset: r, variant, action, index } = listening;
    const current = { ...settings.getBindings(r.shortName, variant, r.defaultBindings(variant)) };
    for (const k of Object.keys(current)) current[k] = [...current[k]];
    // Remove the key from any other action.
    if (code) for (const k of Object.keys(current)) current[k] = current[k].filter(c => c !== code);
    const keys = current[action] ?? [];
    if (code) keys[index] = code;
    else keys.splice(index, 1);
    current[action] = keys.filter(Boolean);
    settings.setBindings(r.shortName, variant, current);
    listening = null;
    renderBindings();
  };

  rulesetSelect.addEventListener('change', () => {
    variantSelect.dataset.v = '';
    renderBindings();
  });
  variantSelect.addEventListener('change', () => {
    variantSelect.dataset.v = variantSelect.value;
    renderBindings();
  });
  renderBindings();

  const sheet = h(
    'div',
    { class: 'sheet scroll-thin' },
    h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } }, h('h2', null, 'Settings'), h('button', { class: 'btn small ghost', onclick: () => game.closeOverlay(el) }, 'Close')),
    h('div', { style: { color: 'var(--fg-dim)', fontSize: '13px' } }, 'Changes are saved automatically in this browser.'),

    h('h3', null, 'General'),
    text('Player name', 'ui.username'),
    toggle('Prefer metadata in original language', 'ui.preferUnicode'),

    h('h3', null, 'Audio'),
    slider('Master volume', 'audio.master', 0, 1, 0.01, pct),
    slider('Music volume', 'audio.music', 0, 1, 0.01, pct),
    slider('Effect volume', 'audio.effects', 0, 1, 0.01, pct),
    slider('Audio offset', 'audio.offset', -500, 500, 1, v => `${v}ms`, 'Positive values make hit objects appear later.'),
    toggle('Compensate for output latency', 'audio.compensateLatency', 'Uses the browser-reported audio output latency.'),

    h('h3', null, 'Gameplay'),
    slider('Background dim', 'gameplay.backgroundDim', 0, 1, 0.01, pct),
    toggle('Show HUD', 'gameplay.showHud'),
    toggle('Hit error meter', 'gameplay.hitErrorMeter'),
    toggle('Key overlay', 'gameplay.showKeyCounter'),
    toggle('Lighten during breaks', 'gameplay.lightenDuringBreaks'),
    toggle('Increase visibility of first object when visual impairment mods are enabled', 'gameplay.increaseFirstObjectVisibility'),
    toggle('Fade playfield to red when health is low', 'gameplay.fadePlayfieldWhenHealthLow'),
    toggle('Always play first combo break sound', 'gameplay.alwaysPlayFirstComboBreak'),
    toggle('Combo break sound', 'gameplay.comboBreakSound'),
    toggle('Disable mouse buttons during gameplay', 'gameplay.disableMouseButtons'),

    toggle('Storyboards & videos', 'gameplay.storyboard'),
    toggle('Beatmap skins', 'skin.beatmapSkins', 'Use skin elements and hitsounds included with beatmaps.'),
    skinSettingsSection(game),

    h('h3', null, RULESET_DISPLAY_NAMES[0]),
    slider('Cursor size', 'osu.cursorSize', 0.1, 2, 0.01, v => `${v.toFixed(2)}x`),
    toggle('Cursor trail', 'osu.cursorTrail'),
    toggle('Follow points', 'osu.followPoints'),
    toggle('Snaking in sliders', 'osu.snakingIn'),
    toggle('Snaking out sliders', 'osu.snakingOut'),
    toggle('Hit lighting', 'osu.hitLighting'),

    h('h3', null, RULESET_DISPLAY_NAMES[3]),
    slider('Scroll speed', 'mania.scrollSpeed', 1, 40, 1, v => String(v)),
    choice('Scroll direction', 'mania.scrollDirection', [
      ['down', 'Down'],
      ['up', 'Up'],
    ]),

    h('h3', null, RULESET_DISPLAY_NAMES[1]),
    toggle('Hit animations', 'taiko.hitAnimations'),
    toggle('Rate-adjusted hit animation', 'taiko.rateAdjustedHitAnimation'),
    toggle('Show combo on drum', 'taiko.drumCombo'),
    choice('Touch control scheme', 'taiko.touchControlScheme', [
      ['KDDK', 'KDDK'],
      ['DDKK', 'DDKK'],
      ['KKDD', 'KKDD'],
    ]),

    h('h3', null, RULESET_DISPLAY_NAMES[2]),
    toggle('Hit lighting', 'fruits.hitLighting'),
    slider('Positional hitsounds', 'fruits.positionalHitsoundsLevel', 0, 1, 0.05, pct),
    slider('Touch zone width', 'fruits.touchZoneWidth', 0.05, 0.5, 0.01, pct),

    h('h3', null, 'Graphics'),
    slider('Render resolution', 'graphics.renderScale', 0.5, 1, 0.05, pct, 'Lower this if gameplay stutters.'),
    toggle('Show FPS', 'graphics.showFps'),

    h('h3', null, 'Key bindings'),
    h('div', { class: 'setting' }, rulesetSelect, variantSelect),
    bindingsWrap,
    h('div', { class: 'hint', style: { color: 'var(--fg-faint)', fontSize: '12px', marginTop: '6px' } }, 'Click a key slot, then press a key or mouse button. Backspace clears the slot.'),

    h('h3', null, 'Maintenance'),
    h(
      'button',
      {
        class: 'btn danger small',
        onclick: async () => {
          if (!(await confirmDialog(game, 'Delete all imported beatmaps, scores and replays from this browser?', 'Delete everything'))) return;
          indexedDB.deleteDatabase('osu-web');
          location.reload();
        },
      },
      'Delete all beatmaps & scores',
    ),
    h('p', { style: { color: 'var(--fg-faint)', fontSize: '12px', lineHeight: '1.6', marginTop: '24px' } }, ATTRIBUTION),
  );

  const el = h(
    'div',
    {
      class: 'overlay',
      onclick: (e: MouseEvent) => {
        if (e.target === el) game.closeOverlay(el);
      },
    },
    sheet,
  );
  game.openOverlay(el, {
    onKey: e => {
      if (!listening) return false;
      if (e.code === 'Escape') {
        listening = null;
        renderBindings();
        return true;
      }
      assign(e.code === 'Backspace' ? null : e.code);
      return true;
    },
  });
}
