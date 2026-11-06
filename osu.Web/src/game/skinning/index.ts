// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Skinning entry points (LegacySkin / SkinManager). Stub until legacy skin support lands.

import type { AudioEngine } from '../../framework/audio/AudioEngine';
import type { BeatmapSetRecord } from '../storage/Database';

/** A loaded user skin (.osk) or beatmap skin: textures, samples and skin.ini configuration. */
export interface LoadedSkin {
  readonly name: string;
  /** Texture by lookup name without extension (e.g. "hitcircle", "default-1"); handles @2x internally. */
  getTexture(name: string): CanvasImageSource | null;
  /** Hit sample by lookup name (e.g. "normal-hitnormal"). */
  getSample(name: string): AudioBuffer | null;
  /** skin.ini value, e.g. getConfig('General', 'AllowSliderBallTint'). */
  getConfig(section: string, key: string): string | undefined;
}

/** Loads the user's currently selected skin, or null for the default procedural skin. */
export async function loadActiveSkin(_engine: AudioEngine): Promise<LoadedSkin | null> {
  return null;
}

/** Loads the beatmap set's own skin elements (if "beatmap skins" are enabled), or null. */
export async function loadBeatmapSkin(_set: BeatmapSetRecord, _engine: AudioEngine): Promise<LoadedSkin | null> {
  return null;
}

/** Imports a .osk skin archive (or a loose skin folder), returning the stored skin's name. */
export async function importSkin(_files: File[]): Promise<string> {
  throw new Error('Skin import is not supported yet');
}
