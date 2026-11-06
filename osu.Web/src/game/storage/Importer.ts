// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Imports .osz archives (and loose folders of .osu files) into the database. Port of BeatmapImporter's essentials.

import { unzipSync } from 'fflate';
import { LegacyBeatmapDecoder } from '../beatmaps/LegacyBeatmapDecoder';
import type { Beatmap } from '../beatmaps/Beatmap';
import { BeatmapEntry, BeatmapSetRecord, Database, hashString } from './Database';

const MIME: Record<string, string> = {
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
  osu: 'text/plain',
  osb: 'text/plain',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
};

/** Video formats browsers can't play are skipped to save space; mp4/webm/m4v are kept for video backgrounds. */
const SKIP_EXTENSIONS = new Set(['avi', 'flv', 'wmv', 'mpg', 'mkv']);

export function mimeFor(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  return MIME[ext] ?? 'application/octet-stream';
}

export function entryFromBeatmap(filename: string, text: string, beatmap: Beatmap): BeatmapEntry {
  const length = beatmap.hitObjects.length > 0 ? beatmap.lastObjectTime - beatmap.firstObjectTime : 0;
  return {
    hash: hashString(text),
    filename,
    rulesetId: beatmap.rulesetId,
    difficultyName: beatmap.difficultyName,
    title: beatmap.metadata.title,
    titleUnicode: beatmap.metadata.titleUnicode,
    artist: beatmap.metadata.artist,
    artistUnicode: beatmap.metadata.artistUnicode,
    creator: beatmap.metadata.creator,
    source: beatmap.metadata.source,
    tags: beatmap.metadata.tags,
    audioFile: beatmap.metadata.audioFile,
    backgroundFile: beatmap.metadata.backgroundFile,
    previewTime: beatmap.metadata.previewTime,
    bpm: 60000 / beatmap.controlPoints.mostCommonBeatLength(beatmap.hitObjects.length > 0 ? beatmap.lastObjectTime : null),
    length,
    objectCount: beatmap.hitObjects.length,
    circleSize: beatmap.difficulty.circleSize,
    approachRate: beatmap.difficulty.approachRate,
    overallDifficulty: beatmap.difficulty.overallDifficulty,
    drainRate: beatmap.difficulty.drainRate,
    onlineId: beatmap.onlineId,
  };
}

/** Case-insensitive lookup of a file in a set (osu! filenames are case-insensitive on Windows). */
export function findFile(files: Record<string, Blob>, name: string): Blob | undefined {
  if (!name) return undefined;
  const normalised = name.replace(/\\/g, '/');
  if (files[normalised]) return files[normalised];
  const lower = normalised.toLowerCase();
  for (const [k, v] of Object.entries(files)) if (k.toLowerCase() === lower) return v;
  return undefined;
}

export interface ImportResult {
  imported: BeatmapSetRecord[];
  errors: string[];
}

/** Builds a set record from a flat file map. Returns null if there are no valid .osu files. */
export async function createSetFromFiles(files: Record<string, Blob>, starRater?: (beatmap: Beatmap) => number): Promise<BeatmapSetRecord | null> {
  const beatmaps: BeatmapEntry[] = [];
  let onlineId = -1;
  for (const [name, blob] of Object.entries(files)) {
    if (!name.toLowerCase().endsWith('.osu')) continue;
    const text = await blob.text();
    let beatmap: Beatmap;
    try {
      beatmap = LegacyBeatmapDecoder.decode(text);
    } catch {
      continue;
    }
    if (beatmap.hitObjects.length === 0) continue;
    const entry = entryFromBeatmap(name, text, beatmap);
    if (starRater) {
      try {
        entry.stars = starRater(beatmap);
      } catch {
        /* difficulty calculation is optional */
      }
    }
    beatmaps.push(entry);
    if (beatmap.beatmapSetOnlineId > 0) onlineId = beatmap.beatmapSetOnlineId;
  }
  if (beatmaps.length === 0) return null;
  beatmaps.sort((a, b) => a.rulesetId - b.rulesetId || (a.stars ?? 0) - (b.stars ?? 0) || a.objectCount - b.objectCount);
  const id = hashString(beatmaps.map(b => b.hash).sort().join(''));
  return { id, onlineId, addedAt: Date.now(), files, beatmaps };
}

export async function importOsz(file: File | Blob, name: string, starRater?: (beatmap: Beatmap) => number): Promise<BeatmapSetRecord> {
  const data = new Uint8Array(await file.arrayBuffer());
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(data, { filter: f => !SKIP_EXTENSIONS.has(f.name.slice(f.name.lastIndexOf('.') + 1).toLowerCase()) });
  } catch (e) {
    throw new Error(`${name}: not a valid .osz archive`);
  }
  const files: Record<string, Blob> = {};
  for (const [path, bytes] of Object.entries(entries)) {
    if (path.endsWith('/')) continue;
    files[path.replace(/\\/g, '/')] = new Blob([bytes as BlobPart], { type: mimeFor(path) });
  }
  const set = await createSetFromFiles(files, starRater);
  if (!set) throw new Error(`${name}: no playable beatmaps found`);
  await Database.putSet(set);
  return set;
}

/**
 * Imports a mixed selection: .osz archives, or loose files from a folder picker / drag & drop (grouped by their parent directory),
 * which allows importing an osu!stable "Songs" folder directly.
 */
export async function importFiles(fileList: Iterable<File>, starRater?: (beatmap: Beatmap) => number, onProgress?: (done: number, total: number) => void): Promise<ImportResult> {
  const result: ImportResult = { imported: [], errors: [] };
  const archives: File[] = [];
  const loose: { path: string; file: File }[] = [];

  for (const file of fileList) {
    const lower = file.name.toLowerCase();
    if (lower.endsWith('.osz') || lower.endsWith('.zip')) {
      archives.push(file);
      continue;
    }
    const rel = ((file as File & { webkitRelativePath?: string }).webkitRelativePath || (file as File & { relativePath?: string }).relativePath || file.name).replace(/\\/g, '/');
    const ext = rel.slice(rel.lastIndexOf('.') + 1).toLowerCase();
    if (SKIP_EXTENSIONS.has(ext)) continue;
    loose.push({ path: rel, file });
  }

  // Every directory that directly contains .osu files is a beatmap set root; other files belong to the deepest root above them.
  const dirname = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
  const roots = [...new Set(loose.filter(f => f.path.toLowerCase().endsWith('.osu')).map(f => dirname(f.path)))].sort((a, b) => b.length - a.length);
  const groups = new Map<string, Record<string, Blob>>();
  for (const { path, file } of loose) {
    const root = roots.find(r => r === '' || path.startsWith(r + '/'));
    if (root === undefined) continue;
    const inner = root === '' ? path : path.slice(root.length + 1);
    if (!groups.has(root)) groups.set(root, {});
    groups.get(root)![inner] = file;
  }

  const total = archives.length + groups.size;
  let done = 0;
  for (const a of archives) {
    try {
      result.imported.push(await importOsz(a, a.name, starRater));
    } catch (e) {
      result.errors.push(e instanceof Error ? e.message : String(e));
    }
    onProgress?.(++done, total);
  }
  for (const [dir, files] of groups) {
    try {
      const set = await createSetFromFiles(files, starRater);
      if (set) {
        await Database.putSet(set);
        result.imported.push(set);
      }
    } catch (e) {
      result.errors.push(`${dir || 'files'}: ${e instanceof Error ? e.message : String(e)}`);
    }
    onProgress?.(++done, total);
  }
  return result;
}
