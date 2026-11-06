// Port of osu.Game/Overlays/NotificationOverlay.cs, NotificationOverlayToastTray.cs and Notifications/*
// (Notification, SimpleNotification, SimpleErrorNotification, ProgressNotification, ProgressCompletionNotification,
// NotificationSection): new notifications pop up as toasts in the tray at the top right and move into the overlay
// (320 wide, purple Background4) after 2.5s (12s for important ones) unless hovered. The overlay lists them under
// "Notifications" (Clear All) and "Running Tasks" (Cancel All); the toolbar button shows the unread count.

import './notifications.css';
import { h } from '../dom';

export type NotificationKind = 'info' | 'error' | 'success' | 'progress';

export interface NotificationHandle {
  /** ProgressNotification.Progress (0..1). */
  setProgress(p: number): void;
  setText(text: string): void;
  /** ProgressNotification.State = Completed: becomes a ProgressCompletionNotification. */
  complete(text: string, onClick?: () => void): void;
  /** ProgressNotification.State = Cancelled */
  fail(text: string): void;
  close(): void;
}

interface Entry {
  el: HTMLElement;
  kind: NotificationKind;
  read: boolean;
  important: boolean;
  closed: boolean;
  inTray: boolean;
  hovered: boolean;
}

const ICONS: Record<NotificationKind, string> = {
  info: '<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-6h2zm0-8h-2V7h2z"/>',
  error: '<path d="M14.5 2.5l1.6 1.6-1.9 1.9A8 8 0 1 1 11 5.1l1.9-1.9zM9 8.5A4.5 4.5 0 0 0 7 12h2a2.5 2.5 0 0 1 1-2z"/><path d="M18 1l1 2 2 1-2 1-1 2-1-2-2-1 2-1z"/>',
  success: '<path d="M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/>',
  progress: '<path d="M12 4V1L8 5l4 4V6a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z"/>',
};
const icon = (kind: NotificationKind) => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.innerHTML = ICONS[kind];
  return s;
};

export class NotificationOverlay {
  readonly tray: HTMLElement;
  readonly panel: HTMLElement;
  private readonly generalList: HTMLElement;
  private readonly tasksList: HTMLElement;
  private readonly generalCount: HTMLElement;
  private readonly tasksCount: HTMLElement;
  private readonly entries = new Set<Entry>();
  private readonly listeners = new Set<() => void>();
  private open = false;

  constructor(host: HTMLElement) {
    this.tray = h('div', { class: 'nt-tray' });
    this.generalCount = h('span', { class: 'nt-section-count' });
    this.tasksCount = h('span', { class: 'nt-section-count' });
    this.generalList = h('div', { class: 'nt-list' });
    this.tasksList = h('div', { class: 'nt-list' });
    const section = (title: string, count: HTMLElement, clearText: string, list: HTMLElement, clear: () => void) =>
      h(
        'div',
        { class: 'nt-section' },
        h('div', { class: 'nt-section-header' }, h('span', { class: 'nt-section-title' }, title.toUpperCase(), ' ', count), h('button', { class: 'nt-clear', onclick: clear }, clearText.toUpperCase())),
        list,
      );
    this.panel = h(
      'div',
      { class: 'nt-overlay', onpointerdown: (e: PointerEvent) => e.stopPropagation() },
      h('div', { class: 'nt-scroll' }, section('Notifications', this.generalCount, 'Clear All', this.generalList, () => this.clearAll('general')), section('Running Tasks', this.tasksCount, 'Cancel All', this.tasksList, () => this.clearAll('tasks'))),
    );
    host.append(this.tray, this.panel);
    document.addEventListener('pointerdown', e => {
      if (!this.open) return;
      const t = e.target as Element;
      if (!this.panel.contains(t) && !t.closest?.('.tb-notifications')) this.hide();
    });
    this.updateCounts();
  }

  get isOpen(): boolean {
    return this.open;
  }

  /** NotificationOverlay.OngoingOperations: the running tasks' texts. */
  get ongoingOperations(): string[] {
    return [...this.entries].filter(e => e.kind === 'progress' && !e.closed).map(e => e.el.querySelector('.nt-text')?.textContent ?? '');
  }

  /** NotificationOverlay.UnreadCount */
  get unreadCount(): number {
    let n = 0;
    for (const e of this.entries) if (!e.read && !e.closed && !e.inTray) n++;
    return n + [...this.entries].filter(e => e.inTray && !e.closed).length;
  }

  subscribe(l: () => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private emit(): void {
    this.updateCounts();
    for (const l of this.listeners) l();
  }

  toggle(): void {
    if (this.open) this.hide();
    else this.show();
  }

  show(): void {
    if (this.open) return;
    this.open = true;
    // FlushAllToasts + MarkAllRead
    for (const e of this.entries) if (e.inTray) this.forward(e, false);
    for (const e of this.entries) e.read = true;
    for (const e of this.entries) e.el.classList.remove('unread');
    this.panel.classList.add('shown');
    this.emit();
  }

  hide(): void {
    if (!this.open) return;
    this.open = false;
    this.panel.classList.remove('shown');
    this.emit();
  }

  /** NotificationOverlay.Post */
  post(text: string, kind: NotificationKind = 'info', opts: { important?: boolean; onClick?: () => void } = {}): NotificationHandle {
    const textEl = h('div', { class: 'nt-text' }, text);
    const bar = h('div', { class: 'nt-progress-fill' });
    const progress = kind === 'progress' ? h('div', { class: 'nt-progress' }, bar) : null;
    const iconBox = h('div', { class: `nt-icon ${kind}` }, icon(kind));
    const closeBtn = h('button', { class: 'nt-close', title: kind === 'progress' ? 'Cancel' : 'Close' }, kind === 'progress' ? '✕' : '✓');
    const el = h('div', { class: `nt-notification ${kind} unread` }, h('div', { class: 'nt-light' }), h('div', { class: 'nt-main' }, iconBox, h('div', { class: 'nt-content' }, textEl, progress), closeBtn));
    const entry: Entry = { el, kind, read: this.open, important: !!opts.important || kind === 'error', closed: false, inTray: false, hovered: false };
    if (entry.read) el.classList.remove('unread');
    this.entries.add(entry);
    const onClick = opts.onClick;

    el.addEventListener('pointerenter', () => (entry.hovered = true));
    el.addEventListener('pointerleave', () => (entry.hovered = false));
    el.addEventListener('click', e => {
      if ((e.target as Element).closest('.nt-close')) return;
      if (onClick) {
        onClick();
        this.close(entry);
      }
    });
    closeBtn.addEventListener('click', e => {
      e.stopPropagation();
      this.close(entry);
    });

    if (this.open || kind === 'progress') {
      (kind === 'progress' ? this.tasksList : this.generalList).prepend(el);
      if (kind === 'progress' && !this.open) {
        // Running tasks also show in the tray until they finish.
        this.moveToTray(entry);
      }
    } else this.moveToTray(entry);
    this.emit();

    const handle: NotificationHandle = {
      setProgress: p => (bar.style.width = `${Math.max(0, Math.min(1, p)) * 100}%`),
      setText: t => (textEl.textContent = t),
      complete: (t, click) => {
        if (entry.closed) return;
        // ProgressCompletionNotification replaces the task.
        this.close(entry, true);
        this.post(t, 'success', { onClick: click });
      },
      fail: t => {
        if (entry.closed) return;
        this.close(entry, true);
        this.post(t, 'error');
      },
      close: () => this.close(entry),
    };
    return handle;
  }

  private moveToTray(entry: Entry): void {
    entry.inTray = true;
    this.tray.prepend(entry.el);
    entry.el.classList.add('toast-in');
    if (entry.kind === 'progress') return;
    const schedule = () =>
      setTimeout(
        () => {
          if (entry.closed || !entry.inTray) return;
          if (entry.hovered) return schedule();
          this.forward(entry, true);
        },
        entry.important ? 12000 : 2500,
      );
    schedule();
  }

  /** NotificationOverlayToastTray.forwardNotification: slides the toast out to the right and into the overlay. */
  private forward(entry: Entry, animate: boolean): void {
    if (!entry.inTray) return;
    entry.inTray = false;
    const move = () => {
      entry.el.classList.remove('toast-in', 'toast-out');
      (entry.kind === 'progress' ? this.tasksList : this.generalList).prepend(entry.el);
      this.emit();
    };
    if (animate && entry.kind !== 'progress') {
      entry.el.classList.add('toast-out');
      setTimeout(move, 600);
    } else move();
  }

  private close(entry: Entry, immediate = false): void {
    if (entry.closed) return;
    entry.closed = true;
    entry.el.classList.add('closing');
    setTimeout(() => entry.el.remove(), immediate ? 0 : 400);
    this.entries.delete(entry);
    this.emit();
  }

  private clearAll(which: 'general' | 'tasks'): void {
    for (const e of [...this.entries]) if ((e.kind === 'progress') === (which === 'tasks') && !e.inTray) this.close(e);
  }

  private updateCounts(): void {
    let general = 0;
    let tasks = 0;
    for (const e of this.entries) {
      if (e.inTray) continue;
      if (e.kind === 'progress') tasks++;
      else general++;
    }
    this.generalCount.textContent = String(general);
    this.tasksCount.textContent = String(tasks);
    (this.tasksList.parentElement as HTMLElement).style.display = tasks > 0 ? '' : 'none';
  }
}
