// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// IndexedDB storage, replacing the Realm database used by osu!lazer.

export interface BeatmapEntry {
  /** Hash of the .osu file contents. */
  hash: string;
  filename: string;
  rulesetId: number;
  difficultyName: string;
  title: string;
  titleUnicode: string;
  artist: string;
  artistUnicode: string;
  creator: string;
  source: string;
  tags: string;
  audioFile: string;
  backgroundFile: string;
  previewTime: number;
  bpm: number;
  length: number;
  objectCount: number;
  circleSize: number;
  approachRate: number;
  overallDifficulty: number;
  drainRate: number;
  /** Star rating for the native ruleset (nomod), if computed. */
  stars?: number;
  onlineId: number;
  /** MD5 of the .osu file (how osu! identifies beatmaps in replays). */
  md5?: string;
}

export interface BeatmapSetRecord {
  id: string;
  onlineId: number;
  addedAt: number;
  files: Record<string, Blob>;
  beatmaps: BeatmapEntry[];
  /** Set for built-in demo maps (generated on the fly, not deletable). */
  builtIn?: boolean;
}

export interface ScoreRecord {
  id?: number;
  beatmapHash: string;
  rulesetId: number;
  totalScore: number;
  accuracy: number;
  maxCombo: number;
  rank: string;
  mods: string[];
  statistics: Record<string, number>;
  date: number;
  pp?: number;
  player: string;
  hasReplay?: boolean;
}

const DB_NAME = 'osu-web';
const DB_VERSION = 2;

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('sets')) db.createObjectStore('sets', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('replays')) db.createObjectStore('replays', { keyPath: 'scoreId' });
        if (!db.objectStoreNames.contains('scores')) {
          const scores = db.createObjectStore('scores', { keyPath: 'id', autoIncrement: true });
          scores.createIndex('beatmapHash', 'beatmapHash');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
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

export const Database = {
  async available(): Promise<boolean> {
    try {
      await open();
      return true;
    } catch {
      return false;
    }
  },

  async getAllSets(): Promise<BeatmapSetRecord[]> {
    const db = await open();
    return wrap(db.transaction('sets').objectStore('sets').getAll());
  },

  async getSet(id: string): Promise<BeatmapSetRecord | undefined> {
    const db = await open();
    return wrap(db.transaction('sets').objectStore('sets').get(id));
  },

  async putSet(set: BeatmapSetRecord): Promise<void> {
    const db = await open();
    await wrap(db.transaction('sets', 'readwrite').objectStore('sets').put(set));
  },

  async deleteSet(id: string): Promise<void> {
    const db = await open();
    await wrap(db.transaction('sets', 'readwrite').objectStore('sets').delete(id));
  },

  async addScore(score: ScoreRecord): Promise<number> {
    const db = await open();
    return wrap(db.transaction('scores', 'readwrite').objectStore('scores').add(score)) as Promise<number>;
  },

  async getScores(beatmapHash: string): Promise<ScoreRecord[]> {
    const db = await open();
    return wrap(db.transaction('scores').objectStore('scores').index('beatmapHash').getAll(beatmapHash));
  },

  async deleteScore(id: number): Promise<void> {
    const db = await open();
    const tx = db.transaction(['scores', 'replays'], 'readwrite');
    tx.objectStore('scores').delete(id);
    tx.objectStore('replays').delete(id);
    await new Promise<void>((res, rej) => {
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  },

  async putReplay(scoreId: number, replay: import('../replays/Replay').Replay): Promise<void> {
    const db = await open();
    await wrap(db.transaction('replays', 'readwrite').objectStore('replays').put({ scoreId, replay }));
  },

  async getReplay(scoreId: number): Promise<import('../replays/Replay').Replay | undefined> {
    const db = await open();
    const rec = (await wrap(db.transaction('replays').objectStore('replays').get(scoreId))) as { replay: import('../replays/Replay').Replay } | undefined;
    return rec?.replay;
  },
};

/** FNV-1a based 64-bit-ish hash (two 32-bit lanes) rendered as hex. Synchronous and dependency-free. */
export function hashString(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x5bd1e995);
    h2 ^= h2 >>> 15;
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}
