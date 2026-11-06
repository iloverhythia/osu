// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game.Rulesets.Mania/Objects/{ManiaHitObject,Note,HeadNote,TailNote,HoldNote,HoldNoteBody}.cs
// and the judgements in osu.Game.Rulesets.Mania/Judgements.

import type { HitSampleInfo } from '../../../audio/HitSampleInfo';
import { HitResult } from '../../../scoring/HitResult';
import { judgement, type Judgement } from '../../../scoring/Judgement';
import { ManiaHitWindows } from '../scoring/ManiaHitWindows';

/** ManiaJudgement (Perfect / Miss). */
export const MANIA_JUDGEMENT: Judgement = judgement(HitResult.Perfect, HitResult.Miss);
/** HoldNoteBodyJudgement. */
export const HOLD_BODY_JUDGEMENT: Judgement = judgement(HitResult.IgnoreHit, HitResult.ComboBreak);
/** IgnoreJudgement (used by HoldNote itself). */
export const IGNORE_JUDGEMENT: Judgement = judgement(HitResult.IgnoreHit, HitResult.IgnoreMiss);

export abstract class ManiaHitObject {
  startTime = 0;
  samples: HitSampleInfo[] = [];
  protected _column = 0;

  get column(): number {
    return this._column;
  }

  set column(v: number) {
    this._column = v;
  }

  abstract get endTime(): number;
  abstract readonly judgement: Judgement;
  /** Null when the object uses HitWindows.Empty. */
  hitWindows: ManiaHitWindows | null = null;

  /** HitObject.ApplyDefaults: create hit windows + nested objects. */
  applyDefaults(overallDifficulty: number): void {
    this.hitWindows = this.createHitWindows();
    this.hitWindows?.setDifficulty(overallDifficulty);
  }

  protected createHitWindows(): ManiaHitWindows | null {
    return new ManiaHitWindows();
  }
}

/** Represents a hit object which has a single hit press. */
export class Note extends ManiaHitObject {
  readonly judgement = MANIA_JUDGEMENT;

  get endTime(): number {
    return this.startTime;
  }
}

/** The head note of a HoldNote. */
export class HeadNote extends Note {}

/** The tail note of a HoldNote. */
export class TailNote extends Note {
  /**
   * Lenience of release hit windows. This is to make cases where the hold note release
   * is timed alongside presses of other hit objects less awkward.
   */
  static readonly RELEASE_WINDOW_LENIENCE = 1.5;
}

/** Invisible and silent object that tracks the holding state of a HoldNote. */
export class HoldNoteBody extends ManiaHitObject {
  readonly judgement = HOLD_BODY_JUDGEMENT;
  duration = 0;

  get endTime(): number {
    return this.startTime + this.duration;
  }

  protected createHitWindows(): ManiaHitWindows | null {
    return null;
  }
}

/** Represents a hit object which requires pressing, holding, and releasing a key. */
export class HoldNote extends ManiaHitObject {
  readonly judgement = IGNORE_JUDGEMENT;
  duration = 0;
  nodeSamples: HitSampleInfo[][] | null = null;
  /** Whether sliding samples should be played when held. */
  playSlidingSamples = false;

  head: HeadNote | null = null;
  tail: TailNote | null = null;
  body: HoldNoteBody | null = null;

  get endTime(): number {
    return this.startTime + this.duration;
  }

  get column(): number {
    return this._column;
  }

  set column(v: number) {
    this._column = v;
    if (this.head) this.head.column = v;
    if (this.tail) this.tail.column = v;
  }

  protected createHitWindows(): ManiaHitWindows | null {
    return null;
  }

  applyDefaults(overallDifficulty: number): void {
    super.applyDefaults(overallDifficulty);
    this.createNestedHitObjects();
    this.head!.applyDefaults(overallDifficulty);
    this.tail!.applyDefaults(overallDifficulty);
    this.body!.applyDefaults(overallDifficulty);
  }

  private createNestedHitObjects(): void {
    // Generally node samples will be populated by ManiaBeatmapConverter, but ensure they are set to a sane default.
    this.nodeSamples ??= HoldNote.createDefaultNodeSamples(this.samples);

    const head = new HeadNote();
    head.startTime = this.startTime;
    head.column = this.column;
    head.samples = this.getNodeSamples(0);
    this.head = head;

    const tail = new TailNote();
    tail.startTime = this.endTime;
    tail.column = this.column;
    tail.samples = this.getNodeSamples(this.nodeSamples.length - 1);
    this.tail = tail;

    const body = new HoldNoteBody();
    body.startTime = this.startTime;
    body.column = this.column;
    body.duration = this.duration;
    this.body = body;
  }

  /** Nested objects in creation order (Head, Tail, Body). */
  get nested(): ManiaHitObject[] {
    return this.head ? [this.head, this.tail!, this.body!] : [];
  }

  getNodeSamples(nodeIndex: number): HitSampleInfo[] {
    const ns = this.nodeSamples;
    if (ns && nodeIndex >= 0 && nodeIndex < ns.length) return ns[nodeIndex];
    return this.samples;
  }

  /** HitObject.CreateSlidingSamples */
  createSlidingSamples(): HitSampleInfo[] {
    const out: HitSampleInfo[] = [];
    const normal = this.samples.find(s => s.name === 'hitnormal');
    if (normal) out.push(normal.with({ name: 'sliderslide' }));
    const whistle = this.samples.find(s => s.name === 'hitwhistle');
    if (whistle) out.push(whistle.with({ name: 'sliderwhistle' }));
    return out;
  }

  /** By default, osu!mania beatmaps only play samples at the start of the hold note. */
  static createDefaultNodeSamples(samples: HitSampleInfo[]): HitSampleInfo[][] {
    return [samples, []];
  }
}

/** Whether this is a playable Note (including hold heads / tails). */
export const isNote = (h: ManiaHitObject): h is Note => h instanceof Note;
