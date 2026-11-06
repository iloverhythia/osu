// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Skinning entry points: SkinManager (current skin selection / loading), SkinImporter (.osk import) and
// LegacyBeatmapSkin creation (BeatmapSkinProvidingContainer source).

import { unzipSync } from 'fflate';
import type { AudioEngine } from '../../framework/audio/AudioEngine';
import { settings } from '../../framework/Settings';
import { hashString, type BeatmapSetRecord } from '../storage/Database';
import { mimeFor } from '../storage/Importer';
import { LegacySkinDecoder } from './LegacySkinDecoder';
import { LegacyBeatmapSkin, LegacySkin, findBlob, shouldConvertToGrayscale, type DecodedImage, type LoadedSkin, type SkinResourceDecoder } from './LegacySkin';
import { grayscaleImageData } from './SkinTexture';
import { SkinStore, type SkinInfo, type SkinRecord } from './SkinStore';

export type { LoadedSkin, SkinResourceDecoder } from './LegacySkin';
export { LegacySkin, LegacyBeatmapSkin } from './LegacySkin';
export { SkinSource, SkinAnimation, LegacyFont, resolveSkinHitSample, resolveComboColours } from './SkinSource';
export { SkinStore } from './SkinStore';
export type { SkinInfo, SkinRecord } from './SkinStore';

/** The setting holding the selected skin's id (null = the default procedural skin). */
export const ACTIVE_SKIN_SETTING = 'skin.active';

// ------------------------------------------------------------------------------------------------ decoding (browser)

const MAX_SUPPORTED_TEXTURE_SIZE = 8192;

async function decodeImage(blob: Blob, path: string): Promise<DecodedImage | null> {
  if (blob.size === 0) return null;
  try {
    let bmp = await createImageBitmap(blob);
    // MaxDimensionLimitedTextureLoaderStore: shrink images of insane dimensions to a usable size.
    if (bmp.width > MAX_SUPPORTED_TEXTURE_SIZE || bmp.height > MAX_SUPPORTED_TEXTURE_SIZE) {
      const resized = await createImageBitmap(bmp, { resizeWidth: Math.min(bmp.width, MAX_SUPPORTED_TEXTURE_SIZE), resizeHeight: Math.min(bmp.height, MAX_SUPPORTED_TEXTURE_SIZE) });
      bmp.close();
      bmp = resized;
    }
    if (shouldConvertToGrayscale(path) && typeof OffscreenCanvas !== 'undefined') {
      const canvas = new OffscreenCanvas(bmp.width, bmp.height);
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(bmp, 0, 0);
        const data = ctx.getImageData(0, 0, bmp.width, bmp.height);
        grayscaleImageData(data);
        ctx.putImageData(data, 0, 0);
        const w = bmp.width;
        const h = bmp.height;
        bmp.close();
        return { image: canvas, width: w, height: h };
      }
    }
    return { image: bmp, width: bmp.width, height: bmp.height };
  } catch {
    return null;
  }
}

export function browserDecoder(engine: AudioEngine): SkinResourceDecoder {
  let silent: AudioBuffer | null = null;
  return {
    decodeImage,
    decodeAudio: data => engine.decode(data),
    silentSample: () => (silent ??= engine.ctx.createBuffer(1, 1, engine.ctx.sampleRate)),
  };
}

// ------------------------------------------------------------------------------------------------ loading

let activeCache: { id: string; engine: AudioEngine; skin: Promise<LoadedSkin | null> } | null = null;
let beatmapCache: { key: string; engine: AudioEngine; skin: Promise<LoadedSkin | null> } | null = null;

SkinStore.subscribe(() => {
  activeCache = null;
});

/** Loads the user's currently selected skin, or null for the default procedural skin. */
export async function loadActiveSkin(engine: AudioEngine): Promise<LoadedSkin | null> {
  const id = settings.get<string | null>(ACTIVE_SKIN_SETTING, null);
  if (!id) return null;
  if (activeCache && activeCache.id === id && activeCache.engine === engine) return activeCache.skin;
  const skin = (async () => {
    const record = await SkinStore.get(id);
    if (!record) return null;
    return LegacySkin.load(record.name, record.files, browserDecoder(engine));
  })();
  activeCache = { id, engine, skin };
  skin.catch(() => {
    if (activeCache?.skin === skin) activeCache = null;
  });
  return skin;
}

/**
 * Loads the beatmap set's own skin elements (if "beatmap skins" are enabled), or null.
 * `beatmapFilename` is the difficulty's .osu file, whose [General]/[Colours] sections act as the beatmap skin's configuration
 * (LegacyBeatmapSkin is constructed with the beatmap's path as its configuration file).
 */
export async function loadBeatmapSkin(set: BeatmapSetRecord, engine: AudioEngine, beatmapFilename?: string): Promise<LoadedSkin | null> {
  if (set.builtIn) return null;
  const key = `${set.id}/${beatmapFilename ?? ''}`;
  if (beatmapCache && beatmapCache.key === key && beatmapCache.engine === engine) return beatmapCache.skin;
  const entry = set.beatmaps.find(b => b.filename === beatmapFilename) ?? set.beatmaps[0];
  // LegacyBeatmapSkin.createSkinInfo: Name = beatmapInfo.ToString()
  const name = entry ? `${entry.artist} - ${entry.title} (${entry.creator}) [${entry.difficultyName}]` : 'Beatmap skin';
  const skin = LegacyBeatmapSkin.loadBeatmap(name, set.files, browserDecoder(engine), beatmapFilename);
  beatmapCache = { key, engine, skin };
  return skin;
}

// ------------------------------------------------------------------------------------------------ import (SkinImporter)

const UNKNOWN_CREATOR = 'Unknown';

// ModelExtensions.invalid_filename_chars
// eslint-disable-next-line no-control-regex
const INVALID_FILENAME_CHARS = /["<>|\u0000-\u001f:*?\\/]/g;

/** ModelExtensions.GetValidFilename */
export function getValidFilename(filename: string): string {
  return filename.replace(INVALID_FILENAME_CHARS, '');
}

/** IEnumerable&lt;string&gt;.GetCommonPrefix (character-wise). */
export function getCommonPrefix(names: readonly string[]): string {
  if (names.length === 0) return '';
  let prefix = names[0];
  for (const s of names) {
    let i = 0;
    while (i < prefix.length && i < s.length && prefix[i] === s[i]) i++;
    prefix = prefix.slice(0, i);
  }
  return prefix;
}

/**
 * RealmArchiveModelImporter.getShortenedFilenames: strips a common folder prefix and rejects case-insensitive duplicates
 * and paths which would traverse outside of the skin's storage.
 */
export function shortenFilenames(names: readonly string[]): { original: string; shortened: string }[] {
  let prefix = getCommonPrefix(names);
  if (!(prefix.endsWith('/') || prefix.endsWith('\\'))) prefix = '';
  const seen = new Set<string>();
  const result: { original: string; shortened: string }[] = [];
  for (const file of names) {
    const shortened = file.slice(prefix.length).replace(/\\/g, '/');
    if (seen.has(shortened.toLowerCase())) throw new Error(`Multiple files with the name "${shortened}" (ignoring case) are present. Only one of them can be kept.`);
    seen.add(shortened.toLowerCase());
    if (shortened.split('/').some(p => p === '..') || shortened.startsWith('/')) throw new Error(`Filename "${file}" is not allowed.`);
    result.push({ original: file, shortened });
  }
  return result;
}

/** SkinImporter.checkSkinIniMetadata (for imports): the skin's display name and creator. */
export function importedSkinMetadata(archiveFilename: string, skinIniText: string | null): { name: string; creator: string } {
  const decoded = skinIniText != null ? new LegacySkinDecoder().decode(skinIniText).skinInfo : { name: '', creator: '' };
  const archiveName = archiveFilename.replace(/\.osk/gi, '');

  let name = decoded.name ? decoded.name : archiveName;
  const creator = decoded.creator ? decoded.creator : UNKNOWN_CREATOR;

  // For imports, we want to use the archive or folder name as part of the metadata, in addition to any existing skin.ini metadata.
  // In an ideal world, skin.ini would be the only source of metadata, but a lot of skin creators and users don't update it when making modifications.
  // In both of these cases, the expectation from the user is that the filename or folder name is displayed somewhere to identify the skin.
  const displayString = `${name} ${creator ? `(${creator})` : ''}`.trim();
  if (archiveName !== name && archiveName !== getValidFilename(displayString)) name = `${name} [${archiveName}]`;

  return { name, creator };
}

/** Builds a skin record from the files of an archive or folder. */
export async function createSkinRecord(archiveFilename: string, entries: Record<string, Blob>): Promise<SkinRecord> {
  const names = Object.keys(entries).filter(n => !n.endsWith('/') && !n.endsWith('\\'));
  if (names.length === 0) throw new Error('The skin contains no files');
  const files: Record<string, Blob> = {};
  for (const { original, shortened } of shortenFilenames(names)) files[shortened] = entries[original];

  const ini = findBlob(files, 'skin.ini');
  const iniText = ini ? await ini.text() : null;
  const { name, creator } = importedSkinMetadata(archiveFilename, iniText);

  // SkinImporter hashes .ini / .json files; include the file listing so different skins with identical ini files don't collide.
  const listing = Object.keys(files)
    .sort()
    .map(f => `${f.toLowerCase()}:${files[f].size}`)
    .join('|');
  const id = hashString(`${iniText ?? ''}\n${listing}`);
  return { id, name, creator, addedAt: Date.now(), files };
}

/** Imports a .osk skin archive (or a loose skin folder), returning the stored skin's name. The imported skin becomes the current skin. */
export async function importSkin(files: File[]): Promise<string> {
  if (files.length === 0) throw new Error('No files selected');
  let archiveFilename: string;
  const entries: Record<string, Blob> = {};

  const single = files.length === 1 ? files[0] : null;
  if (single && /\.(osk|zip)$/i.test(single.name)) {
    archiveFilename = single.name;
    let unzipped: Record<string, Uint8Array>;
    try {
      unzipped = unzipSync(new Uint8Array(await single.arrayBuffer()));
    } catch {
      throw new Error('not a valid .osk archive');
    }
    for (const [path, bytes] of Object.entries(unzipped)) {
      if (path.endsWith('/')) continue;
      entries[path] = new Blob([bytes as BlobPart], { type: mimeFor(path) });
    }
  } else {
    // A loose folder (folder picker / drag & drop): paths are relative to the picked folder's parent.
    const rel = (f: File) => ((f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name).replace(/\\/g, '/');
    const first = rel(files[0]);
    archiveFilename = first.includes('/') ? first.slice(0, first.indexOf('/')) : 'Imported skin';
    for (const f of files) entries[rel(f)] = f;
  }

  const record = await createSkinRecord(archiveFilename, entries);
  await SkinStore.put(record);
  // OsuGame.PresentSkin: the imported skin becomes the current skin.
  settings.set(ACTIVE_SKIN_SETTING, record.id);
  return record.name;
}

/** All imported skins (metadata only). */
export function listSkins(): Promise<SkinInfo[]> {
  return SkinStore.list();
}

/** Deletes an imported skin; reverts to the default skin if it was selected. */
export async function deleteSkin(id: string): Promise<void> {
  await SkinStore.delete(id);
  if (settings.get<string | null>(ACTIVE_SKIN_SETTING, null) === id) settings.set(ACTIVE_SKIN_SETTING, null);
}
