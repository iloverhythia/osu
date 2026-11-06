// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// The default ("Argon") osu! skin pieces, drawn procedurally with Canvas 2D. Ports of
// osu.Game.Rulesets.Osu/Skinning/Argon/*.cs (ArgonMainCirclePiece, ArgonSliderBody, ArgonSliderBall, ArgonFollowCircle,
// ArgonReverseArrow, ArgonSliderScorePoint, ArgonSpinner, ArgonSpinnerDisc, ArgonSpinnerTicks, ArgonSpinnerRingArc,
// ArgonSpinnerProgressArc, ArgonJudgementPiece, ArgonJudgementPieceSliderTickMiss, ArgonCursor, ArgonCursorTrail,
// ArgonFollowPoint), Skinning/Default/DefaultApproachCircle.cs, Default/RingPiece.cs and Default/KiaiFlash.cs.
//
// Each function draws one piece with its state already evaluated (alphas, scales, ...) by DrawableOsuRuleset, which ports the
// transform sequences. Coordinates are osu! playfield units; the context is already transformed into playfield space.
// Approximations (no shaders / textures): edge effects (glow / shadow) are radial gradients, SpriteIcons are stroked paths,
// textures from osu-resources (approach circle, repeat edge piece, cursor trail, spinner glow) are drawn procedurally.

import { HitResult } from '../../scoring/HitResult';
import { Colour4, Easing, WHITE, css, darken, fromHex, lerpColour, opacity } from './transforms';
import { applyEasing } from '../../storyboard/Easing';

const ease = (e: Easing) => (t: number) => applyEasing(e, t);
const outQuint = ease(Easing.OutQuint);
const outQuad = ease(Easing.OutQuad);
const outElasticHalf = ease(Easing.OutElasticHalf);
const inQuint = ease(Easing.InQuint);
const easeIn = ease(Easing.In);
const easeOut = ease(Easing.Out);

const OBJECT_RADIUS = 64;
const OBJECT_DIMENSIONS = OBJECT_RADIUS * 2;

/** ArgonMainCirclePiece constants */
export const BORDER_THICKNESS = OBJECT_DIMENSIONS * (2 / 58);
export const GRADIENT_THICKNESS = BORDER_THICKNESS * 2.5;
export const OUTER_GRADIENT_SIZE = OBJECT_DIMENSIONS - BORDER_THICKNESS * 4;
export const INNER_GRADIENT_SIZE = OUTER_GRADIENT_SIZE - GRADIENT_THICKNESS * 2;
export const INNER_FILL_SIZE = INNER_GRADIENT_SIZE - GRADIENT_THICKNESS * 2;

/** Colours used by the argon gameplay elements (cursor, follow points, spinner). */
export const ARGON_PINK = fromHex('FC618F');
export const ARGON_PINK_DARK = fromHex('BB1A41');

/** Argon's default combo colours (ArgonSkin.Configuration.CustomComboColours). */
export const ARGON_COMBO_COLOURS: [number, number, number][] = [
  [241, 116, 0],
  [0, 241, 53],
  [0, 82, 241],
  [241, 0, 0],
  [232, 235, 0],
  [92, 0, 241],
];

/** Font substitution for Torus (OsuFont.Default). */
export const FONT = '"Exo 2", "Torus", system-ui, sans-serif';

const TAU = Math.PI * 2;

/** OsuColour.ForHitResult */
export function colourForHitResult(result: HitResult): Colour4 {
  switch (result) {
    case HitResult.IgnoreMiss:
    case HitResult.SmallTickMiss:
      return [128 / 255, 128 / 255, 128 / 255, 1]; // Color4.Gray
    case HitResult.Miss:
    case HitResult.LargeTickMiss:
    case HitResult.ComboBreak:
      return fromHex('ed1121'); // Red
    case HitResult.Meh:
      return fromHex('ffcc22'); // Yellow
    case HitResult.Ok:
      return fromHex('88b300'); // Green
    case HitResult.Good:
      return fromHex('b3d944'); // GreenLight
    case HitResult.SmallTickHit:
    case HitResult.LargeTickHit:
    case HitResult.SliderTailHit:
    case HitResult.Great:
      return fromHex('66ccff'); // Blue
    default:
      return fromHex('99eeff'); // BlueLight
  }
}

/** HitResult descriptions (GetDescription().ToUpperInvariant()). */
export function resultText(result: HitResult): string {
  switch (result) {
    case HitResult.Miss:
      return 'MISS';
    case HitResult.Meh:
      return 'MEH';
    case HitResult.Ok:
      return 'OK';
    case HitResult.Good:
      return 'GOOD';
    case HitResult.Great:
      return 'GREAT';
    case HitResult.Perfect:
      return 'PERFECT';
    default:
      return '';
  }
}

const dimmed = (c: Colour4, dim: number): Colour4 => [c[0] * dim, c[1] * dim, c[2] * dim, c[3]];

function circle(g: CanvasRenderingContext2D, r: number): void {
  g.beginPath();
  g.arc(0, 0, Math.max(0, r), 0, TAU);
}

/** A vertical gradient (ColourInfo.GradientVertical) over a circle of radius r. */
function vgrad(g: CanvasRenderingContext2D, r: number, top: Colour4, bottom: Colour4, alpha = 1): CanvasGradient | string {
  if (r <= 0) return 'rgba(0,0,0,0)';
  const grad = g.createLinearGradient(0, -r, 0, r);
  grad.addColorStop(0, css(top, alpha));
  grad.addColorStop(1, css(bottom, alpha));
  return grad;
}

/** RingPiece / CircularContainer with BorderThickness: a ring drawn inside the circle's edge. */
function ring(g: CanvasRenderingContext2D, diameter: number, thickness: number, style: string | CanvasGradient): void {
  const r = diameter / 2;
  const t = Math.min(thickness, r);
  if (r <= 0 || t <= 0) return;
  g.strokeStyle = style;
  g.lineWidth = t;
  circle(g, r - t / 2);
  g.stroke();
}

/** A soft, filled disc approximating an osu-framework glow / shadow edge effect around a circle of radius r. */
function softDisc(g: CanvasRenderingContext2D, r: number, radius: number, colour: Colour4, alpha: number): void {
  const outer = r + radius;
  if (outer <= 0 || alpha <= 0) return;
  const grad = g.createRadialGradient(0, 0, 0, 0, 0, outer);
  const inner = Math.max(0, r) / outer;
  grad.addColorStop(0, css(colour, alpha));
  grad.addColorStop(inner, css(colour, alpha));
  // gaussian-like falloff over the edge effect radius
  for (const [f, a] of [
    [0.25, 0.62],
    [0.5, 0.25],
    [0.75, 0.06],
  ] as const)
    grad.addColorStop(inner + (1 - inner) * f, css(colour, alpha * a));
  grad.addColorStop(1, css(colour, 0));
  g.fillStyle = grad;
  circle(g, outer);
  g.fill();
}

// ------------------------------------------------------------------------------------------------ circles

export interface MainCirclePieceState {
  accent: Colour4;
  /** Whether the dark outer fill is visible (false for slider heads). */
  withOuterFill: boolean;
  number: number;
  /** Combined alpha of the drawable hierarchy above the piece. */
  alpha: number;
  /** DrawableOsuHitObject dim (CirclePiece colour, 195/255 → 1). */
  dim: number;
  /** Time since the hit state update when the object was hit, otherwise null. */
  sinceHit: number | null;
  hitLighting: boolean;
  /** KiaiFlash box alpha. */
  kiai: number;
}

/** ArgonMainCirclePiece (+ its hit animation: ArgonMainCirclePiece.updateStateTransforms). */
export function drawMainCirclePiece(g: CanvasRenderingContext2D, s: MainCirclePieceState): void {
  const accent = dimmed(s.accent, s.dim);
  const white = dimmed(WHITE, s.dim);
  const since = s.sinceHit;
  const p = (start: number, duration: number, f: (t: number) => number = t => t) => (since == null || since < start ? 0 : since >= start + duration ? 1 : f((since - start) / duration));

  // Fade out time is at a maximum of 800. Must match DrawableHitCircle's arbitrary lifetime spec.
  const fadeOutTime = 800;
  const flashIn = 150;
  const resize = 400;
  const shrink = 0.8;

  let pieceAlpha = s.alpha;
  if (since != null) pieceAlpha *= 1 - p(0, s.hitLighting ? fadeOutTime : fadeOutTime * 0.8, outQuad);
  if (pieceAlpha <= 0) return;

  const fillOut = 1 - p(0, flashIn, outQuint);
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

  g.save();
  g.globalAlpha *= pieceAlpha;

  // outer fill (renders dark fill); slightly inset to prevent bleeding outside the ring
  if (s.withOuterFill) {
    g.fillStyle = css(darken(accent, 4), fillOut);
    circle(g, (OBJECT_DIMENSIONS - 1) / 2);
    g.fill();
  }

  // outer gradient — resized with a slight delay from the border, flashes white then fades out.
  {
    const delay = flashIn / 12;
    const size = lerp(OUTER_GRADIENT_SIZE, OUTER_GRADIENT_SIZE * shrink, p(delay, resize, outElasticHalf));
    const toWhite = p(delay, 80);
    const a = 1 - p(delay + 80, flashIn);
    if (a > 0) {
      g.fillStyle = vgrad(g, size / 2, lerpColour(accent, white, toWhite), lerpColour(darken(accent, 0.1), white, toWhite), a);
      circle(g, size / 2);
      g.fill();
    }
  }

  // inner gradient
  if (fillOut > 0) {
    g.fillStyle = vgrad(g, INNER_GRADIENT_SIZE / 2, darken(accent, 0.5), darken(accent, 0.6), fillOut);
    circle(g, INNER_GRADIENT_SIZE / 2);
    g.fill();
    // inner fill
    g.fillStyle = css(darken(accent, 4), fillOut);
    circle(g, INNER_FILL_SIZE / 2);
    g.fill();
  }

  // kiai flash (additive white, coloured by the accent; masked to the circle)
  {
    const size = lerp(OBJECT_DIMENSIONS, OBJECT_DIMENSIONS * shrink, p(0, resize, outElasticHalf));
    const a = s.kiai * (1 - p(0, flashIn, outQuint));
    if (a > 0) {
      g.globalCompositeOperation = 'lighter';
      g.fillStyle = css(accent, a);
      circle(g, size / 2);
      g.fill();
      g.globalCompositeOperation = 'source-over';
    }
  }

  // number (fades out as the flash comes in)
  {
    const a = 1 - p(0, flashIn / 2);
    if (a > 0) {
      g.fillStyle = css(white, a);
      g.font = `700 52px ${FONT}`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(String(s.number), 0, -2);
    }
  }

  // flash (additive glow)
  if (since != null) {
    let a = p(0, flashIn, outQuint);
    if (!s.hitLighting) a *= 1 - p(flashIn, flashIn, outQuint);
    if (a > 0) {
      g.globalCompositeOperation = 'lighter';
      softDisc(g, OBJECT_RADIUS / 2, OBJECT_RADIUS * (s.hitLighting ? 1.2 : 0.6), accent, a);
      g.globalCompositeOperation = 'source-over';
    }
  }

  // border: always white, after hit it gets coloured with a vertical gradient (accent 0.5 → accent 0) and shrinks.
  {
    const size = lerp(OBJECT_DIMENSIONS, OBJECT_DIMENSIONS * shrink + BORDER_THICKNESS, p(0, resize, outElasticHalf));
    const t = p(0, fadeOutTime);
    const style = t > 0 ? vgrad(g, size / 2, lerpColour(white, opacity(accent, 0.5), t), lerpColour(white, opacity(accent, 0), t)) : css(white);
    ring(g, size, BORDER_THICKNESS, style);
  }

  g.restore();
}

/**
 * DefaultApproachCircle (the legacy "approachcircle" sprite scaled by 128 / 118 so that it disappears as it collides with the
 * circle). The texture is approximated by a ring.
 */
export function drawApproachCircle(g: CanvasRenderingContext2D, scale: number, alpha: number, accent: Colour4): void {
  if (alpha <= 0 || scale <= 0) return;
  const thickness = 5 * scale;
  g.strokeStyle = css(accent, alpha);
  g.lineWidth = thickness;
  circle(g, OBJECT_RADIUS * scale - thickness / 2);
  g.stroke();
}

// ------------------------------------------------------------------------------------------------ sliders

/** ArgonSliderBody: path radius, border portion and colours (DrawableSliderPath.ColourAt). */
export const ARGON_PATH_RADIUS = OUTER_GRADIENT_SIZE / 2;
/** CalculatedBorderPortion = BorderSize * BORDER_PORTION = (GRADIENT_THICKNESS / path_radius) */
export const ARGON_BORDER_PORTION = GRADIENT_THICKNESS / ARGON_PATH_RADIUS;

/**
 * Renders the argon slider path into `c` (already transformed to playfield space): border = accent, body = accent.Darken(4)
 * with the body alpha. Each pixel gets exactly one colour, as SmoothPath's depth-tested mesh does.
 */
export function renderArgonSliderPath(c: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, trace: () => void, radius: number, accent: Colour4, bodyAlpha: number): void {
  c.lineCap = 'round';
  c.lineJoin = 'round';
  trace();
  c.lineWidth = radius * 2;
  c.strokeStyle = css(accent);
  c.stroke();
  const inner = radius * 2 * (1 - ARGON_BORDER_PORTION);
  c.globalCompositeOperation = 'destination-out';
  c.lineWidth = inner;
  c.strokeStyle = '#000';
  c.stroke();
  c.globalCompositeOperation = 'source-over';
  c.strokeStyle = css(darken(accent, 4), bodyAlpha);
  c.stroke();
}

/** ArgonSliderBall. `iconScale` multiplies the default icon scale (0.6, 0.8). */
export function drawSliderBall(g: CanvasRenderingContext2D, rotation: number, accent: Colour4, alpha: number, iconScale: number): void {
  if (alpha <= 0) return;
  g.save();
  g.globalAlpha *= alpha;
  const r = OUTER_GRADIENT_SIZE / 2;
  // fill (counter-rotated so the gradient stays vertical)
  g.fillStyle = vgrad(g, r, accent, darken(accent, 0.5));
  circle(g, r);
  g.fill();
  ring(g, OUTER_GRADIENT_SIZE, GRADIENT_THICKNESS, '#fff');
  // icon: FontAwesome.Solid.AngleRight, size 48
  g.rotate((rotation * Math.PI) / 180);
  if (iconScale > 0) {
    g.scale(0.6 * iconScale, 0.8 * iconScale);
    chevron(g, 48, '#fff');
  }
  g.restore();
}

/** A FontAwesome angle/chevron-right glyph approximation, centred, `size` being the SpriteIcon size. */
function chevron(g: CanvasRenderingContext2D, size: number, style: string | CanvasGradient, offsetX = 0): void {
  const w = size * 0.17;
  const h = size * 0.3;
  g.strokeStyle = style;
  g.lineWidth = size * 0.14;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.beginPath();
  g.moveTo(offsetX - w, -h);
  g.lineTo(offsetX + w, 0);
  g.lineTo(offsetX - w, h);
  g.stroke();
}

/** ArgonFollowCircle at the given (relative-to-128) scale. Additive. */
export function drawFollowCircle(g: CanvasRenderingContext2D, scale: number, accent: Colour4, alpha: number): void {
  if (alpha <= 0 || scale <= 0) return;
  g.save();
  g.globalCompositeOperation = 'lighter';
  g.scale(scale, scale);
  const r = OBJECT_RADIUS;
  g.fillStyle = vgrad(g, r, accent, darken(accent, 0.5), 0.3 * alpha);
  circle(g, r);
  g.fill();
  ring(g, OBJECT_DIMENSIONS, 4, vgrad(g, r, accent, darken(accent, 0.5), alpha));
  g.restore();
}

/**
 * ArgonReverseArrow: a white pill with a double chevron (accent.Darken(4)), plus the "repeat-edge-piece" sprite
 * (approximated by an arc on the outer gradient edge, on the side the arrow points to).
 */
export function drawReverseArrow(g: CanvasRenderingContext2D, rotation: number, accent: Colour4, alpha: number, wholeScale: number, mainScale: number, sideX: number, dim = 1): void {
  if (alpha <= 0) return;
  const white = css(dimmed(WHITE, dim));
  g.save();
  g.globalAlpha *= alpha;
  g.scale(wholeScale, wholeScale);
  g.rotate((rotation * Math.PI) / 180);
  // side piece
  g.save();
  g.translate(sideX, 0);
  g.strokeStyle = white;
  g.lineWidth = GRADIENT_THICKNESS * 0.45;
  g.lineCap = 'round';
  g.beginPath();
  g.arc(0, 0, OUTER_GRADIENT_SIZE / 2 - GRADIENT_THICKNESS * 0.35, -0.75, 0.75);
  g.stroke();
  g.restore();
  // main
  g.scale(mainScale, mainScale);
  g.fillStyle = white;
  g.beginPath();
  g.moveTo(-10, -10);
  g.lineTo(10, -10);
  g.arc(10, 0, 10, -Math.PI / 2, Math.PI / 2);
  g.lineTo(-10, 10);
  g.arc(-10, 0, 10, Math.PI / 2, (3 * Math.PI) / 2);
  g.fill();
  const iconColour = css(darken(dimmed(accent, dim), 4));
  // FontAwesome.Solid.AngleDoubleRight, size 16
  chevron(g, 11, iconColour, -2.6);
  chevron(g, 11, iconColour, 2.6);
  g.restore();
}

/** ArgonSliderScorePoint: a 12px hollow circle with a 3px accent border. */
export function drawSliderScorePoint(g: CanvasRenderingContext2D, accent: Colour4, alpha: number): void {
  if (alpha <= 0) return;
  ring(g, 12, 3, css(accent, alpha));
}

// ------------------------------------------------------------------------------------------------ spinner

export interface ArgonSpinnerState {
  alpha: number;
  discScale: number;
  centreScale: number;
  /** centre.Size (80 idle → 40 tracking) */
  centreSize: number;
  fillAlpha: number;
  fillScale: number;
  /** ticksContainer.Rotation + ticks.Rotation (degrees) */
  ticksRotation: number;
  ringArcProgress: number;
  ringArcRadius: number;
  progressBackgroundAlpha: number;
  progressFillAlpha: number;
  progressFill: number;
  bonus: { text: string; scale: number; alpha: number; flash: number } | null;
  spm: { text: string; alpha: number } | null;
}

/** CircularProgress: an annulus segment from the top (12 o'clock) clockwise, rotated by `rotation` degrees. */
function circularProgress(g: CanvasRenderingContext2D, radius: number, progress: number, innerRadius: number, rotation: number, style: string, mirrorX = false, mirrorY = false, roundedCaps = true): void {
  if (progress <= 0 || radius <= 0) return;
  const thickness = radius * innerRadius;
  g.save();
  g.scale(mirrorX ? -1 : 1, mirrorY ? -1 : 1);
  g.rotate((rotation * Math.PI) / 180);
  g.strokeStyle = style;
  g.lineWidth = thickness;
  g.lineCap = roundedCaps ? 'round' : 'butt';
  const r = radius - thickness / 2;
  // rounded caps extend past the arc ends; shorten the arc by the cap radius to stay within the progress span.
  const capAngle = roundedCaps ? Math.min((thickness / 2 / r), (progress * TAU) / 2) : 0;
  g.beginPath();
  g.arc(0, 0, r, -Math.PI / 2 + capAngle, -Math.PI / 2 + progress * TAU - capAngle);
  g.stroke();
  g.restore();
}

/** ArgonSpinner (ArgonSpinnerDisc + bonus / SPM counters). The context is at the spinner centre; size 384 (playfield height). */
export function drawArgonSpinner(g: CanvasRenderingContext2D, s: ArgonSpinnerState): void {
  if (s.alpha <= 0) return;
  g.save();
  g.globalAlpha *= s.alpha;
  const size = 384;

  // ---- disc
  g.save();
  g.scale(s.discScale, s.discScale);
  const padded = size - 16;
  // fill: a pink shadow edge effect (radius 40) on an invisible circle, scaled with progress.
  softDisc(g, (padded / 2) * s.fillScale, 40 * s.fillScale, ARGON_PINK, s.fillAlpha);
  // ticks: 25 hollow capsules with a soft white glow
  g.save();
  g.rotate((s.ticksRotation * Math.PI) / 180);
  for (let i = 0; i < 25; i++) {
    const a = (i / 25) * TAU;
    const x = (Math.sin(a) / 2) * 0.75 * padded;
    const y = (Math.cos(a) / 2) * 0.75 * padded;
    g.save();
    g.translate(x, y);
    g.rotate(((-i / 25) * 360 - 120) * (Math.PI / 180));
    const glow = g.createRadialGradient(0, 0, 0, 0, 0, 30);
    glow.addColorStop(0, 'rgba(255,255,255,0.2)');
    glow.addColorStop(0.5, 'rgba(255,255,255,0.05)');
    glow.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = glow;
    g.fillRect(-30, -30, 60, 60);
    g.strokeStyle = '#fff';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(-12.5, -1.5);
    g.lineTo(12.5, -1.5);
    g.arc(12.5, 0, 1.5, -Math.PI / 2, Math.PI / 2);
    g.lineTo(-12.5, 1.5);
    g.arc(-12.5, 0, 1.5, Math.PI / 2, (3 * Math.PI) / 2);
    g.stroke();
    g.restore();
  }
  g.restore();
  // ring arcs (top + mirrored bottom)
  circularProgress(g, padded / 2, s.ringArcProgress, s.ringArcRadius, -s.ringArcProgress * 180, '#fff');
  circularProgress(g, padded / 2, s.ringArcProgress, s.ringArcRadius, -s.ringArcProgress * 180, '#fff', false, true);
  // progress arcs (left + right sides)
  for (const mirror of [false, true]) {
    if (s.progressBackgroundAlpha > 0) circularProgress(g, size / 2, 0.15, 0.12, 90 - 0.15 * 180, `rgba(255,255,255,${0.25 * s.progressBackgroundAlpha})`, mirror);
    if (s.progressFillAlpha > 0 && s.progressFill > 0) {
      // glow (approximation of the SpinnerGlow shader)
      g.save();
      g.globalCompositeOperation = 'lighter';
      g.shadowColor = `rgba(171,255,255,${(180 / 255) * s.progressFillAlpha})`;
      g.shadowBlur = 25;
      circularProgress(g, size / 2, s.progressFill, 0.12, 90 - s.progressFill * 180, `rgba(255,255,255,${s.progressFillAlpha})`, mirror);
      g.restore();
    }
  }
  g.restore();

  // ---- centre
  if (s.centreScale > 0) {
    g.save();
    g.scale(s.centreScale, s.centreScale);
    ring(g, s.centreSize * 0.8, 10, '#fff');
    ring(g, s.centreSize, 3, '#fff');
    g.restore();
  }

  // ---- counters
  g.textAlign = 'center';
  if (s.bonus && s.bonus.alpha > 0) {
    g.save();
    g.translate(0, -100);
    g.scale(s.bonus.scale, s.bonus.scale);
    g.textBaseline = 'middle';
    g.font = `700 28px ${FONT}`;
    g.fillStyle = css(lerpColour(WHITE, ARGON_PINK, s.bonus.flash), s.bonus.alpha);
    g.fillText(s.bonus.text, 0, 0);
    g.restore();
  }
  if (s.spm && s.spm.alpha > 0) {
    g.textBaseline = 'top';
    g.fillStyle = `rgba(255,255,255,${s.spm.alpha})`;
    g.font = `600 28px ${FONT}`;
    g.fillText(s.spm.text, 0, 60);
    g.font = `600 16px ${FONT}`;
    g.fillText('SPINS PER MINUTE', 0, 90);
  }
  g.restore();
}

// ------------------------------------------------------------------------------------------------ judgements

export interface RingParticle {
  /** direction in radians (RNG.NextSingle(0, 360) is used as radians in lazer) */
  direction: number;
  distance: number;
  size: number;
}

/** ArgonJudgementPiece.RingExplosion particles for a result. */
export function createRingExplosion(result: HitResult, random: () => number = Math.random): RingParticle[] {
  let travel = 52;
  let countSmall = 0;
  let countLarge = 0;
  switch (result) {
    case HitResult.Meh:
      countSmall = 3;
      travel *= 0.3;
      break;
    case HitResult.Ok:
    case HitResult.Good:
      countSmall = 4;
      travel *= 0.6;
      break;
    case HitResult.Great:
    case HitResult.Perfect:
      countSmall = 4;
      countLarge = 4;
      break;
  }
  const out: RingParticle[] = [];
  for (let i = 0; i < countSmall + countLarge; i++) {
    out.push({ direction: random() * 360, distance: travel / 2 + random() * (travel / 2), size: i < countSmall ? 9 : 14 });
  }
  return out;
}

/** ArgonJudgementPiece.RingExplosion.PlayAnimation (drawn in the judgement layer, below hit objects). */
export function drawRingExplosion(g: CanvasRenderingContext2D, particles: readonly RingParticle[], result: HitResult, since: number): void {
  if (particles.length === 0 || since < 0) return;
  const a = 1 - outQuint(Math.min(1, since / 1000));
  if (a <= 0) return;
  const move = outQuint(Math.min(1, since / 600));
  const colour = css(colourForHitResult(result), a);
  g.save();
  g.globalCompositeOperation = 'lighter';
  for (const p of particles) {
    const d = p.distance * (0.3 + 0.7 * move);
    g.save();
    g.translate(Math.cos(p.direction) * d, Math.sin(p.direction) * d);
    ring(g, p.size, 4, colour);
    g.restore();
  }
  g.restore();
}

/** ArgonJudgementPiece text (proxied above hit objects). */
export function drawJudgementText(g: CanvasRenderingContext2D, result: HitResult, since: number): void {
  if (since < 0) return;
  const text = resultText(result);
  if (!text) return;
  const colour = colourForHitResult(result);
  const clamp01 = (t: number) => Math.min(1, Math.max(0, t));
  g.save();
  let alpha: number;
  if (result === HitResult.Miss) {
    alpha = 1 - clamp01(since / 800);
    const scale = 1.6 + (1 - 1.6) * easeIn(clamp01(since / 100));
    const k = inQuint(clamp01(since / 800));
    g.translate(0, 100 * k);
    g.rotate(((40 * k) * Math.PI) / 180);
    g.scale(scale, scale);
  } else {
    alpha = (1 - clamp01(since / 800)) * outQuint(clamp01(since / 300));
    const scale = 1 + 0.2 * outQuint(clamp01(since / 1800));
    g.scale(scale, scale);
  }
  if (alpha > 0) {
    g.globalCompositeOperation = 'lighter';
    g.fillStyle = css(colour, alpha);
    g.font = `700 20px ${FONT}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const lg = g as CanvasRenderingContext2D & { letterSpacing?: string };
    if ('letterSpacing' in lg) lg.letterSpacing = '5px';
    // letter spacing adds trailing space after the last glyph: offset by half of it to stay centred.
    g.fillText(text, 'letterSpacing' in lg ? 2.5 : 0, 0);
    if ('letterSpacing' in lg) lg.letterSpacing = '0px';
  }
  g.restore();
}

/** ArgonJudgementPieceSliderTickMiss (slider tick / tail misses). */
export function drawTickMiss(g: CanvasRenderingContext2D, result: HitResult, since: number): void {
  if (since < 0 || since >= 600) return;
  const scale = 1.4 + (1 - 1.4) * easeOut(Math.min(1, since / 150));
  const alpha = 1 - since / 600;
  g.save();
  g.globalCompositeOperation = 'lighter';
  g.fillStyle = css(colourForHitResult(result), alpha);
  circle(g, 6 * scale);
  g.fill();
  g.restore();
}

// ------------------------------------------------------------------------------------------------ cursor / follow points

/** ArgonCursor at cursor size `size` (OsuCursor.SIZE * scale), with the expand target scaled by `expand`. */
export function drawArgonCursor(g: CanvasRenderingContext2D, size: number, expand: number): void {
  const r = (size / 2) * expand;
  // expand target
  g.save();
  g.fillStyle = css(darken(ARGON_PINK, 0.6), 0.4);
  circle(g, r);
  g.fill();
  ring(g, r * 2, 2 * (size / 28) * expand, 'rgba(255,255,255,0.8)');
  ring(g, r * 2, 6 * (size / 28) * expand, vgrad(g, r, ARGON_PINK, ARGON_PINK_DARK));
  g.restore();
  // centre dot with glow
  const dot = (size / 2) * 0.2;
  const glowR = dot + 20 * (size / 28);
  const glow = g.createRadialGradient(0, 0, dot, 0, 0, glowR);
  glow.addColorStop(0, 'rgba(171,255,255,0.39)');
  glow.addColorStop(0.35, 'rgba(171,255,255,0.12)');
  glow.addColorStop(1, 'rgba(171,255,255,0)');
  g.save();
  g.globalCompositeOperation = 'lighter';
  g.fillStyle = glow;
  circle(g, glowR);
  g.fill();
  g.restore();
  g.fillStyle = '#fff';
  circle(g, dot);
  g.fill();
}

/** ArgonCursorTrail part (the "cursortrail" texture is approximated by a soft white dot). Additive. */
export function drawTrailPart(g: CanvasRenderingContext2D, x: number, y: number, size: number, alpha: number): void {
  if (alpha <= 0) return;
  const r = size / 2;
  const grad = g.createRadialGradient(x, y, 0, x, y, r);
  grad.addColorStop(0, `rgba(255,255,255,${alpha})`);
  grad.addColorStop(0.45, `rgba(255,255,255,${alpha * 0.55})`);
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.beginPath();
  g.arc(x, y, r, 0, TAU);
  g.fill();
}

/** ArgonFollowPoint: two chevrons (dark gray, then white offset by 4), vertical pink gradient, additive. */
export function drawArgonFollowPoint(g: CanvasRenderingContext2D, alpha: number): void {
  if (alpha <= 0) return;
  g.save();
  g.globalCompositeOperation = 'lighter';
  const grad = g.createLinearGradient(0, -4, 0, 4);
  grad.addColorStop(0, css(ARGON_PINK, alpha));
  grad.addColorStop(1, css(ARGON_PINK_DARK, alpha));
  const dark = g.createLinearGradient(0, -4, 0, 4);
  dark.addColorStop(0, css([ARGON_PINK[0] * 0.2, ARGON_PINK[1] * 0.2, ARGON_PINK[2] * 0.2, 1], alpha));
  dark.addColorStop(1, css([ARGON_PINK_DARK[0] * 0.2, ARGON_PINK_DARK[1] * 0.2, ARGON_PINK_DARK[2] * 0.2, 1], alpha));
  chevron(g, 8, dark, -2);
  chevron(g, 8, grad, 2);
  g.restore();
}
