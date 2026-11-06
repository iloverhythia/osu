import { describe, expect, it } from 'vitest';
import { LegacyBeatmapDecoder } from '../../src/game/beatmaps/LegacyBeatmapDecoder';
import { ModSet } from '../../src/game/mods/Mods';
import type { Ruleset } from '../../src/game/rulesets/Ruleset';
import { convertOsuBeatmap } from '../../src/game/rulesets/osu/beatmap';
import { calculateOsuDifficulty, calculateOsuPerformance, OsuDifficultyAttributes } from '../../src/game/rulesets/osu/difficulty';

function header(od = 8, ar = 9, cs = 4): string {
  return `osu file format v14

[General]
StackLeniency: 0.7
Mode: 0

[Difficulty]
HPDrainRate:5
CircleSize:${cs}
OverallDifficulty:${od}
ApproachRate:${ar}
SliderMultiplier:1.4
SliderTickRate:1

[TimingPoints]
0,300,4,2,0,60,1,0

[HitObjects]
`;
}

/** n circles every `interval` ms, alternating between two points `spacing` px apart. */
function backAndForth(n: number, interval: number, spacing: number): string {
  let s = header();
  for (let i = 0; i < n; i++) {
    const x = 256 + (i % 2 === 0 ? -spacing / 2 : spacing / 2);
    s += `${Math.round(x)},192,${1000 + i * interval},${i === 0 ? 5 : 1},0,0:0:0:0:\n`;
  }
  return s;
}

/** Square jump pattern (90° angles). */
function squareJumps(n: number, interval: number, size: number): string {
  const pts = [
    [256 - size / 2, 192 - size / 2],
    [256 + size / 2, 192 - size / 2],
    [256 + size / 2, 192 + size / 2],
    [256 - size / 2, 192 + size / 2],
  ];
  let s = header();
  for (let i = 0; i < n; i++) {
    const [x, y] = pts[i % 4];
    s += `${Math.round(x)},${Math.round(y)},${1000 + i * interval},${i === 0 ? 5 : 1},0,0:0:0:0:\n`;
  }
  return s;
}

function sliders(n: number, interval: number): string {
  let s = header();
  for (let i = 0; i < n; i++) {
    const y = i % 2 === 0 ? 100 : 300;
    s += `100,${y},${1000 + i * interval},${i === 0 ? 6 : 2},0,L|400:${y},1,280\n`;
  }
  return s;
}

const calc = (osu: string, mods: string[] = []): OsuDifficultyAttributes =>
  calculateOsuDifficulty(convertOsuBeatmap(LegacyBeatmapDecoder.decode(osu), {} as Ruleset, new ModSet(mods)));

const JUMPS = squareJumps(200, 300, 250);
const STREAM = backAndForth(200, 75, 20);

describe('osu! difficulty sanity', () => {
  it('empty and single-object maps', () => {
    const empty = calc(header());
    expect(empty.starRating).toBe(0);
    expect(empty.maxCombo).toBe(0);
    const single = calc(header() + '256,192,1000,5,0,0:0:0:0:\n');
    expect(single.starRating).toBe(0);
    expect(single.maxCombo).toBe(1);
    expect(single.hitCircleCount).toBe(1);
  });

  it('rate mods: DT > NM > HT', () => {
    for (const map of [JUMPS, STREAM, sliders(60, 600)]) {
      const nm = calc(map).starRating;
      const dt = calc(map, ['DT']).starRating;
      const nc = calc(map, ['NC']).starRating;
      const ht = calc(map, ['HT']).starRating;
      expect(dt).toBeGreaterThan(nm);
      expect(nm).toBeGreaterThan(ht);
      expect(nc).toBe(dt);
      expect(calc(map, ['DC']).starRating).toBe(ht);
    }
  });

  it('jumps are aim-heavy, low spacing streams are speed-heavy', () => {
    const jumps = calc(JUMPS);
    const stream = calc(STREAM);
    expect(jumps.aimDifficulty).toBeGreaterThan(stream.aimDifficulty);
    expect(stream.speedDifficulty).toBeGreaterThan(jumps.speedDifficulty);
    expect(jumps.aimDifficulty).toBeGreaterThan(jumps.speedDifficulty);
    expect(stream.speedDifficulty).toBeGreaterThan(stream.aimDifficulty);
  });

  it('bigger jumps are harder to aim', () => {
    expect(calc(squareJumps(100, 300, 300)).aimDifficulty).toBeGreaterThan(calc(squareJumps(100, 300, 150)).aimDifficulty);
  });

  it('HR raises and EZ lowers star rating; AR/OD are rate adjusted', () => {
    const nm = calc(JUMPS);
    expect(calc(JUMPS, ['HR']).starRating).toBeGreaterThan(nm.starRating);
    expect(calc(JUMPS, ['EZ']).starRating).toBeLessThan(nm.starRating);
    expect(nm.approachRate).toBeCloseTo(9, 5);
    expect(nm.overallDifficulty).toBeCloseTo(8, 1);
    const dt = calc(JUMPS, ['DT']);
    expect(dt.approachRate).toBeCloseTo(10.333, 2); // AR9 + DT = AR10.33
    expect(dt.overallDifficulty).toBeCloseTo(9.75, 5); // OD8: great 31.5ms / 1.5 = 21ms
    expect(calc(JUMPS, ['HT']).approachRate).toBeLessThan(9);
  });

  it('flashlight only with FL; HD increases reading', () => {
    expect(calc(JUMPS).flashlightDifficulty).toBeUndefined();
    const fl = calc(JUMPS, ['FL']);
    expect(fl.flashlightDifficulty).toBeGreaterThan(0);
    expect(fl.starRating).toBeGreaterThanOrEqual(calc(JUMPS).starRating);
    expect(calc(JUMPS, ['HD']).readingDifficulty).toBeGreaterThan(calc(JUMPS).readingDifficulty);
  });

  it('RX removes speed, AP removes aim', () => {
    expect(calc(STREAM, ['RX']).speedDifficulty).toBe(0);
    expect(calc(JUMPS, ['AP']).aimDifficulty).toBe(0);
  });

  it('counts objects and combo', () => {
    const a = calc(sliders(10, 600) + '256,192,8000,12,0,9000,0:0:0:0:\n');
    expect(a.sliderCount).toBe(10);
    expect(a.spinnerCount).toBe(1);
    expect(a.hitCircleCount).toBe(0);
    // 300px slider at SV1.4 / 300ms beat => 1 tick per slider: head + tick + tail = 3 combo each, +1 spinner.
    expect(a.maxCombo).toBe(31);
    expect(a.sliderFactor).toBeLessThanOrEqual(1);
  });
});

describe('osu! performance sanity', () => {
  const nm = calc(JUMPS);
  const n = nm.hitCircleCount;
  const ss = { count300: n, count100: 0, count50: 0, countMiss: 0, maxCombo: nm.maxCombo, accuracy: 1 };

  it('SS gives finite positive pp', () => {
    const pp = calculateOsuPerformance(nm, ss, new ModSet());
    expect(Number.isFinite(pp)).toBe(true);
    expect(pp).toBeGreaterThan(0);
  });

  it('worse accuracy / misses / lower combo give less pp', () => {
    const mods = new ModSet();
    const pp = calculateOsuPerformance(nm, ss, mods);
    const acc = (c300: number, c100: number, c50: number, miss: number) => (300 * c300 + 100 * c100 + 50 * c50) / (300 * (c300 + c100 + c50 + miss));
    const with100s = calculateOsuPerformance(nm, { ...ss, count300: n - 10, count100: 10, accuracy: acc(n - 10, 10, 0, 0) }, mods);
    const withMiss = calculateOsuPerformance(nm, { ...ss, count300: n - 1, countMiss: 1, maxCombo: Math.floor(n / 2), accuracy: acc(n - 1, 0, 0, 1) }, mods);
    expect(with100s).toBeLessThan(pp);
    expect(withMiss).toBeLessThan(pp);
  });

  it('DT SS gives more pp than NM SS; NF gives slightly less', () => {
    const dt = calc(JUMPS, ['DT']);
    expect(calculateOsuPerformance(dt, ss, new ModSet(['DT']))).toBeGreaterThan(calculateOsuPerformance(nm, ss, new ModSet()));
    const nf = calculateOsuPerformance(calc(JUMPS, ['NF']), ss, new ModSet(['NF']));
    expect(nf).toBeCloseTo(calculateOsuPerformance(nm, ss, new ModSet()), 6); // no misses: NF multiplier is 1
  });
});
