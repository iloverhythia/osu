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
    this.music = new Bus(this.ctx, this.master.gain);
    this.effects = new Bus(this.ctx, this.master.gain);
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

/** A music track backed by an HTMLAudioElement (supports tempo change without pitch change). */
export class Track {
  readonly element: HTMLAudioElement;
  private source: MediaElementAudioSourceNode | null = null;
  private _rate = 1;
  private _preservePitch = true;
  readonly ready: Promise<void>;
  private failed = false;

  constructor(
    private readonly engine: AudioEngine,
    url: string,
  ) {
    const el = new Audio();
    el.preload = 'auto';
    el.crossOrigin = 'anonymous';
    el.src = url;
    this.element = el;
    this.ready = new Promise<void>(resolve => {
      const done = () => resolve();
      el.addEventListener('canplaythrough', done, { once: true });
      el.addEventListener('loadedmetadata', () => setTimeout(done, 1500), { once: true });
      el.addEventListener(
        'error',
        () => {
          this.failed = true;
          resolve();
        },
        { once: true },
      );
    });
    try {
      this.source = engine.ctx.createMediaElementSource(el);
      this.source.connect(engine.music.gain);
    } catch {
      this.source = null;
    }
  }

  get loadFailed(): boolean {
    return this.failed;
  }

  /** Track length in ms. */
  get length(): number {
    const d = this.element.duration;
    return Number.isFinite(d) ? d * 1000 : 0;
  }

  get currentTime(): number {
    return this.element.currentTime * 1000;
  }

  set currentTime(ms: number) {
    try {
      this.element.currentTime = Math.max(0, ms / 1000);
    } catch {
      /* not seekable yet */
    }
  }

  get isRunning(): boolean {
    return !this.element.paused && !this.element.ended;
  }

  get hasEnded(): boolean {
    return this.element.ended;
  }

  set rate(r: number) {
    this._rate = r;
    this.element.playbackRate = r;
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
    this.element.volume = Math.max(0, Math.min(1, v));
  }

  async start(): Promise<void> {
    await this.engine.resume();
    try {
      await this.element.play();
    } catch {
      /* blocked by autoplay policy or not loaded */
    }
  }

  stop(): void {
    this.element.pause();
  }

  dispose(): void {
    this.element.pause();
    this.source?.disconnect();
    this.element.removeAttribute('src');
    this.element.load();
  }
}
