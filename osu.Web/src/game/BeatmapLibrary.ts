// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// In-memory view over stored beatmap sets (BeatmapManager equivalent).

import { getDemoSet } from './demo/Demo';
import { DeletePending } from './Collections';
import { BeatmapSetRecord, Database } from './storage/Database';

export class BeatmapLibrary {
  sets: BeatmapSetRecord[] = [];
  private listeners = new Set<() => void>();
  private loaded: Promise<void> | null = null;
  storageAvailable = true;

  load(): Promise<void> {
    if (!this.loaded) this.loaded = this.reload();
    return this.loaded;
  }

  /** True while the built-in demo set is still being generated. */
  demoPending = true;

  async reload(): Promise<void> {
    // Don't block on the (generated) demo set: show stored sets first.
    void getDemoSet().then(demo => {
      this.demoPending = false;
      if (!this.sets.some(s => s.id === demo.id)) {
        this.sets = [...this.sets, demo];
        this.emit();
      }
    });
    let stored: BeatmapSetRecord[] = [];
    try {
      stored = await Database.getAllSets();
      // Sets deleted during a previous session (DeletePending) are purged on the next launch.
      if (!this.purged) {
        this.purged = true;
        const pending = new Set(DeletePending.clear());
        for (const id of pending) await Database.deleteSet(id).catch(() => {});
        stored = stored.filter(s => !pending.has(s.id));
      } else stored = stored.filter(s => !DeletePending.isPending(s.id));
    } catch {
      this.storageAvailable = false;
    }
    stored.sort((a, b) => b.addedAt - a.addedAt);
    const demo = this.sets.find(s => s.builtIn);
    this.sets = demo ? [...stored, demo] : stored;
    this.emit();
  }

  add(sets: BeatmapSetRecord[]): void {
    const ids = new Set(sets.map(s => s.id));
    this.sets = [...sets, ...this.sets.filter(s => !ids.has(s.id))];
    this.emit();
  }

  private purged = false;
  private readonly pendingDeletion = new Map<string, BeatmapSetRecord>();

  /** BeatmapManager.Delete: marks the set DeletePending (restorable until the next launch). */
  softDelete(id: string): void {
    const set = this.sets.find(s => s.id === id);
    if (!set || set.builtIn) return;
    DeletePending.mark(id);
    this.pendingDeletion.set(id, set);
    this.sets = this.sets.filter(s => s.id !== id);
    this.emit();
  }

  /** BeatmapManager.UndeleteAll ("Restore all recently deleted beatmaps"). */
  restoreDeleted(): number {
    const ids = DeletePending.clear();
    const restored = ids.map(id => this.pendingDeletion.get(id)).filter((s): s is BeatmapSetRecord => s != null);
    for (const id of ids) this.pendingDeletion.delete(id);
    if (restored.length > 0) this.add(restored);
    return ids.length;
  }

  async remove(id: string): Promise<void> {
    await Database.deleteSet(id);
    this.sets = this.sets.filter(s => s.id !== id);
    this.emit();
  }

  subscribe(l: () => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }
}
