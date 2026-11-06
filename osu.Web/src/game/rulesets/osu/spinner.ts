// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Ports of osu.Game.Rulesets.Osu/Objects/Drawables/SpinnerSpinHistory.cs and Skinning/Default/SpinnerSpmCalculator.cs,
// plus the spinning sample frequency of DrawableSpinner.cs.

const f = Math.fround;

/**
 * Stores the spinning history of a single spinner. A single, full rotation of the spinner is defined as a 360-degree rotation
 * of the spinner, starting from 0, going in a single direction. If the player spins 90-degrees clockwise, then changes direction,
 * they need to spin 90-degrees counter-clockwise to return to 0 and then continue rotating for another 360-degrees.
 */
export class SpinnerSpinHistory {
  private readonly completedSpins: { completionTime: number; direction: number }[] = [];
  /** The total accumulated (absolute) rotation. */
  private totalAccumulatedRotation = 0;
  private totalAccumulatedRotationAtLastCompletion = 0;
  /** For the current spin, the maximum absolute rotation (0..360) achieved by the user. */
  private currentSpinMaxRotation = 0;
  private lastReportTime = -Infinity;

  /** The sum of all complete spins and any current partial spin, in degrees. This is the final scoring value. */
  get totalRotation(): number {
    return f(360 * this.completedSpins.length + this.currentSpinMaxRotation);
  }

  /** The current spin, from -360..360. */
  private get currentSpinRotation(): number {
    return f(this.totalAccumulatedRotation - this.totalAccumulatedRotationAtLastCompletion);
  }

  /** Report a delta update based on user input. */
  reportDelta(currentTime: number, delta: number): void {
    if (delta === 0) return;
    this.totalAccumulatedRotation = f(this.totalAccumulatedRotation + delta);

    if (currentTime >= this.lastReportTime) {
      this.currentSpinMaxRotation = f(Math.max(this.currentSpinMaxRotation, Math.abs(this.currentSpinRotation)));

      // Handle the case where the user has completed another spin.
      while (this.currentSpinMaxRotation >= 360) {
        const direction = Math.sign(this.currentSpinRotation);
        this.completedSpins.push({ completionTime: currentTime, direction });
        // Incrementing the last completion point will cause `currentSpinRotation` to hold the remaining spin that needs to be considered.
        this.totalAccumulatedRotationAtLastCompletion = f(this.totalAccumulatedRotationAtLastCompletion + direction * 360);
        // Reset the current max as we are entering a new spin, carrying over the remainder.
        this.currentSpinMaxRotation = Math.abs(this.currentSpinRotation);
      }
    } else {
      // When rewinding, the main thing we care about is getting `totalAbsoluteRotationsAtLastCompletion` to the correct value.
      while (this.completedSpins.length > 0 && this.completedSpins[this.completedSpins.length - 1].completionTime > currentTime) {
        const segment = this.completedSpins.pop()!;
        this.totalAccumulatedRotationAtLastCompletion = f(this.totalAccumulatedRotationAtLastCompletion - segment.direction * 360);
      }
      // This is a best effort. We may not have enough data to match this 1:1, but that's okay.
      this.currentSpinMaxRotation = Math.abs(this.currentSpinRotation);
    }

    this.lastReportTime = currentTime;
  }
}

/** SpinnerSpmCalculator */
export class SpinnerSpmCalculator {
  private static readonly SPM_COUNT_DURATION = 595; // not using hundreds to avoid frame rounding issues
  private readonly records: { rotation: number; time: number }[] = [];
  private lastRecord: { rotation: number; time: number } = { rotation: 0, time: 0 };
  /** The resultant spins per minute value. */
  result = 0;

  setRotation(currentRotation: number, time: number): void {
    // If we've gone back in time, it's fine to work with a fresh set of records for now
    if (this.records.length > 0 && time < this.lastRecord.time) this.records.length = 0;

    // Never calculate SPM by same time of record to avoid 0 / 0 = NaN or X / 0 = Infinity result.
    if (this.records.length > 0 && Math.abs(time - this.lastRecord.time) <= 1e-7) return;

    if (this.records.length > 0) {
      let record = this.records[0];
      while (this.records.length > 0 && time - this.records[0].time > SpinnerSpmCalculator.SPM_COUNT_DURATION) record = this.records.shift()!;
      this.result = (((currentRotation - record.rotation) / (time - record.time)) * 1000 * 60) / 360;
    }

    this.records.push((this.lastRecord = { rotation: currentRotation, time }));
  }
}

// see https://github.com/peppy/osu-stable-reference/blob/0b8b19af621dbb282773c22b36cc0453942b98d8/osu!/Audio/AudioEngine.cs#L924
const SPINNING_SAMPLE_MODULATED_BASE_FREQUENCY = f(20_000 / 44_100);
const SPINNING_SAMPLE_MODULATION_RATIO = f(40_000 / 44_100);
const SPINNING_SAMPLE_MODULATED_MAX_FREQUENCY = f(100_000 / 44_100);

/** DrawableSpinner.Update: spinningSample.Frequency */
export function spinningSampleFrequency(progressUnclamped: number, modulate: boolean): number {
  if (!modulate) return 1;
  return Math.min(SPINNING_SAMPLE_MODULATED_MAX_FREQUENCY, SPINNING_SAMPLE_MODULATED_BASE_FREQUENCY + progressUnclamped * SPINNING_SAMPLE_MODULATION_RATIO);
}
