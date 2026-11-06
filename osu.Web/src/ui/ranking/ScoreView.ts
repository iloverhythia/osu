// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// The subset of osu.Game/Scoring/ScoreInfo.cs the results screen displays, built either from a finished play or from a
// locally stored score (the local leaderboard shown as contracted panels, as SoloResultsScreen does for its scope).

import type { WorkingBeatmap } from '../../game/beatmaps/WorkingBeatmap';
import { ModSet } from '../../game/mods/Mods';
import type { Ruleset } from '../../game/rulesets/Ruleset';
import { HitResult } from '../../game/scoring/HitResult';
import type { HitEvent } from '../../game/scoring/ScoreProcessor';
import type { ScoreRank } from '../../game/scoring/ScoreRank';
import type { ScoreRecord } from '../../game/storage/Database';
import type { Replay } from '../../game/replays/Replay';

export interface ScoreView {
  /** Identity used for selection (ScoreInfo.Equals). */
  key: string;
  working: WorkingBeatmap;
  ruleset: Ruleset;
  mods: ModSet;
  totalScore: number;
  accuracy: number;
  maxCombo: number;
  /** GetMaximumAchievableCombo. */
  maximumCombo: number;
  rank: ScoreRank;
  statistics: Map<HitResult, number>;
  maximumStatistics: Map<HitResult, number>;
  hitEvents: HitEvent[];
  date: number;
  player: string;
  /** Stored pp (ScoreInfo.PP), if known. */
  pp?: number;
  /** The replay, when already in memory. */
  replay?: Replay | null;
  /** IndexedDB score id (for loading the replay of a stored score). */
  recordId?: number;
  hasReplay: boolean;
  /** Whether this is the play that was just completed (flair, IsLocalPlay). */
  isNewLocalScore: boolean;
  /** Leaderboard position (ScorePosition), if known. */
  position?: number;
}

export function statisticsFromRecord(stats: Record<string, number>): Map<HitResult, number> {
  const m = new Map<HitResult, number>();
  for (const [k, v] of Object.entries(stats)) {
    const r = (HitResult as unknown as Record<string, HitResult>)[k];
    if (typeof r === 'number') m.set(r, v);
  }
  return m;
}

/** A stored local score; maximum statistics / combo are taken from the current play of the same beatmap and ruleset. */
export function scoreViewFromRecord(rec: ScoreRecord, working: WorkingBeatmap, ruleset: Ruleset, maximumStatistics: Map<HitResult, number>, maximumCombo: number): ScoreView {
  return {
    key: `db-${rec.id ?? rec.date}`,
    working,
    ruleset,
    mods: new ModSet(rec.mods, rec.modSettings ?? {}).forRuleset(ruleset.shortName, ruleset.availableMods),
    totalScore: rec.totalScore,
    accuracy: rec.accuracy,
    maxCombo: rec.maxCombo,
    maximumCombo,
    rank: rec.rank as ScoreRank,
    statistics: statisticsFromRecord(rec.statistics),
    maximumStatistics,
    hitEvents: [],
    date: rec.date,
    player: rec.player,
    pp: rec.pp,
    recordId: rec.id,
    hasReplay: !!rec.hasReplay,
    isNewLocalScore: false,
  };
}
