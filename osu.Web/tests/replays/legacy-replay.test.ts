import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeOsr, encodeOsr, legacyFramesToReplay, modsFromLegacy, modsToLegacy, replayToLegacyFrames } from '../../src/game/replays/LegacyReplay';
import { md5 } from '../../src/game/replays/md5';
import type { Replay } from '../../src/game/replays/Replay';

const RES = '/home/user/osu/osu.Game.Tests/Resources/Replays/';
const read = (name: string) => new Uint8Array(readFileSync(RES + name));

describe('md5', () => {
  it('matches known digests', () => {
    expect(md5(new TextEncoder().encode(''))).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(md5(new TextEncoder().encode('The quick brown fox jumps over the lazy dog'))).toBe('9e107d9d372bb6826bd81d3542a419d6');
  });
});

// Ports of osu.Game.Tests/Beatmaps/Formats/LegacyScoreDecoderTest.cs
describe('LegacyScoreDecoder', () => {
  it('decodes the mania replay (TestDecodeManiaReplay)', () => {
    const d = decodeOsr(read('mania-replay.osr'));
    expect(d.rulesetId).toBe(3);
    expect(d.maxCombo).toBe(3);
    expect(d.count300).toBe(2); // Great
    expect(d.countKatu).toBe(1); // Good
    expect(d.totalScore).toBe(829931);
    expect(d.mods).toContain('9K');
    // Has one frame at 414ms pressing Key1 and Key18.
    const frame = d.frames.find(f => f.time === 414)!;
    expect(frame).toBeDefined();
    const replay = legacyFramesToReplay(d);
    const pressedAt414 = replay.events.filter(e => e.t === 414 && e.k === 'p').map(e => (e as { a: string }).a);
    expect(pressedAt414.sort()).toEqual(['K1', 'K18']);
  });

  it('decodes the taiko replay (TestDecodeTaikoReplay)', () => {
    const d = decodeOsr(read('taiko-replay.osr'));
    expect(d.rulesetId).toBe(1);
    expect(d.maxCombo).toBe(4);
    expect(d.frames.length).toBeGreaterThan(0);
    const replay = legacyFramesToReplay(d);
    expect(replay.events.some(e => e.k === 'p')).toBe(true);
  });

  it('round-trips an osu! replay through the encoder', () => {
    const replay: Replay = {
      rulesetId: 0,
      space: 'gamefield',
      player: 'tester',
      mods: ['HD', 'DT'],
      events: [
        { t: 100, k: 'm', x: 10, y: 20 },
        { t: 150, k: 'p', a: 'LeftButton' },
        { t: 200, k: 'm', x: 300.5, y: 200.25 },
        { t: 250, k: 'r', a: 'LeftButton' },
        { t: 300, k: 'p', a: 'RightButton' },
        { t: 320, k: 'r', a: 'RightButton' },
      ],
    };
    const bytes = encodeOsr(
      { rulesetId: 0, beatmapMD5: 'abc', playerName: 'tester', count300: 5, count100: 1, count50: 0, countGeki: 0, countKatu: 0, countMiss: 2, totalScore: 12345, maxCombo: 7, perfect: false, mods: ['HD', 'DT'], date: Date.UTC(2024, 0, 1) },
      replayToLegacyFrames(replay),
    );
    const d = decodeOsr(bytes);
    expect(d.beatmapMD5).toBe('abc');
    expect(d.playerName).toBe('tester');
    expect(d.count300).toBe(5);
    expect(d.countMiss).toBe(2);
    expect(d.mods.sort()).toEqual(['DT', 'HD']);
    expect(d.date).toBe(Date.UTC(2024, 0, 1));
    const back = legacyFramesToReplay(d);
    const presses = back.events.filter(e => e.k !== 'm');
    expect(presses).toEqual([
      { t: 150, k: 'p', a: 'LeftButton' },
      { t: 250, k: 'r', a: 'LeftButton' },
      { t: 300, k: 'p', a: 'RightButton' },
      { t: 320, k: 'r', a: 'RightButton' },
    ]);
    const lastMove = back.events.filter(e => e.k === 'm').pop() as { x: number; y: number };
    expect(lastMove.x).toBeCloseTo(300.5);
    expect(lastMove.y).toBeCloseTo(200.25);
  });

  it('maps legacy mod flags', () => {
    expect(modsFromLegacy(64 | 512).sort()).toEqual(['NC']);
    expect(modsFromLegacy(32 | 16384)).toEqual(['PF']);
    expect(modsToLegacy(['NC'])).toBe(576);
    expect(modsFromLegacy(modsToLegacy(['HR', 'HD', 'FL'])).sort()).toEqual(['FL', 'HD', 'HR']);
  });
});
