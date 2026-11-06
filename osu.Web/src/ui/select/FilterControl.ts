// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game/Screens/Select/FilterControl.cs (+ .DifficultyRangeSlider, .ScopedBeatmapSetDisplay): search box with the match
// count, star difficulty range slider, "show converts" toggle, sort / group / collection dropdowns, and creation of FilterCriteria.

import { settings } from '../../framework/Settings';
import { Collections } from '../../game/Collections';
import type { ModSet } from '../../game/mods/Mods';
import type { Ruleset } from '../../game/rulesets/Ruleset';
import { h } from '../dom';
import { createRulesetFilterCriteria } from './BeatmapCarouselFilters';
import { css, foregroundTextColourFor, forStarDifficultyText, gray, lerpColour, lighten, OsuColour, OverlayColourProvider, sampleFromLinearGradient, STAR_DIFFICULTY_SPECTRUM } from './Colours';
import { ShearedDropdown, shearedButton, shearedToggle } from './Components';
import { FilterBeatmapSet, FilterCriteria, GROUP_MODE_NAMES, GroupMode, SORT_MODE_NAMES, SortMode } from './FilterCriteria';
import { applyQueries } from './FilterQueryParser';
import { icon } from './Icons';
import { ENTER_DURATION, wedgeBackground } from './Wedges';

/** FilterControl.HEIGHT_FROM_SCREEN_TOP */
export const HEIGHT_FROM_SCREEN_TOP = 141 - 10;

const STARS_MIN_DEFAULT = 0;
const STARS_MAX_DEFAULT = 10.1;

/** DifficultyRangeSlider spectrum: STAR_DIFFICULTY_SPECTRUM without the grey "unknown" stop, starting at 0. */
const SPECTRUM = [[0, STAR_DIFFICULTY_SPECTRUM[1][1]] as const, ...STAR_DIFFICULTY_SPECTRUM.slice(1)];

export interface FilterControlHost {
  readonly colours: OverlayColourProvider;
  ruleset(): Ruleset;
  mods(): ModSet;
  unscope(): void;
  /** ManageCollectionsDialog.Show */
  manageCollections(): void;
}

const MANAGE_COLLECTIONS = '__manage__';

export class FilterControl {
  private collectionId = 'all';
  readonly el: HTMLDivElement;
  readonly search: HTMLInputElement;
  private readonly status: HTMLDivElement;
  private readonly showConverts: HTMLButtonElement & { setActive(v: boolean): void };
  private readonly sortDropdown: ShearedDropdown<SortMode>;
  private readonly groupDropdown: ShearedDropdown<GroupMode>;
  private readonly slider: DifficultyRangeSlider;
  private readonly scopedDisplay: HTMLDivElement;
  private readonly scopedText: HTMLDivElement;
  scopedBeatmapSet: FilterBeatmapSet | null = null;
  onCriteriaChanged: ((c: FilterCriteria) => void) | null = null;
  currentCriteria: FilterCriteria | null = null;

  constructor(private readonly host: FilterControlHost) {
    const c = host.colours;

    this.search = h('input', { class: 'ssb-input', type: 'text', placeholder: 'type to search', spellcheck: false, autocomplete: 'off' });
    this.search.addEventListener('input', () => this.updateCriteria());
    this.status = h('div', { class: 'ssb-status' });
    this.status.style.color = css(c.content2);
    const searchBox = h('div', { class: 'sheared-search' }, h('div', { class: 'ssb-row' }, this.search, h('span', { class: 'ssb-icon' }, icon('search', 16))), this.status);

    this.slider = new DifficultyRangeSlider(c, () => this.debouncedUpdateCriteria());
    this.showConverts = shearedToggle('Show Converts', settings.get('select.showConverts', true), v => {
      settings.set('select.showConverts', v);
      this.updateCriteria();
    });
    this.showConverts.style.height = '30px';

    this.sortDropdown = new ShearedDropdown<SortMode>(
      'Sort',
      Object.values(SortMode)
        .filter((v): v is SortMode => typeof v === 'number')
        .map(v => ({ value: v, text: SORT_MODE_NAMES[v] })),
      settings.get('select.sortMode', SortMode.Title),
      v => {
        settings.set('select.sortMode', v);
        this.updateCriteria();
      },
    );
    this.groupDropdown = new ShearedDropdown<GroupMode>('Group', [], settings.get('select.groupMode', GroupMode.None), v => {
      settings.set('select.groupMode', v);
      this.updateCriteria();
    });
    this.updateGroupItems();
    // CollectionDropdown: "All beatmaps", every collection (by name) and "Manage collections...".
    const collection = new ShearedDropdown<string>('Collection', [], 'all', v => {
      if (v === MANAGE_COLLECTIONS) {
        collection.value = this.collectionId;
        host.manageCollections();
        return;
      }
      this.collectionId = v;
      this.updateCriteria();
    });
    collection.el.classList.add('collection');
    const refreshCollections = () => {
      const all = Collections.all();
      if (this.collectionId !== 'all' && !all.some(c => c.id === this.collectionId)) this.collectionId = 'all';
      collection.setItems([{ value: 'all', text: 'All beatmaps' }, ...all.map(c => ({ value: c.id, text: c.name })), { value: MANAGE_COLLECTIONS, text: 'Manage collections...' }]);
      collection.value = this.collectionId;
    };
    refreshCollections();
    settings.subscribe(k => {
      if (k !== 'collections') return;
      refreshCollections();
      if (this.collectionId !== 'all') this.updateCriteria();
    });

    this.scopedText = h('div', { class: 'scoped-text', style: { color: css(c.background6) } });
    this.scopedDisplay = h(
      'div',
      { class: 'scoped-display', onclick: () => host.unscope() },
      h('div', { class: 'scoped-bg', style: { background: css(c.highlight1) } }),
      h('div', { class: 'scoped-content' }, this.scopedText, shearedButton('Back', () => host.unscope(), { width: 80, cls: 'scoped-back' })),
    );

    this.el = h(
      'div',
      { class: 'filter-control' },
      h('div', { class: 'fc-bg' }, wedgeBackground(c, { mirrored: true })),
      h(
        'div',
        { class: 'fc-content' },
        searchBox,
        h('div', { class: 'fc-row fc-slider-row' }, this.slider.el, this.showConverts),
        h('div', { class: 'fc-row fc-dropdowns' }, this.sortDropdown.el, this.groupDropdown.el, collection.el),
        this.scopedDisplay,
      ),
    );
  }

  get allowConverts(): boolean {
    return this.showConverts.classList.contains('active');
  }

  setAllowConverts(v: boolean): void {
    this.showConverts.setActive(v);
    settings.set('select.showConverts', v);
    this.updateCriteria();
  }

  resetStars(): void {
    this.slider.reset();
    this.updateCriteria();
  }

  set statusText(text: string) {
    this.status.textContent = text;
  }

  /** GroupModeDropdown.updateAvailableItems: Variant only exists for rulesets with more than one gameplay variant (mania key counts). */
  updateGroupItems(): void {
    const items = Object.values(GroupMode)
      .filter((v): v is GroupMode => typeof v === 'number')
      .filter(v => v !== GroupMode.Variant || this.host.ruleset().id === 3)
      .map(v => ({ value: v, text: v === GroupMode.Variant ? 'Key Count' : GROUP_MODE_NAMES[v] }));
    this.groupDropdown.setItems(items);
    const configured = settings.get('select.groupMode', GroupMode.None);
    this.groupDropdown.value = items.some(i => i.value === configured) ? configured : GroupMode.None;
  }

  /** FilterControl.CreateCriteria */
  createCriteria(): FilterCriteria {
    const query = this.search.value;
    const r = this.host.ruleset();
    const criteria = new FilterCriteria();
    criteria.selectedBeatmapSet = this.scopedBeatmapSet;
    criteria.sort = this.sortDropdown.value;
    criteria.group = this.groupDropdown.value;
    criteria.allowConvertedBeatmaps = this.allowConverts;
    criteria.ruleset = { shortName: r.shortName, onlineId: r.id };
    criteria.mods = this.host.mods().forRuleset(r.shortName, r.availableMods).list;
    if (this.collectionId !== 'all') criteria.collectionBeatmapMD5Hashes = new Set(Collections.get(this.collectionId)?.hashes ?? []);

    if (this.slider.lower !== STARS_MIN_DEFAULT) criteria.userStarDifficulty.min = this.slider.lower;
    if (this.slider.upper !== STARS_MAX_DEFAULT) criteria.userStarDifficulty.max = this.slider.upper;

    criteria.rulesetCriteria = createRulesetFilterCriteria(r.shortName);
    applyQueries(criteria, query);
    return criteria;
  }

  private sliderTimer = 0;
  private debouncedUpdateCriteria(): void {
    clearTimeout(this.sliderTimer);
    this.sliderTimer = window.setTimeout(() => this.updateCriteria(), 50);
  }

  updateCriteria(clearScopedSet = true): void {
    if (clearScopedSet && this.scopedBeatmapSet != null) {
      this.host.unscope();
      return;
    }
    this.currentCriteria = this.createCriteria();
    this.onCriteriaChanged?.(this.currentCriteria);
  }

  /** Mods changed: only re-filter if the ruleset's criteria say so (mania key mods). */
  modsChanged(oldMods: readonly string[], newMods: readonly string[]): void {
    if (!this.currentCriteria) return;
    if (this.currentCriteria.rulesetCriteria?.filterMayChangeFromMods(this.currentCriteria, oldMods, newMods)) this.updateCriteria();
  }

  setScopedBeatmapSet(set: FilterBeatmapSet | null, displayTitle: string): void {
    this.scopedBeatmapSet = set;
    if (set) {
      this.scopedText.textContent = '';
      this.scopedText.append('Temporarily showing all beatmaps in ', h('b', null, displayTitle));
      this.scopedDisplay.classList.add('visible');
    } else this.scopedDisplay.classList.remove('visible');
    this.updateCriteria(false);
  }

  search_(query: string): void {
    this.search.value = query;
    this.updateCriteria();
  }

  /** FilterControl.AddToSearch */
  addToSearch(query: string): void {
    const existing = this.search.value;
    if (existing.includes(query)) return;
    this.search.value = existing.trim() === '' ? query : `${existing.trim()} ${query}`;
    this.updateCriteria();
  }

  setVisible(v: boolean): void {
    this.el.style.transition = `transform ${ENTER_DURATION}ms var(--ss-outquint), opacity ${ENTER_DURATION / 3}ms var(--ss-in)`;
    this.el.style.transform = `translateX(${v ? 0 : 150}px)`;
    this.el.style.opacity = v ? '1' : '0';
  }
}

/** FilterControl.DifficultyRangeSlider (ShearedRangeSlider) */
class DifficultyRangeSlider {
  readonly el: HTMLDivElement;
  lower: number;
  upper: number;
  private readonly lowerNub: HTMLDivElement;
  private readonly upperNub: HTMLDivElement;
  private readonly border: HTMLDivElement;
  private readonly track: HTMLDivElement;
  private readonly lowerLeft: HTMLDivElement;
  private readonly upperRight: HTMLDivElement;

  constructor(
    colours: OverlayColourProvider,
    private readonly onChange: () => void,
  ) {
    this.lower = settings.get('select.starsMin', STARS_MIN_DEFAULT);
    this.upper = settings.get('select.starsMax', STARS_MAX_DEFAULT);
    const stops = SPECTRUM.map(([pos, col]) => `${css(col)} ${(pos / 10) * 100}%`).join(', ');
    this.track = h('div', { class: 'drs-track' }, h('div', { class: 'drs-spectrum', style: { background: `linear-gradient(90deg, ${stops})` } }));
    this.lowerLeft = h('div', { class: 'drs-dim', style: { background: css(gray(0.05), 0.7) } });
    this.upperRight = h('div', { class: 'drs-dim right', style: { background: css(gray(0.05), 0.7) } });
    this.border = h('div', { class: 'drs-border', style: { borderColor: css(colours.highlight1) } });
    this.lowerNub = h('div', { class: 'drs-nub' }, h('span'));
    this.upperNub = h('div', { class: 'drs-nub' }, h('span'));
    this.track.append(this.lowerLeft, this.upperRight, this.border, this.lowerNub, this.upperNub);
    this.el = h('div', { class: 'difficulty-range' }, h('div', { class: 'drs-label' }, 'Stars'), this.track);
    this.setupDrag(this.lowerNub, false);
    this.setupDrag(this.upperNub, true);
    requestAnimationFrame(() => this.updateDisplay(true));
  }

  reset(): void {
    this.lower = STARS_MIN_DEFAULT;
    this.upper = STARS_MAX_DEFAULT;
    settings.set('select.starsMin', this.lower);
    settings.set('select.starsMax', this.upper);
    this.updateDisplay(false);
  }

  private setupDrag(nub: HTMLDivElement, isUpper: boolean): void {
    const apply = (clientX: number) => {
      const r = this.track.getBoundingClientRect();
      const t = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
      let v = Math.round((t * 10.1) / 0.1) * 0.1;
      v = Math.round(v * 10) / 10;
      // MinRange = 0.1
      if (isUpper) this.upper = Math.max(v, Math.round((this.lower + 0.1) * 10) / 10);
      else this.lower = Math.min(Math.min(v, 10), Math.round((this.upper - 0.1) * 10) / 10);
      settings.set('select.starsMin', this.lower);
      settings.set('select.starsMax', this.upper);
      this.updateDisplay(false);
      this.onChange();
    };
    nub.addEventListener('pointerdown', e => {
      e.stopPropagation();
      nub.setPointerCapture(e.pointerId);
      nub.classList.add('dragging');
      const move = (ev: PointerEvent) => apply(ev.clientX);
      const up = () => {
        nub.classList.remove('dragging');
        nub.removeEventListener('pointermove', move);
        nub.removeEventListener('pointerup', up);
      };
      nub.addEventListener('pointermove', move);
      nub.addEventListener('pointerup', up);
    });
    this.track.addEventListener('pointerdown', e => {
      if (e.target !== this.track && !(e.target as HTMLElement).classList.contains('drs-spectrum') && !(e.target as HTMLElement).classList.contains('drs-dim')) return;
      const r = this.track.getBoundingClientRect();
      const t = (e.clientX - r.left) / r.width;
      const closerToUpper = Math.abs(t * 10.1 - this.upper) < Math.abs(t * 10.1 - this.lower);
      if (closerToUpper === isUpper) apply(e.clientX);
    });
  }

  /** DifficultyBoundSliderBar.UpdateDisplay + updateBorderDisplay */
  private updateDisplay(instant: boolean): void {
    const pct = (v: number) => (v / 10.1) * 100;
    const nubStyle = (nub: HTMLDivElement, value: number, isUpper: boolean) => {
      let col = sampleFromLinearGradient(SPECTRUM, Math.round(value * 100) / 100);
      if (value >= 7.5 && value < 8.0) col = lerpColour(col, OsuColour.Gray4, (value - 7.5) / 0.5);
      else if (value >= 8.0) col = OsuColour.Gray4;
      nub.style.left = `${pct(value)}%`;
      nub.style.background = css(col);
      nub.style.boxShadow = `0 0 0 0 ${css(lighten(col, 0.1))}`;
      const text = nub.firstChild as HTMLElement;
      const isDefaultUpper = isUpper && value === STARS_MAX_DEFAULT;
      text.textContent = isDefaultUpper ? '∞' : (Math.round(value * 100) / 100).toFixed(1);
      text.style.color = css(isDefaultUpper ? foregroundTextColourFor(col) : forStarDifficultyText(value));
      nub.title = isDefaultUpper ? 'No limit' : `${Math.round(value * 100) / 100} stars`;
    };
    nubStyle(this.lowerNub, this.lower, false);
    nubStyle(this.upperNub, this.upper, true);
    this.lowerLeft.style.width = `${pct(this.lower)}%`;
    this.upperRight.style.left = `${pct(this.upper)}%`;
    const t = instant ? 'none' : 'left 250ms var(--ss-outquint), width 250ms var(--ss-outquint)';
    this.border.style.transition = t;
    this.border.style.left = `${pct(this.lower)}%`;
    this.border.style.width = `calc(${pct(this.upper) - pct(this.lower)}% + var(--nub-width))`;
  }
}
