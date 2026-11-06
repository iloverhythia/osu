// Tests for the osu! drawables / mod visuals port (DrawableOsuRuleset, transforms, mods, spinner helpers).
import { describe, expect, it } from 'vitest';
import { LegacyBeatmapDecoder } from '../../src/game/beatmaps/LegacyBeatmapDecoder';
import { demoMaps } from '../../src/game/demo/Demo';
import { ModSet } from '../../src/game/mods/Mods';
import { osuRuleset } from '../../src/game/rulesets/osu';
import { OsuFlashlight, OsuModHidden, isBreakTime, spunOutRotation } from '../../src/game/rulesets/osu/mods';
import { HitCircle, Slider, SliderRepeat, SliderTailCircle, SliderTick, Spinner, type OsuHitObject } from '../../src/game/rulesets/osu/objects';
import { SpinnerSpinHistory, SpinnerSpmCalculator, spinningSampleFrequency } from '../../src/game/rulesets/osu/spinner';
import { Easing, Prop, darken, fromHex } from '../../src/game/rulesets/osu/transforms';
import type { OsuPlayableBeatmap } from '../../src/game/rulesets/osu/beatmap';
import type { DrawableRuleset, GameplayContext } from '../../src/game/rulesets/Ruleset';
import type { JudgementResult } from '../../src/game/scoring/Judgement';
import { HitResult, isHit } from '../../src/game/scoring/HitResult';
import { createSkin } from '../../src/game/Skin';

const MAP = `osu file format v14

[General]
AudioFilename: audio.mp3

[Difficulty]
HPDrainRate:5
CircleSize:4
OverallDifficulty:5
ApproachRate:9
SliderMultiplier:1.4
SliderTickRate:1

[TimingPoints]
0,500,4,2,0,100,1,0

[HitObjects]
100,100,1000,1,0,0:0:0:0:
300,100,2000,2,0,L|440:100,1,140
256,192,3000,12,0,5000,0:0:0:0:
`;

interface Run {
  d: DrawableRuleset;
  playable: OsuPlayableBeatmap;
  results: (JudgementResult & { at: number })[];
  samples: { names: string[]; at: number }[];
  step(to: number): void;
  time(): number;
}

function setup(text: string, mods: string[] = [], settings: Record<string, unknown> = {}): Run {
  const modSet = new ModSet(mods);
  const playable = osuRuleset.createPlayable(LegacyBeatmapDecoder.decode(text), modSet) as OsuPlayableBeatmap;
  const results: (JudgementResult & { at: number })[] = [];
  const samples: { names: string[]; at: number }[] = [];
  let now = -2000;
  let combo = 0;
  const ctx: GameplayContext = {
    mods: modSet,
    skin: createSkin(null),
    settings: { get: <T,>(k: string, f: T) => (k in settings ? (settings[k] as T) : f) },
    autoplay: modSet.isAutoplay,
    rate: modSet.rate,
    applyResult: r => {
      results.push({ ...r, at: now });
      if (r.type === HitResult.Miss) combo = 0;
      else if (isHit(r.type) && r.judgement.maxResult !== HitResult.IgnoreHit) combo++;
    },
    playSamples: s => samples.push({ names: s.map(x => x.name), at: now }),
    startLoop: () => null,
    isPressed: () => false,
    get combo() {
      return combo;
    },
    health: 1,
  };
  const d = osuRuleset.createDrawableRuleset(playable, ctx);
  const frame = (1000 / 60) * modSet.rate;
  return {
    d,
    playable,
    results,
    samples,
    step(to: number) {
      for (; now < to; now += frame) d.update(now, frame);
    },
    time: () => now,
  };
}

const byKind = (r: Run, kind: string) => r.results.filter(x => x.tag === kind);

describe('transforms (osu-framework semantics)', () => {
  it('reads start values when a transform starts and lets the latest-started transform win', () => {
    const p = new Prop(0);
    p.fromTo(100, 0, 1, 100); // FadeInFromZero(100)
    p.to(150, 0, 100); // FadeOut(100) while the fade in is running
    expect(p.at(50)).toBe(0);
    expect(p.at(125)).toBeCloseTo(0.25);
    expect(p.at(150)).toBeCloseTo(0.5);
    expect(p.at(200)).toBeCloseTo(0.25);
    expect(p.at(260)).toBe(0);
  });

  it('removes transforms starting after a newly added one', () => {
    const p = new Prop(1);
    p.to(900, 0); // Delay(800).FadeOut()
    p.to(100, 0, 100); // FadeOut(100) at the hit time
    expect(p.count).toBe(1);
    expect(p.at(150)).toBeCloseTo(0.5);
  });

  it('chains with Then()', () => {
    const p = new Prop(1);
    const end = p.to(0, 2, 40, Easing.OutQuint);
    p.to(end, 1, 200, Easing.OutQuint);
    expect(p.at(40)).toBe(2);
    expect(p.at(240)).toBe(1);
  });

  it('ports Color4.Darken', () => {
    const c = darken(fromHex('ffcc00'), 4);
    expect(c[0]).toBeCloseTo(1 / 5);
    expect(c[1]).toBeCloseTo(0.8 / 5);
  });
});

describe('DrawableSlider judgement timing', () => {
  it('judges the slider itself at its end time, after the tail (tail leniency)', () => {
    const r = setup(MAP, ['AT']);
    r.step(4000);
    const slider = r.playable.hitObjects.find(h => h instanceof Slider) as Slider;
    const tail = byKind(r, 'sliderTail')[0];
    const own = byKind(r, 'slider')[0];
    expect(tail.type).toBe(HitResult.SliderTailHit);
    expect(tail.at).toBeLessThan(slider.endTime);
    expect(own.type).toBe(HitResult.IgnoreHit);
    expect(own.at).toBeGreaterThanOrEqual(slider.endTime);
    expect(own.objectEndTime + own.timeOffset).toBeGreaterThanOrEqual(slider.endTime);
    // DrawableSlider plays the tail's samples when the slider is hit (not when the tail is).
    const tailSamples = r.samples.find(s => Math.abs(s.at - own.at) < 1e-6);
    expect(tailSamples).toBeDefined();
  });
});

describe('OsuModHidden', () => {
  const playable = () => osuRuleset.createPlayable(LegacyBeatmapDecoder.decode(MAP), new ModSet(['HD'])) as OsuPlayableBeatmap;

  it('keeps the slider fade in, shortens everything else', () => {
    const p = playable();
    const before = p.hitObjects.map(h => h.timeFadeIn);
    OsuModHidden.applyToBeatmap(p.hitObjects);
    const [circle, slider] = p.hitObjects as [HitCircle, Slider];
    expect(slider.timeFadeIn).toBe(before[1]);
    expect(circle.timeFadeIn).toBeCloseTo(circle.timePreempt * 0.4);
    expect(slider.headCircle.timeFadeIn).toBeCloseTo(slider.headCircle.timePreempt * 0.4);
  });

  it('computes per-object fade out parameters', () => {
    const p = playable();
    OsuModHidden.applyToBeatmap(p.hitObjects);
    const [circle, slider, spinner] = p.hitObjects as [HitCircle, Slider, Spinner];
    const c = OsuModHidden.fadeOutParameters(circle);
    expect(c.start).toBeCloseTo(circle.startTime - circle.timePreempt + circle.timeFadeIn);
    expect(c.duration).toBeCloseTo(circle.timePreempt * 0.3);
    const s = OsuModHidden.fadeOutParameters(slider);
    expect(s.start + s.duration).toBeCloseTo(slider.endTime);
    const tail = slider.nested.find(n => n instanceof SliderTailCircle)!;
    expect(OsuModHidden.fadeOutParameters(tail)).toEqual(OsuModHidden.fadeOutParameters(slider.headCircle));
    const sp = OsuModHidden.fadeOutParameters(spinner);
    expect(sp.start).toBeCloseTo(spinner.endTime);
    expect(sp.duration).toBeCloseTo(spinner.timePreempt * 0.3);
    expect(OsuModHidden.firstAdjustableObject(p.hitObjects)).toBe(circle);
  });

  it('uses the tick fade sequence for slider ticks', () => {
    const p = osuRuleset.createPlayable(LegacyBeatmapDecoder.decode(demoMaps.osuEasy()), new ModSet(['HD'])) as OsuPlayableBeatmap;
    const tick = (p.hitObjects.find(h => h instanceof Slider && h.ticks.length > 0) as Slider).ticks[0] as SliderTick;
    const t = OsuModHidden.fadeOutParameters(tick);
    const d = Math.min(tick.timePreempt - 150, 1000);
    expect(t).toEqual({ start: tick.startTime - d, duration: d });
  });

  it('plays a hidden map perfectly with autoplay', () => {
    const r = setup(demoMaps.osuNormal(), ['AT', 'HD']);
    r.step(Math.max(...r.playable.objectTimes.map(t => t.end)) + 1000);
    expect(r.d.hasCompleted).toBe(true);
    expect(r.results.filter(x => x.type !== x.judgement.maxResult && x.judgement.maxResult < 11)).toEqual([]);
  });

  it('a repeat is still a repeat (no SliderRepeat fade parameters of its own)', () => {
    const p = osuRuleset.createPlayable(LegacyBeatmapDecoder.decode(demoMaps.osuNormal()), new ModSet(['HD'])) as OsuPlayableBeatmap;
    const slider = p.hitObjects.find(h => h instanceof Slider && h.repeats.length > 0) as Slider;
    const rep = slider.repeats[0] as SliderRepeat;
    expect(OsuModHidden.fadeOutParameters(rep)).toEqual(OsuModHidden.fadeOutParameters(slider.headCircle));
  });
});

describe('spinners', () => {
  it('SpinnerSpinHistory counts spins in a single direction', () => {
    const h = new SpinnerSpinHistory();
    h.reportDelta(0, 90);
    h.reportDelta(1, -90); // back to 0: no progress lost, nothing gained
    expect(h.totalRotation).toBe(90);
    h.reportDelta(2, -180);
    expect(h.totalRotation).toBe(180);
    for (let i = 0; i < 4; i++) h.reportDelta(3 + i, -90);
    expect(h.totalRotation).toBe(360 + 180);
    // rewinding pops spins completed after the given time
    h.reportDelta(0.5, 10);
    expect(h.totalRotation).toBeLessThan(540);
  });

  it('SpinnerSpmCalculator measures spins per minute over ~595ms', () => {
    const spm = new SpinnerSpmCalculator();
    // 2 spins per second
    for (let t = 0; t <= 2000; t += 10) spm.setRotation((t / 1000) * 720, t);
    expect(spm.result).toBeCloseTo(120, 5);
  });

  it('spinning sample frequency', () => {
    expect(spinningSampleFrequency(0, true)).toBeCloseTo(20000 / 44100, 5);
    expect(spinningSampleFrequency(1, true)).toBeCloseTo(60000 / 44100, 5);
    expect(spinningSampleFrequency(10, true)).toBeCloseTo(100000 / 44100, 5);
    expect(spinningSampleFrequency(0.5, false)).toBe(1);
  });

  it('OsuModSpunOut spins at 1.01 × the required rate, independent of the clock rate', () => {
    const p = osuRuleset.createPlayable(LegacyBeatmapDecoder.decode(MAP), new ModSet()) as OsuPlayableBeatmap;
    const spinner = p.hitObjects.find(h => h instanceof Spinner) as Spinner;
    for (const rate of [1, 1.5, 0.75]) {
      // SpinnerRotationTracker.AddRotation multiplies by the rate.
      let total = 0;
      for (let t = 0; t < spinner.duration; t += 16) total += spunOutRotation(spinner, 16, rate) * rate;
      expect(total / 360).toBeCloseTo(1.01 * spinner.spinsRequired, 1);
    }
  });

  it('completes spinners with Spun Out (no input)', () => {
    const r = setup(MAP, ['SO']);
    r.step(6000);
    expect(byKind(r, 'spinner')[0].type).toBe(HitResult.Great);
  });
});

describe('Relax / Autopilot', () => {
  /** Moves the cursor onto the currently relevant object (like a player aiming), without any presses. */
  function aim(r: Run, end: number, offset = { x: 0, y: 0 }) {
    const objs = r.playable.hitObjects;
    const W = 512;
    const H = 384;
    // without a render call the screen transform is the identity.
    for (let t = r.time(); t < end; t += 1000 / 60) {
      const target: OsuHitObject = objs.find(h => h.endTime >= t) ?? objs[objs.length - 1];
      let p = target.stackedPosition;
      if (target instanceof Slider && t >= target.startTime) p = target.stackedPositionAt(Math.min(1, (t - target.startTime) / target.duration));
      if (target instanceof Spinner) {
        const a = t / 20;
        p = { x: W / 2 + Math.cos(a) * 60, y: H / 2 + Math.sin(a) * 60 };
      }
      r.d.onPointerMove!(p.x + offset.x, p.y + offset.y, t);
      r.step(t + 1000 / 60);
    }
  }

  it('Relax hits objects under the cursor', () => {
    const r = setup(MAP, ['RX']);
    aim(r, 9000);
    console.log(JSON.stringify(r.results.map(x => [x.tag, x.type, Math.round(x.at)])));
    expect(byKind(r, 'circle')[0].type).toBe(HitResult.Great);
    expect(isHit(byKind(r, 'sliderHead')[0].type)).toBe(true);
    expect(byKind(r, 'sliderTail')[0].type).toBe(HitResult.SliderTailHit);
    expect(byKind(r, 'spinner')[0].type).toBe(HitResult.Great);
  });

  it('Relax only presses when the cursor is over the object', () => {
    const r = setup(MAP, ['RX']);
    aim(r, 2600, { x: 200, y: 200 });
    expect(byKind(r, 'circle')[0].type).toBe(HitResult.Miss);
    expect(byKind(r, 'sliderHead')[0].type).toBe(HitResult.Miss);
  });

  it('Relax ignores user presses', () => {
    const r = setup(MAP, ['RX']);
    r.d.onPointerMove!(0, 0, -1000);
    r.step(999);
    r.d.onPressed('LeftButton', 1000);
    r.step(1500);
    expect(byKind(r, 'circle')[0].type).toBe(HitResult.Miss);
  });

  it('Autopilot moves the cursor; the user clicks', () => {
    const r = setup(demoMaps.osuNormal(), ['AP']);
    const objs = r.playable.hitObjects;
    let key: 'LeftButton' | 'RightButton' = 'LeftButton';
    for (const h of objs) {
      r.step(h.startTime);
      r.d.onPointerMove!(0, 0, h.startTime); // ignored: AllowUserCursorMovement = false
      r.d.onPressed(key, h.startTime);
      r.step(h.endTime + 20);
      r.d.onReleased(key, h.endTime + 20);
      key = key === 'LeftButton' ? 'RightButton' : 'LeftButton';
    }
    r.step(Math.max(...r.playable.objectTimes.map(t => t.end)) + 1000);
    const circles = r.results.filter(x => x.tag === 'circle');
    expect(circles.length).toBeGreaterThan(10);
    expect(circles.filter(x => x.type === HitResult.Great).length).toBe(circles.length);
  });
});

describe('OsuModFlashlight', () => {
  it('shrinks with combo at stable speed and grows during breaks', () => {
    const fl = new OsuFlashlight();
    fl.update(0, 0, false);
    expect(fl.sizeAt(0)).toBe(125);
    fl.update(1000, 100, false);
    // 125 → 101.5625 at (0.1875 / 1.875) * 1000 = 100ms
    expect(fl.sizeAt(1050)).toBeCloseTo((125 + 101.5625) / 2, 3);
    expect(fl.sizeAt(1100)).toBeCloseTo(101.5625, 3);
    fl.update(2000, 200, false);
    expect(fl.sizeAt(5000)).toBeCloseTo(78.125, 3);
    // entering a break: immediately, to 312.5
    fl.update(6000, 200, true);
    expect(fl.sizeAt(6000)).toBeCloseTo(78.125, 3);
    expect(fl.sizeAt(10000)).toBeCloseTo(312.5, 3);
    // exiting a break: delayed by BREAK_FADE_DURATION
    fl.update(20000, 200, false);
    expect(fl.sizeAt(20300)).toBeCloseTo(312.5, 3);
    fl.update(20325, 200, false);
    expect(fl.sizeAt(20325)).toBeCloseTo(312.5, 3);
    expect(fl.sizeAt(25000)).toBeCloseTo(78.125, 3);
  });

  it('BreakTracker.IsBreakTime', () => {
    const breaks = [{ startTime: 10000, endTime: 20000 }, { startTime: 30000, endTime: 30500 }];
    expect(isBreakTime(breaks, 500, 1000, false)).toBe(true); // before gameplay start
    expect(isBreakTime(breaks, 5000, 1000, false)).toBe(false);
    expect(isBreakTime(breaks, 15000, 1000, false)).toBe(true);
    expect(isBreakTime(breaks, 19800, 1000, false)).toBe(false); // break fade
    expect(isBreakTime(breaks, 30200, 1000, false)).toBe(false); // too short to have an effect
    expect(isBreakTime(breaks, 40000, 1000, true)).toBe(true); // completed
  });

  it('dims while a slider is tracked', () => {
    const r = setup(MAP, ['AT', 'FL']);
    const fl = (r.d as unknown as { flashlight: OsuFlashlight }).flashlight;
    r.step(2200);
    expect(fl.dim).toBe(0.8);
    r.step(2700);
    expect(fl.dim).toBe(0);
  });
});
