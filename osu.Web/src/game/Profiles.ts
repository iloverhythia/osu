// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Offline profiles: local users with the statistics osu-web keeps for an account (UserStatistics): play count,
// total / ranked score, hit accuracy, max combo, total hits, play time, grade counts, level and pp.
// Everything is computed from this browser's scores and play history.

import { settings } from '../framework/Settings';
import { convertStandardisedToClassic, getDisplayScore } from './scoring/DisplayScore';
import { HitResult, isBasic, isHit } from './scoring/HitResult';
import { totalPerformance } from './scoring/Performance';
import { Database, type ScoreRecord } from './storage/Database';

export interface Profile {
  id: string;
  username: string;
  createdAt: number;
  /** Avatar colour (hue). */
  hue: number;
  /** SHA-256 of the optional profile password (hex). */
  passwordHash?: string;
}

/** Counters that only exist as history (not derivable from the stored best scores). */
export interface PlayCounters {
  playCount: number;
  /** Classic-scaled total score of every completed or failed play (osu-web total_score). */
  totalScore: number;
  totalHits: number;
  /** ms */
  playTime: number;
  maxCombo: number;
  replaysWatched: number;
}

/** UserStatus as chosen in the login panel dropdown (OsuSetting.UserOnlineStatus). */
export type UserStatus = 'online' | 'dnd' | 'offline';

const PROFILES_KEY = 'profiles';
const CURRENT_KEY = 'profile.current';
const BOOTSTRAPPED_KEY = 'profiles.bootstrapped';
const countersKey = (pid: string, rulesetId: number) => `profileStats.${pid}.${rulesetId}`;
const EMPTY: PlayCounters = { playCount: 0, totalScore: 0, totalHits: 0, playTime: 0, maxCombo: 0, replaysWatched: 0 };
export const GUEST_ID = 'guest';

const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

export async function hashPassword(password: string): Promise<string> {
  const bytes = new TextEncoder().encode(`jarvsu:${password}`);
  try {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  } catch {
    // No SubtleCrypto (insecure context): a simple FNV-1a fallback; this is a local lock, not security.
    let hsh = 0x811c9dc5;
    for (const b of bytes) hsh = Math.imul(hsh ^ b, 0x01000193) >>> 0;
    return `fnv${hsh.toString(16)}`;
  }
}

export const Profiles = {
  all(): Profile[] {
    let list = settings.get<Profile[]>(PROFILES_KEY, []);
    if (list.length === 0 && !settings.get<boolean>(BOOTSTRAPPED_KEY, false)) {
      settings.set(BOOTSTRAPPED_KEY, true);
      // An existing player name becomes the first profile (keeping its scores); otherwise start signed out as Guest.
      const name = (settings.get<string>('ui.username', 'Guest') || 'Guest').trim();
      if (name && name !== 'Guest') {
        list = [{ id: newId(), username: name, createdAt: Date.now(), hue: 280 }];
        settings.set(PROFILES_KEY, list);
        settings.set(CURRENT_KEY, list[0].id);
      }
    }
    return list;
  },
  find(username: string): Profile | undefined {
    const u = username.trim().toLowerCase();
    return this.all().find(p => p.username.toLowerCase() === u);
  },
  /** The signed-in profile, or the Guest stand-in while signed out. */
  current(): Profile {
    const id = settings.get<string>(CURRENT_KEY, '');
    return this.all().find(p => p.id === id) ?? { id: GUEST_ID, username: settings.get<string>('ui.username', 'Guest') || 'Guest', createdAt: 0, hue: 280 };
  },
  signedIn(): boolean {
    return this.current().id !== GUEST_ID;
  },
  async create(username: string, password = ''): Promise<Profile> {
    const p: Profile = { id: newId(), username: username.trim(), createdAt: Date.now(), hue: Math.floor(Math.random() * 360) };
    if (password) p.passwordHash = await hashPassword(password);
    settings.set(PROFILES_KEY, [...this.all(), p]);
    this.switchTo(p.id);
    return p;
  },
  /** LoginForm.performLogin: returns an error message, or null when signed in. */
  async signIn(username: string, password: string): Promise<string | null> {
    const p = this.find(username);
    if (!p) return 'No profile with that username exists. Use "Register" to make one.';
    if (p.passwordHash && (await hashPassword(password)) !== p.passwordHash) return 'Incorrect password.';
    this.switchTo(p.id);
    return null;
  },
  signOut(): void {
    const cur = this.current();
    if (cur.id === GUEST_ID) return;
    settings.set('online.lastUsername', settings.get<boolean>('online.saveUsername', true) ? cur.username : '');
    settings.set(CURRENT_KEY, '');
    settings.set('ui.username', 'Guest');
  },
  rename(id: string, username: string): void {
    settings.set(PROFILES_KEY, this.all().map(p => (p.id === id ? { ...p, username } : p)));
    if (this.current().id === id) settings.set('ui.username', username);
  },
  async setPassword(id: string, password: string): Promise<void> {
    const hash = password ? await hashPassword(password) : undefined;
    settings.set(PROFILES_KEY, this.all().map(p => (p.id === id ? { ...p, passwordHash: hash } : p)));
  },
  remove(id: string): void {
    if (this.current().id === id) this.signOut();
    settings.set(PROFILES_KEY, this.all().filter(p => p.id !== id));
  },
  switchTo(id: string): void {
    const p = this.all().find(x => x.id === id);
    if (!p) return;
    settings.set(CURRENT_KEY, id);
    // Scores and replays record the player name.
    settings.set('ui.username', p.username);
    settings.set('online.lastUsername', settings.get<boolean>('online.saveUsername', true) ? p.username : '');
  },
  status(): UserStatus {
    return settings.get<UserStatus>('online.userStatus', 'online');
  },
  setStatus(s: UserStatus): void {
    settings.set('online.userStatus', s);
  },

  counters(pid: string, rulesetId: number): PlayCounters {
    return { ...EMPTY, ...settings.get<Partial<PlayCounters>>(countersKey(pid, rulesetId), {}) };
  },
  /** Called when a play finishes (pass or fail) — osu-web increments play count, total score, hits and play time. */
  recordPlay(rulesetId: number, play: { totalScore: number; maximumStatistics: ReadonlyMap<HitResult, number>; statistics: ReadonlyMap<HitResult, number>; maxCombo: number; playTime: number }): void {
    const pid = this.current().id;
    const c = this.counters(pid, rulesetId);
    let hits = 0;
    for (const [r, n] of play.statistics) if (isHit(r) && isBasic(r)) hits += n;
    const basic = [...play.maximumStatistics].filter(([r]) => isBasic(r)).reduce((a, [, n]) => a + n, 0);
    settings.set(countersKey(pid, rulesetId), {
      playCount: c.playCount + 1,
      totalScore: c.totalScore + convertStandardisedToClassic(rulesetId, play.totalScore, basic),
      totalHits: c.totalHits + hits,
      playTime: c.playTime + Math.max(0, play.playTime),
      maxCombo: Math.max(c.maxCombo, play.maxCombo),
      replaysWatched: c.replaysWatched,
    } satisfies PlayCounters);
  },
  recordReplayWatched(rulesetId: number): void {
    const pid = this.current().id;
    const c = this.counters(pid, rulesetId);
    settings.set(countersKey(pid, rulesetId), { ...c, replaysWatched: c.replaysWatched + 1 });
  },
};

// ------------------------------------------------------------------ levels

/**
 * The score needed to reach a level (osu! level curve):
 * level ≤ 100: 5000 / 3 × (4n³ − 3n² − n) + 1.25 × 1.8^(n − 60); above: 26 931 190 827 + 99 999 999 999 × (n − 100).
 */
export function scoreForLevel(level: number): number {
  const n = level;
  if (n <= 1) return 0;
  if (n <= 100) return (5000 / 3) * (4 * n ** 3 - 3 * n ** 2 - n) + 1.25 * Math.pow(1.8, n - 60);
  return 26931190827 + 99999999999 * (n - 100);
}

/** Level with progress as the fraction (e.g. 12.37 = level 12, 37% towards 13). */
export function levelFromScore(totalScore: number): number {
  let level = 1;
  while (scoreForLevel(level + 1) <= totalScore) level++;
  const lo = scoreForLevel(level);
  const hi = scoreForLevel(level + 1);
  return level + Math.min(0.999, Math.max(0, (totalScore - lo) / (hi - lo)));
}

// ------------------------------------------------------------------ aggregated statistics

export interface ProfileScore extends ScoreRecord {
  /** pp after the 0.95^i weighting in the best performance list. */
  weightedPp?: number;
  weight?: number;
}

export interface ProfileStatistics {
  pp: number;
  bonusPp: number;
  rankedScore: number;
  totalScore: number;
  hitAccuracy: number;
  playCount: number;
  totalHits: number;
  playTime: number;
  maxCombo: number;
  replaysWatched: number;
  level: number;
  grades: { XH: number; X: number; SH: number; S: number; A: number };
  best: ProfileScore[];
  recent: ScoreRecord[];
  firsts: ScoreRecord[];
}

export const belongsTo = (s: ScoreRecord, p: Profile): boolean => (s.profileId ? s.profileId === p.id : p.id === GUEST_ID ? s.player === 'Guest' : s.player === p.username);

/** UserStatistics for a profile and ruleset, from the stored scores (best per beatmap) and play counters. */
export async function profileStatistics(profile: Profile, rulesetId: number): Promise<ProfileStatistics> {
  let all: ScoreRecord[] = [];
  try {
    all = await Database.getAllScores();
  } catch {
    all = [];
  }
  const rulesetScores = all.filter(s => s.rulesetId === rulesetId);
  const mine = rulesetScores.filter(s => belongsTo(s, profile));

  // Best score per beatmap: by pp for performance, by score for ranked score / grades.
  const byBeatmap = new Map<string, ScoreRecord[]>();
  for (const s of mine) {
    const list = byBeatmap.get(s.beatmapHash) ?? [];
    list.push(s);
    byBeatmap.set(s.beatmapHash, list);
  }
  const bestPp: ScoreRecord[] = [];
  const bestScore: ScoreRecord[] = [];
  for (const list of byBeatmap.values()) {
    bestPp.push([...list].sort((a, b) => (b.pp ?? 0) - (a.pp ?? 0))[0]);
    bestScore.push([...list].sort((a, b) => b.totalScore - a.totalScore)[0]);
  }
  bestPp.sort((a, b) => (b.pp ?? 0) - (a.pp ?? 0));
  const perf = totalPerformance(bestPp.map(s => s.pp ?? 0));
  const best: ProfileScore[] = bestPp.map((s, i) => ({ ...s, weight: Math.pow(0.95, i), weightedPp: perf.weighted[i] }));

  // Hit accuracy: the same 0.95^i weighting over the best performance list (top 100).
  let accSum = 0;
  let weightSum = 0;
  best.slice(0, 100).forEach((s, i) => {
    const w = Math.pow(0.95, i);
    accSum += s.accuracy * w;
    weightSum += w;
  });

  const grades = { XH: 0, X: 0, SH: 0, S: 0, A: 0 };
  let rankedScore = 0;
  for (const s of bestScore) {
    rankedScore += getDisplayScore(rulesetId, s.totalScore, s.maximumStatistics ?? s.statistics, 'classic');
    if (s.rank in grades) grades[s.rank as keyof typeof grades]++;
  }

  // First places: scores that top their beatmap's local leaderboard.
  const firsts: ScoreRecord[] = [];
  const allByBeatmap = new Map<string, ScoreRecord>();
  for (const s of rulesetScores) {
    const top = allByBeatmap.get(s.beatmapHash);
    if (!top || s.totalScore > top.totalScore) allByBeatmap.set(s.beatmapHash, s);
  }
  for (const s of allByBeatmap.values()) if (belongsTo(s, profile)) firsts.push(s);

  const c = Profiles.counters(profile.id, rulesetId);
  // Plays before counters existed still count through their stored scores.
  const playCount = Math.max(c.playCount, mine.length);
  const totalScore = Math.max(c.totalScore, mine.reduce((a, s) => a + getDisplayScore(rulesetId, s.totalScore, s.maximumStatistics ?? s.statistics, 'classic'), 0));
  return {
    pp: perf.total * (bestPp.length > 0 ? 1 : 0),
    bonusPp: bestPp.length > 0 ? perf.bonus : 0,
    rankedScore,
    totalScore,
    hitAccuracy: weightSum > 0 ? accSum / weightSum : 0,
    playCount,
    totalHits: Math.max(c.totalHits, mine.reduce((a, s) => a + Object.entries(s.statistics).filter(([k]) => ['Great', 'Ok', 'Meh', 'Perfect', 'Good'].includes(k)).reduce((x, [, n]) => x + n, 0), 0)),
    playTime: c.playTime,
    maxCombo: Math.max(c.maxCombo, ...mine.map(s => s.maxCombo), 0),
    replaysWatched: c.replaysWatched,
    level: levelFromScore(totalScore),
    grades,
    best,
    recent: [...mine].sort((a, b) => b.date - a.date).slice(0, 50),
    firsts: firsts.sort((a, b) => b.date - a.date),
  };
}

// The settings "Player name" box renames the signed-in profile.
settings.subscribe(k => {
  if (k !== 'ui.username') return;
  const name = (settings.get<string>('ui.username', '') ?? '').trim();
  const cur = Profiles.current();
  if (cur.id !== GUEST_ID && name && name !== cur.username) Profiles.rename(cur.id, name);
});

// OsuSetting.SavePassword ("Stay signed in"): without it, every start of the game is signed out.
if (!settings.get<boolean>('online.staySignedIn', true)) Profiles.signOut();
