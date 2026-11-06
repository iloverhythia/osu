// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game/Screens/Select/BeatmapCarouselFilterMatching.cs, BeatmapCarouselFilterSorting.cs, BeatmapCarouselFilterGrouping.cs,
// osu.Game/Beatmaps/BeatmapInfoExtensions.cs (Match / AllowGameplayWithRuleset), BeatmapMetadataInfoExtensions.Match,
// the GroupDefinition records from BeatmapCarousel.cs and osu.Game.Rulesets.Mania/ManiaFilterCriteria.cs.

import { ManiaBeatmapConverter, MAX_STAGE_KEYS } from '../../game/rulesets/mania/beatmaps/ManiaBeatmapConverter';
import type { ScoreRank } from '../../game/scoring/ScoreRank';
import {
  BeatmapOnlineStatus,
  DATE_MIN,
  FilterBeatmap,
  FilterBeatmapSet,
  FilterCriteria,
  FilterMetadata,
  FilterRuleset,
  GroupMode,
  ONLINE_STATUS_NAMES,
  Operator,
  OptionalRange,
  OptionalTextFilter,
  RulesetFilterCriteria,
  SortMode,
} from './FilterCriteria';
import { tryUpdateCriteriaRangeFloat } from './FilterQueryParser';

// ---------------------------------------------------------------- carousel item model (osu.Game/Graphics/Carousel/CarouselItem.cs)

export const DEFAULT_ITEM_HEIGHT = 45;

export class CarouselItem {
  carouselYPosition = 0;
  carouselInputLenienceAbove = 0;
  carouselInputLenienceBelow = 0;
  drawHeight = DEFAULT_ITEM_HEIGHT;
  depthLayer = 0;
  isVisible = true;
  isExpanded = false;
  nestedItemCount = 0;

  constructor(readonly model: CarouselModel) {}
}

/** GroupDefinition (equality is by case-insensitive title). */
export class GroupDefinition {
  readonly key: string;

  constructor(
    readonly order: number,
    readonly title: string,
  ) {
    this.key = title.toLowerCase();
  }
}

export class StarDifficultyGroupDefinition extends GroupDefinition {
  constructor(
    order: number,
    title: string,
    readonly stars: number,
  ) {
    super(order, title);
  }
}

const RANK_ORDER: Record<ScoreRank, number> = { F: -1, D: 0, C: 1, B: 2, A: 3, S: 4, SH: 5, X: 6, XH: 7 };
const RANK_DESCRIPTIONS: Record<ScoreRank, string> = { F: 'F', D: 'D', C: 'C', B: 'B', A: 'A', S: 'S', SH: 'S+', X: 'SS', XH: 'SS+' };

export class RankDisplayGroupDefinition extends GroupDefinition {
  constructor(readonly rank: ScoreRank) {
    super(-RANK_ORDER[rank], RANK_DESCRIPTIONS[rank]);
  }
}

export class RankedStatusGroupDefinition extends GroupDefinition {
  constructor(
    order: number,
    readonly status: BeatmapOnlineStatus,
  ) {
    super(order, ONLINE_STATUS_NAMES[status]);
  }
}

/** GroupedBeatmapSet(Group, BeatmapSet) */
export class GroupedBeatmapSet {
  readonly key: string;

  constructor(
    readonly group: GroupDefinition | null,
    readonly beatmapSet: FilterBeatmapSet,
  ) {
    this.key = `s|${group?.key ?? ''}|${beatmapSet.id}`;
  }
}

/** GroupedBeatmap(Group, Beatmap) */
export class GroupedBeatmap {
  readonly key: string;

  constructor(
    readonly group: GroupDefinition | null,
    readonly beatmap: FilterBeatmap,
  ) {
    this.key = `b|${group?.key ?? ''}|${beatmap.id}`;
  }
}

export type CarouselModel = GroupDefinition | GroupedBeatmapSet | GroupedBeatmap | FilterBeatmap;

/** Value-equality key of a carousel model (BeatmapCarousel.CheckModelEquality). */
export function modelKey(m: CarouselModel): string {
  if (m instanceof GroupedBeatmap || m instanceof GroupedBeatmapSet) return m.key;
  if (m instanceof GroupDefinition) return `g|${m.key}`;
  return `m|${m.id}`;
}

// ---------------------------------------------------------------- BeatmapInfoExtensions

/** Whether gameplay is allowed for this beatmap with the provided ruleset (via conversion or direct compatibility). */
export function allowGameplayWithRuleset(beatmapRuleset: FilterRuleset, ruleset: FilterRuleset, allowConversion: boolean): boolean {
  if (beatmapRuleset.shortName === ruleset.shortName) return true;
  if (allowConversion && beatmapRuleset.onlineId === 0 && ruleset.onlineId !== 0) return true;
  return false;
}

function metadataMatch(metadata: FilterMetadata, filter: OptionalTextFilter): boolean {
  if (filter.matches(metadata.author)) return true;
  if (filter.matches(metadata.artist)) return true;
  if (filter.matches(metadata.artistUnicode)) return true;
  if (filter.matches(metadata.title)) return true;
  if (filter.matches(metadata.titleUnicode)) return true;
  if (filter.matches(metadata.source)) return true;
  if (filter.matches(metadata.tags)) return true;
  return false;
}

function beatmapMatch(beatmap: FilterBeatmap, filters: readonly OptionalTextFilter[]): boolean {
  for (const filter of filters) {
    if (filter.matches(beatmap.difficultyName)) continue;
    if (metadataMatch(beatmap.metadata, filter)) continue;
    // failed to match a single filter at all - fail the whole match.
    return false;
  }
  // got through all filters without failing any - pass the whole match.
  return true;
}

const floorToDecimalDigits = (value: number, digits: number): number => {
  const base10 = Math.pow(10, digits);
  return Math.floor(value * base10) / base10;
};

// ---------------------------------------------------------------- BeatmapCarouselFilterMatching

export function checkCriteriaMatch(beatmap: FilterBeatmap, criteria: FilterCriteria): boolean {
  let match = criteria.ruleset == null || allowGameplayWithRuleset(beatmap.ruleset, criteria.ruleset, criteria.allowConvertedBeatmaps);

  if (criteria.selectedBeatmapSet != null) {
    // only check ruleset equality or convertability for selected beatmap
    return beatmap.set.id === criteria.selectedBeatmapSet.id && match;
  }

  if (!match) return false;

  if (criteria.searchTerms.length > 0) {
    match = beatmapMatch(beatmap, criteria.searchTerms);

    // if a match wasn't found via text matching of terms, do a second catch-all check matching against online IDs.
    if (!match && criteria.searchNumber != null) match = beatmap.onlineId === criteria.searchNumber || beatmap.set.onlineId === criteria.searchNumber;
  }

  if (!match) return false;

  match &&= !criteria.starDifficulty.hasFilter || criteria.starDifficulty.isInRange(floorToDecimalDigits(beatmap.starRating, 2));
  match &&= !criteria.approachRate.hasFilter || criteria.approachRate.isInRange(beatmap.approachRate);
  match &&= !criteria.drainRate.hasFilter || criteria.drainRate.isInRange(beatmap.drainRate);
  match &&= !criteria.circleSize.hasFilter || criteria.circleSize.isInRange(beatmap.circleSize);
  match &&= !criteria.overallDifficulty.hasFilter || criteria.overallDifficulty.isInRange(beatmap.overallDifficulty);
  match &&= !criteria.length.hasFilter || criteria.length.isInRange(beatmap.length);
  match &&= !criteria.lastPlayed.hasFilter || criteria.lastPlayed.isInRange(beatmap.lastPlayed ?? DATE_MIN);
  match &&= !criteria.dateRanked.hasFilter || (beatmap.set.dateRanked != null && criteria.dateRanked.isInRange(beatmap.set.dateRanked));
  match &&= !criteria.dateSubmitted.hasFilter || (beatmap.set.dateSubmitted != null && criteria.dateSubmitted.isInRange(beatmap.set.dateSubmitted));
  match &&= !criteria.bpm.hasFilter || criteria.bpm.isInRange(beatmap.bpm);

  match &&= !criteria.beatDivisor.hasFilter || criteria.beatDivisor.isInRange(beatmap.beatDivisor);
  match &&= !criteria.onlineStatus.hasFilter || criteria.onlineStatus.isInRange(beatmap.status);

  if (!match) return false;

  match &&= !criteria.creator.hasFilter || criteria.creator.matches(beatmap.metadata.author);

  if (criteria.artist.hasFilter) {
    if (criteria.artist.excludeTerm) match &&= criteria.artist.matches(beatmap.metadata.artist) && criteria.artist.matches(beatmap.metadata.artistUnicode);
    else match &&= criteria.artist.matches(beatmap.metadata.artist) || criteria.artist.matches(beatmap.metadata.artistUnicode);
  }

  if (criteria.title.hasFilter) {
    if (criteria.title.excludeTerm) match &&= criteria.title.matches(beatmap.metadata.title) && criteria.title.matches(beatmap.metadata.titleUnicode);
    else match &&= criteria.title.matches(beatmap.metadata.title) || criteria.title.matches(beatmap.metadata.titleUnicode);
  }

  match &&= !criteria.difficultyName.hasFilter || criteria.difficultyName.matches(beatmap.difficultyName);
  match &&= !criteria.source.hasFilter || criteria.source.matches(beatmap.metadata.source);

  for (const tagFilter of criteria.userTags) {
    if (tagFilter.excludeTerm) {
      // every user tag must pass an excluding filter.
      for (const tag of beatmap.metadata.userTags) match &&= tagFilter.matches(tag);
    } else {
      // at least one of the user tags must pass an including filter.
      let anyTagMatched = false;
      for (const tag of beatmap.metadata.userTags) anyTagMatched ||= tagFilter.matches(tag);
      match &&= anyTagMatched;
    }
  }

  match &&= !criteria.userStarDifficulty.hasFilter || criteria.userStarDifficulty.isInRange(beatmap.starRating);

  if (!match) return false;

  match &&= criteria.collectionBeatmapMD5Hashes?.has(beatmap.md5Hash) ?? true;
  if (match && criteria.rulesetCriteria != null) match &&= criteria.rulesetCriteria.matches(beatmap, criteria);

  if (match && criteria.hasOnlineId === true) match &&= beatmap.onlineId >= 0;

  if (match && criteria.beatmapSetId != null) match &&= criteria.beatmapSetId === beatmap.set.onlineId;

  return match;
}

/** BeatmapCarouselFilterMatching.Run */
export function filterMatching(items: readonly FilterBeatmap[], criteria: FilterCriteria): FilterBeatmap[] {
  const out: FilterBeatmap[] = [];
  for (const beatmap of items) {
    if (beatmap.hidden) continue;
    if (!checkCriteriaMatch(beatmap, criteria)) continue;
    out.push(beatmap);
  }
  return out;
}

// ---------------------------------------------------------------- BeatmapCarouselFilterSorting

/** OrdinalSortByCaseStringComparer: ordinal ignore-case comparison, ties broken by ordinal (case-sensitive) comparison. */
export function ordinalSortByCaseCompare(a: string, b: string): number {
  const ua = a.toUpperCase();
  const ub = b.toUpperCase();
  if (ua !== ub) return ua < ub ? -1 : 1;
  return a === b ? 0 : a < b ? -1 : 1;
}

const numCompare = (a: number, b: number): number => (a < b ? -1 : a > b ? 1 : 0);
/** Nullable.Compare: null sorts before any value. */
const nullableCompare = (a: number | null, b: number | null): number => (a == null ? (b == null ? 0 : -1) : b == null ? 1 : numCompare(a, b));

/**
 * Lazer compares `BeatmapSet.ID` (a GUID) as the last tie breaker; we compare the set id string. Visible beatmaps are tracked so
 * aggregate comparisons can ignore difficulties hidden by the current filter (lazer's `Hidden` flag + filtered items).
 */
export function filterSorting(items: FilterBeatmap[], criteria: FilterCriteria): FilterBeatmap[] {
  const groupedSets = shouldGroupBeatmapsTogether(criteria);

  // lazer's aggregate comparison uses `BeatmapSet.Beatmaps.Where(b => !b.Hidden)`, i.e. every non-hidden difficulty.
  const aggregateCache = new Map<string, number | null>();
  const aggregateMax = (b: FilterBeatmap, kind: string, func: (b: FilterBeatmap) => number): number | null => {
    const k = `${kind}|${b.set.id}`;
    let v = aggregateCache.get(k);
    if (v === undefined) {
      const visible = b.set.beatmaps.filter(bb => !bb.hidden);
      v = visible.length === 0 ? null : Math.max(...visible.map(func));
      aggregateCache.set(k, v);
    }
    return v;
  };

  const compareUsingAggregateMax = (a: FilterBeatmap, b: FilterBeatmap, kind: string, func: (b: FilterBeatmap) => number): number => {
    const am = aggregateMax(a, kind, func);
    const bm = aggregateMax(b, kind, func);
    if (am == null && bm == null) return 0;
    if (am == null) return -1;
    if (bm == null) return 1;
    return numCompare(am, bm);
  };

  const compare = (a: FilterBeatmap, b: FilterBeatmap, sort: SortMode, aggregate: boolean): number => {
    let comparison: number;

    switch (sort) {
      case SortMode.Artist:
        comparison = ordinalSortByCaseCompare(a.set.metadata.artist, b.set.metadata.artist);
        if (comparison === 0) comparison = ordinalSortByCaseCompare(a.set.metadata.title, b.set.metadata.title);
        break;

      case SortMode.Title:
        comparison = ordinalSortByCaseCompare(a.set.metadata.title, b.set.metadata.title);
        break;

      case SortMode.Author:
        comparison = ordinalSortByCaseCompare(a.set.metadata.author, b.set.metadata.author);
        break;

      case SortMode.Source:
        comparison = ordinalSortByCaseCompare(a.set.metadata.source, b.set.metadata.source);
        break;

      case SortMode.Difficulty:
        comparison = numCompare(a.starRating, b.starRating);
        break;

      case SortMode.DateAdded:
        comparison = numCompare(b.set.dateAdded, a.set.dateAdded);
        break;

      case SortMode.DateRanked:
        comparison = nullableCompare(b.set.dateRanked, a.set.dateRanked);
        break;

      case SortMode.DateSubmitted:
        comparison = nullableCompare(b.set.dateSubmitted, a.set.dateSubmitted);
        break;

      case SortMode.LastPlayed:
        if (aggregate) comparison = compareUsingAggregateMax(b, a, 'lp', bb => Math.floor((bb.lastPlayed ?? DATE_MIN) / 1000));
        else comparison = nullableCompare(b.lastPlayed, a.lastPlayed);
        break;

      case SortMode.BPM:
        if (aggregate) comparison = compareUsingAggregateMax(a, b, 'bpm', bb => bb.bpm);
        else comparison = numCompare(a.bpm, b.bpm);
        break;

      case SortMode.Length:
        if (aggregate) comparison = compareUsingAggregateMax(a, b, 'len', bb => bb.length);
        else comparison = numCompare(a.length, b.length);
        break;

      default:
        throw new Error('Unknown sort mode');
    }

    // If the initial sort could not differentiate, attempt to use Title then DateAdded to order sets in a stable fashion.
    if (comparison === 0) comparison = ordinalSortByCaseCompare(a.set.metadata.title, b.set.metadata.title);

    if (comparison === 0) comparison = numCompare(b.set.dateAdded, a.set.dateAdded);

    // If both failed to break the tie, fallback to the internal id for stability.
    if (comparison === 0) comparison = b.set.id < a.set.id ? -1 : b.set.id > a.set.id ? 1 : 0;

    return comparison;
  };

  const compareDifficulty = (a: FilterBeatmap, b: FilterBeatmap): number => {
    let comparison = numCompare(a.ruleset.onlineId, b.ruleset.onlineId);
    if (comparison === 0) comparison = numCompare(a.starRating, b.starRating);
    return comparison;
  };

  // Enumerable.Order is a stable sort; Array.prototype.sort is stable as well.
  return [...items].sort((a, b) => {
    if (groupedSets) {
      if (a.set === b.set) return compareDifficulty(a, b);
      // If we're grouping by sets, all fallback sorts need to be aggregates for the set.
      return compare(a, b, criteria.sort, true);
    }
    return compare(a, b, criteria.sort, false);
  });
}

// ---------------------------------------------------------------- BeatmapCarouselFilterGrouping

export const PANEL_GROUP_HEIGHT = DEFAULT_ITEM_HEIGHT * 1.2;
export const PANEL_BEATMAP_SET_HEIGHT = DEFAULT_ITEM_HEIGHT * 1.6;
export const PANEL_BEATMAP_HEIGHT = DEFAULT_ITEM_HEIGHT;
export const PANEL_BEATMAP_STANDALONE_HEIGHT = DEFAULT_ITEM_HEIGHT * 1.6;

export function shouldGroupBeatmapsTogether(criteria: FilterCriteria): boolean {
  // In certain cases, we intentionally split out difficulties where it's more relevant or convenient to view them as individual items.
  if (criteria.sort === SortMode.Difficulty || criteria.group === GroupMode.Difficulty) return false;
  if (criteria.sort === SortMode.LastPlayed && criteria.group === GroupMode.LastPlayed) return false;
  if (criteria.group === GroupMode.RankAchieved) return false;

  // In the majority case we group sets together for display.
  return true;
}

export interface GroupingContext {
  /** Map of beatmap id -> best local rank (GetBeatmapInfoGuidToTopRankMapping). */
  getLocalUserTopRanks?: (criteria: FilterCriteria) => ReadonlyMap<string, ScoreRank>;
  /** Ruleset variant support (mania key counts). */
  getVariant?: (beatmap: FilterBeatmap, criteria: FilterCriteria) => { variant: number; name: string } | null;
  /** Date.now() override for tests. */
  now?: number;
}

export interface GroupingResult {
  items: CarouselItem[];
  beatmapSetsGroupedTogether: boolean;
  /** model key -> (item, index) */
  itemMap: Map<string, { item: CarouselItem; index: number }>;
  /** GroupedBeatmapSet key -> items related to that set (the set item and its difficulties). */
  setItems: Map<string, { set: GroupedBeatmapSet; items: CarouselItem[] }>;
  /** group key -> items within the group (including the group item itself). */
  groupItems: Map<string, { group: GroupDefinition; items: CarouselItem[] }>;
  beatmapItemsCount: number;
}

interface GroupMapping {
  group: GroupDefinition | null;
  itemsInGroup: FilterBeatmap[];
}

export function filterGrouping(items: FilterBeatmap[], criteria: FilterCriteria, context: GroupingContext = {}): GroupingResult {
  const newItemMap = new Map<string, { item: CarouselItem; index: number }>();
  const newSetMap = new Map<string, { set: GroupedBeatmapSet; items: CarouselItem[] }>();
  const newGroupMap = new Map<string, { group: GroupDefinition; items: CarouselItem[] }>();
  const newItems: CarouselItem[] = [];

  const beatmapSetsGroupedTogether = shouldGroupBeatmapsTogether(criteria);

  const groups = getGroups(items, criteria, context);
  let displayedBeatmapsCount = 0;

  for (const { group, itemsInGroup } of groups) {
    let groupItem: CarouselItem | null = null;
    let currentGroupItems: CarouselItem[] | null = null;
    let currentSetItems: CarouselItem[] | null = null;
    let lastBeatmap: FilterBeatmap | null = null;

    const addItem = (i: CarouselItem) => {
      newItems.push(i);
      newItemMap.set(modelKey(i.model), { item: i, index: newItems.length - 1 });
      currentGroupItems?.push(i);
      currentSetItems?.push(i);
      i.isVisible = i.model instanceof GroupDefinition || (group == null && (i.model instanceof GroupedBeatmapSet || !beatmapSetsGroupedTogether));
    };

    if (group != null) {
      currentGroupItems = [];
      newGroupMap.set(group.key, { group, items: currentGroupItems });

      groupItem = new CarouselItem(group);
      groupItem.drawHeight = PANEL_GROUP_HEIGHT;
      groupItem.depthLayer = -2;
      addItem(groupItem);
    }

    for (const beatmap of itemsInGroup) {
      const newBeatmapSet = lastBeatmap?.set.id !== beatmap.set.id;
      const groupedBeatmapSet = new GroupedBeatmapSet(group, beatmap.set);

      if (newBeatmapSet) {
        const existing = newSetMap.get(groupedBeatmapSet.key);
        if (existing) currentSetItems = existing.items;
        else {
          currentSetItems = [];
          newSetMap.set(groupedBeatmapSet.key, { set: groupedBeatmapSet, items: currentSetItems });
        }
      }

      if (beatmapSetsGroupedTogether) {
        if (newBeatmapSet) {
          if (groupItem != null) groupItem.nestedItemCount++;

          const setItem = new CarouselItem(groupedBeatmapSet);
          setItem.drawHeight = PANEL_BEATMAP_SET_HEIGHT;
          setItem.depthLayer = -1;
          addItem(setItem);
        }
      } else if (groupItem != null) groupItem.nestedItemCount++;

      const beatmapItem = new CarouselItem(new GroupedBeatmap(group, beatmap));
      beatmapItem.drawHeight = beatmapSetsGroupedTogether ? PANEL_BEATMAP_HEIGHT : PANEL_BEATMAP_STANDALONE_HEIGHT;
      addItem(beatmapItem);
      lastBeatmap = beatmap;
      displayedBeatmapsCount++;
    }
  }

  return { items: newItems, beatmapSetsGroupedTogether, itemMap: newItemMap, setItems: newSetMap, groupItems: newGroupMap, beatmapItemsCount: displayedBeatmapsCount };
}

/** FormatUtils.RoundBPM: Math.Round (banker's rounding) of bpm * rate. */
export function roundBPM(baseBpm: number, rate = 1): number {
  return roundHalfEven(baseBpm * rate);
}

export function roundHalfEven(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

function getGroups(items: FilterBeatmap[], criteria: FilterCriteria, context: GroupingContext): GroupMapping[] {
  const now = context.now ?? Date.now();

  switch (criteria.group) {
    case GroupMode.None:
    case GroupMode.Collections: // no collections exist in this port
    case GroupMode.Favourites: // favourites are online-only
    case GroupMode.MyMaps: // no logged-in user
      if (criteria.group === GroupMode.None) return [{ group: null, itemsInGroup: items }];
      return criteria.group === GroupMode.Collections ? getGroupsBy(() => [new GroupDefinition(Number.MAX_SAFE_INTEGER, 'Not in collection')], items) : [];

    case GroupMode.Artist:
      return getGroupsBy(b => defineGroupAlphabetically(b.set.metadata.artist), items);

    case GroupMode.Author:
      return getGroupsBy(b => defineGroupAlphabetically(b.set.metadata.author), items);

    case GroupMode.Title:
      return getGroupsBy(b => defineGroupAlphabetically(b.set.metadata.title), items);

    case GroupMode.DateAdded:
      return getGroupsBy(b => defineGroupByDate(b.set.dateAdded, now), items);

    case GroupMode.DateRanked:
      return getGroupsBy(b => defineGroupByRankedDate(b.set.dateRanked), items);

    case GroupMode.LastPlayed:
      return getGroupsBy(b => {
        if (b.lastPlayed == null) return [new GroupDefinition(Number.MAX_SAFE_INTEGER, 'Never played')];
        return defineGroupByDate(b.lastPlayed, now);
      }, items);

    case GroupMode.RankedStatus:
      return getGroupsBy(b => defineGroupByStatus(b.set.status), items);

    case GroupMode.BPM:
      return getGroupsBy(b => defineGroupByBPM(roundBPM(b.bpm)), items);

    case GroupMode.Difficulty:
      return getGroupsBy(b => defineGroupByStars(b.starRating), items);

    case GroupMode.Length:
      return getGroupsBy(b => defineGroupByLength(b.length), items);

    case GroupMode.Source:
      return getGroupsBy(b => defineGroupBySource(b.set.metadata.source), items);

    case GroupMode.RankAchieved: {
      const topRankMapping = context.getLocalUserTopRanks?.(criteria) ?? new Map<string, ScoreRank>();
      return getGroupsBy(b => {
        const rank = topRankMapping.get(b.id);
        if (rank) return [new RankDisplayGroupDefinition(rank)];
        return [new GroupDefinition(Number.MAX_SAFE_INTEGER, 'Unplayed')];
      }, items);
    }

    case GroupMode.Variant: {
      if (!context.getVariant) return [{ group: null, itemsInGroup: items }];
      return getGroupsBy(b => {
        const v = context.getVariant!(b, criteria);
        return v ? [new GroupDefinition(v.variant, v.name)] : [];
      }, items);
    }

    default:
      throw new Error('Unknown group mode');
  }
}

function getGroupsBy(defineGroups: (b: FilterBeatmap) => GroupDefinition[], items: FilterBeatmap[]): GroupMapping[] {
  const groups = new Map<string, GroupMapping>();

  for (const item of items) {
    for (const groupDefinition of defineGroups(item)) {
      let group = groups.get(groupDefinition.key);
      if (!group) {
        group = { group: groupDefinition, itemsInGroup: [] };
        groups.set(groupDefinition.key, group);
      }
      group.itemsInGroup.push(item);
    }
  }

  // OrderBy(Order).ThenBy(Title) (ordinal string comparison of the title, culture-sensitive in .NET; approximated with localeCompare).
  return [...groups.values()].sort((a, b) => a.group!.order - b.group!.order || a.group!.title.localeCompare(b.group!.title));
}

const isAsciiDigit = (c: string) => c >= '0' && c <= '9';
const isAsciiLetter = (c: string) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');

function defineGroupAlphabetically(name: string): GroupDefinition[] {
  const firstChar = name.length > 0 ? name[0] : '\0';

  if (isAsciiDigit(firstChar)) return [new GroupDefinition(Number.MIN_SAFE_INTEGER, '0-9')];

  if (isAsciiLetter(firstChar)) {
    const upper = firstChar.toUpperCase();
    return [new GroupDefinition(upper.charCodeAt(0) - 'A'.charCodeAt(0), upper)];
  }

  return [new GroupDefinition(Number.MAX_SAFE_INTEGER, 'Other')];
}

function defineGroupByDate(date: number, now: number): GroupDefinition[] {
  const elapsedDays = (now - date) / 86400000;

  if (elapsedDays < 1) return [new GroupDefinition(0, 'Today')];
  if (elapsedDays < 2) return [new GroupDefinition(1, 'Yesterday')];
  if (elapsedDays < 7) return [new GroupDefinition(2, 'Last week')];
  if (elapsedDays < 30) return [new GroupDefinition(3, 'Last month')];

  for (let i = 60; i <= 150; i += 30) {
    if (elapsedDays < i) {
      const months = i / 30 - 1;
      return [new GroupDefinition(i, `${months} month${months === 1 ? '' : 's'} ago`)];
    }
  }

  return [new GroupDefinition(151, 'Over 5 months ago')];
}

function defineGroupByRankedDate(date: number | null): GroupDefinition[] {
  if (date == null) return [new GroupDefinition(0, 'Unranked')];
  const year = new Date(date).getUTCFullYear();
  return [new GroupDefinition(-year, `${year}`)];
}

function defineGroupByStatus(status: BeatmapOnlineStatus): GroupDefinition[] {
  switch (status) {
    case BeatmapOnlineStatus.Ranked:
    case BeatmapOnlineStatus.Approved:
      return [new RankedStatusGroupDefinition(0, BeatmapOnlineStatus.Ranked)];
    case BeatmapOnlineStatus.Qualified:
      return [new RankedStatusGroupDefinition(1, status)];
    case BeatmapOnlineStatus.WIP:
      return [new RankedStatusGroupDefinition(2, status)];
    case BeatmapOnlineStatus.Pending:
      return [new RankedStatusGroupDefinition(3, status)];
    case BeatmapOnlineStatus.Graveyard:
      return [new RankedStatusGroupDefinition(4, status)];
    case BeatmapOnlineStatus.LocallyModified:
      return [new RankedStatusGroupDefinition(5, status)];
    case BeatmapOnlineStatus.None:
      return [new RankedStatusGroupDefinition(6, status)];
    case BeatmapOnlineStatus.Loved:
      return [new RankedStatusGroupDefinition(7, status)];
    default:
      throw new Error(`Unknown status ${status}`);
  }
}

function defineGroupByBPM(bpm: number): GroupDefinition[] {
  if (bpm < 60) return [new GroupDefinition(60, 'Under 60 BPM')];

  for (let i = 70; i <= 300; i += 10) {
    if (bpm < i) return [new GroupDefinition(i, `${i - 10} - ${i} BPM`)];
  }

  return [new GroupDefinition(301, 'Over 300 BPM')];
}

function defineGroupByStars(stars: number): GroupDefinition[] {
  // truncation is intentional - compare `FormatUtils.FormatStarRating()`
  const starInt = Math.trunc(stars);

  if (starInt === 0) return [new StarDifficultyGroupDefinition(0, 'Below 1 Star', 0)];
  if (starInt < 15) return [new StarDifficultyGroupDefinition(starInt, `${starInt} Star${starInt === 1 ? '' : 's'}`, starInt)];
  return [new StarDifficultyGroupDefinition(15, 'Over 15 Stars', 15)];
}

function defineGroupByLength(length: number): GroupDefinition[] {
  for (let i = 1; i < 6; i++) {
    if (length <= i * 60_000) return [new GroupDefinition(i, `${i} minute${i === 1 ? '' : 's'} or less`)];
  }

  if (length <= 10 * 60_000) return [new GroupDefinition(10, '10 minutes or less')];

  return [new GroupDefinition(11, 'Over 10 minutes')];
}

function defineGroupBySource(source: string): GroupDefinition[] {
  if (!source) return [new GroupDefinition(1, 'Unsourced')];
  return [new GroupDefinition(0, source)];
}

// ---------------------------------------------------------------- ManiaFilterCriteria

/** osu.Game.Rulesets.Mania/ManiaFilterCriteria.cs */
export class ManiaFilterCriteria implements RulesetFilterCriteria {
  // using `2 * MAX_STAGE_KEYS` here, as it is achievable by engaging key mods (Dual Stages + 10K)
  private readonly includedKeyCounts = new Set(Array.from({ length: 2 * MAX_STAGE_KEYS }, (_, i) => i + 1));
  private readonly longNotePercentage = new OptionalRange();

  static keyCountFor(beatmap: FilterBeatmap, mods: readonly string[] | null): number {
    const keyMod = mods?.map(m => /^(\d+)K$/.exec(m)).find(Boolean);
    return ManiaBeatmapConverter.getColumnCount(
      {
        sourceRulesetId: beatmap.ruleset.onlineId,
        drainRate: Math.fround(beatmap.drainRate),
        approachRate: Math.fround(beatmap.approachRate),
        circleSize: Math.fround(beatmap.circleSize),
        overallDifficulty: Math.fround(beatmap.overallDifficulty),
        endTimeObjectCount: beatmap.endTimeObjectCount,
        totalObjectCount: beatmap.totalObjectCount,
      },
      keyMod ? parseInt(keyMod[1], 10) : null,
    );
  }

  matches(beatmap: FilterBeatmap, criteria: FilterCriteria): boolean {
    const keyCount = ManiaFilterCriteria.keyCountFor(beatmap, criteria.mods);

    const keyCountMatch = this.includedKeyCounts.has(keyCount);
    const longNotePercentageMatch = !this.longNotePercentage.hasFilter || (beatmap.ruleset.shortName === 'mania' && this.longNotePercentage.isInRange(calculateLongNotePercentage(beatmap)));

    return keyCountMatch && longNotePercentageMatch;
  }

  tryParseCustomKeywordCriteria(key: string, op: Operator, strValues: string): boolean {
    switch (key) {
      case 'key':
      case 'keys': {
        const keyCounts = new Set<number>();

        for (const strValue of strValues.split(',')) {
          const m = /^\s*([+-]?\d+)\s*$/.exec(strValue);
          if (!m) return false;
          keyCounts.add(parseInt(m[1], 10));
        }

        const singleKeyCount = keyCounts.size === 1 ? [...keyCounts][0] : null;
        const removeWhere = (pred: (k: number) => boolean) => {
          for (const k of [...this.includedKeyCounts]) if (pred(k)) this.includedKeyCounts.delete(k);
        };

        switch (op) {
          case Operator.Equal:
            removeWhere(k => !keyCounts.has(k));
            return true;

          case Operator.NotEqual:
            removeWhere(k => keyCounts.has(k));
            return true;

          case Operator.Less:
            if (singleKeyCount == null) return false;
            removeWhere(k => k >= singleKeyCount);
            return true;

          case Operator.LessOrEqual:
            if (singleKeyCount == null) return false;
            removeWhere(k => k > singleKeyCount);
            return true;

          case Operator.Greater:
            if (singleKeyCount == null) return false;
            removeWhere(k => k <= singleKeyCount);
            return true;

          case Operator.GreaterOrEqual:
            if (singleKeyCount == null) return false;
            removeWhere(k => k < singleKeyCount);
            return true;

          default:
            return false;
        }
      }

      case 'ln':
      case 'lns':
        return tryUpdateCriteriaRangeFloat(this.longNotePercentage, op, strValues);
    }

    return false;
  }

  filterMayChangeFromMods(criteria: FilterCriteria, oldMods: readonly string[], newMods: readonly string[]): boolean {
    if (this.includedKeyCounts.size !== 2 * MAX_STAGE_KEYS || criteria.group === GroupMode.Variant) {
      const keyMods = (m: readonly string[]) =>
        m
          .filter(a => /^\d+K$/.test(a))
          .sort()
          .join(',');
      if (keyMods(oldMods) !== keyMods(newMods)) return true;
    }
    return false;
  }
}

function calculateLongNotePercentage(beatmap: FilterBeatmap): number {
  const holdNotes = beatmap.endTimeObjectCount;
  const totalNotes = Math.max(1, beatmap.totalObjectCount);
  return Math.fround(Math.fround(holdNotes / totalNotes) * 100);
}

/** Ruleset.CreateRulesetFilterCriteria() */
export function createRulesetFilterCriteria(rulesetShortName: string): RulesetFilterCriteria | null {
  return rulesetShortName === 'mania' ? new ManiaFilterCriteria() : null;
}
