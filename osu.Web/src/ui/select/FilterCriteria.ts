// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game/Screens/Select/FilterCriteria.cs, Filter/Operator.cs, Filter/SortMode.cs, Filter/GroupMode.cs,
// osu.Game/Beatmaps/BeatmapOnlineStatus.cs and osu.Game/Rulesets/Filter/IRulesetFilterCriteria.cs.

/** Filter/Operator.cs */
export enum Operator {
  Less,
  LessOrEqual,
  Equal,
  NotEqual,
  GreaterOrEqual,
  Greater,
}

/** Filter/SortMode.cs */
export enum SortMode {
  Artist,
  Author,
  BPM,
  DateAdded,
  DateRanked,
  DateSubmitted,
  Difficulty,
  LastPlayed,
  Length,
  Source,
  Title,
}

export const SORT_MODE_NAMES: Record<SortMode, string> = {
  [SortMode.Artist]: 'Artist',
  [SortMode.Author]: 'Author',
  [SortMode.BPM]: 'BPM',
  [SortMode.DateAdded]: 'Date Added',
  [SortMode.DateRanked]: 'Date Ranked',
  [SortMode.DateSubmitted]: 'Date Submitted',
  [SortMode.Difficulty]: 'Difficulty',
  [SortMode.LastPlayed]: 'Last Played',
  [SortMode.Length]: 'Length',
  [SortMode.Source]: 'Source',
  [SortMode.Title]: 'Title',
};

/** Filter/GroupMode.cs */
export enum GroupMode {
  None,
  Artist,
  Author,
  BPM,
  Collections,
  DateAdded,
  DateRanked,
  Difficulty,
  Favourites,
  LastPlayed,
  Length,
  MyMaps,
  RankAchieved,
  RankedStatus,
  Source,
  Title,
  Variant,
}

export const GROUP_MODE_NAMES: Record<GroupMode, string> = {
  [GroupMode.None]: 'None',
  [GroupMode.Artist]: 'Artist',
  [GroupMode.Author]: 'Author',
  [GroupMode.BPM]: 'BPM',
  [GroupMode.Collections]: 'Collections',
  [GroupMode.DateAdded]: 'Date Added',
  [GroupMode.DateRanked]: 'Date Ranked',
  [GroupMode.Difficulty]: 'Difficulty',
  [GroupMode.Favourites]: 'Favourites',
  [GroupMode.LastPlayed]: 'Last Played',
  [GroupMode.Length]: 'Length',
  [GroupMode.MyMaps]: 'My Maps',
  [GroupMode.RankAchieved]: 'Rank Achieved',
  [GroupMode.RankedStatus]: 'Ranked Status',
  [GroupMode.Source]: 'Source',
  [GroupMode.Title]: 'Title',
  [GroupMode.Variant]: 'Variant',
};

/** BeatmapOnlineStatus.cs */
export enum BeatmapOnlineStatus {
  LocallyModified = -4,
  None = -3,
  Graveyard = -2,
  WIP = -1,
  Pending = 0,
  Ranked = 1,
  Approved = 2,
  Qualified = 3,
  Loved = 4,
}

export const ONLINE_STATUS_NAMES: Record<BeatmapOnlineStatus, string> = {
  [BeatmapOnlineStatus.LocallyModified]: 'Locally Modified',
  [BeatmapOnlineStatus.None]: 'Unknown',
  [BeatmapOnlineStatus.Graveyard]: 'Graveyard',
  [BeatmapOnlineStatus.WIP]: 'WIP',
  [BeatmapOnlineStatus.Pending]: 'Pending',
  [BeatmapOnlineStatus.Ranked]: 'Ranked',
  [BeatmapOnlineStatus.Approved]: 'Approved',
  [BeatmapOnlineStatus.Qualified]: 'Qualified',
  [BeatmapOnlineStatus.Loved]: 'Loved',
};

/**
 * `Enum.GetValues<BeatmapOnlineStatus>()` / `Enum.GetNames`: .NET orders enum members by the *unsigned* magnitude of their value,
 * so negative members come last. This matters for prefix matching (`status=l` resolves to Loved, not LocallyModified).
 */
export const ONLINE_STATUS_ENUM_ORDER: readonly { name: string; value: BeatmapOnlineStatus }[] = [
  { name: 'Pending', value: BeatmapOnlineStatus.Pending },
  { name: 'Ranked', value: BeatmapOnlineStatus.Ranked },
  { name: 'Approved', value: BeatmapOnlineStatus.Approved },
  { name: 'Qualified', value: BeatmapOnlineStatus.Qualified },
  { name: 'Loved', value: BeatmapOnlineStatus.Loved },
  { name: 'LocallyModified', value: BeatmapOnlineStatus.LocallyModified },
  { name: 'None', value: BeatmapOnlineStatus.None },
  { name: 'Graveyard', value: BeatmapOnlineStatus.Graveyard },
  { name: 'WIP', value: BeatmapOnlineStatus.WIP },
];

/** DateTimeOffset.MinValue / MaxValue (0001-01-01 / 9999-12-31T23:59:59.9999999) as epoch milliseconds. */
export const DATE_MIN = -62135596800000;
export const DATE_MAX = 253402300799999;

/** A ruleset reference as far as filtering is concerned (RulesetInfo.ShortName / OnlineID). */
export interface FilterRuleset {
  shortName: string;
  onlineId: number;
}

/**
 * The beatmap model used by the carousel filters (the subset of lazer's BeatmapInfo / BeatmapSetInfo that filtering, sorting and
 * grouping read). Built from the stored BeatmapEntry by `CarouselModel.ts`.
 */
export interface FilterBeatmap {
  /** Unique id of this difficulty (beatmap hash). */
  readonly id: string;
  readonly set: FilterBeatmapSet;
  ruleset: FilterRuleset;
  onlineId: number;
  difficultyName: string;
  metadata: FilterMetadata;
  /** Stored (native ruleset, nomod) star rating. */
  starRating: number;
  approachRate: number;
  drainRate: number;
  circleSize: number;
  overallDifficulty: number;
  /** Playable length in milliseconds. */
  length: number;
  bpm: number;
  beatDivisor: number;
  status: BeatmapOnlineStatus;
  /** Epoch milliseconds, or null if never played. */
  lastPlayed: number | null;
  hidden: boolean;
  md5Hash: string;
  endTimeObjectCount: number;
  totalObjectCount: number;
}

export interface FilterMetadata {
  title: string;
  titleUnicode: string;
  artist: string;
  artistUnicode: string;
  author: string;
  source: string;
  tags: string;
  userTags: string[];
}

export interface FilterBeatmapSet {
  readonly id: string;
  onlineId: number;
  /** Set-level metadata (lazer's BeatmapSetInfo.Metadata is that of the first difficulty). */
  metadata: FilterMetadata;
  status: BeatmapOnlineStatus;
  dateAdded: number;
  dateRanked: number | null;
  dateSubmitted: number | null;
  beatmaps: FilterBeatmap[];
}

/** FilterCriteria.MatchMode */
export enum MatchMode {
  /** Match using a simple "contains" substring match. */
  Substring,
  /** Match for the search phrase being isolated by spaces, or at the start or end of the text. */
  IsolatedPhrase,
  /** Match for the search phrase matching the full text in completion. */
  FullPhrase,
}

/** FilterCriteria.OptionalSet<T> (for BeatmapOnlineStatus). */
export class OptionalSet<T extends number> {
  readonly values: Set<T>;

  constructor(all: readonly T[]) {
    this.values = new Set(all);
  }

  get hasFilter(): boolean {
    return true;
  }

  isInRange(value: T): boolean {
    return this.values.has(value);
  }
}

/** FilterCriteria.OptionalRange<T> for numeric (float / double / int / DateTimeOffset-as-epoch-ms) values. */
export class OptionalRange {
  min: number | null = null;
  max: number | null = null;
  isLowerInclusive = false;
  isUpperInclusive = false;
  /** When true, the meaning of this filter is inverted, i.e. it will exclude items that satisfy this range. */
  invertRange = false;

  constructor(init?: Partial<Pick<OptionalRange, 'min' | 'max' | 'isLowerInclusive' | 'isUpperInclusive' | 'invertRange'>>) {
    if (init) Object.assign(this, init);
  }

  get hasFilter(): boolean {
    return this.max != null || this.min != null;
  }

  isInRange(value: number): boolean {
    let lowerRangeSatisfied = true;
    let upperRangeSatisfied = true;

    if (this.min != null) {
      const comparison = compare(value, this.min);
      lowerRangeSatisfied = comparison > 0 || (comparison === 0 && this.isLowerInclusive);
    }

    if (this.max != null) {
      const comparison = compare(value, this.max);
      upperRangeSatisfied = comparison < 0 || (comparison === 0 && this.isUpperInclusive);
    }

    let result = lowerRangeSatisfied && upperRangeSatisfied;
    if (this.invertRange) result = !result;
    return result;
  }

  equals(other: OptionalRange): boolean {
    return this.min === other.min && this.max === other.max && this.isLowerInclusive === other.isLowerInclusive && this.isUpperInclusive === other.isUpperInclusive;
  }
}

/** Comparer<double>.Default.Compare (NaN sorts before every other value). */
function compare(a: number, b: number): number {
  if (a < b) return -1;
  if (a > b) return 1;
  if (a === b) return 0;
  const an = Number.isNaN(a);
  const bn = Number.isNaN(b);
  return an && bn ? 0 : an ? -1 : 1;
}

// .NET's \w is [\p{L}\p{Mn}\p{Nd}\p{Pc}] and \b is Unicode-aware; JS's are ASCII-only, so build the equivalents explicitly.
const WORD = '[\\p{L}\\p{Mn}\\p{Nd}\\p{Pc}]';
const WORD_BOUNDARY = `(?:(?<=${WORD})(?!${WORD})|(?<!${WORD})(?=${WORD}))`;

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');

/** FilterCriteria.OptionalTextFilter */
export class OptionalTextFilter {
  /** When true, the meaning of this filter is inverted, i.e. it will exclude items which match the search term. */
  excludeTerm = false;
  private _matchMode = MatchMode.Substring;
  private _searchTerm = '';
  private upperTerm = '';
  private isolatedRegex: RegExp | null = null;

  constructor(init?: { searchTerm?: string; excludeTerm?: boolean }) {
    if (init?.searchTerm !== undefined) this.searchTerm = init.searchTerm;
    if (init?.excludeTerm !== undefined) this.excludeTerm = init.excludeTerm;
  }

  get hasFilter(): boolean {
    return this._searchTerm.length > 0;
  }

  get matchMode(): MatchMode {
    return this._matchMode;
  }

  get searchTerm(): string {
    return this._searchTerm;
  }

  set searchTerm(value: string) {
    let term = value;

    if (term.startsWith('"')) {
      // length check ensures that the quote character in the `startsWith()` check above and the `endsWith()` check below is not the same character.
      if (term.endsWith('"!') && term.length >= 3) {
        term = trimChars(trimEndChars(term, '!'), '"');
        this._matchMode = MatchMode.FullPhrase;
      } else {
        term = trimChars(term, '"');
        this._matchMode = MatchMode.IsolatedPhrase;
      }
    } else this._matchMode = MatchMode.Substring;

    this._searchTerm = term;
    this.upperTerm = term.toUpperCase();
    this.isolatedRegex = null;
  }

  matches(value: string | null | undefined): boolean {
    if (!this.hasFilter) return true;

    // search term is guaranteed to be non-empty, so if the string we're comparing is empty, it's not matching
    if (!value) return this.excludeTerm;

    let result: boolean;

    switch (this._matchMode) {
      default:
      case MatchMode.Substring:
        // Ordinal ignore-case "contains".
        result = value.toUpperCase().includes(this.upperTerm);
        break;

      case MatchMode.IsolatedPhrase:
        this.isolatedRegex ??= new RegExp(`(?:^|${WORD_BOUNDARY})${escapeRegex(this._searchTerm)}(?:$|${WORD_BOUNDARY})`, 'iu');
        result = this.isolatedRegex.test(value);
        break;

      case MatchMode.FullPhrase:
        result = value.length === this._searchTerm.length && value.toUpperCase() === this.upperTerm;
        break;
    }

    if (this.excludeTerm) result = !result;

    return result;
  }

  equals(other: OptionalTextFilter): boolean {
    return this._searchTerm === other._searchTerm;
  }
}

export function trimChars(s: string, chars: string): string {
  return trimEndChars(trimStartChars(s, chars), chars);
}

export function trimStartChars(s: string, chars: string): string {
  let i = 0;
  while (i < s.length && chars.includes(s[i])) i++;
  return s.slice(i);
}

export function trimEndChars(s: string, chars: string): string {
  let i = s.length;
  while (i > 0 && chars.includes(s[i - 1])) i--;
  return s.slice(0, i);
}

/** IRulesetFilterCriteria */
export interface RulesetFilterCriteria {
  /** Checks whether the beatmap satisfies ruleset-specific custom criteria. */
  matches(beatmap: FilterBeatmap, criteria: FilterCriteria): boolean;
  /** Attempts to parse a single custom keyword criterion `{key}{op}{value}`. */
  tryParseCustomKeywordCriteria(key: string, op: Operator, value: string): boolean;
  /** Whether to reapply the filter as a result of the given change in applied mods. */
  filterMayChangeFromMods(criteria: FilterCriteria, oldMods: readonly string[], newMods: readonly string[]): boolean;
}

const ALL_STATUSES = ONLINE_STATUS_ENUM_ORDER.map(s => s.value);

/** FilterCriteria */
export class FilterCriteria {
  group = GroupMode.None;
  sort = SortMode.Title;

  selectedBeatmapSet: FilterBeatmapSet | null = null;

  starDifficulty = new OptionalRange();
  approachRate = new OptionalRange();
  drainRate = new OptionalRange();
  circleSize = new OptionalRange();
  overallDifficulty = new OptionalRange();
  length = new OptionalRange();
  bpm = new OptionalRange();
  beatDivisor = new OptionalRange();
  onlineStatus = new OptionalSet<BeatmapOnlineStatus>(ALL_STATUSES);
  lastPlayed = new OptionalRange();
  dateRanked = new OptionalRange();
  dateSubmitted = new OptionalRange();
  creator = new OptionalTextFilter();
  artist = new OptionalTextFilter();
  title = new OptionalTextFilter();
  difficultyName = new OptionalTextFilter();
  source = new OptionalTextFilter();
  userTags: OptionalTextFilter[] = [];

  userStarDifficulty = new OptionalRange({ isLowerInclusive: true, isUpperInclusive: true });

  searchTerms: OptionalTextFilter[] = [];

  ruleset: FilterRuleset | null = null;
  /** Selected mod acronyms. */
  mods: readonly string[] | null = null;
  allowConvertedBeatmaps = false;
  beatmapSetId: number | null = null;

  hasOnlineId: boolean | null = null;

  /** Hashes from the collection to filter to. */
  collectionBeatmapMD5Hashes: ReadonlySet<string> | null = null;

  rulesetCriteria: RulesetFilterCriteria | null = null;

  localUserId: number | null = null;
  localUserUsername: string | null = null;

  /** `searchText` as a number (if it can be parsed as one). */
  searchNumber: number | null = null;

  private _searchText = '';

  get searchText(): string {
    return this._searchText;
  }

  set searchText(value: string) {
    this._searchText = value;

    const terms: OptionalTextFilter[] = [];

    let remainingText = value;

    // Match either an open difficulty tag to the end of string,
    // or match a closed one with a whitespace after it.
    //
    // To keep things simple, the closing ']' may be included in the match group,
    // and is trimmed post-match.
    for (const quotedSegment of value.matchAll(/(^|\s)\[(.*)(\]\s|$)/g)) {
      this.difficultyName = new OptionalTextFilter({ searchTerm: trimChars(quotedSegment[2], ']') });
      remainingText = remainingText.split(quotedSegment[0]).join('');
    }

    // First handle quoted segments to ensure we keep inline spaces in exact matches.
    for (const quotedSegment of value.matchAll(/("[^"]+"[!]?)/g)) {
      terms.push(new OptionalTextFilter({ searchTerm: quotedSegment[0] }));
      remainingText = remainingText.split(quotedSegment[0]).join('');
    }

    // Then handle the rest splitting on any spaces.
    for (const s of remainingText.split(' ')) if (s.length > 0) terms.push(new OptionalTextFilter({ searchTerm: s }));

    this.searchTerms = terms;

    this.searchNumber = null;

    if (this.searchTerms.length === 1) {
      const parsed = tryParseInt32(this.searchTerms[0].searchTerm);
      if (parsed != null) this.searchNumber = parsed;
    }
  }

  /** Given a new filter criteria, decide whether a full sort needs to be performed. */
  requiresSorting(newCriteria: FilterCriteria): boolean {
    if (this.sort !== newCriteria.sort) return true;

    switch (this.sort) {
      // Some sorts are stable across all other changes.
      case SortMode.Artist:
      case SortMode.Author:
      case SortMode.DateSubmitted:
      case SortMode.DateAdded:
      case SortMode.DateRanked:
      case SortMode.Source:
      case SortMode.Title:
        return false;

      // Some sorts use aggregate max comparisons, which will change based on filtered items.
      case SortMode.LastPlayed:
      case SortMode.BPM:
      case SortMode.Length:
      case SortMode.Difficulty:
        return true;
    }
  }
}

/** int.TryParse(s) with the default NumberStyles.Integer (whitespace + leading sign allowed). */
export function tryParseInt32(s: string): number | null {
  const m = /^\s*([+-]?\d+)\s*$/.exec(s);
  if (!m) return null;
  const v = Number(m[1]);
  if (!Number.isSafeInteger(v) || v < -2147483648 || v > 2147483647) return null;
  return v;
}
