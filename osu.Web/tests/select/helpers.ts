// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.

import { BeatmapOnlineStatus, FilterBeatmap, FilterBeatmapSet, FilterCriteria, FilterMetadata } from '../../src/ui/select/FilterCriteria';
import { checkCriteriaMatch } from '../../src/ui/select/BeatmapCarouselFilters';

let nextId = 0;

export function metadata(m: Partial<FilterMetadata> = {}): FilterMetadata {
  return { title: '', titleUnicode: '', artist: '', artistUnicode: '', author: '', source: '', tags: '', userTags: [], ...m };
}

export function makeSet(s: Partial<Omit<FilterBeatmapSet, 'beatmaps' | 'id'>> = {}): FilterBeatmapSet {
  return { id: `set${nextId++}`, onlineId: -1, metadata: metadata(), status: BeatmapOnlineStatus.None, dateAdded: 0, dateRanked: null, dateSubmitted: null, beatmaps: [], ...s };
}

/** Equivalent of `new BeatmapInfo { ... }` in lazer's tests (defaults match BeatmapInfo's defaults). */
export function makeBeatmap(b: Partial<Omit<FilterBeatmap, 'id' | 'set'>> & { set?: FilterBeatmapSet } = {}): FilterBeatmap {
  const set = b.set ?? makeSet();
  const beatmap: FilterBeatmap = {
    id: `b${nextId++}`,
    ruleset: { shortName: '', onlineId: -1 },
    onlineId: -1,
    difficultyName: '',
    metadata: metadata(),
    starRating: 0,
    approachRate: 5,
    drainRate: 5,
    circleSize: 5,
    overallDifficulty: 5,
    length: 0,
    bpm: 0,
    beatDivisor: 4,
    status: BeatmapOnlineStatus.None,
    lastPlayed: null,
    hidden: false,
    md5Hash: '',
    endTimeObjectCount: 0,
    totalObjectCount: 0,
    ...b,
    set,
  };
  set.beatmaps.push(beatmap);
  return beatmap;
}

/** FilterMatchingTest.CarouselBeatmap.Filter: returns whether the beatmap is filtered out. */
export const filtered = (b: FilterBeatmap, c: FilterCriteria): boolean => !checkCriteriaMatch(b, c);
