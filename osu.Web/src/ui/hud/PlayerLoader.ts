// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// The PlayerLoader stage of gameplay: port of osu.Game/Screens/Play/PlayerLoader.cs (timings, content in/out transitions,
// quick restart black layer, low-pass on the music), BeatmapMetadataDisplay.cs (layout) and PlayerLoaderDisclaimer.cs.
// The player settings side panel (visual / audio / input settings) is not ported.

import { APP_NAME } from '../../brand';
import { MOD_BY_ACRONYM, type ModSet } from '../../game/mods/Mods';
import { h, starColour } from '../dom';
import { css } from './anim';
import { colourForModType } from './HudComponents';
import './hud.css';

/** PlayerLoader.PlayerPushDelay = 1800 + disclaimers.Count * 500 */
export const PLAYER_PUSH_BASE_DELAY = 1800;
export const CONTENT_OUT_DURATION = 300;
export const QUICK_RESTART_INITIAL_DELAY = 500;

export interface MetadataInfo {
  title: string;
  artist: string;
  version: string;
  source: string;
  mapper: string;
  stars?: number;
  backgroundUrl: string | null;
  mods: ModSet;
  epilepsyWarning: boolean;
  /** Shown under the mods for replays (not part of lazer's loader; lazer shows it as a ReplayPlayer message). */
  watching?: string;
}

export class PlayerLoaderView {
  readonly el: HTMLDivElement;
  private readonly content: HTMLDivElement;
  private readonly metadata: HTMLDivElement;
  private readonly loadingLayer: HTMLDivElement;
  private readonly disclaimers: HTMLDivElement;
  private blackLayer: HTMLDivElement | null = null;
  readonly disclaimerCount: number;

  constructor(info: MetadataInfo) {
    const thumb = h(
      'div',
      { class: 'pl-thumb' },
      info.backgroundUrl ? h('div', { class: 'pl-thumb-img', style: { backgroundImage: `url("${info.backgroundUrl}")` } }) : null,
      (this.loadingLayer = h('div', { class: 'pl-loading visible' }, h('div', { class: 'pl-spinner' }, h('div', { class: 'pl-spinner-icon' })))),
    );
    const stars =
      info.stars != null && info.stars > 0
        ? h('div', { class: 'pl-stars', style: { background: starColour(info.stars), color: info.stars >= 6.5 ? '#ffd966' : 'rgba(0,0,0,0.75)' } }, `★ ${info.stars.toFixed(2)}`)
        : null;
    const modIcons = h(
      'div',
      { class: 'pl-mods' },
      info.mods.list.map(a => {
        const el = h('div', { class: 'pl-mod' }, h('span', null, a));
        el.style.setProperty('--mod-colour', css(colourForModType(MOD_BY_ACRONYM.get(a)?.type ?? 'fun')));
        return el;
      }),
    );
    this.metadata = h(
      'div',
      { class: 'pl-metadata' },
      h('div', { class: 'pl-logo' }, h('span', null, APP_NAME)),
      h('div', { class: 'pl-title' }, info.title),
      h('div', { class: 'pl-artist' }, info.artist),
      thumb,
      h('div', { class: 'pl-version' }, h('div', null, info.version), stars),
      h(
        'div',
        { class: 'pl-lines' },
        h('div', { class: 'pl-label' }, 'Source'),
        h('div', { class: 'pl-value' }, info.source || '-'),
        h('div', { class: 'pl-label' }, 'Mapper'),
        h('div', { class: 'pl-value' }, info.mapper || '-'),
      ),
      modIcons,
      info.watching ? h('div', { class: 'pl-watching' }, info.watching) : null,
    );
    this.content = h('div', { class: 'pl-content' }, this.metadata);
    this.disclaimers = h(
      'div',
      { class: 'pl-disclaimers' },
      info.epilepsyWarning
        ? h(
            'div',
            { class: 'pl-disclaimer' },
            h('div', { class: 'pl-disclaimer-bar' }),
            h('div', null, h('div', { class: 'pl-disclaimer-title' }, 'This beatmap contains scenes with rapidly flashing colours'), h('div', { class: 'pl-disclaimer-text' }, 'Please take caution if you are affected by epilepsy.')),
          )
        : null,
    );
    this.disclaimerCount = info.epilepsyWarning ? 1 : 0;
    this.el = h('div', { class: 'player-loader' }, this.content, this.disclaimers);
  }

  get pushDelay(): number {
    return PLAYER_PUSH_BASE_DELAY + this.disclaimerCount * 500;
  }

  /** OnEntering (first load) / OnResuming (retry) → contentIn. */
  enter(mode: 'first' | 'restart' | 'quick'): void {
    const c = this.content.style;
    const m = this.metadata.style;
    const d = this.disclaimers.style;
    const set = (s: CSSStyleDeclaration, transition: string, props: Partial<CSSStyleDeclaration>) => {
      s.transition = transition;
      Object.assign(s, props);
    };
    // Start state.
    set(c, 'none', { opacity: '0', transform: 'scale(0.7)' });
    set(m, 'none', { opacity: mode === 'first' ? '0' : '1' });
    set(d, 'none', { opacity: '0', transform: 'translateX(-100%)' });
    void this.el.offsetWidth;
    if (mode === 'quick') {
      this.blackLayer = h('div', { class: 'pl-black' });
      this.el.prepend(this.blackLayer);
      void this.blackLayer.offsetWidth;
      this.blackLayer.style.transition = 'opacity 5000ms cubic-bezier(0.23, 1, 0.32, 1) 50ms';
      this.blackLayer.style.opacity = '0';
      // content.Delay(500).ScaleTo(1).FadeInFromZero(500, OutQuint)
      set(c, `opacity 500ms cubic-bezier(0.23, 1, 0.32, 1) ${QUICK_RESTART_INITIAL_DELAY}ms, transform 0ms linear ${QUICK_RESTART_INITIAL_DELAY}ms`, { opacity: '1', transform: 'scale(1)' });
      return;
    }
    const sideDelay = mode === 'first' ? 750 : 0;
    set(c, 'opacity 500ms cubic-bezier(0.23, 1, 0.32, 1), transform 650ms cubic-bezier(0.23, 1, 0.32, 1)', { opacity: '1', transform: 'scale(1)' });
    if (mode === 'first') set(m, 'opacity 500ms cubic-bezier(0.23, 1, 0.32, 1) 500ms', { opacity: '1' });
    set(d, `opacity 500ms cubic-bezier(0, 0, 0.58, 1) ${sideDelay}ms, transform 500ms cubic-bezier(0.23, 1, 0.32, 1) ${sideDelay}ms`, { opacity: '1', transform: 'translateX(0)' });
  }

  /** Whether the content is still invisible (quick restart before the 500ms delay). */
  get contentHidden(): boolean {
    return parseFloat(getComputedStyle(this.content).opacity) < 0.01;
  }

  setLoading(loading: boolean): void {
    this.loadingLayer.classList.toggle('visible', loading);
  }

  /** ContentOut */
  contentOut(): void {
    const c = this.content.style;
    c.transition = `opacity ${CONTENT_OUT_DURATION}ms cubic-bezier(0.23, 1, 0.32, 1), transform ${CONTENT_OUT_DURATION * 2}ms cubic-bezier(0.23, 1, 0.32, 1)`;
    c.opacity = '0';
    c.transform = 'scale(0.7)';
    const d = this.disclaimers.style;
    d.transition = `opacity ${CONTENT_OUT_DURATION}ms cubic-bezier(0, 0, 0.58, 1), transform ${CONTENT_OUT_DURATION * 2}ms cubic-bezier(0.23, 1, 0.32, 1)`;
    d.opacity = '0';
    d.transform = 'translateX(-100%)';
    if (this.blackLayer) {
      this.blackLayer.style.transition = 'opacity 500ms cubic-bezier(0.23, 1, 0.32, 1)';
      this.blackLayer.style.opacity = '0';
    }
    this.el.style.pointerEvents = 'none';
  }
}
