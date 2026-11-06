// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game/Screens/Select/WedgeBackground.cs, BeatmapTitleWedge.cs (+ .DifficultyDisplay, .DifficultyStatisticsDisplay,
// .StatisticDifficulty, .Statistic), BeatmapDetailsArea.cs (+ .Header, .WedgeSelector), BeatmapMetadataWedge.cs (+ .MetadataDisplay,
// .TagsLine; offline parts only), BeatmapLeaderboardWedge.cs + BeatmapLeaderboardScore.cs (local scope) and NoResultsPlaceholder.cs.

import type { Beatmap } from '../../game/beatmaps/Beatmap';
import type { WorkingBeatmap } from '../../game/beatmaps/WorkingBeatmap';
import { MOD_BY_ACRONYM, ModSet } from '../../game/mods/Mods';
import type { Ruleset } from '../../game/rulesets/Ruleset';
import type { ScoreRank } from '../../game/scoring/ScoreRank';
import type { ScoreRecord } from '../../game/storage/Database';
import { HitResult } from '../../game/scoring/HitResult';
import { clear, h } from '../dom';
import { cssEasing, Easing, tween } from './Anim';
import { css, forModType, forRank, OsuColour, OverlayColourProvider, rankLetter, rankLetterColour, WHITE, lighten } from './Colours';
import { MenuItem, ShearedDropdown, shearedToggle, showContextMenu, StarRatingDisplay, statusPill, updateStatusPill } from './Components';
import { createDisplayPlayable, decodeEntry, difficultyCache, getStatistics } from './DifficultyCache';
import { format0dd, getBeatmapAttributesForDisplay } from './DisplayAttributes';
import { BeatmapOnlineStatus, FilterCriteria } from './FilterCriteria';
import { icon } from './Icons';
import { roundBPM } from './BeatmapCarouselFilters';

/** SongSelect.WEDGE_CONTENT_MARGIN = CORNER_RADIUS_HIDE_OFFSET + OsuGame.SCREEN_EDGE_MARGIN */
export const CORNER_RADIUS_HIDE_OFFSET = 20;
export const SCREEN_EDGE_MARGIN = 12;
export const WEDGE_CONTENT_MARGIN = CORNER_RADIUS_HIDE_OFFSET + SCREEN_EDGE_MARGIN;
export const ENTER_DURATION = 600;

export interface SongSelectHost {
  readonly colours: OverlayColourProvider;
  working(): WorkingBeatmap | null;
  ruleset(): Ruleset;
  mods(): ModSet;
  setMods(m: ModSet): void;
  preferUnicode(): boolean;
  addToSearch(text: string): void;
  watchReplay(score: ScoreRecord): void;
  deleteScore(score: ScoreRecord): void;
  playSample(name: string, volume?: number): void;
  overlayHost(): HTMLElement;
}

/** WedgeBackground: additive Background2 glow + Background5 fill fading out over the right 30%. */
export function wedgeBackground(c: OverlayColourProvider, opts: { startAlpha?: number; finalAlpha?: number; widthForGradient?: number; mirrored?: boolean } = {}): HTMLDivElement {
  const start = opts.startAlpha ?? 0.9;
  const final = opts.finalAlpha ?? 0.6;
  const w = (opts.widthForGradient ?? 0.3) * 100;
  const el = h(
    'div',
    { class: 'wedge-bg' },
    h('div', { class: 'wedge-bg-glow', style: { background: `linear-gradient(90deg, ${css(c.background2)}, ${css(c.background2, 0)})` } }),
    h('div', { class: 'wedge-bg-fill', style: { background: `linear-gradient(90deg, ${css(c.background5, start)} 0%, ${css(c.background5, start)} ${100 - w}%, ${css(c.background5, final)} 100%)` } }),
  );
  if (opts.mirrored) el.style.transform = 'scaleX(-1)';
  return el;
}

/** VisibilityContainer PopIn/PopOut used by the wedges: MoveToX(0 / ±150, ENTER_DURATION, OutQuint) + FadeIn/Out(ENTER_DURATION / 3, In). */
export function setWedgeVisible(el: HTMLElement, visible: boolean, hiddenX: number): void {
  el.style.transition = `transform ${ENTER_DURATION}ms ${cssEasing(Easing.OutQuint)}, opacity ${ENTER_DURATION / 3}ms ${cssEasing(Easing.In)}`;
  el.style.transform = `translateX(${visible ? 0 : hiddenX}px)`;
  el.style.opacity = visible ? '1' : '0';
}

/** TimeDisplayExtensions.ToFormattedDuration */
export function formattedDuration(ms: number): string {
  const total = Math.floor(Math.abs(ms) / 1000);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const hr = Math.floor(total / 3600) % 24;
  const d = Math.floor(total / 86400);
  const p = (n: number) => String(n).padStart(2, '0');
  if (d >= 1) return `${p(d)}:${p(hr)}:${p(m)}:${p(s)}`;
  if (hr >= 1) return `${p(hr)}:${p(m)}:${p(s)}`;
  return `${p(m)}:${p(s)}`;
}

/** MarqueeContainer: scrolls its content when it overflows, with OverflowSpacing between repeats. */
function marquee(cls: string): { el: HTMLDivElement; set(text: string): void } {
  const inner = h('div', { class: 'marquee-inner' });
  const el = h('div', { class: `marquee ${cls}` }, inner);
  let current = '';
  const set = (text: string) => {
    if (text === current) return;
    current = text;
    inner.getAnimations?.().forEach(a => a.cancel());
    clear(inner);
    const a = h('span', null, text);
    inner.appendChild(a);
    requestAnimationFrame(() => {
      if (current !== text || !el.isConnected) return;
      const scale = el.getBoundingClientRect().width / Math.max(1, el.offsetWidth);
      const overflow = a.offsetWidth - el.offsetWidth;
      if (overflow <= 0 || !('animate' in inner)) return;
      const spacing = 50;
      inner.appendChild(h('span', { style: { marginLeft: `${spacing}px` } }, text));
      const distance = a.offsetWidth + spacing;
      void scale;
      const speed = 0.04; // px per ms
      const delay = 2000;
      const duration = distance / speed;
      inner.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(0)', offset: delay / (delay + duration) }, { transform: `translateX(${-distance}px)` }], { duration: delay + duration, iterations: Infinity });
    });
  };
  return { el, set };
}

// ---------------------------------------------------------------- BeatmapTitleWedge

class StatisticDifficulty {
  readonly el: HTMLDivElement;
  private readonly bar: HTMLDivElement;
  private readonly adjustedBar: HTMLDivElement;
  private readonly label: HTMLDivElement;
  private readonly value: HTMLSpanElement;
  private readonly valueIcon: HTMLSpanElement;
  labelText = '';

  constructor(private readonly colours: OverlayColourProvider) {
    this.bar = h('div', { class: 'sd-bar' });
    this.adjustedBar = h('div', { class: 'sd-bar adjusted' });
    this.label = h('div', { class: 'sd-label' });
    this.label.style.color = css(colours.content2);
    this.value = h('span', { class: 'sd-value' });
    this.valueIcon = h('span', { class: 'sd-value-icon' });
    this.el = h('div', { class: 'stat-difficulty' }, h('div', { class: 'sd-bars' }, h('div', { class: 'sd-bar back' }), this.bar, this.adjustedBar), this.label, h('div', { class: 'sd-value-row' }, this.value, this.valueIcon));
  }

  set accent(c: string) {
    this.bar.style.background = c;
  }

  setValue(d: { label: string; value: number; adjustedValue: number; maximum: number; content?: string }): void {
    const ease = cssEasing(Easing.OutQuint);
    const frac = (v: number) => (d.maximum === 0 ? 0 : Math.max(0, Math.min(1, v / d.maximum)));
    this.bar.style.transition = this.adjustedBar.style.transition = `width 300ms ${ease}, opacity 300ms ${ease}, background 300ms ${ease}`;
    this.value.style.transition = `color 300ms ${ease}`;
    this.bar.style.width = `${frac(d.value) * 100}%`;
    this.adjustedBar.style.width = `${frac(d.adjustedValue) * 100}%`;
    this.labelText = d.label;
    this.label.textContent = d.label;
    this.value.textContent = d.content ?? format0dd(d.adjustedValue);
    clear(this.valueIcon);
    if (d.value === d.adjustedValue) {
      this.adjustedBar.style.background = 'transparent';
      this.bar.style.opacity = '1';
      this.value.style.color = '#fff';
    } else if (d.value < d.adjustedValue) {
      this.adjustedBar.style.zIndex = '0';
      this.bar.style.zIndex = '1';
      this.bar.style.opacity = '1';
      this.adjustedBar.style.background = `linear-gradient(90deg, #000, ${css(OsuColour.Red1)})`;
      this.value.style.color = css(OsuColour.Red1);
      this.valueIcon.appendChild(icon('sortUp', 8));
      this.valueIcon.style.color = css(OsuColour.Red1);
    } else {
      this.bar.style.opacity = '0.5';
      this.adjustedBar.style.zIndex = '2';
      this.adjustedBar.style.background = css(OsuColour.Lime1);
      this.value.style.color = css(OsuColour.Lime1);
      this.valueIcon.appendChild(icon('sortDown', 8));
      this.valueIcon.style.color = css(OsuColour.Lime1);
    }
  }
}

/** BeatmapTitleWedge.DifficultyStatisticsDisplay */
class DifficultyStatisticsDisplay {
  readonly el: HTMLDivElement;
  private readonly flow: HTMLDivElement;
  private readonly tiny: HTMLDivElement;
  private stats: StatisticDifficulty[] = [];
  private accent = '#fff';
  private data: { label: string; value: number; adjustedValue: number; maximum: number; content?: string }[] = [];

  constructor(
    private readonly colours: OverlayColourProvider,
    private readonly autoSize: boolean,
  ) {
    this.flow = h('div', { class: 'dsd-flow' });
    this.tiny = h('div', { class: 'dsd-tiny' });
    this.el = h('div', { class: `dsd${autoSize ? ' auto' : ''}` }, this.flow, this.tiny);
  }

  setAccent(c: string): void {
    if (c === this.accent) return;
    this.accent = c;
    for (const s of this.stats) s.accent = c;
  }

  set(data: { label: string; value: number; adjustedValue: number; maximum: number; content?: string }[]): void {
    this.data = data;
    if (this.stats.length === data.length && this.stats.every((s, i) => s.labelText === data[i].label)) data.forEach((d, i) => this.stats[i].setValue(d));
    else {
      clear(this.flow);
      this.stats = data.map(d => {
        const s = new StatisticDifficulty(this.colours);
        s.accent = this.accent;
        s.setValue(d);
        s.el.style.opacity = '0';
        this.flow.appendChild(s.el);
        return s;
      });
      requestAnimationFrame(() => {
        // updateStatisticsSizing: every statistic gets the width of the widest label (minimum 65).
        const width = Math.max(65, ...this.stats.map(s => (s.el.querySelector('.sd-label') as HTMLElement).scrollWidth));
        for (const s of this.stats) {
          s.el.style.width = `${width}px`;
          tween(s.el, { opacity: '1' }, 200, Easing.InQuint);
        }
        this.updateLayout();
      });
    }
    clear(this.tiny);
    for (const d of data) {
      const l = h('span', { class: 'tiny-label' }, d.label);
      l.style.color = css(this.colours.content2);
      const v = h('span', { class: 'tiny-value' }, d.content ?? format0dd(d.value));
      v.style.color = css(this.colours.content1);
      this.tiny.append(l, v);
    }
  }

  /** Switch to the compact two-column grid when the full flow doesn't fit. */
  updateLayout(): void {
    if (this.autoSize || this.stats.length === 0) return;
    const w = parseFloat(this.stats[0].el.style.width || '65');
    const flowWidth = w * this.stats.length + 8 * (this.stats.length - 1);
    const tiny = this.el.offsetWidth < flowWidth - 20;
    if (tiny !== this.el.classList.contains('tiny')) {
      this.el.classList.toggle('tiny', tiny);
      const shown = tiny ? this.tiny : this.flow;
      shown.style.opacity = '0';
      tween(shown, { opacity: '1' }, 200, Easing.InQuint);
    }
    void this.data;
  }
}

export class BeatmapTitleWedge {
  readonly el: HTMLDivElement;
  private readonly pill: HTMLDivElement;
  private readonly title = marquee('tw-title');
  private readonly artist = marquee('tw-artist');
  private readonly lengthValue: HTMLSpanElement;
  private readonly lengthStat: HTMLDivElement;
  private readonly bpmValue: HTMLSpanElement;
  private readonly stars: StarRatingDisplay;
  private readonly ratingRow: HTMLDivElement;
  private readonly difficultyText: HTMLSpanElement;
  private readonly mappedBy: HTMLSpanElement;
  private readonly mapperText: HTMLSpanElement;
  private readonly countStats: DifficultyStatisticsDisplay;
  private readonly diffStats: DifficultyStatisticsDisplay;
  private token = 0;
  private starsUnsub: (() => void) | null = null;
  private decoded: { hash: string; beatmap: Beatmap } | null = null;

  constructor(
    private readonly host: SongSelectHost,
    topPadding = 0,
  ) {
    const c = host.colours;
    this.pill = statusPill(BeatmapOnlineStatus.None, true, c, 'tw-pill');
    const titleLink = h('div', { class: 'tw-link', onclick: () => host.addToSearch(this.title.el.textContent ? this.currentTitle : '') }, this.title.el);
    const artistLink = h('div', { class: 'tw-link', onclick: () => host.addToSearch(this.currentArtist) }, this.artist.el);
    const stat = (iconName: string, extraCls = '') => {
      const value = h('span', { class: 'tw-stat-value' });
      value.style.color = css(c.content2);
      const ic = icon(iconName, 18);
      ic.style.color = css(c.content2);
      return { el: h('div', { class: `tw-stat ${extraCls}` }, ic, value), value };
    };
    const length = stat('clock');
    const bpm = stat('metronome', 'bpm');
    this.lengthValue = length.value;
    this.lengthStat = length.el;
    this.bpmValue = bpm.value;
    bpm.el.title = 'BPM';

    this.stars = new StarRatingDisplay('regular', true);
    this.stars.onChange = () => this.updateForegroundColour();
    this.difficultyText = h('span', { class: 'dd-diff' });
    this.mappedBy = h('span', { class: 'dd-mappedby' }, ' mapped by ');
    this.mapperText = h('span', { class: 'dd-mapper' });
    this.mapperText.style.color = css(c.light2);
    this.ratingRow = h('div', { class: 'dd-rating-row' }, this.stars.el, h('div', { class: 'dd-name-line' }, this.difficultyText, this.mappedBy, this.mapperText));
    this.countStats = new DifficultyStatisticsDisplay(c, false);
    this.diffStats = new DifficultyStatisticsDisplay(c, true);
    const statsBox = h('div', { class: 'dd-stats' }, h('div', { class: 'dd-stats-bg', style: { background: css(c.background5, 0.8) } }), h('div', { class: 'dd-stats-grid' }, this.countStats.el, h('div', { class: 'dd-gap' }), this.diffStats.el));
    const difficultyDisplay = h('div', { class: 'difficulty-display' }, h('div', { class: 'sheared-bg' }, wedgeBackground(c)), this.ratingRow, statsBox);

    this.el = h(
      'div',
      { class: 'title-wedge' },
      h('div', { class: 'sheared-bg' }, wedgeBackground(c)),
      h(
        'div',
        { class: 'tw-content', style: { paddingTop: `${WEDGE_CONTENT_MARGIN + topPadding}px`, paddingLeft: `${WEDGE_CONTENT_MARGIN}px` } },
        h('div', { class: 'tw-row' }, this.pill),
        h('div', { class: 'tw-row tw-title-row' }, titleLink),
        h('div', { class: 'tw-row tw-artist-row' }, artistLink),
        h('div', { class: 'tw-row tw-stats' }, length.el, bpm.el),
        h('div', { class: 'tw-row tw-dd-row' }, difficultyDisplay),
      ),
    );
  }

  private currentTitle = '';
  private currentArtist = '';

  update(): void {
    const w = this.host.working();
    const token = ++this.token;
    if (!w) {
      this.ratingRow.style.opacity = '0';
      return;
    }
    const e = w.entry;
    const uni = this.host.preferUnicode();
    this.currentTitle = (uni && e.titleUnicode) || e.title;
    this.currentArtist = (uni && e.artistUnicode) || e.artist;
    this.title.set(this.currentTitle);
    this.artist.set(this.currentArtist);
    updateStatusPill(this.pill, ((e as { status?: BeatmapOnlineStatus }).status ?? BeatmapOnlineStatus.None) as BeatmapOnlineStatus, true, this.host.colours);
    tween(this.ratingRow, { opacity: '1' }, 300, Easing.OutQuint);
    this.difficultyText.textContent = e.difficultyName;
    this.mapperText.textContent = e.creator;

    this.starsUnsub?.();
    this.starsUnsub = difficultyCache.get(w.set, e, this.host.ruleset(), this.host.mods(), s => {
      if (token === this.token) this.stars.set(s);
    });

    this.updateDifficultyStatistics();
    this.updateLengthAndBpm();

    void decodeEntry(w.set, e)
      .then(b => {
        if (token !== this.token) return;
        this.decoded = { hash: e.hash, beatmap: b };
        this.updateLengthAndBpm();
        const playable = createDisplayPlayable(b, this.host.ruleset().id);
        if (!playable) {
          tween(this.countStats.el, { opacity: '0' }, 300, Easing.OutQuint);
          return;
        }
        tween(this.countStats.el, { opacity: '1' }, 200, Easing.OutQuint);
        this.countStats.set(getStatistics(playable).map(s => ({ label: s.name, value: s.barDisplayLength, adjustedValue: s.barDisplayLength, maximum: 1, content: s.content })));
      })
      .catch(() => undefined);
  }

  /** Mods changed: length / bpm / difficulty attributes / star rating. */
  updateMods(): void {
    const w = this.host.working();
    if (!w) return;
    const token = this.token;
    this.starsUnsub?.();
    this.starsUnsub = difficultyCache.get(w.set, w.entry, this.host.ruleset(), this.host.mods(), s => {
      if (token === this.token) this.stars.set(s);
    });
    this.updateDifficultyStatistics();
    this.updateLengthAndBpm();
  }

  private updateLengthAndBpm(): void {
    const w = this.host.working();
    if (!w) return;
    const rate = this.host.mods().rate;
    const e = w.entry;
    const b = this.decoded?.hash === e.hash ? this.decoded.beatmap : null;
    const hitLength = Math.round(e.length / rate);
    this.lengthValue.textContent = formattedDuration(hitLength);
    if (b) this.lengthStat.title = `Drain length: ${formattedDuration(Math.round(b.drainLength / rate))}`;
    const mostCommon = roundBPM(e.bpm, rate);
    if (b && b.controlPoints.timingPoints.length > 0) {
      const lengths = b.controlPoints.timingPoints.map(t => t.beatLength);
      const bpmMax = roundBPM(60000 / Math.min(...lengths), rate);
      const bpmMin = roundBPM(60000 / Math.max(...lengths), rate);
      this.bpmValue.textContent = bpmMin === bpmMax ? `${bpmMin}` : `${bpmMin}-${bpmMax} (mostly ${mostCommon})`;
    } else this.bpmValue.textContent = `${mostCommon}`;
  }

  private updateDifficultyStatistics(): void {
    const w = this.host.working();
    if (!w) {
      this.diffStats.set([]);
      return;
    }
    const attrs = getBeatmapAttributesForDisplay(w.entry, this.host.ruleset().id, this.host.mods().forRuleset(this.host.ruleset().shortName, this.host.ruleset().availableMods));
    this.diffStats.set(attrs.map(a => ({ label: a.label, value: a.originalValue, adjustedValue: a.adjustedValue, maximum: a.maxValue })));
  }

  private updateForegroundColour(): void {
    const col = css(this.stars.foregroundTextColour);
    this.difficultyText.style.color = col;
    this.mappedBy.style.color = col;
    this.countStats.setAccent(col);
    this.diffStats.setAccent(col);
  }

  layout(): void {
    this.countStats.updateLayout();
  }

  setVisible(v: boolean): void {
    setWedgeVisible(this.el, v, -150);
  }
}

// ---------------------------------------------------------------- BeatmapDetailsArea

type DetailsSelection = 'details' | 'ranking';
type LeaderboardSortMode = 'score' | 'accuracy' | 'maxCombo' | 'misses' | 'date';
const SORT_NAMES: Record<LeaderboardSortMode, string> = { score: 'Score', accuracy: 'Accuracy', maxCombo: 'Max Combo', misses: 'Misses', date: 'Date' };

export class BeatmapDetailsArea {
  readonly el: HTMLDivElement;
  private readonly content: HTMLDivElement;
  private readonly tabs: HTMLDivElement;
  private readonly strip: HTMLDivElement;
  private readonly leaderboardControls: HTMLDivElement;
  private readonly sortDropdown: ShearedDropdown<LeaderboardSortMode>;
  private readonly modsToggle: HTMLButtonElement & { setActive(v: boolean): void };
  private selection: DetailsSelection;
  private sort: LeaderboardSortMode;
  private filterBySelectedMods: boolean;
  private current: BeatmapMetadataWedge | BeatmapLeaderboardWedge | null = null;

  constructor(private readonly host: SongSelectHost, private readonly settings: { get<T>(k: string, d: T): T; set(k: string, v: unknown): void }) {
    const c = host.colours;
    this.selection = settings.get<DetailsSelection>('select.detailTab', 'ranking');
    this.sort = settings.get<LeaderboardSortMode>('select.leaderboardSort', 'score');
    this.filterBySelectedMods = settings.get('select.detailModsFilter', false);

    this.strip = h('div', { class: 'ws-strip', style: { background: css(c.highlight1) } });
    this.tabs = h('div', { class: 'wedge-selector' });
    for (const s of ['details', 'ranking'] as DetailsSelection[]) {
      const t = h('div', { class: 'ws-tab', 'data-sel': s, onclick: () => this.select(s, true) }, s === 'details' ? 'Details' : 'Ranking');
      t.addEventListener('mouseenter', () => this.updateTabs());
      t.addEventListener('mouseleave', () => this.updateTabs());
      this.tabs.appendChild(t);
    }
    this.tabs.appendChild(this.strip);

    this.modsToggle = shearedToggle('Selected Mods', this.filterBySelectedMods, v => {
      this.filterBySelectedMods = v;
      settings.set('select.detailModsFilter', v);
      this.refresh();
    });
    this.modsToggle.style.height = '30px';
    this.sortDropdown = new ShearedDropdown<LeaderboardSortMode>('Sort', (Object.keys(SORT_NAMES) as LeaderboardSortMode[]).map(k => ({ value: k, text: SORT_NAMES[k] })), this.sort, v => {
      this.sort = v;
      settings.set('select.leaderboardSort', v);
      this.refresh();
    });
    const scope = new ShearedDropdown<string>('Scope', [{ value: 'local', text: 'Local' }], 'local', () => undefined);
    this.leaderboardControls = h('div', { class: 'lb-controls' }, this.modsToggle, this.sortDropdown.el, scope.el);

    const header = h('div', { class: 'details-header' }, this.tabs, this.leaderboardControls);
    header.addEventListener('mousedown', e => e.stopPropagation());
    this.content = h('div', { class: 'details-content' });
    this.el = h('div', { class: 'details-area' }, header, this.content);
    this.select(this.selection, false);
  }

  private select(s: DetailsSelection, byUser: boolean): void {
    if (byUser && s !== this.selection) this.host.playSample('menu-click', 0.5);
    const changed = s !== this.selection || !this.current;
    this.selection = s;
    this.settings.set('select.detailTab', s);
    tween(this.leaderboardControls, { opacity: s === 'ranking' ? '1' : '0' }, 300, Easing.OutQuint);
    this.leaderboardControls.style.pointerEvents = s === 'ranking' ? '' : 'none';
    this.updateTabs();
    if (!changed) return;
    if (this.current) {
      const old = this.current.el;
      old.style.pointerEvents = 'none';
      tween(old, { opacity: '0' }, 300, Easing.OutQuint);
      setTimeout(() => old.remove(), 300);
    }
    this.current = s === 'details' ? new BeatmapMetadataWedge(this.host) : new BeatmapLeaderboardWedge(this.host, () => ({ sort: this.sort, filterBySelectedMods: this.filterBySelectedMods }));
    this.content.appendChild(this.current.el);
    this.current.show();
  }

  private updateTabs(): void {
    const c = this.host.colours;
    for (const t of [...this.tabs.querySelectorAll<HTMLElement>('.ws-tab')]) {
      const active = t.dataset.sel === this.selection;
      t.classList.toggle('active', active);
      t.style.color = css(active || t.matches(':hover') ? c.content1 : c.content2);
    }
    requestAnimationFrame(() => {
      const active = this.tabs.querySelector<HTMLElement>('.ws-tab.active');
      if (!active) return;
      this.strip.style.transition = `transform 300ms ${cssEasing(Easing.OutQuint)}`;
      this.strip.style.width = `${active.offsetWidth}px`;
      this.strip.style.transform = `translateX(${active.offsetLeft}px)`;
    });
  }

  /** Beatmap / ruleset changed. */
  refresh(): void {
    this.current?.refresh();
  }

  /** Mods changed (only matters for the mods filter / star display). */
  modsChanged(): void {
    if (this.current instanceof BeatmapLeaderboardWedge && this.filterBySelectedMods) this.current.refresh();
  }

  setVisible(v: boolean): void {
    setWedgeVisible(this.el, v, -150);
  }
}

// ---------------------------------------------------------------- BeatmapMetadataWedge

class BeatmapMetadataWedge {
  readonly el: HTMLDivElement;
  private readonly creator: HTMLDivElement;
  private readonly genre: HTMLDivElement;
  private readonly source: HTMLDivElement;
  private readonly language: HTMLDivElement;
  private readonly submitted: HTMLDivElement;
  private readonly ranked: HTMLDivElement;
  private readonly mapperTags: HTMLDivElement;

  constructor(private readonly host: SongSelectHost) {
    const c = host.colours;
    const display = (label: string) => {
      const value = h('div', { class: 'md-value' });
      value.style.color = css(c.content2);
      const el = h('div', { class: 'metadata-display' }, h('div', { class: 'md-label', style: { color: css(c.content1) } }, label), value);
      return { el, value };
    };
    const creator = display('Creator');
    const genre = display('Genre');
    const source = display('Source');
    const language = display('Language');
    const submitted = display('Submitted');
    const ranked = display('Ranked');
    const tags = display('Mapper Tags');
    this.creator = creator.value;
    this.genre = genre.value;
    this.source = source.value;
    this.language = language.value;
    this.submitted = submitted.value;
    this.ranked = ranked.value;
    this.mapperTags = tags.value;
    this.mapperTags.classList.add('md-tags');
    this.el = h(
      'div',
      { class: 'metadata-wedge' },
      h(
        'div',
        { class: 'md-box' },
        h('div', { class: 'sheared-bg' }, wedgeBackground(c)),
        h(
          'div',
          { class: 'md-content' },
          h('div', { class: 'md-grid' }, h('div', { class: 'md-col' }, creator.el, genre.el), h('div', { class: 'md-col' }, source.el, language.el), h('div', { class: 'md-col' }, submitted.el, ranked.el)),
          tags.el,
        ),
      ),
    );
    this.refresh();
  }

  show(): void {
    this.el.style.opacity = '0';
    this.el.style.transform = 'translateX(-100px)';
    void this.el.offsetWidth;
    tween(this.el, { opacity: '1', transform: 'translateX(0)' }, 300, Easing.OutQuint);
  }

  refresh(): void {
    const w = this.host.working();
    if (!w) return;
    const e = w.entry;
    const link = (el: HTMLElement, text: string, action: (() => void) | null) => {
      clear(el);
      if (action) {
        const a = h('span', { class: 'md-link', onclick: action }, text);
        a.style.color = css(this.host.colours.light2);
        el.appendChild(a);
      } else el.textContent = text;
    };
    link(this.creator, e.creator, () => this.host.addToSearch(`creator=${e.creator.includes(' ') ? `"${e.creator}"` : e.creator}`));
    link(this.source, e.source || '-', e.source ? () => this.host.addToSearch(e.source) : null);
    // genre / language / submitted / ranked come from the online lookup (unavailable offline).
    link(this.genre, '-', null);
    link(this.language, '-', null);
    link(this.submitted, '-', null);
    link(this.ranked, '-', null);
    clear(this.mapperTags);
    // TagsLine
    for (const t of e.tags ? e.tags.split(' ').filter(Boolean) : []) {
      const tag = h('span', { class: 'md-tag', onclick: () => this.host.addToSearch(t) }, t);
      tag.style.color = css(this.host.colours.light2);
      this.mapperTags.appendChild(tag);
    }
    if (!e.tags) this.mapperTags.textContent = '';
  }
}

// ---------------------------------------------------------------- BeatmapLeaderboardWedge

const SPACING_BETWEEN_SCORES = 4;
const SCORE_HEIGHT = 50;

class BeatmapLeaderboardWedge {
  readonly el: HTMLDivElement;
  private readonly scroll: HTMLDivElement;
  private readonly scores: HTMLDivElement;
  private readonly placeholder: HTMLDivElement;
  private token = 0;

  constructor(
    private readonly host: SongSelectHost,
    private readonly options: () => { sort: LeaderboardSortMode; filterBySelectedMods: boolean },
  ) {
    this.scores = h('div', { class: 'lb-scores' });
    this.scroll = h('div', { class: 'lb-scroll' }, this.scores);
    this.placeholder = h('div', { class: 'lb-placeholder' });
    this.el = h('div', { class: 'leaderboard-wedge' }, this.scroll, this.placeholder);
    this.scroll.addEventListener('scroll', () => this.updateFade());
    this.refresh();
  }

  show(): void {
    this.el.style.opacity = '0';
    void this.el.offsetWidth;
    tween(this.el, { opacity: '1' }, 300, Easing.OutQuint);
  }

  /** RefetchScores (local scope: LeaderboardManager's realm query + OrderByCriteria). */
  refresh(): void {
    const token = ++this.token;
    this.clearScores();
    const w = this.host.working();
    if (!w) {
      this.setPlaceholder('Please select a beatmap!');
      return;
    }
    const ruleset = this.host.ruleset();
    const { sort, filterBySelectedMods } = this.options();
    const mods = this.host.mods().forRuleset(ruleset.shortName, ruleset.availableMods);
    void import('../../game/storage/Database')
      .then(({ Database }) => Database.getScores(w.entry.hash))
      .catch(() => [] as ScoreRecord[])
      .then(all => {
        if (token !== this.token) return;
        let scores = all.filter(s => s.rulesetId === ruleset.id);
        if (filterBySelectedMods) {
          if (mods.isEmpty) scores = scores.filter(s => s.mods.length === 0);
          else {
            const selected = new Set(mods.list);
            scores = scores.filter(s => s.mods.length === selected.size && s.mods.every(m => selected.has(m)));
          }
        }
        scores = orderByCriteria(scores, sort);
        if (scores.length === 0) {
          this.setPlaceholder('No records yet!');
          return;
        }
        this.setPlaceholder(null);
        this.setScores(scores);
      });
  }

  private setPlaceholder(text: string | null): void {
    clear(this.placeholder);
    if (!text) return;
    const msg = h('div', { class: 'lb-placeholder-msg' }, text);
    this.placeholder.appendChild(msg);
    msg.style.opacity = '0';
    msg.style.transform = 'scale(0.8)';
    void msg.offsetWidth;
    msg.style.transition = `opacity 300ms ${cssEasing(Easing.OutQuint)}, transform 900ms ${cssEasing(Easing.OutQuint)}`;
    msg.style.opacity = '1';
    msg.style.transform = 'scale(1)';
  }

  private clearScores(): void {
    let delay = 0;
    for (const d of [...this.scores.children] as HTMLElement[]) {
      if (d.dataset.expiring) continue;
      d.dataset.expiring = '1';
      d.style.transition = `transform 120ms ${cssEasing(Easing.Out)} ${delay}ms, opacity 120ms ${cssEasing(Easing.Out)} ${delay}ms`;
      d.style.transform = 'translateX(-10px)';
      d.style.opacity = '0';
      setTimeout(() => d.remove(), 120 + delay);
      delay += 20;
    }
  }

  private setScores(scores: ScoreRecord[]): void {
    let delay = 200;
    scores.forEach((s, i) => {
      const row = scoreRow(this.host, s, i + 1);
      row.style.top = `${(SCORE_HEIGHT + SPACING_BETWEEN_SCORES) * i}px`;
      row.style.opacity = '0';
      row.style.transform = 'translateX(-20px)';
      this.scores.appendChild(row);
      void row.offsetWidth;
      tween(row, { opacity: '1', transform: 'translateX(0)' }, 300, Easing.OutQuint, delay);
      delay += 30;
    });
    this.scores.style.height = `${(SCORE_HEIGHT + SPACING_BETWEEN_SCORES) * scores.length + SCORE_HEIGHT * 3}px`;
    requestAnimationFrame(() => this.updateFade());
  }

  /** UpdateAfterChildren fade handling: rows fade out towards the top and bottom edges of the scroll area. */
  private updateFade(): void {
    const height = SCORE_HEIGHT;
    const fadeBottom = this.scroll.scrollTop + this.scroll.clientHeight;
    let fadeTop = this.scroll.scrollTop;
    fadeTop += Math.min(height, Math.log10(Math.max(fadeTop, 0) + 1) * height);
    for (const c of [...this.scores.children] as HTMLElement[]) {
      if (c.dataset.expiring) continue;
      const topY = c.offsetTop;
      const bottomY = topY + height;
      const requireBottomFade = bottomY >= fadeBottom;
      const requireTopFade = topY < fadeTop;
      if (!requireBottomFade && !requireTopFade) {
        c.style.maskImage = '';
        continue;
      }
      const a1 = requireBottomFade ? Math.min(1 - (topY - fadeBottom) / height, 1) : Math.min(1 - (fadeTop - topY) / height, 1);
      const a2 = requireBottomFade ? Math.min(1 - (bottomY - fadeBottom) / height, 1) : Math.min(1 - (fadeTop - bottomY) / height, 1);
      c.style.maskImage = `linear-gradient(rgba(0,0,0,${Math.max(0, a1)}), rgba(0,0,0,${Math.max(0, a2)}))`;
    }
  }
}

function missCount(s: ScoreRecord): number {
  return s.statistics?.[HitResult[HitResult.Miss]] ?? 0;
}

/** ScoreInfoExtensions.OrderByCriteria */
function orderByCriteria(scores: ScoreRecord[], sort: LeaderboardSortMode): ScoreRecord[] {
  const byScore = (a: ScoreRecord, b: ScoreRecord) => b.totalScore - a.totalScore;
  const s = [...scores];
  switch (sort) {
    case 'accuracy':
      return s.sort((a, b) => b.accuracy - a.accuracy || byScore(a, b));
    case 'maxCombo':
      return s.sort((a, b) => b.maxCombo - a.maxCombo || byScore(a, b));
    case 'misses':
      return s.sort((a, b) => missCount(a) - missCount(b) || byScore(a, b));
    case 'date':
      return s.sort((a, b) => b.date - a.date);
    default:
      return s.sort(byScore);
  }
}

/** DateTimeExtensions.ToShortRelativeTime(TimeSpan.FromSeconds(30)) */
function shortRelativeTime(date: number): string {
  const s = (Date.now() - date) / 1000;
  if (s < 30) return 'now';
  if (s < 60) return `${Math.floor(s)}sec`;
  if (s < 3600) return `${Math.floor(s / 60)}min`;
  if (s < 86400) return `${Math.floor(s / 3600)}hr`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d`;
  if (s < 86400 * 365) return `${Math.floor(s / (86400 * 30))}mo`;
  return `${Math.floor(s / (86400 * 365))}y`;
}

/** BeatmapLeaderboardScore */
function scoreRow(host: SongSelectHost, s: ScoreRecord, rank: number): HTMLDivElement {
  const c = host.colours;
  const rankName = s.rank as ScoreRank;
  const rankColour = forRank(rankName);
  const bg = c.background3;
  const fg = c.background5;
  const scoreMods = new ModSet(s.mods, s.modSettings ?? {});
  // ScoreInfo.IsPerfect (approximated: no misses / combo breaks recorded)
  const perfectCombo = missCount(s) === 0 && (s.statistics?.[HitResult[HitResult.LargeTickMiss]] ?? 0) === 0 && (s.statistics?.[HitResult[HitResult.ComboBreak]] ?? 0) === 0;

  const label = (name: string, value: string, perfect: boolean, minWidth: number) =>
    h('div', { class: 'lbs-label', style: { minWidth: `${minWidth}px` } }, h('div', { class: 'lbs-label-name', style: { color: css(c.content2) } }, name), h('div', { class: 'lbs-label-value', style: { color: perfect ? css(OsuColour.Lime1) : '#fff' } }, value));

  const mods = h(
    'div',
    { class: 'lbs-mods' },
    scoreMods.list.map(m => {
      const def = MOD_BY_ACRONYM.get(m);
      return h('span', { class: 'lbs-mod', style: { background: css(def ? forModType(def.type) : WHITE) } }, m);
    }),
  );

  const row = h(
    'div',
    { class: `lb-score${s.hasReplay ? ' has-replay' : ''}`, title: s.hasReplay ? 'Click to watch the replay' : '' },
    h('div', { class: 'lbs-bg', style: { background: css(bg, 0.4) } }),
    h('div', { class: 'lbs-rank' }, h('span', { class: 'lbs-unshear', style: { color: css(c.content1) } }, `#${rank}`)),
    h(
      'div',
      { class: 'lbs-centre' },
      h('div', { class: 'lbs-fg', style: { background: css(fg, 0.4) } }),
      h('div', { class: 'lbs-avatar' }, h('span', { class: 'lbs-unshear' }, (s.player || '?').slice(0, 1).toUpperCase())),
      h('div', { class: 'lbs-info' }, h('div', { class: 'lbs-unshear lbs-date', style: { color: css(c.content2) } }, shortRelativeTime(s.date)), h('div', { class: 'lbs-unshear lbs-username' }, s.player)),
      h('div', { class: 'lbs-stats lbs-unshear' }, label('COMBO', `${s.maxCombo}x`, perfectCombo, 60), label('ACCURACY', `${(Math.floor(s.accuracy * 10000) / 100).toFixed(2)}%`, s.accuracy === 1, 55)),
    ),
    h(
      'div',
      { class: 'lbs-right' },
      h('div', { class: 'lbs-right-grad', style: { background: `linear-gradient(90deg, ${css(bg, 0)}, ${css(rankColour)})` } }),
      h('div', { class: 'lbs-grade', style: { background: css(rankColour) } }, h('span', { class: 'lbs-unshear lbs-grade-text', style: { color: css(rankLetterColour(rankName)) } }, rankLetter(rankName))),
      h(
        'div',
        { class: 'lbs-total' },
        h('div', { class: 'lbs-total-bg', style: { background: `linear-gradient(90deg, ${css(bg, 0)}, ${css(bg)}), linear-gradient(90deg, ${css(bg, 0)}, ${css(rankColour, 0.5)})` } }),
        h('div', { class: 'lbs-total-flow' }, h('div', { class: 'lbs-unshear lbs-score' }, Math.round(s.totalScore).toLocaleString('en-US').padStart(7, '0').replace(/^(\d)/, '$1')), h('div', { class: 'lbs-unshear' }, mods)),
      ),
    ),
  );

  row.addEventListener('mouseenter', () => row.classList.add('hover'));
  row.addEventListener('mouseleave', () => row.classList.remove('hover'));
  row.style.setProperty('--lbs-bg-hover', css(lighten(bg, 0.2), 0.4));
  row.addEventListener('click', () => {
    if (s.hasReplay) host.watchReplay(s);
  });
  row.addEventListener('contextmenu', e => {
    e.preventDefault();
    e.stopPropagation();
    const items: MenuItem[] = [];
    const ruleset = host.ruleset();
    const copyable = s.mods.filter(m => ruleset.availableMods.includes(m));
    if (copyable.length > 0) items.push({ text: 'Use these mods', type: 'highlighted', action: () => host.setMods(new ModSet(copyable, s.modSettings ?? {})) });
    if (s.hasReplay) items.push({ text: 'Watch replay', action: () => host.watchReplay(s) });
    items.push({ text: 'Delete', type: 'destructive', action: () => host.deleteScore(s) });
    showContextMenu(e.clientX, e.clientY, items);
  });
  return row;
}

// ---------------------------------------------------------------- NoResultsPlaceholder

export class NoResultsPlaceholder {
  readonly el: HTMLDivElement;
  private readonly text: HTMLDivElement;
  private visible = false;

  constructor(private readonly actions: { clearSearch(): void; resetStars(): void; enableConverts(): void; hasAnyBeatmaps(): boolean }) {
    this.text = h('div', { class: 'nrp-text' });
    this.el = h('div', { class: 'no-results' }, h('div', { class: 'nrp-flow' }, h('div', { class: 'nrp-icon' }, icon('ghost', 50)), h('div', { class: 'nrp-title' }, 'No matching beatmaps'), this.text));
    this.el.style.opacity = '0';
    this.el.style.pointerEvents = 'none';
  }

  show(filter: FilterCriteria): void {
    if (!this.visible) {
      this.visible = true;
      tween(this.el, { opacity: '1' }, 600, Easing.OutQuint);
      this.el.style.pointerEvents = '';
    }
    this.updateText(filter);
  }

  hide(): void {
    if (!this.visible) return;
    this.visible = false;
    tween(this.el, { opacity: '0' }, 200, Easing.OutQuint);
    this.el.style.pointerEvents = 'none';
  }

  get isVisible(): boolean {
    return this.visible;
  }

  private updateText(filter: FilterCriteria): void {
    const flow = this.el.querySelector('.nrp-flow') as HTMLElement;
    flow.style.transition = 'none';
    flow.style.transform = 'scale(0.9)';
    void flow.offsetWidth;
    tween(flow, { transform: 'scale(1)' }, 1000, Easing.OutQuint);
    this.text.style.opacity = '0';
    void this.text.offsetWidth;
    tween(this.text, { opacity: '1' }, 800, Easing.OutQuint);
    clear(this.text);
    const bullet = (...parts: (string | Node)[]) => this.text.appendChild(h('div', { class: 'nrp-bullet' }, h('span', { class: 'nrp-dot' }), h('span', null, ...parts)));
    const linkTo = (text: string, action: () => void) => h('a', { class: 'nrp-link', onclick: action }, text);

    if (!this.actions.hasAnyBeatmaps()) {
      bullet('Consider dropping some .osz files onto this window to import some beatmaps!');
      return;
    }
    this.text.appendChild(h('p', null, 'No beatmaps match your filter criteria!'));
    if (filter.searchText) bullet('Try ', linkTo('clearing', () => this.actions.clearSearch()), ' your current search criteria.');
    if (filter.userStarDifficulty.hasFilter) {
      const lower = (filter.userStarDifficulty.min ?? 0).toFixed(1);
      const upper = filter.userStarDifficulty.max == null ? '∞' : filter.userStarDifficulty.max.toFixed(1);
      bullet('Try ', linkTo('removing', () => this.actions.resetStars()), ` the ${lower} - ${upper} star difficulty filter.`);
    }
    if (filter.ruleset?.onlineId !== 0 && !filter.allowConvertedBeatmaps) bullet('Try ', linkTo('enabling', () => this.actions.enableConverts()), ' automatic conversion!');
  }
}
