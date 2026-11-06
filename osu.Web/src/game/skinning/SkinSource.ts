// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of the lookup behaviour of ISkinSource / SkinProvidingContainer (first source providing a lookup wins),
// LegacySkinExtensions (GetAnimation, GetTextures, fonts), SkinnableTextureAnimation timing, and
// LegacySkinTransformer.GetSample (LayeredHitSounds).

import type { HitSampleInfo } from '../audio/HitSampleInfo';
import { DEFAULT_COMBO_COLOURS, type RGB, type Skin } from '../Skin';
import type { Colour4 } from './LegacySkinDecoder';
import { parseConfigBool, parseConfigFloat, parseConfigInt, type LoadedSkin } from './LegacySkin';
import { withMaximumSize, type SkinTexture } from './SkinTexture';

/** LegacySkinExtensions.SIXTY_FRAME_TIME: the frame length of each frame at a 60 FPS rate (default for legacy skin animations). */
export const SIXTY_FRAME_TIME = 1000 / 60;

export enum LegacyFont {
  Score,
  Combo,
  HitCircle,
  ScoreEntry,
}

/** A legacy animation (osu-framework TextureAnimation): frames shown for `frameLength` ms each. */
export class SkinAnimation {
  constructor(
    readonly frames: SkinTexture[],
    public frameLength: number,
    readonly loop: boolean,
  ) {}

  get frameCount(): number {
    return this.frames.length;
  }

  get duration(): number {
    return this.frames.length * this.frameLength;
  }

  /** The frame displayed `elapsed` ms after the animation's start time. */
  frameAt(elapsed: number): SkinTexture {
    const n = this.frames.length;
    if (n === 1 || !(this.frameLength > 0) || !Number.isFinite(elapsed)) return this.frames[0];
    let position = elapsed;
    if (this.loop) position = ((position % this.duration) + this.duration) % this.duration;
    const index = Math.floor(position / this.frameLength);
    return this.frames[Math.max(0, Math.min(n - 1, index))];
  }
}

export interface MaxSize {
  width: number;
  height: number;
}

/** A chain of skins, highest priority first (beatmap skin, then user skin). */
export class SkinSource {
  constructor(readonly sources: readonly LoadedSkin[]) {}

  get isEmpty(): boolean {
    return this.sources.length === 0;
  }

  /** A source containing only the given skin (lookups made on a single ISkin, e.g. from within a skin transformer). */
  only(skin: LoadedSkin): SkinSource {
    return new SkinSource([skin]);
  }

  /** ISkinSource.FindProvider */
  findProvider(predicate: (s: LoadedSkin) => boolean): LoadedSkin | null {
    for (const s of this.sources) if (predicate(s)) return s;
    return null;
  }

  /** First skin providing the given texture, as a single-skin source. */
  providerOf(textureName: string): SkinSource | null {
    const p = this.findProvider(s => s.getSkinTexture(textureName) != null);
    return p ? this.only(p) : null;
  }

  getTexture(name: string, maxSize?: MaxSize): SkinTexture | null {
    for (const s of this.sources) {
      const t = s.getSkinTexture(name);
      if (t) return maxSize ? withMaximumSize(t, maxSize.width, maxSize.height) : t;
    }
    return null;
  }

  hasTexture(name: string): boolean {
    return this.sources.some(s => s.getSkinTexture(name) != null);
  }

  /** LegacySkinExtensions.GetTextures */
  getTextures(componentName: string, animatable: boolean, animationSeparator = '-', maxSize?: MaxSize): { textures: SkinTexture[]; source: SkinSource | null } {
    if (this.sources.length === 0) return { textures: [], source: null };
    const frameName = (i: number) => `${componentName}${animationSeparator}${i}`;

    // find the first source which provides either the animated or non-animated version.
    const provider =
      this.findProvider(s => {
        if (animatable && s.getSkinTexture(frameName(0)) != null) return true;
        return s.getSkinTexture(componentName) != null;
      }) ?? null;
    const retrievalSource = provider ? this.only(provider) : this;

    if (animatable) {
      const textures: SkinTexture[] = [];
      for (let i = 0; ; i++) {
        const t = retrievalSource.getTexture(frameName(i), maxSize);
        if (!t) break;
        textures.push(t);
      }
      if (textures.length > 0) return { textures, source: retrievalSource };
    }

    // if an animation was not allowed or not found, fall back to a sprite retrieval.
    const single = retrievalSource.getTexture(componentName, maxSize);
    return { textures: single ? [single] : [], source: retrievalSource };
  }

  /** LegacySkinExtensions.GetAnimation */
  getAnimation(
    componentName: string,
    animatable: boolean,
    looping: boolean,
    applyConfigFrameRate = false,
    animationSeparator = '-',
    frameLength?: number,
    maxSize?: MaxSize,
  ): SkinAnimation | null {
    const { textures, source } = this.getTextures(componentName, animatable, animationSeparator, maxSize);
    switch (textures.length) {
      case 0:
        return null;
      case 1:
        return new SkinAnimation(textures, 0, false);
      default:
        return new SkinAnimation(textures, frameLength ?? getFrameLength(source ?? this, applyConfigFrameRate, textures), looping);
    }
  }

  // ------------------------------------------------------------------------------------------------ configuration

  /** Generic string lookup (first source with the key). */
  getString(key: string): string | null {
    for (const s of this.sources) {
      const v = s.lookup(key);
      if (v !== undefined) return v;
    }
    return null;
  }

  /** Generic bool lookup; a value which fails to parse counts as a miss for that source (as LegacySkin.genericLookup returns null). */
  getBool(key: string): boolean | null {
    for (const s of this.sources) {
      const v = parseConfigBool(s.lookup(key));
      if (v != null) return v;
    }
    return null;
  }

  getFloat(key: string): number | null {
    for (const s of this.sources) {
      const v = parseConfigFloat(s.lookup(key));
      if (v != null) return v;
    }
    return null;
  }

  getInt(key: string): number | null {
    for (const s of this.sources) {
      const v = parseConfigInt(s.lookup(key));
      if (v != null) return v;
    }
    return null;
  }

  /** SkinConfiguration.LegacySetting.Version (beatmap skins don't provide one). */
  get version(): number | null {
    for (const s of this.sources) {
      const v = s.legacyVersion;
      if (v != null) return v;
    }
    return null;
  }

  /** SkinCustomColourLookup / OsuSkinColour lookups. */
  customColour(name: string): Colour4 | null {
    for (const s of this.sources) {
      const c = s.customColour(name);
      if (c) return c;
    }
    return null;
  }

  /** GlobalSkinColours.ComboColours */
  get comboColours(): readonly Colour4[] | null {
    for (const s of this.sources) {
      const c = s.comboColours;
      if (c) return c;
    }
    return null;
  }

  // ------------------------------------------------------------------------------------------------ fonts

  /** LegacySkinExtensions.GetFontPrefix */
  getFontPrefix(font: LegacyFont): string {
    switch (font) {
      case LegacyFont.ScoreEntry:
        return 'scoreentry';
      case LegacyFont.Score:
        return this.getString('ScorePrefix') ?? 'score';
      case LegacyFont.Combo:
        return this.getString('ComboPrefix') ?? 'score';
      case LegacyFont.HitCircle:
        return this.getString('HitCirclePrefix') ?? 'default';
    }
  }

  /** LegacySkinExtensions.GetFontOverlap: a positive number brings the number sprites closer together. */
  getFontOverlap(font: LegacyFont): number {
    switch (font) {
      case LegacyFont.ScoreEntry:
        return 1;
      case LegacyFont.Score:
        return this.getFloat('ScoreOverlap') ?? 0;
      case LegacyFont.Combo:
        return this.getFloat('ComboOverlap') ?? 0;
      case LegacyFont.HitCircle:
        return this.getFloat('HitCircleOverlap') ?? -2;
    }
  }

  /** LegacySkinExtensions.HasFont */
  hasFont(font: LegacyFont): boolean {
    return this.getTexture(`${this.getFontPrefix(font)}-0`) != null;
  }

  /** First skin which has the font, as a single-skin source. */
  fontProvider(font: LegacyFont): SkinSource | null {
    const p = this.findProvider(s => this.only(s).hasFont(font));
    return p ? this.only(p) : null;
  }
}

/** LegacySkinExtensions.getFrameLength */
function getFrameLength(source: SkinSource, applyConfigFrameRate: boolean, textures: SkinTexture[]): number {
  if (applyConfigFrameRate) {
    const iniRate = source.getInt('AnimationFramerate');
    if (iniRate != null && iniRate > 0) return Math.fround(1000 / iniRate);
    return Math.fround(1000 / textures.length);
  }
  return SIXTY_FRAME_TIME;
}

/** LegacySpriteText.LegacyGlyphStore.getLookupName */
function glyphLookupName(c: string): string {
  switch (c) {
    case ',':
      return 'comma';
    case '.':
      return 'dot';
    case '%':
      return 'percent';
    case '':
      return 'pp';
    default:
      return c;
  }
}

/** A laid-out LegacySpriteText: glyph textures with their x offsets. */
export interface LegacyText {
  glyphs: { texture: SkinTexture; x: number }[];
  width: number;
  height: number;
}

/** LegacySpriteText layout (glyph advance = texture display width, Spacing = -overlap, UseFullGlyphHeight = false). */
export function layoutLegacyText(source: SkinSource, font: LegacyFont, text: string, maxSizePerGlyph?: MaxSize, fixedWidth = false): LegacyText | null {
  const prefix = source.getFontPrefix(font);
  const spacing = -source.getFontOverlap(font);
  const glyphs: { texture: SkinTexture; x: number }[] = [];
  let x = 0;
  let height = 0;
  let fixed = 0;
  if (fixedWidth) {
    const ref = source.getTexture(`${prefix}-5`, maxSizePerGlyph);
    fixed = ref ? ref.sw / ref.scaleAdjust : 0;
  }
  for (const c of text) {
    const t = source.getTexture(`${prefix}-${glyphLookupName(c)}`, maxSizePerGlyph);
    if (!t) continue;
    if (glyphs.length > 0) x += spacing;
    const w = t.sw / t.scaleAdjust;
    const excluded = c === ',' || c === '.' || c === '%' || c === 'x' || c === '';
    const advance = fixedWidth && !excluded ? fixed : w;
    glyphs.push({ texture: t, x: x + (advance - w) / 2 });
    x += advance;
    height = Math.max(height, t.sh / t.scaleAdjust);
  }
  if (glyphs.length === 0) return null;
  return { glyphs, width: x, height };
}

/** Draws laid-out legacy text with the given origin (0..1) at (x, y), scaled. */
export function drawLegacyText(
  g: CanvasRenderingContext2D,
  text: LegacyText,
  x: number,
  y: number,
  scale: number,
  originX = 0.5,
  originY = 0.5,
  alpha = 1,
): void {
  if (alpha <= 0 || scale === 0) return;
  const prev = g.globalAlpha;
  g.globalAlpha = prev * alpha;
  const left = x - text.width * scale * originX;
  const top = y - text.height * scale * originY;
  for (const glyph of text.glyphs) {
    const t = glyph.texture;
    g.drawImage(t.image, t.sx, t.sy, t.sw, t.sh, left + glyph.x * scale, top, (t.sw / t.scaleAdjust) * scale, (t.sh / t.scaleAdjust) * scale);
  }
  g.globalAlpha = prev;
}

// ------------------------------------------------------------------------------------------------ samples & colours

/**
 * Resolves a hit sample through the skins (beatmap skin, then user skin), as LegacySkinTransformer.GetSample + LegacySkin.GetSample do:
 * a layered hitsound is silenced when a skin has "LayeredHitSounds: 0". Returns null if no skin provides the sample.
 * Pass `rulesetPrefix = 'taiko-'` for osu!taiko (TaikoLegacySkinTransformer.LegacyTaikoSampleInfo).
 */
export function resolveSkinHitSample(
  skins: readonly LoadedSkin[],
  info: HitSampleInfo,
  silent: () => AudioBuffer | null = defaultSilent,
  rulesetPrefix?: string,
): AudioBuffer | null {
  for (const skin of skins) {
    if (info.isLayered && parseConfigBool(skin.lookup('LayeredHitSounds')) === false) return silent();
    const s = skin.getHitSample(info, rulesetPrefix);
    if (s) return s;
  }
  return null;
}

let silentBuffer: AudioBuffer | null = null;
function defaultSilent(): AudioBuffer | null {
  if (!silentBuffer && typeof AudioBuffer !== 'undefined') silentBuffer = new AudioBuffer({ length: 1, sampleRate: 44100 });
  return silentBuffer;
}

/**
 * The combo colours in effect: beatmap colours (if the beatmap has any) take priority, then the skins' combo colours
 * (a user skin without any falls back to SkinConfiguration.DefaultComboColours), then the default skin's.
 */
export function resolveComboColours(skin: Skin): RGB[] {
  if (skin.comboColours !== DEFAULT_COMBO_COLOURS) return skin.comboColours;
  const src = new SkinSource(skin.sources ?? []);
  const c = src.comboColours;
  if (c && c.length > 0) return c.map(x => [x[0], x[1], x[2]] as RGB);
  return skin.comboColours;
}

export const toRGB = (c: Colour4): RGB => [c[0], c[1], c[2]];

const comboColourCache = new WeakMap<Skin, RGB[]>();

/** The combo colour for an index, using {@link resolveComboColours} (cached per Skin). */
export function skinComboColour(skin: Skin, index: number): RGB {
  let colours = comboColourCache.get(skin);
  if (!colours) comboColourCache.set(skin, (colours = resolveComboColours(skin)));
  return colours[((index % colours.length) + colours.length) % colours.length];
}
