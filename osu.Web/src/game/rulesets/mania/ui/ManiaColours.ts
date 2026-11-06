// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Column accent colours from osu.Game.Rulesets.Mania/Skinning/Argon/ManiaArgonSkinTransformer.cs
// and Color4 extension helpers (osu.Framework Color4Extensions.Lighten / Darken).

export type RGB = [number, number, number];

const colour_special_column: RGB = [169, 106, 255];
const colour_yellow: RGB = [255, 197, 40];
const colour_orange: RGB = [252, 109, 1];
const colour_pink: RGB = [213, 35, 90];
const colour_purple: RGB = [203, 60, 236];
const colour_cyan: RGB = [72, 198, 255];
const colour_green: RGB = [100, 192, 92];

const total_colours = 6;

const LAYOUTS: Record<number, RGB[]> = {
  1: [colour_yellow],
  2: [colour_green, colour_cyan],
  3: [colour_green, colour_special_column, colour_cyan],
  4: [colour_yellow, colour_orange, colour_pink, colour_purple],
  5: [colour_pink, colour_orange, colour_yellow, colour_green, colour_cyan],
  6: [colour_pink, colour_orange, colour_green, colour_cyan, colour_orange, colour_pink],
  7: [colour_pink, colour_orange, colour_pink, colour_special_column, colour_pink, colour_orange, colour_pink],
  8: [colour_purple, colour_pink, colour_orange, colour_green, colour_cyan, colour_orange, colour_pink, colour_purple],
  9: [colour_purple, colour_pink, colour_orange, colour_yellow, colour_special_column, colour_yellow, colour_orange, colour_pink, colour_purple],
  10: [colour_purple, colour_pink, colour_orange, colour_yellow, colour_green, colour_cyan, colour_yellow, colour_orange, colour_pink, colour_purple],
};

/** ManiaArgonSkinTransformer.getColourForLayout */
export function columnColour(columnIndex: number, stageColumns: number): RGB {
  // Account for cases like dual-stage (assume that all stages have the same column count for now).
  columnIndex %= stageColumns;

  const layout = LAYOUTS[stageColumns];
  if (layout) return layout[columnIndex];

  // fallback for unhandled scenarios
  if (stageColumns % 2 === 1 && columnIndex === Math.trunc(stageColumns / 2)) return colour_special_column;

  switch (columnIndex % total_colours) {
    case 0:
      return colour_yellow;
    case 1:
      return colour_orange;
    case 2:
      return colour_pink;
    case 3:
      return colour_purple;
    case 4:
      return colour_cyan;
    default:
      return colour_green;
  }
}

/** Color4Extensions.Lighten */
export function lightenC4(c: RGB, amount: number): RGB {
  amount *= 0.5;
  const f = (v: number): number => Math.min(255, (v / 255) * (1 + 0.5 * amount) * 255 + amount * 255);
  return [f(c[0]), f(c[1]), f(c[2])];
}

/** Color4Extensions.Darken */
export function darkenC4(c: RGB, amount: number): RGB {
  const scale = Math.max(1, 1 + amount);
  return [c[0] / scale, c[1] / scale, c[2] / scale];
}

/** Interpolation.ValueAt(t, a, b, 0, 1) for colours. */
export function mixC4(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

export const css = (c: RGB, a = 1): string =>
  a >= 1 ? `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})` : `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a < 0 ? 0 : a})`;
