// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game.Rulesets.Catch/CatchRuleset.cs (+ CatchInputManager.cs actions / default key bindings).

import { RULESET_DISPLAY_NAMES } from '../../../brand';
import type { Beatmap } from '../../beatmaps/Beatmap';
import type { ModSet } from '../../mods/Mods';
import { HitResult } from '../../scoring/HitResult';
import type { DrawableRuleset, GameplayContext, PlayableBeatmap, Ruleset, RulesetAction } from '../Ruleset';
import { canConvertToCatch } from './CatchBeatmap';
import { calculateCatchStarRating } from './CatchDifficultyCalculator';
import { CatchPlayableBeatmap } from './CatchPlayable';
import { CatchHealthProcessor, CatchScoreProcessor, catchScoreMultiplier } from './CatchScoring';
import { DrawableCatchRuleset } from './DrawableCatchRuleset';

export { CatchPlayableBeatmap } from './CatchPlayable';

const ACTIONS: RulesetAction[] = [
  { id: 'MoveLeft', label: 'Move left' },
  { id: 'MoveRight', label: 'Move right' },
  { id: 'Dash', label: 'Engage dash' },
];

function asCatchPlayable(playable: PlayableBeatmap): CatchPlayableBeatmap {
  if (!(playable instanceof CatchPlayableBeatmap)) throw new Error('Not an osu!catch playable beatmap');
  return playable;
}

export const catchRuleset: Ruleset = {
  id: 2,
  shortName: 'fruits',
  name: RULESET_DISPLAY_NAMES[2],

  availableMods: ['EZ', 'NF', 'HT', 'DC', 'HR', 'SD', 'PF', 'DT', 'NC', 'HD', 'FL', 'AC', 'DA', 'MR', 'AT', 'CN', 'RX'],

  actions(): RulesetAction[] {
    return ACTIONS;
  },

  defaultBindings(): Record<string, string[]> {
    return {
      MoveLeft: ['KeyZ', 'ArrowLeft'],
      MoveRight: ['KeyX', 'ArrowRight'],
      Dash: ['ShiftLeft', 'ShiftRight', 'Mouse0'],
    };
  },

  canConvert(beatmap: Beatmap): boolean {
    return canConvertToCatch(beatmap);
  },

  createPlayable(beatmap: Beatmap, mods: ModSet): PlayableBeatmap {
    return new CatchPlayableBeatmap(beatmap, catchRuleset, mods);
  },

  createDrawableRuleset(playable: PlayableBeatmap, ctx: GameplayContext): DrawableRuleset {
    return new DrawableCatchRuleset(asCatchPlayable(playable), ctx);
  },

  createScoreProcessor(playable: PlayableBeatmap) {
    const p = new CatchScoreProcessor();
    p.scoreMultiplier = catchScoreMultiplier(playable.mods);
    return p;
  },

  createHealthProcessor(playable: PlayableBeatmap, drainStartTime: number) {
    const p = asCatchPlayable(playable);
    return new CatchHealthProcessor(drainStartTime, p.hitObjects, p.difficulty.drainRate);
  },

  scoreMultiplier(mods: ModSet): number {
    return catchScoreMultiplier(mods);
  },

  displayedResults: [HitResult.Great, HitResult.LargeTickHit, HitResult.SmallTickHit, HitResult.LargeBonus, HitResult.SmallTickMiss, HitResult.LargeTickMiss, HitResult.Miss],

  resultLabel(result: HitResult): string {
    switch (result) {
      case HitResult.Great:
        return 'Fruit';
      case HitResult.LargeTickHit:
        return 'Large droplet';
      case HitResult.SmallTickHit:
        return 'Small droplet';
      case HitResult.LargeBonus:
        return 'Banana';
      case HitResult.SmallTickMiss:
        return 'Small droplet miss';
      case HitResult.LargeTickMiss:
        return 'Large droplet miss';
      case HitResult.Miss:
        return 'Miss';
      default:
        return HitResult[result] ?? '';
    }
  },

  starRating(playable: PlayableBeatmap): number {
    const p = asCatchPlayable(playable);
    return calculateCatchStarRating(p.hitObjects, p.difficulty, p.mods.rate);
  },
};
