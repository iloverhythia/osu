// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game/Storyboards/Drawables/DrawableStoryboardSample.cs (a PausableSkinnableSound for a StoryboardSampleInfo),
// for all storyboard samples at once. Samples are played on the effects bus of the AudioEngine, with the gameplay rate applied as a
// frequency adjustment (ModRateAdjust implements IApplicableToSample that way).

import type { AudioEngine } from '../../framework/audio/AudioEngine';
import type { StoryboardSampleInfo } from './Storyboard';

/** The amount of time allowable beyond the start time of the sample, for the sample to start. */
const allowable_late_start = 100;

interface SampleChannel {
  readonly info: StoryboardSampleInfo;
  readonly buffer: AudioBuffer;
  requestedPlaying: boolean;
  source: AudioBufferSourceNode | null;
}

export class DrawableStoryboardSamples {
  private readonly channels: SampleChannel[];
  /** Index of the first channel whose start time is after the last update time. */
  private next = 0;
  private lastTime: number | null = null;
  private wasRunning = true;

  constructor(
    private readonly engine: AudioEngine,
    samples: { info: StoryboardSampleInfo; buffer: AudioBuffer }[],
  ) {
    this.channels = samples.map(s => ({ info: s.info, buffer: s.buffer, requestedPlaying: false, source: null }));
    this.channels.sort((a, b) => a.info.startTime - b.info.startTime);
  }

  get count(): number {
    return this.channels.length;
  }

  update(time: number, running: boolean, rate: number): void {
    if (this.channels.length === 0) return;

    if (!running) {
      // SamplePlaybackDisabledChanged: storyboards regularly have long running samples that would otherwise play out while paused,
      // so (non-looping) samples are stopped immediately.
      if (this.wasRunning) for (const c of this.channels) this.stop(c);
      this.wasRunning = false;
      this.lastTime = time;
      return;
    }
    this.wasRunning = true;

    const last = this.lastTime ?? time;
    this.lastTime = time;

    if (time < last) {
      // Rewound: samples which haven't started yet at the new time are stopped (and may play again once their start time is passed).
      while (this.next > 0 && this.channels[this.next - 1].info.startTime > time) {
        const c = this.channels[--this.next];
        this.stop(c);
        c.requestedPlaying = false;
      }
      return;
    }

    while (this.next < this.channels.length && this.channels[this.next].info.startTime <= time) {
      const c = this.channels[this.next++];
      const start = c.info.startTime;
      // Ensure that we've elapsed from a point before the sample's start time before playing, and only play the sample if we're within
      // an allowable range from the sample's start, to reduce layering if we've been fast-forwarded far into the future.
      if (last <= start && !c.requestedPlaying && time - start < allowable_late_start) this.play(c, rate);
    }
  }

  private play(c: SampleChannel, rate: number): void {
    c.requestedPlaying = true;
    const ctx = this.engine.ctx;
    if (ctx.state !== 'running') return;
    try {
      const src = ctx.createBufferSource();
      src.buffer = c.buffer;
      src.playbackRate.value = rate;
      const gain = ctx.createGain();
      gain.gain.value = c.info.volume / 100;
      src.connect(gain);
      gain.connect(this.engine.effects.gain);
      src.onended = () => {
        if (c.source === src) c.source = null;
        gain.disconnect();
      };
      c.source = src;
      src.start();
    } catch {
      c.source = null;
    }
  }

  private stop(c: SampleChannel): void {
    const src = c.source;
    if (!src) return;
    c.source = null;
    try {
      src.stop();
    } catch {
      /* already stopped */
    }
  }

  dispose(): void {
    for (const c of this.channels) this.stop(c);
  }
}
