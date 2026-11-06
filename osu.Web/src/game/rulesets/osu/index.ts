// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game.Rulesets.Osu/OsuRuleset.cs

import type { Beatmap } from '../../beatmaps/Beatmap';
import { RULESET_DISPLAY_NAMES } from '../../../brand';
import { ModSet } from '../../mods/Mods';
import { HitResult } from '../../scoring/HitResult';
import type { DrawableRuleset, GameplayContext, PlayableBeatmap, Ruleset } from '../Ruleset';
import { OsuPlayableBeatmap, convertOsuBeatmap } from './beatmap';
import { DrawableOsuRuleset } from './DrawableOsuRuleset';
import { calculateOsuDifficulty } from './difficulty';
import { OsuHealthProcessor, OsuScoreProcessor, osuScoreMultiplier } from './scoring';

export const osuRuleset: Ruleset = {
  id: 0,
  shortName: 'osu',
  name: RULESET_DISPLAY_NAMES[0],
  availableMods: ['EZ', 'NF', 'HT', 'DC', 'HR', 'SD', 'PF', 'DT', 'NC', 'HD', 'FL', 'AC', 'DA', 'MR', 'AT', 'CN', 'RX', 'AP', 'SO'],

  actions: () => [
    { id: 'LeftButton', label: 'Left button' },
    { id: 'RightButton', label: 'Right button' },
  ],

  defaultBindings: () => ({
    LeftButton: ['KeyZ', 'Mouse0'],
    RightButton: ['KeyX', 'Mouse2'],
  }),

  // OsuBeatmapConverter.CanConvert: every object has a position (all legacy objects do).
  canConvert: (beatmap: Beatmap) => beatmap.rulesetId === 0,

  createPlayable: (beatmap: Beatmap, mods: ModSet) => convertOsuBeatmap(beatmap, osuRuleset, mods),

  createDrawableRuleset: (playable: PlayableBeatmap, ctx: GameplayContext): DrawableRuleset => new DrawableOsuRuleset(playable as OsuPlayableBeatmap, ctx),

  createScoreProcessor: () => new OsuScoreProcessor(),

  createHealthProcessor: (_playable: PlayableBeatmap, drainStartTime: number) => new OsuHealthProcessor(drainStartTime),

  scoreMultiplier: (mods: ModSet) => osuScoreMultiplier(mods),

  displayedResults: [HitResult.Great, HitResult.Ok, HitResult.Meh, HitResult.Miss, HitResult.LargeTickHit, HitResult.SliderTailHit],

  starRating: (playable: PlayableBeatmap) => calculateOsuDifficulty(playable as OsuPlayableBeatmap).starRating,

  resultLabel: (r: HitResult) => {
    switch (r) {
      case HitResult.Great:
        return '300';
      case HitResult.Ok:
        return '100';
      case HitResult.Meh:
        return '50';
      case HitResult.Miss:
        return 'Miss';
      case HitResult.LargeTickHit:
        return 'Slider ticks';
      case HitResult.SliderTailHit:
        return 'Slider ends';
      case HitResult.SmallBonus:
        return 'Spinner spins';
      case HitResult.LargeBonus:
        return 'Spinner bonus';
      default:
        return HitResult[r];
    }
  },
};
