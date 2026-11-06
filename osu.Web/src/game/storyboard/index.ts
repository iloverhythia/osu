// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Storyboard entry points (LegacyStoryboardDecoder + DrawableStoryboard). Stub until storyboard support lands.

import type { AudioEngine } from '../../framework/audio/AudioEngine';
import type { Beatmap } from '../beatmaps/Beatmap';
import type { WorkingBeatmap } from '../beatmaps/WorkingBeatmap';

export interface StoryboardPlayer {
  /** When true the player should not draw the beatmap background image (StoryboardReplacesBackground). */
  readonly replacesBackground: boolean;
  /** Draw the layers behind the playfield (Video, Background, Fail/Pass, Foreground). */
  drawUnder(g: CanvasRenderingContext2D, width: number, height: number, time: number, state: { passing: boolean; running: boolean; rate: number }): void;
  /** Draw the Overlay layer above the playfield. */
  drawOver(g: CanvasRenderingContext2D, width: number, height: number, time: number, state: { passing: boolean; running: boolean; rate: number }): void;
  dispose(): void;
}

/** Loads the storyboard (.osb + difficulty-specific events) and video for a beatmap, or null if it has none. */
export async function loadStoryboard(_working: WorkingBeatmap, _beatmap: Beatmap, _engine: AudioEngine): Promise<StoryboardPlayer | null> {
  return null;
}
