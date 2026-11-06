// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Local beatmap state kept alongside the library (replacing realm fields):
//   - BeatmapCollection (name + beatmap MD5 hashes), ordered by name,
//   - BeatmapInfo.Hidden (BeatmapManager.Hide / Restore / RestoreAll),
//   - BeatmapSetInfo.DeletePending (soft deletion, restorable until the next launch purges it).

import { settings } from '../framework/Settings';
import type { BeatmapEntry } from './storage/Database';

export interface BeatmapCollection {
  id: string;
  name: string;
  /** BeatmapMD5Hashes */
  hashes: string[];
  lastModified: number;
}

const COLLECTIONS_KEY = 'collections';
const HIDDEN_KEY = 'beatmaps.hidden';
const DELETE_PENDING_KEY = 'beatmaps.deletePending';

/** The MD5 identifying a beatmap in collections (the file hash when the MD5 hasn't been computed yet). */
export const collectionKey = (e: Pick<BeatmapEntry, 'md5' | 'hash'>): string => e.md5 ?? e.hash;

export const Collections = {
  /** All collections, ordered by name (as the collection dropdown and grouping use them). */
  all(): BeatmapCollection[] {
    const list = settings.get<BeatmapCollection[]>(COLLECTIONS_KEY, []);
    return [...list].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  },
  get(id: string): BeatmapCollection | undefined {
    return this.all().find(c => c.id === id);
  },
  save(list: BeatmapCollection[]): void {
    settings.set(COLLECTIONS_KEY, list);
  },
  create(name: string): BeatmapCollection {
    const c: BeatmapCollection = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`, name, hashes: [], lastModified: Date.now() };
    this.save([...this.all(), c]);
    return c;
  },
  rename(id: string, name: string): void {
    this.save(this.all().map(c => (c.id === id ? { ...c, name, lastModified: Date.now() } : c)));
  },
  remove(id: string): void {
    this.save(this.all().filter(c => c.id !== id));
  },
  removeAll(): number {
    const n = this.all().length;
    this.save([]);
    return n;
  },
  /** CollectionToggleMenuItem */
  toggle(id: string, key: string, state: boolean): void {
    this.save(
      this.all().map(c => {
        if (c.id !== id) return c;
        const hashes = c.hashes.filter(h => h !== key);
        if (state) hashes.push(key);
        return { ...c, hashes, lastModified: Date.now() };
      }),
    );
  },
};

// ------------------------------------------------------------------ hidden difficulties

export const HiddenBeatmaps = {
  all(): Set<string> {
    return new Set(settings.get<string[]>(HIDDEN_KEY, []));
  },
  isHidden(hash: string): boolean {
    return this.all().has(hash);
  },
  /** BeatmapManager.CanHide: at least one other difficulty of the set stays visible. */
  canHide(setHashes: string[], hash: string): boolean {
    const hidden = this.all();
    return !hidden.has(hash) && setHashes.filter(h => !hidden.has(h)).length > 1;
  },
  hide(hash: string): void {
    const s = this.all();
    s.add(hash);
    settings.set(HIDDEN_KEY, [...s]);
  },
  /** BeatmapManager.Restore(BeatmapSetInfo) */
  restoreSet(setHashes: string[]): void {
    const s = this.all();
    for (const h of setHashes) s.delete(h);
    settings.set(HIDDEN_KEY, [...s]);
  },
  /** BeatmapManager.RestoreAll */
  restoreAll(): number {
    const n = this.all().size;
    settings.set(HIDDEN_KEY, []);
    return n;
  },
};

// ------------------------------------------------------------------ soft deletion

export const DeletePending = {
  all(): string[] {
    return settings.get<string[]>(DELETE_PENDING_KEY, []);
  },
  isPending(setId: string): boolean {
    return this.all().includes(setId);
  },
  mark(setId: string): void {
    if (!this.isPending(setId)) settings.set(DELETE_PENDING_KEY, [...this.all(), setId]);
  },
  clear(): string[] {
    const ids = this.all();
    settings.set(DELETE_PENDING_KEY, []);
    return ids;
  },
};
