// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game.Tests/NonVisual/Filtering/FilterMatchingTest.cs (+ sorting / grouping / mania key filter checks).

import { describe, expect, it } from 'vitest';
import { BeatmapOnlineStatus, FilterBeatmap, FilterCriteria, GroupMode, OptionalRange, OptionalTextFilter, SortMode } from '../../src/ui/select/FilterCriteria';
import { applyQueries } from '../../src/ui/select/FilterQueryParser';
import { filterGrouping, filterSorting, GroupedBeatmap, GroupedBeatmapSet, GroupDefinition, ManiaFilterCriteria } from '../../src/ui/select/BeatmapCarouselFilters';
import { filtered, makeBeatmap, makeSet, metadata } from './helpers';

const getExampleBeatmap = (): FilterBeatmap =>
  makeBeatmap({
    ruleset: { shortName: 'osu', onlineId: 0 },
    starRating: 4.0,
    approachRate: 5.0,
    drainRate: 3.0,
    circleSize: 2.0,
    metadata: metadata({
      artist: 'The Artist',
      artistUnicode: 'check unicode too',
      title: 'Title goes here',
      titleUnicode: 'TitleUnicode goes here',
      author: 'The Author',
      source: 'unit tests',
      tags: 'look for tags too',
      userTags: ['song representation/simple', 'style/clean'],
    }),
    difficultyName: 'version as well',
    length: 2500,
    bpm: 160,
    beatDivisor: 12,
    status: BeatmapOnlineStatus.Loved,
  });

const criteria = (init: Partial<FilterCriteria> & { searchText?: string } = {}) => {
  const c = new FilterCriteria();
  const { searchText, ...rest } = init;
  Object.assign(c, rest);
  if (searchText !== undefined) c.searchText = searchText;
  return c;
};

const convertCriteria = (extra: Partial<FilterCriteria> & { searchText?: string } = {}) => criteria({ ruleset: { shortName: '', onlineId: 6 }, allowConvertedBeatmaps: true, ...extra });

const visibleIndexes = (beatmaps: FilterBeatmap[], c: FilterCriteria) => beatmaps.map((b, i) => (filtered(b, c) ? -1 : i)).filter(i => i >= 0);

describe('FilterMatching', () => {
  it('TestCriteriaMatchingNoRuleset', () => {
    expect(filtered(getExampleBeatmap(), new FilterCriteria())).toBe(false);
  });

  it('TestCriteriaMatchingSpecificRuleset', () => {
    expect(filtered(getExampleBeatmap(), criteria({ ruleset: { shortName: 'catch', onlineId: -1 } }))).toBe(true);
  });

  it('TestCriteriaMatchingConvertedBeatmaps', () => {
    expect(filtered(getExampleBeatmap(), convertCriteria())).toBe(false);
  });

  it('TestCriteriaMatchingConvertedBeatmapsForCustomRulesets', () => {
    expect(filtered(getExampleBeatmap(), criteria({ ruleset: { shortName: '', onlineId: -1 }, allowConvertedBeatmaps: true }))).toBe(false);
  });

  it.each([true, false])('TestCriteriaMatchingRangeMin(%s)', inclusive => {
    expect(filtered(getExampleBeatmap(), convertCriteria({ approachRate: new OptionalRange({ isLowerInclusive: inclusive, min: 5.0 }) }))).toBe(!inclusive);
  });

  it.each([true, false])('TestCriteriaMatchingRangeMax(%s)', inclusive => {
    expect(filtered(getExampleBeatmap(), convertCriteria({ bpm: new OptionalRange({ isUpperInclusive: inclusive, max: 160 }) }))).toBe(!inclusive);
  });

  it.each<[string, boolean]>([
    ['artist', false],
    ['artist title author', false],
    ['an artist', true],
    ['tags too', false],
    ['version', false],
    ['an auteur', true],
    ['unit', false],
  ])('TestCriteriaMatchingTerms(%s)', (terms, expected) => {
    expect(filtered(getExampleBeatmap(), convertCriteria({ searchText: terms }))).toBe(expected);
  });

  it.each<[string, boolean]>([
    ['"artist"', false],
    ['"arti"', true],
    ['"artist title author"', true],
    ['"artist" "title" "author"', false],
    ['"an artist"', true],
    ['"tags too"', false],
    ['"tags to"', true],
    ['"version"', false],
    ['"an auteur"', true],
    ['"Artist"!', true],
    ['"The Artist"!', false],
    ['"the artist"!', false],
    ['"unit tests"!', false],
    ['"\\"', true],
  ])('TestCriteriaMatchingExactTerms(%s)', (terms, expected) => {
    expect(filtered(getExampleBeatmap(), convertCriteria({ searchText: terms }))).toBe(expected);
  });

  it.each<[string, boolean]>([
    ['', false],
    ['The', false],
    ['THE', false],
    ['author', false],
    ['the author', false],
    ['the author AND then something else', true],
    ['unknown', true],
  ])('TestCriteriaMatchingCreator(%s)', (name, expected) => {
    expect(filtered(getExampleBeatmap(), criteria({ creator: new OptionalTextFilter({ searchTerm: name }) }))).toBe(expected);
  });

  it.each<[string, boolean]>([
    ['"quoted words"', false],
    ['"the artist"', false],
    ['the artist "quoted words"', false],
    ['"unknown"', true],
  ])('TestCriteriaMatchingTermsAdjacentToPunctuation(%s)', (terms, expected) => {
    const b = getExampleBeatmap();
    b.metadata.title = 'the artist "quoted words"';
    expect(filtered(b, convertCriteria({ searchText: terms }))).toBe(expected);
  });

  it.each<[string, boolean]>([
    ['~quoted words~', false],
    ['the artist', false],
    ['the artist ~quoted words~', false],
    ['~unknown~', true],
  ])('TestCriteriaMatchingTermsAdjacentToMathSymbols(%s)', (terms, expected) => {
    const b = getExampleBeatmap();
    b.metadata.title = 'the artist ~quoted words~';
    expect(filtered(b, convertCriteria({ searchText: terms }))).toBe(expected);
  });

  it.each<[string, boolean]>([
    ['', false],
    ['Goes', false],
    ['GOES', false],
    ['goes', false],
    ['title goes', false],
    ['title goes AND then something else', true],
    ['titleunicode', false],
    ['unknown', true],
  ])('TestCriteriaMatchingTitle(%s)', (name, expected) => {
    expect(filtered(getExampleBeatmap(), criteria({ title: new OptionalTextFilter({ searchTerm: name }) }))).toBe(expected);
  });

  it.each<[string, boolean]>([
    ['', false],
    ['The', false],
    ['THE', false],
    ['artist', false],
    ['the artist', false],
    ['the artist AND then something else', true],
    ['unicode too', false],
    ['unknown', true],
    ['"Artist"!', true],
    ['"The Artist"!', false],
    ['"the artist"!', false],
  ])('TestCriteriaMatchingArtist(%s)', (name, expected) => {
    expect(filtered(getExampleBeatmap(), criteria({ artist: new OptionalTextFilter({ searchTerm: name }) }))).toBe(expected);
  });

  it.each<[string, boolean]>([
    ['', false],
    ['artist', false],
    ['unknown', true],
  ])('TestCriteriaMatchingArtistWithNullUnicodeName(%s)', (name, expected) => {
    const b = getExampleBeatmap();
    b.metadata.artistUnicode = '';
    expect(filtered(b, criteria({ artist: new OptionalTextFilter({ searchTerm: name }) }))).toBe(expected);
  });

  it.each<[string, boolean]>([
    ['202010', true],
    ['20201010', false],
    ['153', true],
    ['1535', false],
  ])('TestCriteriaMatchingBeatmapIDs(%s)', (query, expected) => {
    const b = getExampleBeatmap();
    b.onlineId = 20201010;
    b.set.onlineId = 1535;
    expect(filtered(b, criteria({ searchText: query }))).toBe(expected);
  });

  it.each(['artist', 'unicode'])('TestCriteriaNotMatchingArtist(%s)', term => {
    expect(filtered(getExampleBeatmap(), criteria({ artist: new OptionalTextFilter({ searchTerm: term, excludeTerm: true }) }))).toBe(true);
  });

  it.each<[string, boolean]>([
    ['simple', false],
    ['"style/clean"', false],
    ['"style/clean"!', false],
    ['iNiS-style', true],
    ['"reading/visually dense"!', true],
  ])('TestCriteriaMatchingUserTags(%s)', (query, expected) => {
    expect(filtered(getExampleBeatmap(), criteria({ userTags: [new OptionalTextFilter({ searchTerm: query })] }))).toBe(expected);
  });

  it('TestCriteriaMatchingMultipleTagsAtOnce', () => {
    const c = criteria({ userTags: [new OptionalTextFilter({ searchTerm: '"song representation/simple"!' }), new OptionalTextFilter({ searchTerm: '"style/clean"!' })] });
    expect(filtered(getExampleBeatmap(), c)).toBe(false);
  });

  it('TestCriteriaAllTagFiltersMustMatch', () => {
    const c = criteria({ userTags: [new OptionalTextFilter({ searchTerm: '"song representation/simple"!' }), new OptionalTextFilter({ searchTerm: '"style/dirty"!' })] });
    expect(filtered(getExampleBeatmap(), c)).toBe(true);
  });

  it('TestCriteriaMatchingTagExcluded', () => {
    const c = criteria({ userTags: [new OptionalTextFilter({ searchTerm: '"song representation/simple"!', excludeTerm: true })] });
    expect(filtered(getExampleBeatmap(), c)).toBe(true);
  });

  it('TestCriteriaOneTagIncludedAndOneTagExcluded', () => {
    const c = criteria({
      userTags: [new OptionalTextFilter({ searchTerm: '"song representation/simple"!' }), new OptionalTextFilter({ searchTerm: '"style/clean"!', excludeTerm: true })],
    });
    expect(filtered(getExampleBeatmap(), c)).toBe(true);
  });

  it('TestBeatmapMustHaveAtLeastOneTagIfUserTagFilterActive', () => {
    const b = getExampleBeatmap();
    b.metadata.userTags = [];
    expect(filtered(b, criteria({ userTags: [new OptionalTextFilter({ searchTerm: 'simple' })] }))).toBe(true);
  });

  it.each([null, true, false])('TestCustomRulesetCriteria(%s)', match => {
    const c = criteria({ rulesetCriteria: match == null ? null : { matches: () => match, tryParseCustomKeywordCriteria: () => false, filterMayChangeFromMods: () => false } });
    expect(filtered(getExampleBeatmap(), c)).toBe(match === false);
  });

  it.each<[string, number[]]>([
    ['title!=Title', [2, 4, 6]],
    ['title!="Title1"', [2, 3, 4, 5, 6]],
    ['title!="Title1"!', [2, 3, 4, 5, 6]],
  ])('TestNotEqualSearchForTextFilters(%s)', (query, expected) => {
    const beatmaps = ['Title1', 'Title1', 'My[Favourite]Song', 'Title', 'Another One', 'Diff in title', 'a'].map(title => makeBeatmap({ metadata: metadata({ title }) }));
    const c = new FilterCriteria();
    applyQueries(c, query);
    expect(visibleIndexes(beatmaps, c)).toEqual(expected);
  });

  it('TestNotEqualSearchForNumberFilters', () => {
    const beatmaps = [2.78, 1.78, 1.55, 3.78, 1.78, 1.55, 2.78].map(starRating => makeBeatmap({ starRating }));
    const c = new FilterCriteria();
    applyQueries(c, 'star!=1.78');
    expect(visibleIndexes(beatmaps, c)).toEqual([0, 2, 3, 5, 6]);
  });

  it.each<[string, number[]]>([
    ['status!=ranked', [1, 2, 4, 5]],
    ['status!=r', [1, 2, 4, 5]],
    ['status!=loved', [0, 1, 2, 3, 4, 6]],
    ['status!=l', [0, 1, 2, 3, 4, 6]],
    ['status!=r,l', [1, 2, 4]],
  ])('TestNotEqualSearchForEnumFilter(%s)', (query, expected) => {
    const S = BeatmapOnlineStatus;
    const beatmaps = [S.Ranked, S.Qualified, S.Approved, S.Ranked, S.Approved, S.Loved, S.Ranked].map(status => makeBeatmap({ status }));
    const c = new FilterCriteria();
    applyQueries(c, query);
    expect(visibleIndexes(beatmaps, c)).toEqual(expected);
  });

  it.each<[string, number[]]>([
    ['played!=1', [1, 4, 5]],
    ['played!=0', [0, 2, 3, 6, 7]],
  ])('TestNotEqualSearchForBooleanFilter(%s)', (query, expected) => {
    const beatmaps = [Date.UTC(2012, 9, 21), null, Date.UTC(2012, 10, 12), Date.UTC(2013, 1, 13), null, null, Date.UTC(2014, 0, 15), Date.UTC(2014, 10, 16)].map(lastPlayed =>
      makeBeatmap({ lastPlayed }),
    );
    const c = new FilterCriteria();
    applyQueries(c, query);
    expect(visibleIndexes(beatmaps, c)).toEqual(expected);
  });

  it.each<[string, number[]]>([
    ['ranked!=2012', [3, 4, 5, 6, 7]],
    ['ranked!=2012.11', [0, 1, 3, 4, 5, 6, 7]],
    ['ranked!=2012.10.21', [1, 2, 3, 4, 5, 6, 7]],
  ])('TestNotEqualSearchForDateFilter(%s)', (query, expected) => {
    const dates = [
      Date.UTC(2012, 9, 21, 13, 42, 13),
      Date.UTC(2012, 9, 11, 2, 33, 43),
      Date.UTC(2012, 10, 12, 10, 22, 32),
      Date.UTC(2013, 1, 13, 5, 19, 0),
      Date.UTC(2013, 1, 13, 11, 23, 35),
      Date.UTC(2013, 2, 14, 9, 9, 1),
      Date.UTC(2014, 0, 15, 10, 5, 0),
      Date.UTC(2014, 10, 16, 23, 27, 0),
    ];
    const beatmaps = dates.map(dateRanked => makeBeatmap({ set: makeSet({ dateRanked }) }));
    const c = new FilterCriteria();
    applyQueries(c, query);
    expect(visibleIndexes(beatmaps, c)).toEqual(expected);
  });
});

describe('ManiaFilterCriteria', () => {
  const maniaMap = (keys: number) => makeBeatmap({ ruleset: { shortName: 'mania', onlineId: 3 }, circleSize: keys, totalObjectCount: 10 });

  it.each<[string, number[]]>([
    ['keys=4', [0]],
    ['keys!=4', [1, 2]],
    ['keys>4', [1, 2]],
    ['keys<=7', [0, 1]],
    ['keys=4,10', [0, 2]],
  ])('key filters (%s)', (query, expected) => {
    const beatmaps = [maniaMap(4), maniaMap(7), maniaMap(10)];
    const c = new FilterCriteria();
    c.rulesetCriteria = new ManiaFilterCriteria();
    applyQueries(c, query);
    expect(c.searchText.trim()).toBe('');
    expect(visibleIndexes(beatmaps, c)).toEqual(expected);
  });

  it('key mods change the column count of converts only', () => {
    const convert = makeBeatmap({ ruleset: { shortName: 'osu', onlineId: 0 }, overallDifficulty: 8, totalObjectCount: 10 });
    expect(ManiaFilterCriteria.keyCountFor(convert, ['5K'])).toBe(5);
    expect(ManiaFilterCriteria.keyCountFor(maniaMap(7), ['5K'])).toBe(7);
  });
});

describe('Sorting and grouping', () => {
  const setWith = (title: string, artist: string, stars: number[], dateAdded = 0) => {
    const set = makeSet({ metadata: metadata({ title, artist }), dateAdded });
    for (const s of stars) makeBeatmap({ set, starRating: s, metadata: set.metadata, ruleset: { shortName: 'osu', onlineId: 0 } });
    return set;
  };

  it('sorts sets by title with difficulties by star rating', () => {
    const a = setWith('b', 'z', [3, 1]);
    const b = setWith('A', 'y', [2]);
    const c = new FilterCriteria();
    const sorted = filterSorting([...a.beatmaps, ...b.beatmaps], c);
    expect(sorted.map(x => [x.set.metadata.title, x.starRating])).toEqual([
      ['A', 2],
      ['b', 1],
      ['b', 3],
    ]);
  });

  it('groups by artist alphabetically, with set + difficulty items', () => {
    const a = setWith('t', 'zed', [1, 2]);
    const b = setWith('t2', '9lives', [1]);
    const c = new FilterCriteria();
    c.group = GroupMode.Artist;
    c.sort = SortMode.Artist;
    const result = filterGrouping(filterSorting([...a.beatmaps, ...b.beatmaps], c), c);
    const kinds = result.items.map(i => (i.model instanceof GroupDefinition ? `g:${i.model.title}` : i.model instanceof GroupedBeatmapSet ? 's' : i.model instanceof GroupedBeatmap ? 'b' : '?'));
    expect(kinds).toEqual(['g:0-9', 's', 'b', 'g:Z', 's', 'b', 'b']);
    expect(result.items[0].nestedItemCount).toBe(1);
    expect(result.items.filter(i => i.isVisible).length).toBe(2);
  });

  it('difficulty sort splits difficulties into standalone items', () => {
    const a = setWith('t', 'a', [1, 2]);
    const c = new FilterCriteria();
    c.sort = SortMode.Difficulty;
    const result = filterGrouping(filterSorting(a.beatmaps, c), c);
    expect(result.beatmapSetsGroupedTogether).toBe(false);
    expect(result.items.every(i => i.model instanceof GroupedBeatmap && i.isVisible)).toBe(true);
  });
});
