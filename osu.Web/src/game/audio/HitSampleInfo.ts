// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game/Audio/HitSampleInfo.cs + ConvertHitObjectParser.LegacyHitSampleInfo / FileHitSampleInfo.

export const HIT_NORMAL = 'hitnormal';
export const HIT_WHISTLE = 'hitwhistle';
export const HIT_FINISH = 'hitfinish';
export const HIT_CLAP = 'hitclap';
export const BANK_NORMAL = 'normal';
export const BANK_SOFT = 'soft';
export const BANK_DRUM = 'drum';

export class HitSampleInfo {
  readonly name: string;
  readonly bank: string;
  readonly suffix: string | null;
  readonly volume: number;
  readonly editorAutoBank: boolean;
  readonly useBeatmapSamples: boolean;
  readonly bankSpecified: boolean;
  readonly isLayered: boolean;
  /** Set for samples which reference a specific file in the beatmap set. */
  readonly filename: string | null;

  constructor(opts: {
    name: string;
    bank?: string | null;
    volume?: number;
    editorAutoBank?: boolean;
    customSampleBank?: number;
    isLayered?: boolean;
    filename?: string | null;
  }) {
    const csb = opts.customSampleBank ?? 0;
    this.name = opts.name;
    this.bank = opts.bank || BANK_NORMAL;
    this.bankSpecified = !!opts.bank;
    this.suffix = csb >= 2 ? String(csb) : null;
    this.volume = opts.volume ?? 0;
    this.editorAutoBank = opts.editorAutoBank ?? false;
    this.useBeatmapSamples = csb >= 1;
    this.isLayered = opts.isLayered ?? false;
    this.filename = opts.filename ?? null;
  }

  get customSampleBank(): number {
    if (this.suffix != null) return parseInt(this.suffix, 10);
    return this.useBeatmapSamples ? 1 : 0;
  }

  with(changes: { name?: string; bank?: string; volume?: number; customSampleBank?: number; isLayered?: boolean }): HitSampleInfo {
    if (this.filename != null) {
      return new HitSampleInfo({ name: HIT_NORMAL, bank: BANK_NORMAL, customSampleBank: 1, volume: changes.volume ?? this.volume, filename: this.filename });
    }
    return new HitSampleInfo({
      name: changes.name ?? this.name,
      bank: changes.bank ?? (this.bankSpecified ? this.bank : null),
      volume: changes.volume ?? this.volume,
      editorAutoBank: this.editorAutoBank,
      customSampleBank: changes.customSampleBank ?? this.customSampleBank,
      isLayered: changes.isLayered ?? this.isLayered,
    });
  }

  /** Names to look up, most specific first. Beatmap-provided names are prefixed with "beatmap:". */
  get lookupNames(): string[] {
    const names: string[] = [];
    if (this.filename) {
      names.push(`beatmap:${this.filename}`);
      names.push(`beatmap:${this.filename.replace(/\.[^.]+$/, '')}`);
    }
    if (this.useBeatmapSamples) {
      names.push(`beatmap:${this.bank}-${this.name}${this.suffix ?? ''}`);
    }
    names.push(`${this.bank}-${this.name}`);
    names.push(this.name);
    return names;
  }
}
