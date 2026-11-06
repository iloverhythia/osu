// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game.Rulesets.Taiko/Replays/TaikoAutoGenerator.cs (+ AutoGenerator base).

import { DrumRoll, DrumRollTick, Hit, HitType, Swell, TaikoHitObject } from './objects';

export type TaikoAction = 'LeftRim' | 'LeftCentre' | 'RightCentre' | 'RightRim';
export const TAIKO_ACTIONS: readonly TaikoAction[] = ['LeftRim', 'LeftCentre', 'RightCentre', 'RightRim'];

export interface TaikoReplayFrame {
  time: number;
  actions: TaikoAction[];
}

/** AutoGenerator.KEY_UP_DELAY: the default duration of a key press in milliseconds. */
export const KEY_UP_DELAY = 50;
const SWELL_HIT_SPEED = 50;

export function generateTaikoAutoplay(hitObjects: readonly TaikoHitObject[]): TaikoReplayFrame[] {
  const frames: TaikoReplayFrame[] = [];
  if (hitObjects.length === 0) return frames;

  let hitButton = true;

  frames.push({ time: hitObjects[0].startTime - 1000, actions: [] });

  for (let i = 0; i < hitObjects.length; i++) {
    const h = hitObjects[i];
    const endTime = h.endTime;

    if (h instanceof Swell) {
      let d = 0;
      let count = 0;
      const req = h.requiredHits;
      const hitRate = Math.min(SWELL_HIT_SPEED, h.duration / req);

      for (let j = h.startTime; j < endTime; j += hitRate) {
        let action: TaikoAction;
        switch (d) {
          default:
          case 0:
            action = 'LeftCentre';
            break;
          case 1:
            action = 'LeftRim';
            break;
          case 2:
            action = 'RightCentre';
            break;
          case 3:
            action = 'RightRim';
            break;
        }
        frames.push({ time: j, actions: [action] });
        d = (d + 1) % 4;
        if (++count === req) break;
      }
    } else if (h instanceof DrumRoll) {
      for (const tick of h.nested) {
        if (!(tick instanceof DrumRollTick)) continue;
        frames.push({ time: tick.startTime, actions: [hitButton ? 'LeftCentre' : 'RightCentre'] });
        hitButton = !hitButton;
      }
    } else if (h instanceof Hit) {
      let actions: TaikoAction[];
      if (h.type === HitType.Centre) actions = h.isStrong ? ['LeftCentre', 'RightCentre'] : [hitButton ? 'LeftCentre' : 'RightCentre'];
      else actions = h.isStrong ? ['LeftRim', 'RightRim'] : [hitButton ? 'LeftRim' : 'RightRim'];
      frames.push({ time: h.startTime, actions });
    } else {
      throw new Error('Unknown hit object type.');
    }

    // Get the next object that requires pressing the same button
    const nextHitObject = i >= hitObjects.length - 1 ? null : hitObjects[i + 1];
    const canDelayKeyUp = nextHitObject === null || nextHitObject.startTime > endTime + KEY_UP_DELAY;
    const calculatedDelay = canDelayKeyUp ? KEY_UP_DELAY : (nextHitObject!.startTime - endTime) * 0.9;
    frames.push({ time: endTime + calculatedDelay, actions: [] });

    hitButton = !hitButton;
  }

  // Replay frames are ordered by time (OrderBy is stable).
  return frames.map((fr, i) => ({ fr, i })).sort((a, b) => a.fr.time - b.fr.time || a.i - b.i).map(x => x.fr);
}
