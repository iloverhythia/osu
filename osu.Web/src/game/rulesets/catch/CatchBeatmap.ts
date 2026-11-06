// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game.Rulesets.Catch/Beatmaps/CatchBeatmapConverter.cs, CatchBeatmapProcessor.cs,
// the difficulty / beatmap parts of Mods/CatchModEasy.cs, CatchModHardRock.cs, CatchModMirror.cs,
// and the playable-beatmap pipeline of WorkingBeatmap.GetPlayableBeatmap.

import { f32, LegacyRandom } from '../../../framework/math';
import type { Beatmap, ConvertHitObject } from '../../beatmaps/Beatmap';
import { BeatmapDifficulty } from '../../beatmaps/Difficulty';
import type { ModSet } from '../../mods/Mods';
import { SliderPath } from '../../objects/SliderPath';
import { ALLOWED_CATCH_RANGE, BASE_DASH_SPEED, calculateCatchWidth } from './CatcherLogic';
import {
  Banana,
  BananaShower,
  CatchHitObject,
  DEFAULT_LEGACY_CONVERT_Y,
  Droplet,
  Fruit,
  getPalpableObjects,
  JuiceStream,
  PLAYFIELD_WIDTH,
  TinyDroplet,
} from './objects';

// ---------------------------------------------------------------------------------------------
// CatchBeatmapConverter
// ---------------------------------------------------------------------------------------------

/** CatchBeatmapConverter.CanConvert: every object has an X position (only osu! and catch maps are offered for conversion). */
export function canConvertToCatch(beatmap: Beatmap): boolean {
  return (beatmap.rulesetId === 0 || beatmap.rulesetId === 2) && beatmap.hitObjects.every(h => h.kind !== 'hold');
}

function convertHitObject(obj: ConvertHitObject, beatmap: Beatmap): CatchHitObject {
  switch (obj.kind) {
    case 'slider': {
      const s = new JuiceStream();
      s.startTime = obj.startTime;
      s.samples = obj.samples;
      s.path = obj.path.clone();
      s.nodeSamples = obj.nodeSamples.map(n => n.slice());
      s.repeatCount = obj.repeatCount;
      s.originalX = obj.x;
      s.newCombo = obj.newCombo;
      s.comboOffset = obj.comboOffset;
      s.legacyConvertedY = obj.y;
      // prior to v8, speed multipliers don't adjust for how many ticks are generated over the same distance.
      // this results in more (or less) ticks being generated in <v8 maps for the same time duration.
      s.tickDistanceMultiplier = beatmap.formatVersion < 8 ? 1 / beatmap.controlPoints.difficultyPointAt(obj.startTime).sliderVelocity : 1;
      s.sliderVelocityMultiplier = obj.sliderVelocityMultiplier;
      return s;
    }

    case 'spinner':
    case 'hold': {
      const b = new BananaShower();
      b.startTime = obj.startTime;
      b.samples = obj.samples;
      b.setDuration(obj.duration);
      b.newCombo = obj.newCombo;
      b.comboOffset = obj.comboOffset;
      return b;
    }

    default: {
      const f = new Fruit();
      f.startTime = obj.startTime;
      f.samples = obj.samples;
      f.newCombo = obj.newCombo;
      f.comboOffset = obj.comboOffset;
      f.originalX = obj.x;
      f.legacyConvertedY = obj.y ?? DEFAULT_LEGACY_CONVERT_Y;
      return f;
    }
  }
}

/** BeatmapConverter.Convert: converts and orders by start time (stable). */
export function convertToCatch(beatmap: Beatmap): CatchHitObject[] {
  return beatmap.hitObjects.map(h => convertHitObject(h, beatmap)).sort((a, b) => a.startTime - b.startTime);
}

// ---------------------------------------------------------------------------------------------
// Difficulty mods (CatchModEasy / CatchModHardRock ApplyToDifficulty), in single precision like the C# floats.
// ---------------------------------------------------------------------------------------------

export function applyCatchDifficultyMods(source: BeatmapDifficulty, mods: ModSet): BeatmapDifficulty {
  const d = source.clone();
  d.circleSize = f32(d.circleSize);
  d.approachRate = f32(d.approachRate);
  d.drainRate = f32(d.drainRate);
  d.overallDifficulty = f32(d.overallDifficulty);

  if (mods.has('EZ')) {
    const ratio = f32(0.5);
    d.circleSize = f32(d.circleSize * ratio);
    d.approachRate = f32(d.approachRate * ratio);
    d.drainRate = f32(d.drainRate * ratio);
    d.overallDifficulty = f32(d.overallDifficulty * ratio);
  }

  if (mods.has('HR')) {
    const ratio = f32(1.4);
    d.drainRate = Math.min(f32(d.drainRate * ratio), 10);
    d.overallDifficulty = Math.min(f32(d.overallDifficulty * ratio), 10);
    d.circleSize = Math.min(f32(d.circleSize * f32(1.3)), 10); // CS uses a custom 1.3 ratio.
    d.approachRate = Math.min(f32(d.approachRate * ratio), 10);
  }

  return d;
}

// ---------------------------------------------------------------------------------------------
// CatchBeatmapProcessor
// ---------------------------------------------------------------------------------------------

export const RNG_SEED = 1337;

export class CatchBeatmapProcessor {
  hardRockOffsets = false;

  constructor(
    private readonly hitObjects: CatchHitObject[],
    private readonly difficulty: BeatmapDifficulty,
  ) {}

  preProcess(): void {
    let lastObj: CatchHitObject | null = null;

    // For sanity, ensures that both the first hitobject and the first hitobject after a banana shower start a new combo.
    for (const obj of this.hitObjects) {
      if (!(obj instanceof BananaShower) && (lastObj == null || lastObj instanceof BananaShower)) obj.newCombo = true;
      lastObj = obj;
    }

    // BeatmapProcessor.PreProcess
    lastObj = null;
    for (const obj of this.hitObjects) {
      obj.updateComboInformation(lastObj);
      lastObj = obj;
    }
  }

  postProcess(): void {
    this.applyPositionOffsets();

    let index = 0;
    for (const obj of this.hitObjects) {
      obj.indexInBeatmap = index;
      for (const nested of obj.nested) nested.indexInBeatmap = index;

      if (obj.lastInCombo && obj.nested.length > 0) obj.nested[obj.nested.length - 1].lastInCombo = true;

      index++;
    }
  }

  applyPositionOffsets(): void {
    const rng = new LegacyRandom(RNG_SEED);

    const state = { lastPosition: null as number | null, lastStartTime: 0 };

    for (const obj of this.hitObjects) {
      obj.xOffset = 0;

      if (obj instanceof Fruit) {
        if (this.hardRockOffsets) applyHardRockOffset(obj, state, rng);
      } else if (obj instanceof BananaShower) {
        for (const banana of obj.nested) {
          if (!(banana instanceof Banana)) continue;
          banana.xOffset = rng.nextDouble() * PLAYFIELD_WIDTH;
          rng.next(); // osu!stable retrieved a random banana type
          rng.next(); // osu!stable retrieved a random banana rotation
          rng.next(); // osu!stable retrieved a random banana colour
        }
      } else if (obj instanceof JuiceStream) {
        // Todo: BUG!! Stable used the last control point as the final position of the path, but it should use the computed path instead.
        const cps = obj.path.controlPoints;
        state.lastPosition = f32(obj.originalX + f32(cps[cps.length - 1].position.x));

        // Todo: BUG!! Stable attempted to use the end time of the stream, but referenced it too early in execution and used the start time instead.
        state.lastStartTime = obj.startTime;

        for (const nested of obj.nested) {
          nested.xOffset = 0;

          if (nested instanceof TinyDroplet) {
            const v = rng.nextRange(-20, 20);
            nested.xOffset = Math.min(PLAYFIELD_WIDTH - nested.originalX, Math.max(-nested.originalX, v));
          } else if (nested instanceof Droplet) rng.next(); // osu!stable retrieved a random droplet rotation
        }
      }
    }

    initialiseHyperDash(this.hitObjects, this.difficulty);
  }
}

interface HardRockState {
  lastPosition: number | null;
  lastStartTime: number;
}

function applyHardRockOffset(hitObject: CatchHitObject, state: HardRockState, rng: LegacyRandom): void {
  let offsetPosition = hitObject.originalX;
  const startTime = hitObject.startTime;

  if (
    state.lastPosition == null ||
    // some objects can get assigned position zero, making stable incorrectly go inside this if branch on the next object. to maintain behaviour and compatibility, do the same here.
    // reference: https://github.com/peppy/osu-stable-reference/blob/3ea48705eb67172c430371dcfc8a16a002ed0d3d/osu!/GameplayElements/HitObjects/Fruits/HitFactoryFruits.cs#L45-L50
    state.lastPosition === 0
  ) {
    state.lastPosition = offsetPosition;
    state.lastStartTime = startTime;
    return;
  }

  const positionDiff = f32(offsetPosition - state.lastPosition);

  // Todo: BUG!! Stable calculated time deltas as ints, which affects randomisation. This should be changed to a double.
  const timeDiff = Math.trunc(startTime - state.lastStartTime) | 0;

  if (timeDiff > 1000) {
    state.lastPosition = offsetPosition;
    state.lastStartTime = startTime;
    return;
  }

  if (positionDiff === 0) {
    offsetPosition = applyRandomOffset(offsetPosition, timeDiff / 4, rng);
    hitObject.xOffset = f32(offsetPosition - hitObject.originalX);
    return;
  }

  // (integer division, as in stable)
  if (Math.abs(positionDiff) < Math.trunc(timeDiff / 3)) offsetPosition = applyOffset(offsetPosition, positionDiff);

  hitObject.xOffset = f32(offsetPosition - hitObject.originalX);

  state.lastPosition = offsetPosition;
  state.lastStartTime = startTime;
}

function applyRandomOffset(position: number, maxOffset: number, rng: LegacyRandom): number {
  const right = rng.nextBool();
  // LegacyRandom.Next(double, double)
  const rand = Math.min(20, Math.trunc(0 + rng.nextDouble() * (Math.max(0, maxOffset) - 0)));

  if (right) {
    // Clamp to the right bound
    if (f32(position + rand) <= PLAYFIELD_WIDTH) position = f32(position + rand);
    else position = f32(position - rand);
  } else {
    // Clamp to the left bound
    if (f32(position - rand) >= 0) position = f32(position - rand);
    else position = f32(position + rand);
  }
  return position;
}

function applyOffset(position: number, amount: number): number {
  if (amount > 0) {
    // Clamp to the right bound
    if (f32(position + amount) < PLAYFIELD_WIDTH) position = f32(position + amount);
  } else {
    // Clamp to the left bound
    if (f32(position + amount) > 0) position = f32(position + amount);
  }
  return position;
}

/** CatchBeatmapProcessor.initialiseHyperDash */
export function initialiseHyperDash(hitObjects: readonly CatchHitObject[], difficulty: BeatmapDifficulty): void {
  const palpableObjects = getPalpableObjects(hitObjects).filter(h => h instanceof Fruit || (h instanceof Droplet && !(h instanceof TinyDroplet)));

  let halfCatcherWidth = f32(calculateCatchWidth(difficulty.circleSize) / 2);

  // Todo: This is wrong. osu!stable calculated hyperdashes using the full catcher size, excluding the margins.
  // This should theoretically cause impossible scenarios, but practically, likely due to the size of the playfield, it doesn't seem possible.
  // For now, to bring gameplay (and diffcalc!) completely in-line with stable, this code also uses the full catcher size.
  halfCatcherWidth /= ALLOWED_CATCH_RANGE;

  let lastDirection = 0;
  let lastExcess = halfCatcherWidth;

  // 1/4th of a frame of grace time, taken from osu-stable
  const grace = f32(f32(f32(1000) / f32(60)) / 4);

  for (let i = 0; i < palpableObjects.length - 1; i++) {
    const currentObject = palpableObjects[i];
    const nextObject = palpableObjects[i + 1];

    // Reset variables in-case values have changed (e.g. after applying HR)
    currentObject.hyperDashTarget = null;
    currentObject.distanceToHyperDash = 0;

    const thisDirection = nextObject.effectiveX > currentObject.effectiveX ? 1 : -1;

    // Int truncation added to match osu!stable.
    const timeToNext = f32((Math.trunc(nextObject.startTime) - Math.trunc(currentObject.startTime)) - grace);
    const distanceToNext = Math.abs(f32(nextObject.effectiveX - currentObject.effectiveX)) - (lastDirection === thisDirection ? lastExcess : halfCatcherWidth);
    const distanceToHyper = f32(timeToNext * BASE_DASH_SPEED - distanceToNext);

    if (distanceToHyper < 0) {
      currentObject.hyperDashTarget = nextObject;
      lastExcess = halfCatcherWidth;
    } else {
      currentObject.distanceToHyperDash = distanceToHyper;
      lastExcess = Math.min(halfCatcherWidth, Math.max(0, distanceToHyper));
    }

    lastDirection = thisDirection;
  }
}

// ---------------------------------------------------------------------------------------------
// CatchModMirror.ApplyToBeatmap
// ---------------------------------------------------------------------------------------------

export function applyMirror(hitObjects: readonly CatchHitObject[]): void {
  const mirrorEffectiveX = (o: CatchHitObject) => {
    o.originalX = PLAYFIELD_WIDTH - o.originalX;
    o.xOffset = -o.xOffset;
    for (const n of o.nested) {
      n.originalX = PLAYFIELD_WIDTH - n.originalX;
      n.xOffset = -n.xOffset;
    }
  };

  for (const h of hitObjects) {
    if (h instanceof Fruit) mirrorEffectiveX(h);
    else if (h instanceof JuiceStream) {
      mirrorEffectiveX(h);
      const cps = h.path.controlPoints.map(p => ({ position: { x: -p.position.x, y: p.position.y }, type: p.type }));
      h.path = new SliderPath(cps, h.path.expectedDistance);
    } else if (h instanceof BananaShower) {
      for (const banana of h.nested) if (banana instanceof Banana) banana.xOffset = PLAYFIELD_WIDTH - banana.xOffset;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// WorkingBeatmap.GetPlayableBeatmap for catch
// ---------------------------------------------------------------------------------------------

export interface CatchConversionResult {
  hitObjects: CatchHitObject[];
  difficulty: BeatmapDifficulty;
}

export function createCatchBeatmap(beatmap: Beatmap, mods: ModSet): CatchConversionResult {
  // 1. convert
  const hitObjects = convertToCatch(beatmap);

  // 2. IApplicableToDifficulty
  const difficulty = applyCatchDifficultyMods(beatmap.difficulty, mods);

  // 3. processor + IApplicableToBeatmapProcessor (CatchModHardRock)
  const processor = new CatchBeatmapProcessor(hitObjects, difficulty);
  processor.hardRockOffsets = mods.has('HR');
  processor.preProcess();

  // 4. ApplyDefaults (creates nested objects)
  for (const h of hitObjects) h.applyDefaults(beatmap.controlPoints, difficulty, beatmap.formatVersion);

  // 5. PostProcess
  processor.postProcess();

  // 6. IApplicableToBeatmap (CatchModMirror)
  if (mods.has('MR')) applyMirror(hitObjects);

  return { hitObjects, difficulty };
}
