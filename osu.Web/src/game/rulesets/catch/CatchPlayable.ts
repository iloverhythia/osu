// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// A converted + processed osu!catch beatmap (the equivalent of CatchBeatmap returned by GetPlayableBeatmap).

import type { Beatmap, BreakPeriod } from '../../beatmaps/Beatmap';
import type { BeatmapDifficulty } from '../../beatmaps/Difficulty';
import type { ModSet } from '../../mods/Mods';
import { HitResult } from '../../scoring/HitResult';
import type { JudgementResult } from '../../scoring/Judgement';
import type { PlayableBeatmap, Ruleset } from '../Ruleset';
import { createCatchBeatmap } from './CatchBeatmap';
import type { CatchHitObject } from './objects';

export class CatchPlayableBeatmap implements PlayableBeatmap<CatchHitObject> {
  readonly difficulty: BeatmapDifficulty;
  readonly hitObjects: CatchHitObject[];
  readonly breaks: BreakPeriod[];
  readonly objectTimes: { start: number; end: number }[];

  constructor(
    readonly source: Beatmap,
    readonly ruleset: Ruleset,
    readonly mods: ModSet,
  ) {
    const { hitObjects, difficulty } = createCatchBeatmap(source, mods);
    this.hitObjects = hitObjects;
    this.difficulty = difficulty;
    this.breaks = source.breaks.slice();
    this.objectTimes = hitObjects.map(h => ({ start: h.startTime, end: h.endTime }));
  }

  /**
   * JudgementProcessor.ApplyBeatmap order: for every top-level object, its nested objects (recursively) followed by
   * the object itself, each with its maximum result.
   */
  perfectResults(): JudgementResult[] {
    const out: JudgementResult[] = [];
    const visit = (h: CatchHitObject) => {
      for (const n of h.nested) visit(n);
      const j = h.judgement;
      out.push({
        hitObject: h,
        judgement: j,
        type: j.maxResult,
        timeOffset: 0,
        objectEndTime: h.endTime,
        newCombo: h.newCombo,
        lastInCombo: h.lastInCombo,
      });
    };
    for (const h of this.hitObjects) visit(h);
    return out;
  }

  /** IBeatmap.GetMaxCombo */
  get maxCombo(): number {
    let combo = 0;
    for (const r of this.perfectResults()) if (r.type === HitResult.Great || r.type === HitResult.LargeTickHit) combo++;
    return combo;
  }
}
