// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game.Rulesets.Taiko/TaikoRuleset.cs

import { RULESET_DISPLAY_NAMES } from '../../../brand';
import type { Beatmap } from '../../beatmaps/Beatmap';
import type { ModSet } from '../../mods/Mods';
import { HitResult } from '../../scoring/HitResult';
import type { DrawableRuleset, GameplayContext, PlayableBeatmap, Ruleset } from '../Ruleset';
import { TaikoPlayableBeatmap, createTaikoPlayable } from './beatmap';
import { calculateTaikoDifficulty } from './difficulty/TaikoDifficultyCalculator';
import { DrawableTaikoRuleset } from './DrawableTaikoRuleset';
import { TaikoHealthProcessor, TaikoScoreProcessor, taikoScoreMultiplier } from './scoring';

export const taikoRuleset: Ruleset = {
  id: 1,
  shortName: 'taiko',
  name: RULESET_DISPLAY_NAMES[1],
  availableMods: ['EZ', 'NF', 'HT', 'DC', 'HR', 'SD', 'PF', 'DT', 'NC', 'HD', 'FL', 'AC', 'DA', 'RD', 'AT', 'CN', 'RX'],

  actions: () => [
    { id: 'LeftRim', label: 'Left (rim)' },
    { id: 'LeftCentre', label: 'Left (centre)' },
    { id: 'RightCentre', label: 'Right (centre)' },
    { id: 'RightRim', label: 'Right (rim)' },
  ],

  defaultBindings: () => ({
    LeftRim: ['KeyD', 'Mouse2'],
    LeftCentre: ['KeyF', 'Mouse0'],
    RightCentre: ['KeyJ'],
    RightRim: ['KeyK'],
  }),

  // TaikoBeatmapConverter.CanConvert() is always true, but (as in lazer's song select) only osu! and native taiko maps are offered.
  canConvert: (beatmap: Beatmap) => beatmap.rulesetId === 0 || beatmap.rulesetId === 1,

  createPlayable: (beatmap: Beatmap, mods: ModSet) => createTaikoPlayable(beatmap, taikoRuleset, mods),

  createDrawableRuleset: (playable: PlayableBeatmap, ctx: GameplayContext): DrawableRuleset => new DrawableTaikoRuleset(playable as TaikoPlayableBeatmap, ctx),

  createScoreProcessor: () => new TaikoScoreProcessor(),

  createHealthProcessor: () => new TaikoHealthProcessor(),

  scoreMultiplier: (mods: ModSet) => taikoScoreMultiplier(mods),

  // TaikoRuleset.GetValidHitResults (scorable ones)
  displayedResults: [HitResult.Great, HitResult.Ok, HitResult.Miss, HitResult.SmallBonus, HitResult.LargeBonus],

  resultLabel: (r: HitResult) => {
    switch (r) {
      case HitResult.Great:
        return 'Great';
      case HitResult.Ok:
        return 'Ok';
      case HitResult.Miss:
        return 'Miss';
      case HitResult.SmallBonus:
        return 'Drum tick';
      case HitResult.LargeBonus:
        return 'Bonus';
      default:
        return HitResult[r];
    }
  },

  starRating: (playable: PlayableBeatmap) => calculateTaikoDifficulty(playable as TaikoPlayableBeatmap).starRating,
};

export { TaikoPlayableBeatmap, createTaikoPlayable } from './beatmap';
export { calculateTaikoDifficulty } from './difficulty/TaikoDifficultyCalculator';
