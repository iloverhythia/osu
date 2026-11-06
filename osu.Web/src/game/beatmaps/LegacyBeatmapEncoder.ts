// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game/Beatmaps/Formats/LegacyBeatmapEncoder.cs: writes a beatmap as "osu file format v128".
// Storyboard elements defined in the .osu are written back from the lines kept by the decoder.

import { BANK_DRUM, BANK_NORMAL, BANK_SOFT, HIT_CLAP, HIT_FINISH, HIT_NORMAL, HIT_WHISTLE, type HitSampleInfo } from '../audio/HitSampleInfo';
import { Beatmap, ConvertHitObject, LegacyHitObjectType } from './Beatmap';
import { SampleControlPoint, type TimingControlPoint } from './ControlPoints';
import { CONTROL_POINT_LENIENCY, FIRST_LAZER_VERSION } from './LegacyBeatmapDecoder';

const MAX_COMBO_COLOUR_COUNT = 8;
const LegacyHitSoundType = { None: 0, Normal: 1, Whistle: 2, Finish: 4, Clap: 8 };
const LegacyEffectFlags = { None: 0, Kiai: 1, OmitFirstBarLine: 8 };

/** FormattableString.Invariant for doubles / floats. */
const num = (v: number): string => {
  if (Number.isInteger(v)) return String(v);
  // C# prints shortest round-trip; JS does the same except for exponent forms.
  const s = String(v);
  return s.includes('e') ? v.toFixed(12).replace(/0+$/, '').replace(/\.$/, '') : s;
};
/** Single-precision values (CircleSize etc.) print at float precision in C#. */
const float = (v: number): string => num(Number(Math.fround(v).toPrecision(7)));

function toLegacySampleBank(bank: string | null | undefined): number {
  switch (bank?.toLowerCase()) {
    case BANK_NORMAL:
      return 1;
    case BANK_SOFT:
      return 2;
    case BANK_DRUM:
      return 3;
    default:
      return 0;
  }
}

const BANK_NAMES = ['None', 'Normal', 'Soft', 'Drum'];

function toLegacyHitSoundType(samples: readonly HitSampleInfo[]): number {
  let type = LegacyHitSoundType.None;
  for (const s of samples) {
    if (s.name === HIT_WHISTLE) type |= LegacyHitSoundType.Whistle;
    else if (s.name === HIT_FINISH) type |= LegacyHitSoundType.Finish;
    else if (s.name === HIT_CLAP) type |= LegacyHitSoundType.Clap;
  }
  return type;
}

interface Props {
  sliderVelocity: number;
  timingSignature: number;
  sampleBank: number;
  customSampleBank: number;
  sampleVolume: number;
  effectFlags: number;
}

const isRedundant = (a: Props, b: Props) =>
  a.sliderVelocity === b.sliderVelocity && a.timingSignature === b.timingSignature && a.sampleBank === b.sampleBank && a.customSampleBank === b.customSampleBank && a.sampleVolume === b.sampleVolume && a.effectFlags === b.effectFlags;

/** A sorted list of control points of one type with "active at time" lookup. */
class PointList<T extends { time: number }> {
  readonly list: T[] = [];
  constructor(private readonly fallback: T) {}
  at(time: number): T {
    let found: T | null = null;
    for (const p of this.list) {
      if (p.time <= time) found = p;
      else break;
    }
    return found ?? this.list[0] ?? this.fallback;
  }
  put(p: T): void {
    const i = this.list.findIndex(x => x.time === p.time);
    if (i >= 0) this.list.splice(i, 1);
    let j = this.list.length;
    while (j > 0 && this.list[j - 1].time > p.time) j--;
    this.list.splice(j, 0, p);
  }
}

export class LegacyBeatmapEncoder {
  private readonly lines: string[] = [];

  constructor(private readonly beatmap: Beatmap) {
    if (beatmap.rulesetId < 0 || beatmap.rulesetId > 3) throw new Error('Only beatmaps in the osu, taiko, catch, or mania rulesets can be encoded to the legacy beatmap format.');
  }

  static encode(beatmap: Beatmap): string {
    return new LegacyBeatmapEncoder(beatmap).encode();
  }

  encode(): string {
    const w = this.lines;
    w.length = 0;
    w.push(`osu file format v${FIRST_LAZER_VERSION}`, '');
    this.handleGeneral();
    w.push('');
    this.handleEditor();
    w.push('');
    this.handleMetadata();
    w.push('');
    this.handleDifficulty();
    w.push('');
    this.handleEvents();
    w.push('');
    this.handleControlPoints();
    w.push('');
    this.handleColours();
    w.push('');
    this.handleHitObjects();
    return w.join('\r\n') + '\r\n';
  }

  private get rulesetId(): number {
    return this.beatmap.rulesetId;
  }

  private handleGeneral(): void {
    const b = this.beatmap;
    const w = this.lines;
    w.push('[General]');
    if (b.metadata.audioFile) w.push(`AudioFilename: ${b.metadata.audioFile.split('/').pop()}`);
    w.push(`AudioLeadIn: ${num(b.audioLeadIn)}`);
    w.push(`PreviewTime: ${num(b.metadata.previewTime)}`);
    w.push(`Countdown: ${b.countdown}`);
    w.push(`SampleSet: ${BANK_NAMES[toLegacySampleBank((b.controlPoints.samplePoints[0] ?? SampleControlPoint.DEFAULT).sampleBank)]}`);
    w.push(`StackLeniency: ${float(b.stackLeniency)}`);
    w.push(`Mode: ${this.rulesetId}`);
    w.push(`LetterboxInBreaks: ${b.letterboxInBreaks ? '1' : '0'}`);
    if (b.epilepsyWarning) w.push('EpilepsyWarning: 1');
    if (b.countdownOffset > 0) w.push(`CountdownOffset: ${b.countdownOffset}`);
    if (this.rulesetId === 3) w.push(`SpecialStyle: ${b.specialStyle ? '1' : '0'}`);
    w.push(`WidescreenStoryboard: ${b.widescreenStoryboard ? '1' : '0'}`);
    if (b.samplesMatchPlaybackRate) w.push('SamplesMatchPlaybackRate: 1');
  }

  private handleEditor(): void {
    const b = this.beatmap;
    const w = this.lines;
    w.push('[Editor]');
    if (b.bookmarks.length > 0) w.push(`Bookmarks: ${b.bookmarks.map(num).join(',')}`);
    w.push(`DistanceSpacing: ${num(b.distanceSpacing)}`);
    w.push(`BeatDivisor: ${b.beatDivisor}`);
    w.push(`GridSize: ${b.gridSize}`);
    w.push(`TimelineZoom: ${float(b.timelineZoom)}`);
    w.push(`VelocityPresets: ${b.sliderVelocityPresets.map(num).join(',')}`);
  }

  private handleMetadata(): void {
    const b = this.beatmap;
    const m = b.metadata;
    const w = this.lines;
    w.push('[Metadata]');
    w.push(`Title: ${m.title}`);
    if (m.titleUnicode) w.push(`TitleUnicode: ${m.titleUnicode}`);
    w.push(`Artist: ${m.artist}`);
    if (m.artistUnicode) w.push(`ArtistUnicode: ${m.artistUnicode}`);
    w.push(`Creator: ${m.creator}`);
    w.push(`Version: ${b.difficultyName}`);
    if (m.source) w.push(`Source: ${m.source}`);
    if (m.tags) w.push(`Tags: ${m.tags}`);
    if (b.onlineId > 0) w.push(`BeatmapID: ${b.onlineId}`);
    if (b.beatmapSetOnlineId > 0) w.push(`BeatmapSetID: ${b.beatmapSetOnlineId}`);
  }

  private handleDifficulty(): void {
    const d = this.beatmap.difficulty;
    const w = this.lines;
    w.push('[Difficulty]');
    w.push(`HPDrainRate: ${float(d.drainRate)}`);
    w.push(`CircleSize: ${float(d.circleSize)}`);
    w.push(`OverallDifficulty: ${float(d.overallDifficulty)}`);
    w.push(`ApproachRate: ${float(d.approachRate)}`);
    w.push(`SliderMultiplier: ${num(d.sliderMultiplier)}`);
    w.push(`SliderTickRate: ${num(d.sliderTickRate)}`);
  }

  private handleEvents(): void {
    const b = this.beatmap;
    const w = this.lines;
    w.push('[Events]');
    if (b.metadata.backgroundFile) w.push(`0,0,"${b.metadata.backgroundFile}",0,0`);
    // Storyboard elements and the video, as they were in the .osu.
    w.push(...b.storyboardLines);
    w.push('// Break Periods');
    for (const br of b.breaks) w.push(`2,${num(br.startTime)},${num(br.endTime)}`);
  }

  private handleControlPoints(): void {
    const b = this.beatmap;
    const w = this.lines;
    const cpi = b.controlPoints;
    const timing = new PointList<TimingControlPoint>(cpi.timingPointAt(0));
    for (const p of cpi.timingPoints) timing.put(p);
    const difficulty = new PointList<{ time: number; sliderVelocity: number }>({ time: 0, sliderVelocity: 1 });
    for (const p of cpi.difficultyPoints) difficulty.put({ time: p.time, sliderVelocity: p.sliderVelocity });
    const effect = new PointList<{ time: number; kiaiMode: boolean; scrollSpeed: number }>({ time: 0, kiaiMode: false, scrollSpeed: 1 });
    for (const p of cpi.effectPoints) effect.put({ time: p.time, kiaiMode: p.kiaiMode, scrollSpeed: p.scrollSpeed });
    const sample = new PointList<{ time: number; sampleBank: string; sampleVolume: number; customSampleBank: number }>({ time: 0, sampleBank: BANK_NORMAL, sampleVolume: 100, customSampleBank: 0 });
    for (const p of cpi.samplePoints) sample.put({ time: p.time, sampleBank: p.sampleBank, sampleVolume: p.sampleVolume, customSampleBank: p.customSampleBank });

    w.push('[TimingPoints]');

    // In osu!taiko and osu!mania, a scroll speed is stored as "slider velocity" in legacy formats.
    const scrollSpeedEncodedAsSliderVelocity = this.rulesetId === 1 || this.rulesetId === 3;

    // ControlPointInfo.Add skips points redundant with the one active at their time.
    const addDifficulty = (time: number, sv: number) => {
      if (difficulty.list.length > 0 && difficulty.at(time).sliderVelocity === sv && difficulty.at(time).time <= time) return;
      difficulty.put({ time, sliderVelocity: sv });
    };
    const addSample = (p: { time: number; sampleBank: string; sampleVolume: number; customSampleBank: number }) => {
      const cur = sample.at(p.time);
      if (sample.list.length > 0 && cur.time <= p.time && cur.sampleBank === p.sampleBank && cur.sampleVolume === p.sampleVolume && cur.customSampleBank === p.customSampleBank) return;
      sample.put(p);
    };

    // extractDifficultyControlPoints
    if (!scrollSpeedEncodedAsSliderVelocity) {
      let last: number | null = null;
      for (const h of [...b.hitObjects].filter(h => h.kind === 'slider').sort((x, y) => x.startTime - y.startTime)) {
        if (last === h.sliderVelocityMultiplier) continue;
        addDifficulty(h.startTime, h.sliderVelocityMultiplier);
        last = h.sliderVelocityMultiplier;
      }
    }

    // extractSampleControlPoints
    {
      const collected: { time: number; sampleBank: string; sampleVolume: number; customSampleBank: number }[] = [];
      const pointFor = (time: number, samples: readonly HitSampleInfo[]) => ({
        time,
        sampleVolume: Math.max(...samples.map(s => s.volume)),
        sampleBank: samples.find(s => s.name === HIT_NORMAL)?.bank ?? samples[0].bank,
        customSampleBank: Math.max(...samples.map(s => s.customSampleBank)),
      });
      for (const h of b.hitObjects) {
        if (h.kind === 'slider') {
          const spanDuration = h.duration / h.spanCount;
          for (let i = 0; i < h.nodeSamples.length; i++) {
            const nodeTime = h.startTime + i * spanDuration;
            if (h.nodeSamples[i].length > 0) collected.push(pointFor(nodeTime, h.nodeSamples[i]));
            if (spanDuration > CONTROL_POINT_LENIENCY + 1 && h.samples.length > 0 && i < h.nodeSamples.length - 1) collected.push(pointFor(nodeTime + CONTROL_POINT_LENIENCY + 1, h.samples));
          }
        } else if (h.samples.length > 0) collected.push(pointFor(h.endTime, h.samples));
      }
      collected.sort((x, y) => x.time - y.time);
      let last: (typeof collected)[number] | null = null;
      for (const p of collected) {
        if (last && last.sampleBank === p.sampleBank && last.sampleVolume === p.sampleVolume && last.customSampleBank === p.customSampleBank) continue;
        addSample(p);
        last = p;
      }
    }

    if (scrollSpeedEncodedAsSliderVelocity) for (const p of effect.list) difficulty.put({ time: p.time, sliderVelocity: p.scrollSpeed });

    const times = [...new Set([...timing.list, ...difficulty.list, ...effect.list, ...sample.list].map(p => p.time))].sort((x, y) => x - y);
    let last: Props = { sliderVelocity: 0, timingSignature: 0, sampleBank: 0, customSampleBank: 0, sampleVolume: 0, effectFlags: 0 };

    const propsAt = (time: number, updateSampleBank: boolean): Props => {
      const t = timing.at(time);
      const s = sample.at(time);
      const e = effect.at(time);
      let effectFlags = LegacyEffectFlags.None;
      if (e.kiaiMode) effectFlags |= LegacyEffectFlags.Kiai;
      if (t.omitFirstBarLine) effectFlags |= LegacyEffectFlags.OmitFirstBarLine;
      return {
        sliderVelocity: difficulty.at(time).sliderVelocity,
        timingSignature: t.timeSignature,
        sampleBank: updateSampleBank ? toLegacySampleBank(s.sampleBank) : last.sampleBank,
        customSampleBank: s.customSampleBank >= 0 ? s.customSampleBank : last.customSampleBank,
        sampleVolume: s.sampleVolume,
        effectFlags,
      };
    };
    const output = (p: Props, isTiming: boolean) => `${p.timingSignature},${p.sampleBank},${p.customSampleBank},${p.sampleVolume},${isTiming ? '1' : '0'},${p.effectFlags}`;

    for (const time of times) {
      const groupTiming = timing.list.find(p => p.time === time);
      const props = propsAt(time, groupTiming != null);
      if (groupTiming) {
        const timingProps: Props = { ...props, sliderVelocity: 1, effectFlags: props.effectFlags & ~LegacyEffectFlags.Kiai };
        w.push(`${num(groupTiming.time)},${num(groupTiming.beatLength)},${output(timingProps, true)}`);
        last = timingProps;
      }
      if (isRedundant(props, last)) continue;
      w.push(`${num(time)},${num(-100 / props.sliderVelocity)},${output(props, false)}`);
      last = props;
    }
  }

  private handleColours(): void {
    const b = this.beatmap;
    const w = this.lines;
    w.push('[Colours]');
    b.comboColours.slice(0, MAX_COMBO_COLOUR_COUNT).forEach((c, i) => w.push(`Combo${i + 1}: ${c[0]},${c[1]},${c[2]},255`));
    for (const [key, c] of Object.entries(b.customColours)) w.push(`${key}: ${c[0]},${c[1]},${c[2]},${c[3] ?? 255}`);
  }

  private handleHitObjects(): void {
    const w = this.lines;
    w.push('[HitObjects]');
    for (const h of this.beatmap.hitObjects) w.push(this.hitObjectLine(h));
  }

  private hitObjectLine(h: ConvertHitObject): string {
    let x = 256;
    let y = 192;
    if (this.rulesetId === 0 || this.rulesetId === 2 || this.rulesetId === 3) {
      // Mania keeps the raw x the column was decoded from.
      x = h.x;
      y = this.rulesetId === 3 ? 192 : h.y;
    }
    let line = `${num(x)},${num(y)},${num(h.startTime)},${this.objectType(h)},${toLegacyHitSoundType(h.samples)},`;
    if (h.kind === 'slider') {
      line += this.pathData(h, x, y);
      line += this.sampleBank(h.samples);
    } else {
      if (h.kind === 'spinner' || h.kind === 'hold') line += `${num(h.endTime)}${this.objectType(h) & LegacyHitObjectType.Hold ? ':' : ','}`;
      line += this.sampleBank(h.samples);
    }
    return line;
  }

  private objectType(h: ConvertHitObject): number {
    let type = h.comboOffset << 4;
    if (h.newCombo) type |= LegacyHitObjectType.NewCombo;
    if (h.kind === 'slider') type |= LegacyHitObjectType.Slider;
    else if (h.kind === 'spinner' || h.kind === 'hold') type |= this.rulesetId === 3 ? LegacyHitObjectType.Hold : LegacyHitObjectType.Spinner;
    else type |= LegacyHitObjectType.Circle;
    return type;
  }

  private pathData(h: ConvertHitObject, x: number, y: number): string {
    let s = '';
    const cps = h.path.controlPoints;
    for (let i = 0; i < cps.length; i++) {
      const p = cps[i];
      if (p.type) {
        switch (p.type.type) {
          case 'BSpline':
            s += (p.type.degree ?? 0) > 0 ? `B${p.type.degree}|` : 'B|';
            break;
          case 'Catmull':
            s += 'C|';
            break;
          case 'PerfectCurve':
            s += 'P|';
            break;
          case 'Linear':
            s += 'L|';
            break;
        }
      }
      if (i !== 0) {
        s += `${num(x + p.position.x)}:${num(y + p.position.y)}`;
        s += i !== cps.length - 1 ? '|' : ',';
      }
    }
    s += `${h.repeatCount + 1},`;
    s += `${num(h.path.expectedDistance ?? h.path.distance)},`;
    const spans = h.spanCount;
    for (let i = 0; i < spans + 1; i++) {
      s += `${i < h.nodeSamples.length ? toLegacyHitSoundType(h.nodeSamples[i]) : 0}`;
      s += i !== spans ? '|' : ',';
    }
    for (let i = 0; i < spans + 1; i++) {
      s += i < h.nodeSamples.length ? this.sampleBank(h.nodeSamples[i], true) : '0:0';
      s += i !== spans ? '|' : ',';
    }
    return s;
  }

  private sampleBank(samples: readonly HitSampleInfo[], banksOnly = false): string {
    const normal = samples.filter(s => s.name === HIT_NORMAL);
    const normalBank = toLegacySampleBank(normal.length === 1 ? normal[0].bank : null);
    const addBank = toLegacySampleBank(samples.find(s => s.name && s.name !== HIT_NORMAL && !s.editorAutoBank)?.bank);
    let sb = `${normalBank}:${addBank}`;
    if (!banksOnly) {
      let customSampleBank = samples.find(s => s.name)?.customSampleBank ?? 0;
      const sampleFilename = samples.find(s => s.filename)?.filename ?? '';
      let volume = samples[0]?.volume ?? 100;
      // Custom sample banks and volume are only kept for osu!mania (they're satisfied by the control points otherwise).
      if (this.rulesetId !== 3) {
        customSampleBank = 0;
        volume = 0;
      }
      sb += `:${customSampleBank}:${volume}:${sampleFilename}`;
    }
    return sb;
  }
}


