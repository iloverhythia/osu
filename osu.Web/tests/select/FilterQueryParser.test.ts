// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game.Tests/NonVisual/Filtering/FilterQueryParserTest.cs

import { describe, expect, it } from 'vitest';
import { BeatmapOnlineStatus, DATE_MIN, FilterCriteria, MatchMode, Operator, RulesetFilterCriteria, ONLINE_STATUS_ENUM_ORDER } from '../../src/ui/select/FilterCriteria';
import { applyQueries } from '../../src/ui/select/FilterQueryParser';
import { filtered, makeBeatmap, metadata } from './helpers';

const parse = (query: string, criteria = new FilterCriteria()) => {
  applyQueries(criteria, query);
  return criteria;
};

const utc = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d);

describe('FilterQueryParser', () => {
  it('TestApplyQueriesBareWords', () => {
    const c = parse('looking for a beatmap');
    expect(c.searchText).toBe('looking for a beatmap');
    expect(c.searchTerms.length).toBe(4);
  });

  it('TestApplyQueriesBareWordsWithExactMatch', () => {
    const c = parse('looking for "a beatmap"! like "this"');
    expect(c.searchText).toBe('looking for "a beatmap"! like "this"');
    expect(c.searchTerms.length).toBe(5);
    expect(c.searchTerms.map(t => [t.searchTerm, t.matchMode])).toEqual([
      ['a beatmap', MatchMode.FullPhrase],
      ['this', MatchMode.IsolatedPhrase],
      ['looking', MatchMode.Substring],
      ['for', MatchMode.Substring],
      ['like', MatchMode.Substring],
    ]);
  });

  it('TestApplyFullPhraseQueryWithExclamationPointInTerm', () => {
    const c = parse('looking for "circles!"!');
    expect(c.searchTerms.map(t => [t.searchTerm, t.matchMode])).toEqual([
      ['circles!', MatchMode.FullPhrase],
      ['looking', MatchMode.Substring],
      ['for', MatchMode.Substring],
    ]);
  });

  it('TestApplyBrokenFullPhraseQuery', () => {
    const c = parse('"!');
    expect(c.searchText).toBe('"!');
    expect(c.searchTerms.length).toBe(1);
    expect(c.searchTerms[0].searchTerm).toBe('!');
    expect(c.searchTerms[0].matchMode).toBe(MatchMode.IsolatedPhrase);
  });

  it.each(['star', 'stars'])('TestApplyStarQueries(%s)', variant => {
    const c = parse(`${variant}<4 easy`);
    expect(c.searchText.trim()).toBe('easy');
    expect(c.searchTerms.length).toBe(1);
    expect(c.starDifficulty.max).toBe(4);
    expect(c.starDifficulty.min).toBeNull();
  });

  it('TestStarQueriesInclusive', () => {
    const c = parse('stars>=6');
    expect(c.starDifficulty.min).toBe(6);
    expect(c.starDifficulty.isLowerInclusive).toBe(true);
    expect(c.starDifficulty.max).toBeNull();
  });

  it('TestApplyApproachRateQueries', () => {
    const c = parse('ar>=9 difficult');
    expect(c.searchText.trim()).toBe('difficult');
    expect(c.approachRate.min!).toBeGreaterThan(8.9);
    expect(c.approachRate.min!).toBeLessThan(9.0);
    expect(c.approachRate.max).toBeNull();
  });

  it.each(['dr>2 quite specific dr<:6', 'hp>2 quite specific hp<=6'])('TestApplyDrainRateQueries(%s)', q => {
    const c = parse(q);
    expect(c.searchText.trim()).toBe('quite specific');
    expect(c.searchTerms.length).toBe(2);
    expect(c.drainRate.min!).toBeGreaterThan(2.0);
    expect(c.drainRate.min!).toBeLessThan(2.1);
    expect(c.drainRate.max!).toBeGreaterThan(6.0);
    expect(c.drainRate.max!).toBeLessThan(6.1);
  });

  it('TestApplyOverallDifficultyQueries', () => {
    const c = parse('od>4 easy od<8');
    expect(c.searchText.trim()).toBe('easy');
    expect(c.overallDifficulty.min!).toBeGreaterThan(4.0);
    expect(c.overallDifficulty.min!).toBeLessThan(4.1);
    expect(c.overallDifficulty.max!).toBeGreaterThan(7.9);
    expect(c.overallDifficulty.max!).toBeLessThan(8.0);
  });

  it('TestApplyBPMQueries', () => {
    const c = parse('bpm=200');
    expect(c.bpm.min).toBe(199.5);
    expect(c.bpm.max).toBe(200.5);
  });

  it('TestApplyBPMRangeQueries', () => {
    const c = parse('bpm>:200 gotta go fast');
    expect(c.searchText.trim()).toBe('gotta go fast');
    expect(c.searchTerms.length).toBe(3);
    expect(c.bpm.min).toBe(199.5);
    expect(c.bpm.max).toBeNull();
  });

  const S = 1000;
  const M = 60000;
  const H = 3600000;
  it.each([
    ['23s', 23 * S, S],
    ['9m', 9 * M, M],
    ['0.25h', 0.25 * H, H],
    ['70', 70 * S, S],
    ['7m27s', 447 * S, S],
    ['7:27', 447 * S, S],
    ['1h2m3s', 3723 * S, S],
    ['1h2m3.5s', 3723.5 * S, S],
    ['1:2:3', 3723 * S, S],
    ['1:02:03', 3723 * S, S],
    ['6', 6 * S, S],
    ['6.5', 6.5 * S, S],
    ['6.5s', 6.5 * S, S],
    ['6.5m', 6.5 * M, M],
    ['6h5m', 365 * M, M],
    ['65m', 65 * M, M],
    ['90s', 90 * S, S],
    ['80m20s', 4820 * S, S],
    ['1h20s', 3620 * S, S],
  ])('TestApplyLengthQueries(%s)', (lengthQuery, expected, scale) => {
    const c = parse(`length=${lengthQuery} time`);
    expect(c.searchText.trim()).toBe('time');
    expect(c.searchTerms.length).toBe(1);
    expect(c.length.min).toBe(expected - scale / 2);
    expect(c.length.max).toBe(expected + scale / 2);
  });

  it.each(['7.5m27s', '7m27', '7m7m7m', '7m70s', '5s6m', '0:', ':0', '0:3:', '3:15.5'])('TestInvalidLengthQueries(%s)', q => {
    expect(parse(`length=${q} time`).length.hasFilter).toBe(false);
  });

  it('TestApplyDivisorQueries', () => {
    const c = parse("that's a time signature alright! divisor:12");
    expect(c.searchText.trim()).toBe("that's a time signature alright!");
    expect(c.searchTerms.length).toBe(5);
    expect(c.beatDivisor.min).toBe(12);
    expect(c.beatDivisor.isLowerInclusive).toBe(true);
    expect(c.beatDivisor.max).toBe(12);
    expect(c.beatDivisor.isUpperInclusive).toBe(true);
  });

  it('TestPartialStatusMatch', () => {
    expect(parse('status=r').onlineStatus.values.has(BeatmapOnlineStatus.Ranked)).toBe(true);
  });

  it('TestApplyStatusQueries', () => {
    const c = parse('I want the pp status=ranked');
    expect(c.searchText.trim()).toBe('I want the pp');
    expect(c.searchTerms.length).toBe(4);
    expect(c.onlineStatus.values.has(BeatmapOnlineStatus.Ranked)).toBe(true);
  });

  it('TestApplyMultipleEqualityStatusQueries', () => {
    expect(parse('status=ranked status=loved').onlineStatus.values.size).toBe(0);
  });

  it('TestPartialStatusNotMatch', () => {
    const c = parse('status!=r');
    expect(c.onlineStatus.values.size).toBeGreaterThan(0);
    expect(c.onlineStatus.values.has(BeatmapOnlineStatus.Ranked)).toBe(false);
  });

  it('TestApplyEqualStatusQueryWithMultipleValues', () => {
    const c = parse('status=ranked,loved');
    expect([...c.onlineStatus.values].sort()).toEqual([BeatmapOnlineStatus.Ranked, BeatmapOnlineStatus.Loved].sort());
  });

  it('TestApplyRangeStatusMatches', () => {
    const c = parse('status>=r');
    expect(c.onlineStatus.values.size).toBe(4);
    for (const s of [BeatmapOnlineStatus.Ranked, BeatmapOnlineStatus.Approved, BeatmapOnlineStatus.Qualified, BeatmapOnlineStatus.Loved]) expect(c.onlineStatus.values.has(s)).toBe(true);
  });

  it('TestApplyRangeStatusWithMultipleMatchesQuery', () => {
    expect(parse('status>=r,l').onlineStatus.values.size).toBe(ONLINE_STATUS_ENUM_ORDER.length);
  });

  it('TestApplyTwoRangeStatusQuery', () => {
    const c = parse('status>r status<l');
    expect([...c.onlineStatus.values].sort()).toEqual([BeatmapOnlineStatus.Approved, BeatmapOnlineStatus.Qualified]);
  });

  it('TestApplyRangeAndEqualStatusQuery', () => {
    expect(parse('status>r status=loved').onlineStatus.values.has(BeatmapOnlineStatus.Loved)).toBe(true);
  });

  it.each(['creator', 'author', 'mapper'])('TestApplyCreatorQueries(%s)', keyword => {
    const c = parse(`beatmap specifically by ${keyword}=my_fav`);
    expect(c.searchText.trim()).toBe('beatmap specifically by');
    expect(c.searchTerms.length).toBe(3);
    expect(c.creator.searchTerm).toBe('my_fav');
  });

  it('TestApplyTitleQueries', () => {
    const c = parse('find me songs with title="a certain title" please');
    expect(c.searchText.trim()).toBe('find me songs with  please');
    expect(c.searchTerms.length).toBe(5);
    expect(c.title.searchTerm).toBe('a certain title');
    expect(c.title.matchMode).toBe(MatchMode.IsolatedPhrase);
  });

  it('TestApplyArtistQueries', () => {
    const c = parse('find me songs by artist=singer please');
    expect(c.searchText.trim()).toBe('find me songs by  please');
    expect(c.searchTerms.length).toBe(5);
    expect(c.artist.searchTerm).toBe('singer');
    expect(c.artist.matchMode).toBe(MatchMode.Substring);
  });

  it('TestApplyArtistQueriesWithSpaces', () => {
    const c = parse('really like artist="name with space" yes');
    expect(c.searchText.trim()).toBe('really like  yes');
    expect(c.searchTerms.length).toBe(3);
    expect(c.artist.searchTerm).toBe('name with space');
    expect(c.artist.matchMode).toBe(MatchMode.IsolatedPhrase);
  });

  it('TestApplyArtistQueriesWithSpacesFullPhrase', () => {
    const c = parse('artist="The Only One"!');
    expect(c.searchText.trim()).toBe('');
    expect(c.searchTerms.length).toBe(0);
    expect(c.artist.searchTerm).toBe('The Only One');
    expect(c.artist.matchMode).toBe(MatchMode.FullPhrase);
  });

  it('TestApplyArtistQueriesOneDoubleQuote', () => {
    const c = parse('weird artist=double"quote');
    expect(c.searchText.trim()).toBe('weird');
    expect(c.searchTerms.length).toBe(1);
    expect(c.artist.searchTerm).toBe('double"quote');
  });

  it('TestOperatorParsing', () => {
    expect(parse('artist=><something').artist.searchTerm).toBe('><something');
  });

  it('TestUnrecognisedKeywordIsIgnored', () => {
    expect(parse('unrecognised=keyword').searchText).toBe('unrecognised=keyword');
  });

  it.each(['cs=nope', 'bpm>=bad', 'divisor<nah', 'status=noidea'])('TestInvalidKeywordValueIsIgnored(%s)', q => {
    expect(parse(q).searchText).toBe(q);
  });

  it('TestCustomKeywordIsParsed', () => {
    let customValue: string | null = null;
    const custom: RulesetFilterCriteria = {
      matches: () => true,
      tryParseCustomKeywordCriteria: (key, op, value) => {
        if (key === 'custom' && op === Operator.Equal) {
          customValue = value;
          return true;
        }
        return false;
      },
      filterMayChangeFromMods: () => false,
    };
    const c = new FilterCriteria();
    c.rulesetCriteria = custom;
    parse('custom=readme unrecognised=keyword', c);
    expect(customValue).toBe('readme');
    expect(c.searchText.trim()).toBe('unrecognised=keyword');
  });

  it.each<[string, number[]]>([
    ['[1]', [0]],
    ['[1', [0]],
    ['My[Favourite', [2]],
    ['My[Favourite]', [2]],
    ['My[Favourite]Song', [2]],
    ['Favourite]', [2]],
    ['[Diff', [0, 1, 3, 4, 6]],
    ['[Diff]', [0, 1, 3, 4, 6]],
    ['[Favourite]', [3]],
    ['Title1 [Diff]', [0, 1]],
    ['Title1[Diff]', []],
    ['[diff ]with]', [4]],
    ['[diff ]with [[ brackets]]]]', [4]],
    ['[Diff in title]', []],
    ['[Diff in diff]', [6]],
    ['diff=Diff', [0, 1, 3, 4, 6]],
    ['diff=Diff1', [0]],
    ['diff="Diff"', [3, 4, 6]],
    ['diff=!"Diff"', []],
  ])('TestDifficultySearch(%s)', (query, expected) => {
    const beatmaps = (
      [
        ['Title1', 'Diff1'],
        ['Title1', 'Diff2'],
        ['My[Favourite]Song', 'Expert'],
        ['Title', 'My Favourite Diff'],
        ['Another One', 'diff ]with [[ brackets]]]'],
        ['Diff in title', 'a'],
        ['a', 'Diff in diff'],
      ] as const
    ).map(([title, difficultyName]) => makeBeatmap({ metadata: metadata({ title }), difficultyName }));
    const c = parse(query);
    expect(beatmaps.map((b, i) => (filtered(b, c) ? -1 : i)).filter(i => i >= 0)).toEqual(expected);
  });

  it('TestApplySourceQueries', () => {
    const c = parse('find me songs with source="unit tests" please');
    expect(c.searchText.trim()).toBe('find me songs with  please');
    expect(c.searchTerms.length).toBe(5);
    expect(c.source.searchTerm).toBe('unit tests');
    expect(c.source.matchMode).toBe(MatchMode.IsolatedPhrase);
  });

  it.each(['600', '0.5s', '120m', '48h120s', '10y24M', '10y60d120s', '0y0M2d', '1y1M2d'])('TestValidDateQueries(%s)', q => {
    expect(parse(`lastplayed<${q} time`).lastPlayed.hasFilter).toBe(true);
  });

  it.each(['.5s', '7m27', '7m7m7m', '5s6m', '7d7y', '0:3:6', '0:3:', '"three days"', '0.1y0.1M2d', '0.99y0.99M2d', ''])('TestInvalidDateQueries(%s)', q => {
    expect(parse(`played<${q} time`).lastPlayed.hasFilter).toBe(false);
    // the lazer test uses `played<`, which never parses dates; also check the date parser itself rejects these.
    expect(parse(`lastplayed<${q} time`).lastPlayed.hasFilter).toBe(false);
  });

  it('TestGreaterDateQuery', () => {
    const c = parse('lastplayed>50');
    expect(c.lastPlayed.min).toBeNull();
    expect(Math.abs(c.lastPlayed.max! - (Date.now() - 50 * 86400000))).toBeLessThan(5000);
  });

  it('TestLowerDateQuery', () => {
    const c = parse('lastplayed<50');
    expect(c.lastPlayed.max).toBeNull();
    expect(Math.abs(c.lastPlayed.min! - (Date.now() - 50 * 86400000))).toBeLessThan(5000);
  });

  it('TestBothSidesDateQuery', () => {
    const c = parse('lastplayed>3M lastplayed<1y6M');
    const now = new Date();
    const minExpected = new Date(now);
    minExpected.setMonth(now.getMonth() - 18);
    const maxExpected = new Date(now);
    maxExpected.setMonth(now.getMonth() - 3);
    expect(Math.abs(c.lastPlayed.min! - minExpected.getTime())).toBeLessThan(5 * 86400000);
    expect(Math.abs(c.lastPlayed.max! - maxExpected.getTime())).toBeLessThan(5 * 86400000);
  });

  it('TestEqualDateQuery', () => {
    expect(parse('lastplayed=50').lastPlayed.hasFilter).toBe(false);
  });

  it('TestOutOfRangeDateQuery', () => {
    const c = parse('lastplayed<10000y');
    expect(c.lastPlayed.hasFilter).toBe(true);
    expect(c.lastPlayed.min).toBe(DATE_MIN + 1);
  });

  it.each<[string, number, 'min' | 'max']>([
    ['ranked<2012', utc(2012, 1, 1), 'max'],
    ['ranked<2012.03', utc(2012, 3, 1), 'max'],
    ['ranked<2012/03/05', utc(2012, 3, 5), 'max'],
    ['ranked<2012-3-5', utc(2012, 3, 5), 'max'],
    ['ranked<=2012', utc(2013, 1, 1), 'max'],
    ['ranked<=2012.03', utc(2012, 4, 1), 'max'],
    ['ranked<=2012/03/05', utc(2012, 3, 6), 'max'],
    ['ranked<=2012-3-5', utc(2012, 3, 6), 'max'],
    ['ranked>2012', utc(2013, 1, 1), 'min'],
    ['ranked>2012.03', utc(2012, 4, 1), 'min'],
    ['ranked>2012/03/05', utc(2012, 3, 6), 'min'],
    ['ranked>2012-3-5', utc(2012, 3, 6), 'min'],
    ['ranked>=2012', utc(2012, 1, 1), 'min'],
    ['ranked>=2012.03', utc(2012, 3, 1), 'min'],
    ['ranked>=2012/03/05', utc(2012, 3, 5), 'min'],
    ['ranked>=2012-3-5', utc(2012, 3, 5), 'min'],
    ['ranked=2012', utc(2012, 1, 1), 'min'],
    ['ranked=2012-03', utc(2012, 3, 1), 'min'],
    ['ranked=2012-03', utc(2012, 4, 1), 'max'],
    ['ranked=2012-03-05', utc(2012, 3, 5), 'min'],
    ['ranked=2012-03-05', utc(2012, 3, 6), 'max'],
  ])('TestValidRankedDateQueries(%s)', (query, expected, side) => {
    const c = parse(query);
    expect(c.dateRanked.hasFilter).toBe(true);
    expect(c.dateRanked[side]).toBe(expected);
  });

  it.each(['ranked<0', 'ranked=99999', 'ranked>=2012-03-05-04'])('TestInvalidRankedDateQueries(%s)', q => {
    expect(parse(q).dateRanked.hasFilter).toBe(false);
  });

  it.each<[string, boolean]>([
    ['submitted<2012', true],
    ['submitted<2012.03', true],
    ['submitted<2012/03/05', true],
    ['submitted<2012-3-5', true],
    ['submitted<0', false],
    ['submitted=99999', false],
    ['submitted>=2012-03-05-04', false],
    ['submitted>=2012/03.05-04', false],
    ['created<2012', true],
    ['created<2012.03', true],
    ['created<2012/03/05', true],
    ['created<2012-3-5', true],
    ['created<0', false],
    ['created=99999', false],
    ['created>=2012-03-05-04', false],
    ['created>=2012/03.05-04', false],
  ])('TestSubmittedDateQueries(%s)', (q, expected) => {
    expect(parse(q).dateSubmitted.hasFilter).toBe(expected);
  });

  it.each<[string, number, boolean]>([
    ['0', DATE_MIN, true],
    ['0', Date.now(), false],
    ['false', DATE_MIN, true],
    ['false', Date.now(), false],
    ['no', DATE_MIN, true],
    ['no', Date.now(), false],
    ['1', DATE_MIN, false],
    ['1', Date.now(), true],
    ['true', DATE_MIN, false],
    ['true', Date.now(), true],
    ['yes', DATE_MIN, false],
    ['yes', Date.now(), true],
  ])('TestPlayedQuery(%s)', (query, reference, matched) => {
    const c = parse(`played=${query}`);
    expect(c.lastPlayed.hasFilter).toBe(true);
    expect(c.lastPlayed.isInRange(reference)).toBe(matched);
  });

  it('TestMultipleTextFilters', () => {
    const c = parse('tag="simple" tag="clean"!');
    expect(c.userTags.length).toBe(2);
    expect([c.userTags[0].searchTerm, c.userTags[0].matchMode]).toEqual(['simple', MatchMode.IsolatedPhrase]);
    expect([c.userTags[1].searchTerm, c.userTags[1].matchMode]).toEqual(['clean', MatchMode.FullPhrase]);
  });
});
