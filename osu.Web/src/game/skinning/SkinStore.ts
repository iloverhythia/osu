// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// IndexedDB storage for imported skins (replacing the realm-backed SkinInfo storage of SkinManager / SkinImporter).
// Uses its own database so the beatmap/score database's schema is unaffected.

export interface SkinRecord {
  id: string;
  name: string;
  creator: string;
  addedAt: number;
  /** Files by their path inside the skin (common archive folder prefix removed). */
  files: Record<string, Blob>;
}

export type SkinInfo = Omit<SkinRecord, 'files'>;

const DB_NAME = 'osu-web-skins';
const DB_VERSION = 1;
const STORE = 'skins';

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        dbPromise = null;
        reject(req.error);
      };
    });
  }
  return dbPromise;
}

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

type Listener = () => void;
const listeners = new Set<Listener>();

export const SkinStore = {
  async list(): Promise<SkinInfo[]> {
    const db = await open();
    const all: SkinRecord[] = await wrap(db.transaction(STORE).objectStore(STORE).getAll());
    return all.map(({ id, name, creator, addedAt }) => ({ id, name, creator, addedAt })).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  },

  async get(id: string): Promise<SkinRecord | undefined> {
    const db = await open();
    return wrap(db.transaction(STORE).objectStore(STORE).get(id));
  },

  async put(record: SkinRecord): Promise<void> {
    const db = await open();
    await wrap(db.transaction(STORE, 'readwrite').objectStore(STORE).put(record));
    for (const l of listeners) l();
  },

  async delete(id: string): Promise<void> {
    const db = await open();
    await wrap(db.transaction(STORE, 'readwrite').objectStore(STORE).delete(id));
    for (const l of listeners) l();
  },

  /** Notified whenever a skin is added or removed. */
  subscribe(l: Listener): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};
