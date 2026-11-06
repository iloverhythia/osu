// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game.Rulesets.Osu/Replays/OsuAutoGenerator.cs + OsuAutoGeneratorBase.cs (+ AutoGenerator.KEY_UP_DELAY).
// Lazer's autoplay is a generated replay played through the replay input handler; this produces the same frames and
// converts them into this port's replay events (gamefield coordinates).

import { Easing, applyEasing } from '../../storyboard/Easing';
import { HitResult } from '../../scoring/HitResult';
import type { Replay, ReplayEvent } from '../../replays/Replay';
import type { OsuPlayableBeatmap } from './beatmap';
import { HitCircle, OsuHitObject, OsuHitWindows, PLAYFIELD_HEIGHT, PLAYFIELD_WIDTH, Slider, Spinner } from './objects';

type Action = 'LeftButton' | 'RightButton';

interface Vec {
  x: number;
  y: number;
}

class OsuReplayFrame {
  actions: Action[];
  constructor(
    public time: number,
    public position: Vec,
    ...actions: Action[]
  ) {
    this.actions = actions;
  }
}

class OsuKeyUpReplayFrame extends OsuReplayFrame {}

const KEY_UP_DELAY = 50; // AutoGenerator.KEY_UP_DELAY
const MIN_FRAME_SEPARATION_FOR_ALTERNATING = 266;
const SPINNER_CENTRE: Vec = { x: PLAYFIELD_WIDTH / 2, y: PLAYFIELD_HEIGHT / 2 };
const SPIN_RADIUS = 50;
const f32 = Math.fround;

/** osu-framework Interpolation.ValueAt(double, Vector2, Vector2, double, double, Easing) — note: no clamping. */
function valueAt(time: number, start: Vec, end: Vec, startTime: number, endTime: number, easing: Easing): Vec {
  const current = f32(time - startTime);
  const duration = f32(endTime - startTime);
  if (duration === 0 || current === 0) return { ...start };
  const t = f32(applyEasing(easing, current / duration));
  return { x: f32(start.x + t * (end.x - start.x)), y: f32(start.y + t * (end.y - start.y)) };
}

const len = (v: Vec) => f32(Math.hypot(v.x, v.y));

export class OsuAutoGenerator {
  /** Autopilot ("Relax2") uses delayed movements. */
  delayedMovements = false;
  private readonly frames: OsuReplayFrame[] = [];
  private readonly defaultHitWindows = new OsuHitWindows();
  private buttonIndex = 0;

  constructor(
    private readonly beatmap: OsuPlayableBeatmap,
    /** Combined rate of IApplicableToRate mods (DT/HT/NC/DC). */
    private readonly rate: number,
  ) {
    this.defaultHitWindows.setDifficulty(beatmap.difficulty.overallDifficulty);
  }

  private get preferredEasing(): Easing {
    return this.delayedMovements ? Easing.InOutCubic : Easing.Out;
  }

  // ---- OsuAutoGeneratorBase utilities ----

  private applyModsToTimeDelta(startTime: number, endTime: number): number {
    return (endTime - startTime) / this.rate;
  }

  private applyModsToRate(_time: number, rate: number): number {
    return rate * this.rate;
  }

  private getFrameDelay(time: number): number {
    return this.applyModsToRate(time, 1000.0 / 60);
  }

  private findInsertionIndex(frame: OsuReplayFrame): number {
    // List.BinarySearch, then skip past equal times.
    let lo = 0;
    let hi = this.frames.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const t = this.frames[mid].time;
      if (t === frame.time) {
        found = mid;
        break;
      }
      if (t < frame.time) lo = mid + 1;
      else hi = mid - 1;
    }
    if (found < 0) return lo;
    let index = found;
    while (index < this.frames.length && frame.time === this.frames[index].time) ++index;
    return index;
  }

  private addFrameToReplay(frame: OsuReplayFrame): void {
    this.frames.splice(this.findInsertionIndex(frame), 0, frame);
  }

  private static circlePosition(t: number, radius: number): Vec {
    return { x: f32(Math.cos(t) * radius), y: f32(Math.sin(t) * radius) };
  }

  // ---- Generator ----

  generateFrames(): OsuReplayFrame[] {
    const objects = this.beatmap.hitObjects;
    if (objects.length === 0) return this.frames;
    this.buttonIndex = 0;
    this.addFrameToReplay(new OsuReplayFrame(objects[0].startTime - 1500, { x: 256, y: 500 }));
    for (let i = 0; i < objects.length; i++) {
      const h = objects[i];
      if (this.delayedMovements && i > 0) this.addDelayedMovements(h, objects[i - 1]);
      this.addHitObjectReplay(h);
    }
    return this.frames;
  }

  private addDelayedMovements(h: OsuHitObject, prev: OsuHitObject): void {
    const endTime = prev.endTime;
    let hitWindows: OsuHitWindows;
    if (h instanceof HitCircle) hitWindows = h.hitWindows as OsuHitWindows;
    else if (h instanceof Slider) hitWindows = h.tailCircle.hitWindows as OsuHitWindows;
    else hitWindows = this.defaultHitWindows;

    const w = (r: HitResult) => hitWindows.windowFor(r);
    const prevEnd = (): OsuReplayFrame => new OsuReplayFrame(0, { x: prev.stackedEndPosition.x, y: prev.stackedEndPosition.y });
    // Make the cursor stay at a hitObject as long as possible (mainly for autopilot).
    for (const [early, late] of [
      [HitResult.Miss, HitResult.Meh],
      [HitResult.Meh, HitResult.Meh],
      [HitResult.Ok, HitResult.Ok],
    ] as const) {
      if (h.startTime - w(early) > endTime + w(late) + 50) {
        if (!(prev instanceof Spinner) && h.startTime - endTime < 1000) {
          const f = prevEnd();
          f.time = endTime + w(late);
          this.addFrameToReplay(f);
        }
        if (!(h instanceof Spinner)) this.addFrameToReplay(new OsuReplayFrame(h.startTime - w(early), { x: h.stackedPosition.x, y: h.stackedPosition.y }));
        return;
      }
    }
  }

  private addHitObjectReplay(h: OsuHitObject): void {
    // Default values for circles/sliders
    let startPosition = h.stackedPosition;
    let easing = this.preferredEasing;
    let spinnerDirection = -1;

    // The startPosition for the slider should not be its .Position, but the point on the circle whose tangent crosses the current cursor position
    // We also modify spinnerDirection so it spins in the direction it enters the spin circle, to make a smooth transition.
    // TODO: Shouldn't the spinner always spin in the same direction?
    if (h instanceof Spinner) {
      // spinners with 0 spins required will auto-complete - don't bother
      if (h.spinsRequired === 0) return;
      const prevPos = this.frames[this.frames.length - 1].position;
      const r = OsuAutoGenerator.calcSpinnerStartPosAndDirection(prevPos);
      startPosition = r.startPosition;
      spinnerDirection = r.spinnerDirection;
      const spinCentreOffset = { x: SPINNER_CENTRE.x - prevPos.x, y: SPINNER_CENTRE.y - prevPos.y };
      if (len(spinCentreOffset) > SPIN_RADIUS) {
        // If moving from outside the spinner, take a direct path to the edge of the spinner
        easing = Easing.In;
      }
    }

    // Do some nice easing for cursor movements
    if (this.frames.length > 0) this.moveToHitObject(h, startPosition, easing);

    // Add frames to click the hitobject
    this.addHitObjectClickFrames(h, startPosition, spinnerDirection);
  }

  private static calcSpinnerStartPosAndDirection(prevPos: Vec): { startPosition: Vec; spinnerDirection: number } {
    const spinCentreOffset = { x: f32(SPINNER_CENTRE.x - prevPos.x), y: f32(SPINNER_CENTRE.y - prevPos.y) };
    const distFromCentre = len(spinCentreOffset);
    const distToTangentPoint = f32(Math.sqrt(distFromCentre * distFromCentre - SPIN_RADIUS * SPIN_RADIUS));

    if (distFromCentre > SPIN_RADIUS) {
      // Previous cursor position was outside spin circle, set startPosition to the tangent point.
      // Angle between centre offset and tangent point offset.
      const angle = f32(Math.asin(SPIN_RADIUS / distFromCentre));
      const spinnerDirection = angle > 0 ? -1 : 1;
      // Rotate by angle so it's parallel to tangent line.
      // Note: like the C#, the Y rotation uses the already-rotated X.
      spinCentreOffset.x = f32(spinCentreOffset.x * Math.cos(angle) - spinCentreOffset.y * Math.sin(angle));
      spinCentreOffset.y = f32(spinCentreOffset.x * Math.sin(angle) + spinCentreOffset.y * Math.cos(angle));
      // Set length to distToTangentPoint
      const l = len(spinCentreOffset);
      if (l > 0) {
        spinCentreOffset.x = f32((spinCentreOffset.x / l) * distToTangentPoint);
        spinCentreOffset.y = f32((spinCentreOffset.y / l) * distToTangentPoint);
      }
      // Move along the tangent line, now startPosition is at the tangent point.
      return { startPosition: { x: f32(prevPos.x + spinCentreOffset.x), y: f32(prevPos.y + spinCentreOffset.y) }, spinnerDirection };
    }
    if (len(spinCentreOffset) > 0) {
      // Previous cursor position was inside spin circle, set startPosition to the nearest point on spin circle.
      const k = SPIN_RADIUS / len(spinCentreOffset);
      return { startPosition: { x: f32(SPINNER_CENTRE.x - spinCentreOffset.x * k), y: f32(SPINNER_CENTRE.y - spinCentreOffset.y * k) }, spinnerDirection: 1 };
    }
    // Degenerate case where cursor position is exactly at the centre of the spin circle.
    return { startPosition: { x: SPINNER_CENTRE.x, y: SPINNER_CENTRE.y - SPIN_RADIUS }, spinnerDirection: 1 };
  }

  private moveToHitObject(h: OsuHitObject, targetPos: Vec, easing: Easing): void {
    let lastFrame = this.frames[this.frames.length - 1];

    // Wait until Auto could "see and react" to the next note.
    const waitTime = h.startTime - Math.max(0.0, h.timePreempt - this.getReactionTime(h.startTime - h.timePreempt));
    let hasWaited = false;
    if (waitTime > lastFrame.time) {
      const f = new OsuReplayFrame(waitTime, lastFrame.position);
      f.actions = lastFrame.actions;
      lastFrame = f;
      hasWaited = true;
      this.addFrameToReplay(lastFrame);
    }

    const timeDifference = this.applyModsToTimeDelta(lastFrame.time, h.startTime);
    const lastLastFrame = this.frames.length >= 2 ? this.frames[this.frames.length - 2] : null;

    if (timeDifference >= 0) {
      // If the last frame is a key-up frame and there has been no wait period, adjust the last frame's position such that it begins eased movement instantaneously.
      if (lastLastFrame != null && lastFrame instanceof OsuKeyUpReplayFrame && !hasWaited) {
        // [lastLastFrame] ... [lastFrame] ... [current frame]
        // We want to find the cursor position at lastFrame, so interpolate between lastLastFrame and the new target position.
        lastFrame.position = valueAt(lastFrame.time, lastFrame.position, targetPos, lastLastFrame.time, h.startTime, easing);
      }
      const lastPosition = lastFrame.position;
      // Only "snap" to hitcircles if they are far enough apart. As the time between hitcircles gets shorter the snapping threshold goes up.
      for (let time = lastFrame.time + this.getFrameDelay(lastFrame.time); time < h.startTime; time += this.getFrameDelay(time)) {
        const currentPosition = valueAt(time, lastPosition, targetPos, lastFrame.time, h.startTime, easing);
        const f = new OsuReplayFrame(Math.trunc(time), { x: currentPosition.x, y: currentPosition.y });
        f.actions = lastFrame.actions;
        this.addFrameToReplay(f);
      }
    }

    // Start alternating once the time separation is too small (equivalent to 120BPM @ 1/4 divisor).
    if (timeDifference >= 0 && timeDifference < MIN_FRAME_SEPARATION_FOR_ALTERNATING) this.buttonIndex++;
    else this.buttonIndex = 0;
  }

  /** Auto reaction time for a certain moment. */
  private getReactionTime(timeInstant: number): number {
    return this.applyModsToRate(timeInstant, 100);
  }

  // Add frames to click the hitobject
  private addHitObjectClickFrames(h: OsuHitObject, startPosition: Vec, spinnerDirection: number): void {
    // Time to insert the first frame which clicks the object
    // Here we mainly need to determine which button to use
    let action: Action = this.buttonIndex % 2 === 0 ? 'LeftButton' : 'RightButton';
    const startFrame = new OsuReplayFrame(h.startTime, { x: startPosition.x, y: startPosition.y }, action);

    // TODO: Why do we delay 1 ms if the object is a spinner? There already is KEY_UP_DELAY from hEndTime.
    const hEndTime = h.endTime + KEY_UP_DELAY;
    const endDelay = h instanceof Spinner ? 1 : 0;
    const endFrame = new OsuKeyUpReplayFrame(hEndTime + endDelay, { x: h.stackedEndPosition.x, y: h.stackedEndPosition.y });

    // Decrement because we want the previous frame, not the next one
    const index = this.findInsertionIndex(startFrame) - 1;

    // If the previous frame has a button pressed, force alternation.
    // If there are frames ahead, modify those to use the new button press.
    // Do we have a previous frame? No need to check for < replay.Count since we decremented!
    if (index >= 0) {
      const previousFrame = this.frames[index];
      const previousActions = previousFrame.actions;
      // If a button is already held, then we simply alternate
      if (previousActions.length > 0) {
        // Force alternation if we have the same button. Otherwise we can just keep the naturally to us assigned button.
        if (previousActions.includes(action)) {
          action = action === 'LeftButton' ? 'RightButton' : 'LeftButton';
          startFrame.actions = [action];
        }
        // We always follow the most recent slider / spinner, so remove any other frames that occur while it exists.
        const endIndex = this.findInsertionIndex(endFrame);
        if (index < this.frames.length - 1) this.frames.splice(index + 1, Math.max(0, endIndex - (index + 1)));
        // After alternating we need to keep holding the other button in the future rather than the previous one.
        for (let j = index + 1; j < this.frames.length; ++j) {
          const frame = this.frames[j];
          // Don't affect frames which stop pressing a button!
          if (j < this.frames.length - 1 || sequenceEqual(frame.actions, previousActions)) frame.actions = [action];
        }
      }
    }

    this.addFrameToReplay(startFrame);

    // 0.05 rad/ms, or ~477 RPM, as per stable.
    // the redundant conversion from RPM to rad/ms is here for ease of testing custom SPM specs.
    const spinRpm = f32((f32(0.05) / f32(2 * Math.PI)) * 60000);
    const radsPerMillisecond = f32(f32((spinRpm * 360 * Math.PI) / 180) / 60000);

    if (h instanceof Spinner) {
      const difference = { x: startPosition.x - SPINNER_CENTRE.x, y: startPosition.y - SPINNER_CENTRE.y };
      const radius = len(difference);
      let angle = radius === 0 ? 0 : f32(Math.atan2(difference.y, difference.x));
      let t: number;
      let previousFrame = h.startTime;
      for (let nextFrame = h.startTime + this.getFrameDelay(h.startTime); nextFrame < h.endTime; nextFrame += this.getFrameDelay(nextFrame)) {
        t = this.applyModsToTimeDelta(previousFrame, nextFrame) * spinnerDirection;
        angle = f32(angle + f32(t) * radsPerMillisecond);
        const c = OsuAutoGenerator.circlePosition(angle, SPIN_RADIUS);
        this.addFrameToReplay(new OsuReplayFrame(Math.trunc(nextFrame), { x: SPINNER_CENTRE.x + c.x, y: SPINNER_CENTRE.y + c.y }, action));
        previousFrame = nextFrame;
      }
      t = this.applyModsToTimeDelta(previousFrame, h.endTime) * spinnerDirection;
      angle = f32(angle + f32(t) * radsPerMillisecond);
      const c = OsuAutoGenerator.circlePosition(angle, SPIN_RADIUS);
      const endPosition = { x: SPINNER_CENTRE.x + c.x, y: SPINNER_CENTRE.y + c.y };
      this.addFrameToReplay(new OsuReplayFrame(h.endTime, { ...endPosition }, action));
      endFrame.position = endPosition;
    } else if (h instanceof Slider) {
      for (let j = this.getFrameDelay(h.startTime); j < h.duration; j += this.getFrameDelay(h.startTime + j)) {
        const pos = h.stackedPositionAt(j / h.duration);
        this.addFrameToReplay(new OsuReplayFrame(h.startTime + j, { x: pos.x, y: pos.y }, action));
      }
      this.addFrameToReplay(new OsuReplayFrame(h.endTime, { x: h.stackedEndPosition.x, y: h.stackedEndPosition.y }, action));
    }

    // We only want to let go of our button if we are at the end of the current replay. Otherwise something is still going on after us so we need to keep the button pressed!
    if (this.frames[this.frames.length - 1].time <= endFrame.time) this.addFrameToReplay(endFrame);
  }
}

function sequenceEqual(a: Action[], b: Action[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * Generates lazer's autoplay replay for an osu! beatmap as replay events
 * (cursor moves in gamefield coordinates + button presses/releases).
 */
export function generateOsuAutoplay(playable: OsuPlayableBeatmap, rate: number, delayedMovements = false): Replay {
  const gen = new OsuAutoGenerator(playable, rate);
  gen.delayedMovements = delayedMovements;
  const frames = gen.generateFrames();
  const events: ReplayEvent[] = [];
  let held: Action[] = [];
  for (const f of frames) {
    events.push({ t: f.time, k: 'm', x: f.position.x, y: f.position.y });
    for (const a of held) if (!f.actions.includes(a)) events.push({ t: f.time, k: 'r', a });
    for (const a of f.actions) if (!held.includes(a)) events.push({ t: f.time, k: 'p', a });
    held = [...f.actions];
  }
  return { rulesetId: 0, space: 'gamefield', events, player: 'Autoplay', mods: playable.mods.list };
}

export type { OsuReplayFrame };
