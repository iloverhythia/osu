// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Ports of osu.Game/Screens/Menu/SongTicker.cs and MenuTipDisplay.cs.

import type { Game } from '../Game';
import { icon } from './icons';
import { Anim, Easing } from './Transforms';

const FADE_DURATION = 800;

/** SongTicker: title / artist of the current track at the top right, shown for a few seconds on change. */
export class SongTicker {
  readonly el: HTMLDivElement;
  private readonly title: HTMLDivElement;
  private readonly artist: HTMLDivElement;
  readonly alpha = new Anim(0);
  private shownFor: unknown = null;

  constructor(private readonly game: Game) {
    this.el = document.createElement('div');
    this.el.className = 'song-ticker';
    this.title = document.createElement('div');
    this.title.className = 'song-ticker-title';
    this.artist = document.createElement('div');
    this.artist.className = 'song-ticker-artist';
    this.el.append(this.title, this.artist);
  }

  /** Called every frame; shows the ticker when the working beatmap changes (beatmap.BindValueChanged(show, true)). */
  update(now: number, enabled: boolean): void {
    const w = this.game.working;
    if (enabled && w && w !== this.shownFor) {
      this.shownFor = w;
      this.title.textContent = w.entry.titleUnicode || w.entry.title;
      this.artist.textContent = w.entry.artistUnicode || w.entry.artist;
      this.alpha
        .clear()
        .set(0)
        .to(1, now, FADE_DURATION / 2)
        .to(0, now + FADE_DURATION / 2 + 4000, FADE_DURATION);
    }
    this.alpha.update(now);
    this.el.style.opacity = String(this.alpha.value);
  }

  hide(now: number): void {
    this.alpha.clear().to(0, now, 0);
  }
}

/** The tips that apply to this offline web build (a subset of MenuTipDisplay's 30 tips). */
const TIPS = [
  'Press Ctrl+O at the main menu or song select to access settings!',
  'Ctrl-Enter at song select will start a beatmap in autoplay mode!',
  'Most of the hotkeys in the game are configurable and can be changed to anything you want. Check the key bindings section in settings!',
  'Drop .osz beatmaps, .osk skins or .osr replays anywhere to import them!',
];

/** MenuTipDisplay. */
export class MenuTipDisplay {
  readonly el: HTMLDivElement;
  private readonly text: HTMLDivElement;
  private readonly alpha = new Anim(0);
  private readonly scale = new Anim(1);

  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'menu-tip';
    const header = document.createElement('div');
    header.className = 'menu-tip-header';
    header.append(icon('lightbulb', 'menu-tip-icon'), document.createTextNode(' a tip for you:'));
    this.text = document.createElement('div');
    this.text.className = 'menu-tip-text';
    this.el.append(header, this.text);
  }

  showNextTip(now: number): void {
    const tip = TIPS[Math.floor(Math.random() * TIPS.length)];
    this.text.textContent = tip;
    // FadeOut().ScaleTo(0.9).Delay(600).FadeInFromZero(800, OutQuint).ScaleTo(1, 800, OutElasticHalf)
    //   .Delay(1000 + 80 * length).Then().FadeOutFromOne(2000, OutQuint)
    this.alpha.clear().set(0).to(0, now + 600).to(1, now + 600, 800, Easing.OutQuint);
    this.scale.clear().set(0.9).to(1, now + 600, 800, Easing.OutElasticHalf);
    const fadeOutAt = now + 600 + Math.max(800, 1000 + 80 * tip.length);
    this.alpha.to(1, fadeOutAt).to(0, fadeOutAt, 2000, Easing.OutQuint);
  }

  update(now: number, containerAlpha: number, containerScale: number): void {
    this.alpha.update(now);
    this.scale.update(now);
    this.el.style.opacity = String(this.alpha.value * containerAlpha);
    this.el.style.transform = `translateX(-50%) scale(${this.scale.value * containerScale})`;
  }
}
