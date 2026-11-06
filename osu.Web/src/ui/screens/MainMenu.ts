// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Intro + main menu (IntroScreen / MainMenu essentials).

import { h } from '../dom';
import type { Game } from '../Game';
import { openSettings } from '../overlays/Settings';
import { Screen } from '../Screen';
import { SongSelectScreen } from './SongSelect';

export class MainMenuScreen extends Screen {
  private logo: HTMLButtonElement;
  private nowPlaying: HTMLDivElement;
  private hint: HTMLDivElement;
  private buttons: HTMLDivElement;
  private started = false;
  private raf = 0;
  private unsub: (() => void) | null = null;

  constructor(game: Game) {
    super(game, 'menu');
    this.backgroundDim = 0.55;
    this.logo = h('button', { class: 'logo', 'aria-label': 'Start', onclick: () => this.onLogo() }, 'osu!');
    this.hint = h('div', { class: 'splash-hint' }, 'Click the circle to start');
    this.nowPlaying = h('div', { class: 'now-playing' });
    this.buttons = h(
      'div',
      { class: 'menu-buttons', style: { display: 'none' } },
      h('button', { class: 'btn primary', onclick: () => this.play() }, 'Play'),
      h('button', { class: 'btn', onclick: () => this.game.openFilePicker() }, 'Import beatmaps'),
      h('button', { class: 'btn', onclick: () => openSettings(this.game) }, 'Settings'),
    );
    this.el.append(
      this.nowPlaying,
      this.logo,
      this.hint,
      this.buttons,
      h(
        'div',
        { class: 'menu-footer' },
        h('span', null, 'osu!web — a browser port of osu!lazer'),
        h('span', null, 'Drop .osz files anywhere to import · ', h('span', { class: 'kbd' }, 'Ctrl'), ' + ', h('span', { class: 'kbd' }, 'O'), ' settings'),
      ),
    );
  }

  onEnter(): void {
    this.unsub = this.game.subscribe(() => this.updateNowPlaying());
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      const beat = this.game.beatPhase();
      if (beat) {
        const kick = Math.pow(1 - beat.phase, 4);
        this.logo.style.transform = `scale(${1 + kick * (beat.kiai ? 0.05 : 0.025)})`;
      } else this.logo.style.transform = '';
    };
    this.raf = requestAnimationFrame(loop);
  }

  onResume(): void {
    this.game.setBackgroundDim(this.backgroundDim);
    this.updateNowPlaying();
  }

  onExit(): void {
    cancelAnimationFrame(this.raf);
    this.unsub?.();
  }

  private updateNowPlaying(): void {
    const w = this.game.working;
    this.nowPlaying.textContent = w && this.started ? `♪ ${w.entry.artist} - ${w.entry.title}` : '';
  }

  private async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.hint.style.display = 'none';
    this.buttons.style.display = '';
    await this.game.ensureAudio();
    this.game.playUiSample('menu-confirm', 0.6);
    await this.game.library.load();
    const sets = this.game.library.sets;
    if (!this.game.working && sets.length > 0) {
      const s = sets[Math.floor(Math.random() * sets.length)];
      this.game.select(s, s.beatmaps[0], false);
    }
    void this.game.startPreview();
    this.updateNowPlaying();
  }

  private onLogo(): void {
    if (!this.started) void this.start();
    else this.play();
  }

  private play(): void {
    void this.start().then(() => {
      this.game.playUiSample('menu-click', 0.6);
      this.game.push(new SongSelectScreen(this.game));
    });
  }

  onKeyDown(e: KeyboardEvent): boolean {
    if (e.code === 'Enter' || e.code === 'Space' || e.code === 'KeyP') {
      this.onLogo();
      return true;
    }
    if (e.ctrlKey && e.code === 'KeyO') {
      openSettings(this.game);
      return true;
    }
    return false;
  }

  onBack(): boolean {
    return false;
  }
}
