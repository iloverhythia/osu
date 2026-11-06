// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// A browser equivalent of osu.Game/Beatmaps/BeatmapDifficultyCache.cs (GetBindableDifficulty with a debounce) plus the
// per-ruleset `IBeatmap.GetStatistics()` counts shown by BeatmapTitleWedge.DifficultyDisplay.
// Difficulty calculation runs on the main thread in small idle slices (no worker), newest request first.

import type { Beatmap } from '../../game/beatmaps/Beatmap';
import { LegacyBeatmapDecoder } from '../../game/beatmaps/LegacyBeatmapDecoder';
import { ModSet, applyDifficultyAdjust } from '../../game/mods/Mods';
import { getRuleset } from '../../game/rulesets';
import type { PlayableBeatmap, Ruleset } from '../../game/rulesets/Ruleset';
import { HitCircle, Slider, Spinner } from '../../game/rulesets/osu/objects';
import { DrumRoll, Hit, Swell } from '../../game/rulesets/taiko/objects';
import { BananaShower, Fruit, JuiceStream } from '../../game/rulesets/catch/objects';
import { HoldNote, Note } from '../../game/rulesets/mania/objects/ManiaHitObject';
import type { BeatmapEntry, BeatmapSetRecord } from '../../game/storage/Database';
import { findFile } from '../../game/storage/Importer';

/** SongSelect.DIFFICULTY_CALCULATION_DEBOUNCE */
export const DIFFICULTY_CALCULATION_DEBOUNCE = 150;

/** BeatmapStatistic as produced by each ruleset's Beatmap.GetStatistics(). */
export interface BeatmapStatistic {
  name: string;
  content: string;
  barDisplayLength: number;
}

type Listener = (stars: number) => void;

interface Job {
  key: string;
  set: BeatmapSetRecord;
  entry: BeatmapEntry;
  ruleset: Ruleset;
  mods: ModSet;
  notBefore: number;
}

const decodedCache = new Map<string, Promise<Beatmap>>();
const MAX_DECODED = 24;

/** Decodes (and caches a handful of) beatmaps by hash. */
export function decodeEntry(set: BeatmapSetRecord, entry: BeatmapEntry): Promise<Beatmap> {
  let p = decodedCache.get(entry.hash);
  if (p) {
    decodedCache.delete(entry.hash);
    decodedCache.set(entry.hash, p);
    return p;
  }
  p = (async () => {
    const blob = findFile(set.files, entry.filename);
    if (!blob) throw new Error(`Missing ${entry.filename}`);
    const beatmap = LegacyBeatmapDecoder.decode(await blob.text());
    // Opportunistically fill fields song select filtering needs but older imports don't store (kept in memory only).
    const e = entry as BeatmapEntry & { endTimeObjectCount?: number };
    e.endTimeObjectCount ??= beatmap.hitObjects.filter(h => h.kind !== 'circle').length;
    return beatmap;
  })();
  p.catch(() => decodedCache.delete(entry.hash));
  decodedCache.set(entry.hash, p);
  while (decodedCache.size > MAX_DECODED) decodedCache.delete(decodedCache.keys().next().value!);
  return p;
}

export function difficultyKey(entry: BeatmapEntry, ruleset: Ruleset, mods: ModSet): string {
  return `${entry.hash}|${ruleset.id}|${mods.forRuleset(ruleset.shortName, ruleset.availableMods).toString()}`;
}

class DifficultyCacheImpl {
  private readonly values = new Map<string, number>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly queue: Job[] = [];
  private running = false;

  /** Synchronous lookup; returns undefined if not yet computed. */
  peek(entry: BeatmapEntry, ruleset: Ruleset, mods: ModSet): number | undefined {
    const rulesetMods = mods.forRuleset(ruleset.shortName, ruleset.availableMods);
    if (rulesetMods.isEmpty && entry.rulesetId === ruleset.id && entry.stars !== undefined) return entry.stars;
    return this.values.get(difficultyKey(entry, ruleset, mods));
  }

  /**
   * GetBindableDifficulty: calls `cb` with the star rating once known (immediately if cached). Returns an unsubscribe function
   * which also cancels the pending computation if nobody else is waiting for it.
   */
  get(set: BeatmapSetRecord, entry: BeatmapEntry, ruleset: Ruleset, mods: ModSet, cb: Listener, debounce = DIFFICULTY_CALCULATION_DEBOUNCE): () => void {
    const known = this.peek(entry, ruleset, mods);
    if (known !== undefined) {
      cb(known);
      return () => undefined;
    }
    const key = difficultyKey(entry, ruleset, mods);
    let ls = this.listeners.get(key);
    if (!ls) this.listeners.set(key, (ls = new Set()));
    ls.add(cb);
    if (!this.queue.some(j => j.key === key)) this.queue.push({ key, set, entry, ruleset, mods: mods.forRuleset(ruleset.shortName, ruleset.availableMods), notBefore: performance.now() + debounce });
    this.pump();
    return () => {
      const l = this.listeners.get(key);
      l?.delete(cb);
      if (l && l.size === 0) {
        this.listeners.delete(key);
        const i = this.queue.findIndex(j => j.key === key);
        if (i >= 0) this.queue.splice(i, 1);
      }
    };
  }

  private pump(): void {
    if (this.running) return;
    this.running = true;
    const step = async () => {
      // Newest request first (panels that just came on screen / the current selection).
      const now = performance.now();
      let idx = -1;
      for (let i = this.queue.length - 1; i >= 0; i--) {
        if (this.queue[i].notBefore <= now) {
          idx = i;
          break;
        }
      }
      if (idx < 0) {
        if (this.queue.length === 0) {
          this.running = false;
          return;
        }
        setTimeout(() => void step(), 30);
        return;
      }
      const [job] = this.queue.splice(idx, 1);
      let stars = 0;
      try {
        stars = await computeStars(job);
      } catch {
        stars = job.entry.stars ?? 0;
      }
      this.values.set(job.key, stars);
      const ls = this.listeners.get(job.key);
      this.listeners.delete(job.key);
      ls?.forEach(l => l(stars));
      setTimeout(() => void step(), 0);
    };
    setTimeout(() => void step(), 0);
  }
}

async function computeStars(job: Job): Promise<number> {
  const r = job.ruleset;
  if (!r.starRating) return job.entry.stars ?? 0;
  const beatmap = await decodeEntry(job.set, job.entry);
  if (!r.canConvert(beatmap)) return 0;
  return r.starRating(r.createPlayable(applyDifficultyAdjust(beatmap, job.mods), job.mods));
}

export const difficultyCache = new DifficultyCacheImpl();

/** Beatmap.GetStatistics() of the beatmap converted to `ruleset` (OsuBeatmap / TaikoBeatmap / CatchBeatmap / ManiaBeatmap). */
export function getStatistics(playable: PlayableBeatmap): BeatmapStatistic[] {
  const objs = playable.hitObjects as unknown[];
  const count = (pred: (o: unknown) => boolean) => objs.reduce<number>((a, o) => a + (pred(o) ? 1 : 0), 0);
  const f = Math.fround;
  const make = (names: [string, string, string], a: number, b: number, c?: number): BeatmapStatistic[] => {
    const sum = Math.max(1, a + b);
    const out: BeatmapStatistic[] = [
      { name: names[0], content: String(a), barDisplayLength: f(a / sum) },
      { name: names[1], content: String(b), barDisplayLength: f(b / sum) },
    ];
    if (c !== undefined) out.push({ name: names[2], content: String(c), barDisplayLength: Math.min(f(c / 10), 1) });
    return out;
  };

  switch (playable.ruleset.id) {
    case 0:
      return make(['Circles', 'Sliders', 'Spinners'], count(o => o instanceof HitCircle), count(o => o instanceof Slider), count(o => o instanceof Spinner));
    case 1:
      return make(['Hits', 'Drumrolls', 'Swells'], count(o => o instanceof Hit), count(o => o instanceof DrumRoll), count(o => o instanceof Swell));
    case 2:
      return make(['Fruits', 'Juice Streams', 'Banana Showers'], count(o => o instanceof Fruit), count(o => o instanceof JuiceStream), count(o => o instanceof BananaShower));
    default:
      return make(['Notes', 'Hold Notes', ''], count(o => o instanceof Note), count(o => o instanceof HoldNote));
  }
}

/** Creates the playable beatmap for display purposes (WorkingBeatmap.GetPlayableBeatmap(ruleset)). */
export function createDisplayPlayable(beatmap: Beatmap, rulesetId: number): PlayableBeatmap | null {
  const r = getRuleset(rulesetId);
  if (!r.canConvert(beatmap)) return null;
  try {
    return r.createPlayable(beatmap, new ModSet());
  } catch {
    return null;
  }
}
