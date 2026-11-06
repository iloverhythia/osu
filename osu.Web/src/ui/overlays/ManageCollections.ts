// Port of osu.Game/Collections/ManageCollectionsDialog.cs + DrawableCollectionList / DrawableCollectionListItem:
// a centred 50% × 80% dialog listing collections with editable names, item counts and delete buttons, a filter box,
// and a trailing "Create a new collection" placeholder row.

import './collections.css';
import { Collections } from '../../game/Collections';
import { confirmDialog } from '../confirm';
import { h } from '../dom';
import type { Game } from '../Game';

let open: HTMLElement | null = null;

export function openManageCollections(game: Game): void {
  if (open) return;
  const list = h('div', { class: 'mc-list' });
  const search = h('input', { class: 'mc-search', type: 'text', placeholder: 'type to search', spellcheck: false }) as HTMLInputElement;
  let term = '';

  const row = (c: ReturnType<typeof Collections.all>[number] | null): HTMLElement => {
    const input = h('input', { class: 'mc-name', type: 'text', value: c?.name ?? '', placeholder: c ? '' : 'Create a new collection', maxLength: 100 }) as HTMLInputElement;
    const count = h('div', { class: 'mc-count' }, c ? `${c.hashes.length} item${c.hashes.length === 1 ? '' : 's'}` : '');
    let committed = false;
    const commit = () => {
      if (committed) return;
      const name = input.value.trim();
      if (c) {
        if (name && name !== c.name) Collections.rename(c.id, name);
        else input.value = c.name;
      } else if (name) {
        committed = true;
        Collections.create(name);
        render();
        // Focus the new placeholder for quick entry of several collections.
        (list.querySelector('.mc-row.placeholder .mc-name') as HTMLInputElement | null)?.focus();
      }
    };
    input.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter') commit();
      if (e.key === 'Escape') input.blur();
    });
    input.addEventListener('blur', commit);
    const del = c
      ? h(
          'button',
          {
            class: 'mc-delete',
            title: 'Delete',
            onclick: async () => {
              // DeleteCollectionDialog only when the collection has items.
              if (c.hashes.length > 0 && !(await confirmDialog(game, `Are you sure you want to delete this collection? ${c.name} (${c.hashes.length} items)`, 'Yes. Go for it.'))) return;
              Collections.remove(c.id);
              render();
            },
          },
          '✕',
        )
      : null;
    return h('div', { class: `mc-row${c ? '' : ' placeholder'}` }, h('div', { class: 'mc-field' }, input, count), del);
  };

  const render = () => {
    const words = term.toLowerCase().split(/\s+/).filter(Boolean);
    const collections = Collections.all().filter(c => words.every(w => c.name.toLowerCase().includes(w)));
    list.replaceChildren(...collections.map(c => row(c)), row(null));
  };

  search.addEventListener('input', () => {
    term = search.value;
    render();
  });
  search.addEventListener('keydown', e => {
    if (e.key !== 'Escape') e.stopPropagation();
  });

  const close = () => {
    open = null;
    game.closeOverlay(el);
  };
  const dialog = h(
    'div',
    { class: 'mc-dialog', onclick: (e: MouseEvent) => e.stopPropagation() },
    h('div', { class: 'mc-header' }, h('div', { class: 'mc-title' }, 'Manage Collections'), h('button', { class: 'mc-close', onclick: close, title: 'Close' }, '✕')),
    h('div', { class: 'mc-body' }, search, list),
  );
  const el = h('div', { class: 'overlay center mc-overlay', onclick: close }, dialog);
  open = el;
  render();
  game.openOverlay(el, {
    capture: true,
    onClose: () => (open = null),
    onKey: e => {
      if (e.code === 'Escape') {
        close();
        return true;
      }
      return false;
    },
  });
  search.focus();
}
