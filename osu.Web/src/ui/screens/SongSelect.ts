// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Song select (port of the essentials of SongSelect / BeatmapCarousel / BeatmapInfoWedge / BeatmapLeaderboard).

import { settings } from '../../framework/Settings';
import { applyCommonDifficultyMods } from '../../game/mods/Mods';
import { availableRulesets } from '../../game/rulesets';
import type { Ruleset } from '../../game/rulesets/Ruleset';
import { RANK_COLOURS, RANK_DISPLAY, type ScoreRank } from '../../game/scoring/ScoreRank';
import { BeatmapDifficulty } from '../../game/beatmaps/Difficulty';
import { BeatmapEntry, BeatmapSetRecord, Database } from '../../game/storage/Database';
import { findFile } from '../../game/storage/Importer';
import { clear, formatNumber, formatTime, h, starColour, starTextColour } from '../dom';
import type { Game } from '../Game';
import { openModSelect } from '../overlays/ModSelect';
import { openSettings } from '../overlays/Settings';
import { Screen } from '../Screen';
import { PlayerScreen } from './Player';
import { MOD_BY_ACRONYM, MOD_TYPE_COLOURS } from '../../game/mods/Mods';

type SortMode = 'title' | 'artist' | 'creator' | 'difficulty' | 'length' | 'added' | 'bpm';

const RULESET_NAMES = ['osu!', 'osu!taiko', 'osu!catch', 'osu!mania'];

export class SongSelectScreen extends Screen {
  private carousel: HTMLDivElement;
  private info: HTMLDivElement;
  private search: HTMLInputElement;
  private sortSelect: HTMLSelectElement;
  private tabs: HTMLDivElement;
  private modPills: HTMLDivElement;
  private visible: { set: BeatmapSetRecord; beatmaps: BeatmapEntry[] }[] = [];
  private unsubscribe: (() => void)[] = [];
  private starCache = new Map<string, number>();
  private starJob = 0;
  private bgObserver: IntersectionObserver;

  constructor(game: Game) {
    super(game, 'song-select');
    this.backgroundDim = 0.6;

    this.search = h('input', { class: 'search', type: 'search', placeholder: 'Search (title, artist, creator, tags…)', spellcheck: false });
    this.search.addEventListener('input', () => this.refresh());
    this.sortSelect = h(
      'select',
      { class: 'sort', title: 'Sort' },
      ...(['title', 'artist', 'creator', 'difficulty', 'bpm', 'length', 'added'] as SortMode[]).map(m => h('option', { value: m }, `Sort: ${m}`)),
    );
    this.sortSelect.value = settings.get('ui.sortMode', 'title');
    this.sortSelect.addEventListener('change', () => {
      settings.set('ui.sortMode', this.sortSelect.value);
      this.refresh();
    });
    this.tabs = h('div', { class: 'ruleset-tabs' });
    this.carousel = h('div', { class: 'carousel scroll-thin' });
    this.info = h('div', { class: 'ss-info scroll-thin' });
    this.modPills = h('div', { class: 'mod-pills' });

    this.bgObserver = new IntersectionObserver(entries => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        const el = en.target as HTMLElement;
        const setId = el.dataset.set;
        const set = this.game.library.sets.find(s => s.id === setId);
        if (set) {
          const blob = findFile(set.files, set.beatmaps[0].backgroundFile);
          if (blob) el.style.backgroundImage = `url("${thumbUrl(set.id, blob)}")`;
        }
        this.bgObserver.unobserve(el);
      }
    });

    const top = h(
      'div',
      { class: 'ss-top' },
      h('button', { class: 'btn small ghost', onclick: () => this.game.back(), title: 'Back (Esc)' }, '‹ Back'),
      this.tabs,
      this.search,
      this.sortSelect,
    );
    const bottom = h(
      'div',
      { class: 'ss-bottom' },
      h('button', { class: 'btn', onclick: () => openModSelect(this.game) }, 'Mods ', h('span', { class: 'kbd' }, 'F1')),
      h('button', { class: 'btn', onclick: () => this.random() }, 'Random ', h('span', { class: 'kbd' }, 'F2')),
      h('button', { class: 'btn', onclick: () => this.game.openFilePicker() }, 'Import .osz'),
      h('button', { class: 'btn', onclick: () => this.game.openFolderPicker(), title: 'Import a folder (for example an osu!stable Songs folder)' }, 'Import folder'),
      h('button', { class: 'btn ghost', onclick: () => openSettings(this.game) }, '⚙'),
      this.modPills,
      h('div', { class: 'spacer' }),
      h('button', { class: 'btn primary', style: { padding: '12px 30px', fontSize: '17px' }, onclick: () => this.play() }, 'Play ', h('span', { class: 'kbd' }, 'Enter')),
    );
    this.el.append(top, h('div', { class: 'ss-body' }, this.info, this.carousel), bottom);
  }

  onEnter(): void {
    this.unsubscribe.push(this.game.library.subscribe(() => this.refresh()));
    this.unsubscribe.push(this.game.subscribe(() => this.onSelectionChanged()));
    void this.game.library.load().then(() => this.refresh());
    this.refresh();
    if (!matchMedia('(pointer: coarse)').matches) setTimeout(() => this.search.focus({ preventScroll: true }), 50);
  }

  onResume(): void {
    this.game.setBackgroundDim(this.backgroundDim);
    this.refresh();
    this.renderInfo();
  }

  onExit(): void {
    this.unsubscribe.forEach(u => u());
    this.bgObserver.disconnect();
  }

  // ------------------------------------------------------------------ filtering

  private matchesRuleset(e: BeatmapEntry, r: Ruleset): boolean {
    return e.rulesetId === r.id || (e.rulesetId === 0 && r.id !== 0);
  }

  private refresh(): void {
    const r = this.game.ruleset;
    const terms = this.search.value.toLowerCase().split(/\s+/).filter(Boolean);
    const filters: ((e: BeatmapEntry) => boolean)[] = [];
    const textTerms: string[] = [];
    // Support simple osu!-style filters like "stars>4", "ar>=9", "length<120", "bpm>180"
    for (const t of terms) {
      const m = /^(stars|star|sr|ar|od|cs|hp|bpm|length|keys)(<=|>=|<|>|=)([\d.]+)$/.exec(t);
      if (!m) {
        textTerms.push(t);
        continue;
      }
      const v = parseFloat(m[3]);
      const get = (e: BeatmapEntry): number => {
        switch (m[1]) {
          case 'stars':
          case 'star':
          case 'sr':
            return e.stars ?? 0;
          case 'ar':
            return e.approachRate;
          case 'od':
            return e.overallDifficulty;
          case 'cs':
          case 'keys':
            return e.circleSize;
          case 'hp':
            return e.drainRate;
          case 'bpm':
            return e.bpm;
          default:
            return e.length / 1000;
        }
      };
      const cmp = m[2];
      filters.push(e => {
        const x = get(e);
        return cmp === '<' ? x < v : cmp === '>' ? x > v : cmp === '<=' ? x <= v : cmp === '>=' ? x >= v : Math.abs(x - v) < 0.05;
      });
    }

    const sets: { set: BeatmapSetRecord; beatmaps: BeatmapEntry[] }[] = [];
    for (const set of this.game.library.sets) {
      const beatmaps = set.beatmaps.filter(e => {
        if (!this.matchesRuleset(e, r)) return false;
        if (!filters.every(f => f(e))) return false;
        if (textTerms.length === 0) return true;
        const hay = `${e.title} ${e.titleUnicode} ${e.artist} ${e.artistUnicode} ${e.creator} ${e.source} ${e.tags} ${e.difficultyName}`.toLowerCase();
        return textTerms.every(t => hay.includes(t));
      });
      if (beatmaps.length > 0) sets.push({ set, beatmaps: [...beatmaps].sort((a, b) => (a.rulesetId === r.id ? 0 : 1) - (b.rulesetId === r.id ? 0 : 1) || (a.stars ?? 0) - (b.stars ?? 0)) });
    }

    const mode = this.sortSelect.value as SortMode;
    const first = (x: { beatmaps: BeatmapEntry[] }) => x.beatmaps[0];
    const cmpStr = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' });
    sets.sort((a, b) => {
      switch (mode) {
        case 'artist':
          return cmpStr(first(a).artist, first(b).artist);
        case 'creator':
          return cmpStr(first(a).creator, first(b).creator);
        case 'difficulty':
          return Math.max(...a.beatmaps.map(x => x.stars ?? 0)) - Math.max(...b.beatmaps.map(x => x.stars ?? 0));
        case 'length':
          return first(a).length - first(b).length;
        case 'bpm':
          return first(a).bpm - first(b).bpm;
        case 'added':
          return b.set.addedAt - a.set.addedAt;
        default:
          return cmpStr(first(a).title, first(b).title);
      }
    });
    this.visible = sets;

    // Keep a valid selection.
    const w = this.game.working;
    const stillVisible = w && sets.some(s => s.set.id === w.set.id && s.beatmaps.some(b => b.hash === w.entry.hash));
    if (!stillVisible && sets.length > 0) {
      const same = w ? sets.find(s => s.set.id === w.set.id) : undefined;
      const target = same ?? sets[0];
      this.game.select(target.set, target.beatmaps[0]);
    }
    this.renderTabs();
    this.renderCarousel();
    this.renderInfo();
  }

  private onSelectionChanged(): void {
    this.renderTabs();
    this.renderCarousel();
    this.renderInfo();
    this.renderModPills();
  }

  private renderTabs(): void {
    clear(this.tabs);
    for (const r of availableRulesets()) {
      this.tabs.appendChild(
        h(
          'button',
          {
            class: `ruleset-tab${r === this.game.ruleset ? ' active' : ''}`,
            onclick: () => {
              this.game.setRuleset(r);
              this.refresh();
            },
          },
          RULESET_NAMES[r.id] ?? r.name,
        ),
      );
    }
  }

  private renderModPills(): void {
    clear(this.modPills);
    for (const m of this.game.mods.list) {
      const def = MOD_BY_ACRONYM.get(m);
      this.modPills.appendChild(h('span', { class: 'mod-pill', style: { background: def ? MOD_TYPE_COLOURS[def.type] : '#fff' } }, m));
    }
  }

  private renderCarousel(): void {
    const scrollTop = this.carousel.scrollTop;
    clear(this.carousel);
    const w = this.game.working;
    if (this.visible.length === 0) {
      this.carousel.appendChild(
        h(
          'div',
          { class: 'empty-state' },
          this.search.value ? 'No beatmaps match your search.' : `No beatmaps for ${this.game.ruleset.name} yet.`,
          h('br'),
          'Drop .osz files anywhere, or use ',
          h('b', null, 'Import'),
          ' below. You can also import a whole osu!stable Songs folder.',
        ),
      );
      return;
    }
    let selectedEl: HTMLElement | null = null;
    for (const { set, beatmaps } of this.visible) {
      const e = beatmaps[0];
      const selected = w?.set.id === set.id;
      const card = h(
        'div',
        { class: `set-card${selected ? ' selected' : ''}`, 'data-set': set.id, onclick: () => this.game.select(set, selected ? w!.entry : beatmaps[0]) },
        h('div', { class: 't' }, this.displayTitle(e)),
        h('div', { class: 'a' }, `${this.displayArtist(e)} · ${e.creator}`),
        h(
          'div',
          { class: 'dots' },
          beatmaps.map(b => h('span', { class: 'dot', title: `${b.difficultyName} (${(b.stars ?? 0).toFixed(2)}★)`, style: { background: starColour(b.stars ?? 0) } })),
        ),
      );
      this.bgObserver.observe(card);
      this.carousel.appendChild(card);
      if (selected) {
        selectedEl = card;
        const list = h('div', { class: 'diff-list' });
        for (const b of beatmaps) {
          const isSel = w?.entry.hash === b.hash;
          const stars = isSel ? (this.starCache.get(this.starKey(b)) ?? b.stars ?? 0) : (b.stars ?? 0);
          const row = h(
            'div',
            {
              class: `diff-row${isSel ? ' selected' : ''}`,
              onclick: () => (isSel ? this.play() : this.game.select(set, b)),
              ondblclick: () => this.play(),
            },
            h('span', { class: 'star-badge', style: { background: starColour(stars), color: starTextColour(stars) } }, `★ ${stars.toFixed(2)}`),
            h('span', { class: 'name' }, b.difficultyName || 'Normal'),
            h('span', { class: 'mode' }, b.rulesetId !== this.game.ruleset.id ? `convert` : RULESET_NAMES[b.rulesetId]),
          );
          list.appendChild(row);
        }
        this.carousel.appendChild(list);
      }
    }
    this.carousel.scrollTop = scrollTop;
    if (selectedEl) {
      const el = selectedEl;
      requestAnimationFrame(() => {
        const r = el.getBoundingClientRect();
        const cr = this.carousel.getBoundingClientRect();
        if (r.top < cr.top + 20 || r.bottom > cr.bottom - 120) this.carousel.scrollTop += r.top - cr.top - cr.height / 3;
      });
    }
  }

  private displayTitle(e: BeatmapEntry): string {
    return settings.get('ui.preferUnicode', false) && e.titleUnicode ? e.titleUnicode : e.title;
  }

  private displayArtist(e: BeatmapEntry): string {
    return settings.get('ui.preferUnicode', false) && e.artistUnicode ? e.artistUnicode : e.artist;
  }

  private starKey(e: BeatmapEntry): string {
    return `${e.hash}|${this.game.ruleset.id}|${this.game.mods.toString()}`;
  }

  private renderInfo(): void {
    clear(this.info);
    const w = this.game.working;
    if (!w) return;
    const e = w.entry;
    const mods = this.game.mods;
    const r = this.game.ruleset;
    const base = Object.assign(new BeatmapDifficulty(), {
      circleSize: e.circleSize,
      approachRate: e.approachRate,
      overallDifficulty: e.overallDifficulty,
      drainRate: e.drainRate,
    });
    const adjusted = applyCommonDifficultyMods(base, mods, r.id !== 3 && r.id !== 1);
    const rate = mods.rate;
    const key = this.starKey(e);
    const stars = this.starCache.get(key) ?? (mods.isEmpty && e.rulesetId === r.id ? e.stars : undefined);
    if (stars === undefined) this.computeStars(w.set, e, key);

    const bar = (label: string, value: number, baseValue: number, max = 10) =>
      h(
        'div',
        { class: 'stat' },
        h('div', { class: 'stat-label' }, label),
        h('div', { class: 'stat-bar' }, h('div', { class: value > baseValue + 0.01 ? 'boosted' : value < baseValue - 0.01 ? 'reduced' : '', style: { width: `${Math.min(100, (value / max) * 100)}%` } })),
        h('div', { class: 'stat-value' }, value.toFixed(1).replace(/\.0$/, '')),
      );

    const isMania = r.id === 3;
    const keyCount = e.rulesetId === 3 ? Math.round(e.circleSize) : undefined;
    const details = h(
      'div',
      { class: 'panel' },
      h('div', { class: 'ss-title' }, this.displayTitle(e)),
      h('div', { class: 'ss-artist' }, this.displayArtist(e)),
      h(
        'div',
        { class: 'ss-diffname' },
        h('span', { class: 'star-badge', style: { background: starColour(stars ?? 0), color: starTextColour(stars ?? 0) } }, stars === undefined ? '★ …' : `★ ${stars.toFixed(2)}`),
        h('b', null, e.difficultyName),
        h('span', { style: { color: 'var(--fg-dim)' } }, `mapped by ${e.creator}`),
      ),
      h(
        'div',
        { class: 'stats-grid' },
        stat('Length', formatTime(e.length / rate)),
        stat('BPM', String(Math.round(e.bpm * rate))),
        stat('Objects', formatNumber(e.objectCount)),
        isMania || r.id === 1 ? (keyCount ? stat('Keys', String(keyCount)) : null) : bar('Circle size', adjusted.circleSize, e.circleSize),
        r.id === 0 || r.id === 2 ? bar('Approach rate', adjusted.approachRate, e.approachRate) : null,
        bar('Accuracy', adjusted.overallDifficulty, e.overallDifficulty),
        bar('HP drain', adjusted.drainRate, e.drainRate),
      ),
      e.source ? h('div', { style: { marginTop: '10px', color: 'var(--fg-dim)', fontSize: '13px' } }, `Source: ${e.source}`) : null,
      !w.set.builtIn
        ? h(
            'div',
            { style: { marginTop: '12px', display: 'flex', gap: '8px', flexWrap: 'wrap' } },
            h('button', { class: 'btn small ghost', onclick: () => this.deleteSet(w.set) }, 'Delete set'),
            h('button', { class: 'btn small ghost', onclick: () => this.playAuto() }, 'Watch autoplay'),
          )
        : h('div', { style: { marginTop: '12px' } }, h('button', { class: 'btn small ghost', onclick: () => this.playAuto() }, 'Watch autoplay')),
    );
    const board = h('div', { class: 'panel leaderboard' }, h('div', { class: 'leaderboard-title' }, 'Local scores'), h('div', { class: 'empty-state', style: { padding: '10px' } }, 'Loading…'));
    this.info.append(details, board);
    void this.loadScores(e, board);
  }

  private computeStars(set: BeatmapSetRecord, e: BeatmapEntry, key: string): void {
    const job = ++this.starJob;
    const r = this.game.ruleset;
    const mods = this.game.mods;
    if (!r.starRating) return;
    setTimeout(async () => {
      if (job !== this.starJob) return;
      try {
        const working = this.game.working;
        if (!working || working.entry.hash !== e.hash) return;
        const beatmap = await working.getBeatmap();
        if (!r.canConvert(beatmap)) return;
        const value = r.starRating!(r.createPlayable(beatmap, mods.forRuleset(r.shortName, r.availableMods)));
        this.starCache.set(key, value);
        if (mods.isEmpty && e.rulesetId === r.id && e.stars === undefined) e.stars = value;
        if (job === this.starJob) {
          this.renderInfo();
          this.renderCarousel();
        }
        void set;
      } catch {
        /* ignore */
      }
    }, 30);
  }

  private async loadScores(e: BeatmapEntry, board: HTMLElement): Promise<void> {
    let scores: Awaited<ReturnType<typeof Database.getScores>> = [];
    try {
      scores = await Database.getScores(e.hash);
    } catch {
      /* ignore */
    }
    const list = scores.filter(s => s.rulesetId === this.game.ruleset.id).sort((a, b) => b.totalScore - a.totalScore).slice(0, 10);
    board.lastElementChild?.remove();
    if (list.length === 0) {
      board.appendChild(h('div', { class: 'empty-state', style: { padding: '10px' } }, 'No scores yet. Be the first!'));
      return;
    }
    const wrap = h('div');
    for (const s of list) {
      const rank = s.rank as ScoreRank;
      const watch = async () => {
        if (!s.hasReplay || s.id == null) return;
        const replay = await Database.getReplay(s.id);
        const w = this.game.working;
        if (!replay || !w) return;
        const { ModSet } = await import('../../game/mods/Mods');
        this.game.push(new PlayerScreen(this.game, w, this.game.ruleset, new ModSet(s.mods), replay));
      };
      wrap.appendChild(
        h(
          'div',
          { class: 'score-row', style: s.hasReplay ? { cursor: 'pointer' } : {}, title: s.hasReplay ? 'Click to watch the replay' : undefined, onclick: watch },
          h('div', { class: 'rank', style: { color: RANK_COLOURS[rank] ?? '#fff' } }, RANK_DISPLAY[rank] ?? s.rank),
          h(
            'div',
            null,
            h('div', null, h('b', null, formatNumber(s.totalScore)), ` · ${(s.accuracy * 100).toFixed(2)}% · ${s.maxCombo}x`),
            h('div', { class: 'sub' }, `${s.player} · ${new Date(s.date).toLocaleDateString()}${s.mods.length ? ` · ${s.mods.join('')}` : ''}`),
          ),
          h('div', { style: { color: 'var(--fg-dim)', fontWeight: '700', textAlign: 'right' } }, s.pp ? `${Math.round(s.pp)}pp` : '', s.hasReplay ? h('div', { class: 'sub' }, '▶ replay') : null),
        ),
      );
    }
    board.appendChild(wrap);
  }

  private async deleteSet(set: BeatmapSetRecord): Promise<void> {
    if (!confirm(`Delete "${set.beatmaps[0].title}" and all its difficulties?`)) return;
    this.game.working = null;
    await this.game.library.remove(set.id);
    this.game.toast('Beatmap set deleted');
  }

  // ------------------------------------------------------------------ navigation

  private flat(): { set: BeatmapSetRecord; entry: BeatmapEntry }[] {
    return this.visible.flatMap(s => s.beatmaps.map(entry => ({ set: s.set, entry })));
  }

  private moveDifficulty(delta: number): void {
    const list = this.flat();
    const w = this.game.working;
    const idx = list.findIndex(x => x.entry.hash === w?.entry.hash && x.set.id === w?.set.id);
    const next = list[(idx + delta + list.length) % list.length];
    if (next) this.game.select(next.set, next.entry);
  }

  private moveSet(delta: number): void {
    const w = this.game.working;
    const idx = this.visible.findIndex(s => s.set.id === w?.set.id);
    const next = this.visible[(idx + delta + this.visible.length) % this.visible.length];
    if (next) this.game.select(next.set, next.beatmaps[0]);
  }

  private random(): void {
    if (this.visible.length === 0) return;
    const s = this.visible[Math.floor(Math.random() * this.visible.length)];
    this.game.select(s.set, s.beatmaps[Math.floor(Math.random() * s.beatmaps.length)]);
  }

  private play(autoplay = false): void {
    const w = this.game.working;
    if (!w) return;
    const r = this.game.ruleset;
    let mods = this.game.mods.forRuleset(r.shortName, r.availableMods);
    if (autoplay && !mods.has('AT')) mods = mods.toggle('AT');
    this.game.playUiSample('menu-confirm', 0.7);
    this.game.push(new PlayerScreen(this.game, w, r, mods));
  }

  private playAuto(): void {
    this.play(true);
  }

  onKeyDown(e: KeyboardEvent): boolean {
    switch (e.code) {
      case 'ArrowDown':
        this.moveDifficulty(1);
        return true;
      case 'ArrowUp':
        this.moveDifficulty(-1);
        return true;
      case 'ArrowRight':
        if (document.activeElement === this.search && this.search.value) return false;
        this.moveSet(1);
        return true;
      case 'ArrowLeft':
        if (document.activeElement === this.search && this.search.value) return false;
        this.moveSet(-1);
        return true;
      case 'Enter':
      case 'NumpadEnter':
        this.play(e.ctrlKey);
        return true;
      case 'F1':
        openModSelect(this.game);
        return true;
      case 'F2':
        this.random();
        return true;
      case 'Delete':
        if (e.shiftKey && this.game.working && !this.game.working.set.builtIn) {
          void this.deleteSet(this.game.working.set);
          return true;
        }
        return false;
    }
    if (e.ctrlKey && e.code === 'KeyO') {
      openSettings(this.game);
      return true;
    }
    return false;
  }
}

function stat(label: string, value: string): HTMLElement {
  return h('div', { class: 'stat' }, h('div', { class: 'stat-label' }, label), h('div', { class: 'stat-value' }, value));
}

const thumbs = new Map<string, string>();
function thumbUrl(id: string, blob: Blob): string {
  let u = thumbs.get(id);
  if (!u) {
    u = URL.createObjectURL(blob);
    thumbs.set(id, u);
  }
  return u;
}
