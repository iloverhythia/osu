// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game/Screens/Footer/ScreenFooter.cs, ScreenFooterButton.cs, ScreenBackButton.cs and
// osu.Game/Screens/Select/FooterButtonMods.cs, FooterButtonRandom.cs, FooterButtonOptions.cs (+ .Popover).

import { MOD_BY_ACRONYM, type ModSet } from '../../game/mods/Mods';
import { APP_NAME } from '../../brand';
import { h } from '../dom';
import { cssEasing, Easing, sequence, tween } from './Anim';
import { css, darken, forModType, hex, lighten, OsuColour, OverlayColourProvider, OverlayColourScheme, RGBA, opacity } from './Colours';
import { icon } from './Icons';

export const FOOTER_HEIGHT = 50;
export const FOOTER_BUTTON_HEIGHT = 75;
const BUTTON_WIDTH = 116;
const BACK_BUTTON_WIDTH = 240;
const SCREEN_EDGE_MARGIN = 12;
const PADDING = 60;
const DELAY_PER_BUTTON = 30;

/** ScreenFooterButton */
export class ScreenFooterButton {
  readonly el: HTMLDivElement;
  protected readonly content: HTMLDivElement;
  protected readonly sheared: HTMLDivElement;
  private readonly bg: HTMLDivElement;
  private readonly glow: HTMLDivElement;
  private readonly bar: HTMLDivElement;
  private readonly iconEl: HTMLSpanElement;
  protected readonly textContainer: HTMLDivElement;
  protected readonly text: HTMLSpanElement;
  private readonly flashLayer: HTMLDivElement;
  overlayVisible = false;
  enabled = true;
  hidden = false;
  private hovered = false;
  action: (() => void) | null = null;

  constructor(
    protected readonly colours: () => OverlayColourProvider,
    label: string,
    iconName: string,
    protected readonly accent: RGBA,
  ) {
    this.bg = h('div', { class: 'fb-bg' });
    this.glow = h('div', { class: 'fb-glow' });
    this.text = h('span', { class: 'fb-text' }, label);
    this.textContainer = h('div', { class: 'fb-text-container' }, this.text);
    this.iconEl = h('span', { class: 'fb-icon' }, icon(iconName, 16));
    this.bar = h('div', { class: 'fb-bar' });
    this.flashLayer = h('div', { class: 'fb-flash' });
    this.sheared = h('div', { class: 'fb-sheared' }, this.bg, this.glow, h('div', { class: 'fb-unshear' }, this.textContainer, this.iconEl), h('div', { class: 'fb-bar-container' }, this.bar), this.flashLayer);
    this.content = h('div', { class: 'fb-content' }, this.sheared);
    this.el = h('div', { class: 'footer-button' }, this.content);
    this.el.style.width = `${BUTTON_WIDTH}px`;
    this.sheared.addEventListener('mouseenter', () => {
      this.hovered = true;
      this.updateDisplay();
    });
    this.sheared.addEventListener('mouseleave', () => {
      this.hovered = false;
      this.updateDisplay();
    });
    this.sheared.addEventListener('click', e => this.onClick(e));
    this.updateDisplay();
  }

  protected onClick(_e: MouseEvent): void {
    if (this.enabled) this.flash();
    if (!this.hidden && this.enabled) this.action?.();
  }

  triggerClick(e?: MouseEvent): void {
    this.onClick(e ?? new MouseEvent('click'));
  }

  protected flash(): void {
    sequence(this.flashLayer, [{ props: { opacity: 0 }, duration: 800, easing: Easing.OutQuint }], { opacity: 1 });
  }

  /** ScreenFooterButton.UpdateDisplay */
  updateDisplay(): void {
    const c = this.colours();
    let backgroundColour = this.overlayVisible ? this.accent : c.background3;
    let textColour = this.overlayVisible ? c.background6 : c.content1;
    const accentColour = this.overlayVisible ? c.background6 : this.accent;
    if (!this.enabled) backgroundColour = darken(backgroundColour, 1);
    else if (this.hovered) backgroundColour = lighten(backgroundColour, 0.2);
    if (!this.enabled) textColour = opacity(textColour, 0.6);
    const t = `150ms ${cssEasing(Easing.OutQuint)}`;
    this.bg.style.transition = this.text.style.transition = this.iconEl.style.transition = this.bar.style.transition = `background ${t}, color ${t}`;
    this.bg.style.background = css(backgroundColour);
    this.text.style.color = css(textColour);
    this.iconEl.style.color = css(accentColour);
    this.bar.style.background = css(accentColour);
    this.glow.style.background = `linear-gradient(${css(this.accent, 0)}, ${css(this.accent, 0.2)})`;
  }

  appearFromLeft(delay: number): void {
    this.content.getAnimations?.().forEach(a => a.cancel());
    this.content.animate?.(
      [
        { transform: 'translateX(-300px)', opacity: 0, offset: 0 },
        { transform: 'translateX(-300px)', opacity: 0, offset: delay / (delay + 240), easing: cssEasing(Easing.OutCubic) },
        { transform: 'translateX(0)', opacity: 1 },
      ],
      { duration: delay + 240, fill: 'backwards' },
    );
  }

  appearFromBottom(delay: number): void {
    this.content.getAnimations?.().forEach(a => a.cancel());
    this.content.animate?.(
      [
        { transform: 'translateY(100px)', opacity: 0, offset: 0 },
        { transform: 'translateY(100px)', opacity: 0, offset: delay / (delay + 240), easing: cssEasing(Easing.OutCubic) },
        { transform: 'translateY(0)', opacity: 1 },
      ],
      { duration: delay + 240, fill: 'both' },
    );
  }

  disappearToBottom(delay: number): void {
    this.content.getAnimations?.().forEach(a => a.cancel());
    this.content.animate?.(
      [
        { transform: 'translateY(0)', opacity: 1, offset: 0 },
        { transform: 'translateY(0)', opacity: 1, offset: delay / (delay + 240), easing: cssEasing(Easing.InOutCubic) },
        { transform: 'translateY(100px)', opacity: 0 },
      ],
      { duration: delay + 240, fill: 'forwards' },
    );
  }
}

/** FooterButtonMods */
export class FooterButtonMods extends ScreenFooterButton {
  private readonly modDisplayBar: HTMLDivElement;
  private readonly modDisplay: HTMLDivElement;
  private readonly multiplierText: HTMLSpanElement;
  private readonly unrankedBadge: HTMLDivElement;
  requestDeselectAllMods: (() => void) | null = null;

  constructor(colours: () => OverlayColourProvider) {
    super(colours, 'Mods', 'exchange', OsuColour.Lime1);
    const c = colours();
    this.multiplierText = h('span', { class: 'fbm-multiplier' });
    this.modDisplay = h('div', { class: 'fbm-mods' });
    this.modDisplayBar = h(
      'div',
      { class: 'fbm-bar' },
      h('div', { class: 'fbm-bar-bg', style: { background: css(c.background4) } }),
      h('div', { class: 'fbm-multiplier-container' }, this.multiplierText),
      h('div', { class: 'fbm-mod-container' }, h('div', { class: 'fbm-mod-bg', style: { background: css(c.background3) } }), this.modDisplay),
    );
    this.unrankedBadge = h('div', { class: 'fbm-unranked', title: 'Performance points will not be granted due to active mods.' }, h('span', null, 'UNRANKED'));
    this.unrankedBadge.style.background = css(OsuColour.Orange2);
    this.el.prepend(this.unrankedBadge, this.modDisplayBar);
    this.sheared.addEventListener('mousedown', e => {
      if (e.button === 2) {
        e.preventDefault();
        this.requestDeselectAllMods?.();
      }
    });
    this.sheared.addEventListener('contextmenu', e => e.preventDefault());
  }

  /** FooterButtonMods.updateDisplay */
  setMods(mods: ModSet, multiplier: number): void {
    const d = 240;
    const ease = cssEasing(Easing.OutQuint);
    this.modDisplayBar.style.transition = this.unrankedBadge.style.transition = `transform ${d}ms ${ease}, opacity ${d}ms ${ease}`;
    this.el.style.transition = `width ${d}ms ${ease}`;
    if (mods.isEmpty) {
      this.modDisplayBar.style.transform = 'translateY(20px) skewX(var(--shear))';
      this.modDisplayBar.style.opacity = '0';
      this.unrankedBadge.style.transform = 'translateY(20px) skewX(var(--shear))';
      this.unrankedBadge.style.opacity = '0';
      this.el.style.transition = `width ${d}ms ${ease} ${d}ms`;
      this.el.style.width = `${BUTTON_WIDTH}px`;
    } else {
      if (!mods.isRanked) {
        this.unrankedBadge.style.transform = 'translate(0, -5px) skewX(var(--shear))';
        this.unrankedBadge.style.opacity = '1';
        this.el.style.width = `${BUTTON_WIDTH + 5 + this.unrankedBadge.offsetWidth}px`;
      } else {
        this.unrankedBadge.style.transform = `translate(${-this.unrankedBadge.offsetWidth}px, -5px) skewX(var(--shear))`;
        this.unrankedBadge.style.opacity = '0';
        this.el.style.width = `${BUTTON_WIDTH}px`;
      }
      this.modDisplayBar.style.transform = 'translateY(-5px) skewX(var(--shear))';
      this.modDisplayBar.style.opacity = '1';
    }
    this.modDisplay.textContent = '';
    const list = mods.list;
    for (const m of list) {
      const def = MOD_BY_ACRONYM.get(m);
      this.modDisplay.appendChild(h('span', { class: 'mod-icon-small', style: { background: css(def ? forModType(def.type) : OsuColour.Yellow) } }, mods.label(m).replace(/ \(.*\)$/, '')));
    }
    requestAnimationFrame(() => {
      // ModCountText overflow: "N MODS" when the icons don't fit.
      const container = this.modDisplay.parentElement!;
      if (this.modDisplay.scrollWidth > container.clientWidth) {
        this.modDisplay.textContent = '';
        this.modDisplay.appendChild(h('span', { class: 'fbm-count' }, `${list.length} MODS`));
      }
    });
    // ModUtils.FormatScoreMultiplier
    this.multiplierText.textContent = `${(Math.floor(multiplier * 100) / 100).toFixed(2)}x`;
    this.multiplierText.style.transition = `color ${d}ms ${ease}`;
    this.multiplierText.style.color = multiplier > 1 ? css(OsuColour.Red1) : multiplier < 1 ? css(OsuColour.Lime1) : '#fff';
  }
}

/** FooterButtonRandom */
export class FooterButtonRandom extends ScreenFooterButton {
  private readonly randomText: HTMLSpanElement;
  private readonly rewindText: HTMLSpanElement;
  nextRandom: (() => void) | null = null;
  previousRandom: (() => void) | null = null;
  private rewindSearch = false;

  constructor(colours: () => OverlayColourProvider) {
    super(colours, '', 'random', OsuColour.Blue1);
    this.text.remove();
    this.randomText = h('span', { class: 'fb-text' }, 'Random');
    this.rewindText = h('span', { class: 'fb-text rewind' }, 'Rewind');
    this.rewindText.style.opacity = '0';
    this.textContainer.append(h('div', { class: 'fbr-persistent' }, this.randomText, this.rewindText));
    this.action = () => {
      if (this.rewindSearch) {
        const falling = h('span', { class: 'fb-text fbr-falling' }, 'Rewind');
        this.textContainer.appendChild(falling);
        sequence(falling, [{ props: { opacity: 0, transform: 'translateY(10px)' }, duration: 500, easing: Easing.In }], { opacity: 1, transform: 'translateY(0)' });
        setTimeout(() => falling.remove(), 500);
        const persistent = this.textContainer.querySelector('.fbr-persistent') as HTMLElement;
        sequence(persistent, [{ props: { opacity: 1 }, duration: 500, easing: Easing.In }], { opacity: 0 });
        this.previousRandom?.();
      } else this.nextRandom?.();
    };
    this.sheared.addEventListener('mouseup', e => {
      if (e.button === 2) {
        this.rewindSearch = true;
        this.triggerClick();
        this.rewindSearch = false;
      }
    });
    this.sheared.addEventListener('contextmenu', e => e.preventDefault());
    this.updateDisplay();
    const c = colours();
    this.randomText.style.color = this.rewindText.style.color = css(c.content1);
  }

  protected onClick(e: MouseEvent): void {
    try {
      this.rewindSearch ||= e.shiftKey;
      super.onClick(e);
    } finally {
      this.rewindSearch = false;
    }
  }

  /** OnKeyDown/OnKeyUp: show "Rewind" while shift is held. */
  setShift(shift: boolean): void {
    this.randomText.style.opacity = shift ? '0' : '1';
    this.rewindText.style.opacity = shift ? '1' : '0';
  }

  /** GlobalAction.SelectNextRandom / SelectPreviousRandom */
  press(previous: boolean): void {
    this.rewindSearch = previous;
    this.triggerClick();
    this.rewindSearch = false;
  }
}

export interface OptionsEntry {
  header?: string;
  context?: string;
  text?: string;
  icon?: string;
  colour?: RGBA;
  spacer?: boolean;
  action?: () => void;
}

/** FooterButtonOptions (+ Popover) */
export class FooterButtonOptions extends ScreenFooterButton {
  private popover: HTMLDivElement | null = null;
  getEntries: (() => OptionsEntry[]) | null = null;
  onStateChanged: ((open: boolean) => void) | null = null;

  constructor(colours: () => OverlayColourProvider) {
    super(colours, 'Options', 'cog', OsuColour.Purple1);
    this.action = () => (this.popover ? this.hidePopover() : this.showPopover());
  }

  get isOpen(): boolean {
    return this.popover != null;
  }

  showPopover(): void {
    if (this.popover || !this.getEntries) return;
    const c = this.colours();
    const buttons: HTMLButtonElement[] = [];
    const flow = h('div', { class: 'opt-flow' });
    for (const e of this.getEntries()) {
      if (e.spacer) flow.appendChild(h('div', { class: 'opt-spacer' }));
      else if (e.header) flow.appendChild(h('div', { class: 'opt-header' }, h('div', { class: 'opt-header-text' }, e.header), e.context ? h('div', { class: 'opt-header-context', style: { color: css(c.content2) } }, e.context) : null));
      else {
        const b = h(
          'button',
          {
            class: 'opt-button',
            type: 'button',
            style: { background: css(c.background3), color: e.colour ? css(e.colour) : '#fff' },
            onclick: () => {
              setTimeout(() => this.hidePopover(), 50);
              e.action?.();
            },
          },
          h('span', { class: 'opt-icon' }, icon(e.icon ?? 'circle', 17)),
          h('span', { class: 'opt-text' }, e.text ?? ''),
        );
        buttons.push(b);
        flow.appendChild(b);
      }
    }
    this.popover = h('div', { class: 'osu-popover', style: { background: css(c.background4) } }, flow, h('div', { class: 'popover-arrow', style: { borderTopColor: css(c.background4) } }));
    (this.popover as HTMLDivElement & { buttons?: HTMLButtonElement[] }).buttons = buttons;
    this.el.appendChild(this.popover);
    this.popover.style.opacity = '0';
    this.popover.style.transform = 'translateX(-50%) scale(0.95)';
    void this.popover.offsetWidth;
    tween(this.popover, { opacity: '1', transform: 'translateX(-50%) scale(1)' }, 300, Easing.OutQuint);
    this.overlayVisible = true;
    this.updateDisplay();
    this.onStateChanged?.(true);
    const off = (ev: MouseEvent) => {
      if (this.popover && !this.el.contains(ev.target as Node)) this.hidePopover();
    };
    setTimeout(() => document.addEventListener('mousedown', off, { once: true }), 0);
  }

  hidePopover(): void {
    if (!this.popover) return;
    const p = this.popover;
    this.popover = null;
    tween(p, { opacity: '0' }, 200, Easing.OutQuint);
    setTimeout(() => p.remove(), 200);
    this.overlayVisible = false;
    this.updateDisplay();
    this.onStateChanged?.(false);
  }

  /** Popover.OnKeyDown: number keys trigger the n-th button. */
  handleKey(e: KeyboardEvent): boolean {
    if (!this.popover) return false;
    if (e.ctrlKey) return false;
    const m = /^Digit([1-9])$/.exec(e.code);
    if (m && !e.repeat) {
      const b = (this.popover as HTMLDivElement & { buttons?: HTMLButtonElement[] }).buttons?.[parseInt(m[1], 10) - 1];
      if (b) {
        b.click();
        return true;
      }
    }
    if (e.code === 'Escape') {
      this.hidePopover();
      return true;
    }
    return false;
  }
}

/** ScreenFooter (with the ScreenBackButton and the logo position) */
export class ScreenFooter {
  readonly el: HTMLDivElement;
  readonly colours = new OverlayColourProvider(OverlayColourScheme.Blue);
  private readonly background: HTMLDivElement;
  private readonly leftButtons: HTMLDivElement;
  readonly overlayContent: HTMLDivElement;
  readonly backButton: HTMLButtonElement;
  readonly logo: HTMLButtonElement;
  private buttons: ScreenFooterButton[] = [];
  private hiddenForOverlay: ScreenFooterButton[] = [];
  activeOverlay: { onBack(): void } | null = null;

  constructor(onBack: () => void, onLogo: () => void) {
    this.background = h('div', { class: 'footer-bg' });
    this.leftButtons = h('div', { class: 'footer-left' });
    this.overlayContent = h('div', { class: 'footer-overlay-content' });
    // ScreenBackButton: sheared button, darker/lighter pink in lazer -> the JarvSU accent purple.
    this.backButton = h('button', { class: 'sheared-button back-button', type: 'button', onclick: () => this.onBackPressed(onBack) }, h('span', { class: 'sb-content' }, icon('chevronLeft', 17), h('span', { class: 'back-text' }, 'back')));
    this.backButton.style.width = `${BACK_BUTTON_WIDTH}px`;
    this.logo = h('button', { class: 'footer-logo', type: 'button', 'aria-label': 'Play', onclick: () => onLogo() }, h('span', { class: 'footer-logo-word' }, APP_NAME));
    this.el = h('div', { class: 'screen-footer' }, this.background, h('div', { class: 'footer-grid', style: { paddingLeft: `${SCREEN_EDGE_MARGIN + BACK_BUTTON_WIDTH + PADDING}px`, paddingRight: `${SCREEN_EDGE_MARGIN}px` } }, this.leftButtons, this.overlayContent), this.backButton, this.logo);
    this.updateColourScheme(this.colours.hue);
  }

  setButtons(buttons: ScreenFooterButton[]): void {
    this.buttons = buttons;
    this.leftButtons.textContent = '';
    buttons.forEach((b, i) => {
      this.leftButtons.appendChild(b.el);
      b.appearFromLeft(240 + (buttons.length - i) * DELAY_PER_BUTTON);
    });
  }

  private onBackPressed(onBack: () => void): void {
    if (this.activeOverlay) {
      this.activeOverlay.onBack();
      return;
    }
    onBack();
  }

  /** RegisterActiveOverlayContainer: buttons after the overlay's own button move away, colour scheme follows the overlay. */
  registerActiveOverlay(overlay: { onBack(): void }, owner: ScreenFooterButton | null, hue: number, content: HTMLElement | null): void {
    this.activeOverlay = overlay;
    const idx = owner ? this.buttons.indexOf(owner) : -1;
    this.hiddenForOverlay = idx >= 0 ? this.buttons.slice(idx + 1) : [...this.buttons];
    // Hidden buttons move out of the flow (into lazer's hiddenLeftButtonsContainer), keeping their position.
    const lefts = this.hiddenForOverlay.map(b => b.el.offsetLeft);
    this.hiddenForOverlay.forEach((b, i) => {
      b.hidden = true;
      b.disappearToBottom(0);
      b.el.style.pointerEvents = 'none';
      b.el.style.position = 'absolute';
      b.el.style.left = `${lefts[i]}px`;
      b.el.style.bottom = '0';
    });
    this.updateColourScheme(hue);
    this.overlayContent.textContent = '';
    if (content) {
      this.overlayContent.appendChild(content);
      setTimeout(() => content.classList.add('visible'), this.hiddenForOverlay.length > 0 ? 60 : 0);
    }
  }

  clearActiveOverlay(): void {
    if (!this.activeOverlay) return;
    const content = this.overlayContent.firstElementChild as HTMLElement | null;
    if (content) {
      content.classList.remove('visible');
      setTimeout(() => content.remove(), 400);
    }
    for (const b of this.hiddenForOverlay) {
      b.hidden = false;
      b.el.style.position = '';
      b.el.style.left = '';
      b.el.style.bottom = '';
      b.appearFromBottom(0);
      b.el.style.pointerEvents = '';
    }
    this.hiddenForOverlay = [];
    // lazer resets to Aquamarine here.
    this.updateColourScheme(OverlayColourScheme.Aquamarine);
    this.activeOverlay = null;
  }

  private updateColourScheme(hue: number): void {
    this.colours.hue = hue;
    this.background.style.transition = `background 150ms ${cssEasing(Easing.OutQuint)}`;
    this.background.style.background = css(this.colours.background5);
    for (const b of this.buttons) b.updateDisplay();
  }

  setVisible(v: boolean): void {
    this.el.style.transition = `transform 500ms ${cssEasing(Easing.OutQuint)}`;
    this.el.style.transform = `translateY(${v ? 0 : FOOTER_BUTTON_HEIGHT}px)`;
  }
}

/** Back button colours (ShearedButton DarkerColour / LighterColour), substituted with the JarvSU purple. */
export const BACK_DARKER = hex('7a1fd6');
export const BACK_LIGHTER = hex('b56cff');
