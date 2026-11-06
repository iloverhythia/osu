// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game.Rulesets.Taiko/Beatmaps/TaikoBeatmapConverter.cs (+ BeatmapConverter<T>.ConvertBeatmap and
// LegacyRulesetExtensions.GetPrecisionAdjustedBeatLength).

import type { HitSampleInfo } from '../../audio/HitSampleInfo';
import type { Beatmap, ConvertHitObject } from '../../beatmaps/Beatmap';
import { ControlPointInfo, EffectControlPoint, TimingControlPoint } from '../../beatmaps/ControlPoints';
import { difficultyRange } from '../../beatmaps/Difficulty';
import { DOUBLE_EPSILON, almostEquals } from '../../../framework/math';
import { DrumRoll, Hit, Swell, TaikoHitObject, TaikoStrongableHitObject, VELOCITY_MULTIPLIER } from './objects';

/** Because swells are easier in taiko than spinners are in osu!, legacy taiko multiplies a factor when converting the number of required hits. */
const SWELL_HIT_MULTIPLIER = Math.fround(1.65);
/** Base osu! slider scoring distance. */
const OSU_BASE_SCORING_DISTANCE = 100;

export function requiredSwellHitsPerSecond(overallDifficulty: number): number {
  return difficultyRange(overallDifficulty, 3, 5, 7.5) * SWELL_HIT_MULTIPLIER;
}

/** LegacyRulesetExtensions.GetPrecisionAdjustedBeatLength (taiko / mania branch). */
export function getPrecisionAdjustedBeatLength(sliderVelocityMultiplier: number, timingPoint: TimingControlPoint): number {
  const sliderVelocityAsBeatLength = -100 / sliderVelocityMultiplier;
  const bpmMultiplier = sliderVelocityAsBeatLength < 0 ? Math.min(Math.max(Math.fround(-sliderVelocityAsBeatLength), 10), 10000) / 100.0 : 1;
  return timingPoint.beatLength * bpmMultiplier;
}

export interface TaikoConversionResult {
  hitObjects: TaikoHitObject[];
  controlPoints: ControlPointInfo;
}

function cloneControlPoints(src: ControlPointInfo): ControlPointInfo {
  const cp = new ControlPointInfo();
  cp.timingPoints.push(...src.timingPoints);
  cp.difficultyPoints.push(...src.difficultyPoints);
  cp.effectPoints.push(...src.effectPoints);
  cp.samplePoints.push(...src.samplePoints);
  return cp;
}

export class TaikoBeatmapConverter {
  private readonly isForCurrentRuleset: boolean;

  constructor(private readonly beatmap: Beatmap) {
    this.isForCurrentRuleset = beatmap.rulesetId === 1;
  }

  canConvert(): boolean {
    return true;
  }

  convert(): TaikoConversionResult {
    const original = this.beatmap;
    // BeatmapConverter deep-clones the control points so that post-processing doesn't affect the source beatmap.
    const controlPoints = cloneControlPoints(original.controlPoints);

    const converted: TaikoHitObject[] = [];
    for (const h of original.hitObjects) converted.push(...this.convertHitObject(h));
    // OrderBy is a stable sort.
    let hitObjects = converted.map((h, i) => ({ h, i })).sort((a, b) => a.h.startTime - b.h.startTime || a.i - b.i).map(x => x.h);

    if (original.rulesetId === 0) {
      // Post processing step to transform standard slider velocity changes into scroll speed changes
      let lastScrollSpeed = 1;
      for (const h of original.hitObjects) {
        if (h.kind !== 'slider') continue; // only ConvertSlider implements IHasSliderVelocity
        const nextScrollSpeed = h.sliderVelocityMultiplier;
        const currentEffectPoint = controlPoints.effectPointAt(h.startTime);
        // ScrollSpeedBindable.Precision is double.Epsilon, so this is an exact comparison.
        if (lastScrollSpeed !== nextScrollSpeed) {
          const ep = new EffectControlPoint();
          ep.kiaiMode = currentEffectPoint.kiaiMode;
          ep.scrollSpeed = lastScrollSpeed = nextScrollSpeed;
          // ControlPointInfo.Add skips redundant points (same kiai + scroll speed as the active point).
          if (!(ep.kiaiMode === currentEffectPoint.kiaiMode && ep.scrollSpeed === currentEffectPoint.scrollSpeed)) controlPoints.add(h.startTime, ep);
        }
      }
    }

    if (original.rulesetId === 3) {
      // Post processing step to transform mania hit objects with the same start time into strong hits
      const groups = new Map<number, TaikoHitObject[]>();
      for (const h of hitObjects) {
        const g = groups.get(h.startTime);
        if (g) g.push(h);
        else groups.set(h.startTime, [h]);
      }
      hitObjects = [...groups.values()].map(g => {
        const first = g[0];
        if (g.length > 1 && first instanceof TaikoStrongableHitObject) first.isStrong = true;
        return first;
      });
    }

    return { hitObjects, controlPoints };
  }

  private *convertHitObject(obj: ConvertHitObject): Generator<TaikoHitObject> {
    // Old osu! used hit sounding to determine various hit type information
    const samples = obj.samples;

    switch (obj.kind) {
      case 'slider': {
        const r = this.shouldConvertSliderToHits(obj);
        if (r.convert) {
          const allSamples: HitSampleInfo[][] = obj.nodeSamples.length > 0 ? obj.nodeSamples : [samples];
          let i = 0;
          for (let j = obj.startTime; j <= obj.startTime + r.taikoDuration + r.tickSpacing / 8; j += r.tickSpacing) {
            const hit = new Hit();
            hit.startTime = j;
            hit.setSamples(allSamples[i]);
            yield hit;
            i = (i + 1) % allSamples.length;
            if (almostEquals(0, r.tickSpacing, DOUBLE_EPSILON)) break;
          }
        } else {
          const roll = new DrumRoll();
          roll.startTime = obj.startTime;
          roll.setSamples(obj.samples);
          roll.duration = r.taikoDuration;
          yield roll;
        }
        break;
      }

      case 'spinner':
      case 'hold': {
        const hitMultiplier = requiredSwellHitsPerSecond(Math.fround(this.beatmap.difficulty.overallDifficulty));
        const swell = new Swell();
        swell.startTime = obj.startTime;
        swell.samples = obj.samples.slice();
        swell.duration = obj.duration;
        swell.requiredHits = Math.trunc(Math.max(1, (obj.duration / 1000) * hitMultiplier));
        yield swell;
        break;
      }

      default: {
        const hit = new Hit();
        hit.startTime = obj.startTime;
        hit.setSamples(samples);
        yield hit;
        break;
      }
    }
  }

  private shouldConvertSliderToHits(obj: ConvertHitObject): { convert: boolean; taikoDuration: number; tickSpacing: number } {
    // DO NOT CHANGE OR REFACTOR ANYTHING IN HERE WITHOUT TESTING AGAINST _ALL_ BEATMAPS.
    // Some of these calculations look redundant, but they are not - extremely small floating point errors are introduced to maintain 1:1 compatibility with stable.
    // Rounding cannot be used as an alternative since the error deltas have been observed to be between 1e-2 and 1e-6.
    const beatmap = this.beatmap;
    const difficulty = beatmap.difficulty;

    // The true distance, accounting for any repeats. This ends up being the drum roll distance later
    const spans = obj.spanCount;
    let distance = obj.path.expectedDistance ?? 0;

    // Do not combine the following two lines!
    distance *= VELOCITY_MULTIPLIER;
    distance *= spans;

    const timingPoint = beatmap.controlPoints.timingPointAt(obj.startTime);

    let beatLength = getPrecisionAdjustedBeatLength(obj.sliderVelocityMultiplier, timingPoint);

    const sliderScoringPointDistance = (OSU_BASE_SCORING_DISTANCE * (difficulty.sliderMultiplier * VELOCITY_MULTIPLIER)) / difficulty.sliderTickRate;

    // The velocity and duration of the taiko hit object - calculated as the velocity of a drum roll.
    const taikoVelocity = sliderScoringPointDistance * difficulty.sliderTickRate;
    const taikoDuration = Math.trunc((distance / taikoVelocity) * beatLength);

    if (this.isForCurrentRuleset) return { convert: false, taikoDuration, tickSpacing: 0 };

    const osuVelocity = taikoVelocity * (1000 / beatLength);

    // osu-stable always uses the speed-adjusted beatlength to determine the osu! velocity, but only uses it for conversion if beatmap version < 8
    if (beatmap.formatVersion >= 8) beatLength = timingPoint.beatLength;

    // If the drum roll is to be split into hit circles, assume the ticks are 1/8 spaced within the duration of one beat
    const tickSpacing = Math.min(beatLength / difficulty.sliderTickRate, taikoDuration / spans);

    return {
      convert: tickSpacing > 0 && (distance / osuVelocity) * 1000 < 2 * beatLength,
      taikoDuration,
      tickSpacing,
    };
  }
}
