// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Gameplay-independent parts of osu.Game.Rulesets.Catch/UI/Catcher.cs + CatcherArea.cs
// (constants, catch width, CanCatch, movement and hyper-dash state), kept free of rendering so it can be unit tested.

import { f32 } from '../../../framework/math';
import { calculateScaleFromCircleSize, PLAYFIELD_CENTER_X, PLAYFIELD_WIDTH, PalpableCatchHitObject, TinyDroplet, type CatchHitObject } from './objects';

/** Catcher.BASE_SIZE */
export const CATCHER_BASE_SIZE = f32(106.75);
/** Catcher.ALLOWED_CATCH_RANGE */
export const ALLOWED_CATCH_RANGE = f32(0.8);
/** Catcher.BASE_DASH_SPEED (playfield units per ms) */
export const BASE_DASH_SPEED = 1.0;
/** Catcher.BASE_WALK_SPEED */
export const BASE_WALK_SPEED = 0.5;
/** Catcher.HYPER_DASH_TRANSITION_DURATION */
export const HYPER_DASH_TRANSITION_DURATION = 180;

/** Catcher.calculateScale: the catcher's scale for a circle size. */
export const calculateCatcherScale = (circleSize: number): number => f32(calculateScaleFromCircleSize(circleSize) * 2);

/** Catcher.CalculateCatchWidth(Vector2 scale) */
export const calculateCatchWidthFromScale = (scaleX: number): number => f32(f32(CATCHER_BASE_SIZE * Math.abs(scaleX)) * ALLOWED_CATCH_RANGE);

/** Catcher.CalculateCatchWidth(IBeatmapDifficultyInfo) */
export const calculateCatchWidth = (circleSize: number): number => calculateCatchWidthFromScale(calculateCatcherScale(circleSize));

/**
 * The movement / catching state of the catcher (Catcher + CatcherArea without drawables).
 * Positions are in playfield units (0..512), times in ms.
 */
export class CatcherState {
  /** Catcher.X */
  x = PLAYFIELD_CENTER_X;
  readonly scale: number;
  readonly catchWidth: number;
  dashing = false;
  /** -1 left, 1 right */
  visualDirection = 1;

  private hyperDashModifier = 1;
  private hyperDashDirection = 0;
  private hyperDashTargetPosition = 0;
  private lastHyperDashStartTime: number | null = null;

  constructor(circleSize: number) {
    this.scale = calculateCatcherScale(circleSize);
    this.catchWidth = calculateCatchWidthFromScale(this.scale);
  }

  get hyperDashing(): boolean {
    return this.hyperDashModifier !== 1;
  }

  /** Catcher.Speed */
  get speed(): number {
    return (this.dashing ? BASE_DASH_SPEED : BASE_WALK_SPEED) * this.hyperDashModifier;
  }

  /** Catcher.CanCatch */
  canCatch(hitObject: CatchHitObject): boolean {
    if (!(hitObject instanceof PalpableCatchHitObject)) return false;
    const halfCatchWidth = f32(this.catchWidth * 0.5);
    const x = hitObject.effectiveX;
    return x >= f32(this.x - halfCatchWidth) && x <= f32(this.x + halfCatchWidth);
  }

  /** CatcherArea.SetCatcherPosition */
  setPosition(x: number): void {
    const lastPosition = this.x;
    const newPosition = Math.min(PLAYFIELD_WIDTH, Math.max(0, f32(x)));
    this.x = newPosition;
    if (lastPosition < newPosition) this.visualDirection = 1;
    else if (lastPosition > newPosition) this.visualDirection = -1;
  }

  /** CatcherArea.Update (keyboard movement) followed by Catcher.Update (hyper-dash overshoot correction). */
  move(direction: number, elapsed: number): void {
    if (direction !== 0 && elapsed > 0) this.setPosition(this.x + this.speed * direction * elapsed);
    this.correctOvershoot();
  }

  /** Catcher.Update: correct overshooting of a hyper-dash target. */
  correctOvershoot(): void {
    if ((this.hyperDashDirection > 0 && this.hyperDashTargetPosition < this.x) || (this.hyperDashDirection < 0 && this.hyperDashTargetPosition > this.x)) {
      this.x = this.hyperDashTargetPosition;
      this.setHyperDashState(this.lastHyperDashStartTime ?? 0);
    }
  }

  /** Catcher.SetHyperDashState */
  setHyperDashState(time: number, modifier = 1, targetPosition = -1): void {
    if (modifier <= 1 || this.x === targetPosition) {
      this.hyperDashModifier = 1;
      this.hyperDashDirection = 0;
      this.lastHyperDashStartTime = null;
    } else {
      this.hyperDashModifier = modifier;
      this.hyperDashDirection = Math.sign(targetPosition - this.x);
      this.hyperDashTargetPosition = targetPosition;
      this.lastHyperDashStartTime = time;
    }
  }

  /** The hyper-dash part of Catcher.OnNewResult, for palpable objects. */
  onPalpableResult(hitObject: PalpableCatchHitObject, isHit: boolean, time: number): void {
    // droplet doesn't affect hyperdash state
    if (hitObject instanceof TinyDroplet) return;

    // if a hyper fruit was already handled this frame, just go where it says to go.
    if (this.lastHyperDashStartTime !== time) {
      const target = hitObject.hyperDashTarget;
      if (isHit && target) {
        const timeDifference = target.startTime - hitObject.startTime;
        const positionDifference = target.effectiveX - this.x;
        const velocity = positionDifference / Math.max(1.0, timeDifference - 1000.0 / 60.0);
        this.setHyperDashState(time, Math.abs(velocity) / BASE_DASH_SPEED, target.effectiveX);
      } else this.setHyperDashState(time);
    }
  }
}
