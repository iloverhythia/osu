// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// BindableBeatDivisor.PREDEFINED_DIVISORS / GetColourFor and ControlPointInfo.GetClosestBeatDivisor.

import type { ControlPointInfo } from './ControlPoints';

export const PREDEFINED_DIVISORS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 12, 16] as const;

const DOUBLE_EPSILON = 1e-7;

/** Math.Round(x, MidpointRounding.AwayFromZero) */
const roundAwayFromZero = (x: number) => Math.sign(x) * Math.round(Math.abs(x));

function closestPositiveSnappedTime(tpTime: number, tpBeatLength: number, time: number, divisor: number): number {
  const beatLength = tpBeatLength / divisor;
  const beats = (Math.max(time, 0) - tpTime) / beatLength;
  const snapped = tpTime + roundAwayFromZero(beats) * beatLength;
  return snapped >= 0 ? snapped : snapped + beatLength;
}

/** ControlPointInfo.GetClosestBeatDivisor: the closest divisor, the smallest one on ties. */
export function getClosestBeatDivisor(cp: ControlPointInfo, time: number, referenceTime?: number): number {
  const tp = cp.timingPointAt(referenceTime ?? time);
  if (time < 0) time += Math.ceil(-time / tp.beatLength) * tp.beatLength;
  let closestDivisor = 0;
  let closestTime = Number.MAX_VALUE;
  for (const d of PREDEFINED_DIVISORS) {
    const distance = Math.abs(time - closestPositiveSnappedTime(tp.time, tp.beatLength, time, d));
    if (closestTime - DOUBLE_EPSILON > distance) {
      closestDivisor = d;
      closestTime = distance;
    }
  }
  return closestDivisor;
}

/** BindableBeatDivisor.GetColourFor (OsuColour values) as [r, g, b]. */
export function beatDivisorColour(divisor: number): [number, number, number] {
  switch (divisor) {
    case 1:
      return [255, 255, 255];
    case 2:
      return [0xed, 0x11, 0x21]; // Red
    case 4:
      return [0x66, 0xcc, 0xff]; // Blue
    case 8:
      return [0xff, 0xcc, 0x22]; // Yellow
    case 16:
      return [0x66, 0x44, 0xcc]; // PurpleDark
    case 3:
      return [0x88, 0x66, 0xee]; // Purple
    case 6:
      return [0xee, 0xaa, 0x00]; // YellowDark
    case 12:
      return [0xcc, 0x66, 0x00]; // YellowDarker
    case 5:
    case 7:
    case 9:
      return [0xb3, 0xd9, 0x44]; // GreenLight
    default:
      return [255, 0, 0];
  }
}
