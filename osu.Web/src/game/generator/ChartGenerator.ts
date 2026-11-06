// Chart generator: turns a RhythmGrid into a .osu beatmap for any of the four rulesets.
// A single "intensity" knob (0 = gentlest, ~1.3 = hardest) drives rhythm density, spacing, patterns and
// difficulty settings; generateForStars() searches that knob until the ported star rating calculator
// reports the requested star rating.

import { PathType, PathTypes, SliderPath } from '../objects/SliderPath';
import { createRng, energyAt, RhythmGrid, RhythmSlot, slotTime, SLOTS_PER_BAR, SLOTS_PER_BEAT } from './RhythmGrid';

export type GeneratorMode = 0 | 1 | 2 | 3;

export interface ChartMetadata {
  title: string;
  artist: string;
  creator: string;
  version: string;
  audioFile: string;
  backgroundFile?: string;
  source?: string;
  tags?: string;
}

export interface ChartOptions {
  mode: GeneratorMode;
  intensity: number;
  /** Mania key count. */
  keys: number;
  seed: number;
  meta: ChartMetadata;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * clamp(t, 0, 1);
const round1 = (v: number) => Math.round(v * 10) / 10;

/** Difficulty names by star rating, as used across osu! (Easy / Normal / Hard / Insane / Expert / Expert+). */
export function difficultyName(stars: number): string {
  if (stars < 2) return 'Easy';
  if (stars < 2.7) return 'Normal';
  if (stars < 4) return 'Hard';
  if (stars < 5.3) return 'Insane';
  if (stars < 6.5) return 'Expert';
  return 'Expert+';
}

interface Pick {
  k: number;
  slot: RhythmSlot;
  score: number;
}

const levelOf = (k: number) => (k % 4 === 0 ? 0 : k % 2 === 0 ? 1 : 2);

function posWeight(k: number): number {
  const p = k % SLOTS_PER_BAR;
  if (p === 0) return 1;
  if (p === 8) return 0.95;
  if (p === 4 || p === 12) return 0.9;
  return p % 2 === 0 ? 0.72 : 0.55;
}

/** Chooses which grid positions get objects. Strong beats are placed first, then 1/2 and 1/4 positions in between. */
export function pickRhythm(grid: RhythmGrid, intensity: number, firstSlot = 0, streamScale = 1): Pick[] {
  const i = intensity;
  const n = grid.slots.length;
  const maxLevel = i < 0.18 ? 0 : i < 0.45 ? 1 : 2;
  const thrBase = 0.62 - 0.47 * Math.min(i, 1) - 0.1 * Math.max(0, i - 1);
  const thr = [thrBase, thrBase + 0.1, thrBase + 0.22 - 0.15 * Math.max(0, i - 0.45)];
  const minGap = i < 0.1 ? 8 : i < 0.18 ? 4 : i < 0.45 ? 2 : 1;
  const maxRun = i < 0.6 ? 3 : i < 0.8 ? 5 : i < 1 ? 9 : i < 1.2 ? 17 : 33;
  // Leave the last two beats of the audio free.
  const lastSlot = Math.min(n - 1, Math.floor(((grid.durationMs - 1000 - grid.offset) / grid.beatLength) * SLOTS_PER_BEAT));
  const score = (k: number) => grid.slots[k].strength * posWeight(k) * (0.55 + 0.45 * energyAt(grid, k));
  const picked = new Uint8Array(n);
  const nearest = (k: number) => {
    let d = Infinity;
    for (let j = 1; j < Math.min(minGap, 64) + 1; j++) {
      if ((k - j >= 0 && picked[k - j]) || (k + j < n && picked[k + j])) {
        d = j;
        break;
      }
    }
    return d;
  };
  const runAround = (k: number) => {
    // Number of objects in the 1/4-spaced run that k would join.
    let a = k;
    while (a - 1 >= 0 && picked[a - 1]) a--;
    let b = k;
    while (b + 1 < n && picked[b + 1]) b++;
    return b - a + 1;
  };
  for (let level = 0; level <= maxLevel; level++) {
    for (let k = firstSlot; k <= lastSlot; k++) {
      if (levelOf(k) !== level) continue;
      if (score(k) < thr[level]) continue;
      if (nearest(k) < minGap) continue;
      if (level === 2 && runAround(k) > maxRun) continue;
      picked[k] = 1;
    }
  }
  // Fill long holes in loud parts so the chart keeps moving with the music.
  const maxHole = i < 0.2 ? 8 : i < 0.5 ? 6 : 4;
  let prev = -1;
  for (let k = firstSlot; k <= lastSlot; k++) {
    if (!picked[k]) continue;
    if (prev >= 0 && k - prev > maxHole) {
      let pos = prev;
      while (k - pos > maxHole) {
        let best = -1;
        let bestScore = 0.04;
        for (let j = pos + minGap; j <= Math.min(k - minGap, pos + maxHole); j++) {
          if (levelOf(j) > maxLevel || energyAt(grid, j) < 0.35) continue;
          const s = score(j) + (levelOf(j) === 0 ? 0.05 : 0);
          if (s > bestScore) (bestScore = s), (best = j);
        }
        if (best < 0) break;
        picked[best] = 1;
        pos = best;
      }
    }
    prev = k;
  }
  // Harder charts subdivide further than the music strictly demands: 1/2 notes between beats, then 1/4 bursts and streams.
  const rng = createRng(0x5eed + Math.round(i * 1000));
  const subdivide = (step: number, minEnergy: number, p: number) => {
    if (p <= 0) return;
    let last = -1;
    for (let k = firstSlot; k <= lastSlot; k++) {
      if (!picked[k]) continue;
      if (last >= 0 && k - last === step * 2 && energyAt(grid, last) >= minEnergy && rng() < p) {
        const m = last + step;
        picked[m] = 1;
        if (step === 1 && runAround(m) > maxRun) picked[m] = 0;
      }
      last = k;
    }
  };
  subdivide(2, 0.45, (i - 0.45) * 1.6);
  subdivide(1, 0.55, (i - 0.7) * 1.4 * streamScale);
  const out: Pick[] = [];
  for (let k = 0; k < n; k++) if (picked[k]) out.push({ k, slot: grid.slots[k], score: score(k) });
  return out;
}

interface Settings {
  hp: number;
  cs: number;
  od: number;
  ar: number;
  sv: number;
}

function settingsFor(mode: GeneratorMode, i: number, keys: number): Settings {
  switch (mode) {
    case 1:
      return { hp: round1(lerp(4, 7, i)), cs: 5, od: round1(lerp(3, 8.5, i)), ar: 5, sv: 1.4 };
    case 2:
      return { hp: round1(lerp(3, 6, i)), cs: round1(lerp(2.5, 4.5, i)), od: round1(lerp(3, 9, i)), ar: round1(lerp(4, 9.5, i)), sv: round1(lerp(1, 1.8, i)) };
    case 3:
      return { hp: round1(lerp(6, 8.5, i)), cs: keys, od: round1(lerp(5, 8.5, i)), ar: 5, sv: 1.4 };
    default:
      return { hp: round1(lerp(3, 6.5, i)), cs: round1(lerp(3, 4.5, i)), od: round1(lerp(3, 9, i)), ar: round1(lerp(4, 9.6, i)), sv: round1(lerp(1, 2, i)) };
  }
}

const sectionStart = (grid: RhythmGrid, k: number) => k % SLOTS_PER_BAR === 0 && energyAt(grid, k) - energyAt(grid, k - SLOTS_PER_BAR) > 0.15;

function hitsoundFor(grid: RhythmGrid, p: Pick, rng: () => number): number {
  const s = p.slot;
  if (sectionStart(grid, p.k) && s.strength > 0.7) return 4;
  if (s.high > 0.6 && p.k % 8 === 4) return 8;
  if (s.strength > 0.6 && s.low < 0.3 && s.high < 0.3 && rng() < 0.3) return 2;
  return 0;
}

interface Vec {
  x: number;
  y: number;
}

/** Output of one object, as a .osu line plus where it ends (for breaks). */
interface Line {
  time: number;
  endTime: number;
  text: string;
}

const pathTypeChar = (t: PathType) => (t.type === 'Linear' ? 'L' : t.type === 'PerfectCurve' ? 'P' : 'B');

interface SliderShape {
  curve: string;
  end: Vec;
  endAngle: number;
}

/** Builds a slider body of the given length from `start`, keeping it inside the playfield. */
function sliderShape(start: Vec, angle: number, length: number, rng: () => number, intensity: number, horizontal = false, bounds = { x0: 24, x1: 488, y0: 24, y1: 360 }): SliderShape {
  const roll = rng();
  const type = roll < (horizontal ? 0.4 : 0.3) ? PathTypes.LINEAR : roll < 0.75 ? PathTypes.PERFECT_CURVE : PathTypes.BEZIER;
  const bend = (0.12 + rng() * (0.18 + 0.1 * intensity)) * (rng() < 0.5 ? -1 : 1);
  const tries = horizontal ? [0, Math.PI] : [0, Math.PI, Math.PI / 2, -Math.PI / 2, Math.PI / 4, -Math.PI / 4, (3 * Math.PI) / 4, (-3 * Math.PI) / 4];
  let fallback: SliderShape | null = null;
  for (const t of tries) {
    const dir = horizontal ? (Math.cos(angle) >= 0 ? 0 : Math.PI) + t : angle + t;
    const d = { x: Math.cos(dir), y: Math.sin(dir) * (horizontal ? 0 : 1) };
    const perp = { x: -Math.sin(dir), y: Math.cos(dir) };
    const vertical = horizontal ? 0.35 : 1;
    const end = { x: d.x * length, y: d.y * length };
    let points: Vec[];
    if (type === PathTypes.LINEAR) points = [{ x: 0, y: 0 }, end];
    else if (type === PathTypes.PERFECT_CURVE) points = [{ x: 0, y: 0 }, { x: end.x / 2 + perp.x * length * bend, y: end.y / 2 + perp.y * length * bend * vertical }, end];
    else points = [{ x: 0, y: 0 }, { x: end.x * 0.5 + perp.x * length * bend * 1.6, y: end.y * 0.5 + perp.y * length * bend * 1.6 * vertical }, end];
    points = points.map(p => ({ x: Math.round(p.x), y: Math.round(p.y) }));
    const path = new SliderPath(points.map((p, idx) => ({ position: p, type: idx === 0 ? type : null })), length);
    const inside = [0.25, 0.5, 0.75, 1].every(prog => {
      const q = path.positionAt(prog);
      const x = start.x + q.x;
      const y = start.y + q.y;
      return x >= bounds.x0 && x <= bounds.x1 && y >= bounds.y0 && y <= bounds.y1;
    });
    const tail = path.positionAt(1);
    const beforeTail = path.positionAt(0.97);
    const shape: SliderShape = {
      curve: `${pathTypeChar(type)}|${points
        .slice(1)
        .map(p => `${start.x + p.x}:${start.y + p.y}`)
        .join('|')}`,
      end: { x: start.x + tail.x, y: start.y + tail.y },
      endAngle: Math.atan2(tail.y - beforeTail.y, tail.x - beforeTail.x),
    };
    if (inside) return shape;
    fallback ??= shape;
  }
  return fallback!;
}

interface Placed {
  pick: Pick;
  /** Slider length in slots (0 = circle). */
  sliderSlots: number;
  spans: number;
}

/** Decides which picks become sliders (osu! / catch) and how long they are. */
function planSliders(picks: Pick[], i: number, rng: () => number): Placed[] {
  const rest = i < 0.25 ? 4 : i < 0.5 ? 2 : 1;
  return picks.map((p, j) => {
    const next = picks[j + 1];
    if (!next) return { pick: p, sliderSlots: 0, spans: 1 };
    const gap = next.k - p.k;
    let len = gap - rest;
    if (i < 0.5) len -= len % 2;
    const chance = (p.slot.sustain > 0 ? 0.85 : lerp(0.55, 0.35, i)) * (i > 1 ? Math.max(0.3, 2 - i) : 1);
    if (len < 2 || rng() >= chance) return { pick: p, sliderSlots: 0, spans: 1 };
    const spans = len >= 8 && i < 0.5 && len % 2 === 0 && rng() < 0.4 ? 2 : 1;
    return { pick: p, sliderSlots: len, spans };
  });
}

function spinnerAtEnd(grid: RhythmGrid, lastEndSlot: number): { start: number; end: number } | null {
  const start = Math.ceil((lastEndSlot + 4) / 4) * 4;
  const maxSlot = Math.floor(((grid.durationMs - 800 - grid.offset) / grid.beatLength) * SLOTS_PER_BEAT);
  const end = Math.min(start + 16, maxSlot);
  return end - start >= 8 ? { start, end } : null;
}

function generateOsu(grid: RhythmGrid, picks: Pick[], i: number, s: Settings, rng: () => number): Line[] {
  const lines: Line[] = [];
  const t = (k: number) => Math.round(slotTime(grid, k));
  const placed = planSliders(picks, i, rng);
  let pos: Vec = { x: 256, y: 192 };
  let angle = rng() * Math.PI * 2;
  let comboCount = 0;
  let lastBar = -1;
  let sharpBar = false;
  let flowSign = 1;
  const anchors: [number, number][] = [
    [1, 14 + 30 * i],
    [2, 60 + 190 * i],
    [4, 90 + 150 * i],
    [8, 110 + 110 * i],
  ];
  const spacing = (gap: number) => {
    if (gap <= anchors[0][0]) return anchors[0][1];
    for (let a = 1; a < anchors.length; a++) {
      if (gap <= anchors[a][0]) {
        const [g0, d0] = anchors[a - 1];
        const [g1, d1] = anchors[a];
        return d0 + ((d1 - d0) * Math.log(gap / g0)) / Math.log(g1 / g0);
      }
    }
    return Math.min(320, anchors[anchors.length - 1][1]);
  };
  const inBounds = (p: Vec) => p.x >= 32 && p.x <= 480 && p.y >= 32 && p.y <= 352;
  const place = (dist: number, turn: number): Vec => {
    // The in-bounds direction closest to the intended turn; if none fits, the direction that keeps the most distance.
    let best: { p: Vec; a: number } | null = null;
    let bestCost = Infinity;
    let far: { p: Vec; a: number } | null = null;
    let farDist = -1;
    for (let j = 0; j < 24; j++) {
      const off = (j % 2 === 0 ? 1 : -1) * Math.ceil(j / 2) * (Math.PI / 12);
      const a = angle + turn + off;
      const p = { x: pos.x + Math.cos(a) * dist, y: pos.y + Math.sin(a) * dist };
      if (inBounds(p)) {
        const cost = Math.abs(off);
        if (cost < bestCost) (bestCost = cost), (best = { p, a });
      } else {
        const c = { x: clamp(p.x, 32, 480), y: clamp(p.y, 32, 352) };
        const d = Math.hypot(c.x - pos.x, c.y - pos.y);
        if (d > farDist) (farDist = d), (far = { p: c, a: Math.atan2(c.y - pos.y, c.x - pos.x) });
      }
    }
    const r = best ?? far!;
    angle = r.a;
    return { x: Math.round(r.p.x), y: Math.round(r.p.y) };
  };
  let prevEndK = -Infinity;
  for (const { pick, sliderSlots, spans } of placed) {
    const k = pick.k;
    const bar = Math.floor(k / SLOTS_PER_BAR);
    let nc = false;
    if (bar !== lastBar && (i >= 0.4 || bar % 2 === 0)) {
      nc = true;
      sharpBar = rng() < clamp((i - 0.35) * 1.2, 0, 0.75);
      flowSign = rng() < 0.5 ? -1 : 1;
      lastBar = bar;
    }
    if (comboCount >= 12) nc = true;
    if (lines.length === 0) nc = true;
    comboCount = nc ? 1 : comboCount + 1;
    const gap = Math.max(1, k - prevEndK);
    const stream = gap <= 1;
    const turn = stream ? flowSign * (0.15 + rng() * 0.2) : sharpBar ? flowSign * (1.9 + rng() * 0.7) : flowSign * (0.3 + rng() * 0.7);
    pos = lines.length === 0 ? pos : place(spacing(gap), turn);
    const hs = hitsoundFor(grid, pick, rng);
    const type = (base: number) => base | (nc ? 4 : 0);
    if (sliderSlots > 0) {
      const length = +(((sliderSlots / spans) / SLOTS_PER_BEAT) * s.sv * 100).toFixed(2);
      const shape = sliderShape(pos, angle + (rng() - 0.5) * 1.2, length, rng, i);
      const edges = Array.from({ length: spans + 1 }, (_, e) => (e === 0 ? hs : 0)).join('|');
      const endK = k + sliderSlots;
      lines.push({ time: t(k), endTime: t(endK), text: `${pos.x},${pos.y},${t(k)},${type(2)},0,${shape.curve},${spans},${length},${edges},${Array(spans + 1).fill('0:0').join('|')},0:0:0:0:` });
      if (spans % 2 === 1) {
        pos = { x: Math.round(shape.end.x), y: Math.round(shape.end.y) };
        angle = shape.endAngle;
      } else angle += Math.PI;
      prevEndK = endK;
    } else {
      lines.push({ time: t(k), endTime: t(k), text: `${pos.x},${pos.y},${t(k)},${type(1)},${hs},0:0:0:0:` });
      prevEndK = k;
    }
  }
  const sp = spinnerAtEnd(grid, prevEndK);
  if (sp) lines.push({ time: t(sp.start), endTime: t(sp.end), text: `256,192,${t(sp.start)},12,4,${t(sp.end)},0:0:0:0:` });
  return lines;
}

function generateCatch(grid: RhythmGrid, picks: Pick[], i: number, s: Settings, rng: () => number): Line[] {
  const lines: Line[] = [];
  const t = (k: number) => Math.round(slotTime(grid, k));
  const placed = planSliders(picks, i, rng);
  let x = 256;
  let dir = rng() < 0.5 ? -1 : 1;
  let lastBar = -1;
  let prevEndK = -Infinity;
  const speed = lerp(0.15, 1.1, i) + 0.3 * Math.max(0, i - 1);
  const flip = lerp(0.25, 0.7, i);
  for (const { pick, sliderSlots, spans } of placed) {
    const k = pick.k;
    const bar = Math.floor(k / SLOTS_PER_BAR);
    const nc = bar !== lastBar && (i >= 0.4 || bar % 2 === 0);
    if (nc) lastBar = bar;
    if (lines.length > 0) {
      const gapMs = t(k) - t(prevEndK);
      const gapSlots = k - prevEndK;
      let dist = gapMs * speed * (gapSlots <= 1 ? lerp(0.5, 0.9, i - 1) : 1) * (0.8 + rng() * 0.4);
      dist = Math.min(dist, 440);
      if (rng() < flip) dir = -dir;
      let nx = x + dir * dist;
      if (nx < 16 || nx > 496) {
        dir = -dir;
        nx = x + dir * dist;
      }
      x = Math.round(clamp(nx, 16, 496));
    }
    const hs = hitsoundFor(grid, pick, rng);
    const type = (base: number) => base | (nc || lines.length === 0 ? 4 : 0);
    if (sliderSlots > 0) {
      const length = +(((sliderSlots / spans) / SLOTS_PER_BEAT) * s.sv * 100).toFixed(2);
      const room = x < 256 ? 0 : Math.PI;
      const shape = sliderShape({ x, y: 192 }, room, Math.min(length, 400), rng, i, true, { x0: 8, x1: 504, y0: 40, y1: 344 });
      const edges = Array.from({ length: spans + 1 }, (_, e) => (e === 0 ? hs : 0)).join('|');
      const endK = k + sliderSlots;
      lines.push({ time: t(k), endTime: t(endK), text: `${x},192,${t(k)},${type(2)},0,${shape.curve},${spans},${length},${edges},${Array(spans + 1).fill('0:0').join('|')},0:0:0:0:` });
      if (spans % 2 === 1) x = Math.round(clamp(shape.end.x, 0, 512));
      prevEndK = endK;
    } else {
      lines.push({ time: t(k), endTime: t(k), text: `${x},192,${t(k)},${type(1)},${hs},0:0:0:0:` });
      prevEndK = k;
    }
  }
  const sp = spinnerAtEnd(grid, prevEndK);
  if (sp) lines.push({ time: t(sp.start), endTime: t(sp.end), text: `256,192,${t(sp.start)},12,0,${t(sp.end)},0:0:0:0:` });
  return lines;
}

const TAIKO_MOTIFS = ['d', 'k', 'dk', 'kd', 'ddk', 'kkd', 'dkk', 'kdd', 'dkd', 'kdk'];

function generateTaiko(grid: RhythmGrid, picks: Pick[], i: number, s: Settings, rng: () => number): Line[] {
  const lines: Line[] = [];
  const t = (k: number) => Math.round(slotTime(grid, k));
  let motif = '';
  let motifPos = 0;
  let prevK = -Infinity;
  let lastBar = -1;
  for (let j = 0; j < picks.length; j++) {
    const p = picks[j];
    const k = p.k;
    const next = picks[j + 1];
    const gapPrev = k - prevK;
    const gapNext = next ? next.k - k : Infinity;
    const bar = Math.floor(k / SLOTS_PER_BAR);
    const nc = bar !== lastBar;
    if (nc) lastBar = bar;
    const type = (base: number) => base | (nc ? 4 : 0);
    // Drumrolls over long held notes.
    if (next && gapNext >= 8 && (p.slot.sustain > 0 || rng() < 0.25) && i < 1) {
      const len = gapNext - (i < 0.5 ? 4 : 2);
      const length = +((len / SLOTS_PER_BEAT) * s.sv * 100).toFixed(2);
      lines.push({ time: t(k), endTime: t(k + len), text: `256,192,${t(k)},${type(2)},0,L|${256 + Math.round(length)}:192,1,${length},0|0,0:0|0:0,0:0:0:0:` });
      prevK = k + len;
      continue;
    }
    let kat = p.slot.high > p.slot.low + 0.15;
    if (gapPrev <= 2 && i >= 0.4) {
      if (motifPos >= motif.length && rng() < 0.3 + 0.5 * Math.min(i, 1)) {
        motif = TAIKO_MOTIFS[Math.floor(rng() * TAIKO_MOTIFS.length)];
        motifPos = 0;
      }
      if (motifPos < motif.length) kat = motif[motifPos++] === 'k';
    } else {
      motif = '';
      motifPos = 0;
      if (k % SLOTS_PER_BAR === 0 && p.slot.low >= p.slot.high) kat = false;
    }
    const big = gapPrev >= 4 && gapNext >= 4 && p.slot.strength > 0.85 && (k % SLOTS_PER_BAR === 0 || sectionStart(grid, k)) && rng() < (i < 0.6 ? 0.5 : 0.2);
    const hs = (kat ? (rng() < 0.5 ? 2 : 8) : 0) | (big ? 4 : 0);
    lines.push({ time: t(k), endTime: t(k), text: `256,192,${t(k)},${type(1)},${hs},0:0:0:0:` });
    prevK = k;
  }
  const sp = spinnerAtEnd(grid, prevK);
  if (sp) lines.push({ time: t(sp.start), endTime: t(sp.end), text: `256,192,${t(sp.start)},12,0,${t(sp.end)},0:0:0:0:` });
  return lines;
}

type ManiaMotif = 'up' | 'down' | 'trill' | 'random';

function generateMania(grid: RhythmGrid, picks: Pick[], i: number, keys: number, rng: () => number): Line[] {
  const lines: Line[] = [];
  const t = (k: number) => Math.round(slotTime(grid, k));
  const colX = (c: number) => Math.floor(((c + 0.5) * 512) / keys);
  const busyUntil = new Array<number>(keys).fill(-Infinity);
  let prevCols: number[] = [];
  let prevK = -Infinity;
  let lastCol = Math.floor(rng() * keys);
  let motif: ManiaMotif = 'random';
  let trill: [number, number] = [0, Math.min(1, keys - 1)];
  let trillPos = 0;
  let lastBar = -1;
  const jackGap = i < 0.6 ? 4 : i < 0.9 ? 2 : 1;
  const maxChord = Math.max(1, keys - 1);
  for (let j = 0; j < picks.length; j++) {
    const p = picks[j];
    const k = p.k;
    const next = picks[j + 1];
    const gapPrev = k - prevK;
    const gapNext = next ? next.k - k : Infinity;
    const bar = Math.floor(k / SLOTS_PER_BAR);
    if (bar !== lastBar) {
      lastBar = bar;
      const r = rng();
      motif = r < 0.3 ? 'up' : r < 0.5 ? 'down' : r < 0.7 && keys > 1 ? 'trill' : 'random';
      if (motif === 'trill') {
        const a = Math.floor(rng() * keys);
        trill = [a, (a + 1 + Math.floor(rng() * (keys - 1))) % keys];
        trillPos = 0;
      }
    }
    // Chord size from the strength of the moment and the intensity.
    let size = 1;
    const sc = p.score + (rng() - 0.5) * 0.1;
    if (i >= 0.25 && k % 4 === 0 && sc > 0.75) size = 2;
    if (i >= 0.55 && k % 8 === 0 && sc > 0.85) size = 3;
    if (i >= 0.85 && k % SLOTS_PER_BAR === 0 && sc > 0.9) size = 4;
    if (i >= 0.7 && k % 4 === 2 && sc > 0.8) size = Math.max(size, 2);
    // Dense chords (jumpstream / chordjack style) at the top end.
    if (i >= 0.8 && k % 2 === 0 && rng() < (i - 0.8) * 1.2) size = Math.max(size, 2 + (rng() < (i - 0.9) ? 1 : 0));
    if (i >= 1.2 && rng() < (i - 1.2) * 0.8) size = Math.max(size, 2);
    if (gapPrev <= 1) size = Math.min(size, i > 1.3 ? 3 : i > 0.9 ? 2 : 1);
    size = Math.min(size, maxChord);
    const free = (c: number) => busyUntil[c] < k && !(gapPrev < jackGap && prevCols.includes(c));
    let available = Array.from({ length: keys }, (_, c) => c).filter(free);
    if (available.length === 0) available = Array.from({ length: keys }, (_, c) => c).filter(c => busyUntil[c] < k);
    if (available.length === 0) continue;
    const cols: number[] = [];
    let first: number;
    if (motif === 'up') first = (lastCol + 1) % keys;
    else if (motif === 'down') first = (lastCol - 1 + keys) % keys;
    else if (motif === 'trill') first = trill[trillPos++ % 2];
    else first = available[Math.floor(rng() * available.length)];
    if (!available.includes(first)) first = available[Math.floor(rng() * available.length)];
    cols.push(first);
    const others = available.filter(c => c !== first);
    while (cols.length < size && others.length > 0) cols.push(others.splice(Math.floor(rng() * others.length), 1)[0]);
    lastCol = first;
    // Holds over sustained notes / long gaps.
    let holdSlots = 0;
    if (next && gapNext >= 4 && (p.slot.sustain > 0 || rng() < 0.25)) {
      holdSlots = i < 0.5 ? gapNext - 2 : p.slot.sustain > 0 ? Math.min(8, Math.round(p.slot.sustain * SLOTS_PER_BEAT)) : Math.min(8, gapNext - 1);
      if (holdSlots < 2) holdSlots = 0;
    }
    const hs = hitsoundFor(grid, p, rng);
    cols.forEach((c, idx) => {
      const hold = holdSlots > 0 && (idx === 0 || (i >= 0.6 && rng() < 0.5));
      if (hold) {
        lines.push({ time: t(k), endTime: t(k + holdSlots), text: `${colX(c)},192,${t(k)},128,${idx === 0 ? hs : 0},${t(k + holdSlots)}:0:0:0:0:` });
        busyUntil[c] = k + holdSlots + 1;
      } else {
        lines.push({ time: t(k), endTime: t(k), text: `${colX(c)},192,${t(k)},1,${idx === 0 ? hs : 0},0:0:0:0:` });
        busyUntil[c] = k;
      }
    });
    prevCols = cols;
    prevK = k;
  }
  return lines;
}

function breaksFor(lines: Line[]): string[] {
  const out: string[] = [];
  const sorted = [...lines].sort((a, b) => a.time - b.time);
  let lastEnd = -Infinity;
  for (const l of sorted) {
    if (lastEnd > -Infinity && l.time - lastEnd >= 5000) {
      const start = lastEnd + 400;
      const end = l.time - 1200;
      if (end - start >= 2000) out.push(`2,${Math.round(start)},${Math.round(end)}`);
    }
    lastEnd = Math.max(lastEnd, l.endTime);
  }
  return out;
}

function kiaiPoints(grid: RhythmGrid): string[] {
  const bars = Math.floor(grid.energy.length / 4);
  const loud: boolean[] = [];
  for (let b = 0; b < bars; b++) {
    let s = 0;
    for (let j = 0; j < 4; j++) s += grid.energy[b * 4 + j];
    loud.push(s / 4 >= 0.8);
  }
  const out: string[] = [];
  let b = 0;
  while (b < bars) {
    if (!loud[b]) {
      b++;
      continue;
    }
    let e = b;
    while (e < bars && loud[e]) e++;
    if (e - b >= 4) {
      out.push(`${Math.round(slotTime(grid, b * SLOTS_PER_BAR))},-100,4,2,0,70,0,1`);
      out.push(`${Math.round(slotTime(grid, e * SLOTS_PER_BAR))},-100,4,2,0,60,0,0`);
    }
    b = e;
  }
  return out;
}

const clean = (s: string) => s.replace(/[\r\n]/g, ' ').trim();

/** Generates the full .osu text. */
export function generateChart(grid: RhythmGrid, opts: ChartOptions): string {
  const i = clamp(opts.intensity, 0, 2);
  const rng = createRng(opts.seed);
  const keys = clamp(Math.round(opts.keys), 1, 10);
  const s = settingsFor(opts.mode, i, keys);
  const picks = pickRhythm(grid, i, 0, opts.mode === 2 ? 0.35 : 1);
  let lines: Line[];
  switch (opts.mode) {
    case 1:
      lines = generateTaiko(grid, picks, i, s, rng);
      break;
    case 2:
      lines = generateCatch(grid, picks, i, s, rng);
      break;
    case 3:
      lines = generateMania(grid, picks, i, keys, rng);
      break;
    default:
      lines = generateOsu(grid, picks, i, s, rng);
  }
  lines.sort((a, b) => a.time - b.time);
  const m = opts.meta;
  const bg = m.backgroundFile ? `0,0,"${m.backgroundFile}",0,0\n` : '';
  return `osu file format v14

[General]
AudioFilename: ${m.audioFile}
AudioLeadIn: 0
PreviewTime: ${Math.round(grid.previewTime)}
Countdown: 0
SampleSet: Normal
StackLeniency: 0.7
Mode: ${opts.mode}
LetterboxInBreaks: 0
WidescreenStoryboard: 1
${opts.mode === 3 ? 'SpecialStyle: 0\n' : ''}
[Editor]
DistanceSpacing: 1
BeatDivisor: 4
GridSize: 4

[Metadata]
Title:${clean(m.title)}
TitleUnicode:${clean(m.title)}
Artist:${clean(m.artist)}
ArtistUnicode:${clean(m.artist)}
Creator:${clean(m.creator)}
Version:${clean(m.version)}
Source:${clean(m.source ?? '')}
Tags:${clean(m.tags ?? 'generated')}
BeatmapID:0
BeatmapSetID:-1

[Difficulty]
HPDrainRate:${s.hp}
CircleSize:${s.cs}
OverallDifficulty:${s.od}
ApproachRate:${s.ar}
SliderMultiplier:${s.sv}
SliderTickRate:1

[Events]
//Background and Video events
${bg}//Break Periods
${breaksFor(lines).join('\n')}${breaksFor(lines).length ? '\n' : ''}
[TimingPoints]
${grid.offset},${grid.beatLength},4,1,0,60,1,0
${kiaiPoints(grid).join('\n')}

[HitObjects]
${lines.map(l => l.text).join('\n')}
`;
}

export interface GeneratedChart {
  text: string;
  stars: number;
  intensity: number;
}

/**
 * Searches the intensity until the star rating (from `rate`, the ported difficulty calculator) is as close to `target`
 * as possible. Yields to the event loop between attempts so the UI can show progress.
 */
export async function generateForStars(
  grid: RhythmGrid,
  base: Omit<ChartOptions, 'intensity'>,
  target: number,
  rate: (osuText: string) => number,
  onStep?: (attempt: number, total: number, stars: number) => void,
): Promise<GeneratedChart> {
  // Star rating is not strictly monotonic in intensity, so scan first, then bisect the bracket closest to the target.
  const scan = [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
  const refine = 6;
  const total = scan.length + refine;
  let best: GeneratedChart | null = null;
  let n = 0;
  const yieldUi = () => new Promise(r => setTimeout(r, 0));
  const evaluate = async (intensity: number): Promise<GeneratedChart> => {
    const text = generateChart(grid, { ...base, intensity });
    const stars = rate(text);
    onStep?.(++n, total, stars);
    const r = { text, stars, intensity };
    if (!best || Math.abs(stars - target) < Math.abs(best.stars - target)) best = r;
    await yieldUi();
    return r;
  };
  const results: GeneratedChart[] = [];
  for (const x of scan) {
    const r = await evaluate(x);
    results.push(r);
    if (r.stars > target + 0.5 && results.length >= 2 && results[results.length - 2].stars < target) break;
  }
  // Bracket: the first neighbouring pair that straddles the target.
  let lo: GeneratedChart | null = null;
  let hi: GeneratedChart | null = null;
  for (let j = 1; j < results.length; j++) {
    if (results[j - 1].stars <= target && results[j].stars >= target) {
      lo = results[j - 1];
      hi = results[j];
      break;
    }
  }
  if (lo && hi) {
    for (let j = 0; j < refine; j++) {
      if (Math.abs(best!.stars - target) < 0.05) break;
      const r = await evaluate((lo.intensity + hi.intensity) / 2);
      if (r.stars < target) lo = r;
      else hi = r;
    }
  }
  return best!;
}

export { SLOTS_PER_BEAT };
