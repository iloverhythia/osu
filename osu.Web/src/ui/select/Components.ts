// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Shared drawables used across song select: StarRatingDisplay (osu.Game/Beatmaps/Drawables/StarRatingDisplay.cs),
// BeatmapSetOnlineStatusPill (osu.Game/Beatmaps/Drawables/BeatmapSetOnlineStatusPill.cs), ShearedButton / ShearedToggleButton /
// ShearedDropdown (osu.Game/Graphics/UserInterface/*) as DOM elements.

import { h } from '../dom';
import { Easing, Tween } from './Anim';
import { css, forBeatmapSetOnlineStatus, forStarDifficulty, forStarDifficultyText, formatStarRating, OverlayColourProvider, RGBA, STAR_DIFFICULTY_DEFINED_COLOUR_CUTOFF } from './Colours';
import { BeatmapOnlineStatus, ONLINE_STATUS_NAMES } from './FilterCriteria';
import { icon } from './Icons';

export type StarRatingDisplaySize = 'small' | 'regular' | 'range';

/** StarRatingDisplay: a pill with a star icon and the (animated) star rating, coloured by OsuColour.ForStarDifficulty. */
export class StarRatingDisplay {
  readonly el: HTMLDivElement;
  private readonly starIcon: SVGSVGElement;
  private readonly text: HTMLSpanElement;
  private readonly displayed = new Tween(-1);
  private raf = 0;
  private current: number | null = null;
  displayedColour: RGBA = forStarDifficulty(0);
  displayedTextColour: RGBA = forStarDifficultyText(0);
  onChange: (() => void) | null = null;

  constructor(
    size: StarRatingDisplaySize = 'regular',
    private readonly animated = false,
  ) {
    this.starIcon = icon('star', 8, 'srd-star');
    this.text = h('span', { class: 'srd-text' });
    this.el = h('div', { class: `srd srd-${size}` }, this.starIcon, h('span', { class: 'srd-gap' }), this.text);
    this.apply(-1);
  }

  /** Current.Value = new StarDifficulty(stars) */
  set(stars: number | null): void {
    const v = stars ?? -1;
    if (this.current === v) return;
    const old = this.current;
    this.current = v;
    const now = performance.now();
    if (!this.animated || old == null) {
      this.displayed.snap(v);
      this.apply(v);
      return;
    }
    this.displayed.set(v, now, Math.min(1000, 100 + 80 * Math.abs(v - this.displayed.at(now))), Easing.OutQuint);
    const tick = () => {
      const t = performance.now();
      this.apply(this.displayed.at(t));
      this.raf = this.displayed.isRunning(t) ? requestAnimationFrame(tick) : 0;
    };
    cancelAnimationFrame(this.raf);
    tick();
  }

  get displayedStars(): number {
    return this.displayed.at(performance.now());
  }

  /** StarRatingDisplay.ForegroundTextColour */
  get foregroundTextColour(): RGBA {
    return this.displayedStars >= STAR_DIFFICULTY_DEFINED_COLOUR_CUTOFF ? this.displayedTextColour : this.displayedColour;
  }

  private apply(s: number): void {
    this.text.textContent = s < 0 ? '-' : formatStarRating(s);
    this.displayedColour = forStarDifficulty(s);
    this.displayedTextColour = forStarDifficultyText(s);
    this.el.style.background = css(this.displayedColour);
    this.el.style.color = css(this.displayedTextColour);
    this.onChange?.();
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
  }
}

/** BeatmapSetOnlineStatusPill */
export function statusPill(status: BeatmapOnlineStatus, showUnknownStatus: boolean, colours: OverlayColourProvider, cls = ''): HTMLDivElement {
  const el = h('div', { class: `status-pill ${cls}` }, ONLINE_STATUS_NAMES[status].toUpperCase());
  updateStatusPill(el, status, showUnknownStatus, colours);
  return el;
}

export function updateStatusPill(el: HTMLElement, status: BeatmapOnlineStatus, showUnknownStatus: boolean, colours: OverlayColourProvider): void {
  el.textContent = ONLINE_STATUS_NAMES[status].toUpperCase();
  el.style.display = status === BeatmapOnlineStatus.None && !showUnknownStatus ? 'none' : '';
  el.style.background = css(forBeatmapSetOnlineStatus(status) ?? colours.light1);
  el.style.color = css(colours.background5);
}

/** ShearedButton (DarkerColour / LighterColour background, sheared parallelogram). */
export function shearedButton(label: string | Node, onClick: () => void, opts: { width?: number; height?: number; cls?: string } = {}): HTMLButtonElement {
  const b = h('button', { class: `sheared-button ${opts.cls ?? ''}`, type: 'button', onclick: onClick }, h('span', { class: 'sb-content' }, label));
  if (opts.width) b.style.width = `${opts.width}px`;
  if (opts.height) b.style.height = `${opts.height}px`;
  return b;
}

/** ShearedToggleButton */
export function shearedToggle(label: string, value: boolean, onChange: (v: boolean) => void): HTMLButtonElement & { setActive(v: boolean): void } {
  const b = shearedButton(label, () => {
    const next = !b.classList.contains('active');
    b.setActive(next);
    onChange(next);
  }, { cls: 'ss-toggle' }) as HTMLButtonElement & { setActive(v: boolean): void };
  b.setActive = (v: boolean) => b.classList.toggle('active', v);
  b.setActive(value);
  return b;
}

/** ShearedDropdown<T>: a sheared label + current value header with a dropdown menu. */
export class ShearedDropdown<T> {
  readonly el: HTMLDivElement;
  private readonly valueEl: HTMLSpanElement;
  private menu: HTMLDivElement | null = null;
  private items: { value: T; text: string }[] = [];
  private _value: T;
  disabled = false;

  constructor(
    label: string,
    items: { value: T; text: string }[],
    value: T,
    private readonly onChange: (v: T) => void,
  ) {
    this._value = value;
    this.valueEl = h('span', { class: 'sd-value' });
    this.el = h(
      'div',
      { class: 'sheared-dropdown', tabindex: '-1' },
      h('div', { class: 'sd-header', onclick: (e: MouseEvent) => (e.stopPropagation(), this.toggle()) }, h('span', { class: 'sd-label' }, label), this.valueEl, icon('chevronDown', 10, 'sd-chevron')),
    );
    this.setItems(items);
  }

  get value(): T {
    return this._value;
  }

  set value(v: T) {
    this._value = v;
    this.valueEl.textContent = this.items.find(i => i.value === v)?.text ?? String(v);
  }

  setItems(items: { value: T; text: string }[]): void {
    this.items = items;
    this.value = this._value;
  }

  setDisabled(d: boolean): void {
    this.disabled = d;
    this.el.classList.toggle('disabled', d);
    if (d) this.close();
  }

  private toggle(): void {
    if (this.menu) {
      this.close();
      return;
    }
    if (this.disabled) return;
    this.menu = h(
      'div',
      { class: 'sd-menu scroll-thin' },
      this.items.map(i =>
        h(
          'div',
          {
            class: `sd-item${i.value === this._value ? ' selected' : ''}`,
            onclick: (e: MouseEvent) => {
              e.stopPropagation();
              this.close();
              if (i.value !== this._value) {
                this.value = i.value;
                this.onChange(i.value);
              }
            },
          },
          i.text,
        ),
      ),
    );
    this.el.appendChild(this.menu);
    this.el.classList.add('open');
    const off = (e: MouseEvent) => {
      if (!this.el.contains(e.target as Node)) this.close();
    };
    setTimeout(() => document.addEventListener('mousedown', off, { once: true }), 0);
  }

  close(): void {
    this.menu?.remove();
    this.menu = null;
    this.el.classList.remove('open');
  }

  get isOpen(): boolean {
    return this.menu != null;
  }
}

/** Simple context menu (OsuContextMenu) at a screen position. */
export interface MenuItem {
  text: string;
  action?: () => void;
  type?: 'standard' | 'highlighted' | 'destructive';
  spacer?: boolean;
  icon?: string;
}

let openMenu: HTMLElement | null = null;

export function showContextMenu(x: number, y: number, items: MenuItem[], host: HTMLElement = document.body): void {
  openMenu?.remove();
  const menu = h(
    'div',
    { class: 'ss-context-menu' },
    items.map(i =>
      i.spacer
        ? h('div', { class: 'cm-spacer' })
        : h(
            'div',
            {
              class: `cm-item ${i.type ?? 'standard'}`,
              onclick: () => {
                menu.remove();
                openMenu = null;
                i.action?.();
              },
            },
            i.text,
          ),
    ),
  );
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  host.appendChild(menu);
  openMenu = menu;
  const r = menu.getBoundingClientRect();
  if (r.right > innerWidth) menu.style.left = `${Math.max(0, x - r.width)}px`;
  if (r.bottom > innerHeight) menu.style.top = `${Math.max(0, y - r.height)}px`;
  const off = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) {
      menu.remove();
      if (openMenu === menu) openMenu = null;
      document.removeEventListener('mousedown', off, true);
    }
  };
  setTimeout(() => document.addEventListener('mousedown', off, true), 0);
}

export function closeContextMenu(): boolean {
  if (!openMenu) return false;
  openMenu.remove();
  openMenu = null;
  return true;
}
