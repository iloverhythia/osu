// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of the parts of osu.Game/Graphics/OsuColour.cs and osu.Game/Overlays/OverlayColourProvider.cs used by song select and mod select,
// plus osu-framework's Color4Extensions.Lighten/Darken/Opacity and ColourUtils.SampleFromLinearGradient.

import { toLinear, toSRGB } from '../../game/storyboard/Easing';
import type { ModType } from '../../game/mods/Mods';
import type { ScoreRank } from '../../game/scoring/ScoreRank';
import { BeatmapOnlineStatus } from './FilterCriteria';

/** RGBA in [0, 1]. */
export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

export function hex(h: string): RGBA {
  let s = h.replace('#', '');
  if (s.length === 3) s = s.split('').map(c => c + c).join('');
  return { r: parseInt(s.slice(0, 2), 16) / 255, g: parseInt(s.slice(2, 4), 16) / 255, b: parseInt(s.slice(4, 6), 16) / 255, a: s.length >= 8 ? parseInt(s.slice(6, 8), 16) / 255 : 1 };
}

export function css(c: RGBA, alpha = 1): string {
  const to = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255);
  return `rgba(${to(c.r)},${to(c.g)},${to(c.b)},${+(Math.max(0, Math.min(1, c.a * alpha))).toFixed(3)})`;
}

/** Color4Extensions.Opacity */
export const opacity = (c: RGBA, a: number): RGBA => ({ ...c, a });

/** Color4Extensions.Lighten */
export function lighten(c: RGBA, amount: number): RGBA {
  amount *= 0.5;
  return {
    r: Math.min(1, c.r * (1 + 0.5 * amount) + amount),
    g: Math.min(1, c.g * (1 + 0.5 * amount) + amount),
    b: Math.min(1, c.b * (1 + 0.5 * amount) + amount),
    a: c.a,
  };
}

/** Color4Extensions.Darken */
export function darken(c: RGBA, amount: number): RGBA {
  const scalar = Math.max(1, 1 + amount);
  return { r: c.r / scalar, g: c.g / scalar, b: c.b / scalar, a: c.a };
}

/** Colour4.FromHSL */
export function fromHSL(h: number, s: number, l: number): RGBA {
  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  if (s === 0) return { r: l, g: l, b: l, a: 1 };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return { r: hue2rgb(p, q, h + 1 / 3), g: hue2rgb(p, q, h), b: hue2rgb(p, q, h - 1 / 3), a: 1 };
}

/** Interpolation.ValueAt(Color4) – linear-space interpolation. */
export function lerpColour(a: RGBA, b: RGBA, t: number): RGBA {
  const m = (x: number, y: number) => toSRGB(toLinear(x) + (toLinear(y) - toLinear(x)) * t);
  return { r: m(a.r, b.r), g: m(a.g, b.g), b: m(a.b, b.b), a: a.a + (b.a - a.a) * t };
}

/** ColourUtils.SampleFromLinearGradient */
export function sampleFromLinearGradient(gradient: readonly (readonly [number, RGBA])[], point: number): RGBA {
  if (point < gradient[0][0]) return gradient[0][1];
  for (let i = 0; i < gradient.length - 1; i++) {
    const [startPos, startCol] = gradient[i];
    const [endPos, endCol] = gradient[i + 1];
    if (point <= endPos) {
      if (point >= endPos) return endCol;
      if (point <= startPos) return startCol;
      return lerpColour(startCol, endCol, (point - startPos) / (endPos - startPos));
    }
  }
  return gradient[gradient.length - 1][1];
}

export const BLACK: RGBA = { r: 0, g: 0, b: 0, a: 1 };
export const WHITE: RGBA = { r: 1, g: 1, b: 1, a: 1 };
export const gray = (amt: number): RGBA => ({ r: amt, g: amt, b: amt, a: 1 });

/** OsuColour (the members used by song select). */
export const OsuColour = {
  Gray4: hex('444'),
  Gray8: hex('888'),
  GrayC: hex('ccc'),
  GrayF: hex('fff'),
  Pink1: hex('ff66ab'),
  Pink3: hex('cc3378'),
  Purple1: hex('8c66ff'),
  Blue1: hex('66ccff'),
  Lime1: hex('b2ff66'),
  Lime3: hex('7fcc33'),
  Orange1: hex('ffd966'),
  Orange2: hex('ebc247'),
  Red1: hex('ff6666'),
  Red2: hex('eb4747'),
  Yellow: hex('ffcc22'),
  Blue: hex('66ccff'),
};

export const STAR_DIFFICULTY_DEFINED_COLOUR_CUTOFF = 6.5;
export const STAR_DIFFICULTY_TEXT_GRADIENT_CUTOFF = 9.0;

export const STAR_DIFFICULTY_SPECTRUM: readonly (readonly [number, RGBA])[] = [
  [0.1, hex('aaaaaa')],
  [0.1, hex('4290fb')],
  [1.25, hex('4fc0ff')],
  [2.0, hex('4fffd5')],
  [2.5, hex('7cff4f')],
  [3.3, hex('f6f05c')],
  [4.2, hex('ff8068')],
  [4.9, hex('ff4e6f')],
  [5.8, hex('c645b8')],
  [6.7, hex('6563de')],
  [7.7, hex('18158e')],
  [9.0, BLACK],
  [10.0, BLACK],
];

export const STAR_DIFFICULTY_TEXT_SPECTRUM: readonly (readonly [number, RGBA])[] = [
  [9.0, hex('f6f05c')],
  [9.9, hex('ff8068')],
  [10.6, hex('ff4e6f')],
  [11.5, hex('c645b8')],
  [12.4, hex('6563de')],
];

/** Math.Round(x, 2, MidpointRounding.AwayFromZero) */
const round2 = (x: number) => Math.sign(x) * Math.round(Math.abs(x) * 100 + 1e-9) / 100;

/** OsuColour.ForStarDifficulty */
export function forStarDifficulty(stars: number): RGBA {
  return sampleFromLinearGradient(STAR_DIFFICULTY_SPECTRUM, round2(stars));
}

/** OsuColour.ForStarDifficultyText */
export function forStarDifficultyText(stars: number): RGBA {
  if (stars < STAR_DIFFICULTY_DEFINED_COLOUR_CUTOFF) return opacity(BLACK, 0.75);
  if (stars < STAR_DIFFICULTY_TEXT_GRADIENT_CUTOFF) return OsuColour.Orange1;
  return sampleFromLinearGradient(STAR_DIFFICULTY_TEXT_SPECTRUM, round2(stars));
}

/** OsuColour.ForegroundTextColourFor: black or white depending on background luminance. */
export function foregroundTextColourFor(bg: RGBA): RGBA {
  // Formula from https://www.w3.org/TR/AERT/#color-contrast, as used by osu-framework.
  const brightness = (bg.r * 299 + bg.g * 587 + bg.b * 114) / 1000;
  return brightness > 0.5 ? opacity(BLACK, 0.75) : WHITE;
}

/** OsuColour.ForRank */
export function forRank(rank: ScoreRank): RGBA {
  switch (rank) {
    case 'XH':
    case 'X':
      return hex('de31ae');
    case 'SH':
    case 'S':
      return hex('02b5c3');
    case 'A':
      return hex('88da20');
    case 'B':
      return hex('e3b130');
    case 'C':
      return hex('ff8e5d');
    case 'D':
      return hex('ff5a5a');
    default:
      return hex('3f3f3f');
  }
}

/** DrawableRank.GetRankLetterColour */
export function rankLetterColour(rank: ScoreRank): RGBA {
  switch (rank) {
    case 'XH':
    case 'SH':
      return hex('#e3e3e3');
    case 'X':
    case 'S':
      return hex('#ffe7a8');
    case 'A':
      return hex('#275227');
    case 'B':
      return hex('#553a2b');
    case 'C':
      return hex('#473625');
    case 'D':
      return hex('#512525');
    default:
      return hex('#cccccc');
  }
}

/** DrawableRank.GetRankLetter */
export function rankLetter(rank: ScoreRank): string {
  switch (rank) {
    case 'XH':
    case 'X':
      return 'SS';
    case 'SH':
    case 'S':
      return 'S';
    default:
      return rank;
  }
}

/** OsuColour.ForModType */
export function forModType(type: ModType): RGBA {
  switch (type) {
    case 'automation':
      return OsuColour.Blue1;
    case 'increase':
      return OsuColour.Red1;
    case 'reduction':
      return OsuColour.Lime1;
    case 'conversion':
      return OsuColour.Purple1;
    case 'fun':
      return OsuColour.Pink1;
    default:
      return OsuColour.Yellow;
  }
}

/** OsuColour.ForBeatmapSetOnlineStatus */
export function forBeatmapSetOnlineStatus(status: BeatmapOnlineStatus): RGBA | null {
  switch (status) {
    case BeatmapOnlineStatus.None:
      return hex('bc8f8f'); // Color4.RosyBrown
    case BeatmapOnlineStatus.LocallyModified:
      return hex('ff4500'); // Color4.OrangeRed
    case BeatmapOnlineStatus.Ranked:
    case BeatmapOnlineStatus.Approved:
      return hex('b3ff66');
    case BeatmapOnlineStatus.Loved:
      return hex('ff66ab');
    case BeatmapOnlineStatus.Qualified:
      return hex('66ccff');
    case BeatmapOnlineStatus.Pending:
      return hex('ffd966');
    case BeatmapOnlineStatus.WIP:
      return hex('ff9966');
    case BeatmapOnlineStatus.Graveyard:
      return BLACK;
    default:
      return null;
  }
}

/** OverlayColourScheme hues (OverlayColourProvider.GetHue). */
export const OverlayColourScheme = {
  Red: 0,
  Orange: 45,
  Lime: 90,
  Green: 125,
  Aquamarine: 160,
  Blue: 200,
  Purple: 255,
  Plum: 320,
  Pink: 333,
} as const;

/** OverlayColourProvider */
export class OverlayColourProvider {
  constructor(public hue: number) {}

  private c(s: number, l: number): RGBA {
    return fromHSL(this.hue / 360, s, l);
  }

  get colour0() { return this.c(1, 0.8); }
  get colour1() { return this.c(1, 0.7); }
  get colour2() { return this.c(0.8, 0.6); }
  get colour3() { return this.c(0.6, 0.5); }
  get colour4() { return this.c(0.4, 0.3); }
  get highlight1() { return this.c(1, 0.7); }
  get content1() { return this.c(0.4, 1); }
  get content2() { return this.c(0.4, 0.9); }
  get light1() { return this.c(0.4, 0.8); }
  get light2() { return this.c(0.4, 0.75); }
  get light3() { return this.c(0.4, 0.7); }
  get light4() { return this.c(0.4, 0.5); }
  get dark1() { return this.c(0.2, 0.35); }
  get dark2() { return this.c(0.2, 0.3); }
  get dark3() { return this.c(0.2, 0.25); }
  get dark4() { return this.c(0.2, 0.2); }
  get dark5() { return this.c(0.2, 0.15); }
  get dark6() { return this.c(0.2, 0.1); }
  get foreground1() { return this.c(0.1, 0.6); }
  get background1() { return this.c(0.1, 0.4); }
  get background2() { return this.c(0.1, 0.3); }
  get background3() { return this.c(0.1, 0.25); }
  get background4() { return this.c(0.1, 0.2); }
  get background5() { return this.c(0.1, 0.15); }
  get background6() { return this.c(0.1, 0.1); }

  /** Writes the palette as CSS custom properties (`--c-background3` etc.) onto an element. */
  apply(el: HTMLElement, prefix = '--c'): void {
    const names = [
      'colour0', 'colour1', 'colour2', 'colour3', 'colour4', 'highlight1', 'content1', 'content2', 'light1', 'light2', 'light3', 'light4',
      'dark1', 'dark2', 'dark3', 'dark4', 'dark5', 'dark6', 'foreground1', 'background1', 'background2', 'background3', 'background4', 'background5', 'background6',
    ] as const;
    for (const n of names) el.style.setProperty(`${prefix}-${n}`, css(this[n]));
    el.style.setProperty(`${prefix}-hue`, String(this.hue));
  }
}

/** FormatUtils.FormatStarRating: floor to 2 decimals, "0.00". */
export function formatStarRating(stars: number): string {
  return (Math.floor(stars * 100) / 100).toFixed(2);
}
