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

export type ModSettingValue = number | boolean | null;
export type ModSettings = Readonly<Record<string, Readonly<Record<string, ModSettingValue>>>>;

export interface ModSettingDef {
  key: string;
  label: string;
  kind: 'number' | 'boolean' | 'difficulty';
  min?: number;
  max?: number;
  step?: number;
  /** Default value (null for difficulty settings = "use the beatmap's value"). */
  default: ModSettingValue;
  /** Only shown for these rulesets. */
  rulesets?: string[];
}

/** Customisable mod settings ([SettingSource] properties in the C# mods). */
export const MOD_SETTINGS: Record<string, ModSettingDef[]> = {
  // ModDoubleTime / ModNightcore: SpeedChange 1.01..2, ModRateAdjust.AdjustPitch
  DT: [
    { key: 'speed', label: 'Speed change', kind: 'number', min: 1.01, max: 2, step: 0.01, default: 1.5 },
    { key: 'adjustPitch', label: 'Adjust pitch', kind: 'boolean', default: false },
  ],
  NC: [{ key: 'speed', label: 'Speed change', kind: 'number', min: 1.01, max: 2, step: 0.01, default: 1.5 }],
  // ModHalfTime / ModDaycore: SpeedChange 0.5..0.99
  HT: [
    { key: 'speed', label: 'Speed change', kind: 'number', min: 0.5, max: 0.99, step: 0.01, default: 0.75 },
    { key: 'adjustPitch', label: 'Adjust pitch', kind: 'boolean', default: false },
  ],
  DC: [{ key: 'speed', label: 'Speed change', kind: 'number', min: 0.5, max: 0.99, step: 0.01, default: 0.75 }],
  // ModDifficultyAdjust (+ ruleset variants: CS/AR only exist for osu! and osu!catch)
  DA: [
    { key: 'circleSize', label: 'Circle size', kind: 'difficulty', min: 0, max: 10, step: 0.1, default: null, rulesets: ['osu', 'fruits'] },
    { key: 'approachRate', label: 'Approach rate', kind: 'difficulty', min: 0, max: 10, step: 0.1, default: null, rulesets: ['osu', 'fruits'] },
    { key: 'drainRate', label: 'HP drain', kind: 'difficulty', min: 0, max: 10, step: 0.1, default: null },
    { key: 'overallDifficulty', label: 'Accuracy', kind: 'difficulty', min: 0, max: 10, step: 0.1, default: null },
  ],
  // ModAccuracyChallenge.MinimumAccuracy (AccuracyJudgeMode defaults to MaximumAchievable)
  AC: [{ key: 'minimumAccuracy', label: 'Minimum accuracy', kind: 'number', min: 0.6, max: 0.999, step: 0.001, default: 0.9 }],
};

export class ModSet {
  readonly acronyms: ReadonlySet<string>;
  readonly settings: ModSettings;

  constructor(acronyms: Iterable<string> = [], settings: ModSettings = {}) {
    this.acronyms = new Set(acronyms);
    this.settings = settings;
  }

  /** A mod setting value, falling back to its default. */
  setting<T extends ModSettingValue>(acronym: string, key: string): T {
    const v = this.settings[acronym]?.[key];
    if (v !== undefined) return v as T;
    return (MOD_SETTINGS[acronym]?.find(d => d.key === key)?.default ?? null) as T;
  }

  withSetting(acronym: string, key: string, value: ModSettingValue): ModSet {
    const forMod = { ...(this.settings[acronym] ?? {}), [key]: value };
    const def = MOD_SETTINGS[acronym]?.find(d => d.key === key);
    if (def && value === def.default) delete forMod[key];
    return new ModSet(this.acronyms, { ...this.settings, [acronym]: forMod });
  }

  /** Whether every setting of every selected mod is at its default (lazer: Ranked => SpeedChange.IsDefault). */
  get usesDefaultSettings(): boolean {
    return [...this.acronyms].every(a => Object.keys(this.settings[a] ?? {}).length === 0);
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
      return new ModSet(next, this.settings);
    }
    const def = MOD_BY_ACRONYM.get(acronym);
    if (def) {
      for (const inc of def.incompatible) next.delete(inc);
      for (const other of [...next]) if (MOD_BY_ACRONYM.get(other)?.incompatible.includes(acronym)) next.delete(other);
    }
    next.add(acronym);
    return new ModSet(next, this.settings);
  }

  /** Filters to mods offered by a ruleset. */
  forRuleset(shortName: string, available: readonly string[]): ModSet {
    return new ModSet(
      [...this.acronyms].filter(a => available.includes(a) && (!MOD_BY_ACRONYM.get(a)?.rulesets || MOD_BY_ACRONYM.get(a)!.rulesets!.includes(shortName))),
      this.settings,
    );
  }

  /** Gameplay clock rate after rate-adjust mods. */
  get rate(): number {
    for (const a of ['DT', 'NC', 'HT', 'DC']) if (this.has(a)) return this.setting<number>(a, 'speed');
    return 1;
  }

  /** Whether the music pitch is preserved when rate adjusting (Nightcore / Daycore, or "Adjust pitch", change pitch). */
  get preservePitch(): boolean {
    if (this.has('NC') || this.has('DC')) return false;
    for (const a of ['DT', 'HT']) if (this.has(a) && this.setting<boolean>(a, 'adjustPitch')) return false;
    return true;
  }

  get isAutoplay(): boolean {
    return this.has('AT') || this.has('CN');
  }

  get isRanked(): boolean {
    return !this.list.some(a => MOD_BY_ACRONYM.get(a)?.unranked) && this.usesDefaultSettings;
  }

  /** Display label for a mod including customised settings, e.g. "DT (1.30x)". */
  label(acronym: string): string {
    if (['DT', 'NC', 'HT', 'DC'].includes(acronym) && this.settings[acronym]?.speed !== undefined) return `${acronym} (${this.setting<number>(acronym, 'speed').toFixed(2)}x)`;
    return acronym;
  }

  toString(): string {
    return this.list.map(a => this.label(a)).join('') + (this.usesDefaultSettings ? '' : JSON.stringify(this.settings));
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

/**
 * ModDifficultyAdjust.ApplyToDifficulty: returns a shallow copy of the beatmap with overridden difficulty values.
 * Applied before conversion; DA is incompatible with EZ/HR so ordering relative to them doesn't matter.
 */
export function applyDifficultyAdjust<T extends { difficulty: BeatmapDifficulty }>(beatmap: T, mods: ModSet): T {
  if (!mods.has('DA')) return beatmap;
  const copy = Object.assign(Object.create(Object.getPrototypeOf(beatmap)), beatmap) as T;
  const d = beatmap.difficulty.clone();
  for (const key of ['circleSize', 'approachRate', 'drainRate', 'overallDifficulty'] as const) {
    const v = mods.setting<number | null>('DA', key);
    if (v != null) d[key] = Math.fround(v);
  }
  copy.difficulty = d;
  return copy;
}
