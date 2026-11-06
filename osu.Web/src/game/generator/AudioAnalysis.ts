// Beat tracking for user-supplied audio: spectral-flux onset detection in three bands, tempo from the
// autocorrelation of the onset envelope, then a fine tempo / phase search by folding the envelope over
// the beat period. The result is sampled onto a 1/4-beat grid for the chart generator.

import { RhythmGrid, RhythmSlot, SLOTS_PER_BEAT } from './RhythmGrid';

const FRAME_RATE = 100; // envelope frames per second
const TARGET_RATE = 11025;
const FFT_SIZE = 512;

export interface AnalysisInput {
  /** Mono samples. */
  samples: Float32Array;
  sampleRate: number;
}

/** Decodes any browser-supported audio file to mono samples. */
export async function decodeAudio(data: ArrayBuffer): Promise<AnalysisInput> {
  const Ctx = (window.OfflineAudioContext || (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext }).webkitOfflineAudioContext) as typeof OfflineAudioContext;
  const ctx = new Ctx(1, 1, 44100);
  const buffer = await ctx.decodeAudioData(data.slice(0));
  const samples = new Float32Array(buffer.length);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const ch = buffer.getChannelData(c);
    for (let i = 0; i < ch.length; i++) samples[i] += ch[i] / buffer.numberOfChannels;
  }
  return { samples, sampleRate: buffer.sampleRate };
}

/** In-place radix-2 FFT. */
function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const a = i + j;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

interface Envelopes {
  low: Float32Array;
  mid: Float32Array;
  high: Float32Array;
  rms: Float32Array;
}

function computeEnvelopes(input: AnalysisInput): Envelopes {
  const factor = Math.max(1, Math.round(input.sampleRate / TARGET_RATE));
  const rate = input.sampleRate / factor;
  const n = Math.floor(input.samples.length / factor);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < factor; j++) s += input.samples[i * factor + j];
    x[i] = s / factor;
  }
  const hop = rate / FRAME_RATE;
  const frames = Math.max(0, Math.floor((n - FFT_SIZE) / hop));
  const low = new Float32Array(frames);
  const mid = new Float32Array(frames);
  const high = new Float32Array(frames);
  const rms = new Float32Array(frames);
  const binHz = rate / FFT_SIZE;
  const lowEnd = Math.round(200 / binHz);
  const midEnd = Math.round(2000 / binHz);
  const window = new Float32Array(FFT_SIZE).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_SIZE));
  const re = new Float32Array(FFT_SIZE);
  const im = new Float32Array(FFT_SIZE);
  let prev = new Float32Array(FFT_SIZE / 2);
  let cur = new Float32Array(FFT_SIZE / 2);
  for (let f = 0; f < frames; f++) {
    const start = Math.round(f * hop);
    let e = 0;
    for (let i = 0; i < FFT_SIZE; i++) {
      const v = x[start + i];
      e += v * v;
      re[i] = v * window[i];
      im[i] = 0;
    }
    rms[f] = Math.sqrt(e / FFT_SIZE);
    fft(re, im);
    let l = 0;
    let m = 0;
    let hgh = 0;
    for (let b = 1; b < FFT_SIZE / 2; b++) {
      cur[b] = Math.log(1 + 100 * Math.hypot(re[b], im[b]));
      const d = cur[b] - prev[b];
      if (d > 0) {
        if (b <= lowEnd) l += d;
        else if (b <= midEnd) m += d;
        else hgh += d;
      }
    }
    low[f] = l;
    mid[f] = m;
    high[f] = hgh;
    [prev, cur] = [cur, prev];
  }
  return { low: normalise(low), mid: normalise(mid), high: normalise(high), rms };
}

/** Removes the local mean (0.5 s window), half-wave rectifies and scales so the 97th percentile is 1. */
function normalise(env: Float32Array): Float32Array {
  const w = Math.round(FRAME_RATE * 0.25);
  const out = new Float32Array(env.length);
  let sum = 0;
  for (let i = 0; i < Math.min(env.length, w); i++) sum += env[i];
  for (let i = 0; i < env.length; i++) {
    const add = i + w;
    const rem = i - w - 1;
    if (add < env.length) sum += env[add];
    if (rem >= 0) sum -= env[rem];
    const count = Math.min(env.length - 1, i + w) - Math.max(0, i - w) + 1;
    out[i] = Math.max(0, env[i] - sum / count);
  }
  const p = percentile(out, 0.97) || 1;
  for (let i = 0; i < out.length; i++) out[i] = Math.min(1.5, out[i] / p);
  return out;
}

function percentile(a: Float32Array, q: number): number {
  if (a.length === 0) return 0;
  const sorted = Float32Array.from(a).sort();
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

const sampleEnv = (env: Float32Array, t: number) => {
  const x = t * FRAME_RATE;
  const i = Math.floor(x);
  if (i < 0 || i + 1 >= env.length) return 0;
  return env[i] + (env[i + 1] - env[i]) * (x - i);
};

/** Estimates the tempo (BPM) and the time of a beat (seconds). */
export function estimateTempo(onset: Float32Array): { bpm: number; phase: number } {
  // Coarse tempo: autocorrelation of a slightly smoothed envelope, weighted by a log-normal prior around 125 BPM.
  const smooth = new Float32Array(onset.length);
  // Gaussian, sigma = 2 frames: hides the 10 ms quantisation of onset positions.
  const kernel = [-4, -3, -2, -1, 0, 1, 2, 3, 4].map(j => Math.exp(-(j * j) / 8));
  for (let i = 0; i < onset.length; i++) {
    let s = 0;
    for (let j = -4; j <= 4; j++) if (i + j >= 0 && i + j < onset.length) s += onset[i + j] * kernel[j + 4];
    smooth[i] = s;
  }
  // Remove the mean so the comb compares peaks, not the constant baseline.
  let mean = 0;
  for (let i = 0; i < smooth.length; i++) mean += smooth[i];
  mean /= Math.max(1, smooth.length);
  for (let i = 0; i < smooth.length; i++) smooth[i] -= mean;
  let best = 120;
  let bestScore = -Infinity;
  // Autocorrelation at a fractional lag (the delayed signal is linearly interpolated).
  const acAt = (lag: number) => {
    const l0 = Math.floor(lag);
    const fr = lag - l0;
    let s = 0;
    for (let i = l0 + 1; i < smooth.length; i++) s += smooth[i] * (smooth[i - l0] * (1 - fr) + smooth[i - l0 - 1] * fr);
    return s / (smooth.length - l0);
  };
  for (let bpm = 70; bpm <= 210; bpm += 0.5) {
    const lag = (60 * FRAME_RATE) / bpm;
    // Comb over the first four multiples of the period: the true beat lines up with all of them.
    let v = 0;
    for (let m = 1; m <= 4; m++) v += acAt(lag * m) / m;
    // A strong pulse halfway between candidate beats means the candidate is probably half the real tempo.
    v -= 0.3 * acAt(lag / 2);
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 125) / 1.0, 2));
    const score = v > 0 ? v * prior : v / prior;
    if (score > bestScore) (bestScore = score), (best = bpm);
  }
  // Fine tempo and phase: fold the envelope over the period and pick the sharpest alignment.
  const BINS = 120;
  const duration = onset.length / FRAME_RATE;
  let fine = { bpm: best, phase: 0, score: -Infinity };
  const hist = new Float32Array(BINS);
  const fold = (bpm: number) => {
    const period = 60 / bpm;
    hist.fill(0);
    for (let i = 0; i < onset.length; i++) {
      const p = ((i / FRAME_RATE) % period) / period;
      hist[Math.floor(p * BINS) % BINS] += onset[i];
    }
    let bs = -Infinity;
    let bp = 0;
    for (let b = 0; b < BINS; b++) {
      const s = hist[b] + hist[(b + 1) % BINS] * 0.5 + hist[(b + BINS - 1) % BINS] * 0.5 + 0.5 * hist[(b + BINS / 2) % BINS];
      if (s > bs) (bs = s), (bp = b);
    }
    return { score: bs / Math.max(1, duration), phase: ((bp + 0.5) / BINS) * period };
  };
  for (let bpm = best * 0.97; bpm <= best * 1.03; bpm += 0.02) {
    const r = fold(bpm);
    if (r.score > fine.score) fine = { bpm, ...r };
  }
  // Prefer a whole (or half) number BPM when it aligns about as well.
  for (const cand of [Math.round(fine.bpm), Math.round(fine.bpm * 2) / 2]) {
    const r = fold(cand);
    if (r.score >= fine.score * 0.985) {
      fine = { bpm: cand, ...r };
      break;
    }
  }
  return { bpm: fine.bpm, phase: fine.phase };
}

export function analyseAudio(input: AnalysisInput): RhythmGrid {
  const env = computeEnvelopes(input);
  const onset = new Float32Array(env.low.length);
  for (let i = 0; i < onset.length; i++) onset[i] = env.low[i] + 0.8 * env.mid[i] + 0.6 * env.high[i];
  const { bpm, phase } = estimateTempo(onset);
  const beat = 60 / bpm;
  const durationSec = input.samples.length / input.sampleRate;

  // Downbeat: the beat rotation with the most low-band onset energy.
  let bestRot = 0;
  let bestRotScore = -1;
  for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let t = phase + r * beat; t < durationSec; t += 4 * beat) s += sampleEnv(env.low, t) + 0.3 * sampleEnv(onset, t);
    if (s > bestRotScore) (bestRotScore = s), (bestRot = r);
  }
  const offset = (phase + bestRot * beat) % (4 * beat);

  // Sample the grid: the strongest onset within ±25 ms of each 1/4-beat position.
  const slotLen = beat / SLOTS_PER_BEAT;
  const count = Math.floor((durationSec - offset) / slotLen);
  const peak = (e: Float32Array, t: number) => {
    let m = 0;
    for (let d = -0.025; d <= 0.025; d += 0.01) m = Math.max(m, sampleEnv(e, t + d));
    return Math.min(1, m);
  };
  const slots: RhythmSlot[] = [];
  for (let k = 0; k < count; k++) {
    const t = offset + k * slotLen;
    const low = peak(env.low, t);
    const high = Math.max(peak(env.high, t), peak(env.mid, t) * 0.9);
    const all = Math.min(1, peak(onset, t) / 1.6);
    slots.push({ strength: Math.max(all, low, high * 0.9), low, high, sustain: 0 });
  }

  // Loudness per beat, normalised and smoothed over two bars.
  const beats = Math.ceil(count / SLOTS_PER_BEAT);
  const raw = new Float32Array(beats);
  for (let b = 0; b < beats; b++) {
    const f0 = Math.floor((offset + b * beat) * FRAME_RATE);
    const f1 = Math.min(env.rms.length, Math.floor((offset + (b + 1) * beat) * FRAME_RATE));
    let s = 0;
    for (let f = f0; f < f1; f++) s += env.rms[f];
    raw[b] = f1 > f0 ? s / (f1 - f0) : 0;
  }
  const loud = percentile(raw, 0.9) || 1;
  const energy: number[] = [];
  for (let b = 0; b < beats; b++) {
    let s = 0;
    let n = 0;
    for (let j = b - 4; j <= b + 4; j++) if (j >= 0 && j < beats) (s += raw[j]), n++;
    energy.push(Math.min(1, s / n / loud));
  }

  // Preview: start of the loudest 8-bar stretch.
  let previewBeat = 0;
  let previewScore = -1;
  for (let b = 0; b + 32 <= beats; b += 4) {
    let s = 0;
    for (let j = b; j < b + 32; j++) s += energy[j];
    if (s > previewScore) (previewScore = s), (previewBeat = b);
  }

  return {
    bpm,
    offset: Math.round(offset * 1000),
    beatLength: 60000 / bpm,
    slots,
    energy,
    durationMs: Math.round(durationSec * 1000),
    previewTime: Math.round((offset + previewBeat * beat) * 1000),
  };
}
