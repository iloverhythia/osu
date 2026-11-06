// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Procedural default skin ("argon"-inspired). No copyrighted textures are used.

export type RGB = [number, number, number];

export const DEFAULT_COMBO_COLOURS: RGB[] = [
  [255, 192, 0],
  [0, 202, 0],
  [18, 124, 255],
  [242, 24, 57],
];

export const rgb = (c: RGB, a = 1): string => (a >= 1 ? `rgb(${c[0]},${c[1]},${c[2]})` : `rgba(${c[0]},${c[1]},${c[2]},${a})`);

export function lighten(c: RGB, amount: number): RGB {
  return [Math.min(255, c[0] + (255 - c[0]) * amount), Math.min(255, c[1] + (255 - c[1]) * amount), Math.min(255, c[2] + (255 - c[2]) * amount)] as RGB;
}

export function darken(c: RGB, amount: number): RGB {
  return [c[0] * (1 - amount), c[1] * (1 - amount), c[2] * (1 - amount)] as RGB;
}

export const COLOURS = {
  pink: '#ff66aa',
  pinkDark: '#cc5288',
  blue: '#66ccff',
  yellow: '#ffcc22',
  green: '#88b300',
  red: '#ed1121',
  purple: '#aa88ff',
  // Judgement colours (OsuColour.ForHitResult)
  perfect: '#99eeff',
  great: '#66ccff',
  good: '#b3d944',
  ok: '#88b300',
  meh: '#ffcc22',
  miss: '#ed1121',
};

export interface Skin {
  /** User skin (.osk) and beatmap skin, highest priority first. Empty when using the default procedural skin. */
  sources: import('./skinning').LoadedSkin[];
  comboColours: RGB[];
  comboColour(index: number): RGB;
  sliderTrackOverride?: RGB;
  sliderBorder?: RGB;
}

export function createSkin(
  beatmapColours: RGB[] | null,
  custom?: Record<string, [number, number, number, number]>,
  sources: import('./skinning').LoadedSkin[] = [],
): Skin {
  const comboColours = beatmapColours && beatmapColours.length > 0 ? beatmapColours : DEFAULT_COMBO_COLOURS;
  const track = custom?.['SliderTrackOverride'];
  const border = custom?.['SliderBorder'];
  return {
    sources,
    comboColours,
    comboColour: (i: number) => comboColours[((i % comboColours.length) + comboColours.length) % comboColours.length],
    sliderTrackOverride: track ? [track[0], track[1], track[2]] : undefined,
    sliderBorder: border ? [border[0], border[1], border[2]] : undefined,
  };
}
