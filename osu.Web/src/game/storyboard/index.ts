// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Storyboard entry points: loading (WorkingBeatmapCache.BeatmapManagerWorkingBeatmap.GetStoryboard — the .osu's own [Events] as the primary
// stream plus the beatmap set's .osb) and the player-facing wrapper around DrawableStoryboard (lazer's DimmableStoryboard / Player usage).

import type { AudioEngine } from '../../framework/audio/AudioEngine';
import type { HitSampleInfo } from '../audio/HitSampleInfo';
import type { Beatmap } from '../beatmaps/Beatmap';
import type { WorkingBeatmap } from '../beatmaps/WorkingBeatmap';
import { isHit, isScorable } from '../scoring/HitResult';
import type { JudgementResult } from '../scoring/Judgement';
import { findFile } from '../storage/Importer';
import { DrawableStoryboard } from './DrawableStoryboard';
import { DrawableStoryboardSamples } from './DrawableStoryboardSample';
import { detectFormatVersion, LegacyStoryboardDecoder } from './LegacyStoryboardDecoder';
import { changeExtensionToNull, type Storyboard, StoryboardSampleInfo } from './Storyboard';
import { StoryboardTextureStore } from './TextureStore';

export { LegacyStoryboardDecoder } from './LegacyStoryboardDecoder';
export { Storyboard } from './Storyboard';

export interface StoryboardPlayer {
  /** When true the player should not draw the beatmap background image (StoryboardReplacesBackground). */
  readonly replacesBackground: boolean;
  /**
   * Storyboard.EarliestEventTime (excluding video): lazer's MasterGameplayClockContainer starts gameplay at
   * min(0, ruleset start time, this) so storyboard intros in negative time are shown. Null when there are no elements.
   */
  readonly earliestEventTime: number | null;
  /** Storyboard.LatestEventTime (excluding video); lazer's Player lets storyboard outros finish (with a skip button) up to this time. */
  readonly latestEventTime: number | null;
  /** Draw the layers behind the playfield (Video, Background, Fail/Pass, Foreground). */
  drawUnder(g: CanvasRenderingContext2D, width: number, height: number, time: number, state: { passing: boolean; running: boolean; rate: number }): void;
  /**
   * Draw the Overlay layer above the playfield. Pass the current background dim (0..1) as `state.dim`: lazer dims the Overlay layer with
   * the rest of the storyboard even though it is shown above the playfield.
   */
  drawOver(g: CanvasRenderingContext2D, width: number, height: number, time: number, state: { passing: boolean; running: boolean; rate: number; dim?: number }): void;
  /** GameplayState.ApplyResult: drives "HitObjectHit" trigger groups. Optional for the player to call. */
  onJudgement?(result: JudgementResult): void;
  /** GameplayState.ApplySamples (hit object / key press hitsounds as they are played): drives "HitSound…" trigger groups. Optional. */
  onSamplesPlayed?(samples: readonly HitSampleInfo[]): void;
  dispose(): void;
}

const AUDIO_EXTENSIONS = ['.wav', '.ogg', '.mp3'];

/** WorkingBeatmapCache.getMainStoryboardFilename (matches stable): "Artist - Title (Creator).osb", sanitised by GetValidFilename. */
export function getMainStoryboardFilename(metadata: { artist: string; title: string; audioFile: string; creator: string }): string {
  const audioBase = changeExtensionToNull(metadata.audioFile.split(/[\\/]/).pop() ?? '');
  const baseFilename =
    (metadata.artist.length > 0 ? `${metadata.artist} - ${metadata.title}` : audioBase) + (metadata.creator.length > 0 ? ` (${metadata.creator})` : '') + '.osb';
  // intentionally chosen to match stable (see ModelExtensions.invalid_filename_chars).
  return baseFilename.replace(/["<>|\u0000-\u001f:*?\\/]/g, '');
}

/** Finds the beatmap set's storyboard file: lazer's main storyboard filename, or (more permissively) the set's only .osb file. */
function findStoryboardFile(files: Record<string, Blob>, beatmap: Beatmap): Blob | undefined {
  const main = findFile(files, getMainStoryboardFilename(beatmap.metadata));
  if (main) return main;
  const osbs = Object.keys(files).filter(f => f.toLowerCase().endsWith('.osb'));
  return osbs.length === 1 ? files[osbs[0]] : undefined;
}

/** Decodes the storyboard of a beatmap from its .osu text and the set's .osb text (if any). */
export function decodeStoryboard(osuText: string, osbText: string | null, backgroundFile: string): Storyboard {
  const decoder = new LegacyStoryboardDecoder(detectFormatVersion(osuText));
  const storyboard = osbText != null ? decoder.decode(osuText, osbText) : decoder.decode(osuText);
  storyboard.backgroundFile = backgroundFile;
  return storyboard;
}

async function loadSamples(storyboard: Storyboard, store: StoryboardTextureStore, engine: AudioEngine): Promise<DrawableStoryboardSamples | null> {
  const infos: StoryboardSampleInfo[] = [];
  for (const layer of storyboard.layerList) for (const e of layer.elements) if (e instanceof StoryboardSampleInfo) infos.push(e);
  if (infos.length === 0) return null;

  // Decode each distinct file once.
  const decoded = new Map<string, Promise<AudioBuffer | null>>();
  const resolve = (info: StoryboardSampleInfo): Promise<AudioBuffer | null> => {
    // LookupNames: the full path first, then without extension (resolved with the sample store's audio extensions).
    let file: string | null = null;
    for (const name of info.lookupNames) {
      const candidates = name === info.path ? [name] : AUDIO_EXTENSIONS.map(ext => name + ext);
      for (const c of candidates) if ((file = store.getPathForFile(c))) break;
      if (file) break;
    }
    if (!file) return Promise.resolve(null);
    const key = file.toLowerCase();
    let p = decoded.get(key);
    if (!p) {
      const blob = store.getBlob(file);
      p = blob && blob.size > 0 ? blob.arrayBuffer().then(buf => engine.decode(buf)) : Promise.resolve(null);
      decoded.set(key, p);
    }
    return p;
  };

  const samples: { info: StoryboardSampleInfo; buffer: AudioBuffer }[] = [];
  await Promise.all(
    infos.map(async info => {
      const buffer = await resolve(info);
      if (buffer) samples.push({ info, buffer });
    }),
  );
  return samples.length > 0 ? new DrawableStoryboardSamples(engine, samples) : null;
}

/** Loads the storyboard (.osb + difficulty-specific events) and video for a beatmap, or null if it has none. */
export async function loadStoryboard(working: WorkingBeatmap, beatmap: Beatmap, engine: AudioEngine): Promise<StoryboardPlayer | null> {
  const files = working.set.files;
  const osuBlob = findFile(files, working.entry.filename);
  if (!osuBlob) return null;
  const osbBlob = findStoryboardFile(files, beatmap);
  const [osuText, osbText] = await Promise.all([osuBlob.text(), osbBlob ? osbBlob.text() : Promise.resolve(null)]);

  const storyboard = decodeStoryboard(osuText, osbText, beatmap.metadata.backgroundFile);
  if (!storyboard.hasDrawable) return null;

  const store = new StoryboardTextureStore(files, storyboard);
  const samples = await loadSamples(storyboard, store, engine);
  const drawable = new DrawableStoryboard(storyboard, store, samples);

  // Make sure what is visible when gameplay starts is decoded (Player starts at min(0, first object - lead-in) - AudioLeadIn).
  const firstObject = beatmap.hitObjects.length > 0 ? beatmap.hitObjects[0].startTime : 0;
  const startGuess = Math.min(0, firstObject - 2100) - beatmap.audioLeadIn;
  await Promise.race([drawable.preload(startGuess, 3000), new Promise(r => setTimeout(r, 10000))]);

  // Player.cs: storyboardReplacesBackground.Value = Storyboard.ReplacesBackground && Storyboard.HasDrawable
  const replacesBackground = storyboard.replacesBackground && storyboard.hasDrawable;
  const earliestEventTime = storyboard.earliestEventTime;
  const latestEventTime = storyboard.latestEventTime;

  return {
    replacesBackground,
    earliestEventTime,
    latestEventTime,
    drawUnder(g, width, height, time, state) {
      drawable.update(time, state);
      drawable.drawLayers(g, width, height, time);
    },
    drawOver(g, width, height, time, state) {
      drawable.update(time, state);
      drawable.drawOverlay(g, width, height, time, state.dim ?? 0);
    },
    onJudgement(result) {
      // StoryboardTriggerController.bindHitObjectHit
      if (isHit(result.type) && isScorable(result.type)) drawable.onHitObjectHit();
    },
    onSamplesPlayed(samples) {
      drawable.onSamplesPlayed(samples);
    },
    dispose() {
      drawable.dispose();
    },
  };
}
