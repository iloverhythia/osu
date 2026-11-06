// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game/Rulesets/Objects/BarLineGenerator.cs

import type { ControlPointInfo } from '../beatmaps/ControlPoints';

export interface BarLine {
  startTime: number;
  major: boolean;
}

const DOUBLE_EPSILON = 1e-7;

/**
 * @param firstHitTime start time of the first hit object.
 * @param lastObjectTime end time of the last hit object.
 */
export function generateBarLines(controlPoints: ControlPointInfo, firstHitTime: number, lastObjectTime: number): BarLine[] {
  const barLines: BarLine[] = [];
  const timingPoints = controlPoints.timingPoints;
  if (timingPoints.length === 0) return barLines;

  const lastHitTime = 1 + lastObjectTime;

  for (let i = 0; i < timingPoints.length; i++) {
    const current = timingPoints[i];
    let currentBeat = 0;

    // Stop on the next timing point, or if there is no next timing point stop slightly past the last object
    const generationStartTime = Math.min(0, firstHitTime);
    const barLength = current.beatLength * current.timeSignature;
    const endTime = i < timingPoints.length - 1 ? timingPoints[i + 1].time : lastHitTime + barLength;

    let startTime: number;
    if (current.time > generationStartTime) startTime = current.time;
    else {
      // If the timing point starts before the minimum allowable time for bar lines,
      // we still need to compute a start time for generation that is actually properly aligned with the timing point.
      const barCount = Math.ceil((generationStartTime - current.time) / barLength);
      startTime = current.time + barCount * barLength;
    }

    if (current.omitFirstBarLine) startTime += barLength;

    for (let t = startTime; endTime > t - DOUBLE_EPSILON; t += barLength, currentBeat++) {
      const roundedTime = Math.sign(t) * Math.round(Math.abs(t));
      if (Math.abs(t - roundedTime) <= DOUBLE_EPSILON) t = roundedTime;
      barLines.push({ startTime: t, major: currentBeat % current.timeSignature === 0 });
    }
  }
  return barLines;
}
