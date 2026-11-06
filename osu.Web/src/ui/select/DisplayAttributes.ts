// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of Ruleset.GetAdjustedDisplayDifficulty / GetBeatmapAttributesForDisplay for the four rulesets
// (osu.Game/Rulesets/Ruleset.cs, OsuRuleset.cs, TaikoRuleset.cs, CatchRuleset.cs, ManiaRuleset.cs), including each ruleset's
// Mod{Easy,HardRock}.ApplyToDifficulty and ModDifficultyAdjust. Only the label/values are ported (not the tooltip metrics).

import { BeatmapDifficulty, difficultyRange, inverseDifficultyRange } from '../../game/beatmaps/Difficulty';
import { applyDifficultyAdjust, type ModSet } from '../../game/mods/Mods';
import { ManiaBeatmapConverter } from '../../game/rulesets/mania/beatmaps/ManiaBeatmapConverter';
import type { BeatmapEntry } from '../../game/storage/Database';

export interface RulesetBeatmapAttribute {
  label: string;
  acronym: string;
  originalValue: number;
  adjustedValue: number;
  maxValue: number;
}

const f = Math.fround;

/** Ruleset.GetAdjustedDisplayDifficulty (base): applies every IApplicableToDifficulty mod of the given ruleset. */
function modAdjustedDifficulty(base: BeatmapDifficulty, rulesetId: number, mods: ModSet): BeatmapDifficulty {
  const d = applyDifficultyAdjust({ difficulty: base }, mods).difficulty.clone();
  if (mods.has('EZ')) {
    // ModEasy: CS, AR, HP; osu!/taiko/catch additionally OD; taiko additionally slider multiplier.
    d.circleSize = f(d.circleSize * 0.5);
    d.approachRate = f(d.approachRate * 0.5);
    d.drainRate = f(d.drainRate * 0.5);
    if (rulesetId !== 3) d.overallDifficulty = f(d.overallDifficulty * 0.5);
    if (rulesetId === 1) d.sliderMultiplier *= 0.8;
  }
  if (mods.has('HR')) {
    // ModHardRock: HP; osu!/catch also OD, CS (1.3) and AR; taiko also OD and slider multiplier.
    d.drainRate = Math.min(f(d.drainRate * f(1.4)), 10);
    if (rulesetId === 0 || rulesetId === 2) {
      d.overallDifficulty = Math.min(f(d.overallDifficulty * f(1.4)), 10);
      d.circleSize = Math.min(f(d.circleSize * f(1.3)), 10);
      d.approachRate = Math.min(f(d.approachRate * f(1.4)), 10);
    } else if (rulesetId === 1) {
      d.overallDifficulty = Math.min(f(d.overallDifficulty * f(1.4)), 10);
      d.sliderMultiplier *= (1.4 * 4) / 3;
    }
  }
  return d;
}

const PREEMPT = { min: 1800, mid: 1200, max: 450 };
const OSU_GREAT = { min: 80, mid: 50, max: 20 };
const TAIKO_GREAT = { min: 50, mid: 35, max: 20 };
const MANIA_PERFECT = { min: 22.4, mid: 19.4, max: 13.9 };

/** Ruleset.GetAdjustedDisplayDifficulty for the given ruleset ("effective" difficulty including rate changes). */
export function getAdjustedDisplayDifficulty(entry: BeatmapEntry, rulesetId: number, mods: ModSet): BeatmapDifficulty {
  const original = originalDifficulty(entry);
  const adjusted = modAdjustedDifficulty(original, rulesetId, mods);
  const rate = mods.rate;

  switch (rulesetId) {
    case 0: {
      const preempt = difficultyRange(adjusted.approachRate, PREEMPT) / rate;
      adjusted.approachRate = f(inverseDifficultyRange(preempt, PREEMPT.min, PREEMPT.mid, PREEMPT.max));
      const great = difficultyRange(adjusted.overallDifficulty, OSU_GREAT) / rate;
      adjusted.overallDifficulty = f(inverseDifficultyRange(great, OSU_GREAT.min, OSU_GREAT.mid, OSU_GREAT.max));
      break;
    }
    case 1: {
      const great = difficultyRange(adjusted.overallDifficulty, TAIKO_GREAT) / rate;
      adjusted.overallDifficulty = f(inverseDifficultyRange(great, TAIKO_GREAT.min, TAIKO_GREAT.mid, TAIKO_GREAT.max));
      break;
    }
    case 2: {
      const preempt = difficultyRange(adjusted.approachRate, PREEMPT) / rate;
      adjusted.approachRate = f(inverseDifficultyRange(preempt, PREEMPT.min, PREEMPT.mid, PREEMPT.max));
      break;
    }
    case 3: {
      // mania hit windows are independent of rate, but HR / EZ multiply the hit window durations directly.
      let perfect = difficultyRange(adjusted.overallDifficulty, MANIA_PERFECT);
      if (mods.has('HR')) perfect /= 1.4;
      else if (mods.has('EZ')) perfect /= 1 / 1.4;
      adjusted.overallDifficulty = f(inverseDifficultyRange(perfect, MANIA_PERFECT.min, MANIA_PERFECT.mid, MANIA_PERFECT.max));
      adjusted.circleSize = maniaColumnCount(entry, mods);
      break;
    }
  }

  return adjusted;
}

function originalDifficulty(entry: BeatmapEntry): BeatmapDifficulty {
  return Object.assign(new BeatmapDifficulty(), {
    circleSize: entry.circleSize,
    approachRate: entry.approachRate,
    overallDifficulty: entry.overallDifficulty,
    drainRate: entry.drainRate,
  });
}

export function maniaColumnCount(entry: BeatmapEntry, mods: ModSet | null): number {
  const keyMod = mods?.list.map(m => /^(\d+)K$/.exec(m)).find(Boolean);
  return ManiaBeatmapConverter.getColumnCount(
    {
      sourceRulesetId: entry.rulesetId,
      drainRate: f(entry.drainRate),
      approachRate: f(entry.approachRate),
      circleSize: f(entry.circleSize),
      overallDifficulty: f(entry.overallDifficulty),
      endTimeObjectCount: (entry as BeatmapEntry & { endTimeObjectCount?: number }).endTimeObjectCount ?? -1,
      totalObjectCount: entry.objectCount,
    },
    keyMod ? parseInt(keyMod[1], 10) : null,
  );
}

/** Ruleset.GetBeatmapAttributesForDisplay */
export function getBeatmapAttributesForDisplay(entry: BeatmapEntry, rulesetId: number, mods: ModSet): RulesetBeatmapAttribute[] {
  const o = originalDifficulty(entry);
  const e = getAdjustedDisplayDifficulty(entry, rulesetId, mods);
  const attr = (label: string, acronym: string, originalValue: number, adjustedValue: number, maxValue = 10): RulesetBeatmapAttribute => ({ label, acronym, originalValue, adjustedValue, maxValue });

  switch (rulesetId) {
    case 0:
      return [attr('Circle Size', 'CS', o.circleSize, e.circleSize), attr('Approach Rate', 'AR', o.approachRate, e.approachRate), attr('Accuracy', 'OD', o.overallDifficulty, e.overallDifficulty), attr('HP Drain', 'HP', o.drainRate, e.drainRate)];
    case 1:
      return [attr('Accuracy', 'OD', o.overallDifficulty, e.overallDifficulty), attr('HP Drain', 'HP', o.drainRate, e.drainRate), attr('Scroll Speed', 'SS', 1, f(e.sliderMultiplier / o.sliderMultiplier), 4)];
    case 2:
      return [attr('Circle Size', 'CS', o.circleSize, e.circleSize), attr('Approach Rate', 'AR', o.approachRate, e.approachRate), attr('HP Drain', 'HP', o.drainRate, e.drainRate)];
    default:
      return [attr('Key Count', 'KC', maniaColumnCount(entry, null), e.circleSize, 18), attr('Accuracy', 'OD', o.overallDifficulty, e.overallDifficulty), attr('HP Drain', 'HP', o.drainRate, e.drainRate)];
  }
}

/** ToLocalisableString("0.##") */
export function format0dd(v: number): string {
  return (Math.round(v * 100) / 100).toString();
}
