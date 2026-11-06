// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// In-page confirmation dialog (DialogOverlay / PopupDialog equivalent). Native confirm() is unavailable in sandboxed frames.

import { h } from './dom';
import type { Game } from './Game';

export function confirmDialog(game: Game, message: string, confirmLabel = 'Confirm', danger = true): Promise<boolean> {
  return new Promise(resolve => {
    let done = false;
    const finish = (value: boolean) => {
      if (done) return;
      done = true;
      game.closeOverlay(el);
      resolve(value);
    };
    const el = h(
      'div',
      { class: 'overlay center', onclick: (e: MouseEvent) => e.target === el && finish(false) },
      h(
        'div',
        { class: 'panel pause-menu', role: 'dialog', 'aria-modal': 'true', style: { padding: '24px' } },
        h('div', { style: { fontSize: '17px', fontWeight: '700', lineHeight: '1.5', marginBottom: '8px' } }, message),
        h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, onclick: () => finish(true) }, confirmLabel),
        h('button', { class: 'btn', onclick: () => finish(false) }, 'Cancel'),
      ),
    );
    game.openOverlay(el, {
      onKey: e => {
        if (e.code === 'Enter') finish(true);
        else if (e.code === 'Escape') finish(false);
        else return false;
        return true;
      },
      onClose: () => finish(false),
    });
  });
}
