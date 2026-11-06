// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// The contract between the shared game (player, scoring, UI) and each ruleset.
// Mirrors osu.Game/Rulesets/Ruleset.cs + DrawableRuleset at a much smaller surface.

import type { HitSampleInfo } from '../audio/HitSampleInfo';
import type { Beatmap, BreakPeriod } from '../beatmaps/Beatmap';
import type { BeatmapDifficulty } from '../beatmaps/Difficulty';
import type { ModSet } from '../mods/Mods';
import type { HealthProcessor } from '../scoring/HealthProcessor';
import type { HitResult } from '../scoring/HitResult';
import type { JudgementResult } from '../scoring/Judgement';
import type { ScoreProcessor } from '../scoring/ScoreProcessor';
import type { Skin } from '../Skin';

export type RulesetShortName = 'osu' | 'taiko' | 'fruits' | 'mania';

export interface RulesetAction {
  id: string;
  label: string;
}

/** A looping sample (slider slide, spinner spin). */
export interface LoopHandle {
  setVolume(v: number): void;
  setRate(rate: number): void;
  setPan(pan: number): void;
  stop(): void;
}

/** User settings rulesets may read. Unknown keys fall back to the provided default. */
export interface GameplaySettings {
  get<T>(key: string, fallback: T): T;
}

export interface GameplayContext {
  readonly mods: ModSet;
  readonly skin: Skin;
  readonly settings: GameplaySettings;
  /** True when the Autoplay / Cinema mods are active: the ruleset must play itself perfectly. */
  readonly autoplay: boolean;
  /** Gameplay clock rate (1.5 for DT, 0.75 for HT). */
  readonly rate: number;
  /** Report a judgement to the score / health processors. */
  applyResult(result: JudgementResult): void;
  /** Play hit samples. `pan` ranges from -1 (left) to 1 (right). */
  playSamples(samples: readonly HitSampleInfo[], options?: { pan?: number; volume?: number; rate?: number }): void;
  /** Start a looping sample, e.g. "sliderslide" or "spinnerspin". */
  startLoop(sample: HitSampleInfo, options?: { pan?: number; volume?: number }): LoopHandle | null;
  /** Whether a ruleset action is currently held. */
  isPressed(action: string): boolean;
  /** Current combo (for rulesets which draw combo in the playfield, e.g. taiko / mania). */
  readonly combo: number;
  /** Current health in [0, 1]. */
  readonly health: number;
}

/** A beatmap converted for a ruleset with mods applied, ready to play. */
export interface PlayableBeatmap<T = unknown> {
  readonly source: Beatmap;
  readonly ruleset: Ruleset;
  /** Difficulty after mods. */
  readonly difficulty: BeatmapDifficulty;
  readonly mods: ModSet;
  readonly hitObjects: T[];
  readonly breaks: BreakPeriod[];
  /** Start/end time of every top-level hit object (used for break / drain logic and progress). */
  readonly objectTimes: { start: number; end: number }[];
  /** Judgements of a perfect play, in chronological order. Used to compute score maxima & health drain. */
  perfectResults(): JudgementResult[];
  /** Ruleset-specific binding variant (e.g. "4K" for mania). */
  readonly variant?: string;
}

export interface DrawableRuleset {
  /** Advance gameplay to `time` (ms). Judgements are emitted through the context. */
  update(time: number, elapsed: number): void;
  /** Draw into a canvas sized `width` x `height` CSS pixels (context is already DPR-scaled). */
  render(ctx: CanvasRenderingContext2D, width: number, height: number, time: number): void;
  onPressed(action: string, time: number): void;
  onReleased(action: string, time: number): void;
  /** Pointer position in CSS pixels relative to the canvas. */
  onPointerMove?(x: number, y: number, time: number): void;
  onTouchStart?(id: number, x: number, y: number, time: number): void;
  onTouchMove?(id: number, x: number, y: number, time: number): void;
  onTouchEnd?(id: number, x: number, y: number, time: number): void;
  /** True once every hit object has been judged. */
  readonly hasCompleted: boolean;
  /** Whether the ruleset draws its own cursor (hide the system one). */
  readonly drawsCursor?: boolean;
  /** Extra time (ms) the ruleset needs before the first object (e.g. approach / scroll time). */
  readonly leadInTime?: number;
  dispose?(): void;
}

export interface Ruleset {
  readonly id: 0 | 1 | 2 | 3;
  readonly shortName: RulesetShortName;
  readonly name: string;
  /** Mod acronyms this ruleset supports. */
  readonly availableMods: readonly string[];
  /** Input actions for a given variant (mania key counts vary). */
  actions(variant?: string): RulesetAction[];
  /** Default bindings: action id -> list of KeyboardEvent.code (and "Mouse0" / "Mouse2"). */
  defaultBindings(variant?: string): Record<string, string[]>;
  /** Whether a decoded beatmap can be played in this ruleset (native or via conversion). */
  canConvert(beatmap: Beatmap): boolean;
  /** Convert + apply mods + process (combo, stacking, etc). */
  createPlayable(beatmap: Beatmap, mods: ModSet): PlayableBeatmap;
  createDrawableRuleset(playable: PlayableBeatmap, ctx: GameplayContext): DrawableRuleset;
  createScoreProcessor(playable: PlayableBeatmap): ScoreProcessor;
  createHealthProcessor(playable: PlayableBeatmap, drainStartTime: number): HealthProcessor;
  /** Score multiplier for a mod combination. */
  scoreMultiplier(mods: ModSet, playable?: PlayableBeatmap): number;
  /** Hit results to list on the results screen, best first. */
  readonly displayedResults: readonly HitResult[];
  /** Short label for a hit result (e.g. "300", "GREAT"). */
  resultLabel(result: HitResult): string;
  /** Star rating of a playable beatmap (optional; 0 when not implemented). */
  starRating?(playable: PlayableBeatmap): number;
}
