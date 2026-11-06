// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Legacy (osu!stable .osk) skin rendering for osu!mania. Ports osu.Game.Rulesets.Mania/Skinning/Legacy:
// ManiaLegacySkinTransformer (all-or-nothing on the key texture), the [Mania] layout lookups of LegacySkin.lookupForMania
// (column widths / spacing / line widths, hit position, score position, light position, note height scale),
// LegacyManiaColumnElement, LegacyNotePiece, LegacyHoldNoteHeadPiece, LegacyHoldNoteTailPiece, LegacyBodyPiece (stretched),
// LegacyKeyArea, LegacyHitTarget, LegacyStageBackground (+ column backgrounds / lines), LegacyColumnBackground (lights),
// LegacyHitExplosion and LegacyManiaJudgementPiece. Only rendering is done here.

import { HitResult } from '../../../scoring/HitResult';
import { LegacyNoteBodyStyle, STABLE_MAGIC_SCALE_FACTOR, type LegacyManiaSkinConfiguration } from '../../../skinning/LegacySkinDecoder';
import type { LoadedSkin } from '../../../skinning/LegacySkin';
import { SkinAnimation, SkinSource } from '../../../skinning/SkinSource';
import { displayHeight, displayWidth, drawSprite, type SkinTexture } from '../../../skinning/SkinTexture';
import { Easing, Prop, applyEasing } from '../../../skinning/Transforms';

/** LegacyHitExplosion.FADE_IN_DURATION */
const FADE_IN_DURATION = 80;

type C4 = [number, number, number, number];

export interface ManiaLegacyColumn {
  index: number;
  /** Index within its stage. */
  inStage: number;
  stageColumns: number;
  special: boolean;
}

/** Which mania-hit* image a result uses (ManiaLegacySkinTransformer hit result mapping). */
const RESULT_IMAGES: Partial<Record<HitResult, { lookup: string; fallback: string }>> = {
  [HitResult.Perfect]: { lookup: 'Hit300g', fallback: 'mania-hit300g' },
  [HitResult.Great]: { lookup: 'Hit300', fallback: 'mania-hit300' },
  [HitResult.Good]: { lookup: 'Hit200', fallback: 'mania-hit200' },
  [HitResult.Ok]: { lookup: 'Hit100', fallback: 'mania-hit100' },
  [HitResult.Meh]: { lookup: 'Hit50', fallback: 'mania-hit50' },
  [HitResult.Miss]: { lookup: 'Hit0', fallback: 'mania-hit0' },
};

export class ManiaLegacySkinRenderer {
  readonly config: LegacyManiaSkinConfiguration;
  private readonly source: SkinSource;
  private readonly version: number | null;
  private readonly cache = new Map<string, SkinAnimation | null>();
  private readonly keyStates = new Map<number, { down: boolean; up: Prop; downAlpha: Prop }>();
  private readonly lightStates = new Map<number, { alpha: Prop; scaleY: Prop; pressTime: number }>();
  private readonly judgementRotation = new Map<number, number>();

  /** Creates the renderer if the skins provide legacy mania resources (ManiaLegacySkinTransformer: isLegacySkin && hasKeyTexture). */
  static create(sources: readonly LoadedSkin[], totalColumns: number): ManiaLegacySkinRenderer | null {
    const source = new SkinSource(sources);
    if (source.version == null) return null;
    let config: LegacyManiaSkinConfiguration | null = null;
    for (const s of sources) {
      config = s.maniaConfig(totalColumns);
      if (config) break;
    }
    if (!config) return null;
    for (const s of sources) {
      const keyImage = s.maniaConfig(totalColumns)?.imageLookups.get('KeyImage0') ?? 'mania-key1';
      if (source.only(s).getAnimation(keyImage, true, true)) return new ManiaLegacySkinRenderer(source, config);
    }
    return null;
  }

  private constructor(source: SkinSource, config: LegacyManiaSkinConfiguration) {
    this.source = source;
    this.config = config;
    this.version = source.version;
  }

  // ---------------------------------------------------------------------------------------------- layout lookups

  columnWidth(index: number): number {
    return this.config.columnWidth[index] ?? 0;
  }

  /** LegacyManiaSkinConfigurationLookups.LeftColumnSpacing */
  leftColumnSpacing(index: number): number {
    return index === 0 ? 0 : (this.config.columnSpacing[index - 1] ?? 0) / 2;
  }

  /** LegacyManiaSkinConfigurationLookups.RightColumnSpacing */
  rightColumnSpacing(index: number): number {
    return index === this.config.columnSpacing.length ? 0 : (this.config.columnSpacing[index] ?? 0) / 2;
  }

  get hitPosition(): number {
    return this.config.hitPosition;
  }

  /** WidthForNoteHeightScale (falls back to the minimum column width). */
  get widthForNoteHeightScale(): number {
    const w = this.config.widthForNoteHeightScale;
    return w > 0 ? w : this.config.minimumColumnWidth;
  }

  private colour(name: string): C4 | null {
    return this.config.customColours.get(name) ?? null;
  }

  private image(lookup: string): string | undefined {
    return this.config.imageLookups.get(lookup);
  }

  /** LegacyManiaColumnElement.FallbackColumnIndex */
  private fallbackIndex(c: ManiaLegacyColumn): string {
    if (c.special) return 'S';
    const distanceToEdge = Math.min(c.inStage, c.stageColumns - 1 - c.inStage);
    return distanceToEdge % 2 === 0 ? '1' : '2';
  }

  private animation(name: string, frameLength?: number, looping = true): SkinAnimation | null {
    const key = `${name}|${frameLength ?? ''}|${looping}`;
    if (!this.cache.has(key)) this.cache.set(key, this.source.getAnimation(name, true, looping, false, '-', frameLength));
    return this.cache.get(key)!;
  }

  // ---------------------------------------------------------------------------------------------- stage

  /** LegacyStageBackground: stage sides, column backgrounds and column lines (inset by the hit position). */
  drawStage(g: CanvasRenderingContext2D, stageLeft: number, stageWidth: number, top: number, height: number, columns: { col: ManiaLegacyColumn; x: number; width: number }[], up: boolean): void {
    const left = this.source.getTexture(this.image('StageLeft') ?? 'mania-stage-left');
    const right = this.source.getTexture(this.image('StageRight') ?? 'mania-stage-right');
    if (left) drawSprite(g, left, stageLeft + 0.05, top, { scaleY: height / displayHeight(left), originX: 1, originY: 0 });
    if (right) drawSprite(g, right, stageLeft + stageWidth - 0.05, top, { scaleY: height / displayHeight(right), originX: 0, originY: 0 });

    // HitTargetInsetContainer: lines stop at the hit position.
    const insetTop = up ? top + this.hitPosition : top;
    const insetHeight = height - this.hitPosition;
    for (let i = 0; i < columns.length; i++) {
      const { col, x, width } = columns[i];
      const isLast = col.inStage === col.stageColumns - 1;
      const bg = this.colour(`Colour${col.index + 1}`) ?? [0, 0, 0, 255];
      // LegacyColourCompatibility.ApplyWithDoubledAlpha
      fillRect(g, x, top, width, height, bg, (bg[3] / 255) * (bg[3] / 255));

      const leftLineWidth = this.config.columnLineWidth[col.index] ?? 1;
      const rightLineWidth = this.config.columnLineWidth[col.index + 1] ?? 1;
      const hasLeftLine = leftLineWidth > 0;
      const hasRightLine = (rightLineWidth > 0 && this.version != null && this.version >= 2.4) || isLast;
      const line = this.colour('ColourColumnLine') ?? [255, 255, 255, 255];
      const lineAlpha = (line[3] / 255) * (line[3] / 255);
      if (hasLeftLine) fillRect(g, x, insetTop, leftLineWidth * 0.74, insetHeight, line, lineAlpha);
      if (hasRightLine) fillRect(g, x + width - (isLast ? 0.16 : 0) - rightLineWidth * 0.74, insetTop, rightLineWidth * 0.74, insetHeight, line, lineAlpha);
    }
  }

  /** LegacyHitTarget: "mania-stage-hint" and the judgement line, centred on the hit position. */
  drawHitTarget(g: CanvasRenderingContext2D, stageLeft: number, stageWidth: number, hitY: number): void {
    const hint = this.source.getTexture(this.image('StageHint') ?? 'mania-stage-hint');
    if (hint) drawSprite(g, hint, stageLeft, hitY, { scaleX: stageWidth / displayWidth(hint), scaleY: 0.9 * 1.6025, originX: 0, originY: 0.5 });
    if (this.config.showJudgementLine) {
      const c = this.colour('ColourJudgementLine') ?? [255, 255, 255, 255];
      fillRect(g, stageLeft, hitY, stageWidth, 1, c, 0.9);
    }
  }

  /** LegacyColumnBackground light ("mania-stage-light") shown while the column is pressed. */
  drawColumnLight(g: CanvasRenderingContext2D, col: ManiaLegacyColumn, x: number, width: number, bottomY: number, up: boolean, down: boolean, pressTime: number, releaseTime: number, time: number): void {
    let st = this.lightStates.get(col.index);
    if (!st) this.lightStates.set(col.index, (st = { alpha: new Prop(0), scaleY: new Prop(1), pressTime: -Infinity }));
    if (down && pressTime !== st.pressTime) {
      st.pressTime = pressTime;
      st.alpha.set(pressTime, 1);
      st.scaleY.set(pressTime, 1);
    } else if (!down && releaseTime >= st.pressTime && Number.isFinite(releaseTime) && st.alpha.endTime < releaseTime) {
      // Todo: Should be 400 * 100 / CurrentBPM
      st.alpha.add(releaseTime, 250, 0);
      st.scaleY.add(releaseTime, 250, 0);
    }
    const alpha = st.alpha.at(time);
    if (alpha <= 0) return;
    const fps = this.config.lightFramePerSecond;
    const anim = this.animation(this.image('StageLight') ?? 'mania-stage-light', 1000 / fps);
    if (!anim) return;
    const t = anim.frameAt(time - st.pressTime);
    const light = this.colour(`ColourLight${col.index + 1}`) ?? [255, 255, 255, 255];
    const sy = st.scaleY.at(time) * (width / displayWidth(t));
    const y = up ? bottomY + this.config.lightPosition : bottomY - this.config.lightPosition;
    drawSprite(g, t, x, y, { scaleX: width / displayWidth(t), scaleY: up ? -sy : sy, originX: 0, originY: 1, alpha, colour: light });
  }

  // ---------------------------------------------------------------------------------------------- notes

  private noteAnimation(col: ManiaLegacyColumn, kind: 'note' | 'head' | 'tail' | 'body'): SkinAnimation | null {
    const fb = this.fallbackIndex(col);
    const lookup = (suffix: string) => this.animation(this.image(`NoteImage${col.index}${suffix}`) ?? `mania-note${fb}${suffix}`);
    switch (kind) {
      case 'note':
        return lookup('');
      case 'head':
        return lookup('H') ?? lookup('');
      case 'tail':
        return lookup('T') ?? lookup('H') ?? lookup('');
      case 'body': {
        const name = this.image(`NoteImage${col.index}L`) ?? `mania-note${fb}L`;
        return this.animation(name, 30);
      }
    }
  }

  /**
   * LegacyNotePiece (and the hold note head / tail pieces): the sprite is as wide as the column, its height scaled by
   * WidthForNoteHeightScale, with its bottom edge at `edgeY` (the edge nearest to the hit target). Tails are flipped.
   * Returns the drawn height.
   */
  drawNote(g: CanvasRenderingContext2D, col: ManiaLegacyColumn, x: number, width: number, edgeY: number, up: boolean, kind: 'note' | 'head' | 'tail', alpha: number, dim: boolean, time: number): number {
    const anim = this.noteAnimation(col, kind);
    if (!anim || alpha <= 0) return 0;
    const t = anim.frameAt(time);
    const sx = width / displayWidth(t);
    const sy = this.widthForNoteHeightScale / displayWidth(t);
    // tails invert the scrolling direction
    const flipped = kind === 'tail' ? !up : up;
    drawSprite(g, t, x, edgeY, { scaleX: sx, scaleY: flipped ? -sy : sy, originX: 0, originY: 1, alpha, colour: dim ? [169, 169, 169] : undefined });
    return displayHeight(t) * sy;
  }

  /** Height of a note piece (for positioning hold note bodies). */
  noteHeight(col: ManiaLegacyColumn, kind: 'note' | 'head' | 'tail'): number {
    const anim = this.noteAnimation(col, kind);
    if (!anim) return 0;
    const t = anim.frames[0];
    return displayHeight(t) * (this.widthForNoteHeightScale / displayWidth(t));
  }

  /** LegacyBodyPiece: the body image stretched between the head and the tail (animated while holding). */
  drawBody(g: CanvasRenderingContext2D, col: ManiaLegacyColumn, x: number, width: number, top: number, bottom: number, up: boolean, alpha: number, holding: boolean, holdStart: number, dim: boolean, time: number): void {
    const anim = this.noteAnimation(col, 'body');
    if (!anim || bottom <= top || alpha <= 0) return;
    const t = holding ? anim.frameAt(time - holdStart) : anim.frames[0];
    const style = this.config.noteBodyStyle ?? (this.version != null && this.version < 2.5 ? LegacyNoteBodyStyle.Stretch : LegacyNoteBodyStyle.RepeatBottom);
    void style; // all styles are drawn stretched (lazer's non-stretch handling only rescales the same stretched sprite)
    drawSprite(g, t, x, up ? bottom : top, { scaleX: width / displayWidth(t), scaleY: ((bottom - top) / displayHeight(t)) * (up ? -1 : 1), originX: 0, originY: 0, alpha, colour: dim ? [169, 169, 169] : undefined });
  }

  /** LegacyBodyPiece hold light ("lightingL") at the hit position while holding. */
  drawHoldLight(g: CanvasRenderingContext2D, col: ManiaLegacyColumn, x: number, width: number, hitY: number, alpha: number, holdStart: number, time: number): void {
    if (alpha <= 0) return;
    const name = this.image('LightingL') ?? 'lightingL';
    const probe = this.animation(name, undefined, false);
    if (!probe) return;
    const frameLength = Math.max(1000 / 60, 170 / probe.frameCount);
    const anim = this.animation(name, frameLength, true)!;
    const scale = this.holdNoteLightScale(col);
    drawSprite(g, anim.frameAt(time - holdStart), x + width / 2, hitY, { scale, alpha, additive: true });
  }

  private holdNoteLightScale(col: ManiaLegacyColumn): number {
    if (this.version != null && this.version < 2.5) return 1;
    const w = this.config.holdNoteLightWidth[col.index];
    return (w ? w : this.config.columnWidth[col.index]) / (30 * STABLE_MAGIC_SCALE_FACTOR);
  }

  private explosionScale(col: ManiaLegacyColumn): number {
    if (this.version != null && this.version < 2.5) return 1;
    const w = this.config.explosionWidth[col.index];
    return (w ? w : this.config.columnWidth[col.index]) / (30 * STABLE_MAGIC_SCALE_FACTOR);
  }

  // ---------------------------------------------------------------------------------------------- keys / explosions / judgements

  /** LegacyKeyArea: key image (down image while pressed), as wide as the column, from the bottom of the stage. */
  drawKey(g: CanvasRenderingContext2D, col: ManiaLegacyColumn, x: number, width: number, edgeY: number, up: boolean, down: boolean, releaseTime: number, time: number): void {
    const fb = this.fallbackIndex(col);
    const upTex = this.source.getTexture(this.image(`KeyImage${col.index}`) ?? `mania-key${fb}`);
    const downTex = this.source.getTexture(this.image(`KeyImage${col.index}D`) ?? `mania-key${fb}D`);
    // released: the up image comes back FADE_IN_DURATION after the release
    const showDown = down || (Number.isFinite(releaseTime) && time - releaseTime < FADE_IN_DURATION && time >= releaseTime);
    const t: SkinTexture | null = showDown ? downTex : upTex;
    if (!t) return;
    drawSprite(g, t, x, edgeY, { scaleX: width / displayWidth(t), scaleY: up ? -1 : 1, originX: 0, originY: 1 });
  }

  /** LegacyHitExplosion ("lightingN") at the hit position. */
  drawExplosion(g: CanvasRenderingContext2D, col: ManiaLegacyColumn, x: number, width: number, hitY: number, startTime: number, time: number): boolean {
    const name = this.image('LightingN') ?? 'lightingN';
    const probe = this.animation(name, undefined, false);
    if (!probe) return false;
    const frameLength = Math.max(1000 / 60, 170 / probe.frameCount);
    const anim = this.animation(name, frameLength, false)!;
    const since = time - startTime;
    if (since < 0) return true;
    // FadeInFromZero(80).Then().FadeOut(120)
    const alpha = since < FADE_IN_DURATION ? since / FADE_IN_DURATION : 1 - (since - FADE_IN_DURATION) / 120;
    if (alpha > 0) drawSprite(g, anim.frameAt(since), x + width / 2, hitY, { scale: this.explosionScale(col), alpha, additive: true });
    return true;
  }

  /** Whether the skin provides a judgement sprite for a result. */
  hasJudgement(result: HitResult): boolean {
    return this.judgementAnimation(result) != null;
  }

  private judgementAnimation(result: HitResult): SkinAnimation | null {
    const img = RESULT_IMAGES[result];
    if (!img) return null;
    return this.animation(this.image(img.lookup) ?? img.fallback, undefined, false);
  }

  /** LegacyManiaJudgementPiece (positioned by ScorePosition relative to the hit position). */
  drawJudgement(g: CanvasRenderingContext2D, result: HitResult, cx: number, stageTop: number, stageHeight: number, up: boolean, startTime: number, time: number): boolean {
    const anim = this.judgementAnimation(result);
    if (!anim) return false;
    const since = time - startTime;
    if (since < 0) return true;

    const hitPositionFromTop = 480 * STABLE_MAGIC_SCALE_FACTOR - this.hitPosition;
    const scorePosition = this.config.scorePosition;
    let y: number;
    if (scorePosition > hitPositionFromTop / 2) y = up ? stageTop + (hitPositionFromTop - scorePosition) : stageTop + stageHeight + (scorePosition - hitPositionFromTop);
    else y = up ? stageTop + stageHeight - scorePosition : stageTop + scorePosition;

    // FadeInFromZero(20, Out).Then().Delay(160).FadeOutFromOne(40, In)
    let alpha: number;
    if (since < 20) alpha = applyEasing(Easing.Out, since / 20);
    else if (since < 180) alpha = 1;
    else alpha = 1 - applyEasing(Easing.In, Math.min(1, (since - 180) / 40));
    if (alpha <= 0) return true;

    let scale: number;
    let rotation = 0;
    if (result === HitResult.Miss) {
      scale = new Prop(1).set(startTime, 1.2).add(startTime, 100, 1, Easing.Out).at(time);
      let r = this.judgementRotation.get(startTime);
      if (r === undefined) this.judgementRotation.set(startTime, (r = -5.73 + Math.random() * 11.46));
      if (this.judgementRotation.size > 64) this.judgementRotation.clear();
      rotation = r * applyEasing(Easing.Out, Math.min(1, since / 100));
    } else {
      // this is actually correct to match stable; there were overlapping transforms.
      scale = new Prop(1)
        .set(startTime, 0.8)
        .add(startTime, 40, 1)
        .set(startTime + 40, 0.85)
        .add(startTime + 40, 40, 0.7)
        .add(startTime + 180, 40, 0.4, Easing.In)
        .at(time);
    }
    drawSprite(g, anim.frameAt(since), cx, y, { scale, rotation, alpha });
    return true;
  }
}

function fillRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, c: readonly number[], alpha: number): void {
  if (alpha <= 0 || w <= 0 || h <= 0) return;
  const prev = g.globalAlpha;
  g.globalAlpha = prev * alpha;
  g.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
  g.fillRect(x, y, w, h);
  g.globalAlpha = prev;
}
