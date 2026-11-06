// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Interactive (DOM) gameplay overlays, ported from:
//  - osu.Game/Screens/Play/SkipOverlay.cs
//  - osu.Game/Screens/Play/GameplayMenuOverlay.cs, PauseOverlay.cs, FailOverlay.cs + osu.Game/Graphics/UserInterface/DialogButton.cs
//  - osu.Game/Graphics/Containers/HoldToConfirmContainer.cs, osu.Game/Overlays/HoldToConfirmOverlay.cs,
//    osu.Game/Screens/Play/HotkeyRetryOverlay.cs, HotkeyExitOverlay.cs, HUD/HoldForMenuButton.cs
//  - osu.Game/Screens/Play/ResumeOverlay.cs + osu.Game.Rulesets.Osu/UI/OsuResumeOverlay.cs

import { h } from '../dom';
import { Anim, Easing, OsuColour, css, dampContinuously, type RGBA } from './anim';
import { MINIMUM_SKIP_TIME } from './clock';
import './hud.css';

// ------------------------------------------------------------------------------------------------ skip overlay

export class SkipOverlay {
  readonly el: HTMLDivElement;
  private readonly buttonContainer: HTMLDivElement;
  private readonly fading: HTMLDivElement;
  private readonly button: HTMLButtonElement;
  private readonly remaining: HTMLDivElement;
  private readonly box: HTMLDivElement;
  private displayTime = 0;
  private remainingWidth = 1;
  inSkipPeriod = false;
  private fadingVisible = false;
  private nextHideTime: number | null = null;
  private hovered = false;
  private expired = false;
  private hiddenOverlay = false;
  skipCount = 0;
  requestSkip: (() => void) | null = null;
  playConfirm: (() => void) | null = null;

  constructor(private readonly startTime: number) {
    this.box = h('div', { class: 'skip-box' });
    const chevrons = h('div', { class: 'skip-chevrons' }, h('i'), h('i'), h('i'));
    this.button = h('button', { class: 'skip-btn', 'aria-label': 'Skip' }, h('div', { class: 'skip-bg' }), h('div', { class: 'skip-aspect' }, this.box, chevrons, h('span', { class: 'skip-text' }, 'SKIP')));
    this.remaining = h('div', { class: 'skip-remaining' });
    this.fading = h('div', { class: 'skip-fading' }, this.button, this.remaining);
    this.buttonContainer = h('div', { class: 'skip-container' }, this.fading);
    this.el = h('div', { class: 'skip-overlay' }, this.buttonContainer);

    this.button.addEventListener('pointerenter', () => {
      this.hovered = true;
      this.button.classList.add('hover');
    });
    this.button.addEventListener('pointerleave', () => {
      this.hovered = false;
      this.button.classList.remove('hover', 'down');
    });
    this.button.addEventListener('pointerdown', e => {
      e.stopPropagation();
      this.button.classList.add('down');
      this.nextHideTime = null;
    });
    this.button.addEventListener('pointerup', () => this.button.classList.remove('down'));
    this.button.addEventListener('click', e => {
      e.stopPropagation();
      this.click();
    });
    this.el.addEventListener('pointermove', e => {
      if (this.inSkipPeriod && e.buttons === 0) this.triggerShow(performance.now());
    });
  }

  private get fadeOutBeginTime(): number {
    return this.startTime - MINIMUM_SKIP_TIME;
  }

  /** LoadComplete: expires immediately if there is no time to skip. Returns false when expired. */
  load(currentTime: number, now: number, visible = true): boolean {
    this.displayTime = currentTime;
    if (this.fadeOutBeginTime <= this.displayTime) {
      this.expire();
      return false;
    }
    this.hiddenOverlay = !visible;
    this.el.style.display = visible ? '' : 'none';
    this.triggerShow(now);
    return true;
  }

  expire(): void {
    this.expired = true;
    this.el.remove();
  }

  get isExpired(): boolean {
    return this.expired;
  }

  /** SkipOverlay.Show (outro skip). */
  show(now: number): void {
    if (this.expired) return;
    this.hiddenOverlay = false;
    this.el.style.display = '';
    this.triggerShow(now);
  }

  hide(): void {
    this.hiddenOverlay = true;
    this.el.style.display = 'none';
  }

  get enabled(): boolean {
    return !this.expired && !this.hiddenOverlay && this.inSkipPeriod;
  }

  /** Button.TriggerClick (SkipCutscene binding / auto skip). */
  click(): boolean {
    if (!this.enabled) return false;
    this.playConfirm?.();
    this.button.classList.remove('flash');
    void this.button.offsetWidth;
    this.button.classList.add('flash');
    this.skipCount++;
    this.requestSkip?.();
    return true;
  }

  private triggerShow(now: number): void {
    this.setFading(true);
    this.nextHideTime = this.hovered ? null : now + 1000;
  }

  private setFading(v: boolean): void {
    if (v === this.fadingVisible) return;
    this.fadingVisible = v;
    this.fading.classList.toggle('visible', v);
  }

  update(currentTime: number, now: number, elapsed: number): void {
    if (this.expired || this.fadeOutBeginTime <= this.displayTime) return;
    if (this.nextHideTime != null && this.nextHideTime <= now) {
      this.setFading(false);
      this.nextHideTime = null;
    }
    const progress = Math.max(0, 1 - (currentTime - this.displayTime) / (this.fadeOutBeginTime - this.displayTime));
    this.remainingWidth = dampContinuously(this.remainingWidth, progress, 40, Math.abs(elapsed));
    this.remaining.style.width = `${this.remainingWidth * 100}%`;
    this.inSkipPeriod = progress > 0;
    this.buttonContainer.classList.toggle('visible', this.inSkipPeriod);
    this.button.disabled = !this.inSkipPeriod;
  }
}

// ------------------------------------------------------------------------------------------------ hold to confirm

/** HoldToConfirmContainer progress logic (driven by update(now)). */
export class HoldToConfirm {
  private readonly progressAnim = new Anim(0);
  private confirming = false;
  fired = false;
  onConfirm: (() => void) | null = null;

  constructor(
    public holdActivationDelay: number,
    private readonly allowMultipleFires = false,
  ) {}

  progress(now: number): number {
    return this.progressAnim.valueAt(now);
  }

  get isConfirming(): boolean {
    return this.confirming;
  }

  begin(now: number): void {
    if (this.confirming || (!this.allowMultipleFires && this.fired)) return;
    this.confirming = true;
    const p = this.progress(now);
    this.progressAnim.to(1, this.holdActivationDelay * (1 - p), Easing.Out, now);
  }

  abort(now: number): void {
    if (!this.confirming || (!this.allowMultipleFires && this.fired)) return;
    this.confirming = false;
    this.fired = false;
    const p = this.progress(now);
    this.progressAnim.set(p, now).to(0, 200, Easing.InSine, now + 200);
  }

  /** Confirm immediately (e.g. pressing Back when holding isn't required). */
  confirm(): void {
    this.onConfirm?.();
    this.fired = true;
  }

  update(now: number): void {
    if (this.confirming && this.progress(now) >= 1 && !this.fired) {
      this.confirm();
      if (this.allowMultipleFires) {
        this.confirming = false;
        this.progressAnim.set(0, now);
      }
    }
  }
}

/** HotkeyRetryOverlay / HotkeyExitOverlay: a black layer whose alpha (and the inverse of the audio volume) follows the hold progress. */
export class HoldToConfirmOverlay {
  readonly el: HTMLDivElement;
  readonly hold: HoldToConfirm;

  constructor(delay: number) {
    this.el = h('div', { class: 'hold-confirm-overlay' });
    this.hold = new HoldToConfirm(delay);
  }

  /** Returns the audio volume factor (1 - progress). */
  update(now: number): number {
    this.hold.update(now);
    const p = this.hold.progress(now);
    this.el.style.opacity = String(p);
    return 1 - p;
  }
}

/** HoldForMenuButton (bottom-right). Visible / interactive only once touch input has been detected. */
export class HoldForMenuButton {
  readonly el: HTMLDivElement;
  private readonly text: HTMLSpanElement;
  private readonly circle: HTMLDivElement;
  private readonly progressEl: HTMLDivElement;
  private readonly icon: HTMLSpanElement;
  readonly hold: HoldToConfirm;
  private touchActive = false;
  private hovered = false;
  private textAlpha = new Anim(0);
  private pendingAnimationUntil = 0;

  constructor(delay: number, isDangerousAction = false) {
    this.hold = new HoldToConfirm(isDangerousAction ? 500 : delay, true);
    this.text = h('span', { class: 'hfm-text' }, this.hold.holdActivationDelay > 0 ? 'Hold for menu' : 'Press for menu');
    this.progressEl = h('div', { class: 'hfm-progress' });
    this.icon = h('span', { class: 'hfm-icon' }, '✕');
    this.circle = h('div', { class: 'hfm-circle' }, this.progressEl, h('div', { class: 'hfm-overlay' }), this.icon);
    this.el = h('div', { class: 'hold-for-menu' }, this.text, this.circle);
    this.circle.addEventListener('pointerenter', () => {
      this.hovered = true;
      this.textAlpha.to(1, 500, Easing.OutQuint, performance.now());
    });
    this.circle.addEventListener('pointerleave', () => {
      this.hovered = false;
      this.textAlpha.to(0, 500, Easing.OutQuint, performance.now());
      this.hold.abort(performance.now());
    });
    this.circle.addEventListener('pointerdown', e => {
      e.stopPropagation();
      e.preventDefault();
      if (performance.now() >= this.pendingAnimationUntil) this.hold.begin(performance.now());
    });
    const up = () => this.hold.abort(performance.now());
    this.circle.addEventListener('pointerup', up);
    this.circle.addEventListener('pointercancel', up);
    this.el.style.opacity = '0';
    this.el.style.pointerEvents = 'none';
  }

  /** SessionStatics.TouchInputActive changed. */
  setTouchActive(v: boolean, now: number): void {
    if (v === this.touchActive) return;
    this.touchActive = v;
    this.el.style.pointerEvents = v ? 'auto' : 'none';
    if (v) this.textAlpha.set(0, now).to(1, 500, Easing.OutQuint, now).then(0, 500, Easing.OutQuint, 1500);
  }

  /** Called when the hold confirms (Confirm → overlay circle animation, ~600ms before another confirm can start). */
  confirmed(now: number): void {
    this.pendingAnimationUntil = now + 700;
  }

  update(now: number): void {
    this.hold.update(now);
    const p = this.hold.progress(now);
    const textA = this.textAlpha.valueAt(now);
    this.text.style.opacity = String(textA);
    let alpha: number;
    if (textA > 0 || p > 0 || this.hovered) alpha = 1;
    else if (this.touchActive) alpha = 0.5;
    else alpha = 0;
    this.el.style.opacity = String(alpha);
    this.progressEl.style.background = `conic-gradient(#fff ${p * 360}deg, transparent 0deg)`;
    this.icon.style.transform = `scale(${1 + p * 0.2})`;
  }
}

// ------------------------------------------------------------------------------------------------ gameplay menu overlay

interface MenuButton {
  el: HTMLButtonElement;
  action: () => void;
}

/** GameplayMenuOverlay (PauseOverlay / FailOverlay). */
export class GameplayMenuOverlay {
  readonly el: HTMLDivElement;
  private readonly buttons: MenuButton[] = [];
  private readonly info: HTMLDivElement;
  private selected = -1;
  visible = false;

  constructor(
    private readonly kind: 'pause' | 'fail',
    actions: { onResume?: () => void; onRetry?: () => void; onQuit?: () => void },
  ) {
    const list = h('div', { class: 'gm-buttons' });
    const add = (text: string, colour: RGBA, action: () => void) => {
      const el = h(
        'button',
        { class: 'gm-button' },
        h('div', { class: 'gm-glow' }, h('i', { class: 'l' }), h('i', { class: 'c' }), h('i', { class: 'r' })),
        h('div', { class: 'gm-colour' }),
        h('span', { class: 'gm-text' }, text),
      );
      el.style.setProperty('--gm-colour', css(colour));
      el.style.setProperty('--gm-colour-0', css(colour, 0));
      const index = this.buttons.length;
      const b: MenuButton = { el, action };
      el.addEventListener('mousemove', () => this.select(index));
      el.addEventListener('mouseleave', () => {
        if (this.selected === index) this.select(-1);
      });
      el.addEventListener('click', () => this.trigger(index));
      this.buttons.push(b);
      list.appendChild(el);
    };
    if (actions.onResume) add('Continue', OsuColour.Green, actions.onResume);
    if (actions.onRetry) add('Retry', OsuColour.YellowDark, actions.onRetry);
    if (actions.onQuit) add('Quit', [170 / 255, 27 / 255, 39 / 255, 1], actions.onQuit);
    this.info = h('div', { class: 'gm-info' });
    this.el = h(
      'div',
      { class: 'gameplay-menu' },
      h('div', { class: 'gm-bg' }),
      h('div', { class: 'gm-grid' }, h('div', { class: 'gm-header' }, kind === 'pause' ? 'paused' : 'failed'), list, this.info, h('div', { class: 'gm-footer' })),
    );
  }

  private select(i: number): void {
    if (i === this.selected) return;
    if (this.selected >= 0) this.buttons[this.selected].el.classList.remove('selected');
    this.selected = i;
    if (i >= 0) this.buttons[i].el.classList.add('selected');
  }

  private trigger(i: number): void {
    const b = this.buttons[i];
    if (!b || !this.visible) return;
    b.el.classList.remove('clicked');
    void b.el.offsetWidth;
    b.el.classList.add('clicked');
    b.action();
    this.hide();
  }

  show(info: { retries: number; progress: number | null; accuracy: string }): void {
    this.info.replaceChildren(
      h('div', null, 'Retry count: ', h('b', null, String(info.retries))),
      info.progress != null ? h('div', null, 'Song progress: ', h('b', null, `${info.progress}%`)) : null,
      h('div', null, 'Accuracy: ', h('b', null, info.accuracy)),
    );
    this.select(-1);
    this.visible = true;
    this.el.classList.add('visible');
  }

  hide(): void {
    this.visible = false;
    this.select(-1);
    this.el.classList.remove('visible');
  }

  /** GlobalAction handling. Returns true if handled. */
  onKey(code: string): boolean {
    if (!this.visible) return false;
    const n = this.buttons.length;
    switch (code) {
      case 'ArrowUp':
        this.select(this.selected <= 0 ? n - 1 : this.selected - 1);
        return true;
      case 'ArrowDown':
        this.select(this.selected < 0 || this.selected >= n - 1 ? 0 : this.selected + 1);
        return true;
      case 'Enter':
      case 'NumpadEnter':
      case 'Space':
        if (this.selected >= 0) this.trigger(this.selected);
        return true;
      case 'Escape':
        this.back();
        return true;
    }
    return false;
  }

  /** BackAction: PauseOverlay → first button (Continue); FailOverlay → last button (Quit). */
  back(): void {
    if (this.buttons.length === 0) return;
    this.trigger(this.kind === 'pause' ? 0 : this.buttons.length - 1);
  }

  /** PauseOverlay: GlobalAction.PauseGameplay (middle mouse) → first button. */
  pauseGameplayAction(): void {
    if (this.kind === 'pause') this.trigger(0);
  }
}

// ------------------------------------------------------------------------------------------------ osu! resume overlay

/** OsuResumeOverlay: click the orange cursor (where the cursor was when pausing) to resume. */
export class OsuResumeOverlay {
  readonly el: HTMLDivElement;
  private readonly cursor: HTMLDivElement;
  private readonly cursorInner: HTMLDivElement;
  hovered = false;
  visible = false;
  onResume: (() => void) | null = null;

  constructor() {
    this.cursorInner = h('div', { class: 'resume-cursor-inner' });
    this.cursor = h('div', { class: 'resume-cursor' }, this.cursorInner);
    this.el = h('div', { class: 'resume-overlay' }, h('div', { class: 'resume-message' }, 'Click the orange cursor to resume'), this.cursor);
    this.cursor.addEventListener('pointerenter', () => this.setHovered(true));
    this.cursor.addEventListener('pointerleave', () => this.setHovered(false));
    this.cursor.addEventListener('pointerdown', e => {
      e.stopPropagation();
      if (e.button === 0 || e.button === 2 || e.pointerType !== 'mouse') this.resume();
    });
  }

  private setHovered(v: boolean): void {
    this.hovered = v;
    this.cursor.classList.toggle('hover', v);
  }

  show(x: number, y: number): void {
    this.visible = true;
    this.cursor.style.left = `${x}px`;
    this.cursor.style.top = `${y}px`;
    this.cursorInner.classList.remove('appear', 'resume');
    void this.cursorInner.offsetWidth;
    this.cursorInner.classList.add('appear');
    this.el.classList.add('visible');
  }

  hide(): void {
    this.visible = false;
    this.setHovered(false);
    this.el.classList.remove('visible');
  }

  /** OsuClickToResumeCursor.OnPressed (LeftButton / RightButton while hovered). */
  tryResumeFromAction(): boolean {
    if (!this.visible || !this.hovered) return false;
    this.resume();
    return true;
  }

  private resume(): void {
    if (!this.visible) return;
    this.cursorInner.classList.add('resume');
    this.hide();
    this.onResume?.();
  }
}

