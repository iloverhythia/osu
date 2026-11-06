// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// A built-in demo beatmap set: an original procedurally generated track plus generated difficulties,
// so the game is playable immediately without importing anything.

import { LegacyBeatmapDecoder } from '../beatmaps/LegacyBeatmapDecoder';
import type { BeatmapSetRecord } from '../storage/Database';
import { entryFromBeatmap } from '../storage/Importer';

export const DEMO_SET_ID = 'builtin-demo';
const BPM = 150;
const BEAT = 60000 / BPM; // 400ms
const OFFSET = 400;
const BARS = 40;
const SAMPLE_RATE = 44100;

const CHORDS = [
  [57, 60, 64], // Am
  [53, 57, 60], // F
  [48, 52, 55], // C
  [55, 59, 62], // G
];

const midi = (n: number) => 440 * Math.pow(2, (n - 69) / 12);

/** Renders the demo song and returns a WAV blob. Each distinct 4-bar block is rendered once and then copied into place. */
export async function renderDemoTrack(): Promise<Blob> {
  const totalSeconds = (OFFSET + BARS * 4 * BEAT) / 1000 + 2;
  const out = new Float32Array(Math.ceil(SAMPLE_RATE * totalSeconds));
  const cache = new Map<string, Float32Array>();
  const jobs: Promise<void>[] = [];
  const placements: { key: string; bar: number }[] = [];
  for (let bar = 0; bar < BARS; ) {
    const section = sectionOf(bar);
    let length = 1;
    while (length < 4 && bar + length < BARS && sectionOf(bar + length) === section && (bar + length) % 4 !== 0) length++;
    const key = `${section}:${bar % 4}:${length}`;
    placements.push({ key, bar });
    if (!cache.has(key)) {
      cache.set(key, new Float32Array(0));
      jobs.push(renderBlock(section, bar % 4, length).then(b => void cache.set(key, b)));
    }
    bar += length;
  }
  await Promise.all(jobs);
  for (const { key, bar } of placements) {
    const block = cache.get(key)!;
    const offset = Math.round(((OFFSET + bar * 4 * BEAT) / 1000) * SAMPLE_RATE);
    for (let i = 0; i < block.length && offset + i < out.length; i++) out[offset + i] += block[i];
  }
  // Soft clip the overlapping tails.
  for (let i = 0; i < out.length; i++) out[i] = Math.tanh(out[i] * 1.2) * 0.9;
  return encodeWav(out, SAMPLE_RATE);
}

async function renderBlock(section: Section, chordOffset: number, bars: number): Promise<Float32Array> {
  const seconds = (bars * 4 * BEAT) / 1000 + 1.5;
  const ctx = new OfflineAudioContext(1, Math.ceil(SAMPLE_RATE * seconds), SAMPLE_RATE);
  const master = ctx.createGain();
  master.gain.value = 0.45;
  master.connect(ctx.destination);

  const noise = ctx.createBuffer(1, SAMPLE_RATE, SAMPLE_RATE);
  const nd = noise.getChannelData(0);
  let seed = 99;
  for (let i = 0; i < nd.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    nd[i] = (seed / 0x7fffffff) * 2 - 1;
  }

  const t = (beat: number) => (beat * BEAT) / 1000;

  const kick = (time: number) => {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.setValueAtTime(150, time);
    o.frequency.exponentialRampToValueAtTime(45, time + 0.15);
    g.gain.setValueAtTime(1, time);
    g.gain.exponentialRampToValueAtTime(0.001, time + 0.3);
    o.connect(g).connect(master);
    o.start(time);
    o.stop(time + 0.32);
  };
  const snare = (time: number) => {
    const s = ctx.createBufferSource();
    s.buffer = noise;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 1800;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.6, time);
    g.gain.exponentialRampToValueAtTime(0.001, time + 0.18);
    s.connect(f).connect(g).connect(master);
    s.start(time, 0.1, 0.2);
    const o = ctx.createOscillator();
    const og = ctx.createGain();
    o.frequency.value = 190;
    og.gain.setValueAtTime(0.3, time);
    og.gain.exponentialRampToValueAtTime(0.001, time + 0.1);
    o.connect(og).connect(master);
    o.start(time);
    o.stop(time + 0.12);
  };
  const hat = (time: number, open = false) => {
    const s = ctx.createBufferSource();
    s.buffer = noise;
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 7000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(open ? 0.18 : 0.12, time);
    g.gain.exponentialRampToValueAtTime(0.001, time + (open ? 0.25 : 0.05));
    s.connect(f).connect(g).connect(master);
    s.start(time, 0.3, 0.3);
  };
  const note = (time: number, freq: number, dur: number, type: OscillatorType, vol: number, cutoff = 4000) => {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(cutoff, time);
    f.frequency.exponentialRampToValueAtTime(Math.max(200, cutoff / 4), time + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, time);
    g.gain.linearRampToValueAtTime(vol, time + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, time + dur);
    o.connect(f).connect(g).connect(master);
    o.start(time);
    o.stop(time + dur + 0.02);
  };

  for (let bar = 0; bar < bars; bar++) {
    const chord = CHORDS[(chordOffset + bar) % 4];
    for (let beat = 0; beat < 4; beat++) {
      const b = bar * 4 + beat;
      if (section !== 'intro' && section !== 'break') kick(t(b));
      if (section === 'chorus' && beat % 2 === 1) kick(t(b + 0.5));
      if ((section === 'verse' || section === 'chorus') && beat % 2 === 1) snare(t(b));
      if (section !== 'break') {
        hat(t(b + 0.5), section === 'chorus' && beat === 3);
        if (section === 'chorus') hat(t(b + 0.25));
      }
      if (section !== 'intro') note(t(b), midi(chord[0] - 24), 0.35, 'sawtooth', 0.22, 900);
      if (section === 'chorus') note(t(b + 0.5), midi(chord[0] - 12), 0.18, 'sawtooth', 0.15, 1200);
    }
    for (const n of chord) note(t(bar * 4), midi(n), (4 * BEAT) / 1000, 'triangle', section === 'break' ? 0.09 : 0.05, 2500);
    if (section === 'verse' || section === 'chorus' || section === 'intro') {
      const pattern = [0, 1, 2, 1, 0, 2, 1, 2];
      for (let i = 0; i < 8; i++) {
        const n = chord[pattern[i]] + 12 + (section === 'chorus' && i % 4 === 3 ? 12 : 0);
        note(t(bar * 4 + i * 0.5), midi(n), 0.22, 'square', section === 'intro' ? 0.04 : 0.06, 3500);
      }
    }
  }
  const buffer = await ctx.startRendering();
  return buffer.getChannelData(0);
}

type Section = 'intro' | 'verse' | 'chorus' | 'break' | 'outro';

function sectionOf(bar: number): Section {
  if (bar < 4) return 'intro';
  if (bar < 12) return 'verse';
  if (bar < 20) return 'chorus';
  if (bar < 24) return 'break';
  if (bar < 32) return 'verse';
  if (bar < 39) return 'chorus';
  return 'outro';
}

function encodeWav(data: Float32Array, sampleRate: number): Blob {
  const bytes = new ArrayBuffer(44 + data.length * 2);
  const v = new DataView(bytes);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  v.setUint32(4, 36 + data.length * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, data.length * 2, true);
  for (let i = 0; i < data.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, data[i])) * 0x7fff, true);
  return new Blob([bytes], { type: 'audio/wav' });
}

/** Draws a simple abstract background image. */
export async function renderDemoBackground(): Promise<Blob | null> {
  const c = document.createElement('canvas');
  c.width = 1280;
  c.height = 720;
  const g = c.getContext('2d');
  if (!g) return null;
  const grad = g.createLinearGradient(0, 0, 1280, 720);
  grad.addColorStop(0, '#2a1440');
  grad.addColorStop(0.5, '#5b1f5e');
  grad.addColorStop(1, '#0d2b4a');
  g.fillStyle = grad;
  g.fillRect(0, 0, 1280, 720);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 70; i++) {
    const x = rnd() * 1280;
    const y = rnd() * 720;
    const s = 20 + rnd() * 120;
    g.globalAlpha = 0.05 + rnd() * 0.12;
    g.fillStyle = rnd() > 0.5 ? '#9b30ff' : '#c77dff';
    g.beginPath();
    g.moveTo(x, y - s);
    g.lineTo(x + s * 0.87, y + s * 0.5);
    g.lineTo(x - s * 0.87, y + s * 0.5);
    g.closePath();
    g.fill();
  }
  g.globalAlpha = 1;
  return new Promise(resolve => c.toBlob(b => resolve(b), 'image/jpeg', 0.85));
}

function header(version: string, mode: number, diff: { hp: number; cs: number; od: number; ar: number; sv: number; tick?: number }, extra = ''): string {
  return `osu file format v14

[General]
AudioFilename: audio.wav
AudioLeadIn: 0
PreviewTime: ${Math.round(OFFSET + 12 * 4 * BEAT)}
Countdown: 0
SampleSet: Soft
StackLeniency: 0.7
Mode: ${mode}
LetterboxInBreaks: 0
WidescreenStoryboard: 1
${extra}
[Editor]
BeatDivisor: 4

[Metadata]
Title:JarvSU demo
TitleUnicode:JarvSU demo
Artist:JarvSU
ArtistUnicode:JarvSU
Creator:JarvSU
Version:${version}
Source:
Tags:demo tutorial generated
BeatmapID:0
BeatmapSetID:-1

[Difficulty]
HPDrainRate:${diff.hp}
CircleSize:${diff.cs}
OverallDifficulty:${diff.od}
ApproachRate:${diff.ar}
SliderMultiplier:${diff.sv}
SliderTickRate:${diff.tick ?? 1}

[Events]
0,0,"bg.jpg",0,0
2,${Math.round(OFFSET + 20 * 4 * BEAT)},${Math.round(OFFSET + 24 * 4 * BEAT - BEAT)}

[TimingPoints]
${OFFSET},${BEAT},4,2,0,60,1,0
${Math.round(OFFSET + 12 * 4 * BEAT)},-100,4,2,0,70,0,1
${Math.round(OFFSET + 20 * 4 * BEAT)},-100,4,2,0,50,0,0
${Math.round(OFFSET + 32 * 4 * BEAT)},-100,4,2,0,70,0,1
${Math.round(OFFSET + 39 * 4 * BEAT)},-100,4,2,0,60,0,0

`;
}

const time = (beat: number) => Math.round(OFFSET + beat * BEAT);

interface OsuMapOptions {
  divisor: number; // notes per beat in dense parts
  sliderBeats: number;
  sv: number;
  spacing: number;
}

/** Generates an osu! standard difficulty mixing circles, several slider curve types and a spinner. */
function generateOsuMap(version: string, diff: { hp: number; cs: number; od: number; ar: number; sv: number }, opts: OsuMapOptions): string {
  const lines: string[] = [];
  let newCombo = true;
  let angle = 0;
  let pos = { x: 256, y: 192 };
  const clampPos = (p: { x: number; y: number }) => ({ x: Math.round(Math.min(480, Math.max(32, p.x))), y: Math.round(Math.min(352, Math.max(32, p.y))) });
  const step = (dist: number, turn: number) => {
    angle += turn;
    let next = { x: pos.x + Math.cos(angle) * dist, y: pos.y + Math.sin(angle) * dist };
    if (next.x < 40 || next.x > 472 || next.y < 40 || next.y > 344) {
      angle += Math.PI * 0.75;
      next = { x: pos.x + Math.cos(angle) * dist, y: pos.y + Math.sin(angle) * dist };
    }
    pos = clampPos(next);
    return pos;
  };
  const type = (base: number) => {
    const t = base | (newCombo ? 4 : 0);
    newCombo = false;
    return t;
  };
  const circle = (beat: number, hitsound = 0) => {
    const p = step(opts.spacing, 0.9);
    lines.push(`${p.x},${p.y},${time(beat)},${type(1)},${hitsound},0:0:0:0:`);
  };
  const pixelLength = (beats: number) => +(opts.sv * 100 * beats).toFixed(2);
  let sliderKind = 0;
  const slider = (beat: number, beats: number, repeats = 1) => {
    const start = step(opts.spacing, 0.6);
    const len = pixelLength(beats);
    const dir = angle + Math.PI / 2;
    let curve: string;
    const k = sliderKind++ % 4;
    const ex = clampPos({ x: start.x + Math.cos(dir) * len, y: start.y + Math.sin(dir) * len });
    if (k === 0) {
      // Bezier
      const mid = clampPos({ x: (start.x + ex.x) / 2 + Math.cos(dir + Math.PI / 2) * len * 0.4, y: (start.y + ex.y) / 2 + Math.sin(dir + Math.PI / 2) * len * 0.4 });
      curve = `B|${mid.x}:${mid.y}|${ex.x}:${ex.y}`;
    } else if (k === 1) {
      // Perfect circle arc
      const mid = clampPos({ x: (start.x + ex.x) / 2 + Math.cos(dir - Math.PI / 2) * len * 0.25, y: (start.y + ex.y) / 2 + Math.sin(dir - Math.PI / 2) * len * 0.25 });
      curve = `P|${mid.x}:${mid.y}|${ex.x}:${ex.y}`;
    } else if (k === 2) {
      // Linear
      curve = `L|${ex.x}:${ex.y}`;
    } else {
      // Bezier with a red (duplicate) anchor
      const a = clampPos({ x: start.x + Math.cos(dir) * len * 0.5, y: start.y + Math.sin(dir) * len * 0.5 });
      const b = clampPos({ x: a.x + Math.cos(dir + 1.2) * len * 0.5, y: a.y + Math.sin(dir + 1.2) * len * 0.5 });
      curve = `B|${a.x}:${a.y}|${a.x}:${a.y}|${b.x}:${b.y}`;
    }
    const edgeSounds = Array.from({ length: repeats + 1 }, (_, i) => (i === 0 ? 2 : 0)).join('|');
    lines.push(`${start.x},${start.y},${time(beat)},${type(2)},0,${curve},${repeats},${len},${edgeSounds},${Array(repeats + 1).fill('0:0').join('|')},0:0:0:0:`);
    // Leave the cursor at the slider end for the next object.
    if (repeats % 2 === 1) pos = ex;
  };

  for (let bar = 4; bar < BARS - 1; bar++) {
    const section = sectionOf(bar);
    const b0 = bar * 4;
    if (section === 'break') continue;
    if (bar % 2 === 0) newCombo = true;
    if (section === 'verse') {
      if (bar % 4 === 0) {
        slider(b0, opts.sliderBeats);
        circle(b0 + 2, 0);
        circle(b0 + 3, 8);
      } else if (bar % 4 === 1) {
        for (let i = 0; i < 4; i++) circle(b0 + i, i % 2 === 1 ? 8 : 0);
      } else if (bar % 4 === 2) {
        slider(b0, 0.5, 2);
        slider(b0 + 2, Math.min(1.5, opts.sliderBeats));
      } else {
        circle(b0, 0);
        circle(b0 + 1, 8);
        if (opts.divisor >= 2) {
          circle(b0 + 2, 0);
          circle(b0 + 2.5, 0);
          circle(b0 + 3, 8);
        } else circle(b0 + 3, 8);
      }
    } else if (section === 'chorus') {
      if (bar === 38) {
        lines.push(`256,192,${time(b0)},${type(8)},4,${time(b0 + 4 + 2)}`);
        newCombo = true;
        bar++;
        continue;
      }
      if (bar % 2 === 0) {
        circle(b0, 4);
        slider(b0 + 1, 0.5);
        for (let i = 0; i < (opts.divisor >= 2 ? 4 : 2); i++) circle(b0 + 2 + i / (opts.divisor >= 2 ? 2 : 1), i % 2 ? 8 : 0);
      } else {
        slider(b0, opts.sliderBeats, opts.divisor >= 2 ? 1 : 1);
        circle(b0 + 2, 8);
        slider(b0 + 3, 0.5);
      }
    } else if (section === 'intro') {
      // nothing
    }
  }
  return header(version, 0, diff) + '[HitObjects]\n' + lines.join('\n') + '\n';
}

/** Generates a native 4K osu!mania difficulty. */
function generateManiaMap(): string {
  const lines: string[] = [];
  const colX = (c: number) => Math.floor((c * 512) / 4 + 64);
  let col = 0;
  const next = () => (col = (col + 1 + (col % 3)) % 4);
  for (let bar = 4; bar < BARS - 1; bar++) {
    const section = sectionOf(bar);
    if (section === 'break') continue;
    const b0 = bar * 4;
    if (section === 'verse') {
      for (let i = 0; i < 4; i++) lines.push(`${colX(next())},192,${time(b0 + i)},1,0,0:0:0:0:`);
      if (bar % 2 === 1) lines.push(`${colX(next())},192,${time(b0 + 2.5)},1,0,0:0:0:0:`);
    } else if (section === 'chorus') {
      // Hold on the downbeat, chords and 8ths elsewhere.
      const hold = next();
      lines.push(`${colX(hold)},192,${time(b0)},128,0,${time(b0 + 1.5)}:0:0:0:0:`);
      for (let i = 2; i < 8; i++) {
        let c = next();
        if (c === hold && i < 3) c = (c + 1) % 4;
        lines.push(`${colX(c)},192,${time(b0 + i / 2)},1,0,0:0:0:0:`);
      }
      if (bar % 2 === 0) lines.push(`${colX((hold + 2) % 4)},192,${time(b0 + 2)},1,0,0:0:0:0:`);
    }
  }
  lines.sort((a, b) => Number(a.split(',')[2]) - Number(b.split(',')[2]));
  return header('4K Groove', 3, { hp: 7, cs: 4, od: 7, ar: 5, sv: 1.4 }) + '[HitObjects]\n' + lines.join('\n') + '\n';
}

let cached: Promise<BeatmapSetRecord> | null = null;

/** Builds (once per session) the demo beatmap set record. */
export function getDemoSet(): Promise<BeatmapSetRecord> {
  if (!cached) {
    cached = (async () => {
      const [audio, bg] = await Promise.all([renderDemoTrack(), renderDemoBackground()]);
      const maps: Record<string, string> = {
        'JarvSU - demo (JarvSU) [Easy].osu': generateOsuMap('Easy', { hp: 3, cs: 3, od: 3, ar: 4, sv: 1.0 }, { divisor: 1, sliderBeats: 1.5, sv: 1.0, spacing: 110 }),
        'JarvSU - demo (JarvSU) [Normal].osu': generateOsuMap('Normal', { hp: 5, cs: 4, od: 6, ar: 7, sv: 1.4 }, { divisor: 2, sliderBeats: 1, sv: 1.4, spacing: 130 }),
        'JarvSU - demo (JarvSU) [4K Groove].osu': generateManiaMap(),
      };
      const files: Record<string, Blob> = { 'audio.wav': audio };
      if (bg) files['bg.jpg'] = bg;
      const beatmaps = [];
      for (const [name, text] of Object.entries(maps)) {
        files[name] = new Blob([text], { type: 'text/plain' });
        beatmaps.push(entryFromBeatmap(name, text, LegacyBeatmapDecoder.decode(text)));
      }
      return { id: DEMO_SET_ID, onlineId: -1, addedAt: 0, files, beatmaps, builtIn: true };
    })();
  }
  return cached;
}

/** Exposed for tests: the raw .osu text of the generated difficulties. */
export const demoMaps = {
  osuNormal: () => generateOsuMap('Normal', { hp: 5, cs: 4, od: 6, ar: 7, sv: 1.4 }, { divisor: 2, sliderBeats: 1, sv: 1.4, spacing: 130 }),
  osuEasy: () => generateOsuMap('Easy', { hp: 3, cs: 3, od: 3, ar: 4, sv: 1.0 }, { divisor: 1, sliderBeats: 1.5, sv: 1.0, spacing: 110 }),
  mania: () => generateManiaMap(),
};
