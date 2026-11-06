// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Small numeric helpers used to reproduce C# semantics in the osu!mania port.

/** Single-precision rounding (C# `float`). */
export const f32 = Math.fround;

/** C# Math.Round / MathF.Round default behaviour (MidpointRounding.ToEven). */
export function roundHalfEven(x: number): number {
  if (!Number.isFinite(x)) return x;
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** C# (int) cast of a double (truncation towards zero). */
export const toInt = (x: number): number => Math.trunc(x);

export const clampNum = (v: number, min: number, max: number): number => (v < min ? min : v > max ? max : v);
