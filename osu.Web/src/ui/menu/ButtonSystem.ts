// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Ports of osu.Game/Screens/Menu/ButtonSystem.cs, MainMenuButton.cs, ButtonArea.cs, FlowContainerWithOrigin.cs and
// osu.Game/Graphics/Containers/LogoTrackingContainer.cs (+ the buttons' ParallaxContainer from MainMenu.cs).
//
// Buttons available offline: top level = play, browse (→ import beatmaps), settings; play = solo. Multiplayer,
// playlists, daily challenge, the editors and exit (the host can't exit on the web) are not shown.

import type { Game } from '../Game';
import { BeatSync, type MenuBeatSource } from './BeatSync';
import { icon, type ICONS } from './icons';
import type { OsuLogo } from './OsuLogo';
import { Anim, clamp, damp, Easing, lerp, Scheduler, valueAt } from './Transforms';
import { applyEasing } from '../../game/storyboard/Easing';

export const BUTTON_WIDTH = 140;
export const WEDGE_WIDTH = 20;
export const BUTTON_AREA_HEIGHT = 100;
const BOUNCE_COMPRESSION = 0.9;
const HOVER_SCALE = 1.2;
const BOUNCE_ROTATION = 8;

export enum ButtonSystemState {
  Exit,
  Initial,
  TopLevel,
  Play,
  Multi,
  Edit,
  EnteringMode,
}

enum ButtonState {
  Contracted,
  Expanded,
  Exploded,
}

interface ButtonOptions {
  text: string;
  sampleName: string;
  icon: keyof typeof ICONS;
  colour: string;
  action: (b: MainMenuButton, e: Event | null) => void;
  keys: string[];
  padLeft?: number;
  padRight?: number;
  visibleMin?: ButtonSystemState;
  visibleMax?: ButtonSystemState;
}

/** MainMenuButton: a sheared "wedge" button that expands, contracts and explodes with the button system state. */
export class MainMenuButton {
  readonly el: HTMLDivElement;
  private readonly bg: HTMLDivElement;
  private readonly hoverLayer: HTMLDivElement;
  private readonly content: HTMLDivElement;
  private readonly iconEl: HTMLSpanElement;

  readonly visibleMin: ButtonSystemState;
  readonly visibleMax: ButtonSystemState;
  readonly triggerKeys: string[];
  readonly initialWidth: number;
  private readonly padLeft: number;
  private readonly padRight: number;

  /** background.Width (height is always BUTTON_AREA_HEIGHT). */
  readonly bgWidth: Anim;
  readonly alpha = new Anim(0);
  private readonly hoverAlpha = new Anim(0);
  private readonly iconRot = new Anim(0);
  private readonly iconScaleX = new Anim(1);
  private readonly iconScaleY = new Anim(1);
  private readonly iconY = new Anim(0);

  private state = ButtonState.Contracted;
  private buttonSystemState = ButtonSystemState.Exit;
  private contractStyle = 0;
  private hovered = false;
  private rightward = false;
  private readonly beat: BeatSync;
  private time = 0;

  constructor(
    private readonly game: Game,
    private readonly opts: ButtonOptions,
  ) {
    this.padLeft = opts.padLeft ?? 0;
    this.padRight = opts.padRight ?? 0;
    this.initialWidth = BUTTON_WIDTH + this.padLeft + this.padRight;
    this.visibleMin = opts.visibleMin ?? ButtonSystemState.TopLevel;
    this.visibleMax = opts.visibleMax ?? ButtonSystemState.TopLevel;
    this.triggerKeys = opts.keys;
    // LoadComplete: animateState() + FinishTransforms → contracted, width 0.
    this.bgWidth = new Anim(0);

    this.el = document.createElement('div');
    this.el.className = 'mmb';
    this.bg = document.createElement('div');
    this.bg.className = 'mmb-bg';
    this.bg.style.background = opts.colour;
    this.hoverLayer = document.createElement('div');
    this.hoverLayer.className = 'mmb-hover';
    this.bg.appendChild(this.hoverLayer);
    this.content = document.createElement('div');
    this.content.className = 'mmb-content';
    this.content.style.paddingLeft = `${this.padLeft}px`;
    this.content.style.paddingRight = `${this.padRight}px`;
    this.iconEl = icon(opts.icon, 'mmb-icon');
    const text = document.createElement('span');
    text.className = 'mmb-text';
    text.textContent = opts.text;
    const inner = document.createElement('div');
    inner.className = 'mmb-inner';
    inner.append(this.iconEl, text);
    this.content.appendChild(inner);
    this.el.append(this.bg, this.content);

    this.bg.addEventListener('pointerenter', () => this.onHover());
    this.bg.addEventListener('pointerleave', () => this.onHoverLost());
    this.bg.addEventListener('pointerdown', () => {
      if (!this.handlesPositionalInput) return;
      this.hoverAlpha.to(0.1, this.time, 1000, Easing.OutQuint);
    });
    this.bg.addEventListener('pointerup', () => this.hoverAlpha.to(0, this.time, 1000, Easing.OutQuint));
    this.bg.addEventListener('click', e => {
      if (!this.handlesPositionalInput) return;
      this.trigger(e);
    });

    this.beat = new BeatSync((_i, tp) => this.onNewBeat(tp.beatLength));
  }

  get isPresent(): boolean {
    return this.alpha.value > 0.0001 || this.state === ButtonState.Expanded;
  }

  get expanded(): boolean {
    return this.state === ButtonState.Expanded;
  }

  private get handlesPositionalInput(): boolean {
    return this.state !== ButtonState.Exploded && this.bgWidth.value / this.initialWidth >= 0.8;
  }

  private onNewBeat(beatLength: number): void {
    if (!this.hovered) return;
    const duration = beatLength / 2;
    const t = this.time - this.beat.timeSinceLastBeat;
    this.iconRot.to(this.rightward ? BOUNCE_ROTATION : -BOUNCE_ROTATION, t, duration * 2, Easing.InOutSine);
    this.iconY.to(-10, t, duration, Easing.Out).to(0, t + duration, duration, Easing.In);
    this.iconScaleX.to(HOVER_SCALE, t, duration, Easing.Out).to(HOVER_SCALE, t + duration, duration, Easing.In);
    this.iconScaleY.to(HOVER_SCALE, t, duration, Easing.Out).to(HOVER_SCALE * BOUNCE_COMPRESSION, t + duration, duration, Easing.In);
    this.rightward = !this.rightward;
  }

  private onHover(): void {
    this.hovered = true;
    if (this.state !== ButtonState.Expanded || !this.handlesPositionalInput) return;
    const duration = this.beat.timeUntilNextBeat;
    for (const a of [this.iconRot, this.iconScaleX, this.iconScaleY, this.iconY]) a.clear();
    this.iconRot.to(this.rightward ? -BOUNCE_ROTATION : BOUNCE_ROTATION, this.time, duration, Easing.InOutSine);
    this.iconScaleX.to(HOVER_SCALE, this.time, duration, Easing.Out);
    this.iconScaleY.to(HOVER_SCALE * BOUNCE_COMPRESSION, this.time, duration, Easing.Out);
    this.game.playUiSample('menu-hover', 0.5);
    this.bgWidth.to(this.initialWidth * 1.5, this.time, 500, Easing.OutElastic);
  }

  private onHoverLost(): void {
    if (!this.hovered) return;
    this.hovered = false;
    for (const a of [this.iconRot, this.iconScaleX, this.iconScaleY, this.iconY]) a.clear();
    this.iconRot.to(0, this.time, 500, Easing.Out);
    this.iconY.to(0, this.time, 500, Easing.Out);
    this.iconScaleX.to(1, this.time, 200, Easing.Out);
    this.iconScaleY.to(1, this.time, 200, Easing.Out);
    if (this.state === ButtonState.Expanded) this.bgWidth.to(this.initialWidth, this.time, 500, Easing.OutElastic);
  }

  /** OnKeyDown (only while expanded: HandleNonPositionalInput). */
  handleKey(code: string): boolean {
    if (this.state !== ButtonState.Expanded) return false;
    if (!this.triggerKeys.includes(code)) return false;
    this.trigger(null);
    return true;
  }

  triggerClick(): void {
    this.trigger(null);
  }

  private trigger(e: Event | null): void {
    this.game.playUiSample(this.opts.sampleName, 0.6);
    this.opts.action(this, e);
    this.hoverAlpha.clear().set(0.9).to(0, this.time, 800, Easing.OutExpo);
  }

  setButtonSystemState(value: ButtonSystemState, t: number): void {
    if (this.buttonSystemState === value) return;
    this.buttonSystemState = value;
    this.contractStyle = 0;
    let s: ButtonState;
    switch (value) {
      case ButtonSystemState.Initial:
        s = ButtonState.Contracted;
        break;
      case ButtonSystemState.EnteringMode:
        this.contractStyle = 1;
        s = ButtonState.Contracted;
        break;
      default:
        if (value <= this.visibleMax && value >= this.visibleMin) s = ButtonState.Expanded;
        else if (value < this.visibleMin) s = ButtonState.Contracted;
        else s = ButtonState.Exploded;
    }
    if (s === this.state) return;
    this.state = s;
    this.animateState(t);
  }

  private animateState(t: number): void {
    const w = this.initialWidth;
    switch (this.state) {
      case ButtonState.Contracted:
        if (this.contractStyle === 1) {
          this.bgWidth.to(0, t, 400, Easing.InSine);
          this.alpha.to(0, t, 800);
        } else {
          this.bgWidth.to(0, t, 500, Easing.OutExpo);
          this.alpha.to(0, t, 500);
        }
        break;
      case ButtonState.Expanded:
        this.bgWidth.to(w, t, 500, Easing.OutExpo);
        this.alpha.to(1, t, 500 / 6);
        break;
      case ButtonState.Exploded:
        this.bgWidth.to(w * 2, t, 200, Easing.OutExpo);
        this.alpha.to(0, t, (200 / 4) * 3);
        break;
    }
  }

  finishTransforms(): void {
    for (const a of [this.bgWidth, this.alpha, this.hoverAlpha, this.iconRot, this.iconScaleX, this.iconScaleY, this.iconY]) a.finish();
  }

  update(now: number, source: MenuBeatSource, frame: number): void {
    this.time = now;
    this.beat.update(now, source, frame);
    for (const a of [this.bgWidth, this.alpha, this.hoverAlpha, this.iconRot, this.iconScaleX, this.iconScaleY, this.iconY]) a.update(now);
  }

  /** Applies the computed layout (left edge in px within the button area). */
  layout(left: number): void {
    const w = this.bgWidth.value;
    const st = this.el.style;
    const present = this.isPresent;
    st.display = present ? '' : 'none';
    if (!present) return;
    st.transform = `translateX(${left}px)`;
    st.width = `${Math.max(0, w)}px`;
    st.opacity = String(clamp(this.alpha.value, 0, 1));
    this.content.style.opacity = String(clamp((w / this.initialWidth - 0.5) / 0.3, 0, 1));
    this.hoverLayer.style.opacity = String(this.hoverAlpha.value);
    this.bg.style.pointerEvents = this.handlesPositionalInput ? 'auto' : 'none';
    this.iconEl.style.transform = `translateY(${this.iconY.value - 2}px) rotate(${this.iconRot.value}deg) scale(${this.iconScaleX.value}, ${this.iconScaleY.value})`;
  }
}

/** ButtonSystem: the state machine around the logo and the wedge buttons. */
export class ButtonSystem {
  readonly el: HTMLDivElement;
  private readonly area: HTMLDivElement;
  private readonly areaBg: HTMLDivElement;
  private readonly flow: HTMLDivElement;

  /** ButtonArea's inner container alpha. */
  private readonly areaAlpha = new Anim(0);
  private areaVisible = false;
  private readonly areaBgScaleX = new Anim(2);
  private readonly areaBgScaleY = new Anim(0);
  private areaBgFlat = true;
  /** Buttons.FadeInFromZero(500) in MainMenu.OnEntering. */
  readonly alpha = new Anim(1);
  /** buttonsContainer (ParallaxContainer) position offset, animated on suspend/resume. */
  readonly containerX = new Anim(0);
  private parallaxX = 0;
  private parallaxY = 0;
  private parallaxScale = 1;
  private mouse: { x: number; y: number } | null = null;

  private readonly settingsButton: MainMenuButton;
  private readonly backButton: MainMenuButton;
  private readonly buttonsPlay: MainMenuButton[] = [];
  private readonly buttonsTopLevel: MainMenuButton[] = [];
  private readonly all: MainMenuButton[];

  private logo: OsuLogo | null = null;
  private flowX = 0;
  private facadeSize = 0;
  private tracking: { duration: number; easing: Easing; startTime: number | null; startX: number; startY: number } | null = null;
  private readonly scheduler = new Scheduler();
  private logoDelayedAction: number | null = null;
  private time = 0;

  private _state = ButtonSystemState.Initial;
  onStateChanged: ((s: ButtonSystemState) => void) | null = null;
  returnToTopOnIdle = true;
  /** Screen pixels per logical pixel (the menu's UI scale). */
  uiScale = 1;

  onSolo: (() => void) | null = null;
  onSettings: (() => void) | null = null;
  onBeatmapListing: (() => void) | null = null;
  onEdit: (() => void) | null = null;

  constructor(
    private readonly game: Game,
    private readonly source: MenuBeatSource,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'button-system';
    this.area = document.createElement('div');
    this.area.className = 'button-area';
    this.areaBg = document.createElement('div');
    this.areaBg.className = 'button-area-bg';
    this.flow = document.createElement('div');
    this.flow.className = 'button-area-flow';
    this.area.append(this.areaBg, this.flow);
    this.el.appendChild(this.area);

    this.settingsButton = new MainMenuButton(game, {
      text: 'settings',
      sampleName: 'menu-click',
      icon: 'settings',
      colour: 'rgb(85,85,85)',
      action: () => this.onSettings?.(),
      keys: ['KeyO', 'KeyS'],
      padRight: WEDGE_WIDTH,
    });
    this.backButton = new MainMenuButton(game, {
      text: 'back',
      sampleName: 'menu-back',
      icon: 'back',
      colour: 'rgb(51,58,94)',
      action: () => {
        this.state = ButtonSystemState.TopLevel;
      },
      keys: [],
      padRight: WEDGE_WIDTH,
      visibleMin: ButtonSystemState.Play,
      visibleMax: ButtonSystemState.Edit,
    });
    this.buttonsPlay.push(
      new MainMenuButton(game, {
        text: 'solo',
        sampleName: 'menu-click',
        icon: 'solo',
        colour: 'rgb(102,68,204)',
        action: () => this.onSolo?.(),
        keys: ['KeyP'],
        padLeft: WEDGE_WIDTH,
        visibleMin: ButtonSystemState.Play,
        visibleMax: ButtonSystemState.Play,
      }),
    );
    this.buttonsTopLevel.push(
      new MainMenuButton(game, {
        text: 'play',
        sampleName: 'menu-click',
        icon: 'logo',
        colour: 'rgb(102,68,204)',
        action: () => {
          this.state = ButtonSystemState.Play;
        },
        keys: ['KeyP', 'KeyM', 'KeyL'],
        padLeft: WEDGE_WIDTH,
      }),
      new MainMenuButton(game, {
        text: 'generate',
        sampleName: 'menu-click',
        icon: 'edit',
        colour: 'rgb(238,170,0)',
        action: () => this.onEdit?.(),
        keys: ['KeyE', 'KeyG'],
      }),
      new MainMenuButton(game, {
        text: 'browse',
        sampleName: 'menu-click',
        icon: 'browse',
        colour: 'rgb(165,204,0)',
        action: () => this.onBeatmapListing?.(),
        keys: ['KeyB', 'KeyD'],
      }),
    );
    // Flow order (insertion order): settings, back, logo facade, [multi], play buttons, [edit], top level buttons.
    this.all = [this.settingsButton, this.backButton, ...this.buttonsPlay, ...this.buttonsTopLevel];
    for (const b of this.all) this.flow.appendChild(b.el);

    window.addEventListener('pointermove', e => (this.mouse = { x: e.clientX / this.uiScale, y: e.clientY / this.uiScale }));
  }

  /** SetOsuLogo. */
  setOsuLogo(logo: OsuLogo | null): void {
    this.logo = logo;
    if (logo) {
      logo.action = () => this.onOsuLogo();
      this.flowX = WEDGE_WIDTH * 2 - (BUTTON_WIDTH + logo.sizeForFlow / 4);
      this.updateLogoState();
    } else this.stopTracking();
  }

  get state(): ButtonSystemState {
    return this._state;
  }

  set state(value: ButtonSystemState) {
    if (this._state === value) return;
    const lastState = this._state;
    this._state = value;
    this.updateLogoState(lastState);

    // buttonArea.FinishTransforms(true)
    this.areaAlpha.finish();
    this.areaBgScaleX.finish();
    this.areaBgScaleY.finish();
    for (const b of this.all) b.finishTransforms();

    const t = this.time + (lastState === ButtonSystemState.Initial ? 150 : 0);
    this.setAreaState(value, t);
    for (const b of this.all) b.setButtonSystemState(value, t);

    this.onStateChanged?.(value);
  }

  /** ButtonArea.ButtonSystemState. */
  private setAreaState(value: ButtonSystemState, t: number): void {
    switch (value) {
      case ButtonSystemState.Exit:
      case ButtonSystemState.Initial:
      case ButtonSystemState.EnteringMode:
        if (this.areaVisible) {
          this.areaVisible = false;
          this.areaAlpha.to(0, t, 300);
        }
        break;
      case ButtonSystemState.TopLevel:
      case ButtonSystemState.Play:
        if (!this.areaVisible) {
          this.areaVisible = true;
          this.areaAlpha.to(1, t, 300);
        }
        break;
    }
    const flat = value === ButtonSystemState.Initial || value === ButtonSystemState.Exit || value === ButtonSystemState.EnteringMode;
    if (flat !== this.areaBgFlat) {
      this.areaBgFlat = flat;
      if (flat) {
        this.areaBgScaleX.to(2, t, 300, Easing.InSine);
        this.areaBgScaleY.to(0, t, 300, Easing.InSine);
      } else {
        this.areaBgScaleX.to(1, t, 400, Easing.OutQuint);
        this.areaBgScaleY.to(1, t, 400, Easing.OutQuint);
      }
    }
  }

  private startTracking(duration: number, easing: Easing): void {
    this.tracking = { duration, easing, startTime: null, startX: 0, startY: 0 };
    if (this.logo) this.logo.isTracking = true;
  }

  private stopTracking(): void {
    this.tracking = null;
    if (this.logo) this.logo.isTracking = false;
  }

  private updateLogoState(lastState: ButtonSystemState = ButtonSystemState.Initial): void {
    const logo = this.logo;
    if (!logo) return;
    const t = this.time;

    switch (this._state) {
      case ButtonSystemState.Exit:
      case ButtonSystemState.Initial:
        this.scheduler.cancel(this.logoDelayedAction);
        this.logoDelayedAction = this.scheduler.add(t + this.areaAlpha.value * 150, () => {
          this.stopTracking();
          const at = this.time;
          logo.x.clear().to(0.5, at, 800, Easing.OutExpo);
          logo.y.clear().to(0.5, at, 800, Easing.OutExpo);
          logo.scale.to(1, at, 800, Easing.OutExpo);
        });
        if (lastState === ButtonSystemState.TopLevel) this.game.playUiSample('menu-back', 0.3);
        break;

      case ButtonSystemState.TopLevel:
      case ButtonSystemState.Play:
        switch (lastState) {
          case ButtonSystemState.TopLevel: // coming from toplevel to play
            break;
          case ButtonSystemState.Initial: {
            logo.x.clear();
            logo.y.clear();
            const impact = logo.scale.value > 0.6;
            logo.scale.to(0.5, t, 200, Easing.In);
            this.startTracking(200, Easing.In);
            this.scheduler.cancel(this.logoDelayedAction);
            this.logoDelayedAction = this.scheduler.add(t + 200, () => {
              if (impact) logo.impact();
            });
            break;
          }
          default:
            logo.x.clear();
            logo.y.clear();
            this.startTracking(0, Easing.In);
            logo.scale.to(0.5, t, 200, Easing.OutQuint);
            break;
        }
        break;

      case ButtonSystemState.EnteringMode:
        this.startTracking(lastState === ButtonSystemState.Initial ? 400 : 0, Easing.InSine);
        break;
    }
  }

  private onOsuLogo(): boolean {
    switch (this._state) {
      default:
        return false;
      case ButtonSystemState.Initial:
        this.state = ButtonSystemState.TopLevel;
        return true;
      case ButtonSystemState.TopLevel:
        this.buttonsTopLevel[0].triggerClick();
        return false;
      case ButtonSystemState.Play:
        this.buttonsPlay[0].triggerClick();
        return false;
    }
  }

  /** goBack (GlobalAction.Back). */
  goBack(): boolean {
    switch (this._state) {
      case ButtonSystemState.TopLevel:
        this.state = ButtonSystemState.Initial;
        this.game.playUiSample('menu-back', 0.6);
        return true;
      case ButtonSystemState.Edit:
      case ButtonSystemState.Play:
      case ButtonSystemState.Multi:
        this.backButton.triggerClick();
        return true;
      default:
        return false;
    }
  }

  /** OnKeyDown + OnPressed(GlobalAction.Select) + the buttons' trigger keys. */
  onKeyDown(e: KeyboardEvent): boolean {
    if (this._state === ButtonSystemState.Exit) return false;
    if (e.repeat || e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) return false;
    if (/^F\d+$/.test(e.code)) return false;
    if (e.code.startsWith('Audio') || e.code.startsWith('Media') || e.code.startsWith('Volume')) return false;
    if (e.code === 'Escape') return false;

    if (this._state === ButtonSystemState.Initial) {
      this.logo?.triggerClick();
      return true;
    }
    if (e.code === 'Enter' || e.code === 'NumpadEnter') {
      this.logo?.triggerClick();
      return true;
    }
    for (const b of this.all) if (b.handleKey(e.code)) return true;
    return false;
  }

  /** Idle tracking (OsuGame's GameIdleTracker(6000) + ButtonSystem.updateIdleState). */
  onIdle(): void {
    if (!this.returnToTopOnIdle) return;
    if (this._state !== ButtonSystemState.Exit && this._state !== ButtonSystemState.EnteringMode) this.state = ButtonSystemState.Initial;
  }

  update(now: number, elapsed: number, frame: number): void {
    this.time = now;
    this.scheduler.update(now);
    for (const a of [this.areaAlpha, this.areaBgScaleX, this.areaBgScaleY, this.alpha, this.containerX]) a.update(now);
    for (const b of this.all) b.update(now, this.source, frame);

    // ParallaxContainer (ParallaxAmount = 0.01).
    const w = this.el.clientWidth;
    const h = this.el.clientHeight;
    const amount = 0.01;
    let ox = 0;
    let oy = 0;
    if (this.mouse) {
      const rx = this.mouse.x - w / 2;
      const ry = this.mouse.y - h / 2;
      ox = Math.sign(rx) * damp(0, 1, 0.999, Math.abs(rx)) * (w / 2) * amount;
      oy = Math.sign(ry) * damp(0, 1, 0.999, Math.abs(ry)) * (h / 2) * amount;
    }
    const pe = clamp(elapsed, 0, 100);
    this.parallaxX = valueAt(pe, this.parallaxX, ox, 0, 100, Easing.OutQuint);
    this.parallaxY = valueAt(pe, this.parallaxY, oy, 0, 100, Easing.OutQuint);
    this.parallaxScale = valueAt(pe, this.parallaxScale, 1 + amount, 0, 1000, Easing.OutQuint);
  }

  /** Lays out the flow and moves the tracked logo. Call after the logo has updated. */
  layout(): void {
    const w = this.el.clientWidth;
    const h = this.el.clientHeight;
    const logo = this.logo;
    this.el.style.opacity = String(this.alpha.value);
    this.el.style.transform = `translate(${this.containerX.value + this.parallaxX}px, ${this.parallaxY}px) scale(${this.parallaxScale})`;

    this.area.style.opacity = String(this.areaAlpha.value);
    this.area.style.visibility = this.areaAlpha.value > 0 || this._state !== ButtonSystemState.Initial ? 'visible' : 'hidden';
    this.areaBg.style.transform = `scale(${this.areaBgScaleX.value}, ${this.areaBgScaleY.value})`;

    // The logo facade's size follows the tracked logo (LogoTrackingContainer.UpdateAfterChildren).
    if (logo && this.tracking) this.facadeSize = logo.sizeForFlow * logo.scale.value;
    const facadeWidth = this.facadeSize * 0.74;

    // FillFlow with spacing -WEDGE_WIDTH; children: settings, back, facade, play buttons, top level buttons.
    const children: (MainMenuButton | 'facade')[] = [this.settingsButton, this.backButton, 'facade', ...this.buttonsPlay, ...this.buttonsTopLevel];
    let cursor = 0;
    let facadeLeft = 0;
    const lefts = new Map<MainMenuButton, number>();
    let first = true;
    for (const c of children) {
      if (c !== 'facade' && !c.isPresent) continue;
      if (!first) cursor -= WEDGE_WIDTH;
      first = false;
      if (c === 'facade') {
        facadeLeft = cursor;
        cursor += facadeWidth;
      } else {
        lefts.set(c, cursor);
        cursor += Math.max(0, c.bgWidth.value);
      }
    }
    // Flow origin = facade centre, anchored at the area centre + flow position.
    const originX = w / 2 + this.flowX;
    const shift = originX - (facadeLeft + facadeWidth / 2);
    for (const b of this.all) b.layout(shift + (lefts.get(b) ?? 0));

    // Logo tracking: the facade's centre in screen space (through the parallax transform).
    if (logo && this.tracking) {
      const s = this.parallaxScale;
      const fx = (originX - w / 2) * s + w / 2 + this.containerX.value + this.parallaxX;
      const fy = h / 2 + this.parallaxY;
      const tx = fx / w;
      const ty = fy / h;
      const tr = this.tracking;
      if (logo.x.value !== tx || logo.y.value !== ty) {
        if (tr.startTime == null) {
          tr.startTime = this.time;
          tr.startX = logo.x.value;
          tr.startY = logo.y.value;
        }
        if (tr.duration !== 0) {
          const amount = applyEasing(tr.easing, Math.min((this.time - tr.startTime) / tr.duration, 1));
          logo.x.set(lerp(tr.startX, tx, amount));
          logo.y.set(lerp(tr.startY, ty, amount));
        } else {
          logo.x.set(tx);
          logo.y.set(ty);
        }
      }
    }
  }
}
