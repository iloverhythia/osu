// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game/Screens/Select/FilterQueryParser.cs: parsing of song select filter queries entered via the search box.

import {
  BeatmapOnlineStatus,
  DATE_MAX,
  DATE_MIN,
  FilterCriteria,
  ONLINE_STATUS_ENUM_ORDER,
  Operator,
  OptionalRange,
  OptionalSet,
  OptionalTextFilter,
  trimEndChars,
} from './FilterCriteria';

// .NET \w / \b are Unicode-aware.
const W = '[\\p{L}\\p{Mn}\\p{Nd}\\p{Pc}]';
const B = `(?:(?<=${W})(?!${W})|(?<!${W})(?=${W}))`;
const QUERY_SYNTAX = new RegExp(`${B}(?<key>${W}+)(?<op>(!?(:|=)|(>|<)(:|=)?))(?<value>(".*?"[!]?)|(\\S*))`, 'giu');

/** Thrown where .NET's DateTimeOffset arithmetic would throw ArgumentOutOfRangeException. */
class OutOfRangeError extends Error {}

export function applyQueries(criteria: FilterCriteria, query: string): void {
  try {
    for (const match of [...query.matchAll(QUERY_SYNTAX)]) {
      const key = match.groups!.key.toLowerCase();
      const op = parseOperator(match.groups!.op);
      const value = match.groups!.value;

      if (tryParseKeywordCriteria(criteria, key, value, op)) query = query.split(match[0]).join('');
    }
  } catch (e) {
    console.warn(`Failed to parse query (${e instanceof Error ? e.message : String(e)})`);
  }

  criteria.searchText = query;
}

function tryParseKeywordCriteria(criteria: FilterCriteria, key: string, value: string, op: Operator): boolean {
  switch (key) {
    case 'star':
    case 'stars':
    case 'sr':
      return tryUpdateCriteriaRangeDouble(criteria.starDifficulty, op, value, 0);

    case 'ar':
      return tryUpdateCriteriaRangeFloat(criteria.approachRate, op, value);

    case 'dr':
    case 'hp':
      return tryUpdateCriteriaRangeFloat(criteria.drainRate, op, value);

    case 'cs':
      return tryUpdateCriteriaRangeFloat(criteria.circleSize, op, value);

    case 'od':
      return tryUpdateCriteriaRangeFloat(criteria.overallDifficulty, op, value);

    case 'bpm':
      return tryUpdateCriteriaRangeDouble(criteria.bpm, op, value, Math.fround(0.5));

    case 'length':
      return tryUpdateLengthRange(criteria, op, value);

    case 'lastplayed':
      return tryUpdateDateAgoRange(criteria.lastPlayed, op, value);

    case 'ranked':
      return tryUpdateRankedDateRange(criteria.dateRanked, op, value);

    case 'created':
    case 'submitted':
      return tryUpdateRankedDateRange(criteria.dateSubmitted, op, value);

    case 'played': {
      let played = tryParseBool(value);
      if (played == null) return false;

      // Unplayed beatmaps are filtered on DateTimeOffset.MinValue.
      if (op === Operator.NotEqual) played = !played;

      if (played) {
        criteria.lastPlayed.min = DATE_MIN;
        criteria.lastPlayed.max = DATE_MAX;
        criteria.lastPlayed.isLowerInclusive = false;
      } else {
        criteria.lastPlayed.min = DATE_MIN;
        criteria.lastPlayed.max = DATE_MIN;
        criteria.lastPlayed.isLowerInclusive = true;
        criteria.lastPlayed.isUpperInclusive = true;
      }

      return true;
    }

    case 'divisor':
      return tryUpdateCriteriaRangeParsed(criteria.beatDivisor, op, value, tryParseIntNone);

    case 'status':
      return tryUpdateCriteriaSet(criteria.onlineStatus, op, value);

    case 'creator':
    case 'author':
    case 'mapper':
      return tryUpdateCriteriaText(criteria.creator, op, value);

    case 'artist':
      return tryUpdateCriteriaText(criteria.artist, op, value);

    case 'title':
      return tryUpdateCriteriaText(criteria.title, op, value);

    case 'diff':
      return tryUpdateCriteriaText(criteria.difficultyName, op, value);

    case 'source':
      return tryUpdateCriteriaText(criteria.source, op, value);

    case 'tag': {
      const tagFilter = new OptionalTextFilter();
      tryUpdateCriteriaText(tagFilter, op, value);
      criteria.userTags.push(tagFilter);
      return true;
    }

    default:
      return criteria.rulesetCriteria?.tryParseCustomKeywordCriteria(key, op, value) ?? false;
  }
}

function parseOperator(value: string): Operator {
  switch (value) {
    case '=':
    case ':':
      return Operator.Equal;

    case '!=':
    case '!:':
      return Operator.NotEqual;

    case '<':
      return Operator.Less;

    case '<=':
    case '<:':
      return Operator.LessOrEqual;

    case '>':
      return Operator.Greater;

    case '>=':
    case '>:':
      return Operator.GreaterOrEqual;

    default:
      throw new Error(`Unsupported operator ${value}`);
  }
}

function getLengthScale(value: string): number {
  return value.endsWith('ms') ? 1 : value.endsWith('s') ? 1000 : value.endsWith('m') ? 60000 : value.endsWith('h') ? 3600000 : 1000;
}

/** double.TryParse(value, NumberStyles.AllowDecimalPoint, InvariantCulture): digits with an optional decimal point only. */
function tryParseDoubleWithPoint(value: string): number | null {
  if (!/^(\d+\.?\d*|\.\d+)$/.test(value)) return null;
  return parseFloat(value);
}

function tryParseFloatWithPoint(value: string): number | null {
  const v = tryParseDoubleWithPoint(value);
  return v == null ? null : Math.fround(v);
}

/** int.TryParse(value, NumberStyles.None, InvariantCulture). */
function tryParseIntNone(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const v = Number(value);
  return v > 2147483647 ? null : v;
}

function tryParseBool(value: string): boolean | null {
  switch (value) {
    case '1':
    case 'yes':
      return true;

    case '0':
    case 'no':
      return false;

    default: {
      // bool.TryParse: case-insensitive "true"/"false", surrounding whitespace allowed.
      const t = value.trim().toLowerCase();
      if (t === 'true') return true;
      if (t === 'false') return false;
      return null;
    }
  }
}

/** Enum.TryParse (exact, case-insensitive, or numeric) followed by a prefix match over Enum.GetNames. */
function tryParseStatus(value: string): BeatmapOnlineStatus | null {
  const trimmed = value.trim();
  if (/^[+-]?\d+$/.test(trimmed)) return Number(trimmed) as BeatmapOnlineStatus;

  const exact = ONLINE_STATUS_ENUM_ORDER.find(s => s.name.toLowerCase() === trimmed.toLowerCase());
  if (exact) return exact.value;

  const prefix = ONLINE_STATUS_ENUM_ORDER.find(s => s.name.toLowerCase().startsWith(value.toLowerCase()));
  return prefix ? prefix.value : null;
}

function tryMatchRegex(value: string, regex: RegExp): Record<string, string | undefined> | null {
  const m = regex.exec(value);
  return m ? (m.groups ?? {}) : null;
}

/**
 * Attempts to parse a keyword filter with the specified `op` and textual `value`.
 * Only Equal (and NotEqual, which sets `excludeTerm`) are valid for textual filters.
 */
export function tryUpdateCriteriaText(textFilter: OptionalTextFilter, op: Operator, value: string): boolean {
  switch (op) {
    case Operator.NotEqual:
      textFilter.excludeTerm = true;
      textFilter.searchTerm = value;
      return true;

    case Operator.Equal:
      textFilter.searchTerm = value;
      return true;

    default:
      return false;
  }
}

/** TryUpdateCriteriaRange(ref OptionalRange&lt;float&gt;, ...): all arithmetic in single precision. */
export function tryUpdateCriteriaRangeFloat(range: OptionalRange, op: Operator, val: string, tolerance = 0.05): boolean {
  const value = tryParseFloatWithPoint(val);
  if (value == null) return false;

  const f = Math.fround;
  const tol = f(tolerance);
  range.invertRange = false;

  switch (op) {
    default:
      return false;

    case Operator.NotEqual:
    case Operator.Equal:
      if (op === Operator.NotEqual) range.invertRange = true;
      range.min = f(value - tol);
      range.max = f(value + tol);
      if (tol === 0) range.isLowerInclusive = range.isUpperInclusive = true;
      break;

    case Operator.Greater:
      range.min = f(value + tol);
      break;

    case Operator.GreaterOrEqual:
      range.min = f(value - tol);
      break;

    case Operator.Less:
      range.max = f(value - tol);
      break;

    case Operator.LessOrEqual:
      range.max = f(value + tol);
      break;
  }

  return true;
}

/** TryUpdateCriteriaRange(ref OptionalRange&lt;double&gt;, ...). */
export function tryUpdateCriteriaRangeDouble(range: OptionalRange, op: Operator, val: string, tolerance = 0.05): boolean {
  const value = tryParseDoubleWithPoint(val);
  return value != null && updateDoubleRange(range, op, value, tolerance);
}

function updateDoubleRange(range: OptionalRange, op: Operator, value: number, tolerance: number): boolean {
  range.invertRange = false;

  switch (op) {
    default:
      return false;

    case Operator.NotEqual:
    case Operator.Equal:
      if (op === Operator.NotEqual) range.invertRange = true;
      range.min = value - tolerance;
      range.max = value + tolerance;
      if (tolerance === 0) range.isLowerInclusive = range.isUpperInclusive = true;
      break;

    case Operator.Greater:
      range.min = value + tolerance;
      break;

    case Operator.GreaterOrEqual:
      range.min = value - tolerance;
      if (tolerance === 0) range.isLowerInclusive = true;
      break;

    case Operator.Less:
      range.max = value - tolerance;
      break;

    case Operator.LessOrEqual:
      range.max = value + tolerance;
      if (tolerance === 0) range.isUpperInclusive = true;
      break;
  }

  return true;
}

/** TryUpdateCriteriaRange&lt;T&gt; with a custom parse function. */
export function tryUpdateCriteriaRangeParsed(range: OptionalRange, op: Operator, val: string, parse: (s: string) => number | null): boolean {
  const converted = parse(val);
  return converted != null && updateGenericRange(range, op, converted);
}

/** TryUpdateCriteriaSet&lt;BeatmapOnlineStatus&gt; */
export function tryUpdateCriteriaSet(range: OptionalSet<BeatmapOnlineStatus>, op: Operator, filterValue: string): boolean {
  const matchingValues = new Set<BeatmapOnlineStatus>();
  const allDefinedValues = ONLINE_STATUS_ENUM_ORDER.map(s => s.value);

  if (filterValue.includes(',')) {
    const splitValues = filterValue
      .split(',')
      .map(s => s.trim())
      .filter(s => s.length > 0);
    const parsedValues = new Set<BeatmapOnlineStatus>();

    for (const splitValue of splitValues) {
      const parsed = tryParseStatus(splitValue);
      if (parsed == null) return false;
      parsedValues.add(parsed);
    }

    if (op === Operator.Equal) {
      for (const v of parsedValues) matchingValues.add(v);
    } else if (op === Operator.NotEqual) {
      for (const v of allDefinedValues) if (!parsedValues.has(v)) matchingValues.add(v);
    } else return false;
  } else {
    const pivotValue = tryParseStatus(filterValue);
    if (pivotValue == null) return false;

    for (const val of allDefinedValues) {
      const compareResult = Math.sign(val - pivotValue);

      switch (op) {
        case Operator.Less:
          if (compareResult < 0) matchingValues.add(val);
          break;

        case Operator.LessOrEqual:
          if (compareResult <= 0) matchingValues.add(val);
          break;

        case Operator.Equal:
          if (compareResult === 0) matchingValues.add(val);
          break;

        case Operator.GreaterOrEqual:
          if (compareResult >= 0) matchingValues.add(val);
          break;

        case Operator.Greater:
          if (compareResult > 0) matchingValues.add(val);
          break;

        case Operator.NotEqual:
          if (compareResult !== 0) matchingValues.add(val);
          break;

        default:
          return false;
      }
    }
  }

  for (const v of [...range.values]) if (!matchingValues.has(v)) range.values.delete(v);
  return true;
}

function updateGenericRange(range: OptionalRange, op: Operator, value: number): boolean {
  switch (op) {
    default:
      return false;

    case Operator.NotEqual:
    case Operator.Equal:
      if (op === Operator.NotEqual) range.invertRange = true;
      range.isLowerInclusive = range.isUpperInclusive = true;
      range.min = value;
      range.max = value;
      break;

    case Operator.Greater:
      range.isLowerInclusive = false;
      range.min = value;
      break;

    case Operator.GreaterOrEqual:
      range.isLowerInclusive = true;
      range.min = value;
      break;

    case Operator.Less:
      range.isUpperInclusive = false;
      range.max = value;
      break;

    case Operator.LessOrEqual:
      range.isUpperInclusive = true;
      range.max = value;
      break;
  }

  return true;
}

function tryUpdateLengthRange(criteria: FilterCriteria, op: Operator, val: string): boolean {
  const parts: string[] = [];

  let match: Record<string, string | undefined> | null = null;

  match ??= tryMatchRegex(val, /^((?<hours>\d+):)?(?<minutes>\d+):(?<seconds>\d+)$/);
  match ??= tryMatchRegex(val, /^((?<hours>\d+(\.\d+)?)h)?((?<minutes>\d+(\.\d+)?)m)?((?<seconds>\d+(\.\d+)?)s)?$/);
  match ??= tryMatchRegex(val, /^(?<seconds>\d+(\.\d+)?)$/);

  if (match == null) return false;

  if (match.seconds !== undefined) parts.push(match.seconds + 's');
  if (match.minutes !== undefined) parts.push(match.minutes + 'm');
  if (match.hours !== undefined) parts.push(match.hours + 'h');

  let totalLength = 0;
  let minScale = 3600000;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const partNoUnit = trimEndChars(part, 'msh');
    const length = tryParseDoubleWithPoint(partNoUnit);
    if (length == null) return false;

    if (i !== parts.length - 1 && length >= 60) return false;
    if (i !== 0 && partNoUnit.includes('.')) return false;

    const scale = getLengthScale(part);
    totalLength += length * scale;
    minScale = Math.min(minScale, scale);
  }

  return updateDoubleRange(criteria.length, op, totalLength, minScale / 2.0);
}

// ---------------------------------------------------------------- DateTimeOffset arithmetic (.NET semantics)

const MS_PER_DAY = 86400000;

function checkDate(ms: number): number {
  if (!(ms >= DATE_MIN && ms <= 253402300799999)) throw new OutOfRangeError('date out of range');
  return ms;
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const daysInMonth = (year: number, month0: number): number => (month0 === 1 && isLeap(year) ? 29 : DAYS_IN_MONTH[month0]);
const isLeap = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** DateTimeOffset.AddMonths: clamps the day to the end of the target month. Operates on the date's own (local) calendar fields. */
function addMonthsLocal(ms: number, months: number): number {
  const d = new Date(ms);
  let year = d.getFullYear();
  let month = d.getMonth() + months;
  year += Math.floor(month / 12);
  month = ((month % 12) + 12) % 12;
  if (year < 1 || year > 9999) throw new OutOfRangeError('year out of range');
  const day = Math.min(d.getDate(), daysInMonth(year, month));
  const out = new Date(d.getTime());
  out.setFullYear(year, month, day);
  return checkDate(out.getTime());
}

function addMonthsUtc(ms: number, months: number): number {
  const d = new Date(ms);
  let year = d.getUTCFullYear();
  let month = d.getUTCMonth() + months;
  year += Math.floor(month / 12);
  month = ((month % 12) + 12) % 12;
  if (year < 1 || year > 9999) throw new OutOfRangeError('year out of range');
  const day = Math.min(d.getUTCDate(), daysInMonth(year, month));
  const out = new Date(d.getTime());
  out.setUTCFullYear(year, month, day);
  return checkDate(out.getTime());
}

/** new DateTimeOffset(year, month, day, 0, 0, 0, TimeSpan.Zero), throwing on invalid components. */
function dateTimeOffsetFromDateOnly(year: number, month: number, day: number): number {
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month - 1)) throw new OutOfRangeError('invalid date');
  const d = new Date(0);
  d.setUTCFullYear(year, month - 1, day);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

/** This function is intended for parsing "days / months / years ago" type filters. */
function tryUpdateDateAgoRange(dateRange: OptionalRange, op: Operator, val: string): boolean {
  switch (op) {
    case Operator.NotEqual:
    case Operator.Equal:
      // an equality or inequality filter is difficult to define for support here, so refuse to support it.
      return false;

    // the value is an "ago" type value, so flip the operator: `>5d` means "more than five days ago", as in "*before* five days ago".
    case Operator.Less:
      op = Operator.Greater;
      break;

    case Operator.LessOrEqual:
      op = Operator.GreaterOrEqual;
      break;

    case Operator.Greater:
      op = Operator.Less;
      break;

    case Operator.GreaterOrEqual:
      op = Operator.LessOrEqual;
      break;
  }

  let match: Record<string, string | undefined> | null = null;

  match ??= tryMatchRegex(val, /^((?<years>\d+)y)?((?<months>\d+)M)?((?<days>\d+(\.\d+)?)d)?((?<hours>\d+(\.\d+)?)h)?((?<minutes>\d+(\.\d+)?)m)?((?<seconds>\d+(\.\d+)?)s)?$/);
  match ??= tryMatchRegex(val, /^(?<days>\d+(\.\d+)?)$/);

  if (match == null) return false;

  let dateTimeOffset: number | null = null;
  const now = Date.now();

  try {
    for (const key of ['seconds', 'minutes', 'hours', 'days', 'months', 'years'] as const) {
      const group = match[key];
      if (group === undefined) continue;

      const length = tryParseDoubleWithPoint(group);
      if (length == null) return false;

      const base = dateTimeOffset ?? now;

      switch (key) {
        case 'seconds':
          dateTimeOffset = checkDate(base - Math.round(length * 1000));
          break;

        case 'minutes':
          dateTimeOffset = checkDate(base - Math.round(length * 60000));
          break;

        case 'hours':
          dateTimeOffset = checkDate(base - Math.round(length * 3600000));
          break;

        case 'days':
          dateTimeOffset = checkDate(base - Math.round(length * MS_PER_DAY));
          break;

        case 'months':
          dateTimeOffset = addMonthsLocal(base, -Math.trunc(length));
          break;

        case 'years':
          dateTimeOffset = addMonthsLocal(base, -Math.trunc(length) * 12);
          break;
      }
    }
  } catch (e) {
    if (!(e instanceof OutOfRangeError)) throw e;
    dateTimeOffset = DATE_MIN + 1;
  }

  if (dateTimeOffset == null) return false;

  return updateGenericRange(dateRange, op, dateTimeOffset);
}

/**
 * Parses a ranked or submitted date filter. Accepted dates are in the formats `yyyy`, `yyyy-mm` and `yyyy-mm-dd`.
 * Leading zeros are accepted. Numbers can be separated by `-`, `/`, or `.`. UTC is used to stay consistent with osu!web.
 */
function tryUpdateRankedDateRange(dateRange: OptionalRange, op: Operator, val: string): boolean {
  const match = tryMatchRegex(val, /^(?<year>\d+)([-/.](?<month>\d+)([-/.](?<day>\d+))?)?$/);

  if (match == null) return false;

  let year: number | null = null;
  let month: number | null = null;
  let day: number | null = null;

  for (const key of ['year', 'month', 'day'] as const) {
    const group = match[key];
    if (group === undefined) continue;

    const value = tryParseDoubleWithPoint(group);
    if (value == null) return false;

    switch (key) {
      case 'year':
        year = Math.trunc(value);
        break;

      case 'month':
        month = Math.trunc(value);
        break;

      case 'day':
        day = Math.trunc(value);
        break;
    }
  }

  if (year == null) return false;

  const addDays = (ms: number, days: number) => checkDate(ms + days * MS_PER_DAY);

  try {
    dateRange.invertRange = false;

    switch (op) {
      case Operator.Less:
        month ??= 1;
        day ??= 1;
        return updateGenericRange(dateRange, op, dateTimeOffsetFromDateOnly(year, month, day));

      case Operator.LessOrEqual:
        if (month == null) return updateGenericRange(dateRange, Operator.Less, addMonthsUtc(dateTimeOffsetFromDateOnly(year, 1, 1), 12));
        if (day == null) return updateGenericRange(dateRange, Operator.Less, addMonthsUtc(dateTimeOffsetFromDateOnly(year, month, 1), 1));
        return updateGenericRange(dateRange, Operator.Less, addDays(dateTimeOffsetFromDateOnly(year, month, day), 1));

      case Operator.GreaterOrEqual:
        month ??= 1;
        day ??= 1;
        return updateGenericRange(dateRange, op, dateTimeOffsetFromDateOnly(year, month, day));

      case Operator.Greater:
        if (month == null) return updateGenericRange(dateRange, Operator.GreaterOrEqual, addMonthsUtc(dateTimeOffsetFromDateOnly(year, 1, 1), 12));
        if (day == null) return updateGenericRange(dateRange, Operator.GreaterOrEqual, addMonthsUtc(dateTimeOffsetFromDateOnly(year, month, 1), 1));
        return updateGenericRange(dateRange, Operator.GreaterOrEqual, addDays(dateTimeOffsetFromDateOnly(year, month, day), 1));

      case Operator.NotEqual:
      case Operator.Equal: {
        if (op === Operator.NotEqual) dateRange.invertRange = true;

        let minDate: number;
        let maxDate: number;

        if (month == null) {
          minDate = dateTimeOffsetFromDateOnly(year, 1, 1);
          maxDate = addMonthsUtc(minDate, 12);
        } else if (day == null) {
          minDate = dateTimeOffsetFromDateOnly(year, month, 1);
          maxDate = addMonthsUtc(minDate, 1);
        } else {
          minDate = dateTimeOffsetFromDateOnly(year, month, day);
          maxDate = addDays(minDate, 1);
        }

        return updateGenericRange(dateRange, Operator.GreaterOrEqual, minDate) && updateGenericRange(dateRange, Operator.Less, maxDate);
      }

      default:
        return false;
    }
  } catch (e) {
    if (e instanceof OutOfRangeError) return false;
    throw e;
  }
}
