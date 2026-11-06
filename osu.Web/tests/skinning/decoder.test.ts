// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Ports of osu.Game.Tests/Skins/LegacySkinDecoderTest.cs and LegacyManiaSkinDecoderTest.cs (using the same test resources).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SKIN_COMBO_COLOURS, LegacyManiaSkinDecoder, LegacySkinDecoder, SkinConfiguration } from '../../src/game/skinning/LegacySkinDecoder';

const RESOURCES = resolve(__dirname, '../../../osu.Game.Tests/Resources');
const resource = (name: string) => readFileSync(resolve(RESOURCES, name), 'utf8');

describe('LegacySkinDecoder', () => {
  it('decodes skin colours', () => {
    const comboColors = new LegacySkinDecoder().decode(resource('skin.ini')).comboColours;
    expect(comboColors).toEqual([
      [142, 199, 255, 255],
      [255, 128, 128, 255],
      [128, 255, 255, 255],
      [100, 100, 100, 255], // alpha is specified as 100, but should be ignored.
    ]);
  });

  it('decodes empty skin colours to the defaults', () => {
    const comboColors = new LegacySkinDecoder().decode(resource('skin-empty.ini')).comboColours;
    expect(comboColors).toEqual(DEFAULT_SKIN_COMBO_COLOURS);
  });

  it('returns no combo colours when default fallback is disallowed', () => {
    const config = new LegacySkinDecoder().decode(resource('skin-empty.ini'));
    config.allowDefaultComboColoursFallback = false;
    expect(config.comboColours).toBeNull();
  });

  it('decodes general', () => {
    const config = new LegacySkinDecoder().decode(resource('skin.ini'));
    expect(config.skinInfo.name).toBe('test skin');
    expect(config.configDictionary.get('TestLookup')).toBe('TestValue');
  });

  it('decodes specified version', () => {
    expect(new LegacySkinDecoder().decode(resource('skin-20.ini')).legacyVersion).toBe(2.0);
  });

  it('strips whitespace', () => {
    expect(new LegacySkinDecoder().decode(resource('skin-with-space.ini')).legacyVersion).toBe(2.0);
  });

  it('decodes latest version', () => {
    expect(new LegacySkinDecoder().decode(resource('skin-latest.ini')).legacyVersion).toBe(SkinConfiguration.LATEST_VERSION);
  });

  it('decodes no version as 1.0', () => {
    expect(new LegacySkinDecoder().decode(resource('skin-empty.ini')).legacyVersion).toBe(1.0);
    // TestSceneSkinConfigurationLookup.TestIniWithNoVersionFallsBackTo1
    expect(new LegacySkinDecoder().decode('').legacyVersion).toBe(1.0);
  });

  it('parses sections, comments, custom colours and catch colours', () => {
    const config = new LegacySkinDecoder().decode(
      [
        '// a comment',
        '[General]',
        'Name: My Skin // trailing comment',
        'Author:someone',
        'AllowSliderBallTint: 1',
        'CursorRotate: 0',
        '[Colours]',
        'SliderBorder: 255, 0, 0',
        'SliderTrackOverride : 0,0,0',
        'Combo9: 1,2,3', // not a combo colour index (1..8) -> custom colour
        'Combo2: 4,5,6',
        'Broken: 1,2',
        '[Fonts]',
        'HitCirclePrefix: fonts\\num',
        'HitCircleOverlap: 3',
        '[CatchTheBeat]',
        'HyperDash: 255,0,0,128',
        '[Mania]',
        'Keys: 4',
        '[Unknown]',
        'Thing: 1',
      ].join('\r\n'),
    );
    expect(config.skinInfo.name).toBe('My Skin');
    expect(config.skinInfo.creator).toBe('someone');
    expect(config.configDictionary.get('AllowSliderBallTint')).toBe('1');
    expect(config.configDictionary.get('HitCirclePrefix')).toBe('fonts\\num');
    expect(config.configDictionary.get('HitCircleOverlap')).toBe('3');
    expect(config.configDictionary.has('Name')).toBe(false);
    expect(config.customColours.get('SliderBorder')).toEqual([255, 0, 0, 255]);
    expect(config.customColours.get('SliderTrackOverride')).toEqual([0, 0, 0, 255]);
    expect(config.customColours.get('Combo9')).toEqual([1, 2, 3, 255]);
    expect(config.customColours.has('Broken')).toBe(false);
    expect(config.customComboColours).toEqual([[4, 5, 6, 255]]);
    // [CatchTheBeat] colours allow alpha and are not put in the config dictionary.
    expect(config.customColours.get('HyperDash')).toEqual([255, 0, 0, 128]);
    expect(config.configDictionary.has('HyperDash')).toBe(false);
    // Mania lines and unknown sections (parsed as General) also land in the dictionary, as in lazer.
    expect(config.configDictionary.get('Keys')).toBe('4');
    expect(config.configDictionary.get('Thing')).toBe('1');
  });
});

describe('LegacyManiaSkinDecoder', () => {
  const decode = (name: string) => new LegacyManiaSkinDecoder().decode(resource(name));

  it('parses a single config', () => {
    const configs = decode('mania-skin-single.ini');
    expect(configs.length).toBe(1);
    expect(configs[0].keys).toBe(4);
    expect(configs[0].columnWidth).toEqual([16, 16, 16, 16]);
    expect(configs[0].hitPosition).toBe(16);
  });

  it('parses multiple configs', () => {
    const configs = decode('mania-skin-multiple.ini');
    expect(configs.length).toBe(2);
    expect(configs[0].keys).toBe(4);
    expect(configs[0].columnWidth).toEqual([16, 16, 16, 16]);
    expect(configs[0].hitPosition).toBe(16);
    expect(configs[1].keys).toBe(2);
    expect(configs[1].columnWidth).toEqual([32, 32]);
    expect(configs[1].hitPosition).toBe(32);
  });

  it('ignores duplicate configs', () => {
    const configs = decode('mania-skin-duplicate.ini');
    expect(configs.length).toBe(1);
    expect(configs[0].keys).toBe(4);
    expect(configs[0].columnWidth).toEqual([16, 16, 16, 16]);
    expect(configs[0].hitPosition).toBe(16);
  });

  it('ignores unnecessary extra data', () => {
    const configs = decode('mania-skin-extra-data.ini');
    expect(configs.length).toBe(1);
    expect(configs[0].columnWidth).toEqual([16, 16, 16, 16]);
    expect(configs[0].hitPosition).toBe(16);
  });

  it('parses colours', () => {
    const configs = decode('mania-skin-colours.ini');
    expect(configs.length).toBe(1);
    expect(configs[0].customColours.get('ColourBarline')).toEqual([50, 50, 50, 50]);
  });

  it('falls back minimum column width when zero is provided', () => {
    const configs = decode('mania-skin-zero-minwidth.ini');
    expect(configs.length).toBe(1);
    expect(configs[0].minimumColumnWidth).toBe(16);
  });

  it('parses arrays with some empty elements as zero', () => {
    const configs = decode('mania-skin-broken-array.ini');
    expect(configs.length).toBe(1);
    expect(configs[0].columnLineWidth.length).toBe(5);
    expect(configs[0].columnLineWidth).toEqual([3, 0, 3, 3, 3]);
  });

  it('holds lines until Keys and handles image lookups / defaults', () => {
    const [c] = new LegacyManiaSkinDecoder().decode(['[Mania]', 'NoteImage0: notes/n1', 'Keys: 7', 'HitPosition: 100', 'NoteBodyStyle: 2', 'LightFramePerSecond: 0', 'Hit300g: hits/300g@2x'].join('\n'));
    expect(c.keys).toBe(7);
    expect(c.imageLookups.get('NoteImage0')).toBe('notes/n1');
    expect(c.imageLookups.get('Hit300g')).toBe('hits/300g@2x');
    // clamped to 240..480
    expect(c.hitPosition).toBe(Math.fround(240 * Math.fround(1.6)));
    expect(c.noteBodyStyle).toBe(2);
    expect(c.lightFramePerSecond).toBe(24);
    expect(c.columnSpacing.length).toBe(6);
    expect(c.columnLineWidth).toEqual(new Array(8).fill(2));
  });
});
