// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game/Scoring/Legacy/LegacyScoreDecoder.cs + LegacyScoreEncoder.cs (the .osr format), SerializationReader /
// SerializationWriter, LegacyReplayFrame and the per-ruleset ReplayFrame FromLegacy/ToLegacy conversions.

import lzmaSource from 'lzma/src/lzma_worker-min.js?raw';
import type { Replay, ReplayEvent } from './Replay';

interface LzmaApi {
  compress(data: Uint8Array | number[] | string, mode: number): number[];
  decompress(data: Uint8Array | number[]): string | number[];
}

let lzma: LzmaApi | null = null;
function getLzma(): LzmaApi {
  if (!lzma) {
    // The library assigns itself to `this`; evaluate it with an explicit receiver so it works as an ES module.
    const holder: { LZMA?: LzmaApi } = {};
    new Function(lzmaSource).call(holder);
    lzma = holder.LZMA!;
  }
  return lzma;
}

// LegacyMods flags
const LEGACY_MODS: [string, number][] = [
  ['NF', 1],
  ['EZ', 2],
  ['HD', 8],
  ['HR', 16],
  ['SD', 32],
  ['DT', 64],
  ['RX', 128],
  ['HT', 256],
  ['NC', 512],
  ['FL', 1024],
  ['AT', 2048],
  ['SO', 4096],
  ['AP', 8192],
  ['PF', 16384],
  ['4K', 32768],
  ['5K', 65536],
  ['6K', 131072],
  ['7K', 262144],
  ['8K', 524288],
  ['FI', 1048576],
  ['RD', 2097152],
  ['CN', 4194304],
  ['9K', 16777216],
  ['1K', 67108864],
  ['3K', 134217728],
  ['2K', 268435456],
  ['MR', 1073741824],
];

/** Ruleset.ConvertFromLegacyMods (NC implies DT, PF implies SD in the bitfield). */
export function modsFromLegacy(flags: number): string[] {
  const out: string[] = [];
  for (const [acr, bit] of LEGACY_MODS) if ((flags & bit) !== 0 || (bit === 1073741824 && flags < 0 && (flags >>> 0) & bit)) out.push(acr);
  if (out.includes('NC')) out.splice(out.indexOf('DT'), out.includes('DT') ? 1 : 0);
  if (out.includes('PF')) out.splice(out.indexOf('SD'), out.includes('SD') ? 1 : 0);
  return out;
}

export function modsToLegacy(mods: string[]): number {
  let flags = 0;
  for (const m of mods) {
    const e = LEGACY_MODS.find(([a]) => a === m);
    if (e) flags |= e[1];
    if (m === 'NC') flags |= 64;
    if (m === 'PF') flags |= 32;
    if (m === 'DC') flags |= 256;
  }
  return flags >>> 0;
}

// ---- SerializationReader / Writer ----

class Reader {
  private pos = 0;
  private view: DataView;
  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  byte(): number {
    return this.bytes[this.pos++];
  }
  int16(): number {
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }
  int32(): number {
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }
  int64(): bigint {
    const v = this.view.getBigInt64(this.pos, true);
    this.pos += 8;
    return v;
  }
  uleb(): number {
    let result = 0;
    let shift = 0;
    for (;;) {
      const b = this.byte();
      result |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
    }
    return result >>> 0;
  }
  string(): string {
    const marker = this.byte();
    if (marker === 0) return '';
    if (marker !== 0x0b) throw new Error('Invalid string in replay');
    const len = this.uleb();
    const s = new TextDecoder().decode(this.bytes.subarray(this.pos, this.pos + len));
    this.pos += len;
    return s;
  }
  byteArray(): Uint8Array {
    const len = this.int32();
    if (len <= 0) return new Uint8Array(0);
    const b = this.bytes.subarray(this.pos, this.pos + len);
    this.pos += len;
    return b;
  }
  get remaining(): number {
    return this.bytes.length - this.pos;
  }
}

class Writer {
  private chunks: number[] = [];
  byte(v: number): void {
    this.chunks.push(v & 0xff);
  }
  int16(v: number): void {
    this.byte(v);
    this.byte(v >> 8);
  }
  int32(v: number): void {
    for (let i = 0; i < 4; i++) this.byte(v >> (8 * i));
  }
  int64(v: bigint): void {
    for (let i = 0n; i < 8n; i++) this.byte(Number((v >> (8n * i)) & 0xffn));
  }
  string(s: string): void {
    if (!s) {
      this.byte(0);
      return;
    }
    const bytes = new TextEncoder().encode(s);
    this.byte(0x0b);
    let len = bytes.length;
    do {
      let b = len & 0x7f;
      len >>>= 7;
      if (len !== 0) b |= 0x80;
      this.byte(b);
    } while (len !== 0);
    for (const b of bytes) this.byte(b);
  }
  bytes(b: ArrayLike<number>): void {
    this.int32(b.length);
    for (let i = 0; i < b.length; i++) this.byte(b[i]);
  }
  finish(): Uint8Array {
    return new Uint8Array(this.chunks);
  }
}

// .NET DateTime ticks <-> JS ms
const TICKS_AT_EPOCH = 621355968000000000n;

export interface LegacyFrame {
  time: number;
  x: number;
  y: number;
  buttons: number;
}

export interface DecodedOsr {
  rulesetId: number;
  version: number;
  beatmapMD5: string;
  playerName: string;
  count300: number;
  count100: number;
  count50: number;
  countGeki: number;
  countKatu: number;
  countMiss: number;
  totalScore: number;
  maxCombo: number;
  mods: string[];
  date: number;
  frames: LegacyFrame[];
}

/** LegacyScoreDecoder.Parse (score + replay frames). */
export function decodeOsr(bytes: Uint8Array, beatmapFormatVersion = 14): DecodedOsr {
  const r = new Reader(bytes);
  const rulesetId = r.byte();
  const version = r.int32();
  const beatmapMD5 = r.string();
  const playerName = r.string();
  r.string(); // replay MD5
  const count300 = r.int16();
  const count100 = r.int16();
  const count50 = r.int16();
  const countGeki = r.int16();
  const countKatu = r.int16();
  const countMiss = r.int16();
  const totalScore = r.int32();
  const maxCombo = r.int16();
  r.byte(); // perfect
  const mods = modsFromLegacy(r.int32());
  r.string(); // health graph
  const ticks = r.int64();
  const date = Number((ticks - TICKS_AT_EPOCH) / 10000n);
  const compressed = r.byteArray();
  const frames = compressed.length > 0 ? readLegacyReplay(decompressText(compressed), rulesetId, beatmapFormatVersion < 5 ? 24 : 0) : [];
  return { rulesetId, version, beatmapMD5, playerName, count300, count100, count50, countGeki, countKatu, countMiss, totalScore, maxCombo, mods, date, frames };
}

function decompressText(data: Uint8Array): string {
  const out = getLzma().decompress(data);
  if (typeof out === 'string') return out;
  return new TextDecoder().decode(Uint8Array.from(out, b => b & 0xff));
}

/** LegacyScoreDecoder.readLegacyReplay */
function readLegacyReplay(text: string, rulesetId: number, beatmapOffset: number): LegacyFrame[] {
  let lastTime = beatmapOffset;
  const legacyFrames: LegacyFrame[] = [];
  for (const f of text.split(',')) {
    const split = f.split('|');
    if (split.length < 4) continue;
    if (split[0] === '-12345') continue; // seed frame
    let diff = parseInt(split[0], 10);
    if (!/^-?\d+$/.test(split[0])) diff = Math.round(parseFloat(split[0]));
    const mouseX = parseFloat(split[1]);
    const mouseY = parseFloat(split[2]);
    lastTime += diff;
    legacyFrames.push({ time: lastTime, x: mouseX, y: mouseY, buttons: parseInt(split[3], 10) || 0 });
  }
  // https://github.com/peppy/osu-stable-reference/blob/1531237b63392e82c003c712faa028406073aa8f/osu!/Play/ReplayWatcher.cs#L62-L67
  if (legacyFrames.length >= 2 && legacyFrames[1].time < legacyFrames[0].time) {
    legacyFrames[1].time = legacyFrames[0].time;
    legacyFrames[0].time = 0;
  }
  // https://github.com/peppy/osu-stable-reference/blob/1531237b63392e82c003c712faa028406073aa8f/osu!/Play/ReplayWatcher.cs#L69-L71
  if (legacyFrames.length >= 3 && legacyFrames[0].time > legacyFrames[2].time) legacyFrames[0].time = legacyFrames[1].time = legacyFrames[2].time;
  // At the start of the replay, stable places two replay frames, at time 0 and SkipBoundary - 1, respectively.
  // both frames use a position of (256, -500).
  if (legacyFrames.length >= 2 && legacyFrames[1].x === 256 && legacyFrames[1].y === -500) legacyFrames.splice(1, 1);
  if (legacyFrames.length >= 1 && legacyFrames[0].x === 256 && legacyFrames[0].y === -500) legacyFrames.splice(0, 1);

  const out: LegacyFrame[] = [];
  for (const f of legacyFrames) {
    // Todo: At some point we probably want to rewind and play back the negative-time frames
    // but for now we'll achieve equal playback to stable by skipping negative frames
    if (out.length > 0 && f.time < out[out.length - 1].time) continue;
    out.push(f);
  }
  void rulesetId;
  return out;
}

// ReplayButtonState
const LEFT1 = 1;
const RIGHT1 = 2;
const LEFT2 = 4;
const RIGHT2 = 8;

/** Converts legacy frames into input events (OsuReplayFrame / TaikoReplayFrame / ManiaReplayFrame .FromLegacy). */
export function legacyFramesToReplay(decoded: DecodedOsr): Replay {
  const events: ReplayEvent[] = [];
  let held = new Set<string>();
  const diff = (t: number, now: Set<string>) => {
    for (const a of held) if (!now.has(a)) events.push({ t, k: 'r', a });
    for (const a of now) if (!held.has(a)) events.push({ t, k: 'p', a });
    held = now;
  };
  for (const f of decoded.frames) {
    const now = new Set<string>();
    switch (decoded.rulesetId) {
      case 0:
        events.push({ t: f.time, k: 'm', x: f.x, y: f.y });
        if (f.buttons & (LEFT1 | LEFT2)) now.add('LeftButton');
        if (f.buttons & (RIGHT1 | RIGHT2)) now.add('RightButton');
        break;
      case 1:
        if (f.buttons & RIGHT1) now.add('LeftRim');
        if (f.buttons & RIGHT2) now.add('RightRim');
        if (f.buttons & LEFT1) now.add('LeftCentre');
        if (f.buttons & LEFT2) now.add('RightCentre');
        break;
      case 3: {
        let active = Math.trunc(f.x);
        let column = 1;
        while (active > 0) {
          if (active & 1) now.add(`K${column}`);
          column++;
          active >>= 1;
        }
        break;
      }
      default:
        throw new Error('osu!catch .osr replays are not supported yet');
    }
    diff(f.time, now);
  }
  return { rulesetId: decoded.rulesetId, space: 'gamefield', events, player: decoded.playerName, mods: decoded.mods };
}

export interface OsrScoreInfo {
  rulesetId: number;
  beatmapMD5: string;
  playerName: string;
  count300: number;
  count100: number;
  count50: number;
  countGeki: number;
  countKatu: number;
  countMiss: number;
  totalScore: number;
  maxCombo: number;
  perfect: boolean;
  mods: string[];
  date: number;
}

/** Builds legacy frames from a recorded replay (OsuReplayFrame / TaikoReplayFrame / ManiaReplayFrame .ToLegacy). */
export function replayToLegacyFrames(replay: Replay): LegacyFrame[] {
  const frames: LegacyFrame[] = [];
  const held = new Set<string>();
  let x = 256;
  let y = 192;
  const buttons = (): { b: number; x: number } => {
    let b = 0;
    let mx = x;
    switch (replay.rulesetId) {
      case 0:
        if (held.has('LeftButton')) b |= LEFT1 | LEFT2;
        if (held.has('RightButton')) b |= RIGHT1 | RIGHT2;
        break;
      case 1:
        if (held.has('LeftRim')) b |= RIGHT1;
        if (held.has('RightRim')) b |= RIGHT2;
        if (held.has('LeftCentre')) b |= LEFT1;
        if (held.has('RightCentre')) b |= LEFT2;
        mx = 0;
        break;
      case 3: {
        mx = 0;
        for (const a of held) {
          const n = /^K(\d+)$/.exec(a);
          if (n) mx |= 1 << (parseInt(n[1], 10) - 1);
        }
        break;
      }
      default:
        throw new Error('Exporting osu!catch replays is not supported yet');
    }
    return { b, x: mx };
  };
  for (const e of replay.events) {
    if (e.k === 'm') {
      if (replay.space !== 'gamefield') continue;
      x = e.x;
      y = e.y;
    } else if (e.k === 'p') held.add(e.a);
    else if (e.k === 'r') held.delete(e.a);
    else continue;
    const s = buttons();
    frames.push({ time: Math.round(e.t), x: s.x, y: replay.rulesetId === 0 ? y : 0, buttons: s.b });
  }
  return frames;
}

/** LegacyScoreEncoder.Encode, written as a legacy (stable-compatible) score. */
export function encodeOsr(info: OsrScoreInfo, frames: LegacyFrame[]): Uint8Array {
  const w = new Writer();
  w.byte(info.rulesetId);
  w.int32(20230621); // a stable client version: lazer imports this as a classic score and recomputes standardised score.
  w.string(info.beatmapMD5);
  w.string(info.playerName);
  w.string('');
  w.int16(info.count300);
  w.int16(info.count100);
  w.int16(info.count50);
  w.int16(info.countGeki);
  w.int16(info.countKatu);
  w.int16(info.countMiss);
  w.int32(Math.min(2147483647, Math.round(info.totalScore)));
  w.int16(info.maxCombo);
  w.byte(info.perfect ? 1 : 0);
  w.int32(modsToLegacy(info.mods) | 0);
  w.string('');
  w.int64(BigInt(Math.round(info.date)) * 10000n + TICKS_AT_EPOCH);

  let last = 0;
  const parts: string[] = [];
  for (const f of frames) {
    const t = Math.max(last, f.time);
    parts.push(`${t - last}|${+f.x.toFixed(4)}|${+f.y.toFixed(4)}|${f.buttons}`);
    last = t;
  }
  parts.push('-12345|0|0|0');
  const compressed = getLzma().compress(parts.join(','), 5);
  w.bytes(compressed);
  w.int64(0n); // online id
  return w.finish();
}
