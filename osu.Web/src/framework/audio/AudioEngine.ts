// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Web Audio backed replacement for osu-framework's AudioManager (BASS is not available on the web).

import { synthesiseDefaultSamples } from './DefaultSamples';

export interface PlayOptions {
  pan?: number;
  /** 0..1 */
  volume?: number;
  rate?: number;
}

export interface LoopingSample {
  setVolume(v: number): void;
  setRate(rate: number): void;
  setPan(pan: number): void;
  stop(): void;
}

class Bus {
  readonly gain: GainNode;
  constructor(ctx: AudioContext, destination: AudioNode) {
    this.gain = ctx.createGain();
    this.gain.connect(destination);
  }
}

export class AudioEngine {
  readonly ctx: AudioContext;
  private readonly master: Bus;
  readonly music: Bus;
  readonly effects: Bus;
  private readonly defaultSamples = new Map<string, AudioBuffer>();
  private defaultsReady: Promise<void> | null = null;

  constructor() {
    const Ctor: typeof AudioContext = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new Ctor({ latencyHint: 'interactive' });
    this.master = new Bus(this.ctx, this.ctx.destination);
    // Music chain: track → music gain → low-pass filter → analyser → master.
    this.musicFilter = this.ctx.createBiquadFilter();
    this.musicFilter.type = 'lowpass';
    this.musicFilter.frequency.value = this.ctx.sampleRate / 2;
    this.musicFilter.Q.value = 0.7071;
    this.musicAnalyser = this.ctx.createAnalyser();
    this.musicAnalyser.fftSize = 512;
    this.musicAnalyser.smoothingTimeConstant = 0;
    this.musicFilter.connect(this.musicAnalyser).connect(this.master.gain);
    this.music = new Bus(this.ctx, this.musicFilter);
    this.effects = new Bus(this.ctx, this.master.gain);
  }

  /**
   * Low-pass filter on the music (osu-framework AudioFilter, used by FailAnimation / pause effects).
   * Set `frequency` to sampleRate / 2 to disable.
   */
  readonly musicFilter: BiquadFilterNode;

  /** Analyser on the music output (ITrack.CurrentAmplitudes, used by LogoVisualisation / menu effects). */
  readonly musicAnalyser: AnalyserNode;

  /**
   * Approximation of BASS's ChannelGetLevel-based TrackAmplitudes: returns { left, right, average } in [0, 1]
   * plus the FFT magnitudes (256 bins, 0..1) like ITrack.CurrentAmplitudes.FrequencyAmplitudes.
   */
  getAmplitudes(): { left: number; right: number; average: number; frequencies: Float32Array } {
    const bins = new Uint8Array(this.musicAnalyser.frequencyBinCount);
    this.musicAnalyser.getByteFrequencyData(bins);
    const frequencies = new Float32Array(bins.length);
    let sum = 0;
    for (let i = 0; i < bins.length; i++) {
      frequencies[i] = bins[i] / 255;
      sum += frequencies[i];
    }
    const wave = new Float32Array(this.musicAnalyser.fftSize);
    this.musicAnalyser.getFloatTimeDomainData(wave);
    let peak = 0;
    for (const v of wave) peak = Math.max(peak, Math.abs(v));
    void sum;
    return { left: peak, right: peak, average: peak, frequencies };
  }

  /** Must be called from a user gesture at least once (autoplay policy). */
  resume(): Promise<void> {
    return this.ctx.state === 'running' ? Promise.resolve() : this.ctx.resume().catch(() => undefined);
  }

  setVolumes(master: number, music: number, effects: number): void {
    this.master.gain.gain.value = master;
    this.music.gain.gain.value = music;
    this.effects.gain.gain.value = effects;
  }

  /** Output latency in ms, used to compensate the gameplay clock. */
  get outputLatency(): number {
    const c = this.ctx as AudioContext & { outputLatency?: number };
    return ((c.outputLatency || 0) + (c.baseLatency || 0)) * 1000;
  }

  loadDefaultSamples(): Promise<void> {
    if (!this.defaultsReady) {
      this.defaultsReady = synthesiseDefaultSamples(this.ctx.sampleRate).then(samples => {
        for (const [name, buffer] of samples) this.defaultSamples.set(name, buffer);
      });
    }
    return this.defaultsReady;
  }

  getDefaultSample(name: string): AudioBuffer | undefined {
    return this.defaultSamples.get(name);
  }

  async decode(data: ArrayBuffer): Promise<AudioBuffer | null> {
    try {
      return await this.ctx.decodeAudioData(data.slice(0));
    } catch {
      return null;
    }
  }

  play(buffer: AudioBuffer, opts: PlayOptions = {}): void {
    if (this.ctx.state !== 'running') return;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = opts.rate ?? 1;
    const gain = this.ctx.createGain();
    gain.gain.value = opts.volume ?? 1;
    let node: AudioNode = src;
    if (opts.pan && this.ctx.createStereoPanner) {
      const panner = this.ctx.createStereoPanner();
      panner.pan.value = Math.max(-1, Math.min(1, opts.pan));
      node.connect(panner);
      node = panner;
    }
    node.connect(gain);
    gain.connect(this.effects.gain);
    src.start();
  }

  loop(buffer: AudioBuffer, opts: PlayOptions = {}): LoopingSample {
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.playbackRate.value = opts.rate ?? 1;
    const gain = this.ctx.createGain();
    gain.gain.value = opts.volume ?? 1;
    const panner = this.ctx.createStereoPanner ? this.ctx.createStereoPanner() : null;
    if (panner) {
      panner.pan.value = opts.pan ?? 0;
      src.connect(panner).connect(gain);
    } else src.connect(gain);
    gain.connect(this.effects.gain);
    if (this.ctx.state === 'running') src.start();
    let stopped = false;
    return {
      setVolume: v => (gain.gain.value = v),
      setRate: r => (src.playbackRate.value = r),
      setPan: p => {
        if (panner) panner.pan.value = Math.max(-1, Math.min(1, p));
      },
      stop: () => {
        if (stopped) return;
        stopped = true;
        try {
          gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.02);
          src.stop(this.ctx.currentTime + 0.1);
        } catch {
          /* already stopped */
        }
      },
    };
  }
}

/**
 * A music track. Normally backed by an HTMLAudioElement (supports tempo change without pitch change); if the element can't
 * load the file (e.g. a sandbox's media policy blocks blob: URLs), it falls back to decoding the file with Web Audio and playing
 * an AudioBuffer (tempo changes then also change pitch).
 */
export class Track {
  readonly element: HTMLAudioElement;
  private source: MediaElementAudioSourceNode | null = null;
  private _rate = 1;
  private _preservePitch = true;
  private _volume = 1;
  private _loop = false;
  readonly ready: Promise<void>;
  private failed = false;

  // Web Audio fallback
  private buffer: AudioBuffer | null = null;
  private bufferNode: AudioBufferSourceNode | null = null;
  private bufferGain: GainNode | null = null;
  private bufferOffset = 0; // track position (s) when playback (re)started
  private bufferStartedAt = 0; // ctx.currentTime when playback (re)started
  private bufferPlaying = false;

  constructor(
    private readonly engine: AudioEngine,
    url: string,
    private readonly blob?: Blob,
  ) {
    const el = new Audio();
    el.preload = 'auto';
    el.crossOrigin = 'anonymous';
    this.element = el;
    this.ready = new Promise<void>(resolve => {
      const done = () => resolve();
      el.addEventListener('canplaythrough', done, { once: true });
      el.addEventListener('loadedmetadata', () => setTimeout(done, 1500), { once: true });
      el.addEventListener(
        'error',
        () => {
          void this.loadFallback().finally(done);
        },
        { once: true },
      );
    });
    el.src = url;
    try {
      this.source = engine.ctx.createMediaElementSource(el);
      this.source.connect(engine.music.gain);
    } catch {
      this.source = null;
    }
  }

  private async loadFallback(): Promise<void> {
    if (!this.blob) {
      this.failed = true;
      return;
    }
    try {
      this.buffer = await this.engine.decode(await this.blob.arrayBuffer());
    } catch {
      this.buffer = null;
    }
    if (!this.buffer) this.failed = true;
    else {
      this.bufferGain = this.engine.ctx.createGain();
      this.bufferGain.gain.value = this._volume;
      this.bufferGain.connect(this.engine.music.gain);
    }
  }

  get loadFailed(): boolean {
    return this.failed;
  }

  /** Track length in ms. */
  get length(): number {
    if (this.buffer) return this.buffer.duration * 1000;
    const d = this.element.duration;
    return Number.isFinite(d) ? d * 1000 : 0;
  }

  get currentTime(): number {
    if (this.buffer) {
      if (!this.bufferPlaying) return this.bufferOffset * 1000;
      let t = this.bufferOffset + (this.engine.ctx.currentTime - this.bufferStartedAt) * this._rate;
      if (this._loop) t %= this.buffer.duration;
      return Math.min(t, this.buffer.duration) * 1000;
    }
    return this.element.currentTime * 1000;
  }

  set currentTime(ms: number) {
    if (this.buffer) {
      const wasPlaying = this.bufferPlaying;
      this.stopBuffer();
      this.bufferOffset = Math.max(0, ms / 1000);
      if (wasPlaying) this.startBuffer();
      return;
    }
    try {
      this.element.currentTime = Math.max(0, ms / 1000);
    } catch {
      /* not seekable yet */
    }
  }

  get isRunning(): boolean {
    if (this.buffer) return this.bufferPlaying && !this.hasEnded;
    return !this.element.paused && !this.element.ended;
  }

  get hasEnded(): boolean {
    if (this.buffer) return !this._loop && this.currentTime >= this.length - 1;
    return this.element.ended;
  }

  set rate(r: number) {
    if (this.buffer && this.bufferPlaying) {
      // Re-anchor so position stays continuous across the rate change.
      this.bufferOffset = this.currentTime / 1000;
      this.bufferStartedAt = this.engine.ctx.currentTime;
    }
    this._rate = r;
    if (this.bufferNode) this.bufferNode.playbackRate.value = r;
    try {
      this.element.playbackRate = r;
    } catch {
      /* unsupported rate */
    }
  }

  get rate(): number {
    return this._rate;
  }

  set preservePitch(v: boolean) {
    this._preservePitch = v;
    const el = this.element as HTMLAudioElement & { mozPreservesPitch?: boolean; webkitPreservesPitch?: boolean };
    el.preservesPitch = v;
    el.mozPreservesPitch = v;
    el.webkitPreservesPitch = v;
  }

  get preservePitch(): boolean {
    return this._preservePitch;
  }

  set volume(v: number) {
    this._volume = Math.max(0, Math.min(1, v));
    this.element.volume = this._volume;
    if (this.bufferGain) this.bufferGain.gain.value = this._volume;
  }

  get volume(): number {
    return this._volume;
  }

  get loop(): boolean {
    return this._loop;
  }

  set loop(v: boolean) {
    this._loop = v;
    this.element.loop = v;
    if (this.bufferNode) this.bufferNode.loop = v;
  }

  private startBuffer(): void {
    if (!this.buffer || !this.bufferGain) return;
    const node = this.engine.ctx.createBufferSource();
    node.buffer = this.buffer;
    node.loop = this._loop;
    node.playbackRate.value = this._rate;
    node.connect(this.bufferGain);
    node.start(0, Math.min(this.bufferOffset, this.buffer.duration));
    this.bufferNode = node;
    this.bufferStartedAt = this.engine.ctx.currentTime;
    this.bufferPlaying = true;
  }

  private stopBuffer(): void {
    if (this.bufferPlaying) this.bufferOffset = this.currentTime / 1000;
    this.bufferPlaying = false;
    try {
      this.bufferNode?.stop();
    } catch {
      /* already stopped */
    }
    this.bufferNode?.disconnect();
    this.bufferNode = null;
  }

  async start(): Promise<void> {
    await this.engine.resume();
    if (this.buffer) {
      if (!this.bufferPlaying) this.startBuffer();
      return;
    }
    try {
      await this.element.play();
    } catch {
      /* blocked by autoplay policy or not loaded */
    }
  }

  stop(): void {
    if (this.buffer) {
      this.stopBuffer();
      return;
    }
    this.element.pause();
  }

  dispose(): void {
    this.stopBuffer();
    this.bufferGain?.disconnect();
    this.element.pause();
    this.source?.disconnect();
    this.element.removeAttribute('src');
    this.element.load();
  }
}
