// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game/Skinning/LegacySkinDecoder.cs, SkinConfiguration.cs, LegacyManiaSkinDecoder.cs, LegacyManiaSkinConfiguration.cs
// and the line handling of osu.Game/Beatmaps/Formats/LegacyDecoder.cs which they share.

/** An 8-bit RGBA colour, as parsed by LegacyDecoder.HandleColours. */
export type Colour4 = [number, number, number, number];

/** Conversion factor from legacy positioning values (based in x480 dimensions) to x768 (LegacySkin.STABLE_MAGIC_SCALE_FACTOR). */
export const STABLE_MAGIC_SCALE_FACTOR = Math.fround(1.6);

/** LegacyDecoder.MAX_COMBO_COLOUR_COUNT */
export const MAX_COMBO_COLOUR_COUNT = 8;

/** LegacyDecoder.Section */
export const SECTIONS = ['General', 'Editor', 'Metadata', 'Difficulty', 'Events', 'TimingPoints', 'Colours', 'HitObjects', 'Variables', 'Fonts', 'CatchTheBeat', 'Mania'] as const;
export type Section = (typeof SECTIONS)[number];

// ------------------------------------------------------------------------------------------------ .NET parsing helpers

/** byte.Parse(string) (NumberStyles.Integer). Throws on failure. */
export function parseByte(s: string): number {
  const t = s.trim();
  if (!/^[+-]?\d+$/.test(t)) throw new Error(`Invalid byte "${s}"`);
  const v = parseInt(t, 10);
  // "-0" parses as zero; any other negative value overflows.
  if (v < 0 || v > 255) throw new Error(`Byte out of range "${s}"`);
  return v === 0 ? 0 : v;
}

/** int.Parse(string, InvariantCulture) (NumberStyles.Integer). Throws on failure. */
export function parseIntStrict(s: string): number {
  const t = s.trim();
  if (!/^[+-]?\d+$/.test(t)) throw new Error(`Invalid integer "${s}"`);
  const v = parseInt(t, 10);
  if (v > 2147483647 || v < -2147483648) throw new Error(`Integer out of range "${s}"`);
  return v;
}

/** int.TryParse(string) */
export function tryParseInt(s: string): number | null {
  try {
    return parseIntStrict(s);
  } catch {
    return null;
  }
}

/** float.Parse(string, InvariantCulture) (NumberStyles.Float | AllowThousands), rounded to single precision. Throws on failure. */
export function parseFloatStrict(s: string, allowThousands = true): number {
  let t = s.trim();
  if (t === 'Infinity' || t === '+Infinity') return Infinity;
  if (t === '-Infinity') return -Infinity;
  if (t === 'NaN') return NaN;
  if (allowThousands) t = t.replace(/(\d),(?=\d)/g, '$1');
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) throw new Error(`Invalid float "${s}"`);
  return Math.fround(parseFloat(t));
}

/** float.TryParse(string, NumberStyles.Float, InvariantCulture) */
export function tryParseFloat(s: string): number | null {
  try {
    return parseFloatStrict(s, false);
  } catch {
    return null;
  }
}

/** decimal.TryParse(value, NumberStyles.AllowDecimalPoint, InvariantCulture) */
export function tryParseDecimalPoint(s: string): number | null {
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(s)) return null;
  return parseFloat(s);
}

/** bool.TryParse(string) */
export function tryParseBool(s: string): boolean | null {
  const t = s.trim().replace(/\0+$/, '').toLowerCase();
  if (t === 'true') return true;
  if (t === 'false') return false;
  return null;
}

// ------------------------------------------------------------------------------------------------ LegacyDecoder line handling

/** LegacyDecoder.SplitKeyVal (with TrimEntries). */
export function splitKeyVal(line: string, separator = ':', shouldTrim = true): [string, string] {
  const index = line.indexOf(separator);
  let key = index < 0 ? line : line.slice(0, index);
  let value = index < 0 ? '' : line.slice(index + 1);
  if (shouldTrim) {
    key = key.trim();
    value = value.trim();
  }
  return [key, value];
}

/** LegacyDecoder.StripComments */
function stripComments(line: string): string {
  const index = line.indexOf('//');
  if (index > 0) return line.slice(0, index);
  return line;
}

/** LegacyDecoder.ShouldSkipLine */
function shouldSkipLine(line: string): boolean {
  return line.trim().length === 0 || line.trimStart().startsWith('//');
}

/** Enum.TryParse&lt;Section&gt; (case sensitive). On failure the out parameter is the default value (General). */
function parseSection(name: string): Section {
  const t = name.trim();
  return (SECTIONS as readonly string[]).includes(t) ? (t as Section) : 'General';
}

/** Splits text the way StreamReader.ReadLine does (\r\n, \n or \r), stripping a leading byte order mark. */
export function readLines(text: string): string[] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const lines = text.split(/\r\n|\n|\r/);
  // ReadLine does not return a final empty line after a trailing newline.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * LegacyDecoder.ParseStreamInto: walks the lines of a legacy file, tracking sections.
 * Exceptions thrown while parsing a line are swallowed (logged in lazer), as in the C#.
 */
export function parseLegacyStream(text: string, onBeginNewSection: (section: Section) => void, parseLine: (section: Section, line: string) => void): void {
  let section: Section = 'General';
  for (let line of readLines(text)) {
    if (shouldSkipLine(line)) continue;
    // comments should not be stripped from metadata lines, as the song metadata may contain "//" as valid data.
    if (section !== 'Metadata') line = stripComments(line);
    line = line.trimEnd();

    if (line.startsWith('[') && line.endsWith(']')) {
      section = parseSection(line.slice(1, -1));
      onBeginNewSection(section);
      continue;
    }

    try {
      parseLine(section, line);
    } catch {
      // "Failed to process line" (logged in lazer).
    }
  }
}

interface HasCustomColours {
  customColours: Map<string, Colour4>;
}

interface HasComboColours {
  customComboColours: Colour4[];
}

/** LegacyDecoder.HandleColours */
export function handleColours(output: HasCustomColours & Partial<HasComboColours>, line: string, allowAlpha: boolean): void {
  const [key, value] = splitKeyVal(line);
  const split = value.split(',');
  if (split.length !== 3 && split.length !== 4) throw new Error(`Color specified in incorrect format (should be R,G,B or R,G,B,A): ${value}`);

  const alpha = allowAlpha && split.length === 4 ? parseByte(split[3]) : 255;
  const colour: Colour4 = [parseByte(split[0]), parseByte(split[1]), parseByte(split[2]), alpha];

  let isCombo = false;
  if (key.startsWith('Combo')) {
    const comboIndex = tryParseInt(key.slice(5));
    isCombo = comboIndex != null && comboIndex >= 1 && comboIndex <= MAX_COMBO_COLOUR_COUNT;
  }

  if (isCombo) {
    if (!output.customComboColours) return;
    output.customComboColours.push(colour);
  } else {
    output.customColours.set(key, colour);
  }
}

// ------------------------------------------------------------------------------------------------ SkinConfiguration

/** SkinConfiguration.DefaultComboColours */
export const DEFAULT_SKIN_COMBO_COLOURS: readonly Colour4[] = [
  [255, 192, 0, 255],
  [0, 202, 0, 255],
  [18, 124, 255, 255],
  [242, 24, 57, 255],
];

/** Port of SkinConfiguration (an empty skin configuration). */
export class SkinConfiguration implements HasCustomColours, HasComboColours {
  /** SkinConfiguration.LATEST_VERSION */
  static readonly LATEST_VERSION = 2.7;

  readonly skinInfo = { name: '', creator: '' };

  /** Whether to allow DefaultComboColours as a fallback list for when no combo colours are provided. */
  allowDefaultComboColoursFallback = true;

  /** Legacy version of this skin. */
  legacyVersion: number | null = null;

  isLatestVersion = false;

  customComboColours: Colour4[] = [];

  get comboColours(): readonly Colour4[] | null {
    if (this.customComboColours.length > 0) return this.customComboColours;
    if (this.allowDefaultComboColoursFallback) return DEFAULT_SKIN_COMBO_COLOURS;
    return null;
  }

  readonly customColours = new Map<string, Colour4>();

  readonly configDictionary = new Map<string, string>();

  /** Port addition: raw key/values per section, for diagnostics and section-qualified lookups. */
  readonly sections = new Map<string, Map<string, string>>();
}

/** Port of LegacySkinDecoder (LegacyDecoder&lt;SkinConfiguration&gt; with version 1). */
export class LegacySkinDecoder {
  decode(text: string): SkinConfiguration {
    // CreateTemplateObject
    const skin = new SkinConfiguration();
    skin.legacyVersion = 1.0;
    skin.isLatestVersion = false;

    parseLegacyStream(
      text,
      () => {},
      (section, line) => this.parseLine(skin, section, line),
    );
    return skin;
  }

  private parseLine(skin: SkinConfiguration, section: Section, line: string): void {
    if (section !== 'Colours') {
      const [key, value] = splitKeyVal(line);

      if (key) {
        let s = skin.sections.get(section);
        if (!s) skin.sections.set(section, (s = new Map()));
        s.set(key, value);
      }

      switch (section) {
        case 'General':
          switch (key) {
            case 'Name':
              skin.skinInfo.name = value;
              return;

            case 'Author':
              skin.skinInfo.creator = value;
              return;

            case 'Version':
              if (value === 'latest') {
                skin.legacyVersion = SkinConfiguration.LATEST_VERSION;
                skin.isLatestVersion = true;
              } else {
                const version = tryParseDecimalPoint(value);
                if (version != null) {
                  skin.legacyVersion = version;
                  skin.isLatestVersion = false;
                }
              }
              return;
          }
          break;

        // osu!catch section only has colour settings
        // so no harm in handling the entire section
        case 'CatchTheBeat':
          handleColours(skin, line, true);
          return;
      }

      if (key) skin.configDictionary.set(key, value);
    }

    // base.ParseLine
    if (section === 'Colours') handleColours(skin, line, false);
  }
}

// ------------------------------------------------------------------------------------------------ Mania

export enum LegacyNoteBodyStyle {
  Stretch = 0,
  // Repeat = 1,
  RepeatTop = 2,
  RepeatBottom = 3,
  RepeatTopAndBottom = 4,
}

export enum LegacySpecialStyle {
  None = 0,
  Left = 1,
  Right = 2,
}

export enum LegacyComboBurstStyle {
  Left = 0,
  Right = 1,
  Both = 2,
}

/** Enum.TryParse for the legacy mania enums: names (case sensitive) or integers. */
function tryParseEnum<T extends Record<string, string | number>>(e: T, value: string): number | null {
  const t = value.trim();
  if (/^[+-]?\d+$/.test(t)) return parseInt(t, 10);
  const v = e[t];
  return typeof v === 'number' ? v : null;
}

const f32 = Math.fround;

/** Port of LegacyManiaSkinConfiguration. */
export class LegacyManiaSkinConfiguration implements HasCustomColours {
  /** Size of a legacy column in the default skin, used for determining relative scale factors. */
  static readonly DEFAULT_COLUMN_SIZE = f32(30 * STABLE_MAGIC_SCALE_FACTOR);
  static readonly DEFAULT_HIT_POSITION = f32((480 - 402) * STABLE_MAGIC_SCALE_FACTOR);

  readonly customColours = new Map<string, Colour4>();
  readonly imageLookups = new Map<string, string>();

  widthForNoteHeightScale = 0;

  readonly columnLineWidth: number[];
  readonly columnSpacing: number[];
  readonly columnWidth: number[];
  readonly explosionWidth: number[];
  readonly holdNoteLightWidth: number[];

  hitPosition = LegacyManiaSkinConfiguration.DEFAULT_HIT_POSITION;
  lightPosition = f32((480 - 413) * STABLE_MAGIC_SCALE_FACTOR);
  comboPosition = f32(111 * STABLE_MAGIC_SCALE_FACTOR);
  scorePosition = f32(300 * STABLE_MAGIC_SCALE_FACTOR);
  barLineHeight = f32(1.2);
  showJudgementLine = true;
  keysUnderNotes = false;
  lightFramePerSecond = 60;

  noteBodyStyle: LegacyNoteBodyStyle | null = null;

  // Unimplemented properties, at this time present primarily for encode-decode stability
  specialStyle: LegacySpecialStyle | null = null;
  columnStart = 136;
  columnRight = 19;
  upsideDown = false;
  separateScore = true;
  splitStages = false;
  stageSeparation = 40;
  comboBurstStyle: LegacyComboBurstStyle | null = null;
  readonly flipSettings = new Map<string, string>();
  readonly columnNoteBodyStyles: (LegacyNoteBodyStyle | null)[];

  constructor(readonly keys: number) {
    if (!Number.isInteger(keys) || keys < 1) throw new Error(`Invalid key count ${keys}`); // new float[keys - 1] would throw in C#.
    this.columnLineWidth = new Array(keys + 1).fill(2);
    this.columnSpacing = new Array(keys - 1).fill(0);
    this.columnWidth = new Array(keys).fill(LegacyManiaSkinConfiguration.DEFAULT_COLUMN_SIZE);
    this.explosionWidth = new Array(keys).fill(0);
    this.holdNoteLightWidth = new Array(keys).fill(0);
    this.columnNoteBodyStyles = new Array(keys).fill(null);
  }

  get minimumColumnWidth(): number {
    return Math.min(...this.columnWidth);
  }
}

/** Port of LegacyManiaSkinDecoder. */
export class LegacyManiaSkinDecoder {
  private pendingLines: string[] = [];
  private currentConfig: LegacyManiaSkinConfiguration | null = null;

  decode(text: string): LegacyManiaSkinConfiguration[] {
    const output: LegacyManiaSkinConfiguration[] = [];
    this.pendingLines = [];
    this.currentConfig = null;
    parseLegacyStream(
      text,
      () => {
        // If a new section is reached with pending lines remaining, they can all be discarded as there isn't a valid configuration to parse them into.
        this.pendingLines = [];
        this.currentConfig = null;
      },
      (section, line) => this.parseLine(output, section, line),
    );
    return output;
  }

  private parseLine(output: LegacyManiaSkinConfiguration[], section: Section, line: string): void {
    if (section !== 'Mania') return;
    const [key, value] = splitKeyVal(line);

    switch (key) {
      case 'Keys': {
        const config = new LegacyManiaSkinConfiguration(parseIntStrict(value));
        this.currentConfig = config;
        // Silently ignore duplicate configurations.
        if (output.every(c => c.keys !== config.keys)) output.push(config);
        // All existing lines can be flushed now that we have a valid configuration.
        this.flushPendingLines();
        break;
      }

      default:
        this.pendingLines.push(line);
        // Hold all lines until a "Keys" item is found.
        if (this.currentConfig != null) this.flushPendingLines();
        break;
    }
  }

  private flushPendingLines(): void {
    const c = this.currentConfig!;

    // Note: as in the C#, an exception part-way leaves the remaining lines pending.
    for (const line of this.pendingLines) {
      const [key, value] = splitKeyVal(line);

      switch (key) {
        case 'ColumnLineWidth':
          parseArrayValue(value, c.columnLineWidth, false);
          continue;
        case 'ColumnSpacing':
          parseArrayValue(value, c.columnSpacing);
          continue;
        case 'ColumnWidth':
          parseArrayValue(value, c.columnWidth);
          continue;
        case 'BarlineHeight':
          c.barLineHeight = parseFloatStrict(value);
          continue;
        case 'HitPosition':
          c.hitPosition = f32(f32(480 - Math.min(Math.max(parseFloatStrict(value), 240), 480)) * STABLE_MAGIC_SCALE_FACTOR);
          continue;
        case 'LightPosition':
          c.lightPosition = f32(f32(480 - parseFloatStrict(value)) * STABLE_MAGIC_SCALE_FACTOR);
          continue;
        case 'ComboPosition':
          c.comboPosition = f32(parseFloatStrict(value) * STABLE_MAGIC_SCALE_FACTOR);
          continue;
        case 'ScorePosition':
          c.scorePosition = f32(parseFloatStrict(value) * STABLE_MAGIC_SCALE_FACTOR);
          continue;
        case 'JudgementLine':
          c.showJudgementLine = value === '1';
          continue;
        case 'KeysUnderNotes':
          c.keysUnderNotes = value === '1';
          continue;
        case 'LightingNWidth':
          parseArrayValue(value, c.explosionWidth);
          continue;
        case 'LightingLWidth':
          parseArrayValue(value, c.holdNoteLightWidth);
          continue;
        case 'NoteBodyStyle': {
          const style = tryParseEnum(LegacyNoteBodyStyle, value);
          if (style != null) c.noteBodyStyle = style;
          continue;
        }
        case 'WidthForNoteHeightScale':
          c.widthForNoteHeightScale = f32(parseFloatStrict(value) * STABLE_MAGIC_SCALE_FACTOR);
          continue;
        case 'LightFramePerSecond': {
          const lightFramePerSecond = parseIntStrict(value);
          c.lightFramePerSecond = lightFramePerSecond > 0 ? lightFramePerSecond : 24;
          continue;
        }
        case 'SpecialStyle': {
          const s = tryParseEnum(LegacySpecialStyle, value);
          if (s != null) c.specialStyle = s;
          continue;
        }
        case 'ColumnStart':
          c.columnStart = parseFloatStrict(value);
          continue;
        case 'ColumnRight':
          c.columnRight = parseFloatStrict(value);
          continue;
        case 'UpsideDown':
          c.upsideDown = value === '1';
          continue;
        case 'SeparateScore':
          c.separateScore = value === '1';
          continue;
        case 'SplitStages':
          c.splitStages = value === '1';
          continue;
        case 'StageSeparation':
          c.stageSeparation = parseFloatStrict(value);
          continue;
        case 'ComboBurstStyle': {
          const s = tryParseEnum(LegacyComboBurstStyle, value);
          if (s != null) c.comboBurstStyle = s;
          continue;
        }
      }

      if (key.startsWith('Colour')) handleColours(c, line, true);
      // Custom sprite paths
      else if (key.startsWith('NoteImage') || key.startsWith('KeyImage') || key.startsWith('Hit') || key.startsWith('Stage') || key.startsWith('Lighting') || key === 'WarningArrow')
        c.imageLookups.set(key, value);
      else if (key.startsWith('KeyFlipWhenUpsideDown') || key.startsWith('NoteFlipWhenUpsideDown')) c.flipSettings.set(key, value);
    }

    this.pendingLines = [];
  }
}

function parseArrayValue(value: string, output: number[], applyScaleFactor = true): void {
  const values = value.split(',');
  for (let i = 0; i < values.length; i++) {
    if (i >= output.length) break;
    // some skins may provide incorrect entries in array values. to match stable behaviour, read such entries as zero.
    let parsedValue = tryParseFloat(values[i]) ?? 0;
    if (applyScaleFactor) parsedValue = f32(parsedValue * STABLE_MAGIC_SCALE_FACTOR);
    output[i] = parsedValue;
  }
}
