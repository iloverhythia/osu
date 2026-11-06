// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Legacy (osu!stable .osk / beatmap) skin rendering for osu!taiko. Ports osu.Game.Rulesets.Taiko/Skinning/Legacy:
// TaikoLegacySkinTransformer (component availability), LegacyCirclePiece / LegacyHit (+ LegacyKiaiFlashingDrawable),
// LegacyDrumRoll, LegacyInputDrum, LegacyHitExplosion, TaikoLegacyHitTarget, TaikoLegacyPlayfieldBackgroundRight,
// LegacyBarLine and LegacyKiaiGlow. Only rendering is done here.
// Not ported: LegacySwell, LegacyTaikoScroller and the mascot (DrawableTaikoMascot); those use the default pieces.

import type { ControlPointInfo } from '../../beatmaps/ControlPoints';
import { HitResult } from '../../scoring/HitResult';
import type { LoadedSkin } from '../../skinning/LegacySkin';
import { SkinAnimation, SkinSource, type MaxSize } from '../../skinning/SkinSource';
import { displayHeight, displayWidth, drawSprite, type SkinTexture } from '../../skinning/SkinTexture';
import { Easing, Prop, applyEasing, progress } from '../../skinning/Transforms';

type RGB = [number, number, number];

const CIRCLE_PIECE_SIZE = 128;
const MAX_CIRCLE_SPRITE_SIZE: MaxSize = { width: 160, height: 160 };
/** TaikoLegacyHitTarget.SCALE */
const HIT_TARGET_SCALE = 0.8;
/** LegacyHit accent colours */
export const LEGACY_CENTRE_COLOUR: RGB = [235, 69, 44];
export const LEGACY_RIM_COLOUR: RGB = [67, 142, 172];
const KIAI_GLOW_COLOUR: RGB = [255, 228, 0];
const STABLE_MAGIC_SCALE_FACTOR = 1.6;

export type TaikoDrumAction = 'LeftRim' | 'LeftCentre' | 'RightCentre' | 'RightRim';

interface CirclePieceTextures {
  circle: SkinAnimation | null;
  overlay: SkinAnimation | null;
}

export class TaikoLegacySkinRenderer {
  readonly has: {
    hitCircle: boolean;
    drumRoll: boolean;
    drumRollTick: boolean;
    inputDrum: boolean;
    barRight: boolean;
    hitTarget: boolean;
    barLine: boolean;
    /** The skin provides taiko-hit300: judgements and kiai explosions are hidden. */
    explosions: boolean;
    kiaiGlow: boolean;
  };

  private readonly source: SkinSource;
  private readonly version: number | null;
  private readonly pieces = new Map<string, CirclePieceTextures>();
  private readonly explosionSprites = new Map<HitResult, { normal: SkinAnimation | null; strong: SkinAnimation | null }>();
  private readonly drumPresses = new Map<TaikoDrumAction, Prop>();
  private barRightGlow = 0;
  private lastBarUpdate = -Infinity;

  private readonly tick: SkinTexture | null;
  private readonly rollMiddle: SkinTexture | null;
  private readonly rollEnd: SkinTexture | null;

  constructor(
    sources: readonly LoadedSkin[],
    private readonly controlPoints: ControlPointInfo,
  ) {
    const source = new SkinSource(sources);
    this.source = source;
    this.version = source.version;
    const per = (f: (s: SkinSource) => boolean) => source.sources.some(s => f(source.only(s)));

    this.tick = this.perSkin(s => s.getAnimation('sliderscorepoint', false, false))?.frames[0] ?? null;
    this.rollMiddle = source.getTexture('taiko-roll-middle');
    this.rollEnd = source.getTexture('taiko-roll-end');

    this.has = {
      hitCircle: per(s => s.hasTexture('taikohitcircle')),
      drumRoll: per(s => s.hasTexture('taiko-roll-middle')),
      drumRollTick: this.tick != null,
      inputDrum: per(s => s.hasTexture('taiko-bar-left')),
      barRight: per(s => s.hasTexture('taiko-bar-right')),
      hitTarget: per(s => s.hasTexture('taikobigcircle')),
      barLine: per(s => s.hasTexture('taiko-barline')),
      explosions: per(s => s.hasTexture('taiko-hit300')),
      kiaiGlow: per(s => s.hasTexture('taiko-glow')),
    };
  }

  private perSkin<T>(get: (s: SkinSource) => T | null): T | null {
    for (const s of this.source.sources) {
      const v = get(this.source.only(s));
      if (v) return v;
    }
    return null;
  }

  // ---------------------------------------------------------------------------------------------- circle pieces

  private texturesFor(strong: boolean): CirclePieceTextures {
    const key = strong ? 'big' : 'normal';
    let t = this.pieces.get(key);
    if (!t) {
      const get = (lookup: string, animatable: boolean) =>
        this.source.getAnimation(`${strong ? 'taikobig' : 'taikohit'}${lookup}`, animatable, false, false, '-', undefined, MAX_CIRCLE_SPRITE_SIZE) ??
        // fallback to regular size if "big" version doesn't exist.
        this.source.getAnimation(`taikohit${lookup}`, animatable, false, false, '-', undefined, MAX_CIRCLE_SPRITE_SIZE);
      t = { circle: get('circle', false), overlay: get('circleoverlay', true) };
      this.pieces.set(key, t);
    }
    return t;
  }

  /** LegacyKiaiFlashingDrawable (BeatSyncedContainer) flash amount at `time`. */
  private kiaiFlash(time: number): number {
    const tp = this.controlPoints.timingPointAt(time);
    let beatLength = tp.beatLength;
    while (beatLength < 50) beatLength *= 2;
    let untilNext = (tp.time - time) % beatLength;
    if (untilNext <= 0) untilNext += beatLength;
    const beatStart = time - (beatLength - untilNext);
    if (!this.controlPoints.effectPointAt(beatStart).kiaiMode) return 0;
    const duration = Math.max(80, tp.beatLength - 80);
    const since = time - beatStart;
    if (since < 0 || since > duration) return 0;
    return 0.3 * (1 - applyEasing(Easing.OutSine, since / duration));
  }

  /**
   * LegacyCirclePiece: the "circle" sprite tinted with the accent colour (with kiai flashing) and the "circleoverlay"
   * animation, whose frame alternates with the beat once the combo reaches 50 / 150. Sprites are scaled by D / 128.
   */
  drawCirclePiece(g: CanvasRenderingContext2D, x: number, y: number, D: number, accent: readonly number[], strong: boolean, alpha: number, combo: number, startTime: number, time: number): void {
    if (alpha <= 0) return;
    const t = this.texturesFor(strong);
    const scale = D / CIRCLE_PIECE_SIZE;
    const circle = t.circle?.frames[0];
    drawSprite(g, circle, x, y, { scale, alpha, colour: accent });
    const flash = this.kiaiFlash(time);
    // The accent colour is applied to the whole LegacyKiaiFlashingDrawable, so the flash is tinted too.
    if (flash > 0) drawSprite(g, circle, x, y, { scale, alpha: alpha * flash, colour: accent, additive: true });

    const overlay = t.overlay;
    if (overlay) {
      let frame = 0;
      const multiplier = combo >= 150 ? 2 : combo >= 50 ? 1 : 0;
      if (multiplier > 0 && overlay.frameCount > 1) {
        const tp = this.controlPoints.timingPointAt(startTime);
        frame = Math.abs(time - tp.time) % ((tp.beatLength * 2) / multiplier) >= tp.beatLength / multiplier ? 0 : 1;
      }
      drawSprite(g, overlay.frames[Math.min(frame, overlay.frameCount - 1)], x, y, { scale, alpha });
    }
  }

  /** LegacyHit */
  drawHit(g: CanvasRenderingContext2D, x: number, y: number, D: number, rim: boolean, strong: boolean, alpha: number, combo: number, startTime: number, time: number): void {
    this.drawCirclePiece(g, x, y, D, rim ? LEGACY_RIM_COLOUR : LEGACY_CENTRE_COLOUR, strong, alpha, combo, startTime, time);
  }

  // ---------------------------------------------------------------------------------------------- drum rolls

  /** LegacyDrumRoll body (stretched "taiko-roll-middle" with a "taiko-roll-end" cap) and its LegacyCirclePiece head. */
  drawDrumRoll(g: CanvasRenderingContext2D, x0: number, x1: number, y: number, H: number, colour: readonly number[], strong: boolean, alpha: number, combo: number, startTime: number, time: number): void {
    if (alpha <= 0) return;
    const prev = g.globalAlpha;
    if (this.rollMiddle && x1 > x0) {
      const m = this.rollMiddle;
      g.globalAlpha = prev * alpha;
      // tinted body
      const tintedEnd = this.rollEnd;
      drawSprite(g, m, x0, y, { scaleX: (x1 - x0) / displayWidth(m), scaleY: H / displayHeight(m), originX: 0, originY: 0.5, colour });
      if (tintedEnd) {
        // FillMode.Fit within the drum roll's height
        const s = H / displayHeight(tintedEnd);
        drawSprite(g, tintedEnd, x1, y, { scale: s, originX: 0, originY: 0.5, colour });
      }
      g.globalAlpha = prev;
    }
    this.drawCirclePiece(g, x0, y, H, colour, strong, alpha, combo, startTime, time);
  }

  /** DrawableDrumRollTick with a "sliderscorepoint" sprite. */
  drawDrumRollTick(g: CanvasRenderingContext2D, x: number, y: number, scale: number, alpha: number): void {
    drawSprite(g, this.tick, x, y, { scale, alpha });
  }

  // ---------------------------------------------------------------------------------------------- playfield

  /** TaikoLegacyPlayfieldBackgroundRight: "taiko-bar-right" stretched over the playfield, with "taiko-bar-right-glow" in kiai. */
  drawBackgroundRight(g: CanvasRenderingContext2D, width: number, height: number, time: number, kiai: boolean): void {
    const dt = this.lastBarUpdate === -Infinity ? 0 : Math.abs(time - this.lastBarUpdate);
    this.lastBarUpdate = time;
    this.barRightGlow = kiai ? Math.min(1, this.barRightGlow + dt / 200) : Math.max(0, this.barRightGlow - dt / 200);
    const bar = this.source.getTexture('taiko-bar-right');
    if (bar) drawSprite(g, bar, 0, 0, { scaleX: width / displayWidth(bar), scaleY: height / displayHeight(bar), originX: 0, originY: 0 });
    const glow = this.source.getTexture('taiko-bar-right-glow');
    if (glow && this.barRightGlow > 0) drawSprite(g, glow, 0, 0, { scaleX: width / displayWidth(glow), scaleY: height / displayHeight(glow), originX: 0, originY: 0, alpha: this.barRightGlow });
  }

  /** TaikoLegacyHitTarget */
  drawHitTarget(g: CanvasRenderingContext2D, x: number, y: number): void {
    drawSprite(g, this.source.getTexture('approachcircle'), x, y, { scale: HIT_TARGET_SCALE + 0.03, alpha: 0.47 });
    drawSprite(g, this.source.getTexture('taikobigcircle'), x, y, { scale: HIT_TARGET_SCALE, alpha: 0.22 });
  }

  /** LegacyBarLine: "taiko-barline" filling (FillMode.Fill) a 2 x 0.88 * height box. */
  drawBarLine(g: CanvasRenderingContext2D, x: number, y: number, height: number, alpha: number): void {
    const t = this.source.getTexture('taiko-barline');
    if (!t) return;
    const s = Math.max(2 / displayWidth(t), (0.88 * height) / displayHeight(t));
    drawSprite(g, t, x, y, { scale: s, alpha });
  }

  /** LegacyKiaiGlow */
  drawKiaiGlow(g: CanvasRenderingContext2D, x: number, y: number, alpha: number, bumpTime: number, time: number): void {
    if (alpha <= 0) return;
    const scale = new Prop(HIT_TARGET_SCALE).set(bumpTime, HIT_TARGET_SCALE + 0.15).add(bumpTime, 80, HIT_TARGET_SCALE, Easing.OutQuad).at(time);
    drawSprite(g, this.source.getTexture('taiko-glow'), x, y, { scale, alpha, colour: KIAI_GLOW_COLOUR });
  }

  // ---------------------------------------------------------------------------------------------- input drum

  /** LegacyHalfDrum.OnPressed: FadeTo(1, 80 * (1 - alpha), Out).Delay(100).FadeOut(50) */
  onDrumPressed(action: TaikoDrumAction, time: number): void {
    let p = this.drumPresses.get(action);
    if (!p) this.drumPresses.set(action, (p = new Prop(0)));
    const current = p.at(time);
    const down = 80 * (1 - current);
    p.add(time, down, 1, Easing.Out).add(time + down + 100, 50, 0);
  }

  /** LegacyInputDrum: "taiko-bar-left" with the "taiko-drum-inner" / "taiko-drum-outer" halves, masked to the drum area. */
  drawInputDrum(g: CanvasRenderingContext2D, width: number, height: number, time: number): void {
    g.save();
    g.beginPath();
    g.rect(0, 0, width, height);
    g.clip();
    drawSprite(g, this.source.getTexture('taiko-bar-left'), 0, 0, { originX: 0, originY: 0 });

    const inner = this.source.getTexture('taiko-drum-inner');
    const outer = this.source.getTexture('taiko-drum-outer');
    const ratio = STABLE_MAGIC_SCALE_FACTOR;
    // because the right half is flipped, we need to position using width - position to get the true "topleft" origin position
    const negativeScaleAdjust = width / ratio;
    let centreL: [number, number], centreR: [number, number], rimL: [number, number], rimR: [number, number];
    if (this.version != null && this.version >= 2.1) {
      centreL = [0, 0];
      centreR = [(negativeScaleAdjust - 56) * ratio, 0];
      rimL = [0, 0];
      rimR = [(negativeScaleAdjust - 56) * ratio, 0];
    } else {
      centreL = [18 * ratio, 31 * ratio];
      centreR = [(negativeScaleAdjust - 54) * ratio, 31 * ratio];
      rimL = [8 * ratio, 23 * ratio];
      rimR = [(negativeScaleAdjust - 53) * ratio, 23 * ratio];
    }
    const a = (action: TaikoDrumAction) => this.drumPresses.get(action)?.at(time) ?? 0;

    // Left half: centre (origin top-left), rim mirrored (scale -1, origin top-right).
    if (inner) drawSprite(g, inner, centreL[0], centreL[1], { originX: 0, originY: 0, alpha: a('LeftCentre') });
    if (outer) drawSprite(g, outer, rimL[0], rimL[1], { scaleX: -1, originX: 1, originY: 0, alpha: a('LeftRim') });
    // Right half: the whole half is mirrored around the drum area (Scale = (-1, 1), Origin = TopRight).
    if (inner) drawSprite(g, inner, width - centreR[0], centreR[1], { scaleX: -1, originX: 1, originY: 0, alpha: a('RightCentre') });
    if (outer) drawSprite(g, outer, width - rimR[0], rimR[1], { originX: 1, originY: 0, alpha: a('RightRim') });
    g.restore();
  }

  // ---------------------------------------------------------------------------------------------- explosions

  private explosionFor(result: HitResult): { normal: SkinAnimation | null; strong: SkinAnimation | null } {
    let e = this.explosionSprites.get(result);
    if (!e) {
      const name = result === HitResult.Miss ? 'taiko-hit0' : result === HitResult.Ok ? 'taiko-hit100' : 'taiko-hit300';
      const normal = this.perSkin(s => s.getAnimation(name, true, false));
      const strong = result === HitResult.Miss ? null : this.perSkin(s => s.getAnimation(`${name}k`, true, false));
      e = { normal, strong };
      this.explosionSprites.set(result, e);
    }
    return e;
  }

  /** LegacyHitExplosion.Animate / AnimateSecondHit */
  drawExplosion(g: CanvasRenderingContext2D, x: number, y: number, result: HitResult, startTime: number, secondHitTime: number | null, time: number): void {
    const e = this.explosionFor(result);
    const anim = e.normal;
    if (!anim) return;
    const since = time - startTime;
    if (since < 0) return;
    const animationTime = 120;
    // FadeInFromZero(120).Then().FadeOut(180)
    const alpha = since < animationTime ? since / animationTime : 1 - progress(since, animationTime, animationTime * 1.5);
    if (alpha <= 0) return;
    let scale = 1;
    // legacy judgements don't play any transforms if they are an animation.
    if (anim.frameCount <= 1) {
      scale = new Prop(1)
        .set(startTime, 0.6)
        .add(startTime, animationTime * 0.8, 1.1)
        .add(startTime + animationTime * 0.8, animationTime * 0.4, 0.9)
        .add(startTime + animationTime * 1.2, animationTime * 0.2, 1)
        .at(time);
    }
    let normalAlpha = 1;
    let strongAlpha = 0;
    if (secondHitTime != null && e.strong && time >= secondHitTime) {
      const p = applyEasing(Easing.OutQuint, Math.min(1, (time - secondHitTime) / 50));
      normalAlpha = 1 - p;
      strongAlpha = p;
    }
    drawSprite(g, anim.frameAt(since), x, y, { scale, alpha: alpha * normalAlpha });
    if (e.strong && strongAlpha > 0) drawSprite(g, e.strong.frameAt(since), x, y, { scale, alpha: alpha * strongAlpha });
  }
}
