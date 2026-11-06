// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Maps the stored beatmap library (BeatmapSetRecord / BeatmapEntry) onto the filter model used by the ported carousel filters
// (the role Realm's BeatmapInfo / BeatmapSetInfo play in lazer), and keeps the "last played" timestamps lazer stores on BeatmapInfo.

import { RULESETS } from '../../game/rulesets';
import type { BeatmapEntry, BeatmapSetRecord } from '../../game/storage/Database';
import { BeatmapOnlineStatus, FilterBeatmap, FilterBeatmapSet, FilterMetadata, FilterRuleset } from './FilterCriteria';

/** Optional fields a newer importer may store (see the report: Importer change request). */
export type ExtendedEntry = BeatmapEntry & {
  beatDivisor?: number;
  endTimeObjectCount?: number;
  status?: BeatmapOnlineStatus;
  dateSubmitted?: number;
  dateRanked?: number;
};

export function rulesetRef(id: number): FilterRuleset {
  const r = RULESETS.find(x => x.id === id);
  return { shortName: r?.shortName ?? 'osu', onlineId: id };
}

// ---------------------------------------------------------------- last played (BeatmapInfo.LastPlayed)

const LAST_PLAYED_KEY = 'select.lastPlayed';
let lastPlayedCache: Record<string, number> | null = null;

function lastPlayedMap(): Record<string, number> {
  if (lastPlayedCache) return lastPlayedCache;
  try {
    lastPlayedCache = JSON.parse(localStorage.getItem(LAST_PLAYED_KEY) ?? '{}') as Record<string, number>;
  } catch {
    lastPlayedCache = {};
  }
  return lastPlayedCache;
}

export function getLastPlayed(hash: string): number | null {
  return lastPlayedMap()[hash] ?? null;
}

/** BeatmapManager.MarkPlayed / MarkNotPlayed */
export function setLastPlayed(hash: string, time: number | null): void {
  const map = lastPlayedMap();
  if (time == null) delete map[hash];
  else map[hash] = time;
  try {
    localStorage.setItem(LAST_PLAYED_KEY, JSON.stringify(map));
  } catch {
    /* storage unavailable */
  }
}

// ---------------------------------------------------------------- model building

export interface CarouselSource {
  set: BeatmapSetRecord;
  entry: BeatmapEntry;
}

const metadataOf = (e: BeatmapEntry): FilterMetadata => ({
  title: e.title,
  titleUnicode: e.titleUnicode,
  artist: e.artist,
  artistUnicode: e.artistUnicode,
  author: e.creator,
  source: e.source,
  tags: e.tags,
  userTags: [],
});

/** Builds (and incrementally reuses) the filter model for the library. */
export class CarouselModelBuilder {
  private readonly sets = new Map<string, { record: BeatmapSetRecord; model: FilterBeatmapSet }>();
  /** FilterBeatmap -> its stored source. */
  readonly sources = new WeakMap<FilterBeatmap, CarouselSource>();

  build(records: readonly BeatmapSetRecord[]): FilterBeatmap[] {
    const out: FilterBeatmap[] = [];
    const seen = new Set<string>();

    for (const record of records) {
      seen.add(record.id);
      let cached = this.sets.get(record.id);
      if (!cached || cached.record !== record || cached.model.beatmaps.length !== record.beatmaps.length) {
        cached = { record, model: this.createSet(record) };
        this.sets.set(record.id, cached);
      }
      for (const b of cached.model.beatmaps) {
        this.refresh(b);
        out.push(b);
      }
    }

    for (const id of [...this.sets.keys()]) if (!seen.has(id)) this.sets.delete(id);
    return out;
  }

  setFor(id: string): FilterBeatmapSet | undefined {
    return this.sets.get(id)?.model;
  }

  recordFor(id: string): BeatmapSetRecord | undefined {
    return this.sets.get(id)?.record;
  }

  findBeatmap(setId: string, hash: string): FilterBeatmap | undefined {
    return this.sets.get(setId)?.model.beatmaps.find(b => b.id === hash);
  }

  private createSet(record: BeatmapSetRecord): FilterBeatmapSet {
    const first = record.beatmaps[0] as ExtendedEntry;
    const set: FilterBeatmapSet = {
      id: record.id,
      onlineId: record.onlineId,
      metadata: metadataOf(first),
      status: first.status ?? BeatmapOnlineStatus.None,
      dateAdded: record.addedAt,
      dateRanked: first.dateRanked ?? null,
      dateSubmitted: first.dateSubmitted ?? null,
      beatmaps: [],
    };
    for (const entry of record.beatmaps) {
      const b: FilterBeatmap = {
        id: entry.hash,
        set,
        ruleset: rulesetRef(entry.rulesetId),
        onlineId: entry.onlineId,
        difficultyName: entry.difficultyName,
        metadata: metadataOf(entry),
        starRating: 0,
        approachRate: entry.approachRate,
        drainRate: entry.drainRate,
        circleSize: entry.circleSize,
        overallDifficulty: entry.overallDifficulty,
        length: entry.length,
        bpm: entry.bpm,
        beatDivisor: 4,
        status: BeatmapOnlineStatus.None,
        lastPlayed: null,
        hidden: false,
        md5Hash: entry.md5 ?? '',
        endTimeObjectCount: -1,
        totalObjectCount: entry.objectCount,
      };
      set.beatmaps.push(b);
      this.sources.set(b, { set: record, entry });
    }
    return set;
  }

  /** Re-reads mutable fields (star ratings are backfilled in the background, last played changes after gameplay). */
  private refresh(b: FilterBeatmap): void {
    const src = this.sources.get(b)!;
    const e = src.entry as ExtendedEntry;
    b.starRating = e.stars ?? 0;
    b.beatDivisor = e.beatDivisor ?? 4;
    b.endTimeObjectCount = e.endTimeObjectCount ?? -1;
    b.status = e.status ?? BeatmapOnlineStatus.None;
    b.md5Hash = e.md5 ?? '';
    b.lastPlayed = getLastPlayed(e.hash);
  }
}
