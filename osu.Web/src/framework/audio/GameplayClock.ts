// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Equivalent of osu-framework's DecouplingFramedClock + InterpolatingFramedClock used by GameplayClockContainer:
// runs freely before the track starts (lead-in) or after it ends, and follows the track (with interpolation) otherwise.

import type { Track } from './AudioEngine';

export class GameplayClock {
  /** Current gameplay time in ms (before user offset). */
  private time = 0;
  private running = false;
  private lastRealTime = 0;
  private trackStarting = false;
  /** Time that the user / output latency offset shifts gameplay by (positive = objects later). */
  offset = 0;

  constructor(
    private readonly track: Track,
    public rate = 1,
  ) {
    track.rate = rate;
  }

  /** Gameplay time including offsets. */
  get currentTime(): number {
    return this.time - this.offset;
  }

  get isRunning(): boolean {
    return this.running;
  }

  seek(ms: number): void {
    this.time = ms;
    if (ms >= 0 && ms < this.track.length) this.track.currentTime = ms;
    else if (ms < 0) this.track.currentTime = 0;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastRealTime = performance.now();
    if (this.time >= 0) this.startTrack();
  }

  stop(): void {
    this.running = false;
    this.track.stop();
  }

  private startTrack(): void {
    if (this.trackStarting || this.track.isRunning || this.track.loadFailed) return;
    if (this.track.length > 0 && this.time >= this.track.length) return;
    this.trackStarting = true;
    this.track.currentTime = Math.max(0, this.time);
    void this.track.start().finally(() => (this.trackStarting = false));
  }

  /** Advance the clock; returns elapsed gameplay ms. */
  update(): number {
    const now = performance.now();
    const realElapsed = now - this.lastRealTime;
    this.lastRealTime = now;
    if (!this.running) return 0;

    const before = this.time;
    if (this.time < 0 || !this.track.isRunning) {
      // Decoupled: run from the real-time clock.
      this.time += realElapsed * this.rate;
      if (this.time >= 0 && !this.track.hasEnded) this.startTrack();
    } else {
      // Coupled: interpolate between track updates, correcting drift.
      const source = this.track.currentTime;
      const proposed = this.time + realElapsed * this.rate;
      const drift = source - proposed;
      if (Math.abs(drift) > 80) this.time = source;
      else this.time = proposed + drift * 0.1;
      // Never go backwards.
      if (this.time < before) this.time = before;
    }
    return this.time - before;
  }
}
