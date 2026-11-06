// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game/Screens/Select/SongSelect.cs + SoloSongSelect.cs (+ ModSpeedHotkeyHandler.cs, LeftSideInteractionContainer.cs):
// the layout (title wedge + details area on the left, filter control + carousel on the right, footer at the bottom), the 150ms
// selection debounce, global-beatmap validation, filtering hookup, background reveal on mouse hold, keyboard handling, scoping to a
// beatmap set, and starting gameplay (Ctrl+Enter adds Autoplay). Components live in ../select/.

import '../select/select.css';
import { settings } from '../../framework/Settings';
import { collectionKey, Collections, HiddenBeatmaps } from '../../game/Collections';
import { RULESET_DISPLAY_NAMES } from '../../brand';
import { ModSet } from '../../game/mods/Mods';
import { availableRulesets } from '../../game/rulesets';
import type { ScoreRank } from '../../game/scoring/ScoreRank';
import { Database, type BeatmapSetRecord, type ScoreRecord } from '../../game/storage/Database';
import { findFile } from '../../game/storage/Importer';
import { h } from '../dom';
import type { Game } from '../Game';
import { openModSelect } from '../overlays/ModSelect';
import { openSettings } from '../overlays/Settings';
import { openChartGenerator } from '../overlays/ChartGenerator';
import { openManageCollections } from '../overlays/ManageCollections';
import { Screen } from '../Screen';
import { confirmDialog } from '../confirm';
import { PlayerScreen } from './Player';
import { cssEasing, Easing } from '../select/Anim';
import { BeatmapCarousel } from '../select/BeatmapCarousel';
import { allowGameplayWithRuleset, CarouselItem, GroupDefinition, GroupedBeatmap, GroupedBeatmapSet, ManiaFilterCriteria } from '../select/BeatmapCarouselFilters';
import { CarouselModelBuilder, setLastPlayed, getLastPlayed } from '../select/CarouselModel';
import { OverlayColourProvider, OverlayColourScheme, OsuColour } from '../select/Colours';
import { closeContextMenu, MenuItem, showContextMenu } from '../select/Components';
import { FilterControl, HEIGHT_FROM_SCREEN_TOP } from '../select/FilterControl';
import type { FilterBeatmap, FilterCriteria } from '../select/FilterCriteria';
import { FooterButtonMods, FooterButtonOptions, FooterButtonRandom, OptionsEntry, ScreenFooter, FOOTER_HEIGHT } from '../select/Footer';
import { rulesetIcon } from '../select/Icons';
import { BeatmapDetailsArea, BeatmapTitleWedge, CORNER_RADIUS_HIDE_OFFSET, NoResultsPlaceholder, SongSelectHost } from '../select/Wedges';

/** SongSelect.SELECTION_DEBOUNCE */
const SELECTION_DEBOUNCE = 150;
/** SongSelect.filter_delay */
const FILTER_DELAY = 250;
/** SongSelect.REVEAL_BACKGROUND_DELAY */
const REVEAL_BACKGROUND_DELAY = 200;
/** In place of lazer's toolbar (which offsets every screen by its height). */
const TOOLBAR_HEIGHT = 40;

const bgUrls = new Map<string, string>();

export class SongSelectScreen extends Screen {
  private readonly colours = new OverlayColourProvider(OverlayColourScheme.Blue);
  private readonly scaleRoot: HTMLDivElement;
  private readonly mainContent: HTMLDivElement;
  private readonly leftColumn: HTMLDivElement;
  private readonly rightColumn: HTMLDivElement;
  private readonly rightGradient: HTMLDivElement;
  private readonly carouselContainer: HTMLDivElement;
  private readonly toolbar: HTMLDivElement;
  private readonly rulesetTabs: HTMLDivElement;

  private readonly model = new CarouselModelBuilder();
  private readonly carousel: BeatmapCarousel;
  private readonly filterControl: FilterControl;
  private readonly titleWedge: BeatmapTitleWedge;
  private readonly detailsArea: BeatmapDetailsArea;
  private readonly noResults: NoResultsPlaceholder;
  private readonly footer: ScreenFooter;
  private readonly modsButton: FooterButtonMods;
  private readonly randomButton: FooterButtonRandom;
  private readonly optionsButton: FooterButtonOptions;

  private unsubscribe: (() => void)[] = [];
  private raf = 0;
  private lastFrame = 0;
  private current = false;
  private drawSize = { w: 1024, h: 768, scale: 1 };

  // selection debounce
  private debounceQueuedSelection: FilterBeatmap | null = null;
  private debounceElapsed = 0;
  private keysHeld = new Set<string>();

  // filtering
  private filterDebounce = 0;
  private filterDebouncePending = false;
  private firstFilter = true;
  private carouselItemsPresented = false;

  // global state tracking
  private lastWorkingKey = '';
  private lastRulesetId = -1;
  private lastModsKey = '';
  private lastModsList: string[] = [];
  private modsAtGameplayStart: ModSet | null = null;
  private ctrlForStart = false;

  // scoping
  private beforeScopedSelection: GroupedBeatmap | null = null;

  // beat sync
  private beatIndex = 0;
  private lastPhase = 0;

  // background reveal
  private revealTimer = 0;
  private revealed = false;

  // ModSpeedHotkeyHandler
  private lastActiveRateAdjustMod: { acronym: string; settings: Record<string, number | boolean | null> } | null = null;

  private readonly localRanks = new Map<string, ScoreRank | null>();
  private readonly localRankWaiters = new Map<string, ((r: ScoreRank | null) => void)[]>();

  /** ScrollAdjustsVolume */
  get scrollAdjustsVolume(): boolean {
    return true;
  }

  constructor(game: Game) {
    super(game, 'song-select');
    this.backgroundDim = 0.1;
    this.showTriangles = false;

    const host = this.createHost();

    this.carousel = new BeatmapCarousel(
      {
        colours: this.colours,
        ruleset: () => this.game.ruleset,
        mods: () => this.game.mods,
        showConverts: () => this.filterControl.allowConverts,
        sourceOf: b => this.model.sources.get(b)!,
        recordOf: s => this.model.recordFor(s.id),
        backgroundUrl: r => backgroundUrl(r),
        activate: item => {
          this.ctrlForStart = false;
          this.carousel.activate(item);
        },
        contextMenu: (item, e) => this.showPanelContextMenu(item, e),
        scopeToSet: set => this.scopeToBeatmapSet(set),
        canScope: () => this.filterControl.scopedBeatmapSet == null,
        localRank: (b, cb) => this.getLocalRank(b.id, cb),
        visibleBeatmaps: s => this.carousel.visibleBeatmapsOf(s),
        preferUnicode: () => settings.get('ui.preferUnicode', false),
      },
      {
        requestPresentBeatmap: gb => this.selectAndRun(gb.beatmap),
        requestSelection: gb => this.queueBeatmapSelection(gb),
        requestRecommendedSelection: list => this.requestRecommendedSelection(list),
        newItemsPresented: () => this.newItemsPresented(),
        playSample: name => this.game.playUiSample(name === 'random' ? 'menu-confirm' : 'menu-click', name === 'traverse' ? 0.25 : 0.4),
        groupingContext: () => ({
          getLocalUserTopRanks: () => this.topRankMapping(),
          getCollections: () => Collections.all(),
          getVariant: (b, criteria) => (this.game.ruleset.id === 3 ? { variant: ManiaFilterCriteria.keyCountFor(b, criteria.mods), name: `${ManiaFilterCriteria.keyCountFor(b, criteria.mods)}K` } : null),
        }),
      },
    );

    this.filterControl = new FilterControl({
      colours: this.colours,
      ruleset: () => this.game.ruleset,
      mods: () => this.game.mods,
      unscope: () => this.unscopeBeatmapSet(true),
      manageCollections: () => openManageCollections(this.game),
    });
    this.filterControl.onCriteriaChanged = c => this.criteriaChanged(c);
    this.filterControl.search.addEventListener('keydown', e => this.onSearchKeyDown(e));

    this.titleWedge = new BeatmapTitleWedge(host);
    this.detailsArea = new BeatmapDetailsArea(host, settings);
    this.noResults = new NoResultsPlaceholder({
      clearSearch: () => this.filterControl.search_(''),
      resetStars: () => this.filterControl.resetStars(),
      enableConverts: () => this.filterControl.setAllowConverts(true),
      hasAnyBeatmaps: () => this.game.library.sets.length > 0,
    });

    // ---------------------------------------------------------------- footer
    this.footer = new ScreenFooter(
      () => this.game.back(),
      () => {
        this.ensureGlobalBeatmapValid();
        const b = this.workingFilterBeatmap();
        if (b) this.selectAndRun(b);
      },
    );
    const fc = () => this.footer.colours;
    this.modsButton = new FooterButtonMods(fc);
    this.modsButton.action = () => this.toggleModSelect();
    this.modsButton.requestDeselectAllMods = () => this.game.setMods(this.game.mods.forRuleset(this.game.ruleset.shortName, []));
    this.randomButton = new FooterButtonRandom(fc);
    this.randomButton.nextRandom = () => {
      if (!this.carousel.nextRandom()) this.game.playUiSample('fail', 0.4);
    };
    this.randomButton.previousRandom = () => {
      if (!this.carousel.previousRandom()) this.game.playUiSample('fail', 0.4);
    };
    this.optionsButton = new FooterButtonOptions(fc);
    this.optionsButton.getEntries = () => this.optionsEntries();
    this.footer.setButtons([this.modsButton, this.randomButton, this.optionsButton]);
    settings.subscribe(k => {
      if (k === 'select.backgroundBlur') this.updateBackgroundBlur();
      if (k === 'graphics.uiScale') this.onResize();
      // Collections / hidden difficulties change carousel contents and grouping.
      if (k === 'collections' || k === 'beatmaps.hidden') this.libraryChanged();
    });

    // ---------------------------------------------------------------- layout
    this.rulesetTabs = h('div', { class: 'ss-ruleset-selector' });
    this.toolbar = h(
      'div',
      { class: 'ss-toolbar' },
      h('button', { class: 'ss-toolbar-button', title: 'Settings (Ctrl+O)', onclick: () => openSettings(this.game) }, '⚙'),
      h('button', { class: 'ss-toolbar-button', onclick: () => this.game.openFilePicker() }, 'Import .osz'),
      h('button', { class: 'ss-toolbar-button', title: 'Import a folder (for example an osu!stable Songs folder)', onclick: () => this.game.openFolderPicker() }, 'Import folder'),
      h('button', { class: 'ss-toolbar-button ss-toolbar-generate', title: 'Generate a beatmap for any mode from a song (Ctrl+G)', onclick: () => this.openGenerator() }, '✦ Generate chart'),
      h('div', { class: 'ss-toolbar-spacer' }),
      this.rulesetTabs,
    );

    const wedges = h('div', { class: 'ss-wedges' }, this.titleWedge.el, h('div', { class: 'ss-wedge-gap' }), this.detailsArea.el);
    this.leftColumn = h('div', { class: 'ss-left', style: { top: `${-CORNER_RADIUS_HIDE_OFFSET}px`, left: `${-CORNER_RADIUS_HIDE_OFFSET}px` } }, wedges);
    // LeftSideInteractionContainer: hovering / clicking the left side scrolls the carousel back to the selection.
    this.leftColumn.addEventListener('mousedown', e => {
      if ((e.target as HTMLElement).closest('input, button, .sheared-dropdown, .lb-score, .md-link, .md-tag, .tw-link')) return;
      this.carousel.userScrolling = false;
      this.carousel.scrollToSelection();
    });

    this.rightGradient = h('div', { class: 'ss-right-gradient' });
    this.carouselContainer = h('div', { class: 'ss-carousel-container', style: { top: `${HEIGHT_FROM_SCREEN_TOP + 5}px`, bottom: '5px' } }, this.carousel.el, this.noResults.el);
    this.rightColumn = h('div', { class: 'ss-right' }, this.rightGradient, this.carouselContainer, this.filterControl.el);

    this.mainContent = h('div', { class: 'ss-main' }, h('div', { class: 'ss-left-gradient' }), this.leftColumn, this.rightColumn);
    this.scaleRoot = h('div', { class: 'ss-scale' }, h('div', { class: 'ss-screen-area', style: { top: `${TOOLBAR_HEIGHT}px` } }, this.mainContent, this.footer.el), this.toolbar);
    this.colours.apply(this.scaleRoot);
    this.scaleRoot.style.setProperty('--ss-outquint', cssEasing(Easing.OutQuint));
    this.scaleRoot.style.setProperty('--ss-in', cssEasing(Easing.In));
    this.el.appendChild(this.scaleRoot);

    this.el.addEventListener('pointerdown', e => this.onPointerDown(e));
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('resize', this.onResize);
  }

  private createHost(): SongSelectHost {
    return {
      colours: this.colours,
      working: () => this.game.working,
      ruleset: () => this.game.ruleset,
      mods: () => this.game.mods,
      setMods: m => this.game.setMods(m),
      preferUnicode: () => settings.get('ui.preferUnicode', false),
      addToSearch: t => this.filterControl.addToSearch(t),
      watchReplay: s => void this.watchReplay(s),
      deleteScore: s => void this.deleteScore(s),
      playSample: (n, v) => this.game.playUiSample(n, v ?? 0.5),
      overlayHost: () => this.scaleRoot,
    };
  }

  // ------------------------------------------------------------------ lifecycle

  onEnter(): void {
    this.current = true;
    this.unsubscribe.push(this.game.library.subscribe(() => this.libraryChanged()));
    this.unsubscribe.push(this.game.subscribe(() => this.globalStateChanged()));
    void this.game.library.load().then(() => this.libraryChanged());
    this.lastRulesetId = this.game.ruleset.id;
    this.lastModsKey = this.game.mods.toString();
    this.lastModsList = this.game.mods.list;
    this.renderRulesetTabs();
    this.libraryChanged();
    this.filterControl.updateCriteria();
    this.onResize();
    this.arrive();
    this.updateFooterMods();
    const w = this.game.working;
    this.lastWorkingKey = w ? `${w.set.id}|${w.entry.hash}` : '';
    this.updateVariousState();
    this.lastFrame = performance.now();
    this.raf = requestAnimationFrame(this.frame);
    if (!matchMedia('(pointer: coarse)').matches) setTimeout(() => this.filterControl.search.focus({ preventScroll: true }), 50);
  }

  /** SongSelect.updateBackgroundBlur: BlurAmount = SongSelectBackgroundBlur && !backgroundRevealActive ? 20 : 0 */
  get backgroundBlur(): number {
    return settings.get('select.backgroundBlur', false) && !this.revealed ? 20 * (window.innerHeight / 768) : 0;
  }

  private updateBackgroundBlur(): void {
    if (this.current) this.game.setBackgroundDim(this.backgroundDim, this.backgroundBlur);
  }

  onResume(): void {
    this.current = true;
    this.game.setBackgroundDim(this.backgroundDim, this.backgroundBlur);
    // SoloSongSelect.revertMods
    if (this.modsAtGameplayStart) {
      this.game.setMods(this.modsAtGameplayStart);
      this.modsAtGameplayStart = null;
    }
    this.localRanks.clear();
    this.arrive();
    this.libraryChanged();
    this.ensureGlobalBeatmapValid();
    this.detailsArea.refresh();
    this.titleWedge.update();
    this.lastFrame = performance.now();
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(this.frame);
    if (!this.game.previewTrack) void this.game.startPreview();
  }

  onSuspend(): void {
    this.current = false;
    this.carousel.visuallyFocusSelected = true;
    this.leave();
    cancelAnimationFrame(this.raf);
  }

  onExit(): void {
    this.current = false;
    this.leave();
    this.unsubscribe.forEach(u => u());
    this.unsubscribe = [];
    cancelAnimationFrame(this.raf);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('resize', this.onResize);
    this.carousel.dispose();
    closeContextMenu();
  }

  onBack(): boolean {
    if (closeContextMenu()) return false;
    if (this.optionsButton.isOpen) {
      this.optionsButton.hidePopover();
      return false;
    }
    if (this.filterControl.scopedBeatmapSet) {
      this.unscopeBeatmapSet(true);
      return false;
    }
    return true;
  }

  private arrive(): void {
    this.carousel.visuallyFocusSelected = false;
    this.updateWedgeVisibility();
    this.footer.setVisible(true);
  }

  private leave(): void {
    this.restoreBackground();
    this.optionsButton.hidePopover();
    this.updateWedgeVisibility();
  }

  private readonly onResize = (): void => {
    const W = window.innerWidth;
    const H = window.innerHeight;
    // ScalingContainer: DrawSizePreservingFillContainer with a 1024x768 target and the Minimum strategy.
    let scale = Math.min(W / 1024, H / 768);
    const portrait = W < H;
    if (portrait) scale = Math.min(1, W / 560);
    // ScalingDrawSizePreservingFillContainer: × OsuSetting.UIScale.
    scale *= settings.get('graphics.uiScale', 1);
    this.drawSize = { w: W / scale, h: H / scale, scale };
    this.scaleRoot.style.width = `${this.drawSize.w}px`;
    this.scaleRoot.style.height = `${this.drawSize.h}px`;
    this.scaleRoot.style.transform = `scale(${scale})`;
    this.scaleRoot.style.setProperty('--ui-scale', String(scale));
    document.documentElement.style.setProperty('--ss-ui-scale', String(scale));
    this.el.classList.toggle('portrait', portrait);
    this.layout();
  };

  /** SongSelect.Update: grid column dimensions. */
  private layout(): void {
    const DW = this.drawSize.w;
    const DH = this.drawSize.h - TOOLBAR_HEIGHT;
    const portrait = this.el.classList.contains('portrait');
    const widescreenBonusWidth = Math.max(0, DW / DH - 2);
    const left = portrait ? 0 : Math.min(DW * 0.5, 700 + widescreenBonusWidth * 100);
    const right = portrait ? DW : Math.max(500, Math.min(DW * 0.5, 700 + widescreenBonusWidth * 300));
    this.leftColumn.style.width = `${left + CORNER_RADIUS_HIDE_OFFSET}px`;
    this.leftColumn.style.display = portrait ? 'none' : '';
    this.rightColumn.style.width = `${right}px`;
    this.carousel.bleedTop = HEIGHT_FROM_SCREEN_TOP + 5;
    this.carousel.bleedBottom = FOOTER_HEIGHT + 5;
    this.titleWedge.layout();
  }

  // ------------------------------------------------------------------ frame loop

  private readonly frame = (now: number): void => {
    const elapsed = Math.min(100, now - this.lastFrame);
    this.lastFrame = now;
    if (this.current) {
      this.updateDebounce(elapsed);
      this.updateBeat();
    }
    const carouselHeight = this.carouselContainer.offsetHeight;
    this.carousel.update(carouselHeight, elapsed);
    this.raf = requestAnimationFrame(this.frame);
  };

  private updateBeat(): void {
    const beat = this.game.beatPhase();
    if (!beat) return;
    // BeatSyncedContainer.EarlyActivationMilliseconds = 40
    const phase = (beat.phase + 40 / beat.beatLength) % 1;
    if (phase < this.lastPhase) {
      this.beatIndex++;
      this.carousel.onBeat(this.beatIndex, beat.beatLength, 4);
    }
    this.lastPhase = phase;
  }

  // ------------------------------------------------------------------ library / global state

  private libraryChanged(): void {
    this.carousel.setBeatmaps(this.model.build(this.game.library.sets));
  }

  private workingFilterBeatmap(): FilterBeatmap | null {
    const w = this.game.working;
    if (!w) return null;
    return this.model.findBeatmap(w.set.id, w.entry.hash) ?? null;
  }

  private globalStateChanged(): void {
    const w = this.game.working;
    const workingKey = w ? `${w.set.id}|${w.entry.hash}` : '';
    const rulesetChanged = this.game.ruleset.id !== this.lastRulesetId;
    const modsKey = this.game.mods.toString();
    const modsChanged = modsKey !== this.lastModsKey;

    if (rulesetChanged) {
      this.lastRulesetId = this.game.ruleset.id;
      this.renderRulesetTabs();
      this.filterControl.updateGroupItems();
      this.filterControl.updateCriteria();
      this.carousel.refreshStarRatings();
      this.localRanks.clear();
      this.detailsArea.refresh();
      this.titleWedge.update();
    }
    if (modsChanged) {
      const oldList = this.lastModsList;
      this.lastModsKey = modsKey;
      this.lastModsList = this.game.mods.list;
      this.storeLastActiveRateAdjustMod();
      this.carousel.refreshStarRatings();
      this.titleWedge.updateMods();
      this.detailsArea.modsChanged();
      this.filterControl.modsChanged(oldList, this.lastModsList);
      this.updateFooterMods();
    }
    if (workingKey !== this.lastWorkingKey) {
      this.lastWorkingKey = workingKey;
      this.updateVariousState();
    }
  }

  /** SongSelect.updateVariousState (Beatmap.ValueChanged) */
  private updateVariousState(): void {
    if (!this.current) return;
    this.ensureGlobalBeatmapValid();
    this.updateWedgeVisibility();
    this.titleWedge.update();
    this.detailsArea.refresh();
    this.optionsButton.hidePopover();
    this.optionsButton.enabled = this.game.working != null;
    this.optionsButton.updateDisplay();
    this.updateFooterMods();
  }

  private updateFooterMods(): void {
    const r = this.game.ruleset;
    const mods = this.game.mods.forRuleset(r.shortName, r.availableMods);
    let multiplier = 1;
    try {
      multiplier = r.scoreMultiplier(mods);
    } catch {
      /* ignore */
    }
    this.modsButton.setMods(mods, multiplier);
  }

  private renderRulesetTabs(): void {
    this.rulesetTabs.textContent = '';
    for (const r of availableRulesets()) {
      const active = r === this.game.ruleset;
      const b = h('button', { class: `ss-ruleset${active ? ' active' : ''}`, title: RULESET_DISPLAY_NAMES[r.id] ?? r.name, onclick: () => this.game.setRuleset(r) }, rulesetIcon(r.id, 20), h('span', null, RULESET_DISPLAY_NAMES[r.id] ?? r.name));
      this.rulesetTabs.appendChild(b);
    }
  }

  // ------------------------------------------------------------------ selection handling

  private checkBeatmapValidForSelection(b: FilterBeatmap | null): boolean {
    if (!b) return false;
    const r = this.game.ruleset;
    if (!allowGameplayWithRuleset(b.ruleset, { shortName: r.shortName, onlineId: r.id }, this.filterControl.allowConverts)) return false;
    if (b.hidden) return false;
    return this.model.recordFor(b.set.id) != null;
  }

  private debounceQueueSelection(b: FilterBeatmap): void {
    this.debounceQueuedSelection = b;
    this.debounceElapsed = 0;
  }

  private updateDebounce(elapsed: number): void {
    if (!this.debounceQueuedSelection) return;
    // When a key is being held, assume the user is traversing the carousel using key repeat.
    const interval = this.keysHeld.size > 0 ? SELECTION_DEBOUNCE * 2 : SELECTION_DEBOUNCE;
    this.debounceElapsed += elapsed;
    if (this.debounceElapsed >= interval) this.performDebounceSelection();
  }

  private performDebounceSelection(): void {
    const b = this.debounceQueuedSelection;
    if (!b) return;
    this.debounceQueuedSelection = null;
    this.debounceElapsed = 0;
    const w = this.game.working;
    if (w && w.set.id === b.set.id && w.entry.hash === b.id) return;
    if (!this.checkBeatmapValidForSelection(b)) return;
    const src = this.model.sources.get(b);
    if (src) this.game.select(src.set, src.entry);
  }

  private cancelDebounceSelection(): void {
    this.debounceQueuedSelection = null;
    this.debounceElapsed = 0;
  }

  /** queueBeatmapSelection */
  private queueBeatmapSelection(gb: GroupedBeatmap): void {
    if (!this.current) return;
    this.carousel.currentGroupedBeatmap = gb;
    this.debounceQueueSelection(gb.beatmap);
  }

  /** requestRecommendedSelection: DifficultyRecommender has no user statistics offline, so the first difficulty is used. */
  private requestRecommendedSelection(list: GroupedBeatmap[]): void {
    if (list.length === 0) return;
    this.queueBeatmapSelection(list[0]);
  }

  private ensureGlobalBeatmapValid(): boolean {
    if (!this.current) return false;
    this.performDebounceSelection();
    if (this.carousel.isFiltering || this.filterDebouncePending) return false;

    const current = this.workingFilterBeatmap();
    if (this.checkBeatmapValidForSelection(current)) {
      this.carousel.currentBeatmap = current;
      return true;
    }

    // If there was no beatmap selected, pick a random one.
    if (!this.game.working || !current) {
      const valid = this.carousel.nextRandom();
      this.performDebounceSelection();
      return valid;
    }

    // In the case a difficulty was hidden or removed, prefer selecting another difficulty from the same set.
    const validBeatmaps = current.set.beatmaps.filter(b => this.checkBeatmapValidForSelection(b));
    if (validBeatmaps.length > 0) {
      this.carousel.currentBeatmap = validBeatmaps[0];
      this.debounceQueueSelection(validBeatmaps[0]);
      return true;
    }

    // If all else fails, select something random (lazer: the default beatmap, which in turn triggers a random selection).
    const valid = this.carousel.nextRandom();
    this.performDebounceSelection();
    return valid;
  }

  /** SelectAndRun(beatmap, OnStart) */
  private selectAndRun(b: FilterBeatmap): void {
    if (!this.current) return;
    if (!this.checkBeatmapValidForSelection(b)) return;
    this.cancelDebounceSelection();
    const src = this.model.sources.get(b);
    if (!src) return;
    this.game.select(src.set, src.entry);
    if (!this.game.working) return;
    this.onStart();
  }

  /** Starts gameplay on the current selection (used after generating a chart from the main menu). */
  startSelected(): void {
    if (this.game.currentScreen === this) this.onStart();
  }

  openGenerator(): void {
    openChartGenerator(this.game, { onPlay: () => this.onStart() });
  }

  /** SoloSongSelect.OnStart */
  private onStart(): void {
    const w = this.game.working;
    if (!w) return;
    const r = this.game.ruleset;
    this.modsAtGameplayStart = this.game.mods;
    let mods = this.game.mods.forRuleset(r.shortName, r.availableMods);
    if (this.ctrlForStart) {
      if (!r.availableMods.includes('AT')) {
        this.game.toast('The current ruleset doesn\'t have an autoplay mod available!', 'error');
        return;
      }
      if (!mods.has('AT')) mods = mods.toggle('AT');
      this.game.setMods(mods);
    }
    this.ctrlForStart = false;
    setLastPlayed(w.entry.hash, Date.now());
    this.game.playUiSample('menu-confirm', 0.7);
    this.game.push(new PlayerScreen(this.game, w, r, mods));
  }

  // ------------------------------------------------------------------ filtering

  private criteriaChanged(criteria: FilterCriteria): void {
    clearTimeout(this.filterDebounce);
    const isFirstFilter = this.firstFilter;
    this.firstFilter = false;
    const isSelectionValid = this.checkBeatmapValidForSelection(this.workingFilterBeatmap());
    this.filterDebouncePending = true;
    this.filterDebounce = window.setTimeout(
      () => {
        this.filterDebouncePending = false;
        this.carousel.filter(criteria, isFirstFilter || !isSelectionValid);
      },
      isFirstFilter || !isSelectionValid ? 0 : FILTER_DELAY,
    );
  }

  /** newItemsPresented */
  private newItemsPresented(): void {
    if (!this.carousel.criteria) return;
    this.carouselItemsPresented = true;
    this.updateNoResultsPlaceholder();
    const count = this.carousel.matchedBeatmapsCount;
    this.filterControl.statusText = `${count.toLocaleString('en-US')} match${count === 1 ? '' : 'es'}`;
    if (this.debounceQueuedSelection == null) this.ensureGlobalBeatmapValid();
    this.updateWedgeVisibility();
  }

  private updateNoResultsPlaceholder(): void {
    const count = this.carousel.matchedBeatmapsCount;
    const ease = cssEasing(Easing.OutPow10);
    if (count === 0) {
      this.noResults.show(this.carousel.criteria!);
      this.rightGradient.style.transition = `width 1000ms ${ease}`;
      this.rightGradient.style.width = '300%';
    } else {
      this.noResults.hide();
      this.rightGradient.style.transition = `width 400ms ${ease}`;
      this.rightGradient.style.width = '100%';
    }
  }

  private updateWedgeVisibility(): void {
    if (!this.carouselItemsPresented && !this.checkBeatmapValidForSelection(this.workingFilterBeatmap())) return;
    const show = !this.carousel.visuallyFocusSelected;
    this.titleWedge.setVisible(show);
    this.detailsArea.setVisible(show);
    this.filterControl.setVisible(show);
  }

  // ------------------------------------------------------------------ scoping

  private scopeToBeatmapSet(set: GroupedBeatmapSet['beatmapSet']): void {
    this.beforeScopedSelection = this.carousel.currentGroupedBeatmap;
    const m = set.metadata;
    this.filterControl.setScopedBeatmapSet(set, `${m.artist} - ${m.title} (${m.author})`);
  }

  private unscopeBeatmapSet(restorePreviousSelection: boolean): void {
    if (!this.filterControl.scopedBeatmapSet) return;
    if (this.beforeScopedSelection && restorePreviousSelection) this.queueBeatmapSelection(this.beforeScopedSelection);
    this.beforeScopedSelection = null;
    this.filterControl.setScopedBeatmapSet(null, '');
  }

  // ------------------------------------------------------------------ background reveal

  private onPointerDown(e: PointerEvent): void {
    if (e.button !== 0 || e.pointerType === 'touch') return;
    const t = e.target as HTMLElement;
    // Only when the screen itself is the hovered target (not panels, wedges, filter control or the footer).
    if (t.closest('.p, .title-wedge, .details-area, .filter-control, .screen-footer, .ss-toolbar, .no-results, .carousel-scrollbar, .ss-context-menu')) return;
    if (this.revealTimer) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const move = (ev: PointerEvent) => {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) > 8) {
        clearTimeout(this.revealTimer);
        this.revealTimer = 0;
        window.removeEventListener('pointermove', move);
      }
    };
    window.addEventListener('pointermove', move);
    this.revealTimer = window.setTimeout(() => {
      window.removeEventListener('pointermove', move);
      if (this.carousel.absoluteScrolling) return;
      this.revealed = true;
      this.updateBackgroundBlur();
      const ease = cssEasing(Easing.OutQuint);
      this.mainContent.style.transition = `transform 600ms ${ease}, opacity 200ms ${ease}`;
      this.mainContent.style.transform = 'scale(1.2)';
      this.mainContent.style.opacity = '0';
      this.footer.setVisible(false);
    }, REVEAL_BACKGROUND_DELAY);
  }

  private readonly onPointerUp = (): void => this.restoreBackground();

  private restoreBackground(): void {
    if (!this.revealTimer) return;
    clearTimeout(this.revealTimer);
    this.revealTimer = 0;
    if (this.revealed) {
      this.revealed = false;
      this.updateBackgroundBlur();
      const ease = cssEasing(Easing.OutQuint);
      this.mainContent.style.transition = `transform 500ms ${ease}, opacity 500ms ${ease}`;
      this.mainContent.style.transform = '';
      this.mainContent.style.opacity = '1';
      this.footer.setVisible(true);
    }
  }

  // ------------------------------------------------------------------ mods

  private toggleModSelect(): void {
    if (this.game.hasOverlay) {
      this.game.closeOverlay();
      return;
    }
    openModSelect(this.game, { footer: this.footer, ownerButton: this.modsButton, scale: this.drawSize.scale });
  }

  private storeLastActiveRateAdjustMod(): void {
    const rate = this.game.mods.list.find(a => ['DT', 'NC', 'HT', 'DC'].includes(a));
    if (rate) this.lastActiveRateAdjustMod = { acronym: rate, settings: { ...(this.game.mods.settings[rate] ?? {}) } };
  }

  /** ModSpeedHotkeyHandler.ChangeSpeed */
  private changeSpeed(delta: number): boolean {
    const r = this.game.ruleset;
    const mods = this.game.mods.forRuleset(r.shortName, r.availableMods);
    const rateMod = mods.list.find(a => ['DT', 'NC', 'HT', 'DC'].includes(a));
    const targetSpeed = (rateMod ? mods.setting<number>(rateMod, 'speed') : 1) + delta;
    const withoutRate = () => {
      let m = mods;
      for (const a of ['DT', 'NC', 'HT', 'DC']) if (m.has(a)) m = m.toggle(a);
      return m;
    };
    const toast = (speed: number) => this.game.toast(`Playback speed: ${speed.toFixed(2)}x`);

    if (Math.abs(targetSpeed - 1) <= 0.005) {
      this.game.setMods(withoutRate());
      toast(targetSpeed);
      return true;
    }

    const last = this.lastActiveRateAdjustMod;
    const target = last && (last.acronym === 'DC' || last.acronym === 'NC') ? (targetSpeed < 1 ? 'DC' : 'NC') : targetSpeed < 1 ? 'HT' : 'DT';
    if (!r.availableMods.includes(target)) return false;

    let next = withoutRate().toggle(target);
    // Copy every other setting of the last active rate mod (e.g. adjust pitch).
    if (last) for (const [k, v] of Object.entries(last.settings)) if (k !== 'speed' && (target === 'DT' || target === 'HT')) next = next.withSetting(target, k, v);
    // SpeedChange is a bounded bindable (DT/NC 1.01..2, HT/DC 0.5..0.99, precision 0.01).
    const [min, max] = target === 'DT' || target === 'NC' ? [1.01, 2] : [0.5, 0.99];
    const speed = Math.round(Math.max(min, Math.min(max, targetSpeed)) * 100) / 100;
    next = next.withSetting(target, 'speed', speed);
    this.game.setMods(next);
    toast(speed);
    return true;
  }

  // ------------------------------------------------------------------ beatmap management

  private async deleteSet(record: BeatmapSetRecord): Promise<void> {
    if (record.builtIn) {
      this.game.toast("The built-in demo beatmap can't be deleted", 'error');
      return;
    }
    const e = record.beatmaps[0];
    // BeatmapDeleteDialog
    if (!(await confirmDialog(this.game, `Confirm deletion of ${e.artist} - ${e.title} (${e.creator})`, 'Yes. Totally. Delete it.'))) return;
    if (this.game.working?.set.id === record.id) this.game.working = null;
    this.game.library.softDelete(record.id);
    this.game.toast('Beatmap set deleted');
  }

  /** BeatmapClearScoresDialog */
  private async clearLocalScores(hash: string): Promise<void> {
    if (!(await confirmDialog(this.game, 'All local scores on this beatmap will be deleted!', 'Yes. Please.'))) return;
    try {
      const scores = await Database.getScores(hash);
      for (const s of scores) if (s.id != null) await Database.deleteScore(s.id);
    } catch {
      /* ignore */
    }
    this.localRanks.clear();
    this.detailsArea.refresh();
    this.game.toast('Local scores cleared');
  }

  /** LocalScoreDeleteDialog */
  private async deleteScore(s: ScoreRecord): Promise<void> {
    if (s.id == null) return;
    if (!(await confirmDialog(this.game, `Are you sure you want to delete this local score? (${s.player}, ${Math.round(s.totalScore).toLocaleString('en-US')})`, 'Yes. Please.'))) return;
    try {
      await Database.deleteScore(s.id);
    } catch {
      /* ignore */
    }
    this.localRanks.clear();
    this.detailsArea.refresh();
  }

  private async watchReplay(s: ScoreRecord): Promise<void> {
    if (!s.hasReplay || s.id == null) return;
    const replay = await Database.getReplay(s.id).catch(() => undefined);
    const w = this.game.working;
    if (!replay || !w) return;
    this.game.push(new PlayerScreen(this.game, w, this.game.ruleset, new ModSet(s.mods, s.modSettings ?? replay.modSettings ?? {}), replay));
  }

  /** SoloSongSelect.GetForwardActions */
  private forwardActions(b: FilterBeatmap): MenuItem[] {
    const played = getLastPlayed(b.id) != null;
    const src = this.model.sources.get(b);
    // SongSelect.CreateCollectionMenuActions: a toggle per collection plus "Manage".
    const key = src ? collectionKey(src.entry) : b.md5Hash;
    const collectionItems: MenuItem[] = [
      ...Collections.all().map(c => ({ text: c.name, checked: c.hashes.includes(key), action: () => Collections.toggle(c.id, key, !c.hashes.includes(key)) })),
      { text: 'Manage', action: () => openManageCollections(this.game) },
    ];
    return [
      { text: 'Play', type: 'highlighted', icon: 'check', action: () => this.selectAndRun(b) },
      { text: '', spacer: true },
      { text: 'Collections', items: collectionItems },
      played
        ? { text: 'Remove from played', icon: 'timesCircle', action: () => (setLastPlayed(b.id, null), this.libraryChanged()) }
        : { text: 'Mark as played', icon: 'timesCircle', action: () => (setLastPlayed(b.id, Date.now()), this.libraryChanged()) },
      { text: 'Clear all local scores', type: 'destructive', icon: 'eraser', action: () => void this.clearLocalScores(src?.entry.hash ?? b.id) },
      ...(src && HiddenBeatmaps.canHide(src.set.beatmaps.map(x => x.hash), src.entry.hash) ? [{ text: 'Hide', action: () => HiddenBeatmaps.hide(src.entry.hash) }] : []),
    ];
  }

  private optionsEntries(): OptionsEntry[] {
    const b = this.workingFilterBeatmap();
    const w = this.game.working;
    if (!w || !b) return [];
    const e = w.entry;
    const entries: OptionsEntry[] = [
      { header: 'For all difficulties', context: `${e.artist} - ${e.title} (${e.creator})` },
      { text: 'Delete...', icon: 'trash', colour: OsuColour.Red1, action: () => void this.deleteSet(w.set) },
      { header: 'For selected difficulty', context: e.difficultyName },
    ];
    for (const item of this.forwardActions(b)) {
      if (item.spacer) entries.push({ spacer: true });
      else entries.push({ text: item.text, icon: item.icon, colour: item.type === 'destructive' ? OsuColour.Red1 : undefined, action: item.action });
    }
    return entries;
  }

  private showPanelContextMenu(item: CarouselItem, e: MouseEvent): void {
    const m = item.model;
    let items: MenuItem[] = [];
    if (m instanceof GroupDefinition) items = [{ text: item.isExpanded ? 'Collapse' : 'Expand', type: 'highlighted', action: () => this.carousel.activate(item) }];
    else if (m instanceof GroupedBeatmapSet) {
      const record = this.model.recordFor(m.beatmapSet.id);
      if (!item.isExpanded) items.push({ text: 'Expand', type: 'highlighted', action: () => this.carousel.activate(item) }, { text: '', spacer: true });
      if (record) {
        // PanelBeatmapSet: Collections (all difficulties toggled together), Restore all hidden, Delete.
        const keys = record.beatmaps.map(e => collectionKey(e));
        items.push({
          text: 'Collections',
          items: [
            ...Collections.all().map(c => {
              const inCount = keys.filter(k => c.hashes.includes(k)).length;
              const all = inCount === keys.length;
              return { text: `${c.name}${inCount > 0 && !all ? ' (partial)' : ''}`, checked: all, action: () => keys.forEach(k => Collections.toggle(c.id, k, !all)) };
            }),
            { text: 'Manage', action: () => openManageCollections(this.game) },
          ],
        });
        if (record.beatmaps.some(e => HiddenBeatmaps.isHidden(e.hash))) items.push({ text: 'Restore all hidden', action: () => HiddenBeatmaps.restoreSet(record.beatmaps.map(e => e.hash)) });
        items.push({ text: 'Delete...', type: 'destructive', action: () => void this.deleteSet(record) });
      }
    } else if (m instanceof GroupedBeatmap) items = this.forwardActions(m.beatmap);
    if (items.length > 0) showContextMenu(e.clientX, e.clientY, items);
  }

  // ------------------------------------------------------------------ local ranks (PanelLocalRankDisplay / RankAchieved grouping)

  private getLocalRank(hash: string, cb: (r: ScoreRank | null) => void): void {
    const key = `${hash}|${this.game.ruleset.id}`;
    if (this.localRanks.has(key)) {
      cb(this.localRanks.get(key)!);
      return;
    }
    const waiters = this.localRankWaiters.get(key);
    if (waiters) {
      waiters.push(cb);
      return;
    }
    this.localRankWaiters.set(key, [cb]);
    const rulesetId = this.game.ruleset.id;
    void Database.getScores(hash)
      .catch(() => [] as ScoreRecord[])
      .then(scores => {
        const best = scores.filter(s => s.rulesetId === rulesetId).sort((a, b) => b.totalScore - a.totalScore || a.date - b.date)[0];
        const rank = (best?.rank as ScoreRank | undefined) ?? null;
        this.localRanks.set(key, rank);
        const ws = this.localRankWaiters.get(key) ?? [];
        this.localRankWaiters.delete(key);
        ws.forEach(w => w(rank));
      });
  }

  /** GetBeatmapInfoGuidToTopRankMapping (from the ranks loaded so far). */
  private topRankMapping(): Map<string, ScoreRank> {
    const out = new Map<string, ScoreRank>();
    const suffix = `|${this.game.ruleset.id}`;
    for (const [k, v] of this.localRanks) if (v && k.endsWith(suffix)) out.set(k.slice(0, -suffix.length), v);
    return out;
  }

  // ------------------------------------------------------------------ input

  /** Keys the search box would otherwise swallow (lazer's InnerTextBox doesn't handle left/right arrows, page up/down, shift+delete). */
  private onSearchKeyDown(e: KeyboardEvent): void {
    if (['ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown'].includes(e.code) || (e.code === 'Delete' && e.shiftKey)) {
      if (this.onKeyDown(e)) {
        e.preventDefault();
        e.stopPropagation();
      }
    } else if (e.code === 'Escape') {
      if (this.filterControl.scopedBeatmapSet) return;
      if (this.filterControl.search.value) {
        this.filterControl.search_('');
        e.preventDefault();
        e.stopPropagation();
      }
    }
  }

  onKeyDown(e: KeyboardEvent): boolean {
    this.keysHeld.add(e.code);
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') this.randomButton.setShift(true);
    if (this.optionsButton.handleKey(e)) return true;
    const typing = document.activeElement === this.filterControl.search;

    switch (e.code) {
      case 'ArrowUp':
      case 'ArrowDown': {
        const dir = e.code === 'ArrowUp' ? -1 : 1;
        if (e.ctrlKey || e.metaKey) {
          // GlobalAction.IncreaseModSpeed / DecreaseModSpeed
          return this.changeSpeed(dir < 0 ? 0.05 : -0.05);
        }
        this.carousel.selectNext(dir);
        return true;
      }
      case 'ArrowLeft':
      case 'ArrowRight': {
        const dir = e.code === 'ArrowLeft' ? -1 : 1;
        if (e.shiftKey) this.carousel.expandNextGroup(dir);
        else this.carousel.activateNextSet(dir);
        return true;
      }
      case 'PageUp':
      case 'PageDown':
        this.carousel.selectPage(e.code === 'PageUp' ? -1 : 1);
        return true;
      case 'Home':
      case 'End':
        if (typing) return false;
        this.carousel.selectEdge(e.code === 'Home' ? -1 : 1);
        return true;
      case 'Enter':
      case 'NumpadEnter':
        if (e.repeat) return true;
        if (e.shiftKey) {
          this.carousel.toggleCurrentGroup();
          return true;
        }
        this.ctrlForStart = e.ctrlKey || e.metaKey;
        // Carousel.OnKeyDown handles Enter first (activating the keyboard selection); otherwise GlobalAction.Select.
        if (!this.carousel.activateSelection()) {
          this.ensureGlobalBeatmapValid();
          const b = this.workingFilterBeatmap();
          if (b) this.selectAndRun(b);
        }
        return true;
      case 'Space':
        if (typing) return false;
        this.ctrlForStart = false;
        if (!this.carousel.activateSelection()) {
          const b = this.workingFilterBeatmap();
          if (b) this.selectAndRun(b);
        }
        return true;
      case 'F1':
        if (!e.repeat) this.modsButton.triggerClick();
        return true;
      case 'F2':
        if (!e.repeat) this.randomButton.press(e.shiftKey);
        return true;
      case 'F3':
        if (!e.repeat && this.game.working) this.optionsButton.triggerClick();
        return true;
      case 'Backspace':
        if (typing) return false;
        // GlobalAction.DeselectAllMods
        this.game.setMods(this.game.mods.forRuleset(this.game.ruleset.shortName, []));
        return true;
      case 'Delete':
        if (e.shiftKey && !e.repeat) {
          if (this.game.working) void this.deleteSet(this.game.working.set);
          return true;
        }
        return false;
    }
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyG') {
      this.openGenerator();
      return true;
    }
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyO') {
      openSettings(this.game);
      return true;
    }
    if (!typing && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // HoldFocus: typing anywhere goes to the search box.
      this.filterControl.search.focus({ preventScroll: true });
      return false;
    }
    return false;
  }

  onKeyUp(e: KeyboardEvent): boolean {
    this.keysHeld.delete(e.code);
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') this.randomButton.setShift(false);
    return false;
  }
}

function backgroundUrl(set: BeatmapSetRecord): string | null {
  let u = bgUrls.get(set.id);
  if (u) return u;
  // PanelBeatmapSet: s.Beatmaps.MinBy(b => b.OnlineID)
  const first = [...set.beatmaps].sort((a, b) => a.onlineId - b.onlineId)[0];
  const blob = first ? findFile(set.files, first.backgroundFile) : undefined;
  if (!blob) return null;
  u = URL.createObjectURL(blob);
  bgUrls.set(set.id, u);
  return u;
}

