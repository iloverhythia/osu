// Port of BeatmapManager.Save / DeleteDifficulty and BeatmapExporter / LegacyBeatmapExporter for the editor:
// the encoded difficulty is written into the set under "Artist - Title (Creator) [Difficulty].osu" (renaming the
// previous file), the set's entries are rebuilt and the set is stored and refreshed in the library.

import { zipSync } from 'fflate';
import type { Beatmap } from '../../game/beatmaps/Beatmap';
import { md5 } from '../../game/replays/md5';
import { type BeatmapEntry, type BeatmapSetRecord, Database, hashString } from '../../game/storage/Database';
import { entryFromBeatmap } from '../../game/storage/Importer';
import { h } from '../dom';
import type { Game } from '../Game';

/** BeatmapManager.createBeatmapFilenameFromMetadata */
export function beatmapFilename(b: Beatmap): string {
  const name = `${b.metadata.artist} - ${b.metadata.title} (${b.metadata.creator}) [${b.difficultyName}]`;
  return `${name.replace(/[\\/:*?"<>|]/g, '').trim()}.osu`;
}

export async function saveBeatmap(game: Game, set: BeatmapSetRecord, previousFilename: string | null, text: string, beatmap: Beatmap): Promise<{ set: BeatmapSetRecord; filename: string }> {
  const filename = beatmapFilename(beatmap);
  const files = { ...set.files };
  if (previousFilename && previousFilename !== filename) delete files[previousFilename];
  const bytes = new TextEncoder().encode(text);
  files[filename] = new Blob([bytes as BlobPart], { type: 'text/plain' });

  const entry: BeatmapEntry = entryFromBeatmap(filename, text, beatmap);
  entry.md5 = md5(bytes);
  try {
    entry.stars = game.starRater(beatmap);
  } catch {
    /* optional */
  }
  const beatmaps = [...set.beatmaps.filter(b => b.filename !== filename && b.filename !== previousFilename), entry];
  beatmaps.sort((a, b) => a.rulesetId - b.rulesetId || (a.stars ?? 0) - (b.stars ?? 0) || a.objectCount - b.objectCount);

  // Built-in (generated) and brand new sets become stored sets on their first save.
  const isNewSet = set.builtIn || set.id.startsWith('new-');
  const next: BeatmapSetRecord = {
    id: isNewSet ? hashString(`${Date.now()}-${Math.random()}-${filename}`) : set.id,
    onlineId: set.onlineId,
    addedAt: isNewSet ? Date.now() : set.addedAt,
    files,
    beatmaps,
  };
  await Database.putSet(next);
  game.library.add([next]);
  if (game.working?.set.id === set.id || isNewSet) game.select(next, entry, false);
  return { set: next, filename };
}

export async function deleteDifficulty(game: Game, set: BeatmapSetRecord, filename: string): Promise<BeatmapSetRecord> {
  const files = { ...set.files };
  delete files[filename];
  const next: BeatmapSetRecord = { ...set, files, beatmaps: set.beatmaps.filter(b => b.filename !== filename) };
  if (!set.builtIn) await Database.putSet(next);
  game.library.add([next]);
  return next;
}

/** BeatmapExporter (.olz, as stored) / LegacyBeatmapExporter (.osz). */
export function exportSet(game: Game, set: BeatmapSetRecord, kind: 'osz' | 'olz'): void {
  void (async () => {
    const entries: Record<string, Uint8Array> = {};
    for (const [name, blob] of Object.entries(set.files)) entries[name] = new Uint8Array(await blob.arrayBuffer());
    const zip = zipSync(entries);
    const first = set.beatmaps[0];
    const base = first ? `${first.artist} - ${first.title}`.replace(/[\\/:*?"<>|]/g, '') : 'beatmap';
    const blob = new Blob([zip as BlobPart], { type: 'application/zip' });
    try {
      const a = h('a', { href: URL.createObjectURL(blob), download: `${base}.${kind}` });
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      game.toast(`Exported ${base}.${kind}`, 'success');
    } catch {
      game.toast('Downloads are blocked here.', 'error');
    }
  })();
}
