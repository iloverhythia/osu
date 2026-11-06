// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Legacy (osu!stable .osk / beatmap) skin rendering for osu!. Ports the pieces in osu.Game.Rulesets.Osu/Skinning/Legacy:
// OsuLegacySkinTransformer (component availability), LegacyMainCirclePiece (+ LegacyKiaiFlashingDrawable), LegacyApproachCircle,
// LegacySliderHeadHitCircle, LegacySliderBody (+ DrawableSliderPath / SmoothPath colour profile), LegacySliderBall, LegacyFollowCircle
// (+ FollowCircle), LegacyReverseArrow, LegacySpinner / LegacyNewStyleSpinner / LegacyOldStyleSpinner, LegacyCursor, LegacyCursorTrail
// (+ CursorTrail), LegacyJudgementPieceOld / LegacyJudgementPieceNew (+ ParticleExplosion), LegacyJudgementPieceSliderTickHit,
// SkinnableLighting (+ DrawableOsuJudgement hit animations), FollowPointConnection and the transforms of DrawableHitCircle,
// DrawableSliderTail, DrawableSliderRepeat, DrawableSliderTick, DrawableSlider and DrawableSpinner which apply to those pieces.
//
// Only rendering is done here; judging stays in DrawableOsuRuleset.

import { HitResult, isHit, isMiss, isTick } from '../../scoring/HitResult';
import type { GameplayContext } from '../Ruleset';
import type { RGB } from '../../Skin';
import type { ControlPointInfo } from '../../beatmaps/ControlPoints';
import { LegacyFont, SkinAnimation, SkinSource, SIXTY_FRAME_TIME, layoutLegacyText, drawLegacyText, type LegacyText, type MaxSize } from '../../skinning/SkinSource';
import { drawSprite, drawSpriteRegion, displayWidth, withScaleAdjust, type SkinTexture } from '../../skinning/SkinTexture';
import { Easing, Prop, applyEasing, progress, valueAt } from '../../skinning/Transforms';
import { STABLE_MAGIC_SCALE_FACTOR } from '../../skinning/LegacySkinDecoder';
import type { LoadedSkin } from '../../skinning/LegacySkin';
import { HitCircle, OBJECT_RADIUS, OsuHitObject, Slider, SliderHeadCircle, SliderRepeat, SliderTailCircle, SliderTick, Spinner } from './objects';

const OBJECT_DIMENSIONS = OBJECT_RADIUS * 2;
/** OsuLegacySkinTransformer.LEGACY_CIRCLE_RADIUS: stable hitcircles have 5px of transparent padding. */
export const LEGACY_CIRCLE_RADIUS = OBJECT_RADIUS - 5;
/** OsuLegacySkinTransformer.MAX_FOLLOW_CIRCLE_AREA_SIZE */
const MAX_FOLLOW_CIRCLE_AREA: MaxSize = { width: OBJECT_DIMENSIONS * 3, height: OBJECT_DIMENSIONS * 3 };
const MAX_CIRCLE_SIZE: MaxSize = { width: OBJECT_DIMENSIONS * 2, height: OBJECT_DIMENSIONS * 2 };
const OBJECT_SIZE: MaxSize = { width: OBJECT_DIMENSIONS, height: OBJECT_DIMENSIONS };
const HITCIRCLE_TEXT_SCALE = 0.8;
/** DrawableOsuHitObject / DrawableSliderTick.ANIM_DURATION */
const ANIM_DURATION = 150;
const LEGACY_FADE_DURATION = 240;

// LegacySpinner
const SPRITE_SCALE = 0.625;
const SPINNER_TOP_OFFSET = 45 - 16;
const SPINNER_Y_CENTRE = SPINNER_TOP_OFFSET + 219;
const SPM_HIDE_OFFSET = 50;
const FINAL_METRE_HEIGHT = 692 * SPRITE_SCALE;
const TOTAL_BARS = 10;
/** DrawableSpinner.score_per_tick (base score of a LargeBonus). */
const SCORE_PER_TICK = 50;

// FollowPointConnection
const FOLLOW_POINT_SPACING = 32;
const FOLLOW_POINT_PREEMPT = 800;
const PREEMPT_MIN = 450;

export interface JudgeView {
  readonly judged: boolean;
  readonly result: HitResult;
  readonly judgedAt: number;
}

/** What the legacy renderer needs to know about DrawableOsuRuleset's state. */
export interface OsuLegacyHost {
  judge(h: OsuHitObject): JudgeView;
  sliderTracking(s: Slider): { tracking: boolean; lastTrackingChange: number };
  spinner(s: Spinner): { displayRotation: number; completedFullSpins: number; rpm: number; progress: number };
  comboColour(h: OsuHitObject): RGB;
  /** The Hidden mod's fade factor (1 without Hidden). */
  hiddenAlpha(h: OsuHitObject, time: number, parent?: OsuHitObject): number;
  readonly hidden: boolean;
  readonly hitLighting: boolean;
  readonly snakingIn: boolean;
  readonly snakingOut: boolean;
}

interface CircleTextures {
  circle: SkinTexture | null;
  overlay: SkinTexture | null;
}

interface JudgementPiece {
  kind: 'old' | 'new' | 'tick';
  main: SkinAnimation | null;
  tickTexture?: SkinTexture;
  particle: SkinTexture | null;
}

interface ActiveJudgement {
  piece: JudgementPiece | null;
  result: HitResult;
  time: number;
  x: number;
  y: number;
  scale: number;
  colour: RGB;
  isTick: boolean;
  rotation: number;
  particles: { distance: number; duration: number; direction: number }[] | null;
}

interface FollowCircleState {
  scale: Prop;
  alpha: Prop;
  lastTracking: boolean;
}

/** Random in [min, max) (osu.Framework.Utils.RNG.NextSingle). */
const rng = (min: number, max: number) => min + Math.random() * (max - min);

const rgbToComponents = (c: readonly number[]): [number, number, number] => [c[0], c[1], c[2]];

/**
 * Renders osu! hit objects with legacy skin elements. Components are only used when the skin chain provides them
 * (mirroring the conditions in OsuLegacySkinTransformer); `has` tells DrawableOsuRuleset which ones to draw procedurally instead.
 */
export class OsuLegacySkinRenderer {
  readonly source: SkinSource;
  readonly has: {
    hitCircle: boolean;
    approachCircle: boolean;
    sliderBall: boolean;
    followCircle: boolean;
    sliderScorePoint: boolean;
    followPoint: boolean;
    cursor: boolean;
    cursorTrail: boolean;
    spinner: boolean;
    lighting: boolean;
    hitCircleText: boolean;
  };

  private readonly version: number | null;
  private readonly controlPoints: ControlPointInfo;

  // ---- resolved components
  private readonly circleTextures = new Map<string, CircleTextures>();
  private readonly overlayAboveNumber: boolean;
  private readonly approachCircle: SkinTexture | null;
  private readonly hitCircleFont: SkinSource | null;
  private readonly numberCache = new Map<number, LegacyText | null>();
  private readonly reverseArrow: SkinTexture | null;
  private readonly sliderBorder: RGB;
  private readonly trackOverride: RGB | null;
  private readonly ball: {
    textures: SkinTexture[];
    nd: SkinTexture | null;
    spec: SkinTexture | null;
    colour: RGB;
    tint: boolean;
  } | null;
  private readonly followCircle: SkinAnimation | null;
  private readonly scorePoint: SkinTexture | null;
  private readonly followPoint: SkinAnimation | null;
  private readonly lighting: SkinTexture | null;
  private readonly judgementPieces = new Map<HitResult, JudgementPiece | null | 'empty'>();
  readonly spinnerFrequencyModulate: boolean;

  constructor(
    sources: readonly LoadedSkin[],
    private readonly host: OsuLegacyHost,
    ctx: GameplayContext,
    controlPoints: ControlPointInfo,
    private readonly objects: readonly OsuHitObject[],
  ) {
    const source = new SkinSource(sources);
    this.source = source;
    this.controlPoints = controlPoints;
    this.version = source.version;

    const hasHitCircle = source.hasTexture('hitcircle');
    // OsuSkinConfiguration.HitCircleOverlayAboveNumber (HitCircleOverlayAboveNumer typo still supported)
    this.overlayAboveNumber = source.getBool('HitCircleOverlayAboveNumber') ?? source.getBool('HitCircleOverlayAboveNumer') ?? true;

    this.approachCircle = source.getTexture('approachcircle', MAX_CIRCLE_SIZE);

    this.hitCircleFont = source.fontProvider(LegacyFont.HitCircle) ? source : null;

    this.reverseArrow = source.providerOf('reversearrow')?.getTexture('reversearrow', MAX_CIRCLE_SIZE) ?? null;

    const border = ctx.skin.sliderBorder ?? source.customColour('SliderBorder');
    this.sliderBorder = border ? rgbToComponents(border) : [255, 255, 255];
    const track = ctx.skin.sliderTrackOverride ?? source.customColour('SliderTrackOverride');
    this.trackOverride = track ? rgbToComponents(track) : null;

    // LegacySliderBall: from the first skin providing "sliderb" or "sliderb0".
    const ballSkin = source.findProvider(s => s.getSkinTexture('sliderb') != null || s.getSkinTexture('sliderb0') != null);
    if (ballSkin) {
      const s = source.only(ballSkin);
      const colour = s.customColour('SliderBall');
      this.ball = {
        textures: s.getTextures('sliderb', true, '', MAX_FOLLOW_CIRCLE_AREA).textures,
        nd: s.getTexture('sliderb-nd', MAX_FOLLOW_CIRCLE_AREA),
        spec: s.getTexture('sliderb-spec', MAX_FOLLOW_CIRCLE_AREA),
        colour: colour ? rgbToComponents(colour) : [255, 255, 255],
        tint: s.getBool('AllowSliderBallTint') === true,
      };
    } else this.ball = null;

    this.followCircle = this.perSkinAnimation(s => s.getAnimation('sliderfollowcircle', true, true, true, '-', undefined, MAX_FOLLOW_CIRCLE_AREA));
    this.scorePoint = this.perSkinAnimation(s => s.getAnimation('sliderscorepoint', false, false, false, '-', undefined, OBJECT_SIZE))?.frames[0] ?? null;
    this.followPoint = this.perSkinAnimation(s => s.getAnimation('followpoint', true, true, true, '-', undefined, { width: OBJECT_RADIUS * 2, height: OBJECT_RADIUS }));
    this.lighting = this.perSkinAnimation(s => s.getAnimation('lighting', false, false))?.frames[0] ?? null;

    // Cursor + trail (LegacyCursor / LegacyCursorTrail use the providing skin).
    const cursorSkin = source.findProvider(s => s.getSkinTexture('cursor') != null);
    const trailSkin = source.findProvider(s => s.getSkinTexture('cursortrail') != null);
    if (cursorSkin) {
      const s = source.only(cursorSkin);
      this.cursorState = {
        cursor: withScaleAdjust(s.getTexture('cursor')!, s.getTexture('cursor')!.scaleAdjust * STABLE_MAGIC_SCALE_FACTOR),
        middle: scaleAdjusted(s.getTexture('cursormiddle')),
        centre: s.getBool('CursorCentre') ?? true,
        spin: s.getBool('CursorRotate') ?? true,
      };
    }
    this.cursorExpand = source.getBool('CursorExpand') ?? true;
    if (trailSkin) {
      const s = source.only(trailSkin);
      // Cursor and cursor trail components are sourced from potentially different skin sources.
      // Stable always chooses cursor trail disjoint behaviour based on the cursor texture lookup source, so we need to fetch where that occurred.
      const cursorProvider = source.providerOf('cursor');
      const disjoint = cursorProvider?.getTexture('cursormiddle') == null;
      this.trail = {
        texture: scaleAdjusted(s.getTexture('cursortrail'))!,
        disjoint,
        centre: s.getBool('CursorCentre') ?? true,
        allowRotation: s.getBool('CursorTrailRotate') ?? true,
        parts: [],
        lastPosition: null,
        lastTrailTime: -Infinity,
      };
    }

    // Spinner style (first skin providing either style).
    const spinnerSkin = source.findProvider(s => s.getSkinTexture('spinner-background') != null || s.getSkinTexture('spinner-top') != null);
    if (spinnerSkin) {
      const hasBackground = spinnerSkin.getSkinTexture('spinner-background') != null;
      this.spinnerStyle = hasBackground ? 'old' : 'new';
    }
    this.spinnerNoBlink = source.getBool('SpinnerNoBlink') === true;
    this.spinnerFrequencyModulate = source.getBool('SpinnerFrequencyModulate') ?? true;
    const spinnerBackground = source.customColour('SpinnerBackground');
    this.spinnerBackground = spinnerBackground ? rgbToComponents(spinnerBackground) : [100, 100, 100];

    this.has = {
      hitCircle: hasHitCircle,
      approachCircle: this.approachCircle != null,
      sliderBall: this.ball != null && this.ball.textures.length > 0,
      followCircle: this.followCircle != null,
      sliderScorePoint: this.scorePoint != null,
      followPoint: this.followPoint != null,
      cursor: this.cursorState != null,
      cursorTrail: this.trail != null,
      spinner: this.spinnerStyle != null,
      lighting: this.lighting != null,
      hitCircleText: this.hitCircleFont != null,
    };
  }

  /** A component created by the first skin (transformer) which provides it. */
  private perSkinAnimation(get: (s: SkinSource) => SkinAnimation | null): SkinAnimation | null {
    for (const s of this.source.sources) {
      const a = get(this.source.only(s));
      if (a) return a;
    }
    return null;
  }

  // ================================================================================================ hit circles

  /** LegacyMainCirclePiece texture resolution, cached per priority lookup prefix. */
  private texturesFor(prefix: string | null): CircleTextures {
    const key = prefix ?? '';
    let t = this.circleTextures.get(key);
    if (!t) {
      const base = 'hitcircle';
      // As a precondition, prefer that any *prefix* lookups are run against the skin which is providing "hitcircle".
      const provider = this.source.providerOf(base) ?? this.source;
      // if a base texture for the specified prefix exists, continue using it for subsequent lookups.
      // otherwise fall back to the default prefix "hitcircle".
      const circleName = prefix != null && provider.getTexture(prefix) != null ? prefix : base;
      t = {
        circle: this.source.getTexture(circleName, MAX_CIRCLE_SIZE),
        overlay: this.source.getTexture(`${circleName}overlay`, MAX_CIRCLE_SIZE),
      };
      this.circleTextures.set(key, t);
    }
    return t;
  }

  private numberText(n: number): LegacyText | null {
    let t = this.numberCache.get(n);
    if (t === undefined) {
      t = this.hitCircleFont
        ? layoutLegacyText(this.hitCircleFont, LegacyFont.HitCircle, String(n), { width: (OBJECT_DIMENSIONS * 2) / HITCIRCLE_TEXT_SCALE, height: (OBJECT_DIMENSIONS * 2) / HITCIRCLE_TEXT_SCALE })
        : null;
      this.numberCache.set(n, t);
    }
    return t;
  }

  /** LegacyKiaiFlashingDrawable: additive flash at each beat during kiai time. */
  private kiaiFlash(time: number): number {
    const tp = this.controlPoints.timingPointAt(time);
    let beatLength = tp.beatLength;
    // BeatSyncedContainer.MinimumBeatLength
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
   * Draws a LegacyMainCirclePiece. `layer` allows splitting the piece as LegacySliderHeadHitCircle does
   * (its overlay layer is proxied above the slider's repeats/ball).
   */
  private drawMainCirclePiece(
    g: CanvasRenderingContext2D,
    x: number,
    y: number,
    scale: number,
    colour: RGB,
    prefix: string | null,
    number: number | null,
    alpha: number,
    state: JudgeView,
    time: number,
    layer: 'all' | 'circle' | 'overlay' = 'all',
  ): void {
    if (alpha <= 0) return;
    const tex = this.texturesFor(prefix);

    let pieceAlpha = 1;
    let pieceScale = 1;
    let numberAlpha = 1;
    let numberScale = 1;
    if (state.judged && isHit(state.result)) {
      const t0 = state.judgedAt;
      pieceAlpha = 1 - progress(time, t0, LEGACY_FADE_DURATION);
      pieceScale = 1 + 0.4 * progress(time, t0, LEGACY_FADE_DURATION, Easing.Out);
      if (this.version != null && this.version > 1.0) {
        // legacy skins of version 2.0 and newer only apply very short fade out to the number piece.
        numberAlpha = 1 - progress(time, t0, LEGACY_FADE_DURATION / 4);
      } else {
        // old skins scale and fade it normally along other pieces.
        numberAlpha = pieceAlpha;
        numberScale = pieceScale;
      }
    }

    const s = scale * pieceScale;
    if (layer !== 'overlay') {
      // CircleSprite: tinted with the combo colour.
      drawSprite(g, tex.circle, x, y, { scale: s, alpha: alpha * pieceAlpha, colour });
    }

    if (layer !== 'circle') {
      const drawOverlay = () => drawSprite(g, tex.overlay, x, y, { scale: s, alpha: alpha * pieceAlpha });
      const drawNumber = () => {
        if (number == null || numberAlpha <= 0) return;
        const text = this.numberText(number);
        if (text) drawLegacyText(g, text, x, y, scale * numberScale * HITCIRCLE_TEXT_SCALE, 0.5, 0.5, alpha * numberAlpha);
        else drawFallbackNumber(g, number, x, y, scale * numberScale, alpha * numberAlpha);
      };
      if (this.overlayAboveNumber) {
        drawNumber();
        drawOverlay();
      } else {
        drawOverlay();
        drawNumber();
      }
    }

    if (layer !== 'overlay') {
      // FlashingDrawable proxy: drawn above the overlay layer.
      const flash = this.kiaiFlash(time);
      if (flash > 0 && tex.circle) {
        const add = Math.max(25, 300 - colour[0] - colour[1] - colour[2]);
        const kiaiTint: RGB = [Math.min(colour[0] + add, 255), Math.min(colour[1] + add, 255), Math.min(colour[2] + add, 255)];
        drawSprite(g, tex.circle, x, y, { scale: s, alpha: alpha * pieceAlpha * flash, colour: kiaiTint, additive: true });
      }
    }
  }

  /** DrawableHitCircle with a LegacyMainCirclePiece. */
  drawHitCircle(g: CanvasRenderingContext2D, c: HitCircle, time: number, layer: 'all' | 'circle' | 'overlay' = 'all', colourSource: OsuHitObject = c): void {
    const state = this.host.judge(c);
    const appear = c.startTime - c.timePreempt;
    if (time < appear) return;
    // CirclePiece.FadeInFromZero(TimeFadeIn)
    let alpha = progress(time, appear, c.timeFadeIn) * this.host.hiddenAlpha(c, time);
    if (state.judged && !isHit(state.result)) alpha *= 1 - progress(time, state.judgedAt, 100); // ArmedState.Miss: FadeOut(100)
    if (state.judged && time > state.judgedAt + 800) return;
    const p = c.stackedPosition;
    const prefix = c instanceof SliderHeadCircle ? 'sliderstartcircle' : null;
    this.drawMainCirclePiece(g, p.x, p.y, c.scale, this.host.comboColour(colourSource), prefix, colourSource.indexInCurrentCombo + 1, alpha, state, time, layer);
  }

  /** LegacyApproachCircle (DrawableHitCircle approach circle transforms). */
  drawApproachCircle(g: CanvasRenderingContext2D, c: HitCircle, colourSource: OsuHitObject, time: number): void {
    const tex = this.approachCircle;
    if (!tex) return;
    const state = this.host.judge(c);
    const appear = c.startTime - c.timePreempt;
    if (time < appear) return;
    if (state.judged && time >= state.judgedAt) return; // ApproachCircle.FadeOut() on judgement
    // FadeTo(0.9, min(TimeFadeIn * 2, TimePreempt)), ScaleTo(1, TimePreempt) from 4, FadeOut(50) at the start time.
    const alpha = new Prop(0).add(appear, Math.min(c.timeFadeIn * 2, c.timePreempt), 0.9).add(c.startTime, 50, 0).at(time);
    if (alpha <= 0) return;
    const scale = valueAt(time, 4, 1, appear, c.startTime);
    const p = c.stackedPosition;
    drawSprite(g, tex, p.x, p.y, { scale: scale * c.scale, alpha, colour: this.host.comboColour(colourSource) });
  }

  // ================================================================================================ sliders

  private readonly bodyCache = new Map<Slider, { key: string; canvas: HTMLCanvasElement | OffscreenCanvas; x: number; y: number; w: number; h: number }>();
  private readonly canvasPool: (HTMLCanvasElement | OffscreenCanvas)[] = [];

  /** Per-frame housekeeping: recycles the cached bodies of sliders which are no longer visible. */
  beginFrame(time: number): void {
    for (const [slider, cached] of this.bodyCache) {
      if (time > slider.endTime + 1000 || time < slider.startTime - slider.timePreempt - 1000) {
        this.bodyCache.delete(slider);
        this.followStates.delete(slider);
        this.ballRotation.delete(slider);
        if (this.canvasPool.length < 8) this.canvasPool.push(cached.canvas);
      }
    }
  }
  private readonly followStates = new Map<Slider, FollowCircleState>();

  /**
   * Draws a slider (DrawableSlider) with legacy pieces. Layering: body, tail, ticks, repeats, head circle,
   * overlay elements (head overlay layer + reverse arrows), ball (follow circle below the ball).
   */
  drawSlider(
    g: CanvasRenderingContext2D,
    slider: Slider,
    time: number,
    body: { points: readonly { x: number; y: number }[]; alpha: number },
    fallback: { ticks(): void; follow(): void; ball(): void },
  ): void {
    const colour = this.host.comboColour(slider);
    const r = slider.radius;
    const head = slider.headCircle;
    const end = this.sliderHitStateUpdateTime(slider);
    // DrawableSlider: FadeOut(240) at the hit state update time.
    const sliderAlpha = time > end ? 1 - progress(time, end, 240) : 1;
    if (sliderAlpha <= 0) return;

    // ---- body
    if (body.alpha > 0 && body.points.length > 0) {
      let a = body.alpha * sliderAlpha;
      // Body.FadeOut(40) when hit with snaking out
      if (time > end && this.host.snakingOut && this.host.judge(head).judged && isHit(this.host.judge(head).result)) a *= 1 - progress(time, end, 40);
      this.drawSliderBody(g, slider, body.points, colour, r, a);
    }

    // ---- tail (proxied below ticks/repeats)
    this.drawEndCircle(g, slider, slider.tailCircle, time, colour, sliderAlpha);

    // ---- ticks
    if (this.scorePoint) this.drawSliderTicks(g, slider, time, sliderAlpha);
    else fallback.ticks();

    // ---- repeats (circle pieces; arrows are proxied to the overlay layer)
    for (const rep of slider.repeats) this.drawEndCircle(g, slider, rep, time, colour, sliderAlpha);

    // ---- head
    this.drawHitCircle(g, head, time, 'circle', slider);

    // ---- overlay elements
    this.drawHitCircle(g, head, time, 'overlay', slider);
    for (const rep of slider.repeats) this.drawReverseArrow(g, slider, rep, time, sliderAlpha);

    // ---- ball
    this.drawBallAndFollowCircle(g, slider, time, sliderAlpha, fallback.follow, fallback.ball);
  }

  /** DrawableSlider's hit state update time (the slider is judged once its end time is reached). */
  private sliderHitStateUpdateTime(slider: Slider): number {
    const state = this.host.judge(slider);
    return state.judged ? Math.max(slider.endTime, state.judgedAt) : slider.endTime;
  }

  /** DrawableSliderBall: follow circle below the ball, each falling back to the procedural piece when the skin lacks it. */
  drawBallAndFollowCircle(g: CanvasRenderingContext2D, slider: Slider, time: number, sliderAlpha: number, proceduralFollow: () => void, proceduralBall: () => void): void {
    const pos = slider.stackedPositionAt(Math.min(1, Math.max(0, (time - slider.startTime) / slider.duration)));
    if (this.followCircle) this.drawFollowCircle(g, slider, time, pos, sliderAlpha);
    else proceduralFollow();
    if (this.has.sliderBall) this.drawBall(g, slider, time, this.host.comboColour(slider), sliderAlpha);
    else proceduralBall();
  }

  /** LegacyDrawableSliderPath.ColourAt, as rendered by SmoothPath (position 0 = edge, 1 = centre). */
  private static sliderColourAt(position: number, border: RGB, accent: [number, number, number, number]): [number, number, number, number] {
    const shadow: [number, number, number, number] = [0, 0, 0, 0.25];
    // Darken(0.1)
    const outer: [number, number, number, number] = [accent[0] / 1.1, accent[1] / 1.1, accent[2] / 1.1, accent[3]];
    // lighten(AccentColour, 0.5): a colour lightening more friendly to dark or strong colours.
    const amount = 0.25;
    const inner: [number, number, number, number] = [
      Math.min(1, accent[0] * (1 + 0.5 * amount) + amount),
      Math.min(1, accent[1] * (1 + 0.5 * amount) + amount),
      Math.min(1, accent[2] * (1 + 0.5 * amount) + amount),
      accent[3],
    ];
    // https://github.com/peppy/osu-stable-reference/blob/3ea48705eb67172c430371dcfc8a16a002ed0d3d/osu!/Graphics/Renderers/MmSliderRendererGL.cs#L59-L70
    const shadowPortion = 1 - LEGACY_CIRCLE_RADIUS / OBJECT_RADIUS;
    const borderPortion = 0.1875;
    const lerp = (a: number[], b: number[], t: number): [number, number, number, number] => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t];
    if (position <= shadowPortion) return lerp([0, 0, 0, 0], shadow, position / shadowPortion);
    if (position <= borderPortion) return [border[0] / 255, border[1] / 255, border[2] / 255, 1];
    return lerp(outer, inner, (position - borderPortion) / (1 - borderPortion));
  }

  private drawSliderBody(g: CanvasRenderingContext2D, slider: Slider, points: readonly { x: number; y: number }[], colour: RGB, r: number, alpha: number): void {
    const m = g.getTransform();
    const pixelScale = Math.hypot(m.a, m.b) || 1;
    const stacked = slider.stackedPosition;

    // Bounding box in playfield units.
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of points) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    minX += stacked.x - r - 1;
    minY += stacked.y - r - 1;
    maxX += stacked.x + r + 1;
    maxY += stacked.y + r + 1;
    const w = maxX - minX;
    const h = maxY - minY;
    const pw = Math.min(4096, Math.ceil(w * pixelScale));
    const ph = Math.min(4096, Math.ceil(h * pixelScale));
    if (pw <= 0 || ph <= 0) return;

    const first = points[0];
    const last = points[points.length - 1];
    const key = `${points.length}|${first.x},${first.y}|${last.x},${last.y}|${pw}x${ph}|${colour.join()}`;
    let cached = this.bodyCache.get(slider);
    if (!cached || cached.key !== key) {
      const canvas = cached?.canvas ?? this.canvasPool.pop() ?? createCanvas(pw, ph);
      if (canvas.width !== pw || canvas.height !== ph) {
        canvas.width = pw;
        canvas.height = ph;
      }
      const c = canvas.getContext('2d') as CanvasRenderingContext2D | null;
      if (!c) return;
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, pw, ph);
      c.setTransform(pw / w, 0, 0, ph / h, (-minX * pw) / w, (-minY * ph) / h);
      c.lineCap = 'round';
      c.lineJoin = 'round';

      // legacy skins use a constant value for slider track alpha, regardless of the source colour.
      const track = this.trackOverride ?? colour;
      const accent: [number, number, number, number] = [track[0] / 255, track[1] / 255, track[2] / 255, 0.7];

      const trace = () => {
        c.beginPath();
        c.moveTo(stacked.x + points[0].x, stacked.y + points[0].y);
        for (let i = 1; i < points.length; i++) c.lineTo(stacked.x + points[i].x, stacked.y + points[i].y);
        if (points.length === 1) c.lineTo(stacked.x + points[0].x + 0.01, stacked.y + points[0].y);
      };

      // The path's radial colour profile is approximated by concentric strokes, outermost first. Each stroke first clears the
      // area it covers so that the final colour at a distance d from the path is exactly ColourAt(1 - d / r) (no alpha stacking).
      const layers: number[] = [0, 0.03, 0.055, 1 - LEGACY_CIRCLE_RADIUS / OBJECT_RADIUS + 0.0001];
      const BODY_LAYERS = 24;
      for (let i = 0; i < BODY_LAYERS; i++) layers.push(0.1875 + 0.0001 + ((1 - 0.1875) * i) / BODY_LAYERS);
      trace();
      for (let i = 0; i < layers.length; i++) {
        const p = layers[i];
        const next = i + 1 < layers.length ? layers[i + 1] : 1;
        const col = OsuLegacySkinRenderer.sliderColourAt((p + next) / 2, this.sliderBorder, accent);
        const width = 2 * r * (1 - p);
        if (width <= 0) continue;
        c.lineWidth = width;
        if (i > 0) {
          c.globalCompositeOperation = 'destination-out';
          c.strokeStyle = '#000';
          c.stroke();
        }
        c.globalCompositeOperation = 'source-over';
        c.strokeStyle = `rgba(${Math.round(col[0] * 255)},${Math.round(col[1] * 255)},${Math.round(col[2] * 255)},${col[3]})`;
        c.stroke();
      }
      cached = { key, canvas, x: minX, y: minY, w, h };
      this.bodyCache.set(slider, cached);
    }

    const prev = g.globalAlpha;
    g.globalAlpha = prev * alpha;
    g.drawImage(cached.canvas, cached.x, cached.y, cached.w, cached.h);
    g.globalAlpha = prev;
  }

  /** DrawableOsuHitObject.ApplyRepeatFadeIn */
  private repeatFadeIn(slider: Slider, end: SliderTailCircle | SliderRepeat, fadeTime: number, time: number): number {
    const initial = end.startTime - end.timePreempt;
    // When snaking in is enabled, the first end circle needs to be delayed until the snaking completes.
    const delayFadeIn = this.host.snakingIn && end.repeatIndex === 0;
    if (end.repeatIndex > 0) fadeTime = Math.min(slider.spanDuration, fadeTime);
    return progress(time, initial + (delayFadeIn ? slider.timePreempt / 3 : 0), fadeTime);
  }

  /** DrawableSliderTail / DrawableSliderRepeat circle piece: LegacyMainCirclePiece("sliderendcircle", false). */
  private drawEndCircle(g: CanvasRenderingContext2D, slider: Slider, end: SliderTailCircle | SliderRepeat, time: number, colour: RGB, sliderAlpha: number): void {
    const state = this.host.judge(end);
    if (time < end.startTime - end.timePreempt) return;
    let alpha = this.repeatFadeIn(slider, end, end.timeFadeIn, time) * sliderAlpha * this.host.hiddenAlpha(end, time, slider);
    if (state.judged) {
      if (end instanceof SliderRepeat) {
        const animDuration = Math.min(300, slider.spanDuration);
        alpha *= 1 - progress(time, state.judgedAt, animDuration, isHit(state.result) ? Easing.Out : Easing.None);
      } else if (!isHit(state.result)) alpha *= 1 - progress(time, state.judgedAt, 100);
      else if (time > state.judgedAt + 800) return;
    }
    if (alpha <= 0) return;
    const p = end.stackedPosition;
    this.drawMainCirclePiece(g, p.x, p.y, end.scale, colour, 'sliderendcircle', null, alpha, state, time);
  }

  /** LegacyReverseArrow (+ DrawableSliderRepeat arrow rotation / fade). */
  private drawReverseArrow(g: CanvasRenderingContext2D, slider: Slider, rep: SliderRepeat, time: number, sliderAlpha: number): void {
    const state = this.host.judge(rep);
    if (time < rep.startTime - rep.timePreempt) return;
    let alpha = this.repeatFadeIn(slider, rep, 150, time) * sliderAlpha * this.host.hiddenAlpha(rep, time, slider);
    const animDuration = Math.min(300, slider.spanDuration);
    const hit = state.judged && isHit(state.result) && time >= state.judgedAt;
    if (state.judged) alpha *= 1 - progress(time, state.judgedAt, animDuration, isHit(state.result) ? Easing.Out : Easing.None);
    if (alpha <= 0) return;

    const pos = rep.stackedPosition;
    // DrawableSliderRepeat.UpdateSnakingPosition: aim at the next distinct point of the curve.
    const curve = slider.path.path;
    const atEnd = rep.repeatIndex % 2 === 0;
    const local = { x: rep.position.x - slider.position.x, y: rep.position.y - slider.position.y };
    let aim = { x: 0, y: 0 };
    for (let i = atEnd ? curve.length - 1 : 0; i >= 0 && i < curve.length; i += atEnd ? -1 : 1) {
      if (Math.abs(curve[i].x - local.x) < 1e-3 && Math.abs(curve[i].y - local.y) < 1e-3) continue;
      aim = curve[i];
      break;
    }
    let rotation = (Math.atan2(aim.y - local.y, aim.x - local.x) * 180) / Math.PI;

    let scale: number;
    if (hit) scale = valueAt(time, 1, 1.4, state.judgedAt, state.judgedAt + animDuration, Easing.Out);
    else {
      const duration = 300;
      const rot = 5.625;
      const animationStart = rep.startTime - rep.timePreempt;
      const loopCurrentTime = (((time - animationStart) % duration) + duration) % duration;
      // Reference: https://github.com/peppy/osu-stable-reference/blob/2280c4c436f80d04f9c79d3c905db00ac2902273/osu!/GameplayElements/HitObjects/Osu/HitCircleSliderEnd.cs#L79-L96
      if (this.version != null && this.version <= 1) {
        rotation += valueAt(loopCurrentTime, rot, -rot, 0, duration);
        scale = valueAt(loopCurrentTime, 1.3, 1, 0, duration);
      } else scale = valueAt(loopCurrentTime, 1.3, 1, 0, duration, Easing.Out);
    }

    if (this.reverseArrow) drawSprite(g, this.reverseArrow, pos.x, pos.y, { scale: scale * rep.scale, rotation, alpha });
    else drawFallbackArrow(g, pos.x, pos.y, (rotation * Math.PI) / 180, slider.radius * scale, alpha);
  }

  /** DrawableSliderTick with a "sliderscorepoint" sprite. */
  drawSliderTicks(g: CanvasRenderingContext2D, slider: Slider, time: number, sliderAlpha = 1): void {
    for (const t of slider.ticks) {
      const state = this.host.judge(t);
      const initial = t.startTime - t.timePreempt;
      if (time < initial) continue;
      let alpha = progress(time, initial, ANIM_DURATION) * sliderAlpha * this.host.hiddenAlpha(t, time, slider);
      let scale = valueAt(time, 0.5, 1, initial, initial + ANIM_DURATION * 4, Easing.OutElasticHalf);
      if (state.judged) {
        if (time > state.judgedAt + ANIM_DURATION) continue;
        alpha *= 1 - progress(time, state.judgedAt, ANIM_DURATION, Easing.OutQuint);
        if (isHit(state.result)) scale *= valueAt(time, 1, 1.5, state.judgedAt, state.judgedAt + ANIM_DURATION, Easing.Out);
      }
      if (alpha <= 0) continue;
      const p = t.stackedPosition;
      drawSprite(g, this.scorePoint, p.x, p.y, { scale: scale * t.scale, alpha });
    }
  }

  /** DrawableSliderBall with LegacySliderBall and LegacyFollowCircle. */
  private drawBall(g: CanvasRenderingContext2D, slider: Slider, time: number, colour: RGB, sliderAlpha: number): void {
    const hitStateUpdateTime = this.sliderHitStateUpdateTime(slider);
    const progressAt = (t: number) => Math.min(1, Math.max(0, (t - slider.startTime) / slider.duration));
    const pos = slider.stackedPositionAt(progressAt(time));

    // Ball: FadeIn at the start time, FadeOut at the hit state update time.
    const ball = this.ball!;
    if (time < slider.startTime || time >= hitStateUpdateTime) return;
    const completion = progressAt(time);
    const checkDistance = 0.1 / slider.path.distance;
    const a = slider.curvePositionAt(Math.min(1 - checkDistance, completion));
    const b = slider.curvePositionAt(Math.min(1, completion + checkDistance));
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    let rotation = this.ballRotation.get(slider) ?? 0;
    if (Math.hypot(dx, dy) >= 0.01) {
      rotation = -90 + (-Math.atan2(dx, dy) * 180) / Math.PI;
      this.ballRotation.set(slider, rotation);
    }

    const frameDelay = Math.max((0.15 / slider.velocity) * SIXTY_FRAME_TIME, SIXTY_FRAME_TIME);
    const frames = ball.textures;
    const elapsed = time - (slider.startTime - slider.timePreempt);
    const frame = frames.length > 1 ? frames[Math.floor((((elapsed / frameDelay) % frames.length) + frames.length) % frames.length)] : frames[0];
    const s = slider.scale;
    const ballColour = ball.tint ? colour : ball.colour;

    drawSprite(g, ball.nd, pos.x, pos.y, { scale: s, alpha: sliderAlpha, colour: [5, 5, 5] });
    drawSprite(g, frame, pos.x, pos.y, { scale: s, rotation, alpha: sliderAlpha, colour: ballColour });
    drawSprite(g, ball.spec, pos.x, pos.y, { scale: s, alpha: sliderAlpha, additive: true });
  }

  private readonly ballRotation = new Map<Slider, number>();

  private followState(slider: Slider): FollowCircleState {
    let st = this.followStates.get(slider);
    if (!st) {
      // onHitObjectApplied: ScaleTo(1), FadeOut()
      st = { scale: new Prop(1), alpha: new Prop(0), lastTracking: false };
      this.followStates.set(slider, st);
    }
    return st;
  }

  /** Polls tracking state changes (FollowCircle.tracking bindable). */
  private updateFollowTracking(slider: Slider, time: number): void {
    const st = this.followState(slider);
    const tracking = this.host.sliderTracking(slider);
    if (tracking.tracking === st.lastTracking) return;
    st.lastTracking = tracking.tracking;
    const sliderState = this.host.judge(slider);
    if (sliderState.judged) return;
    const t = Math.max(Math.min(time, tracking.lastTrackingChange), slider.startTime);
    if (tracking.tracking) {
      // OnSliderPress
      const remaining = Math.max(0, slider.endTime - t);
      // Note that the scale adjust here is 2 instead of DrawableSliderBall.FOLLOW_AREA to match legacy behaviour.
      st.scale.set(t, 1).add(t, Math.min(180, remaining), 2, Easing.Out);
      st.alpha.set(t, 0).add(t, Math.min(60, remaining), 1);
    }
    // OnSliderRelease: nothing
  }

  /** FollowCircle.updateStateTransforms for nested judgements (ticks, repeats, tail) and the slider end. */
  private onSliderNestedResult(slider: Slider, h: OsuHitObject, result: HitResult, t: number): void {
    const st = this.followState(slider);
    if (isHit(result)) {
      if (h instanceof SliderTailCircle) {
        // OnSliderEnd at the slider's hit state update time
        const end = slider.endTime;
        st.scale.add(end, 200, 1.6, Easing.Out);
        st.alpha.add(end, 200, 0, Easing.In);
      } else if (h instanceof SliderTick || h instanceof SliderRepeat) {
        // OnSliderTick
        if (st.scale.at(t) >= 2) st.scale.set(t, 2.2).add(t, 200, 2);
      }
    } else if (h instanceof SliderTailCircle || h instanceof SliderTick || h instanceof SliderRepeat) {
      // OnSliderBreak
      st.scale.add(t, 100, 4);
      st.alpha.add(t, 100, 0);
    }
  }

  private drawFollowCircle(g: CanvasRenderingContext2D, slider: Slider, time: number, pos: { x: number; y: number }, sliderAlpha: number): void {
    this.updateFollowTracking(slider, time);
    const st = this.followState(slider);
    const alpha = st.alpha.at(time) * sliderAlpha;
    if (alpha <= 0) return;
    const anim = this.followCircle!;
    const frame = anim.frameAt(time - (slider.startTime - slider.timePreempt));
    // follow circles are 2x the hitcircle resolution in legacy skins (since they are scaled down from >1x
    drawSprite(g, frame, pos.x, pos.y, { scale: 0.5 * st.scale.at(time) * slider.scale, alpha });
  }

  // ================================================================================================ spinners

  private readonly spinnerStyle: 'old' | 'new' | null = null;
  private readonly spinnerNoBlink: boolean;
  private readonly spinnerBackground: RGB;
  private readonly spinnerStates = new Map<Spinner, { completedAt: number | null; lastSpins: number; bonus: { time: number; text: string; max: boolean } | null; metreTime: number; metre: number }>();

  /** DrawableSpinner with LegacyNewStyleSpinner / LegacyOldStyleSpinner. */
  drawSpinner(g: CanvasRenderingContext2D, spinner: Spinner, time: number): void {
    const style = this.spinnerStyle;
    if (!style) return;
    const src = this.source;
    const judged = this.host.judge(spinner);
    const sp = this.host.spinner(spinner);
    const hitStateUpdateTime = judged.judged ? judged.judgedAt : spinner.endTime;

    // FadeOut at StartTime - TimePreempt, FadeInFromZero(TimeFadeIn) at StartTime - TimeFadeIn; DrawableSpinner FadeOut(240) when judged.
    let alpha = progress(time, spinner.startTime - spinner.timeFadeIn, spinner.timeFadeIn);
    if (judged.judged) alpha *= 1 - progress(time, judged.judgedAt, 240);
    if (alpha <= 0) return;

    let st = this.spinnerStates.get(spinner);
    if (!st) this.spinnerStates.set(spinner, (st = { completedAt: null, lastSpins: 0, bonus: null, metreTime: -Infinity, metre: 0 }));
    if (st.completedAt == null && sp.progress >= 1) st.completedAt = time;

    // The 640x480 window-space area, centred on the spinner and shifted by -8 (LegacySpinner: Size = 640x480, Position = (0, -8)).
    const left = spinner.position.x - 320;
    const top = spinner.position.y - 8 - 240;
    const cx = spinner.position.x;
    const cy = top + SPINNER_Y_CENTRE;
    const rotation = sp.displayRotation;

    g.save();
    g.globalAlpha *= alpha;

    if (style === 'new') {
      const glow = src.getTexture('spinner-glow');
      const bottom = src.getTexture('spinner-bottom');
      const discTop = src.getTexture('spinner-top');
      const middle2 = src.getTexture('spinner-middle2');
      const middle = src.getTexture('spinner-middle');
      const containerScale = SPRITE_SCALE * (0.8 + applyEasing(Easing.Out, sp.progress) * 0.2);
      const turnRatio = middle2 ? 0.5 : 1;
      const topRotation = rotation * turnRatio;

      // glow: alpha = progress, FadeOut(300) when hit, FlashColour(white, 200) on bonus ticks.
      let glowAlpha = sp.progress;
      if (judged.judged && isHit(judged.result)) glowAlpha *= 1 - progress(time, judged.judgedAt, 300);
      let glowColour: number[] = [3, 151, 255];
      if (st.bonus && time - st.bonus.time < 200 && time >= st.bonus.time) {
        const f = (time - st.bonus.time) / 200;
        glowColour = [255 + (3 - 255) * f, 255 + (151 - 255) * f, 255];
      }
      drawSprite(g, glow, cx, cy, { scale: containerScale, alpha: glowAlpha, colour: glowColour, additive: true });
      drawSprite(g, bottom, cx, cy, { scale: containerScale, rotation: topRotation / 3 });
      drawSprite(g, discTop, cx, cy, { scale: containerScale, rotation: topRotation });
      drawSprite(g, middle2, cx, cy, { scale: containerScale, rotation });
      // fixedMiddle: white, fading to red over the spinner's duration.
      const redness = progress(time, spinner.startTime, spinner.duration);
      drawSprite(g, middle, cx, cy, { scale: containerScale, colour: [255, Math.round(255 * (1 - redness)), Math.round(255 * (1 - redness))] });

      // spinner-approachcircle (only when the "spinner-top" provider isn't the default legacy skin, which is always the case here).
      this.drawSpinnerApproach(g, spinner, time, cx, cy);
    } else {
      const background = src.getTexture('spinner-background');
      const disc = src.getTexture('spinner-circle');
      const metre = src.getTexture('spinner-metre');
      drawSprite(g, background, cx, cy, { scale: SPRITE_SCALE, colour: this.spinnerBackground });
      drawSprite(g, disc, cx, cy, { scale: SPRITE_SCALE, rotation });
      if (metre) {
        // careful: need to call this exactly once for all calculations in a frame as the function has a random factor in it
        if (time !== st.metreTime) {
          st.metre = this.getMetreHeight(sp.progress);
          st.metreTime = time;
        }
        // The metre is masked from the top so that it fills from below.
        const visibleFrom = FINAL_METRE_HEIGHT - st.metre;
        drawSpriteRegion(g, metre, left, top + SPINNER_TOP_OFFSET, SPRITE_SCALE, visibleFrom / SPRITE_SCALE);
      }
      this.drawSpinnerApproach(g, spinner, time, cx, cy);
    }

    // ---- LegacySpinner overlay: spin / clear sprites, bonus counter and SPM counter.
    const spin = src.getTexture('spinner-spin');
    if (spin) {
      let spinAlpha = progress(time, spinner.startTime - spinner.timeFadeIn / 2, spinner.timeFadeIn / 2);
      const spinFadeOutLength = Math.min(400, spinner.duration);
      if (time >= hitStateUpdateTime - spinFadeOutLength) spinAlpha = 1 - progress(time, hitStateUpdateTime - spinFadeOutLength, spinFadeOutLength);
      // DrawableSpinnerTick hit: spin.FadeOut(300)
      const firstTick = spinner.ticks[0];
      const tickState = firstTick ? this.host.judge(firstTick) : null;
      if (tickState?.judged && isHit(tickState.result) && time >= tickState.judgedAt) spinAlpha *= 1 - progress(time, tickState.judgedAt, 300);
      drawSprite(g, spin, cx, top + SPINNER_TOP_OFFSET + 335, { scale: SPRITE_SCALE, alpha: spinAlpha });
    }

    const clear = src.getTexture('spinner-clear');
    if (clear && st.completedAt != null && time >= st.completedAt) {
      const startTime = Math.min(st.completedAt, hitStateUpdateTime - 400);
      let clearAlpha = applyEasing(Easing.Out, Math.min(1, Math.max(0, (time - startTime) / 400)));
      if (time >= hitStateUpdateTime - 50) clearAlpha *= 1 - progress(time, hitStateUpdateTime - 50, 50);
      const clearScale = new Prop(SPRITE_SCALE * 2)
        .set(startTime, SPRITE_SCALE * 2)
        .add(startTime, 240, SPRITE_SCALE * 0.8, Easing.Out)
        .add(startTime + 240, 160, SPRITE_SCALE)
        .at(time);
      drawSprite(g, clear, cx, top + SPINNER_TOP_OFFSET + 115, { scale: clearScale, alpha: clearAlpha });
    }

    // Bonus counter (score font).
    const bonusScore = SCORE_PER_TICK * Math.min(Math.max(sp.completedFullSpins - spinner.spinsRequiredForBonus, 0), spinner.maximumBonusSpins);
    if (sp.completedFullSpins !== st.lastSpins) {
      st.lastSpins = sp.completedFullSpins;
      if (bonusScore > 0) {
        st.bonus = { time, text: String(bonusScore), max: bonusScore === SCORE_PER_TICK * spinner.maximumBonusSpins };
      }
    }
    if (st.bonus) {
      const since = time - st.bonus.time;
      const text = layoutLegacyText(src, LegacyFont.Score, st.bonus.text);
      if (text) {
        let a: number;
        let s: number;
        if (st.bonus.max) {
          a = 1 - applyEasing(Easing.Out, Math.min(1, since / 500));
          s = valueAt(since, 1.4, 1.8, 0, 1000, Easing.Out);
        } else {
          a = 1 - applyEasing(Easing.Out, Math.min(1, since / 800));
          s = valueAt(since, SPRITE_SCALE * 2, SPRITE_SCALE * 1.28, 0, 800, Easing.Out);
        }
        drawLegacyText(g, text, cx, top + SPINNER_TOP_OFFSET + 299, s, 0.5, 0.5, a);
      }
    }

    // SPM counter + background slide up during the fade in.
    const slide = SPM_HIDE_OFFSET * applyEasing(Easing.Out, Math.min(1, Math.max(0, (time - (spinner.startTime - spinner.timeFadeIn)) / spinner.timeFadeIn)));
    const rpmBackground = src.getTexture('spinner-rpm');
    drawSprite(g, rpmBackground, cx - 87, top + 445 + SPM_HIDE_OFFSET - slide, { scale: SPRITE_SCALE, originX: 0, originY: 0 });
    const spm = layoutLegacyText(src, LegacyFont.Score, String(Math.trunc(sp.rpm)));
    if (spm) drawLegacyText(g, spm, cx + 80, top + 448 + SPM_HIDE_OFFSET - slide, SPRITE_SCALE * 0.9, 1, 0);

    g.restore();
  }

  private drawSpinnerApproach(g: CanvasRenderingContext2D, spinner: Spinner, time: number, cx: number, cy: number): void {
    const tex = this.source.getTexture('spinner-approachcircle');
    if (!tex) return;
    const scale = valueAt(time, SPRITE_SCALE * 1.86, SPRITE_SCALE * 0.1, spinner.startTime, spinner.endTime);
    drawSprite(g, tex, cx, cy, { scale });
  }

  /** LegacyOldStyleSpinner.getMetreHeight */
  private getMetreHeight(p: number): number {
    p *= 100;
    const blink = !this.spinnerNoBlink;
    // the spinner should still blink at 100% progress.
    if (blink) p = Math.min(99, p);
    let barCount = Math.trunc(Math.trunc(p) / 10);
    if (blink && Math.random() < (Math.trunc(p) % 10) / 10) barCount++;
    return (barCount / TOTAL_BARS) * FINAL_METRE_HEIGHT;
  }

  // ================================================================================================ follow points

  /** FollowPointConnection with a legacy "followpoint" animation. */
  drawFollowPoints(g: CanvasRenderingContext2D, time: number, firstIndex: number): void {
    const anim = this.followPoint!;
    const objs = this.objects;
    for (let i = Math.max(0, firstIndex - 1); i < objs.length - 1; i++) {
      const start = objs[i];
      const end = objs[i + 1];
      if (start.startTime - FOLLOW_POINT_PREEMPT * 2 > time) break;
      if (end.newCombo || start instanceof Spinner || end instanceof Spinner) continue;

      const startTime = start.endTime;
      const startPosition = start.stackedEndPosition;
      const endPosition = end.stackedPosition;
      const vx = endPosition.x - startPosition.x;
      const vy = endPosition.y - startPosition.y;
      const distance = Math.trunc(Math.fround(Math.hypot(vx, vy)));
      const rotation = (Math.atan2(vy, vx) * 180) / Math.PI;
      const duration = end.startTime - startTime;
      // Preempt time can go below 800ms (AR>10), extending the upper linear preempt function.
      const preempt = FOLLOW_POINT_PREEMPT * Math.min(1, start.timePreempt / PREEMPT_MIN);

      for (let d = Math.trunc(FOLLOW_POINT_SPACING * 1.5); d < distance - FOLLOW_POINT_SPACING; d += FOLLOW_POINT_SPACING) {
        const fraction = Math.fround(d / distance);
        const fadeOutTime = startTime + fraction * duration;
        const fadeInTime = fadeOutTime - preempt;
        if (time < fadeInTime || time > fadeOutTime + 400) continue;

        // stable uses `HitObjectManager.TimeFadeIn` (a constant 400) for this
        const k = applyEasing(Easing.Out, Math.min(1, (time - fadeInTime) / 400));
        let alpha = Math.min(1, (time - fadeInTime) / 400);
        if (time >= fadeOutTime) alpha = 1 - (time - fadeOutTime) / 400;
        if (alpha <= 0) continue;
        const px = startPosition.x + (fraction - 0.1 + 0.1 * k) * vx;
        const py = startPosition.y + (fraction - 0.1 + 0.1 * k) * vy;
        const scale = 1.5 * end.scale + (end.scale - 1.5 * end.scale) * k;
        drawSprite(g, anim.frameAt(time - fadeInTime), px, py, { scale, rotation, alpha });
      }
    }
  }

  // ================================================================================================ judgements

  private readonly judgements: ActiveJudgement[] = [];

  /** LegacySkin.getJudgementAnimation / getParticleTexture + OsuLegacySkinTransformer's slider point handling. */
  private judgementPiece(result: HitResult): JudgementPiece | null | 'empty' {
    if (this.judgementPieces.has(result)) return this.judgementPieces.get(result)!;
    let piece: JudgementPiece | null | 'empty' = null;
    for (const skin of this.source.sources) {
      const s = this.source.only(skin);
      const sliderPoint = (r: HitResult) => {
        // https://github.com/peppy/osu-stable-reference/blob/0e91e49bc83fe8b21c3ba5f1eb2d5d06456eae84/osu!/GameModes/Play/Rulesets/Ruleset.cs#L799
        const v = s.version;
        if (v != null && v < 2) return s.getTexture(r === HitResult.LargeTickHit ? 'sliderpoint30' : 'sliderpoint10');
        return null;
      };
      if (result === HitResult.LargeTickHit || result === HitResult.SliderTailHit) {
        const t = sliderPoint(result);
        if (t) {
          piece = { kind: 'tick', main: null, tickTexture: t, particle: null };
          break;
        }
        continue;
      }
      const name =
        result === HitResult.Miss
          ? 'hit0'
          : result === HitResult.LargeTickMiss
            ? 'slidertickmiss'
            : result === HitResult.IgnoreMiss
              ? 'sliderendmiss'
              : result === HitResult.Meh
                ? 'hit50'
                : result === HitResult.Ok
                  ? 'hit100'
                  : result === HitResult.Great
                    ? 'hit300'
                    : null;
      if (!name) break;
      const main = s.getAnimation(name, true, false);
      if (main) {
        const particleName = result === HitResult.Meh ? 'particle50' : result === HitResult.Ok ? 'particle100' : result === HitResult.Great ? 'particle300' : null;
        const particle = particleName ? s.getTexture(particleName) : null;
        piece = { kind: particle ? 'new' : 'old', main, particle };
        break;
      }
      // If the corresponding hit result displays a judgement and the miss texture isn't provided by this skin, don't look up the miss texture from any further skins.
      if ((result === HitResult.LargeTickMiss || result === HitResult.IgnoreMiss) && sliderPoint(result === HitResult.LargeTickMiss ? HitResult.LargeTickHit : HitResult.SliderTailHit)) {
        piece = 'empty';
        break;
      }
    }
    this.judgementPieces.set(result, piece);
    return piece;
  }

  /**
   * Whether the skin displays the given result (otherwise DrawableOsuRuleset shows its procedural popup).
   * Called for every result DrawableOsuJudgement would be created for.
   */
  handlesJudgement(result: HitResult): boolean {
    return this.judgementPiece(result) != null;
  }

  /** OsuPlayfield.onNewResult → DrawableOsuJudgement (and FollowCircle state for slider nested objects). */
  onResult(h: OsuHitObject, result: HitResult, time: number, slider: Slider | null): void {
    if (slider) this.onSliderNestedResult(slider, h, result, time);

    // DisplayResult: everything except spinner ticks and (non-classic) sliders.
    if (h instanceof Slider || (h instanceof OsuHitObject && (h.kind === 'spinnerTick' || h.kind === 'spinnerBonusTick'))) return;
    if (result === HitResult.None) return;
    const piece = this.judgementPiece(result);
    // SkinnableLighting: transparent for ticks (HitResult.IsTick, which includes the slider tail).
    const tick = isTick(result);
    const showsLighting = this.lighting != null && this.host.hitLighting && isHit(result) && !tick;
    if ((piece == null || piece === 'empty') && !showsLighting) return;
    const p = h instanceof Spinner ? h.position : h.stackedPosition;
    const colourSource = slider ?? h;
    this.judgements.push({
      piece: piece === 'empty' ? null : piece,
      result,
      time,
      x: p.x,
      y: p.y,
      scale: h.scale,
      colour: this.host.comboColour(colourSource),
      isTick: tick,
      rotation: isMiss(result) && result === HitResult.Miss ? rng(-8.6, 8.6) : 0,
      particles: piece && piece !== 'empty' && piece.particle ? Array.from({ length: 150 }, () => ({ distance: rng(0, 0.5), duration: rng(1600 / 3, 1600), direction: rng(0, Math.PI * 2) })) : null,
    });
  }

  /** Lighting and new-style judgement main pieces (judgementLayer, below hit objects). */
  drawJudgementsBelow(g: CanvasRenderingContext2D, time: number): void {
    this.pruneJudgements(time);
    for (const j of this.judgements) {
      if (time < j.time) continue;
      const since = time - j.time;
      // DrawableOsuJudgement.ApplyHitAnimations: Lighting.ScaleTo(0.8).ScaleTo(1.2, 600, Out); FadeIn(200).Then().Delay(200).FadeOut(1000)
      if (this.lighting && this.host.hitLighting && isHit(j.result) && !j.isTick) {
        const a = since < 200 ? since / 200 : since < 400 ? 1 : 1 - (since - 400) / 1000;
        const s = valueAt(since, 0.8, 1.2, 0, 600, Easing.Out);
        drawSprite(g, this.lighting, j.x, j.y, { scale: s * j.scale, alpha: a, colour: j.colour, additive: true });
      }
      const piece = j.piece;
      if (piece?.kind === 'new') this.drawNewJudgementMain(g, j, piece, since);
    }
  }

  /** Old-style judgements (and the temporary old style of new-style ones), proxied above hit objects. */
  drawJudgementsAbove(g: CanvasRenderingContext2D, time: number): void {
    for (const j of this.judgements) {
      if (time < j.time - 16) continue;
      const piece = j.piece;
      if (!piece) continue;
      const since = time - j.time;
      if (piece.kind === 'old') this.drawOldJudgement(g, j, piece.main!, since, 1, false, 1, false);
      else if (piece.kind === 'tick') this.drawTickJudgement(g, j, piece.tickTexture!, since);
      else if (piece.kind === 'new' && !isMiss(j.result)) {
        // new style non-miss judgements show the original style temporarily, with additive colour.
        const tempAlpha = new Prop(1).add(j.time - 16, 56, 0.5, Easing.Out).add(j.time + 40, 300, 0).at(time);
        this.drawOldJudgement(g, j, piece.main!, since, 1.05, true, tempAlpha * pieceFade(since), true);
      }
    }
  }

  private pruneJudgements(time: number): void {
    let i = 0;
    while (i < this.judgements.length && time - this.judgements[i].time > 2000) i++;
    if (i > 0) this.judgements.splice(0, i);
  }

  /** LegacyJudgementPieceOld.PlayAnimation */
  private drawOldJudgement(g: CanvasRenderingContext2D, j: ActiveJudgement, anim: SkinAnimation, since: number, finalScale: number, forceTransforms: boolean, alphaOverride: number, additive: boolean): void {
    const t0 = j.time;
    const time = t0 + since;
    const fadeInLength = 120;
    const fadeOutDelay = 500;
    const fadeOutLength = 600;

    const alpha = new Prop(0).add(t0, fadeInLength, 1, Easing.None, 0).add(t0 + fadeOutDelay, fadeOutLength, 0);
    let scale = 1;
    let rotation = 0;
    let y = 0;

    // legacy judgements don't play any transforms if they are an animation.... UNLESS they are the temporary displayed judgement from new piece.
    if (!(anim.frameCount > 1 && !forceTransforms)) {
      if (isMiss(j.result)) {
        if (j.result !== HitResult.Miss) {
          // missed ticks / slider end don't get the normal animation.
          scale = new Prop(1).set(t0, 1.2).add(t0, 100, 1, Easing.In).at(time);
          alpha.add(t0 + fadeOutDelay / 2, fadeOutLength, 0);
        } else {
          scale = new Prop(1).set(t0, 1.6).add(t0, 100, 1, Easing.In).at(time);
          if (this.version != null && this.version > 1.0) y = valueAt(time, -5, 75, t0, t0 + fadeOutDelay + fadeOutLength, Easing.In);
          rotation = new Prop(0).set(t0, 0).add(t0, fadeInLength, j.rotation).add(t0 + fadeInLength, fadeOutDelay + fadeOutLength - fadeInLength, j.rotation * 2, Easing.In).at(time);
        }
      } else {
        scale = new Prop(1)
          .set(t0, 0.6)
          .add(t0, fadeInLength * 0.8, 1.1)
          .add(t0 + fadeInLength, fadeInLength * 0.2, 0.9)
          // stable dictates scale of 0.9->1 over time 1.0 to 1.4, but we are already at 1.2.
          // so we need to force the current value to be correct at 1.2 (0.95) then complete the second half of the transform.
          .set(t0 + fadeInLength * 1.2, 0.95)
          .add(t0 + fadeInLength * 1.2, fadeInLength * 0.2, finalScale)
          .at(time);
      }
    }

    const a = alpha.at(time) * alphaOverride;
    if (a <= 0) return;
    drawSprite(g, anim.frameAt(since), j.x, j.y + y * j.scale, { scale: scale * j.scale, rotation, alpha: a, additive });
  }

  /** LegacyJudgementPieceNew: main piece (and particles), drawn below hit objects. */
  private drawNewJudgementMain(g: CanvasRenderingContext2D, j: ActiveJudgement, piece: JudgementPiece, since: number): void {
    const fade = pieceFade(since);
    if (fade <= 0) return;
    if (j.particles && piece.particle) {
      // ParticleExplosion(texture, 150, 1600), Size = 140, restarted 100ms into its animation.
      const t = since + 100;
      const explosionAlpha = 1 - Math.min(1, t / 1600);
      for (const p of j.particles) {
        const pr = Math.min(1, Math.max(0, t / p.duration));
        const travelled = p.distance * pr;
        const px = j.x + travelled * Math.sin(p.direction) * 140 * j.scale;
        const py = j.y + travelled * Math.cos(p.direction) * 140 * j.scale;
        drawSprite(g, piece.particle, px, py, { scale: j.scale, alpha: fade * explosionAlpha * (1 - pr), additive: true });
      }
    }
    const anim = piece.main!;
    const scale = anim.frameCount > 1 ? 1 : valueAt(since, 0.9, 1.05, 0, 1100);
    drawSprite(g, anim.frameAt(since), j.x, j.y, { scale: scale * j.scale, alpha: fade });
  }

  /** LegacyJudgementPieceSliderTickHit */
  private drawTickJudgement(g: CanvasRenderingContext2D, j: ActiveJudgement, tex: SkinTexture, since: number): void {
    // https://github.com/peppy/osu-stable-reference/blob/0e91e49bc83fe8b21c3ba5f1eb2d5d06456eae84/osu!/GameModes/Play/Rulesets/Ruleset.cs#L804-L806
    const y = valueAt(since, 0, -10, 0, 300, Easing.Out);
    const a = 1 - progress(since, 300, 60);
    drawSprite(g, tex, j.x, j.y + y * j.scale, { scale: j.scale, alpha: a });
  }

  // ================================================================================================ cursor

  private readonly cursorState: { cursor: SkinTexture; middle: SkinTexture | null; centre: boolean; spin: boolean } | null = null;
  private readonly cursorExpand: boolean;
  private readonly expandScale = new Prop(1);
  private lastPressed = false;
  private readonly trail: {
    texture: SkinTexture;
    disjoint: boolean;
    centre: boolean;
    allowRotation: boolean;
    parts: { x: number; y: number; time: number; scale: number }[];
    lastPosition: { x: number; y: number } | null;
    lastTrailTime: number;
  } | null = null;

  /**
   * LegacyCursor + LegacyCursorTrail. Positions are in playfield units; `toScreen` maps them to the screen,
   * `playfieldScale` is the playfield's scale and `cursorScale` the user's cursor size (OsuCursor.CursorScale).
   */
  drawCursor(g: CanvasRenderingContext2D, x: number, y: number, pressed: boolean, time: number, playfieldScale: number, offsetX: number, offsetY: number, cursorScale: number, drawTrail: boolean, cursorSize: number): void {
    // Expand / Contract
    if (pressed !== this.lastPressed) {
      this.lastPressed = pressed;
      if (pressed) {
        if (this.cursorExpand) this.expandScale.set(time, 1).add(time, 100, 1.3, Easing.Out);
      } else this.expandScale.add(time, 100, 1, Easing.Out);
    }
    const expanded = this.expandScale.at(time);
    const rotation = this.cursorState?.spin ? ((time % 10000) / 10000) * 360 : 0;

    if (this.trail && drawTrail) this.drawTrail(g, x, y, time, playfieldScale, offsetX, offsetY, cursorScale, cursorSize, expanded, rotation);

    const c = this.cursorState;
    if (!c) return;
    const sx = offsetX + x * playfieldScale;
    const sy = offsetY + y * playfieldScale;
    const s = playfieldScale * cursorScale;
    const origin = c.centre ? 0.5 : 0;
    drawSprite(g, c.cursor, sx, sy, { scale: s * expanded, rotation, originX: origin, originY: origin });
    drawSprite(g, c.middle, sx, sy, { scale: s, originX: origin, originY: origin });
  }

  private drawTrail(g: CanvasRenderingContext2D, x: number, y: number, time: number, playfieldScale: number, offsetX: number, offsetY: number, cursorScale: number, cursorSize: number, partScale: number, rotation: number): void {
    const trail = this.trail!;
    const fadeDuration = trail.disjoint ? 150 : 500;
    const addPart = (px: number, py: number) => trail.parts.push({ x: px, y: py, time, scale: partScale });

    if (trail.disjoint) {
      // Disjoint trails add a part every 1000 / 60 ms at the current position.
      if (time - trail.lastTrailTime >= 1000 / 60) {
        trail.lastTrailTime = time;
        addPart(x, y);
      }
    } else if (!trail.lastPosition) {
      trail.lastPosition = { x, y };
    } else {
      // Interpolated movement: parts every `interval`, avoiding drawing near the cursor.
      const p1 = trail.lastPosition;
      const dx = x - p1.x;
      const dy = y - p1.y;
      const distance = Math.hypot(dx, dy);
      if (distance > 0) {
        const interval = (displayWidth(trail.texture) * cursorScale) / 2.5 / Math.max(cursorSize, 1);
        const stopAt = distance - interval;
        if (interval > 0) {
          for (let d = interval; d < stopAt; d += interval) {
            trail.lastPosition = { x: p1.x + (dx / distance) * d, y: p1.y + (dy / distance) * d };
            addPart(trail.lastPosition.x, trail.lastPosition.y);
          }
        }
      }
    }

    while (trail.parts.length > 0 && (time - trail.parts[0].time >= fadeDuration || trail.parts[0].time > time)) trail.parts.shift();
    if (trail.parts.length > 2048) trail.parts.splice(0, trail.parts.length - 2048);

    const origin = trail.disjoint && !trail.centre ? 0 : 0.5;
    const angle = trail.allowRotation ? rotation : 0;
    for (const p of trail.parts) {
      // CursorTrail shader: alpha = pow(1 - age / FadeDuration, FadeExponent = 1)
      const a = 1 - (time - p.time) / fadeDuration;
      if (a <= 0) continue;
      drawSprite(g, trail.texture, offsetX + p.x * playfieldScale, offsetY + p.y * playfieldScale, {
        scale: playfieldScale * cursorScale * p.scale,
        rotation: angle,
        alpha: a,
        originX: origin,
        originY: origin,
        additive: !trail.disjoint,
      });
    }
  }

  dispose(): void {
    this.bodyCache.clear();
    this.canvasPool.length = 0;
  }
}

function scaleAdjusted(t: SkinTexture | null): SkinTexture | null {
  // NonPlayfieldSprite / LegacyCursorTrail: stable "magic ratio".
  return t ? withScaleAdjust(t, t.scaleAdjust * STABLE_MAGIC_SCALE_FACTOR) : null;
}

/** LegacyJudgementPieceNew: FadeInFromZero(120); Delay(500).FadeOut(600) */
function pieceFade(since: number): number {
  if (since < 0) return 0;
  if (since < 120) return since / 120;
  if (since < 500) return 1;
  return Math.max(0, 1 - (since - 500) / 600);
}

function createCanvas(w: number, h: number): HTMLCanvasElement | OffscreenCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/** Number drawn when the skin has no hitcircle font (lazer would fall back to the default legacy skin's font). */
function drawFallbackNumber(g: CanvasRenderingContext2D, n: number, x: number, y: number, scale: number, alpha: number): void {
  const prev = g.globalAlpha;
  g.globalAlpha = prev * alpha;
  g.fillStyle = '#fff';
  g.font = `600 ${Math.round(OBJECT_RADIUS * 0.75 * scale)}px "Torus", "Exo 2", system-ui, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(String(n), x, y + OBJECT_RADIUS * 0.04 * scale);
  g.globalAlpha = prev;
}

/** Reverse arrow drawn when no skin provides "reversearrow". */
function drawFallbackArrow(g: CanvasRenderingContext2D, x: number, y: number, angle: number, r: number, alpha: number): void {
  g.save();
  g.globalAlpha *= alpha;
  g.translate(x, y);
  g.rotate(angle);
  g.strokeStyle = '#fff';
  g.lineWidth = r * 0.14;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.beginPath();
  g.moveTo(-r * 0.18, -r * 0.35);
  g.lineTo(r * 0.22, 0);
  g.lineTo(-r * 0.18, r * 0.35);
  g.stroke();
  g.restore();
}
