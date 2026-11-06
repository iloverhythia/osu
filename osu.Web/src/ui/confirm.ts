// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game/Overlays/DialogOverlay.cs + Dialog/PopupDialog.cs and its buttons (PopupDialogOkButton (Pink),
// PopupDialogCancelButton (Blue), PopupDialogDangerousButton (Red3, hold to confirm)) over DialogButton:
// a 500-wide rounded panel (#221a21 with triangles) with an icon ring, header (25), body (18) and full-width
// 50-high buttons whose sheared colour bar widens from 80% to 90% on hover.

import './dialog.css';
import { settings } from '../framework/Settings';
import { h } from './dom';
import type { Game } from './Game';

export type DialogButtonType = 'ok' | 'cancel' | 'danger';

export interface DialogButton {
  text: string;
  type: DialogButtonType;
  action?: () => void;
}

export interface PopupDialogOptions {
  /** FontAwesome-like glyph shown in the ring. */
  icon?: string;
  header: string;
  body?: string;
  buttons: DialogButton[];
}

/** FontAwesome Solid glyphs used by PopupDialogs (QuestionCircle, ExclamationTriangle, TrashAlt, Save, TimesCircle, SignOutAlt). */
const ICONS: Record<string, [string, string]> = {
  question: ['0 0 384 512', 'M202 0C122 0 70 33 29 91c-7 11-5 25 5 33l43 33c10 8 25 6 33-4 25-31 43-48 82-48 30 0 68 20 68 49 0 22-18 34-48 51-35 20-81 44-81 104v10c0 13 11 24 24 24h72c13 0 24-11 24-24v-6c0-41 120-43 120-155C371 74 285 0 202 0zm-10 360c-37 0-67 30-67 67s30 67 67 67 67-30 67-67-30-67-67-67z'],
  warning: ['0 0 576 512', 'M570 440c18 32-5 72-42 72H48c-37 0-60-40-42-72L246 24c18-32 66-32 84 0l240 416zM288 354c-25 0-46 21-46 46s21 46 46 46 46-21 46-46-21-46-46-46zm-44-165 8 136c0 6 6 11 12 11h48c6 0 12-5 12-11l8-136c0-7-5-13-12-13h-64c-7 0-12 6-12 13z'],
  trash: ['0 0 448 512', 'M32 464a48 48 0 0 0 48 48h288a48 48 0 0 0 48-48V128H32zm272-256a16 16 0 0 1 32 0v224a16 16 0 0 1-32 0zm-96 0a16 16 0 0 1 32 0v224a16 16 0 0 1-32 0zm-96 0a16 16 0 0 1 32 0v224a16 16 0 0 1-32 0zM432 32H312l-9-19A24 24 0 0 0 281 0H167a24 24 0 0 0-22 13l-9 19H16A16 16 0 0 0 0 48v32a16 16 0 0 0 16 16h416a16 16 0 0 0 16-16V48a16 16 0 0 0-16-16z'],
  save: ['0 0 448 512', 'M434 130 350 46A48 48 0 0 0 316 32H48A48 48 0 0 0 0 80v352a48 48 0 0 0 48 48h352a48 48 0 0 0 48-48V164a48 48 0 0 0-14-34zM224 416a64 64 0 1 1 64-64 64 64 0 0 1-64 64zm96-304v100a12 12 0 0 1-12 12H76a12 12 0 0 1-12-12V108a12 12 0 0 1 12-12h228a12 12 0 0 1 8 4l4 3a12 12 0 0 1 4 9z'],
  times: ['0 0 512 512', 'M256 8a248 248 0 1 0 0 496 248 248 0 0 0 0-496zm121 313c5 5 5 12 0 17l-39 39c-5 5-12 5-17 0l-65-65-65 65c-5 5-12 5-17 0l-39-39c-5-5-5-12 0-17l65-65-65-65c-5-5-5-12 0-17l39-39c5-5 12-5 17 0l65 65 65-65c5-5 12-5 17 0l39 39c5 5 5 12 0 17l-65 65z'],
  exit: ['0 0 512 512', 'M497 273 329 441c-15 15-41 4-41-17v-96H152c-13 0-24-11-24-24v-96c0-13 11-24 24-24h136V88c0-21 26-32 41-17l168 168c9 10 9 24 0 34zM192 436v-40c0-7-5-12-12-12H96c-18 0-32-14-32-32V160c0-18 14-32 32-32h84c7 0 12-5 12-12V76c0-7-5-12-12-12H96c-53 0-96 43-96 96v192c0 53 43 96 96 96h84c7 0 12-5 12-12z'],
};

function iconSvg(name: string): SVGSVGElement {
  const [viewBox, d] = ICONS[name] ?? ICONS.question;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', viewBox);
  svg.innerHTML = `<path d="${d}"/>`;
  return svg;
}

/** DialogOverlay.Push(PopupDialog). Resolves with the index of the pressed button (-1 when dismissed). */
export function popupDialog(game: Game, o: PopupDialogOptions): Promise<number> {
  return new Promise(resolve => {
    let done = false;
    const finish = (index: number) => {
      if (done) return;
      done = true;
      panel.classList.add('leaving');
      setTimeout(() => game.closeOverlay(el), 200);
      if (index >= 0) o.buttons[index].action?.();
      resolve(index);
    };
    const buttons = o.buttons.map((b, i) => dialogButton(b, () => finish(i)));
    const panel = h(
      'div',
      { class: 'pd-panel', role: 'dialog', 'aria-modal': 'true' },
      h('div', { class: 'pd-bg' }),
      h(
        'div',
        { class: 'pd-content' },
        h('div', { class: 'pd-ring' }, h('span', { class: 'pd-icon' }, iconSvg(o.icon ?? 'question'))),
        h('div', { class: 'pd-header' }, o.header),
        o.body ? h('div', { class: `pd-body${o.body.includes('\n') ? ' left' : ''}` }, o.body) : null,
        h('div', { class: 'pd-buttons' }, ...buttons),
      ),
    );
    const el = h('div', { class: 'overlay pd-overlay', onclick: (e: MouseEvent) => e.target === el && finish(o.buttons.findIndex(b => b.type === 'cancel')) }, panel);
    game.openOverlay(el, {
      capture: true,
      onKey: e => {
        // PopupDialog.OnPressed: number keys press the matching button; Select presses the first; Back the last cancel.
        const n = /^Digit([1-9])$/.exec(e.code);
        if (n && Number(n[1]) <= o.buttons.length && o.buttons[Number(n[1]) - 1].type !== 'danger') {
          finish(Number(n[1]) - 1);
          return true;
        }
        if (e.code === 'Enter' || e.code === 'NumpadEnter') {
          if (o.buttons[0]?.type !== 'danger') finish(0);
          return true;
        }
        if (e.code === 'Escape') {
          finish(o.buttons.findIndex(b => b.type === 'cancel'));
          return true;
        }
        return false;
      },
      onClose: () => finish(-1),
    });
  });
}

function dialogButton(b: DialogButton, press: () => void): HTMLElement {
  const fill = h('div', { class: 'pd-hold' });
  const el = h('button', { class: `pd-button ${b.type}` }, h('div', { class: 'pd-glow' }), h('div', { class: 'pd-bar' }, fill), h('span', { class: 'pd-text' }, b.text));
  if (b.type !== 'danger') {
    el.addEventListener('click', press);
    return el;
  }
  // PopupDialogDangerousButton: hold to confirm (HoldToConfirmContainer).
  let start = 0;
  let raf = 0;
  const delay = Math.max(1, settings.get<number>('ui.holdActivationDelay', 200));
  const tick = () => {
    const p = Math.min(1, (performance.now() - start) / delay);
    fill.style.width = `${p * 100}%`;
    if (p >= 1) {
      release();
      press();
      return;
    }
    raf = requestAnimationFrame(tick);
  };
  const begin = () => {
    start = performance.now();
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(tick);
  };
  const release = () => {
    cancelAnimationFrame(raf);
    fill.style.width = '0%';
  };
  el.addEventListener('pointerdown', begin);
  el.addEventListener('pointerup', release);
  el.addEventListener('pointerleave', release);
  el.addEventListener('keydown', e => {
    if ((e.code === 'Enter' || e.code === 'Space') && !e.repeat) begin();
  });
  el.addEventListener('keyup', release);
  return el;
}

/** ConfirmDialog / DangerousActionDialog. */
export async function confirmDialog(game: Game, message: string, confirmLabel = 'Confirm', danger = true): Promise<boolean> {
  const index = await popupDialog(game, {
    icon: danger ? 'warning' : 'question',
    header: message,
    buttons: [
      { text: confirmLabel, type: danger ? 'danger' : 'ok' },
      { text: 'Cancel', type: 'cancel' },
    ],
  });
  return index === 0;
}
