// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Pure logic used by the results screen, ported from:
//  - osu.Game/Rulesets/Scoring/HitEventExtensions.cs (CalculateUnstableRate, CalculateAverageHitError, AffectsUnstableRate)
//  - osu.Game/Screens/Ranking/Statistics/HitEventTimingDistributionGraph.cs (binning)
//  - osu.Game/Screens/Ranking/Expanded/Accuracy/AccuracyCircle.cs (target accuracy, badge timings, inverseEasing)
//  - osu.Game/Scoring/ScoreInfoExtensions.cs GetStatisticsForDisplay + Ruleset.GetHitResultsForDisplay,
//    the rulesets' GetValidHitResults / GetDisplayNameForHitResult, HitResult [Order] / [Description]
//  - osu.Game/Utils/FormatUtils.cs (FormatAccuracy), osu.Game/Graphics/OsuColour.cs (ForRank, ForHitResult)

import { applyEasing, Easing } from '../../game/storyboard/Easing';
import { HitResult, isBasic, isHit } from '../../game/scoring/HitResult';
import { EmptyHitWindows } from '../../game/scoring/HitWindows';
import type { HitEvent } from '../../game/scoring/ScoreProcessor';
import type { ScoreRank } from '../../game/scoring/ScoreRank';

// ------------------------------------------------------------------ ranks

/** ScoreRank enum order (F < D < C < B < A < S < SH < X < XH). */
const RANK_ORDER: ScoreRank[] = ['F', 'D', 'C', 'B', 'A', 'S', 'SH', 'X', 'XH'];
export const rankValue = (r: ScoreRank): number => RANK_ORDER.indexOf(r);

/** OsuColour.ForRank. */
export function rankColour(rank: ScoreRank): string {
  switch (rank) {
    case 'XH':
    case 'X':
      return '#de31ae';
    case 'SH':
    case 'S':
      return '#02b5c3';
    case 'A':
      return '#88da20';
    case 'B':
      return '#e3b130';
    case 'C':
      return '#ff8e5d';
    case 'D':
      return '#ff5a5a';
    default:
      return '#3f3f3f';
  }
}

/** DrawableRank.GetRankLetter. */
export function rankLetter(rank: ScoreRank): string {
  switch (rank) {
    case 'SH':
      return 'S';
    case 'X':
    case 'XH':
      return 'SS';
    default:
      return rank;
  }
}

/** DrawableRank.GetRankLetterColour: [top, bottom] of the (possibly vertical gradient) letter colour. */
export function rankLetterColour(rank: ScoreRank): [string, string] {
  switch (rank) {
    case 'XH':
    case 'SH':
      return ['#ffffff', '#afdff0'];
    case 'X':
    case 'S':
      return ['#ffe7a8', '#ffb800'];
    case 'A':
      return ['#275227', '#275227'];
    case 'B':
      return ['#553a2b', '#553a2b'];
    case 'C':
      return ['#473625', '#473625'];
    case 'D':
      return ['#512525', '#512525'];
    default:
      return ['#CC3333', '#CC3333'];
  }
}

/** ScoreProcessor.AccuracyCutoffFromRank (same for every ruleset). */
export function accuracyCutoffFromRank(rank: ScoreRank): number {
  switch (rank) {
    case 'X':
    case 'XH':
      return 1;
    case 'S':
    case 'SH':
      return 0.95;
    case 'A':
      return 0.9;
    case 'B':
      return 0.8;
    case 'C':
      return 0.7;
    case 'D':
      return 0;
    default:
      throw new Error(`no cutoff for ${rank}`);
  }
}

// ------------------------------------------------------------------ hit events

function hasHitWindows(hitObject: unknown): boolean {
  if (hitObject == null || typeof hitObject !== 'object') return true;
  if (!('hitWindows' in hitObject)) return true;
  const hw = (hitObject as { hitWindows: unknown }).hitWindows;
  return hw != null && !(hw instanceof EmptyHitWindows);
}

/** HitEventExtensions.AffectsUnstableRate: HitWindows != Empty && result.IsHit(). */
export function affectsUnstableRate(e: HitEvent): boolean {
  return hasHitWindows(e.hitObject) && isHit(e.result);
}

/** CalculateUnstableRate (Welford's online algorithm); null when no events affect it. */
export function calculateUnstableRate(hitEvents: readonly HitEvent[]): number | null {
  let count = 0;
  let mean = 0;
  let sumOfSquares = 0;
  for (const e of hitEvents) {
    if (!affectsUnstableRate(e)) continue;
    count++;
    // Division by gameplay rate is to account for TimeOffset scaling with gameplay rate.
    const current = e.timeOffset / (e.gameplayRate || 1);
    const nextMean = mean + (current - mean) / count;
    sumOfSquares += (current - mean) * (current - nextMean);
    mean = nextMean;
  }
  if (count === 0) return null;
  return 10.0 * Math.sqrt(sumOfSquares / count);
}

/** CalculateAverageHitError (raw time offsets, negative = early). */
export function calculateAverageHitError(hitEvents: readonly HitEvent[]): number | null {
  let sum = 0;
  let n = 0;
  for (const e of hitEvents) {
    if (!affectsUnstableRate(e)) continue;
    sum += e.timeOffset;
    n++;
  }
  return n === 0 ? null : sum / n;
}

export const TIMING_DISTRIBUTION_BINS = 50;
export const TOTAL_TIMING_DISTRIBUTION_BINS = TIMING_DISTRIBUTION_BINS * 2 + 1;
export const TIMING_DISTRIBUTION_CENTRE_BIN_INDEX = TIMING_DISTRIBUTION_BINS;

/** The events the timing distribution graph shows (HitWindows != Empty, basic hit results). */
export function timingGraphEvents(hitEvents: readonly HitEvent[]): HitEvent[] {
  return hitEvents.filter(e => hasHitWindows(e.hitObject) && isBasic(e.result) && isHit(e.result));
}

/** binSize = max(1, ceil(max |offset| / 50)). */
export function timingBinSize(events: readonly HitEvent[]): number {
  let max = 0;
  for (const e of events) max = Math.max(max, Math.abs(e.timeOffset));
  return Math.max(1, Math.ceil(max / TIMING_DISTRIBUTION_BINS));
}

/** .NET Math.Round(x, MidpointRounding.AwayFromZero). */
export const roundAwayFromZero = (x: number): number => Math.sign(x) * Math.round(Math.abs(x));

/** HitEventTimingDistributionGraph.updateDisplay binning: 101 bins of per-result counts. */
export function binTimingDistribution(events: readonly HitEvent[], binSize: number, hitOffset = 0): Map<HitResult, number>[] {
  const bins = Array.from({ length: TOTAL_TIMING_DISTRIBUTION_BINS }, () => new Map<HitResult, number>());
  let roundUp = true;
  for (const e of events) {
    const time = e.timeOffset + hitOffset;
    let binOffset = time / binSize;
    // Cycle between downwards and upwards rounding for midpoints so they distribute evenly to adjacent buckets.
    if (Math.abs(binOffset - Math.trunc(binOffset)) === 0.5) {
      binOffset = Math.trunc(binOffset) + Math.sign(binOffset) * (roundUp ? 1 : 0);
      roundUp = !roundUp;
    }
    const index = TIMING_DISTRIBUTION_CENTRE_BIN_INDEX + roundAwayFromZero(binOffset);
    if (index >= 0 && index < bins.length) bins[index].set(e.result, (bins[index].get(e.result) ?? 0) + 1);
  }
  return bins;
}

// ------------------------------------------------------------------ accuracy circle

export const APPEAR_DURATION = 200;
export const ACCURACY_TRANSFORM_DELAY = 450;
export const ACCURACY_TRANSFORM_DURATION = 3000;
export const TOTAL_DURATION = APPEAR_DURATION + ACCURACY_TRANSFORM_DELAY + ACCURACY_TRANSFORM_DURATION;
export const TEXT_APPEAR_DELAY = ACCURACY_TRANSFORM_DURATION / 2;
export const RANK_CIRCLE_TRANSFORM_DELAY = 150;
export const RANK_CIRCLE_TRANSFORM_DURATION = 800;
export const RANK_CIRCLE_RADIUS = 0.05;
export const ACCURACY_CIRCLE_RADIUS = 0.2;
export const VIRTUAL_SS_PERCENTAGE = 0.01;
export const GRADE_SPACING_PERCENTAGE = 2.0 / 360;
export const ACCURACY_TRANSFORM_EASING = Easing.OutPow10;
const VISUAL_ALIGNMENT_OFFSET = 0.001;

/** The accuracy the gauge fills to (AccuracyCircle.LoadComplete). */
export function accuracyCircleTarget(accuracy: number, rank: ScoreRank): number {
  let targetAccuracy = accuracy;
  const notchPercentages = [accuracyCutoffFromRank('S'), accuracyCutoffFromRank('A'), accuracyCutoffFromRank('B'), accuracyCutoffFromRank('C')];
  // Overshoot / undershoot a bit so the gauge doesn't land in the gaps of the inner graded circle.
  for (const p of notchPercentages) {
    if (Math.abs(p - targetAccuracy) <= GRADE_SPACING_PERCENTAGE / 2) {
      const tippingDirection = targetAccuracy - p >= 0 ? 1 : -1;
      targetAccuracy = p + tippingDirection * (GRADE_SPACING_PERCENTAGE / 2);
      break;
    }
  }
  if (rank === 'X' || rank === 'XH') targetAccuracy = 1;
  else targetAccuracy = Math.min(accuracyCutoffFromRank('X') - VIRTUAL_SS_PERCENTAGE - GRADE_SPACING_PERCENTAGE / 2, targetAccuracy);
  if (targetAccuracy < 1 && targetAccuracy >= VISUAL_ALIGNMENT_OFFSET) targetAccuracy -= VISUAL_ALIGNMENT_OFFSET;
  return targetAccuracy;
}

/** The gauge position after a failed-S (S accuracy, A rank due to misses) drops back. */
export const failedSTarget = (): number => accuracyCutoffFromRank('S') - GRADE_SPACING_PERCENTAGE / 2 - VISUAL_ALIGNMENT_OFFSET;

/** AccuracyCircle.inverseEasing: binary-ish search for the progress at which the easing reaches `targetValue`. */
export function inverseEasing(easing: Easing, targetValue: number): number {
  let test = 0;
  let result = 0;
  let count = 2;
  let guard = 0;
  while (Math.abs(result - targetValue) > 0.005 && guard++ < 100000) {
    const dir = Math.sign(targetValue - result);
    test += (dir * 1.0) / count;
    result = applyEasing(easing, test);
    count++;
  }
  return test;
}

export interface BadgeDef {
  rank: ScoreRank;
  accuracy: number;
  displayPosition: number;
}

/** The six rank badges around the accuracy circle (with `adjust` = the mods' AdjustRank, e.g. Hidden's silver ranks). */
export function rankBadges(adjust: (r: ScoreRank) => ScoreRank = r => r): BadgeDef[] {
  const x = accuracyCutoffFromRank('X');
  const s = accuracyCutoffFromRank('S');
  const a = accuracyCutoffFromRank('A');
  const b = accuracyCutoffFromRank('B');
  const c = accuracyCutoffFromRank('C');
  const d = accuracyCutoffFromRank('D');
  const lerp = (p: number, q: number, t: number) => p + (q - p) * t;
  return [
    { accuracy: d, displayPosition: lerp(d, c, 0.5), rank: adjust('D') },
    { accuracy: c, displayPosition: lerp(c, b, 0.5), rank: adjust('C') },
    { accuracy: b, displayPosition: lerp(b, a, 0.5), rank: adjust('B') },
    // The S and A badges are moved down slightly to prevent collision with the SS badge.
    { accuracy: a, displayPosition: lerp(a, s, 0.25), rank: adjust('A') },
    { accuracy: s, displayPosition: lerp(s, x - VIRTUAL_SS_PERCENTAGE, 0.25), rank: adjust('S') },
    { accuracy: x, displayPosition: x, rank: adjust('X') },
  ];
}

/** Delay (from ACCURACY_TRANSFORM_DELAY) at which a badge appears while the gauge fills. */
export function badgeAppearDelay(badgeAccuracy: number, targetAccuracy: number): number {
  const x = accuracyCutoffFromRank('X');
  return inverseEasing(ACCURACY_TRANSFORM_EASING, Math.min(x - VIRTUAL_SS_PERCENTAGE, badgeAccuracy) / targetAccuracy) * ACCURACY_TRANSFORM_DURATION;
}

// ------------------------------------------------------------------ statistics for display

/** HitResult [Order] attribute values (GetValuesInOrder / GetIndexForOrderedDisplay). */
const HIT_RESULT_ORDER: HitResult[] = [
  HitResult.Perfect,
  HitResult.Great,
  HitResult.Good,
  HitResult.Ok,
  HitResult.Meh,
  HitResult.Miss,
  HitResult.LargeTickHit,
  HitResult.SmallTickHit,
  HitResult.SliderTailHit,
  HitResult.LargeBonus,
  HitResult.SmallBonus,
  HitResult.LargeTickMiss,
  HitResult.SmallTickMiss,
  HitResult.IgnoreHit,
  HitResult.IgnoreMiss,
  HitResult.None,
  HitResult.ComboBreak,
];

export const indexForOrderedDisplay = (r: HitResult): number => HIT_RESULT_ORDER.indexOf(r);

/** The rulesets' GetValidHitResults (by ruleset id: osu, taiko, catch, mania). */
const VALID_HIT_RESULTS: HitResult[][] = [
  [HitResult.Great, HitResult.Ok, HitResult.Meh, HitResult.Miss, HitResult.LargeTickHit, HitResult.LargeTickMiss, HitResult.SmallTickHit, HitResult.SmallTickMiss, HitResult.SliderTailHit, HitResult.SmallBonus, HitResult.LargeBonus, HitResult.IgnoreHit, HitResult.IgnoreMiss, HitResult.ComboBreak],
  [HitResult.Great, HitResult.Ok, HitResult.Miss, HitResult.SmallBonus, HitResult.LargeBonus, HitResult.IgnoreHit, HitResult.IgnoreMiss],
  [HitResult.Great, HitResult.Miss, HitResult.LargeTickHit, HitResult.LargeTickMiss, HitResult.SmallTickHit, HitResult.SmallTickMiss, HitResult.LargeBonus, HitResult.IgnoreHit, HitResult.IgnoreMiss],
  [HitResult.Perfect, HitResult.Great, HitResult.Good, HitResult.Ok, HitResult.Meh, HitResult.Miss, HitResult.IgnoreHit, HitResult.ComboBreak, HitResult.IgnoreMiss],
];

/** HitResult [Description] values. */
function hitResultDescription(r: HitResult): string {
  switch (r) {
    case HitResult.Miss:
      return 'Miss';
    case HitResult.Meh:
      return 'Meh';
    case HitResult.Ok:
      return 'OK';
    case HitResult.Good:
      return 'Good';
    case HitResult.Great:
      return 'Great';
    case HitResult.Perfect:
      return 'Perfect';
    case HitResult.SmallTickHit:
      return 'S Tick';
    case HitResult.LargeTickHit:
      return 'L Tick';
    case HitResult.SmallBonus:
      return 'S Bonus';
    case HitResult.LargeBonus:
      return 'L Bonus';
    default:
      return HitResult[r];
  }
}

/** Ruleset.GetDisplayNameForHitResult (with each ruleset's overrides). */
export function hitResultDisplayName(rulesetId: number, r: HitResult): string {
  switch (rulesetId) {
    case 0:
      if (r === HitResult.LargeTickHit) return 'slider tick';
      if (r === HitResult.SliderTailHit || r === HitResult.SmallTickHit) return 'slider end';
      if (r === HitResult.SmallBonus) return 'spinner spin';
      if (r === HitResult.LargeBonus) return 'spinner bonus';
      break;
    case 1:
      if (r === HitResult.SmallBonus) return 'drum tick';
      if (r === HitResult.LargeBonus) return 'bonus';
      break;
    case 2:
      if (r === HitResult.LargeTickHit) return 'Large droplet';
      if (r === HitResult.SmallTickHit) return 'Small droplet';
      if (r === HitResult.LargeBonus) return 'Banana';
      break;
  }
  return hitResultDescription(r);
}

export interface HitResultDisplayStatistic {
  result: HitResult;
  count: number;
  maxCount: number | null;
  displayName: string;
}

/** ScoreInfoExtensions.GetStatisticsForDisplay. */
export function statisticsForDisplay(rulesetId: number, statistics: ReadonlyMap<HitResult, number>, maximumStatistics: ReadonlyMap<HitResult, number>): HitResultDisplayStatistic[] {
  const valid = VALID_HIT_RESULTS[rulesetId] ?? VALID_HIT_RESULTS[0];
  const out: HitResultDisplayStatistic[] = [];
  for (const r of HIT_RESULT_ORDER) {
    switch (r) {
      case HitResult.None:
      case HitResult.IgnoreHit:
      case HitResult.IgnoreMiss:
      case HitResult.ComboBreak:
      case HitResult.LargeTickMiss:
      case HitResult.SmallTickMiss:
        continue;
    }
    if (r !== HitResult.Miss && !valid.includes(r)) continue;
    const value = statistics.get(r) ?? 0;
    const displayName = hitResultDisplayName(rulesetId, r);
    switch (r) {
      case HitResult.SmallTickHit:
      case HitResult.LargeTickHit:
      case HitResult.SliderTailHit:
      case HitResult.LargeBonus:
      case HitResult.SmallBonus: {
        const count = maximumStatistics.get(r) ?? 0;
        if (count > 0) out.push({ result: r, count: value, maxCount: count, displayName });
        break;
      }
      default:
        out.push({ result: r, count: value, maxCount: null, displayName });
    }
  }
  return out;
}

/** OsuColour.ForHitResult. */
export function hitResultColour(r: HitResult): string {
  switch (r) {
    case HitResult.IgnoreMiss:
    case HitResult.SmallTickMiss:
      return '#808080';
    case HitResult.Miss:
    case HitResult.LargeTickMiss:
    case HitResult.ComboBreak:
      return '#ed1121';
    case HitResult.Meh:
      return '#ffcc22';
    case HitResult.Ok:
      return '#88b300';
    case HitResult.Good:
      return '#b3d944';
    case HitResult.SmallTickHit:
    case HitResult.LargeTickHit:
    case HitResult.SliderTailHit:
    case HitResult.Great:
      return '#66ccff';
    default:
      return '#99eeff';
  }
}

// ------------------------------------------------------------------ formatting

/** FormatUtils.FormatAccuracy: floor to 4 decimal digits, "0.00%". */
export function formatAccuracy(accuracy: number): string {
  const floored = Math.floor(accuracy * 10000 + 1e-9) / 10000;
  return `${(floored * 100).toFixed(2)}%`;
}

/** FormatUtils.FormatStarRating: floor to 2 decimal digits, "0.00". */
export function formatStarRating(stars: number): string {
  return (Math.floor(stars * 100 + 1e-9) / 100).toFixed(2);
}

/** `ToString("N0")`. */
export const formatN0 = (n: number): string => Math.round(n).toLocaleString('en-US');

/** RankingStatisticsStrings.Early / Late ("{0:N2} ms early"). */
export function formatHitError(offset: number | null): string {
  if (offset == null) return '(not available)';
  const v = Math.abs(offset).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return offset < 0 ? `${v} ms early` : `${v} ms late`;
}

export function formatUnstableRate(ur: number | null): string {
  return ur == null ? '(not available)' : ur.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
