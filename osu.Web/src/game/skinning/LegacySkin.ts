// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game/Skinning/LegacySkin.cs (texture / sample / configuration lookups), the file lookup rules of
// Skin.cs + RealmBackedResourceStore (case-insensitive, standardised paths, png/jpg and wav/mp3/ogg extensions),
// LegacyTextureLoaderStore (grayscale taiko sprites), MaxDimensionLimitedTextureLoaderStore, and LegacyBeatmapSkin.cs.
//
// Everything a skin provides must be available synchronously during gameplay, so images and samples are decoded
// when the skin is loaded (see `preload`). Images which are never used by gameplay (menus, ranking screen...) are
// decoded lazily on first lookup instead, to keep memory usage down.

import type { HitSampleInfo } from '../audio/HitSampleInfo';
import { LegacyManiaSkinConfiguration, LegacyManiaSkinDecoder, LegacySkinDecoder, SkinConfiguration, tryParseBool, parseFloatStrict, parseIntStrict, type Colour4 } from './LegacySkinDecoder';
import { createTexture, type SkinTexture } from './SkinTexture';

export interface DecodedImage {
  image: CanvasImageSource;
  width: number;
  height: number;
}

/** Platform services used to decode skin resources (injectable for tests). */
export interface SkinResourceDecoder {
  decodeImage(blob: Blob, path: string): Promise<DecodedImage | null>;
  decodeAudio(data: ArrayBuffer): Promise<AudioBuffer | null>;
  /** A silent sample, returned for sample files which exist but can't be decoded (e.g. the 0-byte files used to mute hitsounds). */
  silentSample(): AudioBuffer | null;
}

/** A loaded user skin (.osk) or beatmap skin: textures, samples and skin.ini configuration. */
export interface LoadedSkin {
  readonly name: string;
  /** Texture by lookup name without extension (e.g. "hitcircle", "default-1"); handles @2x internally. */
  getTexture(name: string): CanvasImageSource | null;
  /** Hit sample by lookup name (e.g. "normal-hitnormal"). */
  getSample(name: string): AudioBuffer | null;
  /** skin.ini value, e.g. getConfig('General', 'AllowSliderBallTint'). */
  getConfig(section: string, key: string): string | undefined;

  // ---- additions (port of the rest of LegacySkin's lookup surface)

  /** Whether this is a LegacyBeatmapSkin (elements provided by the beatmap set's folder). */
  readonly isBeatmapSkin: boolean;
  readonly configuration: SkinConfiguration;
  /** LegacySkin.GetTexture: the texture with its ScaleAdjust (2 for "@2x" files). */
  getSkinTexture(name: string): SkinTexture | null;
  /** Raw value from the skin.ini config dictionary (all sections, last one wins, as in lazer's ConfigDictionary). */
  lookup(key: string): string | undefined;
  /** LegacySetting.Version (null for beatmap skins, which ignore versioning). */
  readonly legacyVersion: number | null;
  /** GlobalSkinColours.ComboColours: skin.ini combo colours, the default list, or null (beatmap skins). */
  readonly comboColours: readonly Colour4[] | null;
  /** SkinCustomColourLookup (e.g. "SliderBorder", "SliderTrackOverride", "SliderBall", "SpinnerBackground"). */
  customColour(name: string): Colour4 | null;
  /** LegacyManiaSkinConfigurationLookup source: the [Mania] configuration for a key count (null for beatmap skins). */
  maniaConfig(keys: number): LegacyManiaSkinConfiguration | null;
  /** LegacySkin.GetSample for a hit sample (bank / custom sample bank / universal fallbacks). */
  getHitSample(info: HitSampleInfo): AudioBuffer | null;
}

const IMAGE_EXTENSIONS = ['png', 'jpg'];
// osu-stable performs audio lookups in order of wav -> mp3 -> ogg.
const AUDIO_EXTENSIONS = ['wav', 'mp3', 'ogg'];
const MAX_SAMPLE_FILE_SIZE = 4 * 1024 * 1024;

// https://github.com/peppy/osu-stable-reference/blob/013c3010a9d495e3471a9c59518de17006f9ad89/osu!/Graphics/Textures/TextureManager.cs#L91-L96
export const GRAYSCALE_SPRITES = ['taiko-bar-right', 'taikobigcircle', 'taikohitcircle', 'taikohitcircleoverlay'];

/** LegacyTextureLoaderStore.shouldConvertToGrayscale (by file name without extension). */
export function shouldConvertToGrayscale(path: string): boolean {
  const name = stripExtension(path.split('/').pop() ?? path).toLowerCase();
  return GRAYSCALE_SPRITES.some(s => name === s || name === `${s}@2x`);
}

/** Elements never used during gameplay; decoded lazily (on first lookup) instead of when the skin loads. */
const LAZY_ELEMENTS = /^(menu-|welcome|ranking-|pause-|fail-background|selection-|button-|mode-|options-|play-skip|play-unranked|section-|inputoverlay-|scorebar-|count[123]$|go$|ready$|arrow-|star$|comboburst|masking-border|multi-|lobby-|songselect|scoreentry-|recordscreen|loading)/;

/** Elements a beatmap may provide (LegacyBeatmapSkin); other images in a beatmap set (backgrounds, storyboards) are decoded lazily. */
const BEATMAP_SKIN_ELEMENTS =
  /^(hitcircle|approachcircle|sliderstartcircle|sliderendcircle|reversearrow|sliderb|sliderfollowcircle|sliderscorepoint|sliderpoint|followpoint|spinner-|cursor|lighting|hit0|hit50|hit100|hit300|particle|slidertickmiss|sliderendmiss|default-|fruit-|taiko|pippidon|mania-|lane|star2)/;

/** ToStandardisedPath + lower-casing, as used by RealmBackedResourceStore's file mapping. */
export function standardisePath(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase();
}

function stripExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/** Path.GetExtension (including the dot), or '' */
export function getExtension(path: string): string {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const dot = path.lastIndexOf('.');
  return dot > slash && dot >= 0 ? path.slice(dot) : '';
}

/** Path.ChangeExtension(path, null) */
export function removeExtension(path: string): string {
  const ext = getExtension(path);
  return ext ? path.slice(0, path.length - ext.length) : path;
}

/** The name LegacySkin.GetTexture looks up first when high resolution sprites are allowed (e.g. "hitcircle@2x"). */
export function highResolutionName(componentName: string): string {
  return `${removeExtension(componentName)}@2x${getExtension(componentName)}`;
}

export class LegacySkin implements LoadedSkin {
  readonly isBeatmapSkin: boolean = false;

  /** Whether high-resolution textures ("@2x"-suffixed) are allowed to be used by GetTexture when available. */
  protected readonly allowHighResolutionSprites: boolean = true;

  /**
   * Whether this skin can use samples with a custom bank (custom sample set in stable terminology).
   * Added in order to match sample lookup logic from stable (in stable, only the beatmap skin could use samples with a custom sample bank).
   */
  protected readonly useCustomSampleBanks: boolean = false;

  protected readonly allowManiaConfigLookups: boolean = true;

  configuration: SkinConfiguration;
  readonly maniaConfigurations = new Map<number, LegacyManiaSkinConfiguration>();

  /** Files by standardised lower-case path. */
  private readonly files = new Map<string, Blob>();
  private readonly images = new Map<string, DecodedImage | null>();
  private readonly pendingImages = new Map<string, Promise<void>>();
  private readonly textures = new Map<string, SkinTexture | null>();
  private readonly samples = new Map<string, AudioBuffer | null>();

  constructor(
    readonly name: string,
    files: Record<string, Blob>,
    protected readonly decoder: SkinResourceDecoder,
    configurationText: string | null,
  ) {
    for (const [path, blob] of Object.entries(files)) this.files.set(standardisePath(path), blob);

    if (configurationText != null) {
      this.configuration = new LegacySkinDecoder().decode(configurationText);
      // LegacySkin.ParseConfigurationStream also decodes the mania configurations from the same stream.
      for (const config of new LegacyManiaSkinDecoder().decode(configurationText)) this.maniaConfigurations.set(config.keys, config);
    } else {
      this.configuration = new SkinConfiguration();
      // generally won't be hit as we always write a `skin.ini` on import, but best be safe than sorry.
      this.configuration.legacyVersion = SkinConfiguration.LATEST_VERSION;
      this.configuration.isLatestVersion = true;
    }
  }

  /** Creates a user skin from its files (reads "skin.ini" if present) and decodes its resources. */
  static async load(name: string, files: Record<string, Blob>, decoder: SkinResourceDecoder): Promise<LegacySkin> {
    const ini = findBlob(files, 'skin.ini');
    const skin = new LegacySkin(name, files, decoder, ini ? await ini.text() : null);
    await skin.preload();
    return skin;
  }

  /** Whether a file exists (case-insensitive). */
  hasFile(path: string): boolean {
    return this.files.has(standardisePath(path));
  }

  get fileNames(): string[] {
    return [...this.files.keys()];
  }

  // ------------------------------------------------------------------------------------------------ preloading

  /** Whether an image file should be decoded up-front. */
  protected shouldPreloadImage(path: string): boolean {
    const base = stripExtension(path.split('/').pop()!);
    if (LAZY_ELEMENTS.test(base)) return false;
    if (this.allowHighResolutionSprites) {
      // When an @2x version exists, the 1x version is never looked up.
      if (!base.endsWith('@2x') && IMAGE_EXTENSIONS.some(e => this.files.has(`${stripExtension(path)}@2x.${e}`))) return false;
    } else if (base.endsWith('@2x')) return false;
    return true;
  }

  protected shouldPreloadSample(path: string, blob: Blob): boolean {
    return blob.size <= MAX_SAMPLE_FILE_SIZE;
  }

  /** Decodes all gameplay images and samples so lookups can be served synchronously. */
  async preload(): Promise<void> {
    const jobs: Promise<unknown>[] = [];
    for (const [path, blob] of this.files) {
      const ext = path.slice(path.lastIndexOf('.') + 1);
      if (IMAGE_EXTENSIONS.includes(ext)) {
        if (this.shouldPreloadImage(path)) jobs.push(this.decodeImage(path));
      } else if (AUDIO_EXTENSIONS.includes(ext)) {
        if (!this.shouldPreloadSample(path, blob)) continue;
        jobs.push(
          blob
            .arrayBuffer()
            .then(buf => (buf.byteLength > 0 ? this.decoder.decodeAudio(buf) : null))
            .catch(() => null)
            .then(b => void this.samples.set(path, b ?? this.decoder.silentSample())),
        );
      }
    }
    await Promise.all(jobs);
  }

  private decodeImage(path: string): Promise<void> {
    let p = this.pendingImages.get(path);
    if (!p) {
      const blob = this.files.get(path)!;
      p = this.decoder
        .decodeImage(blob, path)
        .catch(() => null)
        .then(img => {
          this.images.set(path, img);
          // invalidate cached lookups which may have missed while this image was loading
          this.textures.clear();
        });
      this.pendingImages.set(path, p);
    }
    return p;
  }

  // ------------------------------------------------------------------------------------------------ textures

  /**
   * TextureStore.Get through the skin's resource store: tries the name as-is, then with each image extension.
   * Returns undefined when no file matches, null when a file matched but couldn't be decoded (yet).
   */
  private textureFromStore(name: string, scaleAdjust: number): SkinTexture | null | undefined {
    const path = standardisePath(name);
    for (const candidate of [path, ...IMAGE_EXTENSIONS.map(e => `${path}.${e}`)]) {
      if (!this.files.has(candidate)) continue;
      const img = this.images.get(candidate);
      if (img === undefined) {
        void this.decodeImage(candidate);
        return null;
      }
      if (img === null) return null;
      return createTexture(img.image, img.width, img.height, scaleAdjust);
    }
    return undefined;
  }

  getSkinTexture(componentName: string): SkinTexture | null {
    const cached = this.textures.get(componentName);
    if (cached !== undefined) return cached;

    let name = componentName;
    switch (name) {
      case 'Menu/fountain-star':
        name = 'star2';
        break;
      case 'Intro/Welcome/welcome_text':
        name = 'welcome_text';
        break;
    }

    let texture: SkinTexture | null | undefined = null;
    let pending = false;

    if (this.allowHighResolutionSprites) {
      // some component names (especially user-controlled ones, like `HitX` in mania)
      // may contain `@2x` scale specifications.
      // stable happens to check for that and strip them, so do the same to match stable behaviour.
      name = name.split('@2x').join('');
      texture = this.textureFromStore(highResolutionName(name), 2);
      if (texture === null && this.isPendingLookup(highResolutionName(name))) pending = true;
    }

    if (!texture) {
      const t = this.textureFromStore(name, 1);
      if (t === null && this.isPendingLookup(name)) pending = true;
      texture = t ?? null;
    }

    if (!pending) this.textures.set(componentName, texture);
    return texture;
  }

  private isPendingLookup(name: string): boolean {
    const path = standardisePath(name);
    for (const candidate of [path, ...IMAGE_EXTENSIONS.map(e => `${path}.${e}`)]) {
      if (!this.files.has(candidate)) continue;
      return !this.images.has(candidate);
    }
    return false;
  }

  getTexture(name: string): CanvasImageSource | null {
    return this.getSkinTexture(name)?.image ?? null;
  }

  /** Resolves when lazily-decoded images requested so far have finished decoding. */
  async whenIdle(): Promise<void> {
    await Promise.all([...this.pendingImages.values()]);
  }

  // ------------------------------------------------------------------------------------------------ samples

  /** Skin.GetSampleFromSkinFiles: the sample store tries the name as-is, then .wav, .mp3, .ogg. */
  protected sampleFromFiles(lookup: string): AudioBuffer | null {
    const path = standardisePath(lookup);
    for (const candidate of [path, ...AUDIO_EXTENSIONS.map(e => `${path}.${e}`)]) {
      if (!this.files.has(candidate)) continue;
      const s = this.samples.get(candidate);
      if (s !== undefined) return s;
      // Files which exist but weren't decoded (too large) are treated as unavailable.
    }
    return null;
  }

  getSample(name: string): AudioBuffer | null {
    // LegacySkin.getFallbackSampleNames
    for (const lookup of getFallbackSampleNames(name)) {
      const s = this.sampleFromFiles(lookup);
      if (s) return s;
    }
    return null;
  }

  getHitSample(info: HitSampleInfo): AudioBuffer | null {
    for (const lookup of legacyLookupNames(info, this.useCustomSampleBanks)) {
      const s = this.sampleFromFiles(lookup);
      if (s) return s;
    }
    return null;
  }

  // ------------------------------------------------------------------------------------------------ configuration

  getConfig(section: string, key: string): string | undefined {
    return this.configuration.sections.get(section)?.get(key);
  }

  lookup(key: string): string | undefined {
    return this.configuration.configDictionary.get(key);
  }

  get legacyVersion(): number | null {
    return this.configuration.legacyVersion ?? SkinConfiguration.LATEST_VERSION;
  }

  get comboColours(): readonly Colour4[] | null {
    return this.configuration.comboColours;
  }

  customColour(name: string): Colour4 | null {
    return this.configuration.customColours.get(name) ?? null;
  }

  maniaConfig(keys: number): LegacyManiaSkinConfiguration | null {
    if (!this.allowManiaConfigLookups) return null;
    let existing = this.maniaConfigurations.get(keys);
    if (!existing) {
      try {
        this.maniaConfigurations.set(keys, (existing = new LegacyManiaSkinConfiguration(keys)));
      } catch {
        return null;
      }
    }
    return existing;
  }
}

/** Port of LegacyBeatmapSkin: the skin elements found in a beatmap set's folder, configured by the beatmap (.osu) itself. */
export class LegacyBeatmapSkin extends LegacySkin {
  readonly isBeatmapSkin = true;
  protected readonly allowManiaConfigLookups = false;
  protected readonly useCustomSampleBanks = true;

  // matches stable. references:
  //  1. https://github.com/peppy/osu-stable-reference/blob/dc0994645801010d4b628fff5ff79cd3c286ca83/osu!/Graphics/Textures/TextureManager.cs#L115-L137 (beatmap skin textures lookup)
  //  2. https://github.com/peppy/osu-stable-reference/blob/dc0994645801010d4b628fff5ff79cd3c286ca83/osu!/Graphics/Textures/TextureManager.cs#L158-L196 (user skin textures lookup)
  protected readonly allowHighResolutionSprites = false;

  constructor(name: string, files: Record<string, Blob>, decoder: SkinResourceDecoder, beatmapText: string | null) {
    super(name, files, decoder, beatmapText);
    // Disallow default colours fallback on beatmap skins to allow using parent skin combo colours. (via SkinProvidingContainer)
    this.configuration.allowDefaultComboColoursFallback = false;
  }

  static async loadBeatmap(name: string, files: Record<string, Blob>, decoder: SkinResourceDecoder, beatmapFilename?: string): Promise<LegacyBeatmapSkin> {
    const osu = beatmapFilename ? findBlob(files, beatmapFilename) : undefined;
    const skin = new LegacyBeatmapSkin(name, files, decoder, osu ? await osu.text() : null);
    await skin.preload();
    return skin;
  }

  protected shouldPreloadImage(path: string): boolean {
    // Only elements in the beatmap folder's root which are used as skin elements.
    if (path.includes('/')) return false;
    return BEATMAP_SKIN_ELEMENTS.test(stripExtension(path)) && super.shouldPreloadImage(path);
  }

  /** Beatmap hitsounds are resolved by the player from the beatmap set itself (custom sample banks / file samples). */
  protected shouldPreloadSample(): boolean {
    return false;
  }

  /** For lookup simplicity, ignore beatmap-level versioning completely. */
  get legacyVersion(): number | null {
    return null;
  }

  /**
   * The player resolves beatmap-provided hit samples itself ("beatmap:" lookups of HitSampleInfo), which covers
   * LegacyBeatmapSkin.GetSample (only samples with a custom sample bank are served by the beatmap).
   */
  getSample(_name: string): AudioBuffer | null {
    return null;
  }

  getHitSample(info: HitSampleInfo): AudioBuffer | null {
    if (!info.useBeatmapSamples) return null;
    return super.getHitSample(info);
  }
}

/** LegacySkin.getFallbackSampleNames */
export function getFallbackSampleNames(name: string): string[] {
  // May be something like "Gameplay/normal-hitnormal" from lazer.
  // Fall back to using the last piece for components coming from lazer (e.g. "Gameplay/normal-hitnormal" -> "normal-hitnormal").
  return [name, name.split('/').pop()!];
}

/** HitSampleInfo.LookupNames as defined in lazer (FileHitSampleInfo first looks up its filename). */
export function hitSampleLookupNames(info: HitSampleInfo): string[] {
  const names: string[] = [];
  if (info.filename) names.push(info.filename, removeExtension(info.filename));
  if (info.suffix) names.push(`Gameplay/${info.bank}-${info.name}${info.suffix}`);
  names.push(`Gameplay/${info.bank}-${info.name}`);
  names.push(`Gameplay/${info.name}`);
  return names;
}

/** LegacySkin.getLegacyLookupNames */
export function legacyLookupNames(info: HitSampleInfo, useCustomSampleBanks: boolean): string[] {
  let lookupNames = hitSampleLookupNames(info).flatMap(getFallbackSampleNames);
  const suffix = info.suffix;
  if (suffix) {
    // for compatibility with stable:
    // - if the skin can use custom sample banks, it MUST use the custom sample bank suffix. it is not allowed to fall back to a non-custom sound.
    // - if the skin cannot use custom sample banks, it MUST NOT use the custom sample bank suffix.
    // using .EndsWith() is intentional as it ensures parity in all edge cases
    if (useCustomSampleBanks) lookupNames = lookupNames.filter(n => n.endsWith(suffix));
    else lookupNames = lookupNames.filter(n => !n.endsWith(suffix));
  }
  // also for compatibility, try falling back to non-bank samples (so-called "universal" samples) as the last resort.
  lookupNames.push(info.name);
  return lookupNames;
}

export function findBlob(files: Record<string, Blob>, name: string): Blob | undefined {
  const target = standardisePath(name);
  for (const [k, v] of Object.entries(files)) if (standardisePath(k) === target) return v;
  return undefined;
}

// ------------------------------------------------------------------------------------------------ typed config parsing

/**
 * LegacySkin.genericLookup for a bool: skins may use 1 or 0 (or 2, https://github.com/ppy/osu/issues/18579)
 * to signify a boolean state. Values which can't be parsed result in a failed lookup (null).
 */
export function parseConfigBool(val: string | undefined): boolean | null {
  if (val == null) return null;
  const b = tryParseBool(val);
  if (b != null) return b;
  try {
    return parseIntStrict(val) !== 0;
  } catch {
    return null;
  }
}

export function parseConfigFloat(val: string | undefined): number | null {
  if (val == null || val.trim() === '') return null;
  try {
    return parseFloatStrict(val);
  } catch {
    return null;
  }
}

export function parseConfigInt(val: string | undefined): number | null {
  if (val == null) return null;
  try {
    return parseIntStrict(val);
  } catch {
    return null;
  }
}
