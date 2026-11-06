// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game/Beatmaps/Formats/LegacyStoryboardDecoder.cs, including the parts of LegacyDecoder<T> (line handling,
// sections, comments, SplitKeyVal, CleanFilename) and Decoder.GetDecoder (format version detection) that it relies on.
// Note: like lazer, storyboards do not get the +24ms offset LegacyBeatmapDecoder applies to beatmaps older than v5.

import { MAX_COORDINATE_VALUE, parseDouble, parseFloat32, parseInt32 } from '../beatmaps/Parsing';
import { Anchor } from './Anchor';
import type { StoryboardCommandGroup } from './Commands';
import {
  AnimationLoopType,
  getExtension,
  Storyboard,
  StoryboardAnimation,
  StoryboardElementSource,
  StoryboardSampleInfo,
  StoryboardSprite,
  StoryboardVideo,
  VIDEO_EXTENSIONS,
} from './Storyboard';

export const LATEST_VERSION = 14;

type Section =
  | 'General'
  | 'Editor'
  | 'Metadata'
  | 'Difficulty'
  | 'Events'
  | 'TimingPoints'
  | 'Colours'
  | 'HitObjects'
  | 'Variables'
  | 'Fonts'
  | 'CatchTheBeat'
  | 'Mania'
  /** A numeric section header which isn't a defined Section value (Enum.TryParse succeeds; no handler matches). */
  | 'Unknown';

const SECTIONS: Exclude<Section, 'Unknown'>[] = ['General', 'Editor', 'Metadata', 'Difficulty', 'Events', 'TimingPoints', 'Colours', 'HitObjects', 'Variables', 'Fonts', 'CatchTheBeat', 'Mania'];

/** osu.Game.Beatmaps.Legacy.LegacyEventType */
const LegacyEventType = ['Background', 'Video', 'Break', 'Colour', 'Sprite', 'Sample', 'Animation'] as const;
/** osu.Game.Beatmaps.Legacy.LegacyStoryLayer */
const LegacyStoryLayer = ['Background', 'Fail', 'Pass', 'Foreground', 'Overlay', 'Video'] as const;
/** osu.Game.Beatmaps.Legacy.LegacyOrigins */
const LegacyOrigins = ['TopLeft', 'Centre', 'CentreLeft', 'TopRight', 'BottomCentre', 'TopCentre', 'Custom', 'CentreRight', 'BottomLeft', 'BottomRight'] as const;
const AnimationLoopTypeNames = ['LoopForever', 'LoopOnce'] as const;

class EnumParseError extends Error {}

/**
 * Emulates C# Enum.Parse / Enum.TryParse for a non-flags enum with sequential values: accepts the (case-sensitive) member name or an
 * integer (which need not be a defined value). Returns the numeric value, or null if the input is neither.
 */
function tryParseEnum(names: readonly string[], value: string): number | null {
  const trimmed = value.trim();
  const index = names.indexOf(trimmed);
  if (index >= 0) return index;
  if (/^[+-]?\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    if (n >= -2147483648 && n <= 2147483647) return n;
  }
  return null;
}

function parseEnum(names: readonly string[], value: string): number {
  const result = tryParseEnum(names, value);
  if (result === null) throw new EnumParseError(`Requested value '${value}' was not found.`);
  return result;
}

/** Enum.ToString(): the member name for defined values, otherwise the number. */
const enumName = (names: readonly string[], value: number): string => names[value] ?? String(value);

/** LegacyDecoder.SplitKeyVal */
function splitKeyVal(line: string, separator = ':', shouldTrim = true): [string, string] {
  const index = line.indexOf(separator);
  const key = index < 0 ? line : line.slice(0, index);
  const value = index < 0 ? '' : line.slice(index + 1);
  return shouldTrim ? [key.trim(), value.trim()] : [key, value];
}

/** LegacyDecoder.StripComments */
function stripComments(line: string): string {
  const index = line.indexOf('//');
  if (index > 0) return line.slice(0, index);
  return line;
}

/** C# string.Trim(char): trims only that character from both ends. */
function trimChar(s: string, c: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && s[start] === c) start++;
  while (end > start && s[end - 1] === c) end--;
  return s.slice(start, end);
}

/** LegacyDecoder.CleanFilename: `\\` → `\` (user error supported by stable), trim quotes, then standardise to forward slashes. */
export function cleanFilename(path: string): string {
  return trimChar(path.split('\\\\').join('\\'), '"').replace(/\\/g, '/');
}

/** C# string.Replace(string, string) (ordinal, all occurrences; an empty search string throws). */
function replaceAll(s: string, search: string, replacement: string): string {
  if (search.length === 0) throw new Error('String cannot be of zero length.');
  return s.split(search).join(replacement);
}

/** C# Math.Round(double) — banker's rounding (MidpointRounding.ToEven). */
function roundHalfToEven(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** Decoder.GetDecoder<Storyboard> + LegacyStoryboardDecoder.Register: the format version from the first non-empty line of the primary stream. */
export function detectFormatVersion(text: string): number {
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    // note that this isn't completely correct
    if (line.startsWith('osu file format v')) {
      const parts = line.split('v');
      return parseInt32(parts[parts.length - 1]);
    }
    return LATEST_VERSION; // "[Events]" or the fallback decoder
  }
  return LATEST_VERSION;
}

export class LegacyStoryboardDecoder {
  private storyboardSprite: StoryboardSprite | null = null;
  private currentCommandsGroup: StoryboardCommandGroup | null = null;
  private storyboard!: Storyboard;
  private readonly variables = new Map<string, string>();

  readonly warnings: string[] = [];

  constructor(private readonly formatVersion = LATEST_VERSION) {}

  /** Decoder.Decode(primaryStream, otherStreams...): the first text is the primary stream (the .osu), the rest are e.g. the .osb. */
  decode(...texts: string[]): Storyboard {
    const storyboard = new Storyboard(); // CreateTemplateObject (WidescreenStoryboard = false via ApplyLegacyDefaults)
    texts.forEach((text, i) => this.parseStreamInto(text, i === 0, storyboard));
    return storyboard;
  }

  /** Convenience: decode a storyboard, detecting the format version from the primary stream like Decoder.GetDecoder does. */
  static decode(primary: string, ...others: string[]): Storyboard {
    return new LegacyStoryboardDecoder(detectFormatVersion(primary)).decode(primary, ...others);
  }

  private parseStreamInto(text: string, isPrimaryStream: boolean, storyboard: Storyboard): void {
    this.storyboard = storyboard;
    let section: Section = 'General';
    const lines = text.replace(/^﻿/, '').split(/\r?\n|\r/);

    for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
      let line = lines[lineNumber];

      // ShouldSkipLine
      if (line.trim().length === 0 || line.trimStart().startsWith('//')) continue;

      // comments should not be stripped from metadata lines, as the song metadata may contain "//" as valid data.
      if (section !== 'Metadata') line = stripComments(line);

      line = line.trimEnd();

      if (line.startsWith('[') && line.endsWith(']')) {
        // Enum.TryParse: on failure the out parameter is reset to default(Section) = General.
        const parsed = tryParseEnum(SECTIONS, line.slice(1, -1));
        section = parsed === null ? 'General' : (SECTIONS[parsed] ?? 'Unknown');
        continue;
      }

      try {
        this.parseLine(storyboard, section, line, isPrimaryStream);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.warnings.push(`Failed to process line ${lineNumber + 1} "${line.length <= 50 ? line : line.slice(0, 50) + '…'}": ${msg}`);
      }
    }
  }

  private parseLine(storyboard: Storyboard, section: Section, line: string, isPrimaryStream: boolean): void {
    switch (section) {
      case 'General':
        this.handleGeneral(storyboard, line);
        return;

      case 'Events':
        this.handleEvents(line, isPrimaryStream);
        return;

      case 'Variables':
        this.handleVariables(line);
        return;
    }
    // base.ParseLine only handles [Colours], which has no effect on a Storyboard.
  }

  private handleGeneral(storyboard: Storyboard, line: string): void {
    const [key, value] = splitKeyVal(line);

    switch (key) {
      case 'UseSkinSprites':
        storyboard.useSkinSprites = value === '1';
        break;

      case 'WidescreenStoryboard':
        storyboard.widescreenStoryboard = parseInt32(value) === 1;
        break;
    }
  }

  private handleEvents(line: string, isPrimaryStream: boolean): void {
    line = this.decodeVariables(line);

    let depth = 0;
    for (const c of line) {
      if (c === ' ' || c === '_') depth++;
      else break;
    }

    line = line.substring(depth);

    const split = line.split(',');

    if (depth === 0) {
      this.storyboardSprite = null;

      const type = tryParseEnum(LegacyEventType, split[0]);
      if (type === null) throw new Error(`Unknown event type: ${split[0]}`);

      const source = isPrimaryStream ? StoryboardElementSource.Beatmap : StoryboardElementSource.Shared;

      switch (LegacyEventType[type]) {
        case 'Background': {
          // the actual filename is handled in `LegacyBeatmapDecoder`.
          // this only handles the background offset, because it does not logically belong in `Beatmap` or related classes.
          if (split.length > 4) {
            const x = parseFloat32(split[3]);
            const y = parseFloat32(split[4]);
            this.storyboard.backgroundOffset = { x, y };
          }
          break;
        }

        case 'Video': {
          const offset = parseInt32(split[1]);
          const path = cleanFilename(split[2]);

          // See handling in LegacyBeatmapDecoder for the special case where a video type is used but
          // the file extension is not a valid video.
          if (!VIDEO_EXTENSIONS.includes(getExtension(path).toLowerCase())) break;

          this.storyboard.getLayer('Video').add((this.storyboardSprite = new StoryboardVideo(source, path, offset)));
          break;
        }

        case 'Sprite': {
          const layer = parseLayer(split[1]);
          const origin = parseOrigin(split[2]);
          const path = cleanFilename(split[3]);
          const x = parseFloat32(split[4], MAX_COORDINATE_VALUE);
          const y = parseFloat32(split[5], MAX_COORDINATE_VALUE);
          this.storyboardSprite = new StoryboardSprite(source, path, origin, { x, y });
          this.storyboard.getLayer(layer).add(this.storyboardSprite);
          break;
        }

        case 'Animation': {
          const layer = parseLayer(split[1]);
          const origin = parseOrigin(split[2]);
          const path = cleanFilename(split[3]);
          const x = parseFloat32(split[4], MAX_COORDINATE_VALUE);
          const y = parseFloat32(split[5], MAX_COORDINATE_VALUE);
          const frameCount = parseInt32(split[6]);
          let frameDelay = parseDouble(split[7]);

          if (this.formatVersion < 6)
            // this is random as hell but taken straight from osu-stable.
            frameDelay = roundHalfToEven(0.015 * frameDelay) * 1.186 * Math.fround(1000 / 60);

          const loopType = split.length > 8 ? parseAnimationLoopType(split[8]) : AnimationLoopType.LoopForever;
          this.storyboardSprite = new StoryboardAnimation(source, path, origin, { x, y }, frameCount, frameDelay, loopType);
          this.storyboard.getLayer(layer).add(this.storyboardSprite);
          break;
        }

        case 'Sample': {
          const time = parseDouble(split[1]);
          const layer = parseLayer(split[2]);
          const path = cleanFilename(split[3]);
          const volume = split.length > 4 ? parseFloat32(split[4]) : 100;
          this.storyboard.getLayer(layer).add(new StoryboardSampleInfo(source, path, time, Math.trunc(volume)));
          break;
        }
      }
    } else {
      if (depth < 2) this.currentCommandsGroup = this.storyboardSprite?.commands ?? null;

      const commandType = split[0];

      switch (commandType) {
        case 'T': {
          if (split.length < 2) throw new RangeError('Index was outside the bounds of the array.');
          const triggerName = split[1];
          const startTime = split.length > 2 ? parseDouble(split[2]) : -Number.MAX_VALUE;
          const endTime = split.length > 3 ? parseDouble(split[3]) : Number.MAX_VALUE;
          // negation as per https://github.com/peppy/osu-stable-reference/blob/c34a74fb61c17c5667486a12548485d1f03baa2e/osu!/GameplayElements/HitObjectManager_LoadSave.cs#L736
          const groupNumber = split.length > 4 ? -parseInt32(split[4]) : 0;
          this.currentCommandsGroup = this.storyboardSprite?.addTriggerGroup(triggerName, startTime, endTime, groupNumber) ?? null;
          break;
        }

        case 'L': {
          const startTime = parseDouble(split[1]);
          const repeatCount = parseInt32(split[2]);
          this.currentCommandsGroup = this.storyboardSprite?.addLoopingGroup(startTime, Math.max(0, repeatCount - 1)) ?? null;
          break;
        }

        default: {
          if (split.length < 4) throw new RangeError('Index was outside the bounds of the array.');
          if (!split[3]) split[3] = split[2];

          const easing = parseInt32(split[1]);
          const startTime = parseDouble(split[2]);
          const endTime = parseDouble(split[3]);
          const group = this.currentCommandsGroup;
          const at = (i: number): string => {
            if (i >= split.length) throw new RangeError('Index was outside the bounds of the array.');
            return split[i];
          };

          switch (commandType) {
            case 'F': {
              const startValue = parseFloat32(at(4));
              const endValue = split.length > 5 ? parseFloat32(split[5]) : startValue;
              group?.addAlpha(easing, startTime, endTime, startValue, endValue);
              break;
            }

            case 'S': {
              const startValue = parseFloat32(at(4));
              const endValue = split.length > 5 ? parseFloat32(split[5]) : startValue;
              group?.addScale(easing, startTime, endTime, startValue, endValue);
              break;
            }

            case 'V': {
              const startX = parseFloat32(at(4));
              const startY = parseFloat32(at(5));
              const endX = split.length > 6 ? parseFloat32(split[6]) : startX;
              const endY = split.length > 7 ? parseFloat32(split[7]) : startY;
              group?.addVectorScale(easing, startTime, endTime, { x: startX, y: startY }, { x: endX, y: endY });
              break;
            }

            case 'R': {
              const startValue = parseFloat32(at(4));
              const endValue = split.length > 5 ? parseFloat32(split[5]) : startValue;
              group?.addRotation(easing, startTime, endTime, radiansToDegrees(startValue), radiansToDegrees(endValue));
              break;
            }

            case 'M': {
              const startX = parseFloat32(at(4));
              const startY = parseFloat32(at(5));
              const endX = split.length > 6 ? parseFloat32(split[6]) : startX;
              const endY = split.length > 7 ? parseFloat32(split[7]) : startY;
              group?.addX(easing, startTime, endTime, startX, endX);
              group?.addY(easing, startTime, endTime, startY, endY);
              break;
            }

            case 'MX': {
              const startValue = parseFloat32(at(4));
              const endValue = split.length > 5 ? parseFloat32(split[5]) : startValue;
              group?.addX(easing, startTime, endTime, startValue, endValue);
              break;
            }

            case 'MY': {
              const startValue = parseFloat32(at(4));
              const endValue = split.length > 5 ? parseFloat32(split[5]) : startValue;
              group?.addY(easing, startTime, endTime, startValue, endValue);
              break;
            }

            case 'C': {
              const startRed = parseFloat32(at(4));
              const startGreen = parseFloat32(at(5));
              const startBlue = parseFloat32(at(6));
              const endRed = split.length > 7 ? parseFloat32(split[7]) : startRed;
              const endGreen = split.length > 8 ? parseFloat32(split[8]) : startGreen;
              const endBlue = split.length > 9 ? parseFloat32(split[9]) : startBlue;
              group?.addColour(
                easing,
                startTime,
                endTime,
                { r: Math.fround(startRed / 255), g: Math.fround(startGreen / 255), b: Math.fround(startBlue / 255) },
                { r: Math.fround(endRed / 255), g: Math.fround(endGreen / 255), b: Math.fround(endBlue / 255) },
              );
              break;
            }

            case 'P': {
              const type = at(4);

              switch (type) {
                case 'A':
                  group?.addBlendingParameters(easing, startTime, endTime, 'Additive', startTime === endTime ? 'Additive' : 'Inherit');
                  break;

                case 'H':
                  group?.addFlipH(easing, startTime, endTime, true, startTime === endTime);
                  break;

                case 'V':
                  group?.addFlipV(easing, startTime, endTime, true, startTime === endTime);
                  break;
              }

              break;
            }

            default:
              throw new Error(`Unknown command type: ${commandType}`);
          }

          break;
        }
      }
    }
  }

  private handleVariables(line: string): void {
    const [key, value] = splitKeyVal(line, '=', false);
    this.variables.set(key, value);
  }

  /**
   * Decodes any beatmap variables present in a line into their real values.
   * Each defined variable is substituted a single time (in definition order), so a self-referential definition (e.g. `$a=x$a`) can't hang.
   */
  private decodeVariables(line: string): string {
    if (!line.includes('$')) return line;
    for (const [key, value] of this.variables) line = replaceAll(line, key, value);
    return line;
  }
}

/** float.RadiansToDegrees */
const radiansToDegrees = (radians: number): number => Math.fround(radians * Math.fround(180 / Math.PI));

function parseLayer(value: string): string {
  return enumName(LegacyStoryLayer, parseEnum(LegacyStoryLayer, value));
}

function parseOrigin(value: string): Anchor {
  switch (enumName(LegacyOrigins, parseEnum(LegacyOrigins, value))) {
    case 'TopLeft':
      return Anchor.TopLeft;
    case 'TopCentre':
      return Anchor.TopCentre;
    case 'TopRight':
      return Anchor.TopRight;
    case 'CentreLeft':
      return Anchor.CentreLeft;
    case 'Centre':
      return Anchor.Centre;
    case 'CentreRight':
      return Anchor.CentreRight;
    case 'BottomLeft':
      return Anchor.BottomLeft;
    case 'BottomCentre':
      return Anchor.BottomCentre;
    case 'BottomRight':
      return Anchor.BottomRight;
    default:
      // includes LegacyOrigins.Custom and undefined numeric values
      return Anchor.TopLeft;
  }
}

function parseAnimationLoopType(value: string): AnimationLoopType {
  const parsed = parseEnum(AnimationLoopTypeNames, value);
  return parsed === 0 || parsed === 1 ? parsed : AnimationLoopType.LoopForever;
}
