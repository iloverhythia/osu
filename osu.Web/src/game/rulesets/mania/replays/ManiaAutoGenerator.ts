// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game.Rulesets.Mania/Replays/ManiaAutoGenerator.cs

import { HoldNote, type ManiaHitObject } from '../objects/ManiaHitObject';

export const RELEASE_DELAY = 20;

/** A replay frame: the set of columns held from `time` onwards. */
export interface ManiaReplayFrame {
  time: number;
  /** Held columns (ManiaAction.Key1 + column). */
  columns: number[];
}

interface ActionPoint {
  time: number;
  column: number;
  hit: boolean;
}

export function generateManiaAutoplay(hitObjects: readonly ManiaHitObject[]): ManiaReplayFrame[] {
  const frames: ManiaReplayFrame[] = [];
  if (hitObjects.length === 0) return frames;

  const points = generateActionPoints(hitObjects);

  // GroupBy(a => a.Time) keeps first-occurrence order of groups (and of elements within a group), then OrderBy is stable.
  const groups = new Map<number, ActionPoint[]>();
  for (const p of points) {
    let g = groups.get(p.time);
    if (!g) groups.set(p.time, (g = []));
    g.push(p);
  }
  const ordered = [...groups.values()].sort((a, b) => a[0].time - b[0].time);

  const actions: number[] = [];

  for (const group of ordered) {
    for (const point of group) {
      if (point.hit) actions.push(point.column);
      else {
        // List.Remove removes the first occurrence.
        const idx = actions.indexOf(point.column);
        if (idx >= 0) actions.splice(idx, 1);
      }
    }

    frames.push({ time: group[0].time, columns: [...actions] });
  }

  return frames;
}

function generateActionPoints(hitObjects: readonly ManiaHitObject[]): ActionPoint[] {
  const out: ActionPoint[] = [];

  for (let i = 0; i < hitObjects.length; i++) {
    const currentObject = hitObjects[i];
    const nextObjectInColumn = getNextObject(hitObjects, i); // Get the next object that requires pressing the same button
    const releaseTime = calculateReleaseTime(currentObject, nextObjectInColumn);

    out.push({ time: currentObject.startTime, column: currentObject.column, hit: true });
    out.push({ time: releaseTime, column: currentObject.column, hit: false });
  }

  return out;
}

function calculateReleaseTime(currentObject: ManiaHitObject, nextObject: ManiaHitObject | null): number {
  const endTime = currentObject.endTime;
  let releaseDelay = RELEASE_DELAY;

  if (currentObject instanceof HoldNote) {
    if (currentObject.duration > 0)
      // hold note releases must be timed exactly.
      return endTime;

    // Special case for super short hold notes
    releaseDelay = 1;
  }

  const canDelayKeyUpFully = nextObject == null || nextObject.startTime > endTime + releaseDelay;

  return endTime + (canDelayKeyUpFully ? releaseDelay : (nextObject!.startTime - endTime) * 0.9);
}

function getNextObject(hitObjects: readonly ManiaHitObject[], currentIndex: number): ManiaHitObject | null {
  const desiredColumn = hitObjects[currentIndex].column;

  for (let i = currentIndex + 1; i < hitObjects.length; i++) if (hitObjects[i].column === desiredColumn) return hitObjects[i];

  return null;
}
