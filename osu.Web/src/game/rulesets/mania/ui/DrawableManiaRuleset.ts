// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Gameplay + rendering for osu!mania. Ports the judgement logic of
// osu.Game.Rulesets.Mania/Objects/Drawables/{DrawableNote,DrawableHoldNote,DrawableHoldNoteHead,DrawableHoldNoteTail,DrawableHoldNoteBody}.cs,
// Judgements/HoldNoteJudgementResult.cs, UI/{Column,Stage,OrderedHitPolicy,DrawableManiaRuleset,PlayfieldCoveringWrapper}.cs,
// GameplaySampleTriggerSource.cs, ManiaModHidden/FadeIn/Flashlight, and draws the default (Argon) skin procedurally:
// osu.Game.Rulesets.Mania/Skinning/Argon/{ArgonNotePiece,ArgonHoldNoteHeadPiece,ArgonHoldNoteTailPiece,ArgonHoldBodyPiece,
// ArgonHoldNoteHittingLayer,ArgonColumnBackground,ArgonHitTarget,ArgonKeyArea,ArgonHitExplosion,ArgonJudgementPiece,
// ArgonManiaComboCounter,ArgonStageBackground}.cs, Skinning/Default/DefaultBarLine.cs, Objects/Drawables/DrawableBarLine.cs,
// with the layer order of UI/Stage.cs, UI/Column.cs and UI/Components/ColumnHitObjectArea.cs.

import { ManiaLegacySkinRenderer, type ManiaLegacyColumn } from './legacySkin';
import { generateBarLines, type BarLine } from '../../../objects/BarLineGenerator';
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
import { Anim } from './Anim';
import { Easing, applyEasing } from '../../../storyboard/Easing';
import {
  FA_ANGLE_DOWN,
  drawCircleGlow,
  drawIcon,
  drawRoundRectGlow,
  drawSpacedText,
  fillCircle,
  fillPillBorder,
  roundRectPath,
  seededRandom,
} from '../../taiko/argonDraw';
import { ArgonComboCounter, drawArgonText, measureArgonText } from '../../../../ui/hud/ArgonCounter';

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

/** OsuColour.ForHitResult */
const JUDGEMENT_COLOUR: Partial<Record<HitResult, RGB>> = {
  [HitResult.Perfect]: [0x99, 0xee, 0xff],
  [HitResult.Great]: [0x66, 0xcc, 0xff],
  [HitResult.Good]: [0xb3, 0xd9, 0x44],
  [HitResult.Ok]: [0x88, 0xb3, 0x00],
  [HitResult.Meh]: [0xff, 0xcc, 0x22],
  [HitResult.Miss]: [0xed, 0x11, 0x21],
};
/** DefaultBarLine major_extension */
const BAR_LINE_MAJOR_EXTENSION = 10;
const WHITE: RGB = [255, 255, 255];
/** Torus is substituted by the app font. */
const FONT = '"Exo 2", system-ui, sans-serif';

const mul = (a: RGB, b: RGB): RGB => [(a[0] * b[0]) / 255, (a[1] * b[1]) / 255, (a[2] * b[2]) / 255];
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
  /** HoldNoteJudgementResult holding state reports, oldest first. */
  get holdingStates(): readonly { time: number; holding: boolean }[] {
    return this.holdingState;
  }

  get hasHoldBreak(): boolean {
    return this.body.judged && !this.body.isHit;
  }

  private getLastReport(currentTime: number): {
    time: number;
    holding: boolean;
  } {
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

/** Transform state of a column's ArgonColumnBackground / ArgonKeyArea (on the game-wide clock). */
class ColumnAnims {
  readonly overlay = new Anim(0);
  readonly keyBg = new Anim(0);
  readonly keyFlash = new Anim(0);
  readonly light = new Anim(0);
  readonly lineGlowAlpha = new Anim(0);
  readonly lineGlowRadius = new Anim(0);
  readonly iconScale = new Anim(1);
  readonly iconGlowAlpha = new Anim(0);
  readonly dotGlowAlpha = new Anim(0);
  readonly dotGlowRadius = new Anim(0);

  /** ArgonColumnBackground.OnPressed + ArgonKeyArea.OnPressed */
  press(t: number): void {
    this.overlay.start(t, [
      [1, 50, Easing.OutQuint],
      [0.5, 250, Easing.OutQuint],
    ]);
    // lighting_fade_in_duration = 70
    this.keyFlash.start(t, [[0, 200, Easing.OutQuint]], 1);
    this.keyBg.start(t, [
      [1, 70, Easing.OutQuint],
      [0.8, 500],
    ]);
    this.light.start(t, [[1, 70, Easing.OutQuint]]);
    this.lineGlowAlpha.start(t, [[0.4, 70, Easing.OutQuint]]);
    this.lineGlowRadius.start(t, [[20, 70, Easing.OutQuint]]);
    this.iconScale.start(t, [[0.9, 70, Easing.OutQuint]]);
    this.iconGlowAlpha.start(t, [[0.1, 70, Easing.OutQuint]]);
    this.dotGlowAlpha.start(t, [[0.2, 70, Easing.OutQuint]]);
    this.dotGlowRadius.start(t, [[60, 70, Easing.OutQuint]]);
  }

  /** ArgonColumnBackground.OnReleased + ArgonKeyArea.OnReleased */
  release(t: number): void {
    this.overlay.start(t, [[0, 250, Easing.OutQuint]]);
    // lighting_fade_out_duration = 800
    this.keyBg.start(t, [
      [0.3, 50, Easing.OutQuint],
      [0, 800, Easing.OutQuint],
    ]);
    this.light.start(t, [[0, 800, Easing.OutQuint]]);
    this.lineGlowAlpha.start(t, [[0, 800, Easing.OutQuint]]);
    this.lineGlowRadius.start(t, [[25, 800, Easing.OutQuint]]);
    this.iconScale.start(t, [[1, 200, Easing.OutQuint]]);
    this.iconGlowAlpha.start(t, [[0, 800, Easing.OutQuint]]);
    this.dotGlowAlpha.start(t, [[0, 800, Easing.OutQuint]]);
    this.dotGlowRadius.start(t, [[30, 800, Easing.OutQuint]]);
  }
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
  /** PoolableHitExplosions alive in the column. */
  explosions: Explosion[];
  anim: ColumnAnims;
  // layout (reference units)
  x: number;
  width: number;
  stage: number;
}

interface JudgementDisplay {
  result: HitResult;
  time: number;
  /** Seed for the RingExplosion's random directions / distances. */
  seed: number;
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
  /** Legacy skin renderer, when the user skin provides osu!mania elements (ManiaLegacySkinTransformer). */
  private readonly legacy: ManiaLegacySkinRenderer | null = null;
  private legacyColumns: ManiaLegacyColumn[] = [];
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
  /** PlayfieldCoveringWrapper gradient.Alpha (damped towards 1 while Coverage > 0). */
  private coverGradientAlpha = 0;
  private readonly comboCounter = new ArgonComboCounter();
  private lastCombo = 0;
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
          explosions: [],
          anim: new ColumnAnims(),
          x: 0,
          width: COLUMN_WIDTH,
          stage: stageIndex,
        });
      }
    });
    this.stageJudgements = playable.stages.map(() => null);

    if (ctx.skin.sources && ctx.skin.sources.length > 0) {
      this.legacy = ManiaLegacySkinRenderer.create(ctx.skin.sources, this.columns.length);
      let inStageStart = 0;
      for (const stageColumns of playable.stages) {
        for (let i = 0; i < stageColumns; i++) {
          const c = this.columns[inStageStart + i];
          this.legacyColumns.push({
            index: c.index,
            inStage: i,
            stageColumns,
            special: c.special,
          });
        }
        inStageStart += stageColumns;
      }
    }

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
    column.anim.press(this.realTime(time));

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
    column.anim.release(this.realTime(time));

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
    if (displayResult)
      this.stageJudgements[column.stage] = {
        result: type,
        time,
        seed: Math.round(time * 16) ^ (column.index * 7919),
      };

    // Column.OnNewResult
    if (isHit(type)) {
      this.handleHit(column, obj.startTime, time);
      if (displayResult) column.explosions.push({ time });
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
    this.updateCombo(time);
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
          const handle = this.ctx.startLoop(s, {
            pan: this.panFor(hold.obj.column),
          });
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
      const targetAlpha = target > 0 ? 1 : 0;
      if (lastUpdate == null) {
        this.coverage = target;
        this.coverGradientAlpha = targetAlpha;
      } else {
        this.coverage = target + (this.coverage - target) * Math.pow(0.5, dt / 25);
        this.coverGradientAlpha = targetAlpha + (this.coverGradientAlpha - targetAlpha) * Math.pow(0.5, dt / 25);
      }
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
        const L = this.legacy;
        // Legacy skins: ColumnWidth / ColumnSpacing from the [Mania] section for this key count.
        c.width = L ? L.columnWidth(ci) : COLUMN_WIDTH * (c.special ? 2 : 1);
        w += c.width + (L ? L.leftColumnSpacing(ci) + L.rightColumnSpacing(ci) : COLUMN_SPACING * 2);
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
        const L = this.legacy;
        const left = L ? L.leftColumnSpacing(ci) : COLUMN_SPACING;
        const right = L ? L.rightColumnSpacing(ci) : COLUMN_SPACING;
        c.x = cx + left;
        cx += c.width + left + right;
      }
      x += stageWidths[s] + STAGE_SPACING;
    });

    // Legacy skins have no stage padding and use their HitPosition.
    const padding = this.legacy ? 0 : STAGE_PADDING;
    const hitPosition = this.legacy ? this.legacy.hitPosition : HIT_TARGET_POSITION;
    const top = padding;
    const bottom = H - padding;
    const scrollLength = Math.max(1, bottom - top - hitPosition);
    const hitY = this.upwards ? top + hitPosition : bottom - hitPosition;

    return {
      width,
      height,
      scale,
      W,
      H,
      stageLeft,
      stageWidth: stageWidths,
      hitY,
      scrollLength,
      top,
      bottom,
    };
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
    this.drawBarLines(ctx, l, currentRel, time);

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

    // Stage: judgements, then the top level container (key areas + hit explosions of each column).
    this.drawJudgements(ctx, l, time);
    this.drawColumnTopLevel(ctx, l, time);
    // HUD: ArgonManiaComboCounter (drawn by the playfield here)
    this.drawCombo(ctx, l, time);

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

  /** Column backgrounds and key areas use the game-wide clock (ApplyGameWideClock), which is not rate adjusted. */
  private realTime(time: number): number {
    return time / Math.max(0.01, Math.abs(this.ctx.rate));
  }

  private stageVerticalExtent(l: Layout): { y: number; h: number } {
    return { y: l.top, h: l.bottom - l.top };
  }

  /** Column background container: legacy stage / column lights, or ArgonColumnBackground. */
  private drawColumnBackgrounds(ctx: CanvasRenderingContext2D, l: Layout, time: number): void {
    const { y, h } = this.stageVerticalExtent(l);

    const L = this.legacy;
    if (L) {
      for (let s = 0; s < this.playable.stages.length; s++) {
        const cols = this.columns
          .filter(c => c.stage === s)
          .map(c => ({
            col: this.legacyColumns[c.index],
            x: c.x,
            width: c.width,
          }));
        L.drawStage(ctx, l.stageLeft[s], l.stageWidth[s], y, h, cols, this.upwards);
        L.drawHitTarget(ctx, l.stageLeft[s], l.stageWidth[s], l.hitY);
      }
      for (const c of this.columns)
        L.drawColumnLight(
          ctx,
          this.legacyColumns[c.index],
          c.x,
          c.width,
          this.upwards ? l.top : l.bottom,
          this.upwards,
          c.down,
          c.pressTime,
          c.releaseTime,
          time,
        );
      return;
    }

    const now = this.realTime(time);
    for (const c of this.columns) {
      ctx.save();
      // Masking with CornerRadius = ArgonNotePiece.CORNER_RADIUS
      ctx.beginPath();
      roundRectPath(ctx, c.x, y, c.width, h, CORNER_RADIUS);
      ctx.clip();
      // Background: accent.Darken(3).Opacity(0.8f)
      ctx.fillStyle = css(darkenC4(c.colour, 3), 0.8);
      ctx.fillRect(c.x, y, c.width, h);

      // Background gradient overlay (Height 0.5, additive) on the half nearest the hit target.
      const alpha = c.anim.overlay.valueAt(now);
      if (alpha > 0.002) {
        const half = h * 0.5;
        const y0 = this.upwards ? y : y + half;
        const grad = ctx.createLinearGradient(0, y0, 0, y0 + half);
        const bright = css(c.colour, 0.6 * alpha);
        const dim = css(c.colour, 0);
        grad.addColorStop(0, this.upwards ? bright : dim);
        grad.addColorStop(1, this.upwards ? dim : bright);
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = grad;
        ctx.fillRect(c.x, y0, c.width, half);
      }
      ctx.restore();
    }
  }

  /** DrawableBarLine + DefaultBarLine (the argon skin has no bar line of its own), masked vertically to the stage. */
  private drawBarLines(ctx: CanvasRenderingContext2D, l: Layout, currentRel: number, time: number): void {
    const bars = this.barLines;
    if (bars.length === 0) return;
    const maxPos = l.scrollLength + NOTE_HEIGHT;
    const { y: top, h } = this.stageVerticalExtent(l);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, top, l.W, h);
    ctx.clip();

    for (let s = 0; s < this.playable.stages.length; s++) {
      const left = l.stageLeft[s];
      const width = l.stageWidth[s];
      for (const bar of bars) {
        // UpdateStartTimeStateTransforms: FadeOut(150)
        let alpha = 1;
        if (time > bar.startTime) alpha = 1 - (time - bar.startTime) / 150;
        if (alpha <= 0) continue;
        const pos = this.positionAt(bar.startTime, currentRel, l);
        if (pos > maxPos) break;
        // The 1 unit tall DrawableBarLine sits on the hit position side of its time; DefaultBarLine is centred on it.
        const centre = this.yAt(pos, l) + (this.upwards ? 0.5 : -0.5);
        const hh = bar.major ? 1.7 : 1.2;
        const mainAlpha = bar.major ? 0.5 : 0.2;
        ctx.globalAlpha = alpha;
        ctx.fillStyle = `rgba(255,255,255,${mainAlpha})`;
        ctx.fillRect(left, centre - hh / 2, width, hh);
        if (bar.major) {
          // Left / right anchors: 10 wide additive gradients at mainLine.Alpha * 0.3
          ctx.globalCompositeOperation = 'lighter';
          const a = mainAlpha * 0.3;
          const lg = ctx.createLinearGradient(left - BAR_LINE_MAJOR_EXTENSION, 0, left, 0);
          lg.addColorStop(0, 'rgba(255,255,255,0)');
          lg.addColorStop(1, `rgba(255,255,255,${a})`);
          ctx.fillStyle = lg;
          ctx.fillRect(left - BAR_LINE_MAJOR_EXTENSION, centre - hh / 2, BAR_LINE_MAJOR_EXTENSION, hh);
          const rg = ctx.createLinearGradient(left + width, 0, left + width + BAR_LINE_MAJOR_EXTENSION, 0);
          rg.addColorStop(0, `rgba(255,255,255,${a})`);
          rg.addColorStop(1, 'rgba(255,255,255,0)');
          ctx.fillStyle = rg;
          ctx.fillRect(left + width, centre - hh / 2, BAR_LINE_MAJOR_EXTENSION, hh);
          ctx.globalCompositeOperation = 'source-over';
        }
      }
    }
    ctx.restore();
  }

  private drawHitTargets(ctx: CanvasRenderingContext2D, l: Layout): void {
    // Legacy skins sandwich the hit target between the column background and the column light (drawn in drawColumnBackgrounds).
    if (this.legacy) return;
    // ArgonHitTarget: a white additive box (alpha 0.3) of the note accent height at the hit position, CornerRadius masking.
    const h = NOTE_HEIGHT * NOTE_ACCENT_RATIO;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    for (const c of this.columns) {
      ctx.beginPath();
      roundRectPath(ctx, c.x, this.upwards ? l.hitY : l.hitY - h, c.width, h, CORNER_RADIUS);
      ctx.fill();
    }
    ctx.restore();
  }

  private drawObjects(ctx: CanvasRenderingContext2D, l: Layout, time: number, currentRel: number): void {
    if (this.legacy) {
      this.drawObjectsLegacy(ctx, this.legacy, l, time, currentRel);
      return;
    }
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

  /** Notes and hold notes with legacy skin pieces (LegacyNotePiece, LegacyHoldNoteHead/TailPiece, LegacyBodyPiece). */
  private drawObjectsLegacy(ctx: CanvasRenderingContext2D, L: ManiaLegacySkinRenderer, l: Layout, time: number, currentRel: number): void {
    const up = this.upwards;
    const dir = up ? 1 : -1;
    for (const c of this.columns) {
      const col = this.legacyColumns[c.index];
      const noteH = L.noteHeight(col, 'note');
      const maxPos = l.scrollLength + l.H;
      const minPos = -(l.H + noteH);
      const objects = c.objects;
      for (let i = c.firstActive; i < objects.length; i++) {
        const obj = objects[i];
        const startPos = this.positionAt(obj.startTime, currentRel, l);
        if (startPos > maxPos) break;

        if (obj instanceof DNote) {
          if (startPos < minPos) continue;
          const alpha = this.objectAlpha(obj, time);
          if (alpha > 0) L.drawNote(ctx, col, c.x, c.width, this.yAt(startPos, l), up, 'note', alpha, false, time);
          continue;
        }

        const hold = obj;
        const endPos = this.positionAt(hold.obj.endTime, currentRel, l);
        if (endPos < minPos) continue;
        const alpha = this.objectAlpha(hold, time);
        if (alpha <= 0) continue;
        const dim = hold.isMissing;
        const holding = time >= hold.obj.startTime && hold.head.isHit && !hold.droppedHoldAfter(hold.obj.startTime);
        const headPos = holding ? Math.max(0, startPos) : startPos;
        const headH = L.noteHeight(col, 'head');
        const tailH = L.noteHeight(col, 'tail');
        const headEdge = this.yAt(headPos, l);
        const tailEdge = this.yAt(endPos, l);
        // DrawableHoldNote: the body spans from the middle of the head to the middle of the tail.
        const bodyA = headEdge + dir * (headH / 2);
        const bodyB = tailEdge + dir * (tailH / 2);

        ctx.save();
        if (holding) {
          const clipY = this.yAt(0, l) + dir * (headH / 2);
          ctx.beginPath();
          if (up) ctx.rect(c.x, clipY, c.width, l.H - clipY);
          else ctx.rect(c.x, 0, c.width, clipY);
          ctx.clip();
        }
        const isHolding = holding && hold.isHolding(time);
        L.drawBody(ctx, col, c.x, c.width, Math.min(bodyA, bodyB), Math.max(bodyA, bodyB), up, alpha, isHolding, hold.obj.startTime, dim, time);
        if (!(hold.tail.judged && hold.tail.isHit)) L.drawNote(ctx, col, c.x, c.width, tailEdge, up, 'tail', alpha, dim, time);
        ctx.restore();

        L.drawNote(ctx, col, c.x, c.width, headEdge, up, 'head', alpha, dim, time);
        if (isHolding) L.drawHoldLight(ctx, col, c.x, c.width, l.hitY, alpha, hold.obj.startTime, time);
      }
    }
  }

  /** DrawableManiaHitObject.UpdateHitStateTransforms: hit -> FadeOut(), miss -> FadeOut(150, Easing.In). */
  private objectAlpha(state: JudgeState, time: number): number {
    if (!state.judged) return 1;
    if (isHit(state.result)) return 0;
    const t = (time - state.judgeTime) / MISS_FADE;
    return t >= 1 ? 0 : 1 - applyEasing(Easing.In, Math.max(0, t));
  }

  /**
   * DrawableHoldNote layout: the head sits at the start time (frozen at the hit position while held), the body piece spans
   * from the middle of the head to the middle of the tail, and the body + tail are masked to beyond the head's middle.
   */
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
    const alpha = this.objectAlpha(hold, time);
    if (alpha <= 0) return;

    const holding = time >= hold.obj.startTime && hold.head.isHit && !hold.droppedHoldAfter(hold.obj.startTime);
    const headPos = holding ? Math.max(0, startPos) : startPos;

    const half = NOTE_HEIGHT / 2;
    const dir = this.upwards ? 1 : -1;
    const bodyStart = this.yAt(headPos, l) + dir * half;
    const bodyEnd = this.yAt(endPos, l) + dir * half;
    const hitting = this.hittingLayerAlpha(hold, time);

    ctx.save();
    ctx.globalAlpha *= alpha;

    ctx.save();
    // maskingContainer: padded by half the head on the hit target side, shrinking with the sizing container while held.
    const clipY = this.yAt(headPos, l) + dir * half;
    ctx.beginPath();
    if (this.upwards) ctx.rect(c.x, clipY, c.width, l.H - clipY);
    else ctx.rect(c.x, 0, c.width, clipY);
    ctx.clip();

    const top = Math.min(bodyStart, bodyEnd);
    const bottom = Math.max(bodyStart, bodyEnd);
    if (bottom > top) {
      // ArgonHoldBodyPiece: Masking with CornerRadius; accent.Darken(0.6f) + ArgonHoldNoteHittingLayer
      ctx.save();
      ctx.beginPath();
      roundRectPath(ctx, c.x, top, c.width, bottom - top, CORNER_RADIUS);
      ctx.clip();
      ctx.fillStyle = css(darkenC4(c.colour, 0.6));
      ctx.fillRect(c.x, top, c.width, bottom - top);
      if (hitting > 0.002) {
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = css(lightenC4(c.colour, 0.2), 0.3 * hitting);
        ctx.fillRect(c.x, top, c.width, bottom - top);
      }
      ctx.restore();
    }

    // DrawableHoldNoteTail: hidden instantly once hit, FadeOut(150, In) when missed.
    const tailAlpha = this.objectAlpha(hold.tail, time);
    if (tailAlpha > 0) this.drawTail(ctx, c, this.yAt(endPos, l), tailAlpha, hitting);
    ctx.restore();

    // Head (never hidden on its own; follows the hit position while held)
    this.drawNote(ctx, c, this.yAt(headPos, l), 1, true);
    ctx.restore();
  }

  /**
   * ArgonHoldNoteHittingLayer alpha: while holding, FadeTo(1, 80, OutSine).Then().FadeTo(0.5f, 80, InSine).Loop(), started on
   * the next multiple of 160ms; on release FadeOut(80).
   */
  private hittingLayerAlpha(hold: DHold, time: number): number {
    const ANIMATION_LENGTH = 80;
    let fn: (t: number) => number = () => 0;
    for (const s of hold.holdingStates) {
      if (!Number.isFinite(s.time)) continue;
      if (s.time > time) break;
      const at = fn(s.time);
      if (s.holding) {
        const first = s.time + (ANIMATION_LENGTH * 2 - (s.time % (ANIMATION_LENGTH * 2)));
        fn = t => {
          if (t < first) return at;
          const n = Math.floor((t - first) / (ANIMATION_LENGTH * 2));
          const e = t - first - n * ANIMATION_LENGTH * 2;
          if (e < ANIMATION_LENGTH) {
            const from = n === 0 ? at : 0.5;
            return from + (1 - from) * applyEasing(Easing.OutSine, e / ANIMATION_LENGTH);
          }
          return 1 - 0.5 * applyEasing(Easing.InSine, (e - ANIMATION_LENGTH) / ANIMATION_LENGTH);
        };
      } else {
        const start = s.time;
        fn = t => at * (1 - clamp01((t - start) / ANIMATION_LENGTH));
      }
    }
    return clamp01(fn(time));
  }

  /**
   * Draws a note-shaped piece of NOTE_HEIGHT whose hit-target-side edge is at `edgeY`, in a local frame where y grows away
   * from the hit target... i.e. flipped for upwards scrolling (`Scale = (1, -1)`), with (0, 0) at the top-left of the piece
   * as drawn for downwards scrolling.
   */
  private withPieceFrame(ctx: CanvasRenderingContext2D, c: ColumnState, edgeY: number, draw: () => void): void {
    ctx.save();
    if (this.upwards) {
      ctx.translate(c.x, edgeY + NOTE_HEIGHT);
      ctx.scale(1, -1);
    } else ctx.translate(c.x, edgeY - NOTE_HEIGHT);
    draw();
    ctx.restore();
  }

  /** ArgonNotePiece / ArgonHoldNoteHeadPiece. `edgeY` is the edge of the note nearest to the hit target. */
  private drawNote(ctx: CanvasRenderingContext2D, c: ColumnState, edgeY: number, alpha: number, isHead: boolean): void {
    const w = c.width;
    const h = NOTE_HEIGHT;
    const accentH = h * NOTE_ACCENT_RATIO;
    this.withPieceFrame(ctx, c, edgeY, () => {
      if (alpha < 1) ctx.globalAlpha *= alpha;
      // Masking, CornerRadius
      ctx.beginPath();
      roundRectPath(ctx, 0, 0, w, h, CORNER_RADIUS);
      ctx.clip();

      // Box: GradientVertical(Black.Opacity(0), Black)
      const shadow = ctx.createLinearGradient(0, 0, 0, h);
      shadow.addColorStop(0, 'rgba(0,0,0,0)');
      shadow.addColorStop(1, 'rgba(0,0,0,1)');
      ctx.fillStyle = shadow;
      ctx.fillRect(0, 0, w, h);

      // Accent container (BottomLeft, Height = NOTE_ACCENT_RATIO, CornerRadius): GradientVertical(accent.Lighten(0.1f), accent)
      const accent = ctx.createLinearGradient(0, h - accentH, 0, h);
      accent.addColorStop(0, css(lightenC4(c.colour, 0.1)));
      accent.addColorStop(1, css(c.colour));
      ctx.fillStyle = accent;
      ctx.beginPath();
      roundRectPath(ctx, 0, h - accentH, w, accentH, CORNER_RADIUS);
      ctx.fill();

      // Circle (BottomLeft, Height = CORNER_RADIUS * 2)
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      roundRectPath(ctx, 0, h - CORNER_RADIUS * 2, w, CORNER_RADIUS * 2, CORNER_RADIUS);
      ctx.fill();

      if (isHead) {
        // ArgonHoldNoteHeadPiece icon: Circle 20x5 at Y = 2
        ctx.beginPath();
        roundRectPath(ctx, w / 2 - 10, h / 2 + 2 - 2.5, 20, 5, 2.5);
        ctx.fill();
      } else {
        // SpriteIcon AngleDown, Size 20, Scale (1, 0.7), Y = 4
        drawIcon(ctx, FA_ANGLE_DOWN, w / 2, h / 2 + 4, 20, 1, 0.7);
      }
    });
  }

  /** ArgonHoldNoteTailPiece: `edgeY` is the edge nearest to the hit target. */
  private drawTail(ctx: CanvasRenderingContext2D, c: ColumnState, edgeY: number, alpha: number, hitting: number): void {
    const w = c.width;
    const h = NOTE_HEIGHT;
    const accentH = h * NOTE_ACCENT_RATIO;
    this.withPieceFrame(ctx, c, edgeY, () => {
      if (alpha < 1) ctx.globalAlpha *= alpha;
      ctx.beginPath();
      roundRectPath(ctx, 0, 0, w, h, CORNER_RADIUS);
      ctx.clip();

      // Box (Height 0.9): GradientVertical(Black.Opacity(0), Black)
      const shadow = ctx.createLinearGradient(0, 0, 0, h * 0.9);
      shadow.addColorStop(0, 'rgba(0,0,0,0)');
      shadow.addColorStop(1, 'rgba(0,0,0,1)');
      ctx.fillStyle = shadow;
      ctx.fillRect(0, 0, w, h * 0.9);

      // Accent container (BottomCentre, Height = NOTE_ACCENT_RATIO, CornerRadius)
      ctx.beginPath();
      roundRectPath(ctx, 0, h - accentH, w, accentH, CORNER_RADIUS);
      ctx.clip();
      // foreground: accent.Darken(0.6f)
      ctx.fillStyle = css(darkenC4(c.colour, 0.6));
      ctx.fillRect(0, h - accentH, w, accentH);
      ctx.globalCompositeOperation = 'lighter';
      // hittingLayer
      if (hitting > 0.002) {
        ctx.fillStyle = css(lightenC4(c.colour, 0.2), 0.3 * hitting);
        ctx.fillRect(0, h - accentH, w, accentH);
      }
      // foregroundAdditive (Height 0.5, additive): GradientVertical(accent.Opacity(0.4f), accent.Opacity(0))
      const add = ctx.createLinearGradient(0, h - accentH, 0, h - accentH / 2);
      add.addColorStop(0, css(c.colour, 0.4));
      add.addColorStop(1, css(c.colour, 0));
      ctx.fillStyle = add;
      ctx.fillRect(0, h - accentH, w, accentH / 2);
    });
  }

  private applyCover(layer: CanvasRenderingContext2D, l: Layout): void {
    // PlayfieldCoveringWrapper + ManiaModHidden.LegacyPlayfieldCover.GetHeight (covers the hit object area of each column).
    const availablePlayfieldHeight = Math.abs(REFERENCE_PLAYFIELD_HEIGHT - HIT_TARGET_POSITION);
    const filledRel = (this.coverage * REFERENCE_PLAYFIELD_HEIGHT) / availablePlayfieldHeight;
    const gradientAlpha = clamp01(this.coverGradientAlpha);

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

  /** Stage top level container: per column, the (proxied) key area and then the hit explosions. */
  private drawColumnTopLevel(ctx: CanvasRenderingContext2D, l: Layout, time: number): void {
    const L = this.legacy;
    if (L) {
      for (const c of this.columns)
        L.drawKey(ctx, this.legacyColumns[c.index], c.x, c.width, this.upwards ? l.top : l.bottom, this.upwards, c.down, c.releaseTime, time);
      for (const c of this.columns) {
        compactExplosions(c, time);
        for (const e of c.explosions) L.drawExplosion(ctx, this.legacyColumns[c.index], c.x, c.width, l.hitY, e.time, time);
      }
      return;
    }
    for (const c of this.columns) {
      this.drawKeyArea(ctx, l, c, time);
      this.drawExplosions(ctx, l, c, time);
    }
  }

  /** ArgonKeyArea (flipped for upwards scrolling), animated on the game-wide clock. */
  private drawKeyArea(ctx: CanvasRenderingContext2D, l: Layout, c: ColumnState, time: number): void {
    const now = this.realTime(time);
    const a = c.anim;
    const areaH = HIT_TARGET_POSITION + CORNER_RADIUS * 2;
    const w = c.width;
    const lighting = mixC4(c.colour, [255, 255, 255], 0.2);

    ctx.save();
    // directionContainer: BottomLeft anchored (down) / TopLeft anchored with Scale (1, -1) (up); local y = 0 at the hit target line.
    if (this.upwards) {
      ctx.translate(c.x, l.top + areaH);
      ctx.scale(1, -1);
    } else ctx.translate(c.x, l.bottom - areaH);

    // Key gradient (Darken(0.2f)): FlashColour(Lighten(0.8f), 200, OutQuint) + alpha transforms
    const bgAlpha = a.keyBg.valueAt(now);
    if (bgAlpha > 0.002) {
      const colour = mixC4(darkenC4(c.colour, 0.2), lightenC4(c.colour, 0.8), clamp01(a.keyFlash.valueAt(now)));
      ctx.fillStyle = css(colour, bgAlpha);
      ctx.beginPath();
      roundRectPath(ctx, 0, 0, w, areaH, CORNER_RADIUS);
      ctx.fill();
    }

    const light = clamp01(a.light.valueAt(now));

    // Hit target line: Circle, Gray(196) -> White, with a glow (lighting @ 0.4, radius 20 / 25)
    const lineGlowAlpha = a.lineGlowAlpha.valueAt(now);
    if (lineGlowAlpha > 0.002) drawRoundRectGlow(ctx, 0, 0, w, CORNER_RADIUS * 2, CORNER_RADIUS, a.lineGlowRadius.valueAt(now), lighting, lineGlowAlpha);
    const grey = 196 + (255 - 196) * light;
    ctx.fillStyle = `rgb(${grey | 0},${grey | 0},${grey | 0})`;
    ctx.beginPath();
    roundRectPath(ctx, 0, 0, w, CORNER_RADIUS * 2, CORNER_RADIUS);
    ctx.fill();

    const cx = w / 2;

    // Bottom icon: three additive 8px circles at -30 from the far end, coloured accent -> white, glow (lighting @ 0.2, radius 60 / 30)
    {
      const baseY = areaH - 30;
      const dotColour = mixC4(c.colour, [255, 255, 255], light);
      const glowAlpha = a.dotGlowAlpha.valueAt(now);
      const glowRadius = a.dotGlowRadius.valueAt(now);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      // The auto-sized container (Origin Centre) spans the three circles: [-4, 12.4] around the first one.
      const dots: [number, number][] = [
        [0, -4.2],
        [-7, -4.2 + 7 * 1.2],
        [7, -4.2 + 7 * 1.2],
      ];
      for (const [dx, dy] of dots) {
        if (glowAlpha > 0.002) drawCircleGlow(ctx, cx + dx, baseY + dy, 4, glowRadius, mul(lighting, dotColour), glowAlpha);
        ctx.fillStyle = css(dotColour);
        fillCircle(ctx, cx + dx, baseY + dy, 4);
      }
      ctx.restore();
    }

    // Top icon: CircularContainer 22x14 at 30 from the line, BorderThickness 4, ScaleTo(0.9f) when pressed, glow (lighting @ 0.1, radius 20)
    {
      const s = a.iconScale.valueAt(now);
      const iw = 22 * s;
      const ih = 14 * s;
      const glowAlpha = a.iconGlowAlpha.valueAt(now);
      if (glowAlpha > 0.002) drawRoundRectGlow(ctx, cx - iw / 2, 30 - ih / 2, iw, ih, ih / 2, 20 * s, lighting, glowAlpha);
      ctx.fillStyle = '#fff';
      fillPillBorder(ctx, cx - iw / 2, 30 - ih / 2, iw, ih, 4 * s);
    }
    ctx.restore();
  }

  /** ArgonHitExplosion: a NOTE_HEIGHT tall drawable centred NOTE_HEIGHT / 2 before the hit position, FadeOutFromOne(200, Out). */
  private drawExplosions(ctx: CanvasRenderingContext2D, l: Layout, c: ColumnState, time: number): void {
    compactExplosions(c, time);
    if (c.explosions.length === 0) return;
    const h = NOTE_HEIGHT * NOTE_ACCENT_RATIO;
    const faint = mixC4(c.colour, [255, 255, 255], 0.8);
    // largeFaint.Colour multiplies its glow (accent, radius 60, roundness 40) too.
    const glowColour = mul(c.colour, faint);
    const top = this.upwards ? l.hitY : l.hitY - h;
    const cy = top + h / 2;
    const cx = c.x + c.width / 2;
    for (const e of c.explosions) {
      const t = (time - e.time) / EXPLOSION_DURATION;
      if (t < 0 || t >= 1) continue;
      const alpha = 1 - applyEasing(Easing.Out, t);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha *= alpha;
      // The glow of a (width x 34.44) box with corner radius 3.4 + 60 + 40 and blend range 60: a soft ellipse that is fully
      // opaque within ~(w/2 - 8.8, 15.1) and fades out ((1 - d)^2) at ~(w/2 + 56.6, 76.3) for a 60 wide column.
      const rx = c.width / 2 + 56.6;
      const ry = h / 2 + 59.1;
      const inner = Math.min((c.width / 2 - 8.8) / rx, 15.1 / ry);
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(rx, ry);
      const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
      grad.addColorStop(0, css(glowColour, 1));
      if (inner > 0) grad.addColorStop(inner, css(glowColour, 1));
      for (let i = 1; i <= 6; i++) {
        const f = i / 6;
        grad.addColorStop(Math.max(0, inner) + (1 - Math.max(0, inner)) * f, css(glowColour, (1 - f) * (1 - f)));
      }
      ctx.fillStyle = grad;
      fillCircle(ctx, 0, 0, 1);
      ctx.restore();
      ctx.fillStyle = css(faint);
      ctx.beginPath();
      roundRectPath(ctx, c.x, top, c.width, h, CORNER_RADIUS);
      ctx.fill();
      ctx.restore();
    }
  }

  /** DrawableManiaJudgement + mania ArgonJudgementPiece (180 above the hit position). */
  private drawJudgements(ctx: CanvasRenderingContext2D, l: Layout, time: number): void {
    for (let s = 0; s < this.stageJudgements.length; s++) {
      const j = this.stageJudgements[s];
      if (!j) continue;
      const t = time - j.time;
      if (t >= 1000 || t < 0) {
        if (t >= 1000) this.stageJudgements[s] = null;
        continue;
      }

      const cx = l.stageLeft[s] + l.stageWidth[s] / 2;
      if (this.legacy?.drawJudgement(ctx, j.result, cx, l.top, l.bottom - l.top, this.upwards, j.time, time)) continue;
      if (t >= 800) continue;

      const text = JUDGEMENT_TEXT[j.result];
      if (!text) continue;
      const colour = JUDGEMENT_COLOUR[j.result] ?? WHITE;

      let cy = this.upwards ? l.hitY + JUDGEMENT_Y : l.hitY - JUDGEMENT_Y;
      let pieceScale = 1;
      let textScale = 1;
      let rotation = 0;

      if (j.result === HitResult.Miss) {
        // ScaleTo(1.6f).ScaleTo(1, 100, In); MoveToOffset((0, 100), 800, InQuint); RotateTo(40, 800, InQuint)
        pieceScale = 1.6 - 0.6 * applyEasing(Easing.In, clamp01(t / 100));
        cy += 100 * applyEasing(Easing.InQuint, clamp01(t / 800));
        rotation = ((40 * Math.PI) / 180) * applyEasing(Easing.InQuint, clamp01(t / 800));
      } else {
        // JudgementText.ScaleTo(1.4f, 1800, OutQuint)
        textScale = 1 + 0.4 * applyEasing(Easing.OutQuint, clamp01(t / 1800));
      }

      // FadeOutFromOne(800)
      const alpha = 1 - t / 800;

      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(rotation);
      ctx.scale(pieceScale, pieceScale);
      ctx.globalAlpha *= alpha;
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = css(colour);
      ctx.font = `400 28px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.save();
      ctx.scale(textScale, textScale);
      drawSpacedText(ctx, text, 0, 0, 10);
      ctx.restore();

      // RingExplosion (hits): travel 52, start_position_ratio 0.3, FadeOutFromOne(1000, OutQuint)
      if (isHit(j.result)) {
        const ringAlpha = 1 - applyEasing(Easing.OutQuint, clamp01(t / 1000));
        let countSmall = 0;
        let countLarge = 0;
        let travel = 52;
        if (j.result === HitResult.Meh) {
          countSmall = 3;
          travel *= 0.3;
        } else if (j.result === HitResult.Ok || j.result === HitResult.Good) {
          countSmall = 4;
          travel *= 0.6;
        } else if (j.result === HitResult.Great || j.result === HitResult.Perfect) {
          countSmall = 4;
          countLarge = 4;
        }
        if (ringAlpha > 0.002 && countSmall + countLarge > 0) {
          ctx.globalAlpha *= ringAlpha;
          const rnd = seededRandom(j.seed);
          const move = applyEasing(Easing.OutQuint, clamp01(t / 600));
          for (let i = 0; i < countSmall + countLarge; i++) {
            const size = i < countSmall ? 9 : 14;
            // RNG.NextSingle(0, 360) is passed straight to MathF.Cos / MathF.Sin.
            const direction = rnd() * 360;
            const distance = travel / 2 + rnd() * (travel / 2);
            const d = distance * (0.3 + 0.7 * move);
            fillPillBorder(ctx, Math.cos(direction) * d - size / 2, Math.sin(direction) * d - size / 2, size, size, 4);
          }
        }
      }
      ctx.restore();
    }
  }

  /** ArgonManiaComboCounter (MainHUDComponents: TopCentre, Y = 200, flipped to the bottom for upwards scrolling, no label / "x"). */
  private updateCombo(time: number): void {
    const combo = this.ctx.combo;
    if (combo !== this.lastCombo) {
      this.comboCounter.onComboChanged(this.lastCombo, combo, time);
      this.lastCombo = combo;
    }
  }

  private drawCombo(ctx: CanvasRenderingContext2D, l: Layout, time: number): void {
    this.updateCombo(time);
    const o = this.comboCounter.options(time);
    const count = o.text.endsWith('x') ? o.text.slice(0, -1) : o.text;
    o.text = count;
    o.wireframeTemplate = '#'.repeat(Math.max(1, count.length));
    o.label = undefined;
    const size = measureArgonText(ctx, o);
    ctx.save();
    const y = this.upwards ? l.H - 200 : 200;
    drawArgonText(ctx, l.W / 2 - size.width / 2, y - size.height / 2, o, size);
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

/** Removes hit explosions which have expired (PoolableHitExplosion: Delay(DURATION).Then().Expire()). */
function compactExplosions(c: ColumnState, time: number): void {
  let n = 0;
  while (n < c.explosions.length && time - c.explosions[n].time >= EXPLOSION_DURATION) n++;
  if (n > 0) c.explosions.splice(0, n);
}
