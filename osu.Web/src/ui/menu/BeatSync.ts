// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game/Graphics/Containers/BeatSyncedContainer.cs, plus a small IBeatSyncProvider for the menu music
// (osu.Game/Overlays/MusicController + OsuGameBase's beat sync provider: current track time, control points, amplitudes).

import { ControlPointInfo, EffectControlPoint, TimingControlPoint } from '../../game/beatmaps/ControlPoints';
import type { WorkingBeatmap } from '../../game/beatmaps/WorkingBeatmap';
import type { Game } from '../Game';

export interface ChannelAmplitudes {
  left: number;
  right: number;
  maximum: number;
  /** 256 linear FFT magnitudes (BASS-like scale). */
  frequencies: Float32Array;
}

const EMPTY_AMPLITUDES: ChannelAmplitudes = { left: 0, right: 0, maximum: 0, frequencies: new Float32Array(256) };

/**
 * The beat sync source: the menu track (`game.previewTrack`) and the control points of the beatmap it belongs to.
 */
export class MenuBeatSource {
  private loadedFor: WorkingBeatmap | null = null;
  controlPoints: ControlPointInfo | null = null;
  private amplitudes: ChannelAmplitudes = { left: 0, right: 0, maximum: 0, frequencies: new Float32Array(256) };
  private floatBins: Float32Array<ArrayBuffer> | null = null;
  private wave: Float32Array<ArrayBuffer> | null = null;
  private amplitudesFrame = -1;

  constructor(private readonly game: Game) {}

  get running(): boolean {
    return !!this.game.previewTrack?.isRunning;
  }

  get currentTime(): number {
    return this.game.previewTrack?.currentTime ?? 0;
  }

  /** Called every frame; loads the control points of the current working beatmap. */
  update(): void {
    const w = this.game.working;
    if (w !== this.loadedFor) {
      this.loadedFor = w;
      this.controlPoints = null;
      if (w)
        void w
          .getBeatmap()
          .then(b => {
            if (this.loadedFor === w) this.controlPoints = b.controlPoints;
          })
          .catch(() => undefined);
    }
  }

  isKiaiTime(): boolean {
    if (!this.running || !this.controlPoints) return false;
    return this.controlPoints.effectPointAt(this.currentTime).kiaiMode;
  }

  /**
   * ITrack.CurrentAmplitudes. The FFT is read from the music analyser as dB and converted back to linear magnitudes,
   * scaled by 2 to roughly match BASS's (Hann-windowed) FFT512 output from Web Audio's Blackman-windowed one.
   */
  currentAmplitudes(frame: number): ChannelAmplitudes {
    const audio = this.game.audio;
    if (!audio || !this.running) return EMPTY_AMPLITUDES;
    if (frame === this.amplitudesFrame) return this.amplitudes;
    this.amplitudesFrame = frame;
    const an = audio.musicAnalyser;
    if (!this.floatBins || this.floatBins.length !== an.frequencyBinCount) this.floatBins = new Float32Array(an.frequencyBinCount);
    if (!this.wave || this.wave.length !== an.fftSize) this.wave = new Float32Array(an.fftSize);
    an.getFloatFrequencyData(this.floatBins);
    an.getFloatTimeDomainData(this.wave);
    const f = this.amplitudes.frequencies;
    for (let i = 0; i < f.length; i++) {
      const db = i < this.floatBins.length ? this.floatBins[i] : -Infinity;
      f[i] = Number.isFinite(db) ? Math.min(1, 2 * Math.pow(10, db / 20)) : 0;
    }
    let peak = 0;
    for (const v of this.wave) peak = Math.max(peak, Math.abs(v));
    peak = Math.min(1, peak);
    this.amplitudes.left = this.amplitudes.right = this.amplitudes.maximum = peak;
    return this.amplitudes;
  }
}

export type BeatHandler = (beatIndex: number, timingPoint: TimingControlPoint, effectPoint: EffectControlPoint, amplitudes: ChannelAmplitudes, beatStartTime: number) => void;

/** BeatSyncedContainer: call `update` every frame with the drawable's clock time. */
export class BeatSync {
  earlyActivationMilliseconds = 0;
  divisor = 1;
  minimumBeatLength = 50;
  allowMistimedEventFiring = true;

  timingPoint: TimingControlPoint = TimingControlPoint.DEFAULT;
  effectPoint: EffectControlPoint = EffectControlPoint.DEFAULT;
  timeUntilNextBeat = 0;
  timeSinceLastBeat = 0;
  isKiaiTime = false;
  isBeatSyncedWithTrack = false;

  private lastBeat = 0;
  private lastTimingPoint: TimingControlPoint | null = null;

  constructor(private readonly onNewBeat: BeatHandler) {}

  update(clockTime: number, source: MenuBeatSource, frame: number): void {
    this.isBeatSyncedWithTrack = source.running;
    let currentTrackTime: number;

    if (this.isBeatSyncedWithTrack) {
      currentTrackTime = source.currentTime + this.earlyActivationMilliseconds;
      this.timingPoint = source.controlPoints?.timingPointAt(currentTrackTime) ?? TimingControlPoint.DEFAULT;
      this.effectPoint = source.controlPoints?.effectPointAt(currentTrackTime) ?? EffectControlPoint.DEFAULT;
    } else {
      currentTrackTime = clockTime + this.earlyActivationMilliseconds;
      this.timingPoint = TimingControlPoint.DEFAULT;
      this.effectPoint = EffectControlPoint.DEFAULT;
    }

    let beatLength = this.timingPoint.beatLength / this.divisor;
    while (beatLength < this.minimumBeatLength) beatLength *= 2;

    let beatIndex = Math.trunc((currentTrackTime - this.timingPoint.time) / beatLength) - (this.timingPoint.omitFirstBarLine ? 1 : 0);
    if (currentTrackTime < this.timingPoint.time) beatIndex--;

    this.timeUntilNextBeat = (this.timingPoint.time - currentTrackTime) % beatLength;
    if (this.timeUntilNextBeat <= 0) this.timeUntilNextBeat += beatLength;
    this.timeSinceLastBeat = beatLength - this.timeUntilNextBeat;

    if (this.timingPoint === this.lastTimingPoint && beatIndex === this.lastBeat) return;

    if (this.allowMistimedEventFiring || Math.abs(this.timeSinceLastBeat) < 16)
      this.onNewBeat(beatIndex, this.timingPoint, this.effectPoint, source.currentAmplitudes(frame), clockTime - this.timeSinceLastBeat);

    this.lastBeat = beatIndex;
    this.lastTimingPoint = this.timingPoint;
    this.isKiaiTime = this.effectPoint.kiaiMode;
  }
}
