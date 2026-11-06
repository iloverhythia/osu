// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Gameplay + rendering for osu!mania. Ports the judgement logic of
// osu.Game.Rulesets.Mania/Objects/Drawables/{DrawableNote,DrawableHoldNote,DrawableHoldNoteHead,DrawableHoldNoteTail,DrawableHoldNoteBody}.cs,
// Judgements/HoldNoteJudgementResult.cs, UI/{Column,Stage,OrderedHitPolicy,DrawableManiaRuleset,PlayfieldCoveringWrapper}.cs,
// GameplaySampleTriggerSource.cs, ManiaModHidden/FadeIn/Flashlight, and draws an argon-like skin procedurally.

import { generateBarLines, type BarLine } from '../../../objects/BarLineGenerator';
import { COLOURS } from '../../../Skin';
import { HitResult, isHit } from '../../../scoring/HitResult';
import type { JudgementResult } from '../../../scoring/Judgement';
import type { DrawableRuleset, GameplayContext, LoopHandle } from '../../Ruleset';
import { actionId } from '../input/ManiaInput';
import type { ManiaPlayableBeatmap } from '../ManiaPlayableBeatmap';
import { tagFor } from '../ManiaPlayableBeatmap';
import { HoldNote, TailNote, type HeadNote, type HoldNoteBody, type ManiaHitObject, type Note } from '../objects/ManiaHitObject';
import { generateManiaAutoplay, type ManiaReplayFrame } from '../replays/ManiaAutoGenerator';
import { columnColour, css, darkenC4, lightenC4, mixC4, type RGB } from './ManiaColours';
import { computeScrollTime, MAX_TIME_RANGE, SequentialScroll } from './ScrollAlgorithm';

// ---- Layout constants (reference 1024x768 space, argon skin) ----
const COLUMN_WIDTH = 60;
const COLUMN_SPACING = 1; // left + right margin of each column
const STAGE_PADDING = 30;
const STAGE_SPACING = 30;
/** Stage.HIT_TARGET_POSITION */
const HIT_TARGET_POSITION = 110;
const NOTE_HEIGHT = 42;
const NOTE_ACCENT_RATIO = 0.82;
const CORNER_RADIUS = 3.4;
/** ArgonJudgementPiece.judgement_y_position */
const JUDGEMENT_Y = 180;
/** PoolableHitExplosion.DURATION */
const EXPLOSION_DURATION = 200;
/** ManiaModHidden constants */
const REFERENCE_PLAYFIELD_HEIGHT = 768;
const HIDDEN_MIN_COVERAGE = 160;
const HIDDEN_MAX_COVERAGE = 400;
const HIDDEN_COVERAGE_PER_COMBO = 0.5;
/** ManiaModFlashlight.DefaultFlashlightSize */
const FLASHLIGHT_SIZE = 50;
/** DrawableManiaHitObject miss fade */
const MISS_FADE = 150;

const JUDGEMENT_TEXT: Partial<Record<HitResult, string>> = {
  [HitResult.Perfect]: 'PERFECT',
  [HitResult.Great]: 'GREAT',
  [HitResult.Good]: 'GOOD',
  [HitResult.Ok]: 'OK',
  [HitResult.Meh]: 'MEH',
  [HitResult.Miss]: 'MISS',
};

const JUDGEMENT_COLOUR: Partial<Record<HitResult, string>> = {
  [HitResult.Perfect]: COLOURS.perfect,
  [HitResult.Great]: COLOURS.great,
  [HitResult.Good]: COLOURS.good,
  [HitResult.Ok]: COLOURS.ok,
  [HitResult.Meh]: COLOURS.meh,
  [HitResult.Miss]: COLOURS.miss,
};

const easeOutQuint = (t: number): number => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 5);
const easeInQuint = (t: number): number => Math.pow(Math.min(1, Math.max(0, t)), 5);
const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t);

// ---- Runtime judgement state ----

class JudgeState {
  judged = false;
  result = HitResult.None;
  judgeTime = 0;

  get isHit(): boolean {
    return this.judged && isHit(this.result);
  }
}

class DNote extends JudgeState {
  constructor(
    readonly obj: Note,
    readonly parent: DHold | null,
  ) {
    super();
  }

  get startTime(): number {
    return this.obj.startTime;
  }

  get allJudged(): boolean {
    return this.judged;
  }
}

class DBody extends JudgeState {
  constructor(
    readonly obj: HoldNoteBody,
    readonly parent: DHold,
  ) {
    super();
  }
}

/** DrawableHoldNote + HoldNoteJudgementResult holding state. */
class DHold extends JudgeState {
  readonly head: DNote;
  readonly tail: DNote;
  readonly body: DBody;
  /** HoldNoteJudgementResult.holdingState (as a stack). */
  private readonly holdingState: { time: number; holding: boolean }[] = [{ time: -Infinity, holding: false }];
  loops: LoopHandle[] | null = null;

  constructor(readonly obj: HoldNote) {
    super();
    this.head = new DNote(obj.head as HeadNote, this);
    this.tail = new DNote(obj.tail as TailNote, this);
    this.body = new DBody(obj.body!, this);
  }

  get startTime(): number {
    return this.obj.startTime;
  }

  get allJudged(): boolean {
    return this.judged && this.head.judged && this.tail.judged && this.body.judged;
  }

  /** DrawableHoldNoteBody.HasHoldBreak */
  get hasHoldBreak(): boolean {
    return this.body.judged && !this.body.isHit;
  }

  private getLastReport(currentTime: number): { time: number; holding: boolean } {
    // Note: lazer pops states newer than `currentTime` to support rewinding. Gameplay here never rewinds
    // (input times are clamped to the current time), so the lookup is non-destructive and safe to use while rendering.
    for (let i = this.holdingState.length - 1; i >= 0; i--) if (this.holdingState[i].time <= currentTime) return this.holdingState[i];
    return this.holdingState[0];
  }

  isHolding(currentTime: number): boolean {
    return this.getLastReport(currentTime).holding;
  }

  droppedHoldAfter(time: number): boolean {
    for (const state of this.holdingState) if (state.time >= time && !state.holding) return true;
    return false;
  }

  reportHoldState(currentTime: number, holding: boolean): void {
    const lastReport = this.getLastReport(currentTime);
    if (holding !== lastReport.holding) this.holdingState.push({ time: currentTime, holding });
  }

  /** DrawableHoldNote.MissingStartTime (set once any part has been missed). */
  get isMissing(): boolean {
    return (this.head.judged && !this.head.isHit) || this.hasHoldBreak || (this.tail.judged && !this.tail.isHit);
  }
}

type DObj = DNote | DHold;

interface Explosion {
  time: number;
}

interface ColumnState {
  index: number;
  objects: DObj[];
  /** First object which is not fully judged / finished rendering. */
  firstActive: number;
  keyboardDown: boolean;
  touchCount: number;
  down: boolean;
  pressTime: number;
  releaseTime: number;
  colour: RGB;
  special: boolean;
  /** GameplaySampleTriggerSource.mostValidObject */
  mostValid: DObj | null;
  explosion: Explosion | null;
  // layout (reference units)
  x: number;
  width: number;
  stage: number;
}

interface NotePieceStyle {
  shadow: CanvasGradient;
  accent: CanvasGradient;
  accentTop: number;
  accentH: number;
  tailFill: string;
  tailHighlight: CanvasGradient;
}

interface JudgementDisplay {
  result: HitResult;
  time: number;
}

interface Layout {
  width: number;
  height: number;
  scale: number;
  /** Reference-space size. */
  W: number;
  H: number;
  stageLeft: number[];
  stageWidth: number[];
  hitY: number;
  scrollLength: number;
  top: number;
  bottom: number;
}

export class DrawableManiaRuleset implements DrawableRuleset {
  readonly drawsCursor = false;
  readonly leadInTime: number;

  private readonly columns: ColumnState[] = [];
  private readonly holds: DHold[] = [];
  private readonly allObjects: DObj[] = [];
  private readonly scroll: SequentialScroll;
  private readonly barLines: BarLine[];
  private readonly timeRange: number;
  private readonly upwards: boolean;
  private readonly totalColumns: number;
  private readonly stageJudgements: (JudgementDisplay | null)[];
  private readonly frames: ManiaReplayFrame[] = [];
  private frameIndex = 0;
  private readonly autoplay: boolean;
  private readonly touches = new Map<number, number>();

  private currentTime = -Infinity;
  private remaining: number;
  private layout: Layout | null = null;
  private layer: HTMLCanvasElement | null = null;
  private coverage = 0;
  private flashlightSize = FLASHLIGHT_SIZE;
  private lastUpdateTime: number | null = null;

  constructor(
    private readonly playable: ManiaPlayableBeatmap,
    private readonly ctx: GameplayContext,
  ) {
    const settings = ctx.settings;
    const scrollSpeed = Math.min(40, Math.max(1, Number(settings.get('mania.scrollSpeed', 8)) || 8));
    this.upwards = settings.get<string>('mania.scrollDirection', 'down') === 'up';
    // DrawableManiaRuleset.updateTimeRange: TargetTimeRange * tempo * frequency (hit position at the default 110 => scale 1).
    this.timeRange = Math.min(MAX_TIME_RANGE, Math.max(1, computeScrollTime(scrollSpeed) * ctx.rate));
    this.leadInTime = this.timeRange;

    const objects = playable.hitObjects;
    const lastObjectTime = objects.length > 0 ? Math.max(...objects.map(h => h.endTime)) : null;
    this.scroll = SequentialScroll.forMania(playable.source.controlPoints, playable.source.difficulty.sliderMultiplier, lastObjectTime, playable.isConvert);
    this.barLines = objects.length > 0 ? generateBarLines(playable.source.controlPoints, objects[0].startTime, objects[objects.length - 1].endTime) : [];

    this.totalColumns = playable.totalColumns;
    let columnIndex = 0;
    playable.stages.forEach((stageColumns, stageIndex) => {
      for (let i = 0; i < stageColumns; i++, columnIndex++) {
        this.columns.push({
          index: columnIndex,
          objects: [],
          firstActive: 0,
          keyboardDown: false,
          touchCount: 0,
          down: false,
          pressTime: -Infinity,
          releaseTime: -Infinity,
          colour: columnColour(i, stageColumns),
          special: stageColumns % 2 === 1 && i === Math.trunc(stageColumns / 2),
          mostValid: null,
          explosion: null,
          x: 0,
          width: COLUMN_WIDTH,
          stage: stageIndex,
        });
      }
    });
    this.stageJudgements = playable.stages.map(() => null);

    for (const h of objects) {
      const d: DObj = h instanceof HoldNote ? new DHold(h) : new DNote(h as Note, null);
      if (d instanceof DHold) this.holds.push(d);
      this.allObjects.push(d);
      const column = this.columns[Math.min(this.columns.length - 1, Math.max(0, h.column))];
      column.objects.push(d);
    }
    this.remaining = this.allObjects.length;

    this.autoplay = ctx.autoplay;
    if (this.autoplay) this.frames = generateManiaAutoplay(objects);
  }

  get hasCompleted(): boolean {
    return this.remaining === 0;
  }

  // =====================================================================================
  // Input
  // =====================================================================================

  private columnForAction(action: string): ColumnState | null {
    if (action.length < 2 || action[0] !== 'K') return null;
    const index = parseInt(action.slice(1), 10) - 1;
    return this.columns[index] ?? null;
  }

  onPressed(action: string, time: number): void {
    if (this.autoplay) return;
    const column = this.columnForAction(action);
    if (!column) return;
    column.keyboardDown = true;
    this.updateColumnDown(column, time);
  }

  onReleased(action: string, time: number): void {
    if (this.autoplay) return;
    const column = this.columnForAction(action);
    if (!column) return;
    column.keyboardDown = false;
    this.updateColumnDown(column, time);
  }

  onTouchStart(id: number, x: number, _y: number, time: number): void {
    if (this.autoplay) return;
    const column = this.columnAtX(x);
    if (!column) return;
    this.touches.set(id, column.index);
    column.touchCount++;
    this.updateColumnDown(column, time);
  }

  onTouchMove(): void {
    // Columns keep their touch until it is released (Column.OnTouchDown / OnTouchUp).
  }

  onTouchEnd(id: number, _x: number, _y: number, time: number): void {
    const index = this.touches.get(id);
    if (index === undefined) return;
    this.touches.delete(id);
    const column = this.columns[index];
    column.touchCount = Math.max(0, column.touchCount - 1);
    this.updateColumnDown(column, time);
  }

  private columnAtX(x: number): ColumnState | null {
    const l = this.layout;
    if (!l || this.columns.length === 0) return null;
    const rx = x / l.scale;
    let best: ColumnState | null = null;
    let bestDist = Infinity;
    for (const c of this.columns) {
      // Column.ReceivePositionalInputAt: inflated by column spacing.
      const left = c.x - COLUMN_SPACING;
      const right = c.x + c.width + COLUMN_SPACING;
      if (rx >= left && rx <= right) return c;
      const dist = rx < left ? left - rx : rx - right;
      if (dist < bestDist) {
        bestDist = dist;
        best = c;
      }
    }
    // Outside the stage: the nearest column takes the touch (so the screen edges stay usable on phones).
    return best;
  }

  private updateColumnDown(column: ColumnState, time: number): void {
    const down = column.keyboardDown || column.touchCount > 0;
    if (down === column.down) return;
    if (down) this.pressColumn(column, time);
    else this.releaseColumn(column, time);
  }

  private pressColumn(column: ColumnState, time: number): void {
    // Input is never processed in the past (results up to the current time have already been applied).
    time = Math.max(time, this.currentTime);
    this.advanceTo(time);
    column.down = true;
    column.pressTime = time;

    // Earlier hitobjects handle input first; the first one that handles the press consumes it.
    const lookahead = time + 2000;
    let handled = false;
    for (let i = column.firstActive; i < column.objects.length; i++) {
      const obj = column.objects[i];
      if (obj.startTime > lookahead) break;
      handled = obj instanceof DHold ? this.pressHold(column, i, obj, time) : this.pressNote(column, i, obj, time);
      if (handled) break;
    }

    // Column.OnPressed: play the most appropriate hit sound when no object consumed the press.
    if (!handled) this.playMostValidSamples(column, time);
  }

  private releaseColumn(column: ColumnState, time: number): void {
    time = Math.max(time, this.currentTime);
    this.advanceTo(time);
    column.down = false;
    column.releaseTime = time;

    for (let i = column.firstActive; i < column.objects.length; i++) {
      const obj = column.objects[i];
      if (obj.startTime > time + 2000) break;
      if (obj instanceof DHold) this.releaseHold(obj, time);
    }
  }

  /** OrderedHitPolicy.IsHittable */
  private isHittable(column: ColumnState, index: number, time: number): boolean {
    const next = column.objects[index + 1];
    return next === undefined || time < next.startTime;
  }

  /** DrawableNote.OnPressed */
  private pressNote(column: ColumnState, index: number, note: DNote, time: number): boolean {
    if (note.judged) return false;
    if (!this.isHittable(column, index, time)) return false;
    return this.updateNoteResult(note, true, time);
  }

  /** DrawableHoldNote.OnPressed */
  private pressHold(column: ColumnState, index: number, hold: DHold, time: number): boolean {
    if (hold.allJudged) return false;
    if (!this.isHittable(column, index, time)) return false;

    // The tail has a lenience applied to it which is factored into the miss window (i.e. the miss judgement will be delayed).
    // But the hold cannot ever be started within the late-lenience window, so we should skip trying to begin the hold during that time.
    const tail = hold.tail.obj;
    if (time > tail.startTime && !tail.hitWindows!.canBeHit(time - tail.startTime)) return false;

    // beginHoldAt
    const head = hold.head.obj;
    if (!(time - head.startTime < -head.hitWindows!.windowFor(HitResult.Miss))) hold.reportHoldState(time, true);

    return this.updateNoteResult(hold.head, true, time);
  }

  /** DrawableHoldNote.OnReleased */
  private releaseHold(hold: DHold, time: number): void {
    if (hold.allJudged) return;

    // When our action is released and we are in the middle of a hold, there's a chance that
    // the user has released too early (before the tail). In such a case, record this against the body.
    if (hold.isHolding(time)) {
      this.updateNoteResult(hold.tail, true, time);
      this.triggerBodyResult(hold, hold.tail.isHit, time);
      hold.reportHoldState(time, false);
    }
  }

  /** DrawableHitObject.UpdateResult for notes / heads / tails. Returns whether the object is now judged. */
  private updateNoteResult(note: DNote, userTriggered: boolean, time: number): boolean {
    if (note.judged) return false;
    let timeOffset = time - note.obj.endTime;
    const windows = note.obj.hitWindows!;

    // DrawableHoldNoteTail: factor in the release lenience
    const isTail = note.obj instanceof TailNote;
    if (isTail) timeOffset /= TailNote.RELEASE_WINDOW_LENIENCE;

    if (!userTriggered) {
      if (!windows.canBeHit(timeOffset)) this.applyResult(note, HitResult.Miss, time);
      return note.judged;
    }

    let result = windows.resultFor(timeOffset);
    if (result === HitResult.None) return false;

    if (isTail && note.parent) {
      // If the head wasn't hit or the hold note was broken, cap the max score to Meh.
      const hasComboBreak = !note.parent.head.isHit || note.parent.hasHoldBreak;
      if (result > HitResult.Meh && hasComboBreak) result = HitResult.Meh;
    }

    this.applyResult(note, result, time);
    return note.judged;
  }

  /** DrawableHoldNoteBody.TriggerResult */
  private triggerBodyResult(hold: DHold, hit: boolean, time: number): void {
    if (hold.body.judged) return;
    this.applyResult(hold.body, hit ? HitResult.IgnoreHit : HitResult.ComboBreak, time);
  }

  /** DrawableManiaHitObject.MissForcefully (+ DrawableHoldNote override). */
  private missForcefully(obj: DObj | DBody, time: number): void {
    if (obj instanceof DHold) {
      this.applyResult(obj, HitResult.IgnoreMiss, time);
      obj.reportHoldState(time, false);
    } else if (obj instanceof DBody) {
      this.applyResult(obj, HitResult.ComboBreak, time);
    } else {
      this.applyResult(obj, HitResult.Miss, time);
    }
  }

  private applyResult(state: DNote | DBody | DHold, type: HitResult, time: number): void {
    if (state.judged) return;
    const obj: ManiaHitObject = state.obj;

    state.judged = true;
    state.result = type;
    state.judgeTime = time;

    // JudgementResult.TimeOffset is clamped by HitObject.MaximumJudgementOffset.
    const maxOffset = maximumJudgementOffset(obj);
    const result: JudgementResult = {
      hitObject: obj,
      judgement: obj.judgement,
      type,
      timeOffset: Math.min(time - obj.endTime, maxOffset),
      objectEndTime: obj.endTime,
      tag: tagFor(obj),
      gameplayRate: this.ctx.rate,
    };

    // DrawableHitObject.UpdateState(Hit) -> PlaySamples (DrawableHoldNote / body play nothing themselves).
    if (state instanceof DNote && isHit(type) && state.obj.samples.length > 0) this.ctx.playSamples(state.obj.samples, { pan: this.panFor(obj.column) });

    this.ctx.applyResult(result);

    // Track top-level objects becoming fully judged (each transition happens exactly once).
    const topLevel: DObj = state instanceof DHold ? state : state instanceof DBody ? state.parent : (state.parent ?? state);
    if (topLevel.allJudged) this.remaining--;

    const column = this.columns[obj.column];
    if (!column) return;

    // Stage.OnNewResult: judgement display (notes, heads and tails only).
    const displayResult = state instanceof DNote;
    if (displayResult) this.stageJudgements[column.stage] = { result: type, time };

    // Column.OnNewResult
    if (isHit(type)) {
      this.handleHit(column, obj.startTime, time);
      if (displayResult) column.explosion = { time };
    }
  }

  /** OrderedHitPolicy.HandleHit: miss all earlier unjudged objects in the column. */
  private handleHit(column: ColumnState, targetTime: number, time: number): void {
    for (let i = column.firstActive; i < column.objects.length; i++) {
      const obj = column.objects[i];
      if (obj.obj.endTime >= targetTime) return;

      if (!obj.judged) this.missForcefully(obj, time);

      if (obj instanceof DHold) {
        const nested: (DNote | DBody)[] = [obj.head, obj.tail, obj.body];
        for (const n of nested) {
          if (n.obj.endTime >= targetTime) break;
          if (!n.judged) this.missForcefully(n, time);
        }
      }
    }
  }

  /** GameplaySampleTriggerSource.Play */
  private playMostValidSamples(column: ColumnState, time: number): void {
    const objects = column.objects;
    if (objects.length === 0) return;

    if (column.mostValid == null || column.mostValid.allJudged) {
      let candidate: DObj | null = null;
      for (let i = column.firstActive; i < objects.length; i++) {
        if (!objects[i].allJudged) {
          candidate = objects[i];
          break;
        }
      }

      if (candidate == null) column.mostValid = objects[objects.length - 1];
      else {
        const missWindow = candidate instanceof DHold ? 0 : candidate.obj.hitWindows!.windowFor(HitResult.Miss);
        if (time >= candidate.startTime - missWindow * 2) column.mostValid = candidate;
        else column.mostValid ??= objects[0];
      }
    }

    const mv = column.mostValid;
    if (!mv) return;

    let samples = mv.obj.samples;
    if (!mv.allJudged && mv instanceof DHold) {
      // The earliest valid nested object (ordered by end time, skipping those already passed).
      const nested = [mv.obj.head!, mv.obj.tail!, mv.obj.body!].sort((a, b) => a.endTime - b.endTime);
      const next = nested.find(n => n.endTime > time);
      samples = next ? next.samples : mv.obj.samples;
    }

    if (samples.length > 0) this.ctx.playSamples(samples, { pan: this.panFor(column.index) });
  }

  private panFor(column: number): number {
    // DrawableHitObject.CalculateSamplePlaybackBalance with the default positional hitsound level (0.2).
    const position = this.totalColumns > 0 ? column / this.totalColumns : 0.5;
    return 0.4 * (position - 0.5);
  }

  // =====================================================================================
  // Update
  // =====================================================================================

  update(time: number, elapsed: number): void {
    if (this.autoplay) {
      while (this.frameIndex < this.frames.length && this.frames[this.frameIndex].time <= time) {
        const frame = this.frames[this.frameIndex++];
        this.applyReplayFrame(frame);
      }
    }

    this.advanceTo(time);
    this.updateSlidingSamples(time);
    this.updateMods(time, elapsed);
    this.lastUpdateTime = time;
  }

  private applyReplayFrame(frame: ManiaReplayFrame): void {
    const held = new Set(frame.columns);
    // Releases are processed before presses.
    for (const c of this.columns) {
      if (c.down && !held.has(c.index)) {
        c.keyboardDown = false;
        this.updateColumnDown(c, frame.time);
      }
    }
    for (const c of this.columns) {
      if (!c.down && held.has(c.index)) {
        c.keyboardDown = true;
        this.updateColumnDown(c, frame.time);
      }
    }
  }

  /** Runs the non-user-triggered judgement checks (DrawableHitObject.UpdateResult(false)) up to `time`. */
  private advanceTo(time: number): void {
    if (time < this.currentTime) time = this.currentTime;
    this.currentTime = time;

    for (const column of this.columns) {
      const objects = column.objects;
      for (let i = column.firstActive; i < objects.length; i++) {
        const obj = objects[i];
        if (obj.startTime > time) break;
        if (obj.allJudged) continue;

        if (obj instanceof DNote) this.updateNoteResult(obj, false, time);
        else this.checkHold(obj, time);
      }

      // Advance past objects which are judged and no longer visible.
      while (column.firstActive < objects.length) {
        const obj = objects[column.firstActive];
        if (!obj.allJudged || time - obj.judgeTime < MISS_FADE + 50 || time < obj.obj.endTime) break;
        column.firstActive++;
      }
    }
  }

  /** Nested checks (head, body, tail) followed by DrawableHoldNote.CheckForResult. */
  private checkHold(hold: DHold, time: number): void {
    if (!hold.head.judged) this.updateNoteResult(hold.head, false, time);
    if (!hold.tail.judged) this.updateNoteResult(hold.tail, false, time);

    if (!hold.judged && hold.tail.judged) {
      if (hold.tail.isHit) this.applyResult(hold, HitResult.IgnoreHit, time);
      else this.missForcefully(hold, time);

      // Make sure that the hold note is fully judged by giving the body a judgement.
      if (!hold.body.judged) this.triggerBodyResult(hold, hold.tail.isHit, time);

      // Important that this is always called when a result is applied.
      hold.reportHoldState(time, false);
    }
  }

  private updateSlidingSamples(time: number): void {
    for (const hold of this.holds) {
      if (!hold.obj.playSlidingSamples) continue;
      const holding = !hold.allJudged && hold.isHolding(time);
      if (holding && !hold.loops) {
        hold.loops = [];
        for (const s of hold.obj.createSlidingSamples()) {
          const handle = this.ctx.startLoop(s, { pan: this.panFor(hold.obj.column) });
          if (handle) hold.loops.push(handle);
        }
      } else if (!holding && hold.loops) {
        for (const l of hold.loops) l.stop();
        hold.loops = null;
      }
    }
  }

  private isBreakTime(time: number): boolean {
    for (const b of this.playable.breaks) if (time >= b.startTime && time <= b.endTime) return true;
    return false;
  }

  private updateMods(time: number, elapsed: number): void {
    const mods = this.ctx.mods;
    const dt = Math.abs(elapsed);

    if (mods.has('HD') || mods.has('FI')) {
      // ManiaModHidden.Update + PlayfieldCoveringWrapper.updateCoverSize (DampContinuously, half-time 25ms).
      const target = this.isBreakTime(time)
        ? 0
        : Math.min(HIDDEN_MAX_COVERAGE, HIDDEN_MIN_COVERAGE + this.ctx.combo * HIDDEN_COVERAGE_PER_COMBO) / REFERENCE_PLAYFIELD_HEIGHT;
      const lastUpdate = this.lastUpdateTime;
      if (lastUpdate == null) this.coverage = target;
      else this.coverage = target + (this.coverage - target) * Math.pow(0.5, dt / 25);
    }

    if (mods.has('FL')) {
      // ModFlashlight.GetSize: doubled in breaks (BreakTimeScale 2.5); mania doesn't use combo-based size.
      const target = FLASHLIGHT_SIZE * (this.isBreakTime(time) ? 2.5 : 1);
      this.flashlightSize += (target - this.flashlightSize) * (1 - Math.pow(0.5, dt / 120));
    }
  }

  // =====================================================================================
  // Rendering
  // =====================================================================================

  private computeLayout(width: number, height: number): Layout {
    // Column layout (reference units).
    const stageWidths: number[] = [];
    let ci = 0;
    for (const stageColumns of this.playable.stages) {
      let w = 0;
      for (let i = 0; i < stageColumns; i++, ci++) {
        const c = this.columns[ci];
        c.width = COLUMN_WIDTH * (c.special ? 2 : 1);
        w += c.width + COLUMN_SPACING * 2;
      }
      stageWidths.push(w);
    }
    const totalWidth = stageWidths.reduce((a, b) => a + b, 0) + STAGE_SPACING * (stageWidths.length - 1);

    // ManiaPlayfieldAdjustmentContainer: DrawSizePreservingFillContainer (1024x768), with a portrait special-case.
    const aspect = width / Math.max(1, height);
    let scale: number;
    if (aspect < 1 && this.playable.stages.length === 1) {
      const baseScale = 1.25;
      const baseWidth = 768 / baseScale;
      const sideGap = 0.9;
      const targetH = baseWidth * Math.max(stageWidths[0] / aspect / (baseWidth * sideGap), 1);
      scale = Math.max(width / 1024, height / targetH);
    } else {
      scale = Math.min(width / 1024, height / 768);
    }
    if (!(scale > 0)) scale = 1;

    const W = width / scale;
    const H = height / scale;

    const stageLeft: number[] = [];
    let x = (W - totalWidth) / 2;
    ci = 0;
    this.playable.stages.forEach((stageColumns, s) => {
      stageLeft.push(x);
      let cx = x;
      for (let i = 0; i < stageColumns; i++, ci++) {
        const c = this.columns[ci];
        c.x = cx + COLUMN_SPACING;
        cx += c.width + COLUMN_SPACING * 2;
      }
      x += stageWidths[s] + STAGE_SPACING;
    });

    const top = STAGE_PADDING;
    const bottom = H - STAGE_PADDING;
    const scrollLength = Math.max(1, bottom - top - HIT_TARGET_POSITION);
    const hitY = this.upwards ? top + HIT_TARGET_POSITION : bottom - HIT_TARGET_POSITION;

    return { width, height, scale, W, H, stageLeft, stageWidth: stageWidths, hitY, scrollLength, top, bottom };
  }

  /** Distance (reference units) from the hit position towards the scroll origin of an object at `time`. */
  private positionAt(time: number, currentRel: number, l: Layout): number {
    return ((this.scroll.relativeTime(time) - currentRel) / this.timeRange) * l.scrollLength;
  }

  /** Converts a distance from the hit position into a y coordinate (the edge of a note nearest to the hit target). */
  private yAt(position: number, l: Layout): number {
    return this.upwards ? l.hitY + position : l.hitY - position;
  }

  render(ctx: CanvasRenderingContext2D, width: number, height: number, time: number): void {
    if (!this.layout || this.layout.width !== width || this.layout.height !== height) this.layout = this.computeLayout(width, height);
    const l = this.layout;
    const currentRel = this.scroll.relativeTime(time);

    ctx.save();
    ctx.scale(l.scale, l.scale);

    this.drawColumnBackgrounds(ctx, l, time);
    this.drawBarLines(ctx, l, currentRel);

    const covered = this.ctx.mods.has('HD') || this.ctx.mods.has('FI');
    let target = ctx;
    if (covered) {
      const layerCtx = this.getLayer(width, height);
      if (layerCtx) {
        layerCtx.setTransform(1, 0, 0, 1, 0, 0);
        layerCtx.clearRect(0, 0, layerCtx.canvas.width, layerCtx.canvas.height);
        const dpr = layerCtx.canvas.width / Math.max(1, width);
        layerCtx.setTransform(dpr * l.scale, 0, 0, dpr * l.scale, 0, 0);
        target = layerCtx;
      }
    }

    this.drawHitTargets(ctx, l);
    this.drawObjects(target, l, time, currentRel);

    if (target !== ctx) {
      this.applyCover(target, l);
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.drawImage(target.canvas, 0, 0, ctx.canvas.width, ctx.canvas.height);
      ctx.restore();
    }

    this.drawKeyAreas(ctx, l, time);
    this.drawExplosions(ctx, l, time);
    this.drawJudgements(ctx, l, time);
    this.drawCombo(ctx, l);

    if (this.ctx.mods.has('FL')) this.drawFlashlight(ctx, l);

    ctx.restore();
  }

  private getLayer(width: number, height: number): CanvasRenderingContext2D | null {
    if (typeof document === 'undefined') return null;
    if (!this.layer) this.layer = document.createElement('canvas');
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const w = Math.max(1, Math.round(width * dpr));
    const h = Math.max(1, Math.round(height * dpr));
    if (this.layer.width !== w || this.layer.height !== h) {
      this.layer.width = w;
      this.layer.height = h;
    }
    return this.layer.getContext('2d');
  }

  private stageVerticalExtent(l: Layout): { y: number; h: number } {
    return { y: l.top, h: l.bottom - l.top };
  }

  private drawColumnBackgrounds(ctx: CanvasRenderingContext2D, l: Layout, time: number): void {
    const { y, h } = this.stageVerticalExtent(l);

    for (const c of this.columns) {
      // ArgonColumnBackground: accent darkened (x4) at 80% opacity.
      ctx.fillStyle = css(darkenC4(c.colour, 3), 0.8);
      roundRect(ctx, c.x, y, c.width, h, CORNER_RADIUS);
      ctx.fill();

      // Pressed gradient overlay over the half towards the hit target.
      let alpha: number;
      if (c.down) {
        const t = time - c.pressTime;
        alpha = t < 50 ? easeOutQuint(t / 50) : 1 - 0.5 * easeOutQuint((t - 50) / 250);
      } else {
        const t = time - c.releaseTime;
        const startAlpha = 0.5;
        alpha = startAlpha * (1 - easeOutQuint(t / 250));
      }
      if (alpha > 0.005) {
        const half = h * 0.5;
        const y0 = this.upwards ? y : y + half;
        const grad = ctx.createLinearGradient(0, y0, 0, y0 + half);
        const bright = css(c.colour, 0.6 * alpha);
        const dim = css(c.colour, 0);
        grad.addColorStop(0, this.upwards ? bright : dim);
        grad.addColorStop(1, this.upwards ? dim : bright);
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = grad;
        ctx.fillRect(c.x, y0, c.width, half);
        ctx.restore();
      }
    }
  }

  private drawBarLines(ctx: CanvasRenderingContext2D, l: Layout, currentRel: number): void {
    const bars = this.barLines;
    if (bars.length === 0) return;
    const maxPos = l.scrollLength + NOTE_HEIGHT;

    for (let s = 0; s < this.playable.stages.length; s++) {
      const left = l.stageLeft[s];
      const width = l.stageWidth[s];
      for (const bar of bars) {
        const pos = this.positionAt(bar.startTime, currentRel, l);
        if (pos < -NOTE_HEIGHT) continue;
        if (pos > maxPos) break;
        const y = this.yAt(pos, l);
        // DefaultBarLine: major 1.7 high at 50%, minor 1.2 high at 20%.
        ctx.fillStyle = bar.major ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.2)';
        const hh = bar.major ? 1.7 : 1.2;
        ctx.fillRect(left, this.upwards ? y : y - hh, width, hh);
      }
    }
  }

  private drawHitTargets(ctx: CanvasRenderingContext2D, l: Layout): void {
    // ArgonHitTarget: 30% white additive strip of the note accent height at the hit position.
    const h = NOTE_HEIGHT * NOTE_ACCENT_RATIO;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    for (const c of this.columns) {
      roundRect(ctx, c.x, this.upwards ? l.hitY : l.hitY - h, c.width, h, CORNER_RADIUS);
      ctx.fill();
    }
    ctx.restore();
  }

  private drawObjects(ctx: CanvasRenderingContext2D, l: Layout, time: number, currentRel: number): void {
    const maxPos = l.scrollLength + STAGE_PADDING + NOTE_HEIGHT;
    const minPos = -(HIT_TARGET_POSITION + STAGE_PADDING + NOTE_HEIGHT);

    for (const c of this.columns) {
      const objects = c.objects;
      for (let i = c.firstActive; i < objects.length; i++) {
        const obj = objects[i];
        const startPos = this.positionAt(obj.startTime, currentRel, l);
        if (startPos > maxPos) break;

        if (obj instanceof DNote) {
          if (startPos < minPos) continue;
          const alpha = this.objectAlpha(obj, time);
          if (alpha <= 0) continue;
          this.drawNote(ctx, c, this.yAt(startPos, l), alpha, false);
        } else {
          this.drawHold(ctx, l, c, obj, time, currentRel, startPos, minPos);
        }
      }
    }
  }

  /** DrawableManiaHitObject.UpdateHitStateTransforms: hit -> instant fade, miss -> 150ms fade (Easing.In). */
  private objectAlpha(state: JudgeState, time: number): number {
    if (!state.judged) return 1;
    if (isHit(state.result)) return 0;
    const t = (time - state.judgeTime) / MISS_FADE;
    return t >= 1 ? 0 : 1 - t * t;
  }

  private drawHold(
    ctx: CanvasRenderingContext2D,
    l: Layout,
    c: ColumnState,
    hold: DHold,
    time: number,
    currentRel: number,
    startPos: number,
    minPos: number,
  ): void {
    const endPos = this.positionAt(hold.obj.endTime, currentRel, l);
    if (endPos < minPos) return;

    // The whole hold note fades with its own judgement.
    let alpha = this.objectAlpha(hold, time);
    if (alpha <= 0) return;
    if (hold.isMissing) alpha *= 0.5;

    const holding = time >= hold.obj.startTime && hold.head.isHit && !hold.droppedHoldAfter(hold.obj.startTime);
    const headPos = holding ? Math.max(0, startPos) : startPos;

    const half = NOTE_HEIGHT / 2;
    const dir = this.upwards ? 1 : -1;
    // Body spans from the middle of the head to the middle of the tail.
    const bodyStart = this.yAt(headPos, l) + dir * half;
    const bodyEnd = this.yAt(endPos, l) + dir * half;

    ctx.save();
    ctx.globalAlpha = alpha;

    if (holding) {
      // The masking container clips the body and tail to the region before the head (half-way under it).
      const clipY = this.yAt(0, l) + dir * half;
      ctx.beginPath();
      if (this.upwards) ctx.rect(c.x, clipY, c.width, l.H - clipY);
      else ctx.rect(c.x, 0, c.width, clipY);
      ctx.clip();
    }

    const top = Math.min(bodyStart, bodyEnd);
    const bottom = Math.max(bodyStart, bodyEnd);
    if (bottom > top) {
      // ArgonHoldBodyPiece: accent darkened 0.6
      ctx.fillStyle = this.pieceStyle(ctx, c).tailFill;
      roundRect(ctx, c.x, top, c.width, bottom - top, CORNER_RADIUS);
      ctx.fill();

      if (holding && hold.isHolding(time)) {
        // ArgonHoldNoteHittingLayer: pulsing additive accent while held.
        const phase = (time % 160) / 160;
        const pulse = phase < 0.5 ? 0.5 + 0.5 * Math.sin((phase / 0.5) * (Math.PI / 2)) : 1 - 0.5 * (1 - Math.cos(((phase - 0.5) / 0.5) * (Math.PI / 2)));
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = css(lightenC4(c.colour, 0.2), 0.3 * pulse);
        ctx.fillRect(c.x, top, c.width, bottom - top);
        ctx.restore();
      }
    }

    // Tail (DrawableHoldNoteTail: hidden instantly once hit)
    if (!(hold.tail.judged && hold.tail.isHit)) this.drawTail(ctx, c, this.yAt(endPos, l));

    ctx.restore();

    // Head (never hidden on its own; follows the hit position while held)
    ctx.save();
    ctx.globalAlpha = alpha;
    this.drawNote(ctx, c, this.yAt(headPos, l), 1, true);
    ctx.restore();
  }

  /** ArgonNotePiece: `edgeY` is the edge of the note nearest to the hit target. */
  /** Per-context gradient cache for note pieces (gradients are built in note-local coordinates and used with translate()). */
  private readonly pieceCache = new WeakMap<CanvasRenderingContext2D, Map<number, NotePieceStyle>>();

  private pieceStyle(ctx: CanvasRenderingContext2D, c: ColumnState): NotePieceStyle {
    let map = this.pieceCache.get(ctx);
    if (!map) this.pieceCache.set(ctx, (map = new Map()));
    let style = map.get(c.index);
    if (style) return style;

    const h = NOTE_HEIGHT;
    const up = this.upwards;

    // Shadow gradient (transparent -> black towards the hit target)
    const shadow = ctx.createLinearGradient(0, 0, 0, h);
    shadow.addColorStop(up ? 1 : 0, 'rgba(0,0,0,0)');
    shadow.addColorStop(up ? 0 : 1, 'rgba(0,0,0,1)');

    // Accent box (82% of the height, nearest to the hit target), accent.Lighten(0.1) -> accent
    const accentH = h * NOTE_ACCENT_RATIO;
    const accentTop = up ? 0 : h - accentH;
    const accent = ctx.createLinearGradient(0, accentTop, 0, accentTop + accentH);
    const light = css(lightenC4(c.colour, 0.1));
    const base = css(c.colour);
    accent.addColorStop(0, up ? base : light);
    accent.addColorStop(1, up ? light : base);

    // Tail: darkened accent with a soft highlight away from the hit target.
    const tailHighlight = ctx.createLinearGradient(0, 0, 0, h);
    tailHighlight.addColorStop(up ? 1 : 0, css(lightenC4(c.colour, 0.4), 0.45));
    tailHighlight.addColorStop(up ? 0 : 1, css(c.colour, 0));

    style = { shadow, accent, accentTop, accentH, tailFill: css(darkenC4(c.colour, 0.6)), tailHighlight };
    map.set(c.index, style);
    return style;
  }

  /** ArgonNotePiece: `edgeY` is the edge of the note nearest to the hit target. */
  private drawNote(ctx: CanvasRenderingContext2D, c: ColumnState, edgeY: number, alpha: number, isHead: boolean): void {
    const w = c.width;
    const h = NOTE_HEIGHT;
    const up = this.upwards;
    const top = up ? edgeY : edgeY - h;
    const style = this.pieceStyle(ctx, c);

    ctx.save();
    if (alpha < 1) ctx.globalAlpha *= alpha;
    ctx.translate(c.x, top);

    ctx.fillStyle = style.shadow;
    roundRect(ctx, 0, 0, w, h, CORNER_RADIUS);
    ctx.fill();

    ctx.fillStyle = style.accent;
    roundRect(ctx, 0, style.accentTop, w, style.accentH, CORNER_RADIUS);
    ctx.fill();

    // White strip at the edge nearest to the hit target
    ctx.fillStyle = '#ffffff';
    const stripH = CORNER_RADIUS * 2;
    roundRect(ctx, 0, up ? 0 : h - stripH, w, stripH, CORNER_RADIUS);
    ctx.fill();

    // Chevron icon (FontAwesome AngleDown, squashed vertically), pointing towards the hit target.
    const cx = w / 2;
    const cy = h / 2 + (up ? -4 : 4);
    const iw = isHead ? 8 : 7;
    const ih = (up ? -4.5 : 4.5) / 2;
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.lineWidth = 2.6;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(cx - iw, cy - ih);
    ctx.lineTo(cx, cy + ih);
    ctx.lineTo(cx + iw, cy - ih);
    ctx.stroke();

    ctx.restore();
  }

  /** ArgonHoldNoteTailPiece: darkened accent cap with a soft highlight. */
  private drawTail(ctx: CanvasRenderingContext2D, c: ColumnState, edgeY: number): void {
    const h = NOTE_HEIGHT;
    const top = this.upwards ? edgeY : edgeY - h;
    const style = this.pieceStyle(ctx, c);
    ctx.save();
    ctx.translate(c.x, top);
    ctx.fillStyle = style.tailFill;
    roundRect(ctx, 0, 0, c.width, h, CORNER_RADIUS);
    ctx.fill();
    ctx.fillStyle = style.tailHighlight;
    ctx.fill();
    ctx.restore();
  }

  private applyCover(layer: CanvasRenderingContext2D, l: Layout): void {
    // PlayfieldCoveringWrapper + ManiaModHidden.LegacyPlayfieldCover.GetHeight (covers the hit object area of each column).
    const availablePlayfieldHeight = Math.abs(REFERENCE_PLAYFIELD_HEIGHT - HIT_TARGET_POSITION);
    const filledRel = (this.coverage * REFERENCE_PLAYFIELD_HEIGHT) / availablePlayfieldHeight;
    const gradientAlpha = this.coverage > 0.0005 ? 1 : 0;

    const areaH = l.scrollLength;
    // The hit object area spans from the far end of the stage to the hit position.
    const areaTop = this.upwards ? l.hitY : l.top;
    const areaBottom = areaTop + areaH;
    const filled = Math.min(1, Math.max(0, filledRel)) * areaH;
    const gradH = 0.25 * areaH;

    // FadeIn (AlongScroll) covers where notes enter; Hidden (AgainstScroll) covers near the hit target.
    const nearHitTarget = this.ctx.mods.has('HD');
    const coverAtBottom = nearHitTarget === !this.upwards;

    layer.save();
    layer.globalCompositeOperation = 'destination-out';
    for (let s = 0; s < this.playable.stages.length; s++) {
      const left = l.stageLeft[s];
      const width = l.stageWidth[s];

      // The covering wrapper is a buffered container: nothing outside the hit object area is visible.
      layer.fillStyle = '#000';
      layer.fillRect(left, 0, width, areaTop);
      layer.fillRect(left, areaBottom, width, l.H - areaBottom);

      if (gradientAlpha <= 0 && filled <= 0) continue;

      let gradTop: number;
      let grad: CanvasGradient;
      if (coverAtBottom) {
        const filledTop = areaBottom - filled;
        gradTop = filledTop - gradH;
        grad = layer.createLinearGradient(0, gradTop, 0, filledTop);
        grad.addColorStop(0, 'rgba(0,0,0,0)');
        grad.addColorStop(1, `rgba(0,0,0,${gradientAlpha})`);
        layer.fillStyle = '#000';
        layer.fillRect(left, filledTop, width, filled);
      } else {
        gradTop = areaTop + filled;
        grad = layer.createLinearGradient(0, gradTop, 0, gradTop + gradH);
        grad.addColorStop(0, `rgba(0,0,0,${gradientAlpha})`);
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        layer.fillStyle = '#000';
        layer.fillRect(left, areaTop, width, filled);
      }
      layer.fillStyle = grad;
      layer.fillRect(left, gradTop, width, gradH);
    }
    layer.restore();
  }

  private drawKeyAreas(ctx: CanvasRenderingContext2D, l: Layout, time: number): void {
    // ArgonKeyArea: from just before the hit target to the end of the stage.
    const areaH = HIT_TARGET_POSITION + CORNER_RADIUS * 2;
    const up = this.upwards;
    const areaTop = up ? l.top : l.bottom - areaH;

    for (const c of this.columns) {
      const lighting = mixC4(c.colour, [255, 255, 255], 0.2);

      // Background
      let bgAlpha: number;
      let flash = 0;
      if (c.down) {
        const t = time - c.pressTime;
        bgAlpha = t < 70 ? easeOutQuint(t / 70) : 1 - 0.2 * clamp01((t - 70) / 500);
        flash = 1 - easeOutQuint(t / 200);
      } else {
        const t = time - c.releaseTime;
        bgAlpha = t < 50 ? 0.3 + 0.7 * (1 - easeOutQuint(t / 50)) : 0.3 * (1 - easeOutQuint((t - 50) / 800));
        if (!Number.isFinite(c.releaseTime)) bgAlpha = 0;
      }
      if (bgAlpha > 0.005) {
        const colour = mixC4(darkenC4(c.colour, 0.2), lightenC4(c.colour, 0.8), flash);
        ctx.fillStyle = css(colour, bgAlpha);
        roundRect(ctx, c.x, areaTop, c.width, areaH, CORNER_RADIUS);
        ctx.fill();
      }

      // Lighting amount for the line / icons (fade in 70ms, fade out 800ms).
      const light = c.down ? easeOutQuint((time - c.pressTime) / 70) : 1 - easeOutQuint((time - c.releaseTime) / 800);
      const lightAmount = Number.isFinite(c.releaseTime) || c.down ? clamp01(light) : 0;

      // Hit target line
      const lineY = up ? areaTop + areaH - CORNER_RADIUS * 2 : areaTop;
      const grey = 196 + (255 - 196) * lightAmount;
      if (lightAmount > 0.01) {
        ctx.save();
        ctx.shadowColor = css(lighting, 0.4 * lightAmount);
        ctx.shadowBlur = 20;
        ctx.fillStyle = `rgb(${grey | 0},${grey | 0},${grey | 0})`;
        roundRect(ctx, c.x, lineY, c.width, CORNER_RADIUS * 2, CORNER_RADIUS);
        ctx.fill();
        ctx.restore();
      } else {
        ctx.fillStyle = `rgb(${grey | 0},${grey | 0},${grey | 0})`;
        roundRect(ctx, c.x, lineY, c.width, CORNER_RADIUS * 2, CORNER_RADIUS);
        ctx.fill();
      }

      const cx = c.x + c.width / 2;

      // Top icon: rounded outline 22x14 at 30 from the hit target line.
      const iconScale = 1 - 0.1 * lightAmount;
      const topIconY = up ? areaTop + areaH - 30 : areaTop + 30;
      ctx.save();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 3;
      const iw = 22 * iconScale;
      const ih = 14 * iconScale;
      roundRect(ctx, cx - iw / 2 + 1.5, topIconY - ih / 2 + 1.5, iw - 3, ih - 3, (ih - 3) / 2);
      ctx.stroke();
      ctx.restore();

      // Bottom icon: three dots near the far end of the key area.
      const dotColour = mixC4(c.colour, [255, 255, 255], lightAmount);
      const baseY = up ? areaTop + 30 : areaTop + areaH - 30;
      const dir = up ? -1 : 1;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = css(dotColour);
      if (lightAmount > 0.01) {
        ctx.shadowColor = css(lighting, 0.6 * lightAmount);
        ctx.shadowBlur = 16;
      }
      const dots: [number, number][] = [
        [0, 0],
        [-7, 7 * 1.2],
        [7, 7 * 1.2],
      ];
      for (const [dx, dy] of dots) {
        ctx.beginPath();
        ctx.arc(cx + dx, baseY + dir * dy, 4, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  private drawExplosions(ctx: CanvasRenderingContext2D, l: Layout, time: number): void {
    // ArgonHitExplosion: an additive glow over the hit target, fading out over 200ms.
    const h = NOTE_HEIGHT * NOTE_ACCENT_RATIO;
    for (const c of this.columns) {
      const e = c.explosion;
      if (!e) continue;
      const t = (time - e.time) / EXPLOSION_DURATION;
      if (t >= 1 || t < 0) {
        if (t >= 1) c.explosion = null;
        continue;
      }
      const alpha = 1 - easeOutQuint(t) * 0.999;
      const y = this.upwards ? l.hitY : l.hitY - h;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.shadowColor = css(c.colour, alpha);
      ctx.shadowBlur = 40;
      ctx.fillStyle = css(mixC4(c.colour, [255, 255, 255], 0.8), alpha);
      roundRect(ctx, c.x, y, c.width, h, CORNER_RADIUS);
      ctx.fill();
      ctx.restore();
    }
  }

  private drawJudgements(ctx: CanvasRenderingContext2D, l: Layout, time: number): void {
    for (let s = 0; s < this.stageJudgements.length; s++) {
      const j = this.stageJudgements[s];
      if (!j) continue;
      const t = time - j.time;
      if (t >= 800 || t < 0) {
        if (t >= 800) this.stageJudgements[s] = null;
        continue;
      }

      const text = JUDGEMENT_TEXT[j.result];
      if (!text) continue;

      const cx = l.stageLeft[s] + l.stageWidth[s] / 2;
      let cy = this.upwards ? l.hitY + JUDGEMENT_Y : l.hitY - JUDGEMENT_Y;
      let scale: number;
      let rotation = 0;

      if (j.result === HitResult.Miss) {
        scale = t < 100 ? 1.6 - 0.6 * (t / 100) * (t / 100) : 1;
        cy += 100 * easeInQuint(t / 800);
        rotation = ((40 * Math.PI) / 180) * easeInQuint(t / 800);
      } else {
        scale = 1 + 0.4 * easeOutQuint(t / 1800);
      }

      const alpha = 1 - t / 800;

      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(rotation);
      ctx.scale(scale, scale);
      ctx.globalAlpha = alpha;
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = JUDGEMENT_COLOUR[j.result] ?? '#ffffff';
      ctx.font = '400 28px Torus, "Segoe UI", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      try {
        (ctx as unknown as { letterSpacing: string }).letterSpacing = '10px';
      } catch {
        // letterSpacing unsupported
      }
      ctx.fillText(text, 5, 0);
      ctx.restore();
    }
  }

  private drawCombo(ctx: CanvasRenderingContext2D, l: Layout): void {
    const combo = this.ctx.combo;
    if (combo <= 0) return;
    // ArgonManiaComboCounter: 200 from the top (or bottom when scrolling upwards), centred on the playfield.
    const left = l.stageLeft[0];
    const right = l.stageLeft[l.stageLeft.length - 1] + l.stageWidth[l.stageWidth.length - 1];
    const cx = (left + right) / 2;
    const cy = this.upwards ? l.H - 200 : 200;
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.font = '600 40px Torus, "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${combo}x`, cx, cy);
    ctx.restore();
  }

  private drawFlashlight(ctx: CanvasRenderingContext2D, l: Layout): void {
    // ManiaModFlashlight: a rectangular flashlight spanning the playfield width, centred vertically.
    // (Approximation of the RectangularFlashlight shader: fully lit within the size, smooth falloff beyond.)
    const size = this.flashlightSize;
    const smoothness = 1.1;
    const cy = l.H / 2;
    const inner = size;
    const outer = size * (1 + smoothness * 2);

    ctx.save();
    const grad = ctx.createLinearGradient(0, cy - outer, 0, cy + outer);
    const innerStop = 0.5 - inner / (2 * outer);
    grad.addColorStop(0, 'rgba(0,0,0,1)');
    grad.addColorStop(Math.max(0, innerStop), 'rgba(0,0,0,0)');
    grad.addColorStop(Math.min(1, 1 - innerStop), 'rgba(0,0,0,0)');
    grad.addColorStop(1, 'rgba(0,0,0,1)');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, l.W, Math.max(0, cy - outer));
    ctx.fillRect(0, cy + outer, l.W, Math.max(0, l.H - (cy + outer)));
    ctx.fillStyle = grad;
    ctx.fillRect(0, cy - outer, l.W, outer * 2);
    ctx.restore();
  }

  dispose(): void {
    for (const h of this.holds) {
      if (h.loops) for (const loop of h.loops) loop.stop();
      h.loops = null;
    }
    this.layer = null;
  }

  /** For tests: the action id for a column. */
  static actionFor(column: number): string {
    return actionId(column);
  }
}

/** HitObject.MaximumJudgementOffset for mania objects. */
function maximumJudgementOffset(obj: ManiaHitObject): number {
  if (obj instanceof HoldNote) return maximumJudgementOffset(obj.tail!);
  const base = obj.hitWindows ? obj.hitWindows.windowFor(HitResult.Miss) : 0;
  return obj instanceof TailNote ? base * TailNote.RELEASE_WINDOW_LENIENCE : base;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}
