// Port of osu.Game/Screens/Edit/EditorClock.cs: the editor's seekable clock over the beatmap track (or a virtual clock
// when there's no audio), with tempo adjustment (PlaybackControl), beat-snapped seeking (SeekBackward / SeekForward)
// and stopping at the end of the track.

import type { Track } from '../../framework/audio/AudioEngine';
import type { EditorBeatmap } from './EditorBeatmap';

export class EditorClock {
  private track: Track | null = null;
  private virtualTime = 0;
  private virtualStart = 0;
  private virtualRunning = false;
  private _rate = 1;
  private readonly listeners = new Set<() => void>();
  /** TrackLength (or a 60 second placeholder past the last object without audio). */
  private trackLength = 0;

  constructor(private readonly beatmap: EditorBeatmap) {}

  async attach(track: Track | null): Promise<void> {
    this.track = track;
    if (track) {
      await track.ready;
      track.loop = false;
      track.preservePitch = true;
      track.rate = this._rate;
      track.volume = 1;
      this.trackLength = track.length;
    }
    this.emit();
  }

  dispose(): void {
    this.stop();
    this.track?.dispose();
    this.track = null;
  }

  subscribe(l: () => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  get hasTrack(): boolean {
    return this.track != null && !this.track.loadFailed;
  }

  get trackLengthMs(): number {
    const objects = this.beatmap.lastTime;
    if (this.hasTrack && this.trackLength > 0) return this.trackLength;
    return Math.max(60000, objects + 10000);
  }

  get isRunning(): boolean {
    return this.hasTrack ? this.track!.isRunning : this.virtualRunning;
  }

  get currentTime(): number {
    if (this.hasTrack) return this.track!.currentTime;
    return this.virtualRunning ? this.virtualTime + (performance.now() - this.virtualStart) * this._rate : this.virtualTime;
  }

  get rate(): number {
    return this._rate;
  }

  set rate(r: number) {
    const t = this.currentTime;
    this._rate = r;
    if (this.track) this.track.rate = r;
    if (!this.hasTrack) {
      this.virtualTime = t;
      this.virtualStart = performance.now();
    }
    this.emit();
  }

  start(): void {
    if (this.isRunning) return;
    // Playing from the end starts again from the beginning.
    if (this.currentTime >= this.trackLengthMs - 1) this.seek(0);
    if (this.hasTrack) void this.track!.start().then(() => this.emit());
    else {
      this.virtualStart = performance.now();
      this.virtualRunning = true;
    }
    this.emit();
  }

  stop(): void {
    if (!this.isRunning) return;
    if (this.hasTrack) this.track!.stop();
    else {
      this.virtualTime = this.currentTime;
      this.virtualRunning = false;
    }
    this.emit();
  }

  togglePause(): void {
    if (this.isRunning) this.stop();
    else this.start();
  }

  seek(time: number): void {
    const t = Math.max(0, Math.min(this.trackLengthMs, time));
    if (this.hasTrack) this.track!.currentTime = t;
    else {
      this.virtualTime = t;
      this.virtualStart = performance.now();
    }
    this.emit();
  }

  /** EditorClock.SeekSnapped / seek(direction, snapped, amount) */
  seekBeat(direction: 1 | -1, amount = 1): void {
    const current = this.currentTime;
    const cp = this.beatmap.beatmap.controlPoints;
    let tp = cp.timingPointAt(current);
    if (direction < 0 && tp.time === current) {
      // When at the start of a timing section, seek using the previous section's beat length.
      tp = cp.timingPointAt(current - 1);
    }
    const seekAmount = (tp.beatLength / this.beatmap.beatDivisor) * amount;
    let seekTime = current + seekAmount * direction;
    if (!this.isRunning || Math.abs(seekAmount) < 100) {
      // Snap to the nearest tick in the direction of travel.
      const closest = Math.round((current - tp.time) / seekAmount) * seekAmount + tp.time;
      if (Math.abs(closest - current) > 1 && Math.sign(closest - current) === direction) seekTime = closest;
      else seekTime = tp.time + Math.round((seekTime - tp.time) / seekAmount) * seekAmount;
      // Don't jump past the next timing point.
      const next = cp.timingPoints.find(p => p.time > current);
      if (direction > 0 && next && seekTime > next.time) seekTime = next.time;
    }
    this.seek(seekTime);
  }

  /** EditorSeekToPreviousHitObject / Next */
  seekToHitObject(direction: 1 | -1): void {
    const t = this.currentTime;
    const objects = this.beatmap.hitObjects;
    const target = direction > 0 ? objects.find(h => h.startTime > t + 1) : [...objects].reverse().find(h => h.startTime < t - 1);
    if (target) this.seek(target.startTime);
  }

  /** EditorSeekToPreviousTimingPoint / Next */
  seekToTimingPoint(direction: 1 | -1): void {
    const t = this.currentTime;
    const tps = this.beatmap.beatmap.controlPoints.timingPoints;
    const target = direction > 0 ? tps.find(p => p.time > t + 1) : [...tps].reverse().find(p => p.time < t - 1);
    if (target) this.seek(target.time);
  }

  /** Stops at the end of the track (EditorClock.Update). */
  update(): void {
    if (this.isRunning && this.currentTime >= this.trackLengthMs) {
      this.stop();
      this.seek(this.trackLengthMs);
    }
  }
}
