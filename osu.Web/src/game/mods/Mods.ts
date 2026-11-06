// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Shared mod definitions (port of the common mods in osu.Game/Rulesets/Mods).

import { BeatmapDifficulty } from '../beatmaps/Difficulty';

export type ModType = 'reduction' | 'increase' | 'conversion' | 'automation' | 'fun';

export interface ModDef {
  acronym: string;
  name: string;
  description: string;
  type: ModType;
  incompatible: string[];
  /** Mods which are only offered by some rulesets list them here (otherwise available to all). */
  rulesets?: string[];
  /** Whether a score set with this mod should be stored (autoplay-like mods are not ranked locally). */
  unranked?: boolean;
}

const KEY_MODS = Array.from({ length: 10 }, (_, i) => `${i + 1}K`);

export const MODS: ModDef[] = [
  { acronym: 'EZ', name: 'Easy', description: 'Larger circles, more forgiving HP drain, less accuracy required, and extra lives!', type: 'reduction', incompatible: ['HR', 'AC', 'DA'] },
  { acronym: 'NF', name: 'No Fail', description: "You can't fail, no matter what.", type: 'reduction', incompatible: ['SD', 'PF', 'AT', 'CN', 'RX'] },
  { acronym: 'HT', name: 'Half Time', description: 'Less zoom...', type: 'reduction', incompatible: ['DT', 'NC', 'DC'] },
  { acronym: 'DC', name: 'Daycore', description: 'Whoaaaaa...', type: 'reduction', incompatible: ['DT', 'NC', 'HT'] },
  { acronym: 'HR', name: 'Hard Rock', description: 'Everything just got a bit harder...', type: 'increase', incompatible: ['EZ', 'DA', 'MR'] },
  { acronym: 'SD', name: 'Sudden Death', description: 'Miss and fail.', type: 'increase', incompatible: ['NF', 'PF', 'AT', 'CN', 'RX'] },
  { acronym: 'PF', name: 'Perfect', description: 'SS or quit.', type: 'increase', incompatible: ['NF', 'SD', 'AT', 'CN', 'RX'] },
  { acronym: 'DT', name: 'Double Time', description: 'Zoooooooooom...', type: 'increase', incompatible: ['HT', 'DC', 'NC'] },
  { acronym: 'NC', name: 'Nightcore', description: 'Uguuuuuuuu...', type: 'increase', incompatible: ['HT', 'DC', 'DT'] },
  { acronym: 'HD', name: 'Hidden', description: 'Play with no approach circles and fading circles/sliders.', type: 'increase', incompatible: ['FI'] },
  { acronym: 'FI', name: 'Fade In', description: 'Keys appear out of nowhere!', type: 'increase', incompatible: ['HD', 'FL'], rulesets: ['mania'] },
  { acronym: 'FL', name: 'Flashlight', description: 'Restricted view area.', type: 'increase', incompatible: ['FI'] },
  { acronym: 'AC', name: 'Accuracy Challenge', description: 'Fail if your accuracy drops too low!', type: 'increase', incompatible: ['EZ', 'NF', 'AT', 'CN'] },
  { acronym: 'DA', name: 'Difficulty Adjust', description: 'Override a beatmap\'s difficulty settings.', type: 'conversion', incompatible: ['EZ', 'HR'], unranked: true },
  { acronym: 'MR', name: 'Mirror', description: 'Flip objects on the chosen axes.', type: 'conversion', incompatible: ['HR'], rulesets: ['osu', 'fruits', 'mania'] },
  { acronym: 'RD', name: 'Random', description: 'It never gets boring!', type: 'conversion', incompatible: [], rulesets: ['taiko', 'mania'], unranked: true },
  ...KEY_MODS.map(
    (k): ModDef => ({
      acronym: k,
      name: `${k.slice(0, -1)} Keys`,
      description: `Play with ${k.slice(0, -1)} keys.`,
      type: 'conversion',
      incompatible: KEY_MODS.filter(o => o !== k),
      rulesets: ['mania'],
    }),
  ),
  { acronym: 'AT', name: 'Autoplay', description: 'Watch a perfect automated play through the song.', type: 'automation', incompatible: ['NF', 'SD', 'PF', 'RX', 'AP', 'SO', 'CN', 'AC'], unranked: true },
  { acronym: 'CN', name: 'Cinema', description: 'Watch the video without visual distractions.', type: 'automation', incompatible: ['NF', 'SD', 'PF', 'RX', 'AP', 'SO', 'AT', 'AC', 'FL', 'HD'], unranked: true },
  { acronym: 'RX', name: 'Relax', description: "You don't need to click. Give your clicking/tapping fingers a break from the heat of things.", type: 'automation', incompatible: ['NF', 'SD', 'PF', 'AT', 'CN', 'AP'], rulesets: ['osu', 'taiko', 'fruits'], unranked: true },
  { acronym: 'AP', name: 'Autopilot', description: 'Automatic cursor movement - just follow the rhythm.', type: 'automation', incompatible: ['RX', 'AT', 'CN', 'SO'], rulesets: ['osu'], unranked: true },
  { acronym: 'SO', name: 'Spun Out', description: 'Spinners will be automatically completed.', type: 'automation', incompatible: ['AT', 'CN', 'AP'], rulesets: ['osu'] },
];

export const MOD_BY_ACRONYM = new Map(MODS.map(m => [m.acronym, m]));

export const MOD_TYPE_COLOURS: Record<ModType, string> = {
  reduction: '#b2ff66',
  increase: '#ff6666',
  conversion: '#8c66ff',
  automation: '#66ccff',
  fun: '#ff66aa',
};

export class ModSet {
  readonly acronyms: ReadonlySet<string>;

  constructor(acronyms: Iterable<string> = []) {
    this.acronyms = new Set(acronyms);
  }

  has(acronym: string): boolean {
    return this.acronyms.has(acronym);
  }

  get list(): string[] {
    // Keep display order consistent with the MODS table.
    return MODS.filter(m => this.acronyms.has(m.acronym)).map(m => m.acronym);
  }

  get isEmpty(): boolean {
    return this.acronyms.size === 0;
  }

  /** Toggles a mod, removing incompatible ones. */
  toggle(acronym: string): ModSet {
    const next = new Set(this.acronyms);
    if (next.has(acronym)) {
      next.delete(acronym);
      return new ModSet(next);
    }
    const def = MOD_BY_ACRONYM.get(acronym);
    if (def) {
      for (const inc of def.incompatible) next.delete(inc);
      for (const other of [...next]) if (MOD_BY_ACRONYM.get(other)?.incompatible.includes(acronym)) next.delete(other);
    }
    next.add(acronym);
    return new ModSet(next);
  }

  /** Filters to mods offered by a ruleset. */
  forRuleset(shortName: string, available: readonly string[]): ModSet {
    return new ModSet([...this.acronyms].filter(a => available.includes(a) && (!MOD_BY_ACRONYM.get(a)?.rulesets || MOD_BY_ACRONYM.get(a)!.rulesets!.includes(shortName))));
  }

  /** Gameplay clock rate after rate-adjust mods. */
  get rate(): number {
    if (this.has('DT') || this.has('NC')) return 1.5;
    if (this.has('HT') || this.has('DC')) return 0.75;
    return 1;
  }

  /** Whether the music pitch is preserved when rate adjusting (Nightcore / Daycore change pitch). */
  get preservePitch(): boolean {
    return !(this.has('NC') || this.has('DC'));
  }

  get isAutoplay(): boolean {
    return this.has('AT') || this.has('CN');
  }

  get isRanked(): boolean {
    return !this.list.some(a => MOD_BY_ACRONYM.get(a)?.unranked);
  }

  toString(): string {
    return this.list.join('');
  }
}

/**
 * Applies ModEasy / ModHardRock difficulty adjustments.
 * @param adjustCircleSize false for rulesets where CS has other meaning (mania key count, taiko).
 */
export function applyCommonDifficultyMods(d: BeatmapDifficulty, mods: ModSet, adjustCircleSize = true): BeatmapDifficulty {
  const out = d.clone();
  // C# stores these as floats and multiplies in single precision.
  const f = Math.fround;
  if (mods.has('EZ')) {
    const ratio = f(0.5);
    if (adjustCircleSize) out.circleSize = f(out.circleSize * ratio);
    out.approachRate = f(out.approachRate * ratio);
    out.drainRate = f(out.drainRate * ratio);
    out.overallDifficulty = f(out.overallDifficulty * ratio);
  }
  if (mods.has('HR')) {
    const ratio = f(1.4);
    if (adjustCircleSize) out.circleSize = Math.min(f(out.circleSize * f(1.3)), 10.0); // CS uses a custom 1.3 ratio.
    out.approachRate = Math.min(f(out.approachRate * ratio), 10.0);
    out.drainRate = Math.min(f(out.drainRate * ratio), 10.0);
    out.overallDifficulty = Math.min(f(out.overallDifficulty * ratio), 10.0);
  }
  return out;
}

/** osu!stable-style rate adjust score multiplier (OsuScoreMultiplierCalculatorV1.rateAdjustMultiplier). */
export function rateAdjustMultiplier(speedChange: number): number {
  let value = Math.trunc(speedChange * 10) / 10.0;
  value -= 1;
  return speedChange >= 1 ? 1 + value / 5 : 0.6 + value;
}
