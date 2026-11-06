// Procedural song synthesizer for the chart generator: builds an original arrangement from a seed
// (chord progression, melody, drums, bass, pads), renders it with an OfflineAudioContext and reports
// every onset it played so charts can follow the music exactly.

import { createRng, RhythmGrid, RhythmSlot, SLOTS_PER_BAR } from './RhythmGrid';

export type SongStyle = 'chill' | 'pop' | 'dance' | 'dnb';

export const SONG_STYLES: { id: SongStyle; name: string; bpm: [number, number] }[] = [
  { id: 'chill', name: 'Chill', bpm: [80, 110] },
  { id: 'pop', name: 'Pop', bpm: [110, 145] },
  { id: 'dance', name: 'Dance', bpm: [124, 150] },
  { id: 'dnb', name: 'Drum & Bass', bpm: [165, 185] },
];

export interface SynthOptions {
  style: SongStyle;
  bpm: number;
  lengthSeconds: number;
  seed: number;
}

export interface SynthResult {
  wav: Blob;
  grid: RhythmGrid;
  title: string;
}

type SectionKind = 'intro' | 'verse' | 'build' | 'chorus' | 'break' | 'outro';

const SECTION_ENERGY: Record<SectionKind, number> = { intro: 0.3, verse: 0.6, build: 0.75, chorus: 1, break: 0.2, outro: 0.35 };

const SAMPLE_RATE = 44100;
const LEAD_DELAY = 0.15; // seconds of silence before the first bar

const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const MINOR = [0, 2, 3, 5, 7, 8, 10];
// Progressions as scale degrees (0-based).
const PROGRESSIONS = {
  major: [
    [0, 4, 5, 3],
    [5, 3, 0, 4],
    [0, 5, 3, 4],
    [3, 4, 0, 5],
  ],
  minor: [
    [0, 5, 2, 6],
    [0, 3, 5, 4],
    [0, 6, 5, 6],
    [5, 6, 0, 0],
  ],
};

const WORDS_A = ['Violet', 'Neon', 'Midnight', 'Crystal', 'Electric', 'Hollow', 'Silver', 'Endless', 'Paper', 'Lunar', 'Velvet', 'Static', 'Golden', 'Distant', 'Frozen', 'Hidden'];
const WORDS_B = ['Horizon', 'Circuit', 'Skyline', 'Echoes', 'Drift', 'Signal', 'Garden', 'Pulse', 'Orbit', 'Rain', 'Mirage', 'Lights', 'Waves', 'Motion', 'Dreams', 'Comet'];

interface Note {
  /** Start, in 1/4-beat slots from the section start. */
  slot: number;
  /** Length in slots. */
  length: number;
  midi: number;
}

interface SectionPlan {
  kind: SectionKind;
  bars: number;
  drums: { kick: number[]; snare: number[]; hat: number[]; openHat: number[]; clap: number[] }; // slots within a 4-bar block
  lead: Note[]; // within a 4-bar block
  bass: Note[];
  chords: number[][]; // midi triads, one per bar
  riser: boolean;
}

const midiFreq = (n: number) => 440 * Math.pow(2, (n - 69) / 12);

function buildStructure(totalBars: number): { kind: SectionKind; bars: number }[] {
  const loop: { kind: SectionKind; bars: number }[] = [
    { kind: 'verse', bars: 8 },
    { kind: 'build', bars: 4 },
    { kind: 'chorus', bars: 8 },
    { kind: 'break', bars: 4 },
  ];
  const out: { kind: SectionKind; bars: number }[] = [{ kind: 'intro', bars: 4 }];
  let used = 4;
  const end = totalBars - 4;
  for (let i = 0; used < end; i++) {
    const s = loop[i % loop.length];
    // Never end on a break: skip it if only the outro would follow.
    if (s.kind === 'break' && used + s.bars >= end) continue;
    const bars = Math.min(s.bars, end - used);
    out.push({ kind: s.kind, bars });
    used += bars;
  }
  out.push({ kind: 'outro', bars: 4 });
  return out;
}

function planSections(opts: SynthOptions, rng: () => number): { plans: Map<SectionKind, SectionPlan>; structure: { kind: SectionKind; bars: number }[] } {
  const totalBars = Math.max(16, Math.round((opts.lengthSeconds * opts.bpm) / 60 / 4 / 4) * 4);
  const structure = buildStructure(totalBars);
  const minor = rng() < 0.55;
  const scale = minor ? MINOR : MAJOR;
  const root = 45 + Math.floor(rng() * 10); // A2..F#3
  const prog = (minor ? PROGRESSIONS.minor : PROGRESSIONS.major)[Math.floor(rng() * 4)];
  const degree = (d: number, octave = 0) => root + scale[((d % 7) + 7) % 7] + 12 * (Math.floor(d / 7) + octave);
  const triad = (d: number) => [degree(d, 1), degree(d + 2, 1), degree(d + 4, 1)];
  const chords = prog.map(triad);
  // Melody notes come from the pentatonic subset of the scale, two octaves up.
  const penta = (minor ? [0, 2, 3, 4, 6] : [0, 1, 2, 4, 5]).map(i => scale[i]);
  const melodyPitch = (step: number) => root + 24 + penta[((step % 5) + 5) % 5] + 12 * Math.floor(step / 5);

  const style = opts.style;
  const plans = new Map<SectionKind, SectionPlan>();
  for (const kind of ['intro', 'verse', 'build', 'chorus', 'break', 'outro'] as SectionKind[]) {
    const r = createRng(Math.floor(rng() * 1e9));
    const drums = { kick: [] as number[], snare: [] as number[], hat: [] as number[], openHat: [] as number[], clap: [] as number[] };
    for (let bar = 0; bar < 4; bar++) {
      const b = bar * SLOTS_PER_BAR;
      const lastBar = bar === 3;
      const add = (arr: number[], ...slots: number[]) => arr.push(...slots.map(s => b + s));
      if (kind === 'break') {
        if (bar >= 2) add(drums.hat, 0, 8);
        continue;
      }
      if (kind === 'intro') {
        add(drums.hat, 0, 4, 8, 12);
        if (bar >= 2) add(drums.kick, 0, 8);
        continue;
      }
      if (kind === 'outro') {
        add(drums.kick, 0);
        if (bar < 2) add(drums.hat, 4, 12);
        continue;
      }
      if (kind === 'build') {
        add(drums.kick, 0, 4, 8, 12);
        const roll = lastBar ? [0, 2, 4, 6, 8, 9, 10, 11, 12, 13, 14, 15] : bar === 2 ? [4, 8, 10, 12, 14] : [4, 12];
        add(drums.snare, ...roll);
        add(drums.hat, 2, 6, 10, 14);
        continue;
      }
      const chorus = kind === 'chorus';
      switch (style) {
        case 'dance':
          add(drums.kick, 0, 4, 8, 12);
          add(drums.clap, 4, 12);
          add(drums.openHat, 2, 6, 10, 14);
          if (chorus) add(drums.hat, 1, 3, 5, 7, 9, 11, 13, 15);
          break;
        case 'dnb':
          add(drums.kick, 0, 10);
          if (chorus && bar % 2 === 1) add(drums.kick, 6);
          add(drums.snare, 4, 12);
          if (chorus && r() < 0.5) add(drums.snare, 15);
          add(drums.hat, 0, 2, 4, 6, 8, 10, 12, 14);
          if (chorus) add(drums.hat, 3, 7, 11);
          break;
        case 'chill':
          add(drums.kick, 0, 10);
          add(drums.snare, 8);
          add(drums.hat, 0, 4, 8, 12);
          if (chorus) add(drums.hat, 2, 6, 10, 14);
          break;
        default:
          add(drums.kick, 0, 6, 8);
          if (chorus) add(drums.kick, 10);
          add(drums.snare, 4, 12);
          add(drums.hat, 0, 2, 4, 6, 8, 10, 12, 14);
          if (chorus) add(drums.openHat, 14);
      }
    }

    // Melody: a 2-bar phrase repeated with a varied ending.
    const lead: Note[] = [];
    if (kind !== 'outro') {
      const density = { intro: 0.35, verse: 0.5, build: 0.8, chorus: 0.75, break: 0.2, outro: 0 }[kind];
      const phrase: Note[] = [];
      let step = 5 + Math.floor(r() * 3);
      let s = 0;
      while (s < 32) {
        const strong = s % 4 === 0;
        const play = strong ? r() < 0.4 + density : r() < density * 0.6;
        // Note lengths: mostly 1/2 and 1 beat, some 1/4 in dense parts and long notes at phrase ends.
        let len = r() < density * 0.4 && kind !== 'break' ? 1 : r() < 0.55 ? 2 : 4;
        if (s >= 24 && r() < 0.4) len = Math.min(8, 32 - s);
        if (kind === 'build') len = r() < 0.6 ? 1 : 2;
        if (play) {
          step += Math.round((r() - 0.5) * 4);
          step = Math.max(2, Math.min(11, step));
          phrase.push({ slot: s, length: len, midi: melodyPitch(step) });
        }
        s += len;
      }
      for (const n of phrase) lead.push(n);
      for (const n of phrase) {
        // Second phrase: same rhythm for the first bar, transposed ending.
        const shift = n.slot >= 16 ? (r() < 0.5 ? 2 : -1) : 0;
        lead.push({ slot: n.slot + 32, length: n.length, midi: n.midi + (shift === 0 ? 0 : scaleShift(n.midi, shift, root, scale)) });
      }
    }

    // Bass: roots, rhythm by section.
    const bass: Note[] = [];
    if (kind !== 'intro' && kind !== 'break') {
      for (let bar = 0; bar < 4; bar++) {
        const bassRoot = chords[bar][0] - 24;
        const pattern = kind === 'chorus' || kind === 'build' ? [0, 4, 8, 12] : style === 'dance' ? [2, 6, 10, 14] : [0, 8];
        for (const p of pattern) bass.push({ slot: bar * 16 + p, length: kind === 'outro' ? 8 : 3, midi: bassRoot });
        if (kind === 'chorus' && style !== 'chill') bass.push({ slot: bar * 16 + 14, length: 2, midi: bassRoot + 12 });
      }
    }
    plans.set(kind, { kind, bars: 4, drums, lead, bass, chords, riser: kind === 'build' });
  }
  return { plans, structure };
}

function scaleShift(midi: number, steps: number, root: number, scale: number[]): number {
  // Move a note by `steps` scale degrees; returns the semitone delta.
  const rel = (((midi - root) % 12) + 12) % 12;
  let idx = scale.indexOf(rel);
  if (idx < 0) return 0;
  const octave = Math.floor((midi - root) / 12);
  idx += steps;
  const target = root + 12 * (octave + Math.floor(idx / 7)) + scale[((idx % 7) + 7) % 7];
  return target - midi;
}

async function renderBlock(plan: SectionPlan, opts: SynthOptions): Promise<Float32Array> {
  const beat = 60 / opts.bpm;
  const slot = beat / 4;
  const seconds = plan.bars * 4 * beat + 1.5;
  const ctx = new OfflineAudioContext(1, Math.ceil(SAMPLE_RATE * seconds), SAMPLE_RATE);
  const master = ctx.createGain();
  master.gain.value = 0.42;
  master.connect(ctx.destination);

  const noise = ctx.createBuffer(1, SAMPLE_RATE, SAMPLE_RATE);
  const nd = noise.getChannelData(0);
  const nr = createRng(4242);
  for (let i = 0; i < nd.length; i++) nd[i] = nr() * 2 - 1;

  const kick = (time: number) => {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.setValueAtTime(opts.style === 'dnb' ? 170 : 150, time);
    o.frequency.exponentialRampToValueAtTime(45, time + 0.14);
    g.gain.setValueAtTime(1, time);
    g.gain.exponentialRampToValueAtTime(0.001, time + 0.3);
    o.connect(g).connect(master);
    o.start(time);
    o.stop(time + 0.32);
  };
  const noiseHit = (time: number, type: BiquadFilterType, freq: number, vol: number, decay: number, offset: number) => {
    const s = ctx.createBufferSource();
    s.buffer = noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, time);
    g.gain.exponentialRampToValueAtTime(0.001, time + decay);
    s.connect(f).connect(g).connect(master);
    s.start(time, offset, decay + 0.05);
  };
  const snare = (time: number, vol = 0.6) => {
    noiseHit(time, 'bandpass', 1800, vol, 0.18, 0.1);
    const o = ctx.createOscillator();
    const og = ctx.createGain();
    o.frequency.value = 190;
    og.gain.setValueAtTime(vol / 2, time);
    og.gain.exponentialRampToValueAtTime(0.001, time + 0.1);
    o.connect(og).connect(master);
    o.start(time);
    o.stop(time + 0.12);
  };
  const clap = (time: number) => {
    for (let i = 0; i < 3; i++) noiseHit(time + i * 0.012, 'bandpass', 1400, 0.35, 0.12 + i * 0.03, 0.2 + i * 0.1);
  };
  const note = (time: number, freq: number, dur: number, type: OscillatorType, vol: number, cutoff = 4000, attack = 0.01) => {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(cutoff, time);
    f.frequency.exponentialRampToValueAtTime(Math.max(200, cutoff / 4), time + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, time);
    g.gain.linearRampToValueAtTime(vol, time + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, time + dur);
    o.connect(f).connect(g).connect(master);
    o.start(time);
    o.stop(time + dur + 0.02);
  };

  const leadType: OscillatorType = { chill: 'triangle', pop: 'square', dance: 'sawtooth', dnb: 'square' }[opts.style] as OscillatorType;
  const d = plan.drums;
  const kind = plan.kind;
  for (const s of d.kick) kick(s * slot);
  for (const s of d.snare) snare(s * slot, kind === 'build' ? 0.35 + 0.3 * (s / 64) : 0.6);
  for (const s of d.clap) clap(s * slot);
  for (const s of d.hat) noiseHit(s * slot, 'highpass', 7000, 0.11, 0.05, 0.3);
  for (const s of d.openHat) noiseHit(s * slot, 'highpass', 6500, 0.16, 0.25, 0.4);
  for (const n of plan.lead) note(n.slot * slot, midiFreq(n.midi), Math.max(0.12, n.length * slot * 0.95), leadType, kind === 'break' ? 0.05 : 0.07, kind === 'chorus' ? 4200 : 3000);
  for (const n of plan.bass) note(n.slot * slot, midiFreq(n.midi), n.length * slot, 'sawtooth', 0.2, 900);
  // Pads: one chord per bar.
  for (let bar = 0; bar < plan.bars; bar++) {
    for (const m of plan.chords[bar % 4]) note(bar * 4 * beat, midiFreq(m), 4 * beat, 'triangle', kind === 'break' || kind === 'intro' ? 0.075 : 0.045, 2200, 0.2);
  }
  if (plan.riser) {
    const s = ctx.createBufferSource();
    s.buffer = noise;
    s.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.setValueAtTime(400, 0);
    f.frequency.exponentialRampToValueAtTime(8000, plan.bars * 4 * beat);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, 0);
    g.gain.exponentialRampToValueAtTime(0.12, plan.bars * 4 * beat);
    s.connect(f).connect(g).connect(master);
    s.start(0);
    s.stop(plan.bars * 4 * beat);
  }
  const buffer = await ctx.startRendering();
  return buffer.getChannelData(0);
}

/** Builds the rhythm grid for the arrangement (no audio needed; used by tests too). */
export function synthGrid(opts: SynthOptions): { grid: RhythmGrid; title: string; plans: Map<SectionKind, SectionPlan>; structure: { kind: SectionKind; bars: number }[] } {
  const rng = createRng(opts.seed);
  const title = `${WORDS_A[Math.floor(rng() * WORDS_A.length)]} ${WORDS_B[Math.floor(rng() * WORDS_B.length)]}`;
  const { plans, structure } = planSections(opts, rng);
  const beatLength = 60000 / opts.bpm;
  const totalBars = structure.reduce((a, s) => a + s.bars, 0);
  const slots: RhythmSlot[] = Array.from({ length: totalBars * SLOTS_PER_BAR }, () => ({ strength: 0, low: 0, high: 0, sustain: 0 }));
  const energy: number[] = [];
  let bar0 = 0;
  let previewBar = 0;
  for (const s of structure) {
    const plan = plans.get(s.kind)!;
    if (s.kind === 'chorus' && previewBar === 0) previewBar = bar0;
    for (let bar = 0; bar < s.bars; bar++) {
      const blockBar = bar % 4;
      const base = (bar0 + bar) * SLOTS_PER_BAR;
      const inBar = (slot: number) => Math.floor(slot / SLOTS_PER_BAR) === blockBar;
      const mark = (slot: number, field: 'low' | 'high', v: number) => {
        const k = base + (slot % SLOTS_PER_BAR);
        slots[k][field] = Math.max(slots[k][field], v);
      };
      for (const k of plan.drums.kick.filter(inBar)) mark(k, 'low', 1);
      for (const k of plan.drums.snare.filter(inBar)) mark(k, 'high', s.kind === 'build' ? 0.6 : 0.9);
      for (const k of plan.drums.clap.filter(inBar)) mark(k, 'high', 0.85);
      for (const k of plan.drums.openHat.filter(inBar)) mark(k, 'high', 0.4);
      for (const k of plan.drums.hat.filter(inBar)) mark(k, 'high', 0.25);
      for (const n of plan.bass.filter(n => inBar(n.slot))) mark(n.slot, 'low', 0.45);
      for (const n of plan.lead.filter(n => inBar(n.slot % 64))) {
        const k = base + (n.slot % SLOTS_PER_BAR);
        // Lead notes count as both bands a little, and carry their length for sliders / holds.
        slots[k].strength = Math.max(slots[k].strength, 0.7);
        if (n.length >= 3) slots[k].sustain = Math.max(slots[k].sustain, n.length / 4);
      }
      for (let b = 0; b < 4; b++) energy.push(SECTION_ENERGY[s.kind]);
    }
    bar0 += s.bars;
  }
  for (const sl of slots) sl.strength = 1 - (1 - sl.strength) * (1 - sl.low) * (1 - sl.high);
  // Smooth section edges a little so energy ramps over a bar.
  const smoothed = energy.map((_, i) => {
    let sum = 0;
    let n = 0;
    for (let j = i - 2; j <= i + 2; j++) if (j >= 0 && j < energy.length) (sum += energy[j]), n++;
    return sum / n;
  });
  const offset = Math.round(LEAD_DELAY * 1000);
  const grid: RhythmGrid = {
    bpm: opts.bpm,
    offset,
    beatLength,
    slots,
    energy: smoothed,
    durationMs: offset + totalBars * 4 * beatLength + 1500,
    previewTime: Math.round(offset + previewBar * 4 * beatLength),
  };
  return { grid, title, plans, structure };
}

/** Renders the song. Each distinct section kind is rendered once as a 4-bar block and copied into place. */
export async function synthesizeSong(opts: SynthOptions, onProgress?: (fraction: number) => void): Promise<SynthResult> {
  const { grid, title, plans, structure } = synthGrid(opts);
  const beat = 60 / opts.bpm;
  const blocks = new Map<SectionKind, Float32Array>();
  const kinds = [...new Set(structure.map(s => s.kind))];
  let done = 0;
  await Promise.all(
    kinds.map(async k => {
      blocks.set(k, await renderBlock(plans.get(k)!, opts));
      onProgress?.(++done / kinds.length);
    }),
  );
  const out = new Float32Array(Math.ceil((SAMPLE_RATE * grid.durationMs) / 1000));
  let bar0 = 0;
  for (const s of structure) {
    const block = blocks.get(s.kind)!;
    for (let bar = 0; bar < s.bars; bar += 4) {
      const start = Math.round((LEAD_DELAY + (bar0 + bar) * 4 * beat) * SAMPLE_RATE);
      // A full block is copied with its release tail; a shorter remainder is cut where the section ends.
      const bars = Math.min(4, s.bars - bar);
      const limit = bars < 4 ? Math.round(bars * 4 * beat * SAMPLE_RATE) : block.length;
      for (let i = 0; i < limit && start + i < out.length; i++) out[start + i] += block[i];
    }
    bar0 += s.bars;
  }
  for (let i = 0; i < out.length; i++) out[i] = Math.tanh(out[i] * 1.2) * 0.9;
  return { wav: encodeWav(out, SAMPLE_RATE), grid, title };
}

export function encodeWav(data: Float32Array, sampleRate: number): Blob {
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
