// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Texture (@2x / extensions / case-insensitivity), animation, sample and config lookup rules of LegacySkin,
// LegacyBeatmapSkin and LegacySkinExtensions, plus SkinImporter metadata rules.

import { describe, expect, it } from 'vitest';
import { HitSampleInfo } from '../../src/game/audio/HitSampleInfo';
import { LegacyBeatmapSkin, LegacySkin, legacyLookupNames, type SkinResourceDecoder } from '../../src/game/skinning/LegacySkin';
import { LegacyFont, SkinSource, SIXTY_FRAME_TIME, layoutLegacyText, resolveSkinHitSample, resolveComboColours } from '../../src/game/skinning/SkinSource';
import { displayWidth, withMaximumSize } from '../../src/game/skinning/SkinTexture';
import { createSkin, DEFAULT_COMBO_COLOURS } from '../../src/game/Skin';
import { getCommonPrefix, importedSkinMetadata, shortenFilenames } from '../../src/game/skinning';

/** Image blobs contain "WxH"; audio blobs contain their own name. */
const fakeDecoder: SkinResourceDecoder = {
  async decodeImage(blob, path) {
    const text = await blob.text();
    const m = /^(\d+)x(\d+)$/.exec(text);
    if (!m) return null;
    return { image: { path } as unknown as CanvasImageSource, width: +m[1], height: +m[2] };
  },
  async decodeAudio(data) {
    const text = new TextDecoder().decode(data);
    if (text === 'broken') return null;
    return { name: text } as unknown as AudioBuffer;
  },
  silentSample: () => ({ name: 'silent' }) as unknown as AudioBuffer,
};

const img = (w: number, h: number) => new Blob([`${w}x${h}`]);
const snd = (name: string) => new Blob([name]);
const nameOf = (b: AudioBuffer | null) => (b as unknown as { name: string } | null)?.name ?? null;
const pathOf = (t: { image: CanvasImageSource } | null) => (t?.image as unknown as { path: string } | undefined)?.path ?? null;

async function userSkin(files: Record<string, Blob>, ini?: string): Promise<LegacySkin> {
  if (ini != null) files = { ...files, 'skin.ini': new Blob([ini]) };
  return LegacySkin.load('test', files, fakeDecoder);
}

describe('LegacySkin textures', () => {
  it('prefers @2x textures with a scale adjust of 2', async () => {
    const skin = await userSkin({ 'hitcircle.png': img(128, 128), 'hitcircle@2x.png': img(256, 256), 'approachcircle.png': img(126, 126) });
    const hc = skin.getSkinTexture('hitcircle')!;
    expect(pathOf(hc)).toBe('hitcircle@2x.png');
    expect(hc.scaleAdjust).toBe(2);
    expect(displayWidth(hc)).toBe(128);
    const ac = skin.getSkinTexture('approachcircle')!;
    expect(ac.scaleAdjust).toBe(1);
    expect(displayWidth(ac)).toBe(126);
  });

  it('is case-insensitive, supports jpg, folders with backslashes and strips @2x from lookups', async () => {
    const skin = await userSkin({ 'HitCircleOverlay.PNG': img(10, 10), 'Fonts/Num-1@2X.png': img(40, 60), 'cursor.jpg': img(20, 20) });
    expect(pathOf(skin.getSkinTexture('hitcircleoverlay'))).toBe('hitcircleoverlay.png');
    expect(skin.getSkinTexture('fonts\\num-1')!.scaleAdjust).toBe(2);
    expect(pathOf(skin.getSkinTexture('cursor'))).toBe('cursor.jpg');
    // stable strips "@2x" from component names
    expect(pathOf(skin.getSkinTexture('fonts/num-1@2x'))).toBe('fonts/num-1@2x.png');
    expect(skin.getSkinTexture('missing')).toBeNull();
  });

  it('falls back to the 1x texture when the @2x one is undecodable', async () => {
    const skin = await userSkin({ 'lighting@2x.png': new Blob(['garbage']), 'lighting.png': img(64, 64) });
    // the 1x texture is decoded lazily (skipped during preload because an @2x exists)
    expect(skin.getSkinTexture('lighting')).toBeNull();
    await skin.whenIdle();
    const t = skin.getSkinTexture('lighting')!;
    expect(pathOf(t)).toBe('lighting.png');
    expect(t.scaleAdjust).toBe(1);
  });

  it('beatmap skins never use @2x textures', async () => {
    const skin = await LegacyBeatmapSkin.loadBeatmap('map', { 'hitcircle@2x.png': img(256, 256), 'hitcircle.png': img(128, 128) }, fakeDecoder);
    const t = skin.getSkinTexture('hitcircle')!;
    expect(pathOf(t)).toBe('hitcircle.png');
    expect(t.scaleAdjust).toBe(1);
    const only2x = await LegacyBeatmapSkin.loadBeatmap('map', { 'sliderb@2x.png': img(256, 256) }, fakeDecoder);
    expect(only2x.getSkinTexture('sliderb')).toBeNull();
  });

  it('WithMaximumSize crops oversized textures around their centre', async () => {
    const skin = await userSkin({ 'sliderb@2x.png': img(1000, 200) });
    const t = withMaximumSize(skin.getSkinTexture('sliderb')!, 384, 384);
    expect(t.sw).toBe(768);
    expect(t.sh).toBe(200);
    expect(t.sx).toBe(116);
    expect(t.scaleAdjust).toBe(2);
  });
});

describe('LegacySkinExtensions.GetAnimation', () => {
  it('finds "name-N" frames and uses 60fps frame length', async () => {
    const src = new SkinSource([await userSkin({ 'hit300-0.png': img(10, 10), 'hit300-1.png': img(10, 10), 'hit300-2.png': img(10, 10), 'hit300.png': img(5, 5) })]);
    const anim = src.getAnimation('hit300', true, false)!;
    expect(anim.frameCount).toBe(3);
    expect(anim.frameLength).toBe(SIXTY_FRAME_TIME);
    expect(pathOf(anim.frameAt(0))).toBe('hit300-0.png');
    expect(pathOf(anim.frameAt(SIXTY_FRAME_TIME * 1.5))).toBe('hit300-1.png');
    // not looping: stays on the last frame
    expect(pathOf(anim.frameAt(10000))).toBe('hit300-2.png');
    // not animatable: single sprite
    expect(src.getAnimation('hit300', false, false)!.frameCount).toBe(1);
  });

  it('applies AnimationFramerate, or spreads frames over one second', async () => {
    const files = { 'followpoint-0.png': img(10, 10), 'followpoint-1.png': img(10, 10), 'followpoint-2.png': img(10, 10), 'followpoint-3.png': img(10, 10) };
    const withRate = new SkinSource([await userSkin(files, '[General]\nAnimationFramerate: 20')]);
    expect(withRate.getAnimation('followpoint', true, true, true)!.frameLength).toBeCloseTo(50);
    const noRate = new SkinSource([await userSkin(files)]);
    const anim = noRate.getAnimation('followpoint', true, true, true)!;
    expect(anim.frameLength).toBeCloseTo(250);
    // looping
    expect(pathOf(anim.frameAt(1000 + 260))).toBe('followpoint-1.png');
  });

  it('uses the first provider of either the animated or single texture', async () => {
    const beatmap = await LegacyBeatmapSkin.loadBeatmap('map', { 'hit0.png': img(10, 10) }, fakeDecoder);
    const user = await userSkin({ 'hit0-0.png': img(10, 10), 'hit0-1.png': img(10, 10) });
    const anim = new SkinSource([beatmap, user]).getAnimation('hit0', true, false)!;
    expect(anim.frameCount).toBe(1);
    expect(pathOf(anim.frames[0])).toBe('hit0.png');
  });

  it('sliderb frames use an empty separator', async () => {
    const src = new SkinSource([await userSkin({ 'sliderb0.png': img(10, 10), 'sliderb1.png': img(10, 10) })]);
    expect(src.getTextures('sliderb', true, '').textures.length).toBe(2);
  });
});

describe('LegacySkin samples', () => {
  it('looks up wav, mp3 then ogg and strips the "Gameplay/" prefix', async () => {
    const skin = await userSkin({ 'normal-hitnormal.ogg': snd('ogg'), 'normal-hitnormal.mp3': snd('mp3'), 'soft-hitclap.wav': snd('clap') });
    expect(nameOf(skin.getSample('normal-hitnormal'))).toBe('mp3');
    expect(nameOf(skin.getSample('Gameplay/soft-hitclap'))).toBe('clap');
    expect(skin.getSample('drum-hitclap')).toBeNull();
  });

  it('returns a silent sample for files which exist but cannot be decoded', async () => {
    const skin = await userSkin({ 'normal-hitwhistle.wav': new Blob([]), 'normal-hitfinish.wav': snd('broken') });
    expect(nameOf(skin.getSample('normal-hitwhistle'))).toBe('silent');
    expect(nameOf(skin.getSample('normal-hitfinish'))).toBe('silent');
  });

  it('user skins never use custom sample bank suffixes, but fall back to universal samples', async () => {
    const info = new HitSampleInfo({ name: 'hitclap', bank: 'soft', customSampleBank: 2 });
    expect(legacyLookupNames(info, false)).toEqual(['Gameplay/soft-hitclap', 'soft-hitclap', 'Gameplay/hitclap', 'hitclap', 'hitclap']);
    expect(legacyLookupNames(info, true)).toEqual(['Gameplay/soft-hitclap2', 'soft-hitclap2', 'hitclap']);

    const skin = await userSkin({ 'soft-hitclap2.wav': snd('custom'), 'hitclap.wav': snd('universal') });
    expect(nameOf(skin.getHitSample(info))).toBe('universal');
    const skin2 = await userSkin({ 'soft-hitclap2.wav': snd('custom'), 'soft-hitclap.wav': snd('bank') });
    expect(nameOf(skin2.getHitSample(info))).toBe('bank');
  });

  it('beatmap skins only provide samples with a custom sample bank', async () => {
    const beatmap = new LegacyBeatmapSkin('map', {}, fakeDecoder, null);
    expect(beatmap.getHitSample(new HitSampleInfo({ name: 'hitnormal', customSampleBank: 0 }))).toBeNull();
    expect(beatmap.getSample('normal-hitnormal')).toBeNull();
  });

  it('LayeredHitSounds: 0 silences layered samples', async () => {
    const skin = await userSkin({ 'normal-hitnormal.wav': snd('n') }, '[General]\nLayeredHitSounds: 0');
    const layered = new HitSampleInfo({ name: 'hitnormal', isLayered: true });
    expect(nameOf(resolveSkinHitSample([skin], layered, () => ({ name: 'silent' }) as unknown as AudioBuffer))).toBe('silent');
    expect(nameOf(resolveSkinHitSample([skin], new HitSampleInfo({ name: 'hitnormal' })))).toBe('n');
  });
});

describe('LegacySkin configuration', () => {
  it('parses bools as stable does (0/1/2, true/false)', async () => {
    const src = (v: string) => userSkin({}, `[General]\nAllowSliderBallTint: ${v}`).then(s => new SkinSource([s]));
    expect((await src('0')).getBool('AllowSliderBallTint')).toBe(false);
    expect((await src('1')).getBool('AllowSliderBallTint')).toBe(true);
    expect((await src('2')).getBool('AllowSliderBallTint')).toBe(true);
    expect((await src('True')).getBool('AllowSliderBallTint')).toBe(true);
    expect((await src('yes')).getBool('AllowSliderBallTint')).toBeNull();
  });

  it('parses floats and versions; beatmap skins fall back to the user skin version', async () => {
    const user = await userSkin({}, '[General]\nVersion: 2.3\n[Fonts]\nHitCircleOverlap: 1.1');
    const beatmap = new LegacyBeatmapSkin('map', {}, fakeDecoder, '[General]\nVersion: 1');
    const src = new SkinSource([beatmap, user]);
    expect(src.version).toBe(2.3);
    expect(src.getFontOverlap(LegacyFont.HitCircle)).toBe(Math.fround(1.1));
    expect(new SkinSource([await userSkin({})]).version).toBe(2.7); // no skin.ini: latest
    expect(new SkinSource([await userSkin({}, '')]).version).toBe(1.0);
    expect(new SkinSource([]).version).toBeNull();
  });

  it('beatmap combo colours take priority, then the user skin', async () => {
    const user = await userSkin({}, '[Colours]\nCombo1: 1,2,3\nCombo2: 4,5,6');
    expect(resolveComboColours(createSkin(null, undefined, [user]))).toEqual([
      [1, 2, 3],
      [4, 5, 6],
    ]);
    expect(resolveComboColours(createSkin([[9, 9, 9]], undefined, [user]))).toEqual([[9, 9, 9]]);
    expect(resolveComboColours(createSkin(null))).toBe(DEFAULT_COMBO_COLOURS);
    // beatmap skins don't fall back to the default list
    const beatmap = new LegacyBeatmapSkin('map', {}, fakeDecoder, '');
    expect(beatmap.comboColours).toBeNull();
  });

  it('lays out hitcircle numbers with HitCirclePrefix and HitCircleOverlap', async () => {
    const files: Record<string, Blob> = {};
    for (let i = 0; i < 10; i++) files[`nums/n-${i}@2x.png`] = img(40, 52);
    const src = new SkinSource([await userSkin(files, '[Fonts]\nHitCirclePrefix: nums\\n\nHitCircleOverlap: 4')]);
    expect(src.hasFont(LegacyFont.HitCircle)).toBe(true);
    const text = layoutLegacyText(src, LegacyFont.HitCircle, '12')!;
    expect(text.glyphs.length).toBe(2);
    expect(text.width).toBe(20 + 20 - 4);
    expect(text.height).toBe(26);
  });

  it('mania configurations are created on demand, but never for beatmap skins', async () => {
    const user = await userSkin({}, '[Mania]\nKeys: 4\nColumnWidth: 10,10,10,10');
    expect(user.maniaConfig(4)!.columnWidth).toEqual([16, 16, 16, 16]);
    expect(user.maniaConfig(7)!.columnWidth.length).toBe(7);
    expect(new LegacyBeatmapSkin('map', {}, fakeDecoder, '[Mania]\nKeys: 4').maniaConfig(4)).toBeNull();
  });
});

describe('SkinImporter rules', () => {
  it('strips a common folder prefix only when it ends with a separator', () => {
    expect(getCommonPrefix(['Skin/a.png', 'Skin/b.png'])).toBe('Skin/');
    expect(shortenFilenames(['Skin/a.png', 'Skin/b.png']).map(f => f.shortened)).toEqual(['a.png', 'b.png']);
    expect(shortenFilenames(['a.png', 'b.png']).map(f => f.shortened)).toEqual(['a.png', 'b.png']);
    expect(() => shortenFilenames(['A.png', 'a.PNG'])).toThrow();
  });

  it('uses skin.ini metadata and appends the archive name when it differs', () => {
    expect(importedSkinMetadata('Cool.osk', null)).toEqual({ name: 'Cool', creator: 'Unknown' });
    expect(importedSkinMetadata('Cool.osk', '[General]\nName: Cool\nAuthor: me')).toEqual({ name: 'Cool', creator: 'me' });
    expect(importedSkinMetadata('Cool v2.osk', '[General]\nName: Cool\nAuthor: me')).toEqual({ name: 'Cool [Cool v2]', creator: 'me' });
    // lazer exports use "Name (Creator)" as the filename
    expect(importedSkinMetadata('Cool (me).osk', '[General]\nName: Cool\nAuthor: me')).toEqual({ name: 'Cool', creator: 'me' });
  });
});

describe('ruleset sample prefixes', () => {
  it('taiko lookups insert "taiko-" before the last path component and keep the universal fallback', async () => {
    const info = new HitSampleInfo({ name: 'hitclap', bank: 'drum' });
    expect(legacyLookupNames(info, false, 'taiko-')).toEqual(['Gameplay/taiko-drum-hitclap', 'taiko-drum-hitclap', 'Gameplay/taiko-hitclap', 'taiko-hitclap', 'hitclap']);
    const skin = await userSkin({ 'drum-hitclap.wav': snd('plain'), 'taiko-drum-hitclap.wav': snd('taiko') });
    expect(nameOf(resolveSkinHitSample([skin], info, undefined, 'taiko-'))).toBe('taiko');
    expect(nameOf(resolveSkinHitSample([skin], info))).toBe('plain');
  });
});
