// Port of osu.Game/Overlays/NowPlayingOverlay.cs + Music/PlaylistOverlay.cs, Playlist.cs, PlaylistItem.cs:
// a 400×130 player (beatmap background, title 25 italic, artist 15 bold italic, previous / play / next, shuffle,
// playlist toggle, and a yellow seekable progress bar) under the toolbar at the top right; the playlist
// (510 high, Gray3) lists the library with a filter box, the current set in yellow.

import './nowplaying.css';
import { settings } from '../../framework/Settings';
import { DeletePending } from '../../game/Collections';
import { h } from '../dom';
import type { Game } from '../Game';

const svg = (d: string) => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 512 512');
  s.innerHTML = `<path d="${d}"/>`;
  return s;
};
// FontAwesome solid StepBackward / StepForward / Random / Bars, regular PlayCircle / PauseCircle.
const ICON = {
  prev: 'M64 468V44c0-6.6 5.4-12 12-12h48c6.6 0 12 5.4 12 12v176.4l195.5-181C352.1 22.3 384 36.6 384 64v384c0 27.4-31.9 41.7-52.5 24.6L136 292.7V468c0 6.6-5.4 12-12 12H76c-6.6 0-12-5.4-12-12z',
  next: 'M384 44v424c0 6.6-5.4 12-12 12h-48c-6.6 0-12-5.4-12-12V291.6l-195.5 181C95.9 489.7 64 475.4 64 448V64c0-27.4 31.9-41.7 52.5-24.6L312 219.3V44c0-6.6 5.4-12 12-12h48c6.6 0 12 5.4 12 12z',
  play: 'M371.7 238l-176-107c-15.8-8.8-35.7 2.5-35.7 21v208c0 18.4 19.8 29.8 35.7 21l176-101c16.4-9.1 16.4-32.8 0-42zM504 256C504 119 393 8 256 8S8 119 8 256s111 248 248 248 248-111 248-248zm-448 0c0-110.5 89.5-200 200-200s200 89.5 200 200-89.5 200-200 200S56 366.5 56 256z',
  pause: 'M256 8C119 8 8 119 8 256s111 248 248 248 248-111 248-248S393 8 256 8zm0 448c-110.3 0-200-89.7-200-200S145.7 56 256 56s200 89.7 200 200-89.7 200-200 200zm96-280v160c0 8.8-7.2 16-16 16h-48c-8.8 0-16-7.2-16-16V176c0-8.8 7.2-16 16-16h48c8.8 0 16 7.2 16 16zm-112 0v160c0 8.8-7.2 16-16 16h-48c-8.8 0-16-7.2-16-16V176c0-8.8 7.2-16 16-16h48c8.8 0 16 7.2 16 16z',
  shuffle: 'M504.971 359.029c9.373 9.373 9.373 24.569 0 33.941l-80 79.984c-15.01 15.01-40.971 4.49-40.971-16.971V416h-58.785a12.004 12.004 0 0 1-8.773-3.812l-70.556-75.596 53.333-57.143L352 336h32v-39.981c0-21.438 25.943-31.998 40.971-16.971l80 79.981zM12 176h84l52.781 56.551 53.333-57.143-70.556-75.596A11.999 11.999 0 0 0 122.785 96H12c-6.627 0-12 5.373-12 12v56c0 6.627 5.373 12 12 12zm372 0v39.984c0 21.46 25.961 31.98 40.971 16.971l80-79.984c9.373-9.373 9.373-24.569 0-33.941l-80-79.981C409.943 24.021 384 34.582 384 56.019V96h-58.785a12.004 12.004 0 0 0-8.773 3.812L96 336H12c-6.627 0-12 5.373-12 12v56c0 6.627 5.373 12 12 12h110.785c3.326 0 6.503-1.381 8.773-3.812L352 176h32z',
  bars: 'M16 132h416c8.837 0 16-7.163 16-16V76c0-8.837-7.163-16-16-16H16C7.163 60 0 67.163 0 76v40c0 8.837 7.163 16 16 16zm0 160h416c8.837 0 16-7.163 16-16v-40c0-8.837-7.163-16-16-16H16c-8.837 0-16 7.163-16 16v40c0 8.837 7.163 16 16 16zm0 160h416c8.837 0 16-7.163 16-16v-40c0-8.837-7.163-16-16-16H16c-8.837 0-16 7.163-16 16v40c0 8.837 7.163 16 16 16z',
};

export class NowPlayingOverlay {
  readonly el: HTMLElement;
  private readonly title: HTMLElement;
  private readonly artist: HTMLElement;
  private readonly bg: HTMLElement;
  private readonly playIcon: HTMLElement;
  private readonly shuffleButton: HTMLElement;
  private readonly playlistButton: HTMLElement;
  private readonly progressFill: HTMLElement;
  private readonly progressBar: HTMLElement;
  private readonly playlist: HTMLElement;
  private readonly playlistItems: HTMLElement;
  private readonly filter: HTMLInputElement;
  private open = false;
  private playlistOpen = false;
  private raf = 0;
  private shownSetId = '';

  constructor(private readonly game: Game) {
    const button = (cls: string, icon: string, title: string, action: () => void) => {
      const b = h('button', { class: `np-button ${cls}`, title, onclick: (e: MouseEvent) => (e.stopPropagation(), action(), b.classList.remove('flash'), void b.offsetWidth, b.classList.add('flash')) }, svg(icon));
      return b;
    };
    this.title = h('div', { class: 'np-title' }, 'Nothing to play');
    this.artist = h('div', { class: 'np-artist' }, 'Nothing to play');
    this.bg = h('div', { class: 'np-bg' });
    this.playIcon = button('np-play', ICON.play, 'Play / pause', () => {
      game.music.togglePause();
      this.update();
    });
    this.shuffleButton = button('np-shuffle', ICON.shuffle, 'Shuffle', () => {
      game.music.shuffle = !game.music.shuffle;
      this.update();
    });
    this.playlistButton = button('np-playlist-button', ICON.bars, 'Playlist', () => this.togglePlaylist());
    this.progressFill = h('div', { class: 'np-progress-fill' });
    this.progressBar = h('div', { class: 'np-progress' }, h('div', { class: 'np-progress-bg' }, this.progressFill));
    this.filter = h('input', { class: 'np-filter', type: 'text', placeholder: 'type to search', spellcheck: false }) as HTMLInputElement;
    this.playlistItems = h('div', { class: 'np-playlist-items' });
    this.playlist = h('div', { class: 'np-playlist' }, h('div', { class: 'np-playlist-inner' }, this.filter, this.playlistItems));

    const player = h(
      'div',
      { class: 'np-player' },
      this.bg,
      h('div', { class: 'np-bottom-area' }),
      this.title,
      this.artist,
      h(
        'div',
        { class: 'np-controls' },
        h(
          'div',
          { class: 'np-centre' },
          button('np-prev', ICON.prev, 'Previous track', () => game.music.previous()),
          this.playIcon,
          button('np-next', ICON.next, 'Next track', () => game.music.next()),
        ),
        this.shuffleButton,
        this.playlistButton,
      ),
      this.progressBar,
    );
    this.el = h('div', { class: 'np-overlay', onpointerdown: (e: PointerEvent) => e.stopPropagation() }, player, this.playlist);

    // HoverableProgressBar: click / drag to seek.
    let dragging = false;
    const seekTo = (e: PointerEvent) => {
      const t = game.previewTrack;
      if (!t) return;
      const r = this.progressBar.getBoundingClientRect();
      game.music.seek(((e.clientX - r.left) / r.width) * t.length);
    };
    this.progressBar.addEventListener('pointerdown', e => {
      dragging = true;
      this.progressBar.setPointerCapture(e.pointerId);
      seekTo(e);
    });
    this.progressBar.addEventListener('pointermove', e => dragging && seekTo(e));
    this.progressBar.addEventListener('pointerup', () => (dragging = false));

    this.filter.addEventListener('input', () => this.renderPlaylist());
    this.filter.addEventListener('keydown', e => {
      if (e.key !== 'Escape') e.stopPropagation();
    });

    document.addEventListener('pointerdown', e => {
      if (!this.open) return;
      const t = e.target as Element;
      if (!this.el.contains(t) && !t.closest?.('.tb-music')) this.hide();
    });
    game.subscribe(() => this.update());
    game.music.subscribe(() => this.update());
    game.library.subscribe(() => this.playlistOpen && this.renderPlaylist());
    settings.subscribe(k => k === 'ui.preferUnicode' && this.update());
  }

  get isOpen(): boolean {
    return this.open;
  }

  toggle(): void {
    if (this.open) this.hide();
    else this.show();
  }

  show(): void {
    if (this.open) return;
    this.open = true;
    this.el.classList.add('shown');
    this.update();
    const tick = () => {
      if (!this.open) return;
      const t = this.game.previewTrack;
      this.progressFill.style.width = t && t.length > 0 ? `${Math.min(1, t.currentTime / t.length) * 100}%` : '0%';
      const playing = !!t?.isRunning;
      if (this.playIcon.dataset.playing !== String(playing)) {
        this.playIcon.dataset.playing = String(playing);
        this.playIcon.replaceChildren(svg(playing ? ICON.pause : ICON.play));
      }
      this.raf = requestAnimationFrame(tick);
    };
    cancelAnimationFrame(this.raf);
    tick();
  }

  hide(): void {
    if (!this.open) return;
    this.open = false;
    this.el.classList.remove('shown');
    cancelAnimationFrame(this.raf);
  }

  private togglePlaylist(): void {
    this.playlistOpen = !this.playlistOpen;
    this.playlist.classList.toggle('shown', this.playlistOpen);
    this.playlistButton.classList.toggle('active', this.playlistOpen);
    if (this.playlistOpen) {
      this.renderPlaylist();
      this.filter.focus();
    }
  }

  private update(): void {
    const w = this.game.working;
    const unicode = settings.get<boolean>('ui.preferUnicode', false);
    this.title.textContent = w ? (unicode && w.entry.titleUnicode) || w.entry.title : 'Nothing to play';
    this.artist.textContent = w ? (unicode && w.entry.artistUnicode) || w.entry.artist : 'Nothing to play';
    // Background (crossfades like the BufferedContainer swap).
    const id = w?.set.id ?? '';
    if (id !== this.shownSetId) {
      this.shownSetId = id;
      const url = w?.getBackgroundUrl() ?? null;
      this.bg.style.backgroundImage = url ? `url("${url}")` : '';
      this.bg.classList.toggle('default', !url);
      if (this.playlistOpen) this.renderPlaylist();
    }
    this.shuffleButton.classList.toggle('active', this.game.music.shuffle);
  }

  private renderPlaylist(): void {
    const pending = new Set(DeletePending.all());
    const words = this.filter.value.toLowerCase().split(/\s+/).filter(Boolean);
    const cur = this.game.working?.set.id;
    const unicode = settings.get<boolean>('ui.preferUnicode', false);
    const rows = this.game.library.sets
      .filter(s => s.beatmaps.length && !pending.has(s.id))
      .filter(s => {
        const e = s.beatmaps[0];
        const hay = `${e.title} ${e.titleUnicode} ${e.artist} ${e.artistUnicode} ${e.creator ?? ''} ${e.tags ?? ''}`.toLowerCase();
        return words.every(w => hay.includes(w));
      })
      .map(s => {
        const e = s.beatmaps[0];
        const row = h(
          'button',
          { class: `np-item${s.id === cur ? ' selected' : ''}`, onclick: () => this.game.music.playSet(s) },
          h('span', { class: 'np-handle' }, '≡'),
          h('span', { class: 'np-item-text' }, h('span', { class: 'np-item-title' }, (unicode && e.titleUnicode) || e.title), '  ', h('span', { class: 'np-item-artist' }, (unicode && e.artistUnicode) || e.artist)),
        );
        return row;
      });
    this.playlistItems.replaceChildren(...rows);
    this.playlistItems.querySelector('.np-item.selected')?.scrollIntoView({ block: 'nearest' });
  }
}
