// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game/Graphics/Carousel/Carousel.cs (+ Carousel.ScrollContainer.cs) and osu.Game/Screens/Select/BeatmapCarousel.cs:
// filtering pipeline, Y layout with panel spacing, selection / keyboard selection, group & set expansion, keyboard traversal
// (arrows, left/right set, page up/down, home/end, shift+left/right groups), random selection with rewind, and a virtualised,
// pooled DOM panel display with the circular X offset curve and damped Y movement.

import { settings } from '../../framework/Settings';
import { dampContinuously } from './Anim';
import {
  CarouselItem,
  CarouselModel,
  filterGrouping,
  filterMatching,
  filterSorting,
  GroupDefinition,
  GroupedBeatmap,
  GroupedBeatmapSet,
  GroupingContext,
  GroupingResult,
  modelKey,
  shouldGroupBeatmapsTogether,
} from './BeatmapCarouselFilters';
import type { FilterBeatmap, FilterCriteria } from './FilterCriteria';
import { Panel, PanelBeatmap, PanelBeatmapSet, PanelBeatmapStandalone, PanelContext, PanelGroup, PanelKind } from './Panels';
import { h } from '../dom';
import { cssEasing, Easing } from './Anim';

/** BeatmapCarousel.SPACING */
export const SPACING = 3;
const SCROLL_BAR_WIDTH = 10;
const DISTANCE_DECAY_SCROLL = 0.01;
const DISTANCE_DECAY_JUMP = 0.01;
const SCROLL_DISTANCE = 80;
const DEBOUNCE_DELAY = 100;
const DISTANCE_OFFSCREEN_TO_PRELOAD = 100;

interface Selection {
  model: CarouselModel | null;
  item: CarouselItem | null;
  y: number | null;
  index: number | null;
}

const selection = (model: CarouselModel | null = null, item: CarouselItem | null = null, y: number | null = null, index: number | null = null): Selection => ({ model, item, y, index });

export interface CarouselCallbacks {
  requestPresentBeatmap(b: GroupedBeatmap): void;
  requestSelection(b: GroupedBeatmap): void;
  requestRecommendedSelection(b: GroupedBeatmap[]): void;
  newItemsPresented(): void;
  playSample(name: 'difficulty' | 'set' | 'group' | 'traverse' | 'random'): void;
  groupingContext(): GroupingContext;
}

const eq = (a: CarouselModel | null | undefined, b: CarouselModel | null | undefined): boolean => a != null && b != null && modelKey(a) === modelKey(b);

export class BeatmapCarousel {
  readonly el: HTMLDivElement;
  private readonly panelsEl: HTMLDivElement;
  private readonly scrollbar: HTMLDivElement;
  private readonly scrollbarBox: HTMLDivElement;

  bleedTop = 0;
  bleedBottom = 0;
  /** When true, all panels other than the selected one are moved off to the right (gameplay transition). */
  visuallyFocusSelected = false;
  private selectionFocusOffset = 0;

  criteria: FilterCriteria | null = null;
  private allBeatmaps: FilterBeatmap[] = [];
  private grouping: GroupingResult | null = null;
  private carouselItems: CarouselItem[] | null = null;
  private filterTimer = 0;
  private filterPending = false;
  private clearOnNextFilter = false;
  matchedBeatmapsCount = 0;

  private currentSelection: Selection = selection();
  private currentKeyboardSelection: Selection = selection();
  private selectionValid = false;
  expandedGroup: GroupDefinition | null = null;
  expandedBeatmapSet: GroupedBeatmapSet | null = null;

  // scrolling
  private current = 0;
  private target = 0;
  private decay = DISTANCE_DECAY_JUMP;
  private layoutHeight = 0;
  private scrollToSelectionOp: 'none' | 'standard' | 'immediate' = 'none';
  userScrolling = false;
  absoluteScrolling = false;

  private drawHeight = 0;
  private visibleHalfHeight = 0;
  private displayedRange: [number, number] | null = null;
  private readonly panels = new Map<CarouselItem, Panel>();
  private readonly pools: Record<PanelKind, Panel[]> = { set: [], beatmap: [], standalone: [], group: [] };

  // random (BeatmapCarousel random selection handling)
  private readonly previouslyVisitedRandomBeatmaps = new Set<string>();
  private readonly randomHistory: GroupedBeatmap[] = [];

  constructor(
    private readonly ctx: PanelContext,
    private readonly callbacks: CarouselCallbacks,
  ) {
    this.panelsEl = h('div', { class: 'carousel-panels' });
    this.scrollbarBox = h('div', { class: 'carousel-scrollbar-box' });
    this.scrollbar = h('div', { class: 'carousel-scrollbar' }, this.scrollbarBox);
    this.el = h('div', { class: 'beatmap-carousel' }, this.panelsEl, this.scrollbar);
    this.setupInput();
  }

  // ------------------------------------------------------------------ items & filtering

  setBeatmaps(beatmaps: FilterBeatmap[]): void {
    this.allBeatmaps = beatmaps;
    this.queueFilter(false);
  }

  get isFiltering(): boolean {
    return this.filterPending;
  }

  /** BeatmapCarousel.Filter */
  filter(criteria: FilterCriteria, immediate = false): void {
    const resetDisplay = this.grouping != null && this.grouping.beatmapSetsGroupedTogether !== shouldGroupBeatmapsTogether(criteria);
    this.criteria = criteria;
    this.queueFilter(resetDisplay, immediate);
  }

  private queueFilter(clearExistingPanels: boolean, immediate = false): void {
    if (!this.criteria) return;
    this.clearOnNextFilter ||= clearExistingPanels;
    this.filterPending = true;
    clearTimeout(this.filterTimer);
    // Carousel.DebounceDelay
    this.filterTimer = window.setTimeout(() => this.performFilter(), immediate ? 0 : DEBOUNCE_DELAY);
  }

  private performFilter(): void {
    const criteria = this.criteria!;
    const matched = filterMatching(this.allBeatmaps, criteria);
    const sorted = filterSorting(matched, criteria);
    const grouping = filterGrouping(sorted, criteria, this.callbacks.groupingContext());

    this.grouping = grouping;
    this.matchedBeatmapsCount = grouping.beatmapItemsCount;
    this.carouselItems = grouping.items;
    this.updateYPositions(grouping.items, this.visibleHalfHeight);
    this.displayedRange = null;
    this.filterPending = false;

    if (this.clearOnNextFilter) {
      for (const [item, panel] of [...this.panels]) this.expirePanel(item, panel);
      this.clearOnNextFilter = false;
    }

    this.handleFilterCompleted();
    this.refreshAfterSelection();
    if (!this.userScrolling) this.scrollToSelection(true);
    this.callbacks.newItemsPresented();
  }

  getCarouselItems(): CarouselItem[] | null {
    return this.carouselItems;
  }

  get beatmapSetsGroupedTogether(): boolean {
    return this.grouping?.beatmapSetsGroupedTogether ?? true;
  }

  /** BeatmapCarousel.GetSpacingBetweenPanels */
  private getSpacingBetweenPanels(top: CarouselItem, bottom: CarouselItem): number {
    if (top.model instanceof GroupDefinition !== bottom.model instanceof GroupDefinition) return SPACING * 2;

    if (this.beatmapSetsGroupedTogether) {
      // Give some space around the expanded beatmap set, at the top..
      if (bottom.model instanceof GroupedBeatmapSet && bottom.isExpanded) return SPACING * 2;
      // ..and the bottom.
      if (top.model instanceof GroupedBeatmap && bottom.model instanceof GroupedBeatmapSet) return SPACING * 2;
      // Beatmap difficulty panels do not overlap with themselves or any other panel.
      if (top.model instanceof GroupedBeatmap || bottom.model instanceof GroupedBeatmap) return SPACING;
    } else if (this.currentSelection.model != null && (top === this.currentSelection.item || bottom === this.currentSelection.item)) return SPACING * 2;

    return -SPACING;
  }

  private updateYPositions(items: CarouselItem[], offset: number): void {
    const state = { previousVisible: null as CarouselItem | null, offset };
    for (const item of items) this.updateItemYPosition(item, state);
  }

  private updateItemYPosition(item: CarouselItem, state: { previousVisible: CarouselItem | null; offset: number }): void {
    const spacing = state.previousVisible == null || !item.isVisible ? 0 : this.getSpacingBetweenPanels(state.previousVisible, item);
    state.offset += spacing;
    item.carouselYPosition = state.offset;
    if (spacing > 0) {
      item.carouselInputLenienceAbove = spacing / 2;
      if (state.previousVisible) state.previousVisible.carouselInputLenienceBelow = item.carouselInputLenienceAbove;
    }
    if (item.isVisible) {
      state.offset += item.drawHeight;
      state.previousVisible = item;
    }
  }

  // ------------------------------------------------------------------ selection

  get currentGroupedBeatmap(): GroupedBeatmap | null {
    return this.currentSelection.model instanceof GroupedBeatmap ? this.currentSelection.model : null;
  }

  set currentGroupedBeatmap(value: GroupedBeatmap | null) {
    this.setCurrentSelection(value);
  }

  get currentSelectionItem(): CarouselItem | null {
    return this.currentSelection.item;
  }

  get currentBeatmap(): FilterBeatmap | null {
    return this.currentGroupedBeatmap?.beatmap ?? null;
  }

  set currentBeatmap(value: FilterBeatmap | null) {
    if (value == null) {
      this.currentGroupedBeatmap = null;
      return;
    }
    if (this.currentGroupedBeatmap && this.currentGroupedBeatmap.beatmap.id === value.id && this.currentGroupedBeatmap.beatmap.set.id === value.set.id) return;
    const found = !this.isFiltering ? this.carouselItems?.map(i => i.model).find((m): m is GroupedBeatmap => m instanceof GroupedBeatmap && m.beatmap === value) : undefined;
    this.currentGroupedBeatmap = found ?? new GroupedBeatmap(null, value);
  }

  private setCurrentSelection(value: CarouselModel | null): void {
    if (!eq(this.currentSelection.model, value) || (value == null) !== (this.currentSelection.model == null)) {
      this.handleItemSelected(value);
      this.currentSelection = selection(value);
      this.currentKeyboardSelection = this.currentSelection;
      this.selectionValid = false;
    }
    if (!eq(this.currentKeyboardSelection.model, value)) {
      this.currentKeyboardSelection = this.currentSelection;
      this.selectionValid = false;
    }
  }

  private setKeyboardSelection(model: CarouselModel | null): void {
    this.currentKeyboardSelection = selection(model);
    this.selectionValid = false;
  }

  /** Carousel.Activate */
  activate(item: CarouselItem): void {
    this.setKeyboardSelection(item.model);
    this.panels.get(item)?.activated();
    this.handleItemActivated(item);
    this.selectionValid = false;
  }

  /** BeatmapCarousel.HandleItemActivated */
  private handleItemActivated(item: CarouselItem): void {
    const m = item.model;
    try {
      if (m instanceof GroupDefinition) {
        if (this.expandedGroup && this.expandedGroup.key === m.key) {
          this.setExpansionStateOfGroup(this.expandedGroup, false);
          this.expandedGroup = null;
          return;
        }
        this.setExpandedGroup(m);
        // If the active selection is within this group, it should get keyboard focus immediately.
        if (this.currentSelection.item?.isVisible && this.currentSelection.model instanceof GroupedBeatmap) this.callbacks.requestSelection(this.currentSelection.model);
        return;
      }
      if (m instanceof GroupedBeatmapSet) {
        this.selectRecommendedDifficultyForBeatmapSet(m);
        return;
      }
      if (m instanceof GroupedBeatmap) {
        if (this.currentSelection.model != null && eq(this.currentSelection.model, m)) {
          this.callbacks.requestPresentBeatmap(m);
          return;
        }
        this.callbacks.requestSelection(m);
      }
    } finally {
      this.playActivationSound(item);
    }
  }

  private playActivationSound(item: CarouselItem): void {
    if (item.model instanceof GroupDefinition) this.callbacks.playSample('group');
    else if (item.model instanceof GroupedBeatmapSet) this.callbacks.playSample('set');
    else this.callbacks.playSample('difficulty');
  }

  /** BeatmapCarousel.HandleItemSelected */
  private handleItemSelected(model: CarouselModel | null): void {
    if (model instanceof GroupedBeatmap) {
      this.setExpandedGroup(model.group);
      this.setExpandedSet(new GroupedBeatmapSet(model.group, model.beatmap.set));
    }
  }

  private shouldActivateOnKeyboardSelection(item: CarouselItem): boolean {
    return this.beatmapSetsGroupedTogether && item.model instanceof GroupedBeatmap;
  }

  private checkValidForGroupSelection(item: CarouselItem): boolean {
    return item.model instanceof GroupDefinition;
  }

  private checkValidForSetSelection(item: CarouselItem): boolean {
    if (item.model instanceof GroupedBeatmapSet) return true;
    if (item.model instanceof GroupedBeatmap) return !this.beatmapSetsGroupedTogether;
    return false;
  }

  private findCarouselItemsForSelection(): void {
    const map = this.grouping?.itemMap;
    if (!map) return;
    const k = this.currentKeyboardSelection.model && map.get(modelKey(this.currentKeyboardSelection.model));
    if (k) this.currentKeyboardSelection = { ...this.currentKeyboardSelection, item: k.item, index: k.index };
    const s = this.currentSelection.model && map.get(modelKey(this.currentSelection.model));
    if (s) this.currentSelection = { ...this.currentSelection, item: s.item, index: s.index };
  }

  /** BeatmapCarousel.HandleFilterCompleted */
  private handleFilterCompleted(): void {
    this.attemptSelectSingleFilteredResult();

    // Store selected group before handling selection (it may implicitly change the expanded group).
    const sel = this.currentSelection.model;
    if (sel instanceof GroupedBeatmap && !this.grouping!.itemMap.has(modelKey(sel))) {
      // The selection may not be in this group any more (e.g. grouping changed). Select the first instance in the new grouping.
      const newSelection = this.carouselItems?.map(i => i.model).find((m): m is GroupedBeatmap => m instanceof GroupedBeatmap && m.beatmap.id === sel.beatmap.id && m.beatmap.set.id === sel.beatmap.set.id);
      if (newSelection) this.setCurrentSelection(newSelection);
    }

    if (this.expandedBeatmapSet) this.setExpandedSet(this.expandedBeatmapSet);
    if (this.expandedGroup) this.setExpandedGroup(this.expandedGroup);

    for (const panel of this.panels.values()) if (panel instanceof PanelBeatmapSet) panel.refreshVisibleBeatmaps();
  }

  private attemptSelectSingleFilteredResult(): void {
    const items = this.carouselItems;
    if (!items || items.length === 0) return;

    let setId: string | null = null;
    for (const item of items) {
      if (item.model instanceof GroupedBeatmap) {
        if (setId == null) {
          setId = item.model.beatmap.set.id;
          continue;
        }
        if (setId !== item.model.beatmap.set.id) return;
      }
    }

    const beatmaps = items.map(i => i.model).filter((m): m is GroupedBeatmap => m instanceof GroupedBeatmap);
    const preexisting = beatmaps.find(b => eq(b, this.currentSelection.model));
    if (preexisting) {
      if (this.currentSelection.item == null) this.callbacks.requestSelection(preexisting);
      return;
    }
    if (beatmaps.length > 0) this.callbacks.requestRecommendedSelection(beatmaps);
  }

  private selectRecommendedDifficultyForBeatmapSet(set: GroupedBeatmapSet): void {
    const entry = this.grouping?.setItems.get(set.key);
    if (entry) this.callbacks.requestRecommendedSelection(entry.items.map(i => i.model).filter((m): m is GroupedBeatmap => m instanceof GroupedBeatmap));
  }

  private setExpandedGroup(group: GroupDefinition | null): void {
    if (this.expandedGroup) this.setExpansionStateOfGroup(this.expandedGroup, false);
    this.expandedGroup = group;
    if (this.expandedGroup) this.setExpansionStateOfGroup(this.expandedGroup, true);
  }

  private setExpansionStateOfGroup(group: GroupDefinition, expanded: boolean): void {
    const entry = this.grouping?.groupItems.get(group.key);
    if (!entry) return;
    for (const i of entry.items) {
      if (expanded) {
        if (i.model instanceof GroupDefinition) i.isExpanded = true;
        else if (i.model instanceof GroupedBeatmapSet) {
          i.isVisible = true;
          this.setExpansionStateOfSetItems(i.model, i.isExpanded);
        } else if (!this.beatmapSetsGroupedTogether) i.isVisible = true;
      } else if (i.model instanceof GroupDefinition) i.isExpanded = false;
      else i.isVisible = false;
    }
    this.selectionValid = false;
  }

  private setExpandedSet(set: GroupedBeatmapSet): void {
    const last = this.expandedBeatmapSet;
    this.expandedBeatmapSet = set;
    if (!this.beatmapSetsGroupedTogether) return;
    this.setExpansionStateOfSetItems(last, false);
    this.setExpansionStateOfSetItems(this.expandedBeatmapSet, true);
  }

  private setExpansionStateOfSetItems(set: GroupedBeatmapSet | null, expanded: boolean): void {
    if (!set || !this.grouping) return;
    const canMakeVisible = this.grouping.groupItems.size === 0 || (this.expandedGroup?.key ?? null) === (set.group?.key ?? null);
    const entry = this.grouping.setItems.get(set.key);
    if (!entry) return;
    for (const i of entry.items) {
      if (i.model instanceof GroupedBeatmapSet) i.isExpanded = expanded;
      else i.isVisible = canMakeVisible && expanded;
    }
    this.selectionValid = false;
  }

  /** Difficulties of a set that passed the current filter (BeatmapCarousel.updateVisibleBeatmaps). */
  visibleBeatmapsOf(set: GroupedBeatmapSet): Set<FilterBeatmap> | null {
    const entry = this.grouping?.setItems.get(set.key);
    if (!entry) return null;
    return new Set(entry.items.map(i => i.model).filter((m): m is GroupedBeatmap => m instanceof GroupedBeatmap).map(m => m.beatmap));
  }

  private refreshAfterSelection(): void {
    const state = { previousVisible: null as CarouselItem | null, offset: this.visibleHalfHeight };
    this.displayedRange = null;

    const prevKeyboard = this.currentKeyboardSelection;
    this.currentKeyboardSelection = selection(this.currentKeyboardSelection.model);
    this.currentSelection = selection(this.currentSelection.model);

    if (!this.carouselItems) return;

    this.findCarouselItemsForSelection();

    for (const item of this.carouselItems) this.updateItemYPosition(item, state);

    const k = this.currentKeyboardSelection.item;
    if (k) this.currentKeyboardSelection.y = k.carouselYPosition + k.drawHeight / 2;
    const s = this.currentSelection.item;
    if (s) this.currentSelection.y = s.carouselYPosition + s.drawHeight / 2;

    this.layoutHeight = state.offset + this.visibleHalfHeight;

    // If a keyboard selection is currently made, we want to keep the view stable around the selection.
    if (prevKeyboard.y != null && this.currentKeyboardSelection.y != null && this.currentKeyboardSelection.y !== prevKeyboard.y) this.offsetScrollPosition(this.currentKeyboardSelection.y - prevKeyboard.y);
  }

  scrollToSelection(immediate = false): void {
    if (this.scrollToSelectionOp === 'immediate') return;
    this.scrollToSelectionOp = immediate ? 'immediate' : 'standard';
  }

  private getScrollTarget(): number | null {
    let target = this.currentKeyboardSelection.y;
    if (target == null && this.grouping) {
      let targetItem: CarouselItem | null = null;
      if (this.expandedBeatmapSet) targetItem = this.grouping.itemMap.get(modelKey(this.expandedBeatmapSet))?.item ?? null;
      if (!targetItem && this.expandedGroup) targetItem = this.grouping.itemMap.get(modelKey(this.expandedGroup))?.item ?? null;
      target = targetItem?.carouselYPosition ?? null;
    }
    return target;
  }

  // ------------------------------------------------------------------ keyboard traversal

  /** Enter / GlobalAction.Select */
  activateSelection(): boolean {
    if (this.currentKeyboardSelection.item) {
      this.activate(this.currentKeyboardSelection.item);
      return true;
    }
    return false;
  }

  selectNext(direction: 1 | -1): void {
    const items = this.carouselItems;
    if (!items || items.length === 0) return;
    const originalIndex = this.currentKeyboardSelection.index ?? (direction > 0 ? items.length - 1 : 0);
    let newIndex = originalIndex;
    do {
      newIndex = (newIndex + direction + items.length) % items.length;
      const newItem = items[newIndex];
      if (newItem.isVisible) {
        if (!eq(this.currentSelection.model, newItem.model) && this.shouldActivateOnKeyboardSelection(newItem)) this.activate(newItem);
        else {
          this.callbacks.playSample('traverse');
          this.setKeyboardSelection(newItem.model);
        }
        return;
      }
    } while (newIndex !== originalIndex);
  }

  /** Page up / page down. */
  selectPage(direction: 1 | -1): void {
    const items = this.carouselItems;
    if (!items || items.length === 0) return;
    const startIndex = this.currentKeyboardSelection.index ?? (direction > 0 ? items.length - 1 : 0);
    const visiblePanelsCount = Math.max(1, Math.floor(this.panels.size / 2));
    let visibleCount = 0;
    let i = startIndex;
    while (i >= 0 && i < items.length) {
      i += direction;
      if (i < 0 || i >= items.length) break;
      const item = items[i];
      if (!item.isVisible) continue;
      visibleCount++;
      if (visibleCount >= visiblePanelsCount) {
        this.setKeyboardSelection(item.model);
        this.scrollToSelection();
        this.callbacks.playSample('traverse');
        return;
      }
    }
    const fallback = direction > 0 ? [...items].reverse().find(x => x.isVisible) : items.find(x => x.isVisible);
    if (fallback && !eq(fallback.model, this.currentKeyboardSelection.model)) {
      this.setKeyboardSelection(fallback.model);
      this.scrollToSelection();
      this.callbacks.playSample('traverse');
    }
  }

  /** Home / end. */
  selectEdge(direction: 1 | -1): void {
    const items = this.carouselItems;
    if (!items || items.length === 0) return;
    const item = direction > 0 ? [...items].reverse().find(x => x.isVisible) : items.find(x => x.isVisible);
    if (item && !eq(item.model, this.currentKeyboardSelection.model)) {
      this.setKeyboardSelection(item.model);
      this.scrollToSelection();
      this.callbacks.playSample('traverse');
    }
  }

  /** Left / right (ActivatePreviousSet / ActivateNextSet). */
  activateNextSet(direction: 1 | -1): void {
    // If the user has a different keyboard selection and requests set selection, first transfer the keyboard selection to actual selection.
    if (this.currentKeyboardSelection.item && this.currentSelection.item !== this.currentKeyboardSelection.item) {
      this.activate(this.currentKeyboardSelection.item);
      return;
    }
    this.traverseSelection(direction, i => this.checkValidForSetSelection(i));
  }

  /** Shift+left / shift+right (ExpandPreviousGroup / ExpandNextGroup). */
  expandNextGroup(direction: 1 | -1): void {
    this.traverseSelection(direction, i => this.checkValidForGroupSelection(i));
  }

  /** Shift+Enter (ToggleCurrentGroup). */
  toggleCurrentGroup(): void {
    const items = this.carouselItems;
    if (!items || items.length === 0) return;
    const k = this.currentKeyboardSelection;
    if (!k.item || k.index == null) return;
    if (this.checkValidForGroupSelection(k.item)) {
      this.activate(k.item);
      return;
    }
    for (let i = k.index; i >= 0; i--) {
      if (this.checkValidForGroupSelection(items[i])) {
        this.activate(items[i]);
        return;
      }
    }
  }

  private traverseSelection(direction: 1 | -1, predicate: (i: CarouselItem) => boolean): void {
    const items = this.carouselItems;
    if (!items || items.length === 0) return;
    let originalIndex: number;
    let newIndex: number;
    if (this.currentKeyboardSelection.index == null) newIndex = originalIndex = direction > 0 ? items.length - 1 : 0;
    else {
      newIndex = originalIndex = this.currentKeyboardSelection.index;
      // As a second special case, if we're traversing backwards we need to find the previous matching item first.
      if (direction < 0) while (newIndex > 0 && !predicate(items[newIndex])) newIndex--;
    }
    for (;;) {
      newIndex = (newIndex + direction + items.length) % items.length;
      if (newIndex === originalIndex) break;
      const newItem = items[newIndex];
      if (!newItem.isExpanded && predicate(newItem)) {
        this.activate(newItem);
        return;
      }
    }
  }

  // ------------------------------------------------------------------ random

  /** BeatmapCarousel.NextRandom (RandomSelectAlgorithm.RandomPermutation) */
  nextRandom(): boolean {
    const items = this.carouselItems;
    if (!items || items.length === 0 || !this.grouping) return false;
    const beatmapBefore = this.currentSelection.model instanceof GroupedBeatmap && this.currentSelection.item ? this.currentSelection.model : null;
    if (beatmapBefore) {
      this.randomHistory.push(beatmapBefore);
      this.previouslyVisitedRandomBeatmaps.add(beatmapBefore.beatmap.id);
    }
    const success = this.beatmapSetsGroupedTogether ? this.nextRandomSet() : this.nextRandomBeatmap();
    if (!success) {
      if (beatmapBefore) this.randomHistory.pop();
      return false;
    }
    this.callbacks.playSample('random');
    return true;
  }

  private nextRandomBeatmap(): boolean {
    const groupEntry = this.expandedGroup ? this.grouping!.groupItems.get(this.expandedGroup.key) : undefined;
    const visible = (groupEntry ? groupEntry.items : this.carouselItems!).map(i => i.model).filter((m): m is GroupedBeatmap => m instanceof GroupedBeatmap);
    // RandomSelectAlgorithm.Random: any visible beatmap.
    if (settings.get<string>('select.randomAlgorithm', 'permutation') === 'random') {
      if (visible.length === 0) return false;
      this.callbacks.requestSelection(visible[Math.floor(Math.random() * visible.length)]);
      return true;
    }
    let notYetVisited = visible.filter(b => !this.previouslyVisitedRandomBeatmaps.has(b.beatmap.id));
    if (notYetVisited.length === 0) {
      for (const b of visible) this.previouslyVisitedRandomBeatmaps.delete(b.beatmap.id);
      notYetVisited = visible;
      const cur = this.currentSelection.model;
      if (cur instanceof GroupedBeatmap) notYetVisited = notYetVisited.filter(b => !eq(b, cur));
    }
    if (notYetVisited.length === 0) return false;
    this.callbacks.requestSelection(notYetVisited[Math.floor(Math.random() * notYetVisited.length)]);
    return true;
  }

  private nextRandomSet(): boolean {
    const groupEntry = this.expandedGroup ? this.grouping!.groupItems.get(this.expandedGroup.key) : undefined;
    const visibleSets = groupEntry ? groupEntry.items.map(i => i.model).filter((m): m is GroupedBeatmapSet => m instanceof GroupedBeatmapSet) : [...this.grouping!.setItems.values()].map(v => v.set);
    if (settings.get<string>('select.randomAlgorithm', 'permutation') === 'random') {
      if (visibleSets.length === 0) return false;
      this.selectRecommendedDifficultyForBeatmapSet(visibleSets[Math.floor(Math.random() * visibleSets.length)]);
      return true;
    }
    const visitedSetIds = new Set<string>();
    for (const s of visibleSets) if (s.beatmapSet.beatmaps.some(b => this.previouslyVisitedRandomBeatmaps.has(b.id))) visitedSetIds.add(s.beatmapSet.id);
    let notYetVisited = visibleSets.filter(s => !visitedSetIds.has(s.beatmapSet.id));
    if (notYetVisited.length === 0) {
      for (const s of visibleSets) for (const b of s.beatmapSet.beatmaps) this.previouslyVisitedRandomBeatmaps.delete(b.id);
      notYetVisited = visibleSets;
      const cur = this.currentSelection.model;
      if (cur instanceof GroupedBeatmap) notYetVisited = notYetVisited.filter(s => s.beatmapSet.id !== cur.beatmap.set.id);
    }
    if (notYetVisited.length === 0) return false;
    this.selectRecommendedDifficultyForBeatmapSet(notYetVisited[Math.floor(Math.random() * notYetVisited.length)]);
    return true;
  }

  /** BeatmapCarousel.PreviousRandom */
  previousRandom(): boolean {
    const items = this.carouselItems;
    if (!items || items.length === 0) return false;
    while (this.randomHistory.length > 0) {
      const previous = this.randomHistory.pop()!;
      const candidates = items.filter(i => i.model instanceof GroupedBeatmap && i.model.beatmap.id === previous.beatmap.id && i.model.beatmap.set.id === previous.beatmap.set.id);
      const previousItem = candidates.find(i => ((i.model as GroupedBeatmap).group?.key ?? null) === (previous.group?.key ?? null)) ?? candidates[0];
      if (!previousItem) return false;
      const cur = this.currentSelection.model;
      if (cur instanceof GroupedBeatmap && settings.get<string>('select.randomAlgorithm', 'permutation') === 'permutation') this.previouslyVisitedRandomBeatmaps.delete(cur.beatmap.id);
      this.callbacks.playSample('random');
      this.callbacks.requestSelection(previousItem.model as GroupedBeatmap);
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------------ scrolling

  private offsetScrollPosition(offset: number): void {
    this.current += offset;
    this.target += offset;
    for (const p of this.panels.values()) p.drawYPosition += offset;
  }

  private get scrollableExtent(): number {
    return Math.max(0, this.layoutHeight - this.drawHeight);
  }

  scrollTo(value: number, animated = true, decay = DISTANCE_DECAY_JUMP): void {
    this.target = Math.max(0, Math.min(this.scrollableExtent, value));
    this.decay = decay;
    if (!animated) this.current = this.target;
  }

  scrollBy(delta: number): void {
    this.scrollTo(this.target + delta, true, DISTANCE_DECAY_SCROLL);
  }

  private scrollToAbsolutePosition(localY: number): void {
    const barHeight = this.scrollbarHeight();
    const movementExtent = this.drawHeight - barHeight;
    const padTop = 5;
    const padBottom = 70;
    const from = (pos: number) => (movementExtent - (padTop + padBottom) <= 0 ? 0 : this.scrollableExtent * ((pos - padTop) / (movementExtent - (padTop + padBottom))));
    this.scrollTo(from(localY) - from(barHeight) * 0.5, true);
  }

  private scrollbarHeight(): number {
    if (this.layoutHeight <= 0) return 0;
    return Math.max(SCROLL_BAR_WIDTH * 3, Math.min(1, this.drawHeight / this.layoutHeight) * this.drawHeight);
  }

  private setupInput(): void {
    this.el.addEventListener(
      'wheel',
      e => {
        e.preventDefault();
        const scale = parseFloat(getComputedStyle(this.el).getPropertyValue('--ui-scale') || '1') || 1;
        const delta = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaMode === 2 ? e.deltaY * this.drawHeight : e.deltaY;
        this.userScrolling = true;
        this.scrollBy(((delta / 100) * SCROLL_DISTANCE) / scale);
      },
      { passive: false },
    );

    // Drag scrolling (ScrollContainer drag) and right-mouse absolute scrolling.
    let drag: { id: number; startY: number; startScroll: number; moved: boolean } | null = null;
    const localY = (e: PointerEvent) => {
      const r = this.el.getBoundingClientRect();
      return ((e.clientY - r.top) / r.height) * this.drawHeight;
    };
    this.el.addEventListener('pointerdown', e => {
      if (e.button === 2) {
        if ((e.target as HTMLElement).closest('.p')) return; // panels provide a context menu instead
        this.absoluteScrolling = true;
        this.userScrolling = true;
        this.scrollToAbsolutePosition(localY(e));
        this.el.setPointerCapture(e.pointerId);
        return;
      }
      if (e.button !== 0) return;
      drag = { id: e.pointerId, startY: localY(e), startScroll: this.target, moved: false };
    });
    this.el.addEventListener('pointermove', e => {
      if (this.absoluteScrolling) {
        this.scrollToAbsolutePosition(localY(e));
        return;
      }
      if (!drag || drag.id !== e.pointerId) return;
      const dy = localY(e) - drag.startY;
      if (!drag.moved && Math.abs(dy) > 8) {
        drag.moved = true;
        this.el.setPointerCapture(e.pointerId);
      }
      if (drag.moved) {
        this.userScrolling = true;
        this.scrollTo(drag.startScroll - dy, false);
      }
    });
    const end = (e: PointerEvent) => {
      if (this.absoluteScrolling && e.button === 2) this.absoluteScrolling = false;
      if (drag && drag.id === e.pointerId) {
        if (drag.moved) {
          const suppress = (ev: Event) => {
            ev.stopPropagation();
            ev.preventDefault();
          };
          window.addEventListener('click', suppress, { capture: true, once: true });
          setTimeout(() => window.removeEventListener('click', suppress, true), 0);
        }
        drag = null;
      }
    };
    this.el.addEventListener('pointerup', end);
    this.el.addEventListener('pointercancel', end);
    this.el.addEventListener('contextmenu', e => e.preventDefault());

    // Scrollbar dragging.
    this.scrollbarBox.addEventListener('pointerdown', e => {
      e.stopPropagation();
      if (e.button !== 0) return;
      this.scrollbarBox.setPointerCapture(e.pointerId);
      this.scrollbar.classList.add('dragging');
      const startY = e.clientY;
      const startTarget = this.target;
      const r = this.el.getBoundingClientRect();
      const ratio = this.drawHeight / r.height;
      const move = (ev: PointerEvent) => {
        const movement = this.drawHeight - this.scrollbarHeight() - 75;
        if (movement <= 0) return;
        this.userScrolling = true;
        this.scrollTo(startTarget + ((ev.clientY - startY) * ratio * this.scrollableExtent) / movement, false);
      };
      const up = () => {
        this.scrollbar.classList.remove('dragging');
        this.scrollbarBox.removeEventListener('pointermove', move);
        this.scrollbarBox.removeEventListener('pointerup', up);
      };
      this.scrollbarBox.addEventListener('pointermove', move);
      this.scrollbarBox.addEventListener('pointerup', up);
    });
  }

  // ------------------------------------------------------------------ display (Carousel.Update / UpdateAfterChildren)

  /** Per-frame update. `drawHeight` is the carousel's draw height in osu! pixels. */
  update(drawHeight: number, elapsed: number): void {
    if (drawHeight !== this.drawHeight) {
      this.drawHeight = drawHeight;
      this.selectionValid = false;
    }

    // BeatmapCarousel.Update: selection focus offset
    this.selectionFocusOffset = dampContinuously(this.selectionFocusOffset, this.visuallyFocusSelected ? 300 : 0, 100, elapsed);

    if (!this.carouselItems) return;

    // ScrollContainer.Update: Current approaches Target with exponential decay.
    this.current = this.target + (this.current - this.target) * Math.exp(-this.decay * elapsed);
    if (Math.abs(this.current - this.target) < 0.05) this.current = this.target;

    const visibleBottomBound = this.current + this.drawHeight + this.bleedBottom;
    const visibleUpperBound = this.current - this.bleedTop;
    this.visibleHalfHeight = (this.drawHeight + this.bleedBottom + this.bleedTop) / 2;

    if (!this.selectionValid) {
      this.refreshAfterSelection();
      this.scrollToSelection();
      this.selectionValid = true;
    }

    const range = this.getDisplayRange(visibleUpperBound, visibleBottomBound);
    if (!this.displayedRange || range[0] !== this.displayedRange[0] || range[1] !== this.displayedRange[1]) {
      this.displayedRange = range;
      this.updateDisplayedRange(range);
    }

    const selectedYPos = this.currentSelection.item?.carouselYPosition ?? 0;
    for (const [item, panel] of this.panels) {
      const normalisedDepth = Math.abs(selectedYPos - item.carouselYPosition) / Math.max(1, this.drawHeight);
      panel.el.style.zIndex = String(Math.round(100000 - (item.depthLayer + normalisedDepth) * 1000));
      if (panel.drawYPosition !== item.carouselYPosition) panel.drawYPosition = dampContinuously(panel.drawYPosition, item.carouselYPosition, 50, elapsed);
      panel.setState(this.currentSelection.item != null && item === this.currentSelection.item, item === this.currentKeyboardSelection.item, item.isExpanded);
    }

    // UpdateAfterChildren: pending scroll-to-selection.
    if (this.scrollToSelectionOp !== 'none') {
      const t = this.getScrollTarget();
      if (t != null) this.scrollTo(t - this.visibleHalfHeight + this.bleedTop, this.scrollToSelectionOp === 'standard');
      this.scrollToSelectionOp = 'none';
    }

    // ApplyCurrentToContent + GetPanelXOffset
    for (const [item, panel] of this.panels) {
      const y = panel.drawYPosition - this.current;
      const centre = y + item.drawHeight / 2;
      const dist = Math.abs(1 - (centre + this.bleedTop) / this.visibleHalfHeight);
      panel.x = offsetX(dist, this.visibleHalfHeight) + (panel.selected ? 0 : this.selectionFocusOffset);
      panel.el.style.transform = `translate3d(${panel.x}px, ${y}px, 0)`;
      panel.update();
    }

    this.updateScrollbar();
  }

  private updateScrollbar(): void {
    const extent = this.scrollableExtent;
    if (extent <= 0) {
      this.scrollbar.style.opacity = '0';
      return;
    }
    this.scrollbar.style.opacity = '1';
    const barHeight = this.scrollbarHeight();
    const movement = this.drawHeight - barHeight;
    const padTop = 5;
    const padBottom = 70;
    const pos = padTop + (movement - (padTop + padBottom)) * (Math.max(0, Math.min(extent, this.current)) / extent);
    this.scrollbarBox.style.height = `${barHeight}px`;
    this.scrollbarBox.style.transform = `translateY(${pos}px)`;
  }

  private getDisplayRange(upper: number, bottom: number): [number, number] {
    const items = this.carouselItems!;
    if (items.length === 0) return [-1, -1];
    const lowerBound = (y: number) => {
      let lo = 0;
      let hi = items.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (items[mid].carouselYPosition < y) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    };
    const first = Math.max(0, lowerBound(upper - DISTANCE_OFFSCREEN_TO_PRELOAD) - 1);
    const last = Math.max(0, lowerBound(bottom + DISTANCE_OFFSCREEN_TO_PRELOAD) - 1);
    return [first, last];
  }

  private updateDisplayedRange(range: [number, number]): void {
    const items = this.carouselItems!;
    const toDisplay = range[0] < 0 ? [] : items.slice(range[0], range[1] + 1).filter(i => i.isVisible);
    const byKey = new Map(toDisplay.map(i => [modelKey(i.model), i]));
    const added = new Set<Panel>();

    for (const [item, panel] of [...this.panels]) {
      const existing = byKey.get(modelKey(item.model));
      if (existing && panelKindFor(existing, this.beatmapSetsGroupedTogether) === panel.kind) {
        byKey.delete(modelKey(item.model));
        if (existing !== item) {
          this.panels.delete(item);
          this.panels.set(existing, panel);
          panel.prepare(existing);
        }
        continue;
      }
      this.expirePanel(item, panel);
    }

    for (const item of byKey.values()) {
      const panel = this.getPanel(panelKindFor(item, this.beatmapSetsGroupedTogether));
      panel.prepare(item);
      panel.drawYPosition = item.carouselYPosition;
      this.panels.set(item, panel);
      this.panelsEl.appendChild(panel.el);
      added.add(panel);
    }

    if (added.size > 0) {
      // Newly displayed panels in the middle of the screen animate out from the panel above them.
      const ordered = [...this.panels.entries()]
        .filter(([item]) => item.carouselYPosition + item.drawHeight >= this.current - this.bleedTop && item.carouselYPosition <= this.current + this.drawHeight + this.bleedBottom)
        .sort((a, b) => a[0].carouselYPosition - b[0].carouselYPosition);
      for (let i = 0; i < ordered.length; i++) {
        if (added.has(ordered[i][1]) && i > 0 && i < ordered.length - 1) ordered[i][1].drawYPosition = ordered[i - 1][1].drawYPosition;
      }
    }
  }

  private getPanel(kind: PanelKind): Panel {
    const pooled = this.pools[kind].pop();
    if (pooled) return pooled;
    switch (kind) {
      case 'set':
        return new PanelBeatmapSet(this.ctx);
      case 'beatmap':
        return new PanelBeatmap(this.ctx);
      case 'standalone':
        return new PanelBeatmapStandalone(this.ctx);
      default:
        return new PanelGroup(this.ctx);
    }
  }

  private expirePanel(item: CarouselItem, panel: Panel): void {
    this.panels.delete(item);
    panel.expiring = true;
    panel.setState(false, false, false);
    const el = panel.el;
    el.style.zIndex = String(Number(el.style.zIndex || 0) - 1024 * 1000);
    el.style.transition = `opacity 150ms ${cssEasing(Easing.OutQuint)}, transform 200ms ${cssEasing(Easing.Out)}`;
    el.style.opacity = '0';
    el.style.transform = `translate3d(${panel.x + 100}px, ${panel.drawYPosition - this.current}px, 0)`;
    setTimeout(() => {
      el.remove();
      el.style.transition = 'none';
      panel.expiring = false;
      panel.free();
      this.pools[panel.kind].push(panel);
    }, 200);
  }

  /** Ruleset / mods changed: displayed star ratings need recomputing. */
  refreshStarRatings(): void {
    for (const p of this.panels.values()) if (p instanceof PanelBeatmap || p instanceof PanelBeatmapStandalone) p.recomputeStars();
  }

  /** Beat-synced pulsing of selected panels. */
  onBeat(beatIndex: number, beatLength: number, beatsPerBar: number): void {
    for (const p of this.panels.values()) p.onBeat(beatIndex, beatLength, beatsPerBar);
  }

  get visiblePanelCount(): number {
    return this.panels.size;
  }

  dispose(): void {
    clearTimeout(this.filterTimer);
  }
}

function panelKindFor(item: CarouselItem, groupedTogether: boolean): PanelKind {
  const m = item.model;
  if (m instanceof GroupDefinition) return 'group';
  if (m instanceof GroupedBeatmapSet) return 'set';
  return groupedTogether ? 'beatmap' : 'standalone';
}

/** Carousel.offsetX: panels follow a circle with radius 3 (in units of half the visible height). */
function offsetX(dist: number, halfHeight: number): number {
  const circleRadius = 3;
  const discriminant = Math.max(0, circleRadius * circleRadius - dist * dist);
  return (circleRadius - Math.sqrt(discriminant)) * halfHeight;
}
