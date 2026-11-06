// Shared description of a song's rhythm, used by the chart generator.
// Built either from a synthesized song (exact events) or from audio analysis of a user file.

/** One 1/4-beat position on the song's beat grid. */
export interface RhythmSlot {
  /** Overall onset strength, 0..1. */
  strength: number;
  /** Low-band (kick / bass) onset strength, 0..1. */
  low: number;
  /** High-band (snare / hat / clap) onset strength, 0..1. */
  high: number;
  /** Length in beats of a sustained melodic note starting here (0 when none). */
  sustain: number;
}

export interface RhythmGrid {
  bpm: number;
  /** Time of the first bar line, in ms. */
  offset: number;
  beatLength: number;
  /** Slot k sits at offset + k * beatLength / 4. */
  slots: RhythmSlot[];
  /** Loudness per beat (index = beat from offset), 0..1, smoothed. */
  energy: number[];
  durationMs: number;
  previewTime: number;
}

export const SLOTS_PER_BEAT = 4;
export const SLOTS_PER_BAR = 16;

export const slotTime = (grid: RhythmGrid, k: number): number => grid.offset + (k * grid.beatLength) / SLOTS_PER_BEAT;

export function energyAt(grid: RhythmGrid, k: number): number {
  const beat = Math.floor(k / SLOTS_PER_BEAT);
  return grid.energy[Math.max(0, Math.min(grid.energy.length - 1, beat))] ?? 0;
}

/** Small seeded PRNG (mulberry32) so a seed always produces the same song and chart. */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
