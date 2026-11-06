// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game/Beatmaps/Formats/LegacyBeatmapDecoder.cs, LegacyDecoder.cs and
// osu.Game/Rulesets/Objects/Legacy/ConvertHitObjectParser.cs.

import { HIT_CLAP, HIT_FINISH, HIT_NORMAL, HIT_WHISTLE, HitSampleInfo } from '../audio/HitSampleInfo';
import { Vec2, almostEquals, clamp, equals } from '../../framework/math';
import { PathControlPoint, PathType, PathTypes, SliderPath } from '../objects/SliderPath';
import { Beatmap, ConvertHitObject, LegacyHitObjectType } from './Beatmap';
import { DifficultyControlPoint, EffectControlPoint, SampleControlPoint, TimingControlPoint, ControlPoint } from './ControlPoints';
import { MAX_COORDINATE_VALUE, parseDouble, parseFloat32, parseInt32, tryParseInt } from './Parsing';

export const LATEST_VERSION = 14;
export const FIRST_LAZER_VERSION = 128;
export const EARLY_VERSION_TIMING_OFFSET = 24;
export const CONTROL_POINT_LENIENCY = 5;
export const MAX_MANIA_KEY_COUNT = 18;
const MAX_COMBO_COLOUR_COUNT = 8;

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
  | 'Unknown';

const SECTIONS = new Set(['General', 'Editor', 'Metadata', 'Difficulty', 'Events', 'TimingPoints', 'Colours', 'HitObjects', 'Variables', 'Fonts', 'CatchTheBeat', 'Mania']);

const LegacySampleBank = ['none', 'normal', 'soft', 'drum'];

const LegacyHitSoundType = { None: 0, Normal: 1, Whistle: 2, Finish: 4, Clap: 8 };

const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.avi', '.flv', '.mpg', '.wmv', '.m4v'];

export const standardisePath = (p: string): string => p.replace(/\\/g, '/');
const cleanFilename = (p: string): string => standardisePath(p.replace(/\\\\/g, '\\').trim().replace(/^"+|"+$/g, ''));

function splitKeyVal(line: string, separator = ':'): [string, string] {
  const idx = line.indexOf(separator);
  if (idx < 0) return [line.trim(), ''];
  return [line.slice(0, idx).trim(), line.slice(idx + 1).trim()];
}

interface SampleBankInfo {
  filename: string | null;
  bankForNormal: string | null;
  bankForAdditions: string | null;
  volume: number;
  customSampleBank: number;
  editorAutoBank: boolean;
}

const newBankInfo = (): SampleBankInfo => ({
  filename: null,
  bankForNormal: null,
  bankForAdditions: null,
  volume: 0,
  customSampleBank: 0,
  editorAutoBank: true,
});

export class LegacyBeatmapDecoder {
  private beatmap!: Beatmap;
  private formatVersion: number;
  private offset: number;
  private defaultSampleBank = 'normal';
  private defaultSampleVolume = 100;
  private hasApproachRate = false;
  private pendingControlPoints: ControlPoint[] = [];
  private pendingControlPointTypes = new Set<Function>();
  private pendingControlPointsTime = 0;

  // hit object parser state
  private firstObject = true;
  private lastObject: ConvertHitObject | null = null;

  readonly warnings: string[] = [];

  constructor(version = LATEST_VERSION, private readonly applyOffsets = true) {
    this.formatVersion = version;
    this.offset = version < 5 ? EARLY_VERSION_TIMING_OFFSET : 0;
  }

  /** Decodes the text content of a .osu file. */
  static decode(text: string, applyOffsets = true): Beatmap {
    const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
    let version = LATEST_VERSION;
    let start = 0;
    for (; start < lines.length; start++) {
      const l = lines[start].trim();
      if (l.length === 0) continue;
      const m = /^osu file format v(\d+)/.exec(l);
      if (m) {
        version = parseInt(m[1], 10);
        start++;
      }
      break;
    }
    const decoder = new LegacyBeatmapDecoder(version, applyOffsets);
    return decoder.parse(lines.slice(start));
  }

  private getOffsetTime(time = 0): number {
    return time + (this.applyOffsets ? this.offset : 0);
  }

  parse(lines: string[]): Beatmap {
    const beatmap = (this.beatmap = new Beatmap());
    beatmap.formatVersion = this.formatVersion;

    let section: Section = 'General';
    lines.forEach((rawLine, index) => {
      let line = rawLine;
      if (line.trim().length === 0 || line.trimStart().startsWith('//')) return;
      if (section !== 'Metadata') line = stripComments(line);
      line = line.trimEnd();

      if (line.startsWith('[') && line.endsWith(']')) {
        const name = line.slice(1, -1);
        section = SECTIONS.has(name) ? (name as Section) : 'Unknown';
        return;
      }

      try {
        this.parseLine(section, line);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.warnings.push(`Failed to process line ${index + 1} "${line.slice(0, 50)}": ${msg}`);
      }
    });

    this.applyDifficultyRestrictions();
    this.flushPendingPoints();

    beatmap.hitObjects.sort((a, b) => a.startTime - b.startTime);
    this.postProcessBreaks();

    for (const h of beatmap.hitObjects) {
      this.applyDefaults(h);
      this.applySamples(h);
    }
    return beatmap;
  }

  private applyDifficultyRestrictions(): void {
    const d = this.beatmap.difficulty;
    d.drainRate = clamp(d.drainRate, 0, 10);
    // mania uses "circle size" for key count, thus different allowable range
    d.circleSize = this.beatmap.rulesetId !== 3 ? clamp(d.circleSize, 0, 10) : clamp(d.circleSize, 1, MAX_MANIA_KEY_COUNT);
    d.overallDifficulty = clamp(d.overallDifficulty, 0, 10);
    d.approachRate = clamp(d.approachRate, 0, 10);
    d.sliderMultiplier = clamp(d.sliderMultiplier, 0.4, 3.6);
    d.sliderTickRate = clamp(d.sliderTickRate, 0.5, 8);
  }

  /** Objects following a break must start a new combo. */
  private postProcessBreaks(): void {
    let currentBreak = 0;
    let forceNewCombo = false;
    const breaks = this.beatmap.breaks;
    for (const h of this.beatmap.hitObjects) {
      while (currentBreak < breaks.length && breaks[currentBreak].endTime < h.startTime) {
        forceNewCombo = true;
        currentBreak++;
      }
      h.newCombo ||= forceNewCombo;
      forceNewCombo = false;
    }
  }

  private applyDefaults(h: ConvertHitObject): void {
    const dp = this.beatmap.controlPoints.difficultyPointAt(h.startTime);
    h.generateTicks = dp.generateTicks;
    h.sliderVelocityMultiplier = dp.sliderVelocity;
    h.applyDefaults(this.beatmap.controlPoints, this.beatmap.difficulty);
  }

  private applySamples(h: ConvertHitObject): void {
    const cp = this.beatmap.controlPoints;
    if (h.kind === 'slider') {
      const samplePoint = cp.samplePointAt(h.startTime + CONTROL_POINT_LENIENCY + 1);
      h.samples = h.samples.map(s => applySamplePoint(samplePoint, s));
      for (let i = 0; i < h.nodeSamples.length; i++) {
        const time = h.startTime + (i * h.duration) / h.spanCount + CONTROL_POINT_LENIENCY;
        const nodePoint = cp.samplePointAt(time);
        h.nodeSamples[i] = h.nodeSamples[i].map(s => applySamplePoint(nodePoint, s));
      }
    } else {
      const samplePoint = cp.samplePointAt(h.endTime + CONTROL_POINT_LENIENCY);
      h.samples = h.samples.map(s => applySamplePoint(samplePoint, s));
    }
  }

  private parseLine(section: Section, line: string): void {
    switch (section) {
      case 'General':
        return this.handleGeneral(line);
      case 'Editor':
        return this.handleEditor(line);
      case 'Metadata':
        return this.handleMetadata(line);
      case 'Difficulty':
        return this.handleDifficulty(line);
      case 'Events':
        return this.handleEvent(line);
      case 'TimingPoints':
        return this.handleTimingPoint(line);
      case 'HitObjects':
        return this.handleHitObject(line);
      case 'Colours':
        return this.handleColours(line);
    }
  }

  private handleGeneral(line: string): void {
    const [key, value] = splitKeyVal(line);
    const b = this.beatmap;
    switch (key) {
      case 'AudioFilename':
        b.metadata.audioFile = standardisePath(value);
        break;
      case 'AudioLeadIn':
        b.audioLeadIn = parseInt32(value);
        break;
      case 'PreviewTime': {
        const time = parseInt32(value);
        b.metadata.previewTime = time === -1 ? time : this.getOffsetTime(time);
        break;
      }
      case 'SampleSet': {
        const v = value.toLowerCase();
        if (LegacySampleBank.includes(v)) this.defaultSampleBank = v;
        break;
      }
      case 'SampleVolume':
        this.defaultSampleVolume = parseInt32(value);
        break;
      case 'StackLeniency':
        b.stackLeniency = parseFloat32(value);
        break;
      case 'Mode': {
        const mode = parseInt32(value);
        if (mode < 0 || mode > 3) throw new Error('Ruleset is not available locally.');
        b.rulesetId = mode;
        break;
      }
      case 'LetterboxInBreaks':
        b.letterboxInBreaks = parseInt32(value) === 1;
        break;
      case 'SpecialStyle':
        b.specialStyle = parseInt32(value) === 1;
        break;
      case 'WidescreenStoryboard':
        b.widescreenStoryboard = parseInt32(value) === 1;
        break;
      case 'EpilepsyWarning':
        b.epilepsyWarning = parseInt32(value) === 1;
        break;
      case 'SamplesMatchPlaybackRate':
        b.samplesMatchPlaybackRate = parseInt32(value) === 1;
        break;
      case 'Countdown':
        b.countdown = tryParseInt(value, 1);
        break;
      case 'CountdownOffset':
        b.countdownOffset = parseInt32(value);
        break;
    }
  }

  private handleEditor(line: string): void {
    const [key, value] = splitKeyVal(line);
    if (key === 'BeatDivisor') {
      // BindableBeatDivisor.MINIMUM_DIVISOR / MAXIMUM_DIVISOR
      this.beatmap.beatDivisor = clamp(parseInt32(value), 1, 16);
      return;
    }
    if (key === 'Bookmarks') {
      this.beatmap.bookmarks = value
        .split(',')
        .map(v => v.trim())
        .filter(v => /^-?\d+$/.test(v))
        .map(Number);
    }
  }

  private handleMetadata(line: string): void {
    const [key, value] = splitKeyVal(line);
    const m = this.beatmap.metadata;
    switch (key) {
      case 'Title':
        m.title = value;
        break;
      case 'TitleUnicode':
        m.titleUnicode = value;
        break;
      case 'Artist':
        m.artist = value;
        break;
      case 'ArtistUnicode':
        m.artistUnicode = value;
        break;
      case 'Creator':
        m.creator = value;
        break;
      case 'Version':
        this.beatmap.difficultyName = value;
        break;
      case 'Source':
        m.source = value;
        break;
      case 'Tags':
        m.tags = value;
        break;
      case 'BeatmapID':
        this.beatmap.onlineId = parseInt32(value);
        break;
      case 'BeatmapSetID':
        this.beatmap.beatmapSetOnlineId = parseInt32(value);
        break;
    }
  }

  private handleDifficulty(line: string): void {
    const [key, value] = splitKeyVal(line);
    const d = this.beatmap.difficulty;
    switch (key) {
      case 'HPDrainRate':
        d.drainRate = parseFloat32(value);
        break;
      case 'CircleSize':
        d.circleSize = parseFloat32(value);
        break;
      case 'OverallDifficulty':
        d.overallDifficulty = parseFloat32(value);
        if (!this.hasApproachRate) d.approachRate = d.overallDifficulty;
        break;
      case 'ApproachRate':
        d.approachRate = parseFloat32(value);
        this.hasApproachRate = true;
        break;
      case 'SliderMultiplier':
        d.sliderMultiplier = parseDouble(value);
        break;
      case 'SliderTickRate':
        d.sliderTickRate = parseDouble(value);
        break;
    }
  }

  private handleEvent(line: string): void {
    const split = line.split(',');
    const typeStr = split[0].trim();
    // LegacyEventType: Background = 0, Video = 1, Break = 2, Colour = 3, Sprite = 4, Sample = 5, Animation = 6
    const type =
      typeStr === '0' || typeStr === 'Background'
        ? 'Background'
        : typeStr === '1' || typeStr === 'Video'
          ? 'Video'
          : typeStr === '2' || typeStr === 'Break'
            ? 'Break'
            : typeStr === '4' || typeStr === 'Sprite'
              ? 'Sprite'
              : null;
    const m = this.beatmap.metadata;
    switch (type) {
      case 'Sprite':
        // Generally, the background is the first thing defined in a beatmap file.
        // In some older beatmaps, it is not present and replaced by a storyboard-level background instead.
        // Allow the first sprite (by file order) to act as the background in such cases.
        if (!m.backgroundFile && split.length > 3) m.backgroundFile = cleanFilename(split[3]);
        break;
      case 'Video': {
        const filename = cleanFilename(split[2]);
        // Some very old beatmaps had incorrect type specifications for their backgrounds (ie. using 1 for VIDEO instead of 0 for BACKGROUND).
        const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase();
        if (!VIDEO_EXTENSIONS.includes(ext)) m.backgroundFile = filename;
        break;
      }
      case 'Background':
        m.backgroundFile = cleanFilename(split[2]);
        break;
      case 'Break': {
        const start = this.getOffsetTime(parseDouble(split[1]));
        const end = Math.max(start, this.getOffsetTime(parseDouble(split[2])));
        this.beatmap.breaks.push({ startTime: start, endTime: end });
        break;
      }
    }
  }

  private handleTimingPoint(line: string): void {
    const split = line.split(',');
    const time = this.getOffsetTime(parseDouble(split[0].trim()));
    // beatLength is allowed to be NaN to handle an edge case in which some beatmaps use NaN slider velocity to disable slider tick generation (see LegacyDifficultyControlPoint).
    const beatLength = parseDouble(split[1].trim(), undefined, true);
    // If beatLength is NaN, speedMultiplier should still be 1 because all comparisons against NaN are false.
    const speedMultiplier = beatLength < 0 ? 100.0 / -beatLength : 1;

    let timeSignature = 4;
    if (split.length >= 3) timeSignature = split[2][0] === '0' ? 4 : parseInt32(split[2]);

    let sampleSet = this.defaultSampleBank;
    if (split.length >= 4) sampleSet = LegacySampleBank[parseInt32(split[3])] ?? 'normal';

    let customSampleBank = 0;
    if (split.length >= 5) customSampleBank = parseInt32(split[4]);

    let sampleVolume = this.defaultSampleVolume;
    if (split.length >= 6) sampleVolume = parseInt32(split[5]);

    let timingChange = true;
    if (split.length >= 7) timingChange = split[6][0] === '1';

    let kiaiMode = false;
    let omitFirstBarSignature = false;
    if (split.length >= 8) {
      const effectFlags = parseInt32(split[7]);
      kiaiMode = (effectFlags & 1) !== 0;
      omitFirstBarSignature = (effectFlags & 8) !== 0;
    }

    if (sampleSet === 'none') sampleSet = 'normal';

    if (timingChange) {
      if (Number.isNaN(beatLength)) throw new Error('Beat length cannot be NaN in a timing control point');
      const cp = new TimingControlPoint();
      cp.beatLength = beatLength;
      cp.timeSignature = timeSignature;
      cp.omitFirstBarLine = omitFirstBarSignature;
      this.addControlPoint(time, cp, true);
    }

    const dp = new DifficultyControlPoint();
    dp.generateTicks = !Number.isNaN(beatLength);
    dp.sliderVelocity = speedMultiplier;
    this.addControlPoint(time, dp, timingChange);

    const ep = new EffectControlPoint();
    ep.kiaiMode = kiaiMode;
    // osu!taiko and osu!mania use effect points rather than difficulty points for scroll speed adjustments.
    if (this.beatmap.rulesetId === 1 || this.beatmap.rulesetId === 3) ep.scrollSpeed = speedMultiplier;
    this.addControlPoint(time, ep, timingChange);

    const sp = new SampleControlPoint();
    sp.sampleBank = sampleSet;
    sp.sampleVolume = sampleVolume;
    sp.customSampleBank = customSampleBank;
    this.addControlPoint(time, sp, timingChange);
  }

  private addControlPoint(time: number, point: ControlPoint, timingChange: boolean): void {
    if (time !== this.pendingControlPointsTime) this.flushPendingPoints();
    if (timingChange) this.pendingControlPoints.unshift(point);
    else this.pendingControlPoints.push(point);
    this.pendingControlPointsTime = time;
  }

  private flushPendingPoints(): void {
    // Changes from non-timing-points are added to the end of the list (see addControlPoint()) and should override any changes from timing-points (added to the start of the list).
    for (let i = this.pendingControlPoints.length - 1; i >= 0; i--) {
      const type = this.pendingControlPoints[i].constructor;
      if (this.pendingControlPointTypes.has(type)) continue;
      this.pendingControlPointTypes.add(type);
      this.beatmap.controlPoints.add(this.pendingControlPointsTime, this.pendingControlPoints[i]);
    }
    this.pendingControlPoints = [];
    this.pendingControlPointTypes.clear();
  }

  private handleColours(line: string): void {
    const [key, value] = splitKeyVal(line);
    const split = value.split(',').map(s => s.trim());
    if (split.length !== 3 && split.length !== 4) throw new Error(`Color specified in incorrect format (should be R,G,B or R,G,B,A): ${value}`);
    const comps = split.map(s => {
      const n = Number(s);
      if (!Number.isInteger(n) || n < 0 || n > 255) throw new Error('Color must be specified with 8-bit integer components');
      return n;
    });
    const comboMatch = /^Combo(\d+)$/.exec(key);
    if (comboMatch) {
      const index = parseInt(comboMatch[1], 10);
      if (index >= 1 && index <= MAX_COMBO_COLOUR_COUNT) this.beatmap.comboColours.push([comps[0], comps[1], comps[2]]);
    } else {
      this.beatmap.customColours[key] = [comps[0], comps[1], comps[2], 255];
    }
  }

  private handleHitObject(line: string): void {
    const obj = this.parseHitObject(line);
    obj.applyDefaults(this.beatmap.controlPoints, this.beatmap.difficulty);
    this.beatmap.hitObjects.push(obj);
  }

  // ---- ConvertHitObjectParser ----

  private parseHitObject(text: string): ConvertHitObject {
    const split = text.split(',');
    const lazer = this.formatVersion >= FIRST_LAZER_VERSION;

    const x = clamp(parseFloat32(split[0], MAX_COORDINATE_VALUE), 0, 512);
    const y = clamp(parseFloat32(split[1], MAX_COORDINATE_VALUE), 0, 512);
    const pos: Vec2 = lazer ? { x, y } : { x: Math.trunc(x), y: Math.trunc(y) };

    const offset = this.getOffsetTime();
    const startTime = parseDouble(split[2]) + offset;

    let type = parseInt32(split[3]);
    const comboOffset = (type & LegacyHitObjectType.ComboOffset) >> 4;
    type &= ~LegacyHitObjectType.ComboOffset;
    const combo = (type & LegacyHitObjectType.NewCombo) !== 0;
    type &= ~LegacyHitObjectType.NewCombo;

    const soundType = parseInt32(split[4]);
    const bankInfo = newBankInfo();

    let result: ConvertHitObject | null = null;

    if (type & LegacyHitObjectType.Circle) {
      result = this.createCommon('circle', pos, combo, comboOffset);
      if (split.length > 5) readCustomSampleBanks(split[5], bankInfo);
    } else if (type & LegacyHitObjectType.Slider) {
      let length: number | null = null;
      let repeatCount = parseInt32(split[6]);
      if (repeatCount > 9000) throw new Error('Repeat count is way too high');
      // osu-stable treated the first span of the slider as a repeat, but no repeats are happening
      repeatCount = Math.max(0, repeatCount - 1);

      if (split.length > 7) {
        length = Math.max(0, parseDouble(split[7], MAX_COORDINATE_VALUE));
        if (length === 0) length = null;
      }

      if (split.length > 10) readCustomSampleBanks(split[10], bankInfo, true);

      // One node for each repeat + the start and end nodes
      const nodes = repeatCount + 2;
      const nodeBankInfos: SampleBankInfo[] = [];
      for (let i = 0; i < nodes; i++) nodeBankInfos.push({ ...bankInfo });

      if (split.length > 9 && split[9].length > 0) {
        const sets = split[9].split('|');
        for (let i = 0; i < nodes && i < sets.length; i++) readCustomSampleBanks(sets[i], nodeBankInfos[i]);
      }

      const nodeSoundTypes: number[] = new Array(nodes).fill(soundType);
      if (split.length > 8 && split[8].length > 0) {
        const adds = split[8].split('|');
        for (let i = 0; i < nodes && i < adds.length; i++) nodeSoundTypes[i] = tryParseInt(adds[i], 0);
      }

      let nodeSamples: HitSampleInfo[][] = [];
      for (let i = 0; i < nodes; i++) nodeSamples.push(convertSoundType(nodeSoundTypes[i], nodeBankInfos[i]));

      const path = new SliderPath(this.convertPathString(split[5], pos), length, true);
      if (almostEquals(path.distance, 0)) {
        // A slider with zero length is treated as a circle in stable; drop repeats.
        repeatCount = 0;
        nodeSamples = [nodeSamples[0], nodeSamples[nodeSamples.length - 1]];
      }

      result = this.createCommon('slider', pos, combo, comboOffset);
      result.path = path;
      result.nodeSamples = nodeSamples;
      result.repeatCount = repeatCount;
    } else if (type & LegacyHitObjectType.Spinner) {
      // osu-stable doesn't use the ComboOffset flag for spinners, and new combos are set by default after spinners.
      const duration = Math.max(0, parseDouble(split[5]) + offset - startTime);
      result = new ConvertHitObject('spinner');
      result.x = 256;
      result.y = 192;
      result.newCombo = combo;
      result.duration = duration;
      this.lastObject = result;
      if (split.length > 6) readCustomSampleBanks(split[6], bankInfo);
    } else if (type & LegacyHitObjectType.Hold) {
      // Note: Hold is generated by BMS converts
      let endTime = Math.max(startTime, parseDouble(split[2]));
      if (split.length > 5 && split[5].length > 0) {
        const ss = split[5].split(':');
        endTime = Math.max(startTime, parseDouble(ss[0]));
        readCustomSampleBanks(ss.slice(1).join(':'), bankInfo);
      }
      result = new ConvertHitObject('hold');
      result.x = pos.x;
      result.y = pos.y;
      result.duration = endTime + offset - startTime;
      this.lastObject = result;
    }

    if (result == null) throw new Error(`Unknown hit object type: ${split[3]}`);

    result.startTime = startTime;
    result.legacyType = type;
    if (result.samples.length === 0) result.samples = convertSoundType(soundType, bankInfo);
    this.firstObject = false;
    return result;
  }

  private createCommon(kind: 'circle' | 'slider', pos: Vec2, newCombo: boolean, comboOffset: number): ConvertHitObject {
    const o = new ConvertHitObject(kind);
    o.x = pos.x;
    o.y = pos.y;
    o.newCombo = this.firstObject || this.lastObject?.kind === 'spinner' || newCombo;
    o.comboOffset = newCombo ? comboOffset : 0;
    this.lastObject = o;
    return o;
  }

  private convertPathString(pointString: string, offset: Vec2): PathControlPoint[] {
    const lazer = this.formatVersion >= FIRST_LAZER_VERSION;
    const pointSplit = pointString.split('|');
    const points: Vec2[] = [];
    const segments: { type: PathType; startIndex: number }[] = [];

    const readPoint = (value: string): Vec2 => {
      const v = value.split(':');
      const px = parseFloat32(v[0], MAX_COORDINATE_VALUE);
      const py = parseFloat32(v[1], MAX_COORDINATE_VALUE);
      const p = lazer ? { x: px, y: py } : { x: Math.trunc(px), y: Math.trunc(py) };
      return { x: p.x - offset.x, y: p.y - offset.y };
    };

    for (const s of pointSplit) {
      if (s.length === 0) continue;
      if (/[a-zA-Z]/.test(s[0])) {
        segments.push({ type: convertPathType(s), startIndex: points.length });
        // First segment is prepended by an extra zero point
        if (points.length === 0) points.push({ x: 0, y: 0 });
      } else {
        points.push(readPoint(s));
      }
    }

    const controlPoints: PathControlPoint[] = [];
    for (let i = 0; i < segments.length; i++) {
      const startIndex = segments[i].startIndex;
      if (i < segments.length - 1) {
        const endIndex = segments[i + 1].startIndex;
        controlPoints.push(...this.convertPoints(segments[i].type, points.slice(startIndex, endIndex), points[endIndex]));
      } else {
        controlPoints.push(...this.convertPoints(segments[i].type, points.slice(startIndex), null));
      }
    }
    return controlPoints;
  }

  /** Converts a given point list into a set of path segments. */
  private convertPoints(type: PathType, points: Vec2[], endPoint: Vec2 | null): PathControlPoint[] {
    const lazer = this.formatVersion >= FIRST_LAZER_VERSION;
    const vertices: PathControlPoint[] = points.map(p => ({ position: p, type: null }));

    // Edge-case rules (to match stable).
    if (type.type === 'PerfectCurve') {
      const endPointLength = endPoint == null ? 0 : 1;
      if (!lazer) {
        if (vertices.length + endPointLength !== 3) type = PathTypes.BEZIER;
        else if (isLinear(points[0], points[1], endPoint ?? points[2])) {
          // osu-stable special-cased colinear perfect curves to a linear path
          type = PathTypes.LINEAR;
        }
      } else if (vertices.length + endPointLength > 3) {
        // Lazer supports perfect curves with less than 3 points and colinear points
        type = PathTypes.BEZIER;
      }
    }

    // The first control point must have a definite type.
    vertices[0].type = type;

    // A path can have multiple implicit segments of the same type if there are two sequential control points with the same position.
    // To handle such cases, this code may return multiple path segments with the final control point in each segment having a non-null type.
    const result: PathControlPoint[] = [];
    let startIndex = 0;
    let endIndex = 0;
    while (++endIndex < vertices.length) {
      // Keep incrementing while an implicit segment doesn't need to be started.
      if (!equals(vertices[endIndex].position, vertices[endIndex - 1].position)) continue;
      // Legacy CATMULL sliders don't support multiple segments, so adjacent CATMULL segments should be treated as a single one.
      // Importantly, this is not applied to the first control point, which may duplicate the slider path's position
      // resulting in a duplicate (0,0) control point in the resultant list.
      if (type.type === 'Catmull' && endIndex > 1 && !lazer) continue;
      // The last control point of each segment is not allowed to start a new implicit segment.
      if (endIndex === vertices.length - 1) continue;

      // Force a type on the last point, and return the current control point set as a segment.
      vertices[endIndex - 1].type = type;
      result.push(...vertices.slice(startIndex, endIndex));
      // Skip the current control point - as it's the same as the one that's just been returned.
      startIndex = endIndex + 1;
    }
    if (startIndex < endIndex) result.push(...vertices.slice(startIndex, endIndex));
    return result;
  }
}

function stripComments(line: string): string {
  const index = line.indexOf('//');
  return index > 0 ? line.slice(0, index) : line;
}

function isLinear(p0: Vec2, p1: Vec2, p2: Vec2): boolean {
  return almostEquals(0, (p1.y - p0.y) * (p2.x - p0.x) - (p1.x - p0.x) * (p2.y - p0.y));
}

function convertPathType(input: string): PathType {
  switch (input[0]) {
    default:
    case 'C':
      return PathTypes.CATMULL;
    case 'B': {
      if (input.length > 1) {
        const degree = parseInt(input.slice(1), 10);
        if (degree > 0) return PathTypes.bSpline(degree);
      }
      return PathTypes.BEZIER;
    }
    case 'L':
      return PathTypes.LINEAR;
    case 'P':
      return PathTypes.PERFECT_CURVE;
  }
}

function readCustomSampleBanks(str: string, bankInfo: SampleBankInfo, banksOnly = false): void {
  if (!str) return;
  const split = str.split(':');
  let bank = LegacySampleBank[tryParseInt(split[0], 1)] ?? 'normal';
  let addBank = LegacySampleBank[tryParseInt(split[1] ?? '0', 1)] ?? 'normal';

  let stringBank: string | null = bank;
  let stringAddBank: string | null = addBank;
  if (stringBank === 'none') stringBank = null;
  if (stringAddBank === 'none') {
    bankInfo.editorAutoBank = true;
    stringAddBank = null;
  } else bankInfo.editorAutoBank = false;

  bankInfo.bankForNormal = stringBank;
  bankInfo.bankForAdditions = stringAddBank || stringBank;

  if (banksOnly) return;
  if (split.length > 2) bankInfo.customSampleBank = tryParseInt(split[2], 0);
  if (split.length > 3) bankInfo.volume = Math.max(0, tryParseInt(split[3], 0));
  bankInfo.filename = split.length > 4 && split[4].length > 0 ? split[4] : null;
}

function convertSoundType(type: number, bankInfo: SampleBankInfo): HitSampleInfo[] {
  const soundTypes: HitSampleInfo[] = [];
  if (!bankInfo.filename) {
    soundTypes.push(
      new HitSampleInfo({
        name: HIT_NORMAL,
        bank: bankInfo.bankForNormal,
        volume: bankInfo.volume,
        editorAutoBank: true,
        customSampleBank: bankInfo.customSampleBank,
        // if the sound type doesn't have the Normal flag set, attach it anyway as a layered sample.
        // None also counts as a normal non-layered sample: https://osu.ppy.sh/help/wiki/osu!_File_Formats/Osu_(file_format)#hitsounds
        isLayered: type !== LegacyHitSoundType.None && (type & LegacyHitSoundType.Normal) === 0,
      }),
    );
  } else {
    // Todo: This should set the normal SampleInfo if the specified sample file isn't found, but that's a pretty edge-case scenario
    soundTypes.push(new HitSampleInfo({ name: HIT_NORMAL, customSampleBank: 1, volume: bankInfo.volume, filename: bankInfo.filename }));
  }
  const extra = (name: string) =>
    new HitSampleInfo({
      name,
      bank: bankInfo.bankForAdditions,
      volume: bankInfo.volume,
      editorAutoBank: bankInfo.editorAutoBank,
      customSampleBank: bankInfo.customSampleBank,
    });
  if (type & LegacyHitSoundType.Finish) soundTypes.push(extra(HIT_FINISH));
  if (type & LegacyHitSoundType.Whistle) soundTypes.push(extra(HIT_WHISTLE));
  if (type & LegacyHitSoundType.Clap) soundTypes.push(extra(HIT_CLAP));
  return soundTypes;
}

/** LegacySampleControlPoint.ApplyTo */
function applySamplePoint(point: SampleControlPoint, s: HitSampleInfo): HitSampleInfo {
  return s.with({
    customSampleBank: s.customSampleBank > 0 ? s.customSampleBank : point.customSampleBank,
    volume: s.volume > 0 ? s.volume : point.sampleVolume,
    bank: s.bankSpecified ? s.bank : point.sampleBank,
  });
}
