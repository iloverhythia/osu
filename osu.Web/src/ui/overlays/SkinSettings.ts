// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Skin section of the settings overlay (SkinSection: current skin dropdown, import, delete).

import { settings } from '../../framework/Settings';
import { ACTIVE_SKIN_SETTING, deleteSkin, listSkins, SkinStore, type SkinInfo } from '../../game/skinning';
import { confirmDialog } from '../confirm';
import { clear, h } from '../dom';
import type { Game } from '../Game';

export function skinSettingsSection(game: Game): HTMLElement | null {
  const select = h('select', { class: 'sort', style: { maxWidth: '260px' } });
  const info = h('div', { class: 'hint' });
  const deleteButton = h('button', { class: 'btn danger small' }, 'Delete skin');
  let skins: SkinInfo[] = [];

  const current = () => settings.get<string | null>(ACTIVE_SKIN_SETTING, null);

  const render = () => {
    clear(select);
    select.appendChild(h('option', { value: '' }, 'Default (procedural)'));
    for (const s of skins) select.appendChild(h('option', { value: s.id }, s.name));
    const id = current();
    const selected = skins.find(s => s.id === id);
    select.value = selected ? selected.id : '';
    info.textContent = selected ? `by ${selected.creator}` : skins.length === 0 ? 'Import an osu!stable skin (.osk) to use its elements and hitsounds.' : '';
    deleteButton.disabled = !selected;
  };

  const refresh = async () => {
    try {
      skins = await listSkins();
    } catch {
      skins = [];
      info.textContent = 'Skin storage is unavailable in this browser.';
    }
    render();
  };

  select.addEventListener('change', () => settings.set(ACTIVE_SKIN_SETTING, select.value || null));

  deleteButton.addEventListener('click', async () => {
    const id = current();
    const skin = skins.find(s => s.id === id);
    if (!skin) return;
    if (!(await confirmDialog(game, `Delete the skin "${skin.name}"?`, 'Delete'))) return;
    try {
      await deleteSkin(skin.id);
      game.toast(`Deleted skin "${skin.name}"`, 'success');
    } catch (e) {
      game.toast(`Couldn't delete skin: ${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  });

  const el = h(
    'div',
    { class: 'skin-settings' },
    h('h3', null, 'Skin'),
    h('div', { class: 'setting' }, h('label', null, 'Current skin', info), select),
    h(
      'div',
      { class: 'setting' },
      h('label', null, 'Skin files', h('div', { class: 'hint' }, 'osu!stable skins (.osk) are supported. Missing elements use the default skin.')),
      h('div', { style: { display: 'flex', gap: '8px' } }, h('button', { class: 'btn small ghost', onclick: () => game.openFilePicker() }, 'Import .osk'), deleteButton),
    ),
  );

  // Keep in sync with imports (from the file picker or drag & drop) and selection changes while the overlay is open.
  let seenConnected = false;
  const unsubscribeStore = SkinStore.subscribe(() => {
    if (!alive()) return;
    void refresh();
  });
  const unsubscribeSettings = settings.subscribe(key => {
    if (key === ACTIVE_SKIN_SETTING && alive()) render();
  });
  const alive = () => {
    if (el.isConnected) seenConnected = true;
    else if (seenConnected) {
      unsubscribeStore();
      unsubscribeSettings();
      return false;
    }
    return true;
  };

  render();
  void refresh();
  return el;
}
