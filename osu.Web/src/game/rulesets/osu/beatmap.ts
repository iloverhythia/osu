// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of OsuBeatmapConverter.cs, OsuBeatmapProcessor.cs and the osu!-specific mods that alter objects (HR flip, Mirror).

import type { Beatmap } from '../../beatmaps/Beatmap';
import type { BeatmapDifficulty } from '../../beatmaps/Difficulty';
import { distance } from '../../../framework/math';
import { ModSet, applyCommonDifficultyMods } from '../../mods/Mods';
import { HitResult } from '../../scoring/HitResult';
import type { JudgementResult } from '../../scoring/Judgement';
import type { PlayableBeatmap, Ruleset } from '../Ruleset';
import { HitCircle, OsuHitObject, PLAYFIELD_HEIGHT, PLAYFIELD_WIDTH, Slider, Spinner } from './objects';

export const STACK_DISTANCE = 3;

export class OsuPlayableBeatmap implements PlayableBeatmap<OsuHitObject> {
  readonly hitObjects: OsuHitObject[];
  readonly objectTimes: { start: number; end: number }[];

  constructor(
    readonly source: Beatmap,
    readonly ruleset: Ruleset,
    readonly difficulty: BeatmapDifficulty,
    readonly mods: ModSet,
    hitObjects: OsuHitObject[],
  ) {
    this.hitObjects = hitObjects;
    this.objectTimes = hitObjects.map(h => ({ start: h.startTime, end: h.endTime }));
  }

  get breaks() {
    return this.source.breaks;
  }

  perfectResults(): JudgementResult[] {
    const results: JudgementResult[] = [];
    const push = (h: OsuHitObject, parent: OsuHitObject) => {
      results.push({
        hitObject: h,
        judgement: h.judgement,
        type: h.judgement.maxResult,
        timeOffset: 0,
        objectEndTime: h.endTime,
        tag: h.kind,
        newCombo: parent.newCombo,
        lastInCombo: parent.lastInCombo,
      });
    };
    for (const h of this.hitObjects) {
      if (h instanceof Slider) {
        // Nested objects are judged in time order, then the slider itself.
        for (const n of h.nested) push(n, h);
        push(h, h);
      } else if (h instanceof Spinner) {
        for (const n of h.nested) push(n, h);
        push(h, h);
      } else push(h, h);
    }
    // Same order as JudgementProcessor.SimulateAutoplay (nested objects first, then their parent).
    return results;
  }
}

export function convertOsuBeatmap(beatmap: Beatmap, ruleset: Ruleset, mods: ModSet): OsuPlayableBeatmap {
  let difficulty = applyCommonDifficultyMods(beatmap.difficulty, mods, true);

  const hitObjects: OsuHitObject[] = [];
  for (const original of beatmap.hitObjects) {
    let h: OsuHitObject;
    if (original.kind === 'slider') {
      const s = new Slider();
      s.path = original.path.clone();
      s.path.optimiseCatmull = true;
      s.nodeSamples = original.nodeSamples.map(n => [...n]);
      s.repeatCount = original.repeatCount;
      s.tickDistanceMultiplier = beatmap.formatVersion < 8 ? 1 / beatmap.controlPoints.difficultyPointAt(original.startTime).sliderVelocity : 1;
      s.generateTicks = original.generateTicks;
      s.sliderVelocityMultiplier = original.sliderVelocityMultiplier;
      h = s;
    } else if (original.kind === 'spinner' || original.kind === 'hold') {
      const sp = new Spinner();
      sp.spinnerDuration = original.endTime - original.startTime;
      h = sp;
    } else {
      h = new HitCircle();
    }
    h.startTime = original.startTime;
    h.samples = original.samples;
    h.position = original.kind === 'spinner' ? { x: PLAYFIELD_WIDTH / 2, y: PLAYFIELD_HEIGHT / 2 } : { x: original.x, y: original.y };
    h.newCombo = original.newCombo;
    h.comboOffset = original.comboOffset;
    hitObjects.push(h);
  }

  // ---- mods that apply to hit objects (before defaults so nested positions follow) ----
  if (mods.has('HR')) for (const h of hitObjects) flipVertically(h);
  if (mods.has('MR') && !mods.has('HR')) for (const h of hitObjects) flipHorizontally(h);

  // ---- BeatmapProcessor.PreProcess (combo information) ----
  let last: OsuHitObject | null = null;
  for (const obj of hitObjects) {
    if (!(obj instanceof Spinner) && (last == null || last instanceof Spinner)) obj.newCombo = true;
    last = obj;
  }
  let lastObj: OsuHitObject | null = null;
  for (const obj of hitObjects) {
    updateComboInformation(obj, lastObj);
    lastObj = obj;
  }
  if (lastObj) lastObj.lastInCombo = true;

  // ---- ApplyDefaults ----
  for (const h of hitObjects) h.applyDefaults(beatmap.controlPoints, difficulty);

  // ---- PostProcess: stacking ----
  applyStacking(hitObjects, beatmap.formatVersion, beatmap.stackLeniency);

  difficulty = difficulty.clone();
  return new OsuPlayableBeatmap(beatmap, ruleset, difficulty, mods, hitObjects);
}

/** OsuHitObject.UpdateComboInformation */
function updateComboInformation(obj: OsuHitObject, lastObj: OsuHitObject | null): void {
  let index = lastObj?.comboIndex ?? 0;
  let indexWithOffsets = lastObj?.comboIndexWithOffsets ?? 0;
  let inCurrentCombo = lastObj ? lastObj.indexInCurrentCombo + 1 : 0;

  // Spinners don't affect combo colour offsets.
  if (!(obj instanceof Spinner) && (obj.newCombo || lastObj == null || lastObj instanceof Spinner)) {
    inCurrentCombo = 0;
    index++;
    indexWithOffsets += obj.comboOffset + 1;
    if (lastObj) lastObj.lastInCombo = true;
  }
  obj.comboIndex = index;
  obj.comboIndexWithOffsets = indexWithOffsets;
  obj.indexInCurrentCombo = inCurrentCombo;
}

/** OsuHitObjectGenerationUtils.ReflectVerticallyAlongPlayfield */
function flipVertically(h: OsuHitObject): void {
  h.position = { x: h.position.x, y: PLAYFIELD_HEIGHT - h.position.y };
  if (h instanceof Slider) {
    for (const cp of h.path.controlPoints) cp.position = { x: cp.position.x, y: -cp.position.y };
    h.path.invalidate();
  }
}

function flipHorizontally(h: OsuHitObject): void {
  h.position = { x: PLAYFIELD_WIDTH - h.position.x, y: h.position.y };
  if (h instanceof Slider) {
    for (const cp of h.path.controlPoints) cp.position = { x: -cp.position.x, y: cp.position.y };
    h.path.invalidate();
  }
}

// ---- OsuBeatmapProcessor.ApplyStacking ----

function applyStacking(hitObjects: OsuHitObject[], beatmapVersion: number, stackLeniency: number): void {
  if (hitObjects.length === 0) return;
  for (const h of hitObjects) h.setStackHeight(0);
  if (beatmapVersion >= 6) applyStackingNew(hitObjects, stackLeniency, 0, hitObjects.length - 1);
  else applyStackingOld(hitObjects, stackLeniency);
}

const stackThreshold = (h: OsuHitObject, stackLeniency: number): number => Math.fround(Math.trunc(h.timePreempt) * Math.fround(stackLeniency));

function applyStackingNew(hitObjects: OsuHitObject[], stackLeniency: number, startIndex: number, endIndex: number): void {
  let extendedEndIndex = endIndex;
  if (endIndex < hitObjects.length - 1) {
    // Extend the end index to include objects they are stacked on
    for (let i = endIndex; i >= startIndex; i--) {
      let stackBaseIndex = i;
      for (let n = stackBaseIndex + 1; n < hitObjects.length; n++) {
        const stackBaseObject = hitObjects[stackBaseIndex];
        if (stackBaseObject instanceof Spinner) break;
        const objectN = hitObjects[n];
        if (objectN instanceof Spinner) continue;
        const endTime = stackBaseObject.endTime;
        const threshold = stackThreshold(objectN, stackLeniency);
        if (objectN.startTime - endTime > threshold) break;
        if (
          distance(stackBaseObject.position, objectN.position) < STACK_DISTANCE ||
          (stackBaseObject instanceof Slider && distance(stackBaseObject.endPosition, objectN.position) < STACK_DISTANCE)
        ) {
          stackBaseIndex = n;
          // HitObjects after the specified update range haven't been reset yet
          objectN.setStackHeight(0);
        }
      }
      if (stackBaseIndex > extendedEndIndex) {
        extendedEndIndex = stackBaseIndex;
        if (extendedEndIndex === hitObjects.length - 1) break;
      }
    }
  }

  // Reverse pass for stack calculation.
  let extendedStartIndex = startIndex;
  for (let i = extendedEndIndex; i > startIndex; i--) {
    let n = i;
    /* We should check every note which has not yet got a stack.
     * Consider the case we have two interwound stacks and this will make sense.
     *
     * o <-1      o <-2
     *  o <-3      o <-4
     *
     * We first process starting from 4 and handle 2,
     * then we come backwards on the i loop iteration until we reach 3 and handle 1.
     * 2 and 1 will be ignored in the i loop because they already have a stack value.
     */
    let objectI = hitObjects[i];
    if (objectI.stackHeight !== 0 || objectI instanceof Spinner) continue;
    const threshold = stackThreshold(objectI, stackLeniency);

    /* If this object is a hitcircle, then we enter this "special" case.
     * It either ends with a stack of hitcircles only, or a stack of hitcircles that are underneath a slider.
     * Any other case is handled by the "is Slider" code below this.
     */
    if (objectI instanceof HitCircle) {
      while (--n >= 0) {
        const objectN = hitObjects[n];
        if (objectN instanceof Spinner) continue;
        const endTime = objectN.endTime;
        if (Math.trunc(objectI.startTime) - Math.trunc(endTime) > threshold)
          // We are no longer within stacking range of the previous object.
          break;

        // HitObjects before the specified update range haven't been reset yet
        if (n < extendedStartIndex) {
          objectN.setStackHeight(0);
          extendedStartIndex = n;
        }

        /* This is a special case where hticircles are moved DOWN and RIGHT (negative stacking) if they are under the *last* slider in a stacked pattern.
         *    o==o <- slider is at original location
         *        o <- hitCircle has stack of -1
         *         o <- hitCircle has stack of -2
         */
        if (objectN instanceof Slider && distance(objectN.endPosition, objectI.position) < STACK_DISTANCE) {
          const offset = objectI.stackHeight - objectN.stackHeight + 1;
          for (let j = n + 1; j <= i; j++) {
            // For each object which was declared under this slider, we will offset it to appear *below* the slider end (rather than above).
            const objectJ = hitObjects[j];
            if (distance(objectN.endPosition, objectJ.position) < STACK_DISTANCE) objectJ.setStackHeight(objectJ.stackHeight - offset);
          }
          // We have hit a slider.  We should restart calculation using this as the new base.
          // Breaking here will mean that the slider still has StackCount of 0, so will be handled in the i-outer-loop.
          break;
        }

        if (distance(objectN.position, objectI.position) < STACK_DISTANCE) {
          // Keep processing as if there are no sliders.  If we come across a slider, this gets cancelled out.
          // NOTE: Sliders with start positions stacking are a special case that is also handled here.
          objectN.setStackHeight(objectI.stackHeight + 1);
          objectI = objectN;
        }
      }
    } else if (objectI instanceof Slider) {
      /* We have hit the first slider in a possible stack.
       * From this point on, we ALWAYS stack positive regardless.
       */
      while (--n >= startIndex) {
        const objectN = hitObjects[n];
        if (objectN instanceof Spinner) continue;
        if (objectI.startTime - objectN.startTime > threshold)
          // We are no longer within stacking range of the previous object.
          break;
        if (distance(objectN.endPosition, objectI.position) < STACK_DISTANCE) {
          objectN.setStackHeight(objectI.stackHeight + 1);
          objectI = objectN;
        }
      }
    }
  }
}

function applyStackingOld(hitObjects: OsuHitObject[], stackLeniency: number): void {
  for (let i = 0; i < hitObjects.length; i++) {
    const currHitObject = hitObjects[i];
    if (currHitObject.stackHeight !== 0 && !(currHitObject instanceof Slider)) continue;

    let startTime = currHitObject.endTime;
    let sliderStack = 0;

    for (let j = i + 1; j < hitObjects.length; j++) {
      const threshold = stackThreshold(hitObjects[i], stackLeniency);
      if (hitObjects[j].startTime - threshold > startTime) break;

      // The start position of the hitobject, or the position at the end of the path if the hitobject is a slider
      const position2 =
        currHitObject instanceof Slider
          ? { x: currHitObject.position.x + currHitObject.path.positionAt(1).x, y: currHitObject.position.y + currHitObject.path.positionAt(1).y }
          : currHitObject.position;

      // Note the use of `StartTime` in the code below doesn't match stable's use of `EndTime`.
      // This is because in the stable implementation, `UpdateCalculations` is not called on the inner-loop hitobject (j)
      // and therefore it does not have a correct `EndTime`, but instead the default of `EndTime = StartTime`.
      //
      // Effects of this can be seen on https://osu.ppy.sh/beatmapsets/243#osu/1146 at sliders around 86647 ms, where
      // if we use `EndTime` here it would result in unexpected stacking.

      if (distance(hitObjects[j].position, currHitObject.position) < STACK_DISTANCE) {
        currHitObject.setStackHeight(currHitObject.stackHeight + 1);
        startTime = hitObjects[j].startTime;
      } else if (distance(hitObjects[j].position, position2) < STACK_DISTANCE) {
        // Case for sliders - bump notes down and right, rather than up and left.
        sliderStack++;
        hitObjects[j].setStackHeight(hitObjects[j].stackHeight - sliderStack);
        startTime = hitObjects[j].startTime;
      }
    }
  }
}

export { HitResult };
