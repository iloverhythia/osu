// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of the essentials of WorkingBeatmap: lazily provides the decoded beatmap, track, background and beatmap skin samples.

import type { AudioEngine } from '../../framework/audio/AudioEngine';
import { Track } from '../../framework/audio/AudioEngine';
import type { BeatmapEntry, BeatmapSetRecord } from '../storage/Database';
import { findFile } from '../storage/Importer';
import type { Beatmap } from './Beatmap';
import { LegacyBeatmapDecoder } from './LegacyBeatmapDecoder';

const AUDIO_EXTENSIONS = ['.wav', '.ogg', '.mp3'];

export class WorkingBeatmap {
  private beatmapPromise: Promise<Beatmap> | null = null;
  private backgroundUrl: string | null = null;
  private trackUrl: string | null = null;
  private sampleCache = new Map<string, AudioBuffer | null>();

  constructor(
    readonly set: BeatmapSetRecord,
    readonly entry: BeatmapEntry,
  ) {}

  getBeatmap(): Promise<Beatmap> {
    if (!this.beatmapPromise) {
      this.beatmapPromise = (async () => {
        const blob = findFile(this.set.files, this.entry.filename);
        if (!blob) throw new Error(`Missing ${this.entry.filename}`);
        return LegacyBeatmapDecoder.decode(await blob.text());
      })();
    }
    return this.beatmapPromise;
  }

  get audioBlob(): Blob | undefined {
    return findFile(this.set.files, this.entry.audioFile);
  }

  createTrack(engine: AudioEngine): Track | null {
    const blob = this.audioBlob;
    if (!blob) return null;
    if (!this.trackUrl) this.trackUrl = URL.createObjectURL(blob);
    return new Track(engine, this.trackUrl);
  }

  getBackgroundUrl(): string | null {
    if (this.backgroundUrl) return this.backgroundUrl;
    const blob = findFile(this.set.files, this.entry.backgroundFile);
    if (!blob) return null;
    this.backgroundUrl = URL.createObjectURL(blob);
    return this.backgroundUrl;
  }

  /** Loads the background as a drawable image (for the gameplay canvas). */
  async loadBackgroundImage(): Promise<HTMLImageElement | null> {
    const url = this.getBackgroundUrl();
    if (!url) return null;
    const img = new Image();
    img.src = url;
    try {
      await img.decode();
      return img;
    } catch {
      return null;
    }
  }

  /**
   * Decodes beatmap-provided hitsounds for the given lookup names ("beatmap:soft-hitclap2" etc).
   * Returns a resolver which can be used synchronously during gameplay.
   */
  async preloadSamples(engine: AudioEngine, lookupNames: Iterable<string>): Promise<(name: string) => AudioBuffer | null | undefined> {
    const jobs: Promise<void>[] = [];
    for (const full of lookupNames) {
      if (!full.startsWith('beatmap:') || this.sampleCache.has(full)) continue;
      const name = full.slice('beatmap:'.length);
      this.sampleCache.set(full, null);
      const candidates = /\.[a-z0-9]+$/i.test(name) ? [name] : AUDIO_EXTENSIONS.map(e => name + e);
      const blob = candidates.map(c => findFile(this.set.files, c)).find(b => b);
      if (!blob || blob.size < 100) continue; // 0-byte / tiny files are used to mute hitsounds in stable; treat as silent
      jobs.push(
        blob
          .arrayBuffer()
          .then(buf => engine.decode(buf))
          .then(b => void this.sampleCache.set(full, b)),
      );
    }
    await Promise.all(jobs);
    return (name: string) => this.sampleCache.get(name);
  }

  /** Whether the beatmap set contains an (intentionally) empty file for this sample, meaning "play nothing". */
  isSilenced(full: string): boolean {
    if (!full.startsWith('beatmap:')) return false;
    const name = full.slice('beatmap:'.length);
    const candidates = /\.[a-z0-9]+$/i.test(name) ? [name] : AUDIO_EXTENSIONS.map(e => name + e);
    const blob = candidates.map(c => findFile(this.set.files, c)).find(b => b);
    return !!blob && blob.size < 100;
  }

  dispose(): void {
    if (this.backgroundUrl) URL.revokeObjectURL(this.backgroundUrl);
    if (this.trackUrl) URL.revokeObjectURL(this.trackUrl);
    this.backgroundUrl = null;
    this.trackUrl = null;
  }
}
