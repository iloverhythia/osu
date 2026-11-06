// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Value-at-time semantics of storyboard commands (StoryboardSprite.ApplyTransforms + osu-framework transforms), triggers and animations.

import { describe, expect, it } from 'vitest';
import { HitSampleInfo } from '../../src/game/audio/HitSampleInfo';
import { SpriteState, SpriteTimeline } from '../../src/game/storyboard/CommandTimeline';
import { DrawableStoryboardSprite } from '../../src/game/storyboard/DrawableStoryboard';
import { applyEasing, Easing } from '../../src/game/storyboard/Easing';
import { LegacyStoryboardDecoder } from '../../src/game/storyboard/LegacyStoryboardDecoder';
import type { StoryboardAnimation, StoryboardSprite } from '../../src/game/storyboard/Storyboard';
import { HitSampleTriggerDefinition, StoryboardTriggerController } from '../../src/game/storyboard/StoryboardTriggerController';
import { StoryboardTextureStore } from '../../src/game/storyboard/TextureStore';

function spriteFrom(commands: string, layer = 'Foreground'): StoryboardSprite {
  const sb = LegacyStoryboardDecoder.decode(`[Events]\nSprite,${layer},Centre,"a.png",320,240\n${commands}\n`);
  return sb.getLayer(layer).elements[0] as StoryboardSprite;
}

function stateAt(timeline: SpriteTimeline, time: number): SpriteState {
  const s = new SpriteState();
  timeline.evaluate(time, s);
  return s;
}

describe('command timelines', () => {
  it('uses the first command start value before any command has started', () => {
    const tl = new SpriteTimeline(spriteFrom(' F,0,1000,2000,0.25,1\n F,0,500,600,0.75,0.5'));
    // chronologically first alpha command is the 500ms one → its start value applies before it
    expect(stateAt(tl, 0).alpha).toBe(0.75);
    expect(stateAt(tl, 550).alpha).toBeCloseTo(0.625, 10);
    // between commands the last started one holds its end value
    expect(stateAt(tl, 800).alpha).toBe(0.5);
    expect(stateAt(tl, 1000).alpha).toBe(0.25);
    expect(stateAt(tl, 1500).alpha).toBeCloseTo(0.625, 10);
    expect(stateAt(tl, 5000).alpha).toBe(1);
  });

  it('keeps the initial position for properties without commands, and overrides it with the first move', () => {
    const tl = new SpriteTimeline(spriteFrom(' MX,0,1000,2000,100,200\n F,0,0,0,1'));
    const before = stateAt(tl, 0);
    expect(before.x).toBe(100);
    expect(before.y).toBe(240);
    expect(stateAt(tl, 1500).x).toBe(150);
    expect(stateAt(tl, 1500).scaleX).toBe(1);
    expect(stateAt(tl, 1500).r).toBe(1);
  });

  it('lets a later-starting command supersede one still running', () => {
    const tl = new SpriteTimeline(spriteFrom(' MX,0,0,1000,0,100\n MX,0,500,600,1000,1000'));
    expect(stateAt(tl, 400).x).toBe(40);
    expect(stateAt(tl, 550).x).toBe(1000);
    // the first command does not resume once the second has finished
    expect(stateAt(tl, 800).x).toBe(1000);
  });

  it('orders commands with equal start times by end time then file order', () => {
    const tl = new SpriteTimeline(spriteFrom(' F,0,100,300,0,1\n F,0,100,200,0.5,0.5'));
    // sorted list order: (100,200) then (100,300) → the 300ms one has the higher TransformID and wins
    expect(stateAt(tl, 150).alpha).toBe(0.25);
    expect(stateAt(tl, 0).alpha).toBe(0.5); // initial value from the first in order
  });

  it('applies easing (unclamped for floats)', () => {
    const tl = new SpriteTimeline(spriteFrom(` S,${Easing.OutBack},0,1000,0,1\n F,0,0,0,1`));
    const v = stateAt(tl, 800).scaleX;
    expect(v).toBeCloseTo(applyEasing(Easing.OutBack, 0.8), 10);
    expect(v).toBeGreaterThan(1);
  });

  it('interpolates colours in linear space with clamped easing', () => {
    const tl = new SpriteTimeline(spriteFrom(` C,${Easing.OutBack},0,1000,0,0,0,255,255,255`));
    const mid = stateAt(tl, 500);
    const t = Math.min(1, applyEasing(Easing.OutBack, 0.5));
    const expected = 1.055 * Math.pow(t, 1 / 2.4) - 0.055;
    expect(mid.r).toBeCloseTo(expected, 5);
    // overshoot is clamped
    expect(stateAt(tl, 800).r).toBeCloseTo(1, 5);
    expect(stateAt(tl, -100).r).toBe(0);
  });

  it('repeats loops with the loop group duration as period', () => {
    const tl = new SpriteTimeline(spriteFrom(' L,1000,3\n  F,0,0,500,0,1\n  F,0,500,1000,1,0'));
    expect(stateAt(tl, 0).alpha).toBe(0); // initial
    expect(stateAt(tl, 1250).alpha).toBe(0.5);
    expect(stateAt(tl, 1750).alpha).toBe(0.5);
    expect(stateAt(tl, 2250).alpha).toBe(0.5); // second iteration
    expect(stateAt(tl, 3000).alpha).toBe(0); // third iteration starts
    expect(stateAt(tl, 3250).alpha).toBe(0.5);
    expect(stateAt(tl, 4500).alpha).toBe(0); // done: holds the last end value
  });

  it('interleaves loop iterations with top-level commands by start time', () => {
    const tl = new SpriteTimeline(spriteFrom(' L,0,10\n  MX,0,0,100,0,100\n MX,0,250,250,500'));
    expect(stateAt(tl, 50).x).toBe(50);
    expect(stateAt(tl, 260).x).toBe(500); // top-level command started after iteration 2
    expect(stateAt(tl, 350).x).toBe(50); // iteration 3 started later and wins again
  });

  it('does not loop when the loop group has zero duration', () => {
    const tl = new SpriteTimeline(spriteFrom(' L,1000,5\n  F,0,0,0,0.5'));
    expect(stateAt(tl, 999).alpha).toBe(0.5);
    expect(stateAt(tl, 1000).alpha).toBe(0.5);
  });

  it('handles parameter commands as instantaneous switches, permanent when the first has zero duration', () => {
    const temporary = new SpriteTimeline(spriteFrom(' F,0,0,0,1\n P,0,1000,2000,H\n P,0,1000,2000,A'));
    expect(stateAt(temporary, 500).flipH).toBe(false);
    expect(stateAt(temporary, 1000).flipH).toBe(true);
    expect(stateAt(temporary, 1999).additive).toBe(true);
    expect(stateAt(temporary, 2000).flipH).toBe(false);
    expect(stateAt(temporary, 2000).additive).toBe(false);

    const permanent = new SpriteTimeline(spriteFrom(' F,0,0,0,1\n P,0,1000,1000,V\n P,0,5000,6000,V'));
    expect(stateAt(permanent, 0).flipV).toBe(true);
    expect(stateAt(permanent, 5500).flipV).toBe(true);
    expect(stateAt(permanent, 7000).flipV).toBe(false);

    // the end-time switch of an earlier command is a separate transform which can override a later-starting command
    const overlap = new SpriteTimeline(spriteFrom(' F,0,0,0,1\n P,0,1000,3000,H\n P,0,2000,5000,H'));
    expect(stateAt(overlap, 2500).flipH).toBe(true);
    expect(stateAt(overlap, 4000).flipH).toBe(false);
  });

  it('applies trigger groups relative to the trigger time, removing later transforms of the same property', () => {
    const sprite = spriteFrom(' F,0,0,0,0.2\n F,0,8000,8000,0.9\n T,HitSoundClap,0,10000\n  F,0,0,100,1,0');
    const tl = new SpriteTimeline(sprite);
    const controller = new StoryboardTriggerController();
    controller.bind(tl, sprite.triggerGroups[0]);

    expect(stateAt(tl, 1000).alpha).toBeCloseTo(0.2, 6);
    controller.onSamplesPlayed([new HitSampleInfo({ name: 'hitnormal' })], 1000); // no clap → no trigger
    expect(stateAt(tl, 1050).alpha).toBeCloseTo(0.2, 6);
    controller.onSamplesPlayed([new HitSampleInfo({ name: 'hitnormal' }), new HitSampleInfo({ name: 'hitclap' })], 1000);
    expect(stateAt(tl, 1000).alpha).toBe(1);
    expect(stateAt(tl, 1050).alpha).toBeCloseTo(0.5, 10);
    expect(stateAt(tl, 2000).alpha).toBe(0);
    // the F at 8000 sorted after the trigger's transform and was removed
    expect(stateAt(tl, 9000).alpha).toBe(0);
    // outside the trigger's active range nothing happens
    controller.onSamplesPlayed([new HitSampleInfo({ name: 'hitclap' })], 11000);
    expect(stateAt(tl, 11050).alpha).toBe(0);
  });

  it('fires Passing/Failing triggers on changes and HitObjectHit triggers', () => {
    const sprite = spriteFrom(' F,0,0,0,1\n T,Failing\n  MX,0,0,0,10\n T,Passing\n  MX,0,0,0,20\n T,HitObjectHit\n  S,0,0,100,2,1');
    const tl = new SpriteTimeline(sprite);
    const controller = new StoryboardTriggerController();
    for (const g of sprite.triggerGroups) controller.bind(tl, g);
    controller.onPassingChanged(false, 100);
    expect(stateAt(tl, 150).x).toBe(10);
    controller.onPassingChanged(true, 200);
    expect(stateAt(tl, 250).x).toBe(20);
    controller.onHitObjectHit(300);
    expect(stateAt(tl, 350).scaleX).toBe(1.5);
  });
});

describe('HitSampleTriggerDefinition', () => {
  const samples = (...s: [string, string, number?][]) => s.map(([name, bank, csb]) => new HitSampleInfo({ name, bank, customSampleBank: csb }));

  it('parses names like stable', () => {
    expect(HitSampleTriggerDefinition.tryParse('HitSound')).not.toBeNull();
    expect(HitSampleTriggerDefinition.tryParse('HitSoundFoo')).toBeNull();
    const d = HitSampleTriggerDefinition.tryParse('hitsoundsoftwhistle')!;
    // bank1 followed by a sample name (and no bank2) is the addition bank
    expect(d.additionBank).toBe('soft');
    expect(d.normalBank).toBeNull();
    expect(d.additionName).toBe('hitwhistle');
    const d2 = HitSampleTriggerDefinition.tryParse('HitSoundDrumNormalClap2')!;
    expect(d2.normalBank).toBe('drum');
    expect(d2.additionBank).toBe('normal');
    expect(d2.additionName).toBe('hitclap');
    expect(d2.suffix).toBe('2');
  });

  it('matches hit samples', () => {
    const any = HitSampleTriggerDefinition.tryParse('HitSound')!;
    expect(any.matches(samples(['hitnormal', 'normal']))).toBe(true);
    const drum = HitSampleTriggerDefinition.tryParse('HitSoundDrum')!;
    expect(drum.matches(samples(['hitnormal', 'drum']))).toBe(true);
    expect(drum.matches(samples(['hitnormal', 'soft']))).toBe(false);
    const softFinish = HitSampleTriggerDefinition.tryParse('HitSoundSoftFinish')!;
    expect(softFinish.matches(samples(['hitnormal', 'normal'], ['hitfinish', 'soft']))).toBe(true);
    expect(softFinish.matches(samples(['hitnormal', 'normal'], ['hitfinish', 'drum']))).toBe(false);
    expect(softFinish.matches(samples(['hitnormal', 'soft']))).toBe(false);
    const suffixed = HitSampleTriggerDefinition.tryParse('HitSound3')!;
    expect(suffixed.matches(samples(['hitnormal', 'normal', 3]))).toBe(true);
    expect(suffixed.matches(samples(['hitnormal', 'normal']))).toBe(false);
  });
});

describe('animations', () => {
  function animation(loop: string): DrawableStoryboardSprite {
    const sb = LegacyStoryboardDecoder.decode(`[Events]\nAnimation,Foreground,Centre,"f.png",320,240,4,100,${loop}\n S,0,1000,1000,1\n F,0,2000,3000,0,1\n`);
    const anim = sb.getLayer('Foreground').elements[0] as StoryboardAnimation;
    return new DrawableStoryboardSprite(anim, 0, new StoryboardTextureStore({}, sb));
  }

  it('plays from the earliest transform time and loops forever', () => {
    const a = animation('LoopForever');
    expect(a.lifetimeStart).toBe(2000);
    expect(a.textures).toHaveLength(4);
    expect(a.frameAt(500)).toBe(0);
    expect(a.frameAt(1000)).toBe(0);
    expect(a.frameAt(1099)).toBe(0);
    expect(a.frameAt(1100)).toBe(1);
    expect(a.frameAt(1399)).toBe(3);
    expect(a.frameAt(1400)).toBe(0);
    expect(a.frameAt(2250)).toBe(0); // (2250 - 1000) % 400 = 50
    expect(a.frameAt(2450)).toBe(2);
  });

  it('holds the last frame when looping once', () => {
    const a = animation('LoopOnce');
    expect(a.frameAt(1350)).toBe(3);
    expect(a.frameAt(5000)).toBe(3);
  });
});

describe('easing', () => {
  it('starts at 0 and ends at 1 for every easing', () => {
    for (let e = Easing.None; e <= Easing.OutPow10; e++) {
      expect(applyEasing(e, 0)).toBeCloseTo(0, 6);
      expect(applyEasing(e, 1)).toBeCloseTo(1, 6);
    }
    expect(applyEasing(Easing.Out, 0.5)).toBe(0.75);
    expect(applyEasing(Easing.In, 0.5)).toBe(0.25);
    expect(applyEasing(999, 0.3)).toBe(0.3);
  });
});
