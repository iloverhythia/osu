// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game.Tests/Beatmaps/Formats/LegacyStoryboardDecoderTest.cs (against osu.Game.Tests/Resources), plus hand-written cases.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Anchor } from '../../src/game/storyboard/Anchor';
import { LegacyStoryboardDecoder } from '../../src/game/storyboard/LegacyStoryboardDecoder';
import {
  AnimationLoopType,
  getEndTime,
  type Storyboard,
  StoryboardAnimation,
  StoryboardElementSource,
  StoryboardSampleInfo,
  StoryboardSprite,
  StoryboardVideo,
} from '../../src/game/storyboard/Storyboard';
import { decodeStoryboard, getMainStoryboardFilename } from '../../src/game/storyboard';

const RESOURCES = resolve(__dirname, '../../../osu.Game.Tests/Resources');
const haveResources = existsSync(RESOURCES);
const resource = (name: string): string => readFileSync(resolve(RESOURCES, name), 'utf8');
/** `new LegacyStoryboardDecoder().Decode(stream)` */
const decodeResource = (name: string): Storyboard => new LegacyStoryboardDecoder().decode(resource(name));
const layerByDepth = (sb: Storyboard, depth: number) => sb.layerList.filter(l => l.depth === depth)[0];

describe.runIf(haveResources)('LegacyStoryboardDecoderTest (C# resources)', () => {
  it('TestDecodeStoryboardEvents', () => {
    const storyboard = decodeResource("Himeringo - Yotsuya-san ni Yoroshiku (RLC) [Winber1's Extreme].osu");

    expect(storyboard.hasDrawable).toBe(true);
    expect(storyboard.layerList.length).toBe(6);

    const background = layerByDepth(storyboard, 3);
    expect(background.elements.length).toBe(16);
    expect(background.visibleWhenFailing).toBe(true);
    expect(background.visibleWhenPassing).toBe(true);
    expect(background.name).toBe('Background');

    const fail = layerByDepth(storyboard, 2);
    expect(fail.elements.length).toBe(0);
    expect(fail.visibleWhenFailing).toBe(true);
    expect(fail.visibleWhenPassing).toBe(false);
    expect(fail.name).toBe('Fail');

    const pass = layerByDepth(storyboard, 1);
    expect(pass.elements.length).toBe(0);
    expect(pass.visibleWhenFailing).toBe(false);
    expect(pass.visibleWhenPassing).toBe(true);
    expect(pass.name).toBe('Pass');

    const foreground = layerByDepth(storyboard, 0);
    expect(foreground.elements.length).toBe(151);
    expect(foreground.visibleWhenFailing).toBe(true);
    expect(foreground.visibleWhenPassing).toBe(true);
    expect(foreground.name).toBe('Foreground');

    const overlay = layerByDepth(storyboard, -2147483648);
    expect(overlay.elements).toHaveLength(0);
    expect(overlay.visibleWhenFailing).toBe(true);
    expect(overlay.visibleWhenPassing).toBe(true);
    expect(overlay.name).toBe('Overlay');

    const spriteCount = background.elements.filter(x => x.constructor === StoryboardSprite).length;
    const animationCount = background.elements.filter(x => x.constructor === StoryboardAnimation).length;
    const sampleCount = background.elements.filter(x => x.constructor === StoryboardSampleInfo).length;

    expect(spriteCount).toBe(15);
    expect(animationCount).toBe(1);
    expect(sampleCount).toBe(0);
    expect(background.elements.length).toBe(spriteCount + animationCount + sampleCount);

    const sprite = background.elements[0] as StoryboardSprite;
    expect(sprite).toBeInstanceOf(StoryboardSprite);
    expect(sprite.hasCommands).toBe(true);
    expect(sprite.initialPosition).toEqual({ x: 320, y: 240 });
    expect(sprite.isDrawable).toBe(true);
    expect(sprite.origin).toBe(Anchor.Centre);
    expect(sprite.path).toBe('SB/lyric/ja-21.png');

    const animation = background.elements.find(e => e instanceof StoryboardAnimation) as StoryboardAnimation;
    expect(animation).toBeDefined();
    expect(animation.endTime).toBe(141175);
    expect(animation.frameCount).toBe(10);
    expect(animation.frameDelay).toBe(30);
    expect(animation.hasCommands).toBe(true);
    expect(animation.initialPosition).toEqual({ x: 320, y: 240 });
    expect(animation.isDrawable).toBe(true);
    expect(animation.loopType).toBe(AnimationLoopType.LoopForever);
    expect(animation.origin).toBe(Anchor.Centre);
    expect(animation.path).toBe('SB/red jitter/red_0000.jpg');
    expect(animation.startTime).toBe(78993);
  });

  it('TestLoopWithoutExplicitFadeOut', () => {
    const storyboard = decodeResource('animation-loop-no-explicit-end-time.osb');
    const background = layerByDepth(storyboard, 3);
    expect(background.elements.length).toBe(1);
    const anim = background.elements[0] as StoryboardAnimation;
    expect(anim.startTime).toBe(2000);
    expect(anim.earliestTransformTime).toBe(2000);
    expect(getEndTime(anim)).toBe(3000);
    expect(anim.endTimeForDisplay).toBe(12000);
  });

  it('TestCorrectAnimationStartTime', () => {
    const storyboard = decodeResource('animation-starts-before-alpha.osb');
    const background = layerByDepth(storyboard, 3);
    expect(background.elements.length).toBe(1);
    expect(background.elements[0].startTime).toBe(2000);
    // This property should be used in DrawableStoryboardAnimation as a starting point for animation playback.
    expect((background.elements[0] as StoryboardAnimation).earliestTransformTime).toBe(1000);
  });

  it('TestNoopFadeTransformIsIgnoredForLifetime', () => {
    const storyboard = decodeResource('noop-fade-transform-is-ignored-for-lifetime.osb');
    const background = layerByDepth(storyboard, 3);
    expect(background.elements.length).toBe(2);
    expect(background.elements[0].startTime).toBe(1500);
    expect(background.elements[1].startTime).toBe(1500);
  });

  it('TestOutOfOrderStartTimes', () => {
    const storyboard = decodeResource('out-of-order-starttimes.osb');
    const background = layerByDepth(storyboard, 3);
    expect(background.elements.length).toBe(2);
    expect(background.elements[0].startTime).toBe(1500);
    expect(background.elements[1].startTime).toBe(1000);
    expect(storyboard.earliestEventTime).toBe(1000);
  });

  it('TestEarliestStartTimeWithLoopAlphas', () => {
    const storyboard = decodeResource('loop-containing-earlier-non-zero-fade.osb');
    const background = layerByDepth(storyboard, 3);
    expect(background.elements.length).toBe(2);
    expect(background.elements[0].startTime).toBe(1000);
    expect(background.elements[1].startTime).toBe(1000);
    expect(storyboard.earliestEventTime).toBe(1000);
  });

  it('TestDecodeVariableWithSuffix', () => {
    const storyboard = decodeResource('variable-with-suffix.osb');
    const background = layerByDepth(storyboard, 3);
    expect(background.elements).toHaveLength(1);
    expect((background.elements[0] as StoryboardSprite).initialPosition.x).toBe(3456);
  });

  it('TestDecodeSelfReferencingVariableDoesNotHang', () => {
    const storyboard = decodeResource('variable-with-self-reference.osb');
    const background = layerByDepth(storyboard, 3);
    expect(background.elements).toHaveLength(1);
    expect((background.elements[0] as StoryboardSprite).initialPosition.x).toBe(320);
  });

  it('TestDecodeVideoWithLowercaseExtension', () => {
    const storyboard = decodeResource('video-with-lowercase-extension.osb');
    const video = storyboard.layerList.filter(l => l.name === 'Video')[0];
    expect(video.elements.length).toBe(1);
    expect((video.elements[0] as StoryboardVideo).path).toBe('Video.avi');
  });

  it('TestDecodeVideoWithUppercaseExtension', () => {
    const storyboard = decodeResource('video-with-uppercase-extension.osb');
    const video = storyboard.layerList.filter(l => l.name === 'Video')[0];
    expect(video.elements.length).toBe(1);
    expect((video.elements[0] as StoryboardVideo).path).toBe('Video.AVI');
  });

  it('TestDecodeImageSpecifiedAsVideo', () => {
    const storyboard = decodeResource('image-specified-as-video.osb');
    const video = storyboard.layerList.filter(l => l.name === 'Video')[0];
    expect(video.elements.length).toBe(0);
  });

  it('TestDecodeOutOfRangeLoopAnimationType', () => {
    const storyboard = decodeResource('animation-types.osb');
    const foreground = layerByDepth(storyboard, 0);
    const types = foreground.elements.map(e => (e as StoryboardAnimation).loopType);
    expect(types).toEqual([
      AnimationLoopType.LoopForever,
      AnimationLoopType.LoopOnce,
      AnimationLoopType.LoopForever,
      AnimationLoopType.LoopOnce,
      AnimationLoopType.LoopForever,
      AnimationLoopType.LoopForever,
    ]);
  });

  it('TestDecodeLoopCount', () => {
    // all loop sequences in loop-count.osb have a total duration of 2000ms (fade in 0->1000ms, fade out 1000->2000ms).
    const loop_duration = 2000;
    const storyboard = decodeResource('loop-count.osb');
    const background = layerByDepth(storyboard, 3);
    const byPath = (p: string) => background.elements.filter(e => e instanceof StoryboardSprite && e.path === p)[0] as StoryboardSprite;

    // stable ensures that any loop command executes at least once, even if the loop count specified in the .osb is zero or negative.
    expect(byPath('zero-times.png').endTime).toBe(1000 + loop_duration);
    expect(byPath('one-time.png').endTime).toBe(4000 + loop_duration);
    // It is intentional that we don't consider the loop count (40) as part of the end time calculation to match stable's handling.
    expect(byPath('many-times.png').endTime).toBe(9000 + loop_duration);
  });

  it('TestVideoWithCustomFadeIn', () => {
    const storyboard = decodeResource('video-custom-alpha-transform.osb');
    const elements = storyboard.getLayer('Video').elements;
    expect(elements).toHaveLength(1);
    expect(elements[0]).toBeInstanceOf(StoryboardVideo);
    expect(elements[0].startTime).toBe(-5678);
    const video = elements[0] as StoryboardVideo;
    expect(video.commands.Alpha).toHaveLength(1);
    expect(video.commands.Alpha[0].startTime).toBe(1500);
    expect(video.commands.Alpha[0].endTime).toBe(1600);
    expect(storyboard.earliestEventTime).toBeNull();
    expect(storyboard.latestEventTime).toBeNull();
  });

  it('TestVideoAndBackgroundEventsDoNotAffectStoryboardBounds', () => {
    const storyboard = decodeResource('video-background-events-ignored.osb');
    const elements = storyboard.getLayer('Video').elements;
    expect(elements).toHaveLength(1);
    expect(elements[0]).toBeInstanceOf(StoryboardVideo);
    expect(elements[0].startTime).toBe(-5678);
    expect(storyboard.earliestEventTime).toBeNull();
    expect(storyboard.latestEventTime).toBeNull();
  });
});

describe('LegacyStoryboardDecoder (hand-written)', () => {
  it('substitutes variables once per definition, in definition order', () => {
    const sb = LegacyStoryboardDecoder.decode(`[Variables]
$x=100
$xy=999
$c=$x
$pathvar="sb/a.png"

[Events]
Sprite,Foreground,Centre,$pathvar,$x,$xy
Sprite,Foreground,Centre,$pathvar,$x,240
 MX,0,0,1000,$x,200
Sprite,Foreground,Centre,"c.png",$c,240
`);
    const elements = sb.getLayer('Foreground').elements;
    // "$xy" contains "$x", which is substituted first (definition order) → "100y" fails to parse, dropping the line (as in lazer).
    // "$c" becomes "$x", which is not substituted again (single pass) → the line fails too.
    expect(elements).toHaveLength(1);
    const s = elements[0] as StoryboardSprite;
    expect(s.path).toBe('sb/a.png');
    expect(s.initialPosition.x).toBe(100);
    expect(s.commands.X[0].startValue).toBe(100);
  });

  it('applies commands to the right groups by indentation depth (spaces or underscores)', () => {
    const sb = LegacyStoryboardDecoder.decode(`[Events]
Sprite,Background,TopLeft,"bg.png",0,0
 F,0,0,1000,0,1
 L,2000,3
  M,0,0,500,0,0,100,100
 _S,0,0,,2
 T,HitSoundClap,1000,5000
  F,0,0,100,1,0
_R,0,0,1000,0,3.14159265
`);
    const s = sb.getLayer('Background').elements[0] as StoryboardSprite;
    expect(s.commands.Alpha).toHaveLength(1);
    expect(s.loopingGroups).toHaveLength(1);
    const loop = s.loopingGroups[0];
    expect(loop.totalIterations).toBe(3);
    expect(loop.X).toHaveLength(1);
    expect(loop.X[0].startTime).toBe(2000);
    expect(loop.X[0].endTime).toBe(2500);
    // "_S" at depth 2 continues the loop group
    expect(loop.Scale).toHaveLength(1);
    expect(s.triggerGroups).toHaveLength(1);
    expect(s.triggerGroups[0].triggerName).toBe('HitSoundClap');
    expect(s.triggerGroups[0].triggerStartTime).toBe(1000);
    expect(s.triggerGroups[0].triggerEndTime).toBe(5000);
    expect(s.triggerGroups[0].Alpha).toHaveLength(1);
    // depth 1 goes back to the sprite's own commands; radians are converted to degrees
    expect(s.commands.Rotation).toHaveLength(1);
    expect(s.commands.Rotation[0].endValue).toBeCloseTo(180, 3);
    expect(s.startTime).toBe(0);
    expect(s.endTime).toBe(2500);
    expect(s.endTimeForDisplay).toBe(2000 + 500 * 3);
  });

  it('defaults trigger times and negates the group number', () => {
    const sb = LegacyStoryboardDecoder.decode(`[Events]
Sprite,Foreground,Centre,"a.png",320,240
 F,0,0,0,1
 T,Passing
  F,0,0,100,1,0
 T,Failing,0,1000,2
  F,0,0,100,1,0
`);
    const s = sb.getLayer('Foreground').elements[0] as StoryboardSprite;
    expect(s.triggerGroups[0].triggerStartTime).toBe(-Number.MAX_VALUE);
    expect(s.triggerGroups[0].triggerEndTime).toBe(Number.MAX_VALUE);
    expect(s.triggerGroups[0].groupNumber).toBe(0);
    expect(s.triggerGroups[1].groupNumber).toBe(-2);
  });

  it('parses all command types with their value shorthands', () => {
    const sb = LegacyStoryboardDecoder.decode(`[Events]
Sprite,Foreground,Centre,"a.png",320,240
 F,1,100,200,0.5
 S,2,100,200,1,2
 V,3,100,200,1,2
 V,3,300,400,1,2,3,4
 R,4,100,200,1
 M,5,100,200,10,20
 MX,6,100,200,30,40
 MY,7,100,200,50
 C,8,100,200,255,128,0
 C,8,300,,255,255,255,0,0,0
 P,0,100,200,A
 P,0,300,300,H
 P,0,400,500,V
 P,0,400,500,X
`);
    const s = sb.getLayer('Foreground').elements[0] as StoryboardSprite;
    const c = s.commands;
    expect(c.Alpha[0]).toMatchObject({ easing: 1, startTime: 100, endTime: 200, startValue: 0.5, endValue: 0.5 });
    expect(c.Scale[0]).toMatchObject({ easing: 2, startValue: 1, endValue: 2 });
    expect(c.VectorScale[0].startValue).toEqual({ x: 1, y: 2 });
    expect(c.VectorScale[0].endValue).toEqual({ x: 1, y: 2 });
    expect(c.VectorScale[1].endValue).toEqual({ x: 3, y: 4 });
    expect(c.Rotation[0].startValue).toBeCloseTo(57.29578, 4);
    // M adds both X and Y; MX/MY only one
    expect(c.X.map(x => [x.startValue, x.endValue])).toEqual([
      [10, 10],
      [30, 40],
    ]);
    expect(c.Y.map(y => [y.startValue, y.endValue])).toEqual([
      [20, 20],
      [50, 50],
    ]);
    expect(c.Colour[0].startValue).toEqual({ r: 1, g: Math.fround(128 / 255), b: 0 });
    // empty end time means "same as start time"
    expect(c.Colour[1]).toMatchObject({ startTime: 300, endTime: 300 });
    expect(c.Colour[1].endValue).toEqual({ r: 0, g: 0, b: 0 });
    // P,A with a duration is additive only during it; P,H with zero duration is permanent
    expect(c.Blending[0]).toMatchObject({ startValue: 'Additive', endValue: 'Inherit' });
    expect(c.FlipH[0]).toMatchObject({ startValue: true, endValue: true });
    expect(c.FlipV[0]).toMatchObject({ startValue: true, endValue: false });
  });

  it('assigns layers (by name and number) and origins, including the legacy Custom quirk', () => {
    const sb = LegacyStoryboardDecoder.decode(`[Events]
Sprite,0,TopLeft,"a.png",0,0
 F,0,0,1,1
Sprite,Fail,1,"b.png",0,0
 F,0,0,1,1
Sprite,Pass,Custom,"c.png",0,0
 F,0,0,1,1
Sprite,3,BottomRight,"d.png",0,0
 F,0,0,1,1
Sprite,Overlay,CentreLeft,"e.png",0,0
 F,0,0,1,1
Sprite,Video,TopCentre,"f.png",0,0
 F,0,0,1,1
Sprite,7,6,"g.png",0,0
 F,0,0,1,1
Sprite,Foreground,BottomCentre,"h.png",0,0
Sprite,Foreground,Nope,"i.png",0,0
`);
    const first = (layer: string) => sb.getLayer(layer).elements[0] as StoryboardSprite;
    expect(first('Background').origin).toBe(Anchor.TopLeft);
    expect(first('Fail').origin).toBe(Anchor.Centre);
    expect(first('Pass').origin).toBe(Anchor.TopLeft); // Custom → TopLeft
    expect(first('Foreground').origin).toBe(Anchor.BottomRight);
    expect(first('Overlay').origin).toBe(Anchor.CentreLeft);
    expect(first('Video').origin).toBe(Anchor.TopCentre);
    // an undefined numeric layer creates a new layer in front of Foreground (below Overlay)
    const custom = sb.getLayer('7');
    expect(custom.depth).toBe(-1);
    expect((custom.elements[0] as StoryboardSprite).origin).toBe(Anchor.TopLeft);
    // a sprite without commands is not drawable; an invalid origin drops the line
    expect(sb.getLayer('Foreground').elements).toHaveLength(2);
    expect((sb.getLayer('Foreground').elements[1] as StoryboardSprite).isDrawable).toBe(false);
  });

  it('decodes animations, samples, videos and General settings', () => {
    const sb = new LegacyStoryboardDecoder(14).decode(
      `osu file format v14

[General]
WidescreenStoryboard: 1

[Events]
0,0,"bg.jpg",10,20
Video,1000,"intro.mp4"
Video,0,"bg2.png"
Animation,Foreground,Centre,"sb/anim.v2.png",320,240,4,100,LoopOnce
 F,0,0,1000,1
Sample,500,0,"sb/hit.wav",60
Sample,600,Overlay,"sb\\\\boom.ogg"
2,1000,2000
`,
      `[General]
UseSkinSprites: 1
`,
    );
    expect(sb.widescreenStoryboard).toBe(true);
    expect(sb.useSkinSprites).toBe(true);
    expect(sb.backgroundOffset).toEqual({ x: 10, y: 20 });
    const video = sb.getLayer('Video').elements;
    expect(video).toHaveLength(1);
    expect(video[0]).toBeInstanceOf(StoryboardVideo);
    expect(video[0].startTime).toBe(1000);
    expect(video[0].isDrawable).toBe(true);
    expect(video[0].source).toBe(StoryboardElementSource.Beatmap);

    const anim = sb.getLayer('Foreground').elements[0] as StoryboardAnimation;
    expect(anim.frameCount).toBe(4);
    expect(anim.frameDelay).toBe(100);
    expect(anim.loopType).toBe(AnimationLoopType.LoopOnce);
    // every "." is replaced (string.Replace)
    expect(anim.getFramePath(2)).toBe('sb/anim2.v22.png');

    const sample = sb.getLayer('Background').elements[0] as StoryboardSampleInfo;
    expect(sample).toBeInstanceOf(StoryboardSampleInfo);
    expect(sample).toMatchObject({ startTime: 500, volume: 60, path: 'sb/hit.wav' });
    expect(sample.lookupNames).toEqual(['sb/hit.wav', 'sb/hit']);
    const sample2 = sb.getLayer('Overlay').elements[0] as StoryboardSampleInfo;
    expect(sample2).toMatchObject({ volume: 100, path: 'sb/boom.ogg' });
  });

  it('uses the stable frame delay formula for format versions < 6', () => {
    const text = `osu file format v5

[Events]
Animation,Foreground,Centre,"a.png",320,240,2,100
 F,0,0,1000,1
`;
    const anim = LegacyStoryboardDecoder.decode(text).getLayer('Foreground').elements[0] as StoryboardAnimation;
    // Math.Round(0.015 * 100) = Math.Round(1.5) = 2 (banker's rounding), * 1.186 * (1000 / 60f)
    expect(anim.frameDelay).toBeCloseTo(2 * 1.186 * Math.fround(1000 / 60), 10);
    const anim2 = LegacyStoryboardDecoder.decode(text.replace(',100', ',166.7')).getLayer('Foreground').elements[0] as StoryboardAnimation;
    // Math.Round(2.5005) = 3
    expect(anim2.frameDelay).toBeCloseTo(3 * 1.186 * Math.fround(1000 / 60), 10);
    const anim3 = LegacyStoryboardDecoder.decode(text.replace(',100', ',166.66666666666666')).getLayer('Foreground').elements[0] as StoryboardAnimation;
    // 0.015 * 166.666… = 2.5 → Math.Round(2.5) = 2 (to even)
    expect(anim3.frameDelay).toBeCloseTo(2 * 1.186 * Math.fround(1000 / 60), 10);
  });

  it('marks .osb elements as Shared and keeps decoder state (variables) across streams', () => {
    const sb = decodeStoryboard(
      `osu file format v14

[Events]
Sprite,Foreground,Centre,"bg.jpg",320,240
 F,0,0,1000,1
`,
      `[Variables]
$v=1
[Events]
Sprite,Background,Centre,"BG.JPG",320,240
 F,0,0,1000,$v
`,
      'bg.jpg',
    );
    expect(sb.getLayer('Foreground').elements[0].source).toBe(StoryboardElementSource.Beatmap);
    expect(sb.getLayer('Background').elements[0].source).toBe(StoryboardElementSource.Shared);
    // Storyboard.ReplacesBackground: the background file is used (case-insensitively) by an element of the Background layer.
    expect(sb.replacesBackground).toBe(true);
    expect(decodeStoryboard('[Events]\nSprite,Foreground,Centre,"bg.jpg",320,240\n F,0,0,1,1\n', null, 'bg.jpg').replacesBackground).toBe(false);
  });

  it('skips comments and logs invalid lines without aborting', () => {
    const decoder = new LegacyStoryboardDecoder();
    const sb = decoder.decode(`[Events]
// a comment
Sprite,Foreground,Centre,"a.png",320,240 // trailing comment
 F,0,0,1000,1
 Q,0,0,1000,1
 F,0,0
Bogus,1,2
Sprite,Foreground,Centre,"b.png",320,240
 F,0,500,1000,1
`);
    expect(sb.getLayer('Foreground').elements.map(e => e.path)).toEqual(['a.png', 'b.png']);
    expect(decoder.warnings.length).toBe(3);
  });

  it('builds the main storyboard filename like stable', () => {
    expect(getMainStoryboardFilename({ artist: 'Artist', title: 'Ti/tle?', audioFile: 'audio.mp3', creator: 'Map:per' })).toBe('Artist - Title (Mapper).osb');
    expect(getMainStoryboardFilename({ artist: '', title: 'x', audioFile: 'song.mp3', creator: '' })).toBe('song.osb');
  });
});
