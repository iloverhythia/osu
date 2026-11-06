// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Ruleset registry (RulesetStore equivalent).

import type { Ruleset } from './Ruleset';
import { osuRuleset } from './osu';
import { catchRuleset } from './catch';
import { taikoRuleset } from './taiko';

export const RULESETS: Ruleset[] = [osuRuleset, taikoRuleset, catchRuleset];

export function getRuleset(id: number): Ruleset {
  return RULESETS.find(r => r.id === id) ?? osuRuleset;
}

export function availableRulesets(): Ruleset[] {
  return [...RULESETS].sort((a, b) => a.id - b.id);
}

export function registerRuleset(r: Ruleset): void {
  if (!RULESETS.some(x => x.id === r.id)) RULESETS.push(r);
}
