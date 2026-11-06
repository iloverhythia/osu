// Port of osu.Game/Screens/Edit/Components/Menus/EditorMenuBar.cs (+ EditorMenuItem, OsuMenuItemSpacer, ToggleMenuItem):
// the "osu!editor" label followed by top-level menus that open on click and switch on hover while one is open.
// Items show their hotkey, can be disabled, destructive (red), toggles (checkbox) or nest sub-menus.

import { APP_NAME } from '../../brand';
import { h } from '../dom';

export interface EditorMenuItem {
  text?: string;
  hotkey?: string;
  action?: () => void;
  items?: EditorMenuItem[];
  type?: 'standard' | 'destructive';
  disabled?: boolean;
  checked?: boolean;
  spacer?: boolean;
}

export interface EditorMenu {
  title: string;
  items: EditorMenuItem[];
}

export function editorMenuBar(build: () => EditorMenu[]): { el: HTMLElement; update: () => void } {
  const bar = h('div', { class: 'ed-menubar' });
  const logo = h('div', { class: 'ed-menubar-logo' }, h('span', null, APP_NAME.toLowerCase()), h('span', { class: 'ed-logo-accent' }, 'editor'));
  let openIndex = -1;
  let popup: HTMLElement | null = null;

  const closeAll = () => {
    popup?.remove();
    popup = null;
    openIndex = -1;
    for (const b of bar.querySelectorAll('.ed-menu-title')) b.classList.remove('open');
    document.removeEventListener('pointerdown', outside, true);
  };
  const outside = (e: PointerEvent) => {
    const t = e.target as Element;
    if (!t.closest('.ed-menu-popup') && !t.closest('.ed-menu-title')) closeAll();
  };

  const renderItems = (items: EditorMenuItem[], depth: number): HTMLElement => {
    const list = h('div', { class: `ed-menu-popup${depth > 0 ? ' sub' : ''}` });
    let sub: HTMLElement | null = null;
    for (const it of items) {
      if (it.spacer) {
        list.appendChild(h('div', { class: 'ed-menu-spacer' }));
        continue;
      }
      const row = h(
        'div',
        { class: `ed-menu-item${it.type === 'destructive' ? ' destructive' : ''}${it.disabled ? ' disabled' : ''}${it.items ? ' has-items' : ''}` },
        it.checked != null ? h('span', { class: `ed-menu-check${it.checked ? ' on' : ''}` }) : null,
        h('span', { class: 'ed-menu-text' }, it.text ?? ''),
        it.hotkey ? h('span', { class: 'ed-menu-hotkey' }, it.hotkey) : null,
        it.items ? h('span', { class: 'ed-menu-arrow' }, '›') : null,
      );
      row.addEventListener('pointerenter', () => {
        sub?.remove();
        sub = null;
        if (it.items && !it.disabled) {
          sub = renderItems(it.items, depth + 1);
          row.appendChild(sub);
          // Keep sub-menus on screen.
          const r = sub.getBoundingClientRect();
          if (r.right > innerWidth) sub.classList.add('flip');
        }
      });
      row.addEventListener('click', e => {
        e.stopPropagation();
        if (it.disabled || it.items) return;
        closeAll();
        it.action?.();
      });
      list.appendChild(row);
    }
    return list;
  };

  const open = (index: number, anchor: HTMLElement) => {
    popup?.remove();
    for (const b of bar.querySelectorAll('.ed-menu-title')) b.classList.remove('open');
    openIndex = index;
    anchor.classList.add('open');
    const menus = build();
    popup = renderItems(menus[index].items, 0);
    document.body.appendChild(popup);
    const r = anchor.getBoundingClientRect();
    popup.style.left = `${r.left}px`;
    popup.style.top = `${r.bottom}px`;
    document.addEventListener('pointerdown', outside, true);
  };

  const update = () => {
    const menus = build();
    bar.replaceChildren(
      logo,
      ...menus.map((m, i) => {
        const b = h('button', { class: `ed-menu-title${i === openIndex ? ' open' : ''}` }, m.title);
        b.addEventListener('click', () => (openIndex === i ? closeAll() : open(i, b)));
        b.addEventListener('pointerenter', () => {
          if (openIndex >= 0 && openIndex !== i) open(i, b);
        });
        return b;
      }),
    );
  };
  update();
  return { el: bar, update };
}
