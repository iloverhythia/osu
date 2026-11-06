// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Playback timing of storyboard samples (port of DrawableStoryboardSample.Update / SamplePlaybackDisabledChanged).

import { describe, expect, it } from 'vitest';
import type { AudioEngine } from '../../src/framework/audio/AudioEngine';
import { DrawableStoryboardSamples } from '../../src/game/storyboard/DrawableStoryboardSample';
import { StoryboardElementSource, StoryboardSampleInfo } from '../../src/game/storyboard/Storyboard';

function fakeEngine() {
  const started: { name: string; rate: number; volume: number; stopped: boolean }[] = [];
  const engine = {
    effects: { gain: {} },
    ctx: {
      state: 'running',
      createBufferSource() {
        const entry = { name: '', rate: 1, volume: 1, stopped: false };
        return {
          set buffer(b: { name: string }) {
            entry.name = b.name;
          },
          playbackRate: {
            set value(v: number) {
              entry.rate = v;
            },
          },
          connect(g: { gain: { value: number } }) {
            entry.volume = g.gain.value;
          },
          start() {
            started.push(entry);
          },
          stop() {
            entry.stopped = true;
          },
          onended: null,
        };
      },
      createGain() {
        return { gain: { value: 1 }, connect() {}, disconnect() {} };
      },
    },
  };
  const buffer = (name: string) => ({ name }) as unknown as AudioBuffer;
  return {
    engine: engine as unknown as AudioEngine,
    started,
    make(samples: [number, string, number?][]) {
      return new DrawableStoryboardSamples(
        engine as unknown as AudioEngine,
        samples.map(([time, name, volume]) => {
          const info = new StoryboardSampleInfo(StoryboardElementSource.Shared, name, time, volume ?? 100);
          return { info, buffer: buffer(name) };
        }),
      );
    },
  };
}

describe('storyboard samples', () => {
  it('plays samples as their start time is passed, with volume and rate', () => {
    const f = fakeEngine();
    const s = f.make([
      [1000, 'a', 50],
      [2000, 'b'],
    ]);
    s.update(900, true, 1.5);
    expect(f.started).toHaveLength(0);
    s.update(1010, true, 1.5);
    expect(f.started.map(x => x.name)).toEqual(['a']);
    expect(f.started[0].rate).toBe(1.5);
    expect(f.started[0].volume).toBe(0.5);
    s.update(1500, true, 1.5);
    expect(f.started).toHaveLength(1);
  });

  it('does not play samples skipped by more than the allowable late start', () => {
    const f = fakeEngine();
    const s = f.make([
      [1000, 'a'],
      [1950, 'b'],
    ]);
    s.update(500, true, 1);
    s.update(2040, true, 1); // e.g. a skip: "a" is 1040ms late, "b" 90ms
    expect(f.started.map(x => x.name)).toEqual(['b']);
  });

  it('stops samples when playback is disabled (paused) and on rewinding before their start', () => {
    const f = fakeEngine();
    const s = f.make([[1000, 'a']]);
    s.update(990, true, 1);
    s.update(1005, true, 1);
    expect(f.started[0].stopped).toBe(false);
    s.update(1005, false, 1);
    expect(f.started[0].stopped).toBe(true);

    const g = fakeEngine();
    const r = g.make([[1000, 'a']]);
    r.update(990, true, 1);
    r.update(1005, true, 1);
    r.update(500, true, 1);
    expect(g.started[0].stopped).toBe(true);
    // passing the start time again plays it again
    r.update(1001, true, 1);
    expect(g.started).toHaveLength(2);
  });
});
