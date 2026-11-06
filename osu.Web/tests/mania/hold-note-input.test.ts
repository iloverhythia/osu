// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game.Rulesets.Mania.Tests/TestSceneHoldNoteInput.cs (judgement logic of DrawableHoldNote & friends).

import { describe, expect, it } from 'vitest';
import { HitResult } from '../../src/game/scoring/HitResult';
import { HeadNote, HoldNote, HoldNoteBody, Note, TailNote } from '../../src/game/rulesets/mania/objects/ManiaHitObject';
import { ManiaHitWindows } from '../../src/game/rulesets/mania/scoring/ManiaHitWindows';
import { buildPlayable, hold, note, play, type Frame, type RunResult } from './helpers';

const time_before_head = 250;
const time_head = 1500;
const time_during_hold_1 = 2500;
const time_tail = 4000;
const time_after_tail = 5250;

const defaultBeatmap = () => buildPlayable([hold(time_head, time_tail - time_head, 0)]);

const headResult = (r: RunResult) => r.results.find(j => j.hitObject instanceof Note)!.type;
const tailResults = (r: RunResult) => r.results.filter(j => j.hitObject instanceof TailNote);
const tailResult = (r: RunResult) => {
  const t = tailResults(r);
  expect(t.length).toBe(1);
  return t[0].type;
};
const holdResult = (r: RunResult) => {
  const t = r.results.filter(j => j.hitObject instanceof HoldNote);
  expect(t.length).toBe(1);
  return t[0].type;
};

const f = (time: number, ...columns: number[]): Frame => ({ time, columns });

describe('hold note input (TestSceneHoldNoteInput)', () => {
  it('no input', () => {
    const r = play(defaultBeatmap(), [f(time_before_head), f(time_after_tail)]);
    expect(headResult(r)).toBe(HitResult.Miss);
    expect(tailResult(r)).toBe(HitResult.Miss);
    expect(holdResult(r)).toBe(HitResult.IgnoreMiss);
  });

  it('correct input', () => {
    const r = play(defaultBeatmap(), [f(time_head, 0), f(time_tail)]);
    expect(headResult(r)).toBe(HitResult.Perfect);
    expect(tailResult(r)).toBe(HitResult.Perfect);
    expect(holdResult(r)).toBe(HitResult.IgnoreHit);
    expect(r.drawable.hasCompleted).toBe(true);
  });

  it('late release', () => {
    const r = play(defaultBeatmap(), [f(time_head, 0), f(time_after_tail)]);
    expect(headResult(r)).toBe(HitResult.Perfect);
    expect(tailResult(r)).toBe(HitResult.Miss);
    expect(holdResult(r)).toBe(HitResult.IgnoreMiss);
  });

  it('press too early and release after tail', () => {
    const r = play(defaultBeatmap(), [f(time_before_head, 0), f(time_after_tail, 0)]);
    expect(headResult(r)).toBe(HitResult.Miss);
    expect(tailResult(r)).toBe(HitResult.Miss);
  });

  it('press too early and release at tail', () => {
    const r = play(defaultBeatmap(), [f(time_before_head, 0), f(time_tail)]);
    expect(headResult(r)).toBe(HitResult.Miss);
    expect(tailResult(r)).toBe(HitResult.Miss);
  });

  it('press too early, then press at start and release after tail', () => {
    const r = play(defaultBeatmap(), [f(time_before_head, 0), f(time_before_head + 10), f(time_head, 0), f(time_after_tail)]);
    expect(headResult(r)).toBe(HitResult.Perfect);
    expect(tailResult(r)).toBe(HitResult.Miss);
  });

  it('press too early, then press at start and release at tail', () => {
    const r = play(defaultBeatmap(), [f(time_before_head, 0), f(time_before_head + 10), f(time_head, 0), f(time_tail)]);
    expect(headResult(r)).toBe(HitResult.Perfect);
    expect(tailResult(r)).toBe(HitResult.Perfect);
  });

  it('press at start and break', () => {
    const r = play(defaultBeatmap(), [f(time_head, 0), f(time_head + 10), f(time_after_tail)]);
    expect(headResult(r)).toBe(HitResult.Perfect);
    expect(tailResult(r)).toBe(HitResult.Miss);
  });

  it('press at start, release and immediately repress', () => {
    const r = play(defaultBeatmap(), [f(time_head, 0), f(time_head + 1), f(time_head + 2, 0), f(time_tail)]);
    expect(headResult(r)).toBe(HitResult.Perfect);
    expect(r.results[0].comboAfterJudgement).toBe(1);
    expect(tailResult(r)).toBe(HitResult.Meh);
    expect(r.results[1].comboAfterJudgement).toBe(0);
    expect(r.results[3].comboAfterJudgement).toBe(1);
  });

  it('press at start, break, repress and release after tail', () => {
    const r = play(defaultBeatmap(), [f(time_head, 0), f(time_head + 10), f(time_during_hold_1, 0), f(time_after_tail)]);
    expect(headResult(r)).toBe(HitResult.Perfect);
    expect(tailResult(r)).toBe(HitResult.Miss);
  });

  it('press at start, break, repress and release at tail', () => {
    const r = play(defaultBeatmap(), [f(time_head, 0), f(time_head + 10), f(time_during_hold_1, 0), f(time_tail)]);
    expect(headResult(r)).toBe(HitResult.Perfect);
    expect(tailResult(r)).toBe(HitResult.Meh);
  });

  it('press during note and release after tail', () => {
    const r = play(defaultBeatmap(), [f(time_during_hold_1, 0), f(time_after_tail)]);
    expect(headResult(r)).toBe(HitResult.Miss);
    expect(tailResult(r)).toBe(HitResult.Miss);
  });

  it('press during note and release at tail', () => {
    const r = play(defaultBeatmap(), [f(time_during_hold_1, 0), f(time_tail)]);
    expect(headResult(r)).toBe(HitResult.Miss);
    expect(tailResult(r)).toBe(HitResult.Meh);
  });

  it('press and release just before tail with nearby note and close-by head', () => {
    const duration = 50;
    const n = note(time_head + duration + 10);
    const playable = buildPlayable([hold(time_head, duration), n]);
    const r = play(playable, [f(time_head + duration, 0), f(time_head + duration + 10)]);
    expect(headResult(r)).toBe(HitResult.Good);
    expect(tailResult(r)).toBe(HitResult.Perfect);
    expect(r.results.find(j => j.hitObject === n)!.type).toBe(HitResult.Miss);
  });

  it('press and release just before tail with nearby note', () => {
    const n = note(time_tail + 50);
    const playable = buildPlayable([hold(time_head, time_tail - time_head), n]);
    const r = play(playable, [f(time_tail - 10, 0), f(time_tail)]);
    expect(headResult(r)).toBe(HitResult.Miss);
    expect(tailResult(r)).toBe(HitResult.Miss);
    expect(r.results.find(j => j.hitObject === n)!.type).toBe(HitResult.Good);
  });

  it('press and release just after tail with nearby note', () => {
    const n = note(time_tail + 50);
    const playable = buildPlayable([hold(time_head, time_tail - time_head), n]);
    const r = play(playable, [f(time_tail + 10, 0), f(time_tail + 20)]);
    expect(headResult(r)).toBe(HitResult.Miss);
    expect(tailResult(r)).toBe(HitResult.Miss);
    expect(r.results.find(j => j.hitObject === n)!.type).toBe(HitResult.Great);
  });

  it('press and release at tail', () => {
    const r = play(defaultBeatmap(), [f(time_tail, 0), f(time_tail + 10)]);
    expect(headResult(r)).toBe(HitResult.Miss);
    expect(tailResult(r)).toBe(HitResult.Meh);
  });

  it('miss release and hit second release', () => {
    const windows = new ManiaHitWindows();
    windows.setDifficulty(10);
    const first = hold(1000, 500);
    const second = hold(1000 + 500 + windows.windowFor(HitResult.Miss) + 10, 500);
    const playable = buildPlayable([first, second], { od: 10 });
    const r = play(playable, [f(second.startTime, 0), f(second.endTime)]);

    const nestedResults = (h: HoldNote) => r.results.filter(j => h.nested.includes(j.hitObject as HeadNote));
    expect(nestedResults(first).length).toBe(3);
    expect(nestedResults(first).every(j => j.type !== HitResult.Perfect && j.type !== HitResult.IgnoreHit)).toBe(true);
    expect(nestedResults(second).length).toBe(3);
    expect(nestedResults(second).every(j => j.type === HitResult.Perfect || j.type === HitResult.IgnoreHit)).toBe(true);
  });

  it('zero length', () => {
    const h = hold(1000, 0);
    const r = play(buildPlayable([h]), [f(1000, 0), f(1001)]);
    const nested = r.results.filter(j => h.nested.includes(j.hitObject as HeadNote));
    expect(nested.length).toBe(3);
    expect(nested.every(j => j.type === HitResult.Perfect || j.type === HitResult.IgnoreHit)).toBe(true);
  });

  it('release during hold breaks the body at the release time', () => {
    const r = play(defaultBeatmap(), [f(time_head, 0), f(time_during_hold_1)]);
    expect(headResult(r)).toBe(HitResult.Perfect);
    expect(tailResult(r)).toBe(HitResult.Miss);
    expect(holdResult(r)).toBe(HitResult.IgnoreMiss);
    const body = r.results.find(j => j.hitObject instanceof HoldNoteBody)!;
    expect(body.type).toBe(HitResult.ComboBreak);
    // TimeAbsolute (end time + clamped offset) indicates the release during the hold.
    expect(Math.abs(body.objectEndTime + body.timeOffset - time_during_hold_1)).toBeLessThanOrEqual(100);
  });
});
