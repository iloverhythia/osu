// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game.Rulesets.Mania/ManiaRuleset.cs

import { RULESET_DISPLAY_NAMES } from '../../../brand';
import type { Beatmap } from '../../beatmaps/Beatmap';
import type { ModSet } from '../../mods/Mods';
import type { HealthProcessor } from '../../scoring/HealthProcessor';
import { HitResult } from '../../scoring/HitResult';
import type { ScoreProcessor } from '../../scoring/ScoreProcessor';
import type { DrawableRuleset, GameplayContext, PlayableBeatmap, Ruleset, RulesetAction } from '../Ruleset';
import { ManiaBeatmapConverter } from './beatmaps/ManiaBeatmapConverter';
import { calculateManiaDifficulty } from './difficulty/ManiaDifficultyCalculator';
import { maniaActions, maniaDefaultBindings } from './input/ManiaInput';
import { createManiaPlayable, ManiaPlayableBeatmap } from './ManiaPlayableBeatmap';
import { MANIA_MODS, maniaScoreMultiplier } from './mods/ManiaMods';
import { ManiaHealthProcessor, maniaPerfectFailCondition } from './scoring/ManiaHealthProcessor';
import { ManiaScoreProcessor } from './scoring/ManiaScoreProcessor';
import { DrawableManiaRuleset } from './ui/DrawableManiaRuleset';

function asMania(playable: PlayableBeatmap): ManiaPlayableBeatmap {
  if (!(playable instanceof ManiaPlayableBeatmap)) throw new Error('Not an osu!mania playable beatmap');
  return playable;
}

const RESULT_LABELS: Partial<Record<HitResult, string>> = {
  [HitResult.Perfect]: 'PERFECT',
  [HitResult.Great]: 'GREAT',
  [HitResult.Good]: 'GOOD',
  [HitResult.Ok]: 'OK',
  [HitResult.Meh]: 'MEH',
  [HitResult.Miss]: 'MISS',
};

export const maniaRuleset: Ruleset = {
  id: 3,
  shortName: 'mania',
  name: RULESET_DISPLAY_NAMES[3],
  availableMods: MANIA_MODS,

  actions(variant?: string): RulesetAction[] {
    return maniaActions(variant);
  },

  defaultBindings(variant?: string): Record<string, string[]> {
    return maniaDefaultBindings(variant);
  },

  canConvert(beatmap: Beatmap): boolean {
    return ManiaBeatmapConverter.canConvert(beatmap);
  },

  createPlayable(beatmap: Beatmap, mods: ModSet): PlayableBeatmap {
    return createManiaPlayable(beatmap, mods, maniaRuleset);
  },

  createDrawableRuleset(playable: PlayableBeatmap, ctx: GameplayContext): DrawableRuleset {
    return new DrawableManiaRuleset(asMania(playable), ctx);
  },

  createScoreProcessor(playable: PlayableBeatmap): ScoreProcessor {
    const p = new ManiaScoreProcessor();
    p.scoreMultiplier = maniaScoreMultiplier(playable.mods);
    return p;
  },

  createHealthProcessor(playable: PlayableBeatmap, drainStartTime: number): HealthProcessor {
    const p = asMania(playable);
    const hp = new ManiaHealthProcessor(drainStartTime, p.hitObjects, p.difficulty.drainRate, p.breaks, p.mods.has('EZ') ? 2 : 0);
    if (p.mods.has('PF')) hp.failConditions.push(maniaPerfectFailCondition);
    return hp;
  },

  scoreMultiplier(mods: ModSet): number {
    return maniaScoreMultiplier(mods);
  },

  displayedResults: [HitResult.Perfect, HitResult.Great, HitResult.Good, HitResult.Ok, HitResult.Meh, HitResult.Miss],

  resultLabel(result: HitResult): string {
    return RESULT_LABELS[result] ?? '';
  },

  starRating(playable: PlayableBeatmap): number {
    const p = asMania(playable);
    return calculateManiaDifficulty(p.hitObjects, p.totalColumns, p.mods.rate).starRating;
  },
};

export { ManiaPlayableBeatmap, createManiaPlayable };
