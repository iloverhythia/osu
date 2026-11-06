// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game.Rulesets.Catch/Replays/CatchAutoGenerator.cs and the playback side of
// CatchFramedReplayInputHandler.cs (catcher position interpolated between frames).

import { binarySearch, f32 } from '../../../framework/math';
import { BASE_DASH_SPEED, BASE_WALK_SPEED, calculateCatchWidth } from './CatcherLogic';
import { PalpableCatchHitObject, PLAYFIELD_CENTER_X, type CatchHitObject } from './objects';

export interface CatchReplayFrame {
  time: number;
  position: number;
  dashing: boolean;
}

export class CatchAutoGenerator {
  readonly frames: CatchReplayFrame[] = [];
  private readonly frameTimes: number[] = [];

  constructor(hitObjects: readonly CatchHitObject[], circleSize: number) {
    this.generate(hitObjects, f32(calculateCatchWidth(circleSize) * 0.5));
    for (const f of this.frames) this.frameTimes.push(f.time);
  }

  private addFrame(time: number, position: number, dashing = false): void {
    this.frames.push({ time, position: f32(position), dashing });
  }

  private generate(hitObjects: readonly CatchHitObject[], halfCatcherWidth: number): void {
    if (hitObjects.length === 0) return;

    let lastPosition = PLAYFIELD_CENTER_X;
    let lastTime = 0;

    const moveToNext = (h: PalpableCatchHitObject) => {
      const effectiveX = h.effectiveX;
      const positionChange = Math.abs(f32(lastPosition - effectiveX));
      const timeAvailable = h.startTime - lastTime;

      if (timeAvailable < 0) return;

      // So we can either make it there without a dash or not.
      // If positionChange is 0, we don't need to move, so speedRequired should also be 0 (could be NaN if timeAvailable is 0 too)
      // The case where positionChange > 0 and timeAvailable == 0 results in PositiveInfinity which provides expected beheaviour.
      const speedRequired = positionChange === 0 ? 0 : positionChange / timeAvailable;

      const dashRequired = speedRequired > BASE_WALK_SPEED;
      const impossibleJump = speedRequired > BASE_DASH_SPEED;

      if (f32(lastPosition - halfCatcherWidth) < effectiveX && f32(lastPosition + halfCatcherWidth) > effectiveX) {
        // we are already in the correct range.
        lastTime = h.startTime;
        this.addFrame(h.startTime, lastPosition);
        return;
      }

      if (impossibleJump) {
        this.addFrame(h.startTime, effectiveX);
      } else if (h.hyperDash) {
        this.addFrame(h.startTime - timeAvailable, lastPosition);
        this.addFrame(h.startTime, effectiveX);
      } else if (dashRequired) {
        // we do a movement in two parts - the dash part then the normal part...
        const timeAtNormalSpeed = positionChange / BASE_WALK_SPEED;
        const timeWeNeedToSave = timeAtNormalSpeed - timeAvailable;
        const timeAtDashSpeed = timeWeNeedToSave / 2;

        const midPosition = f32(lastPosition + (effectiveX - lastPosition) * (f32(timeAtDashSpeed) / timeAvailable));

        // dash movement
        this.addFrame(h.startTime - timeAvailable + 1, lastPosition, true);
        this.addFrame(h.startTime - timeAvailable + timeAtDashSpeed, midPosition);
        this.addFrame(h.startTime, effectiveX);
      } else {
        const timeBefore = positionChange / BASE_WALK_SPEED;

        this.addFrame(h.startTime - timeBefore, lastPosition);
        this.addFrame(h.startTime, effectiveX);
      }

      lastTime = h.startTime;
      lastPosition = effectiveX;
    };

    for (const obj of hitObjects) {
      if (obj instanceof PalpableCatchHitObject) moveToNext(obj);
      for (const nested of obj.nested) if (nested instanceof PalpableCatchHitObject) moveToNext(nested);
    }
  }

  /** Index of the current frame (the last frame with time <= `time`), or -1 before the first frame. */
  private currentFrameIndex(time: number): number {
    let i = binarySearch(this.frameTimes, time);
    if (i < 0) return ~i - 1;
    // Several frames may share a time; the handler ends up on the last of them.
    while (i + 1 < this.frameTimes.length && this.frameTimes[i + 1] === time) i++;
    return i;
  }

  /** CatchFramedReplayInputHandler.CollectReplayInputs: the catcher X at a time. */
  positionAt(time: number): number {
    if (this.frames.length === 0) return PLAYFIELD_CENTER_X;
    const index = this.currentFrameIndex(time);
    const start = this.frames[Math.max(0, index)];
    const end = this.frames[Math.min(index + 1, this.frames.length - 1)];
    return interpolateValueAt(time, start.position, end.position, start.time, end.time);
  }

  /** Whether the Dash action is held by the replay at a time. */
  dashingAt(time: number): boolean {
    const index = this.currentFrameIndex(time);
    return index >= 0 && this.frames[index].dashing;
  }
}

/** osu.Framework.Utils.Interpolation.ValueAt (linear). */
function interpolateValueAt(time: number, val1: number, val2: number, startTime: number, endTime: number): number {
  if (val1 === val2) return val1;
  const current = time - startTime;
  const duration = endTime - startTime;
  if (duration === 0 || current === 0) return val1;
  const t = Math.min(1, Math.max(0, current / duration));
  return f32(val1 + t * (val2 - val1));
}
