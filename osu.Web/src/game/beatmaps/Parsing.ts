// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game/Beatmaps/Formats/Parsing.cs

export const MAX_COORDINATE_VALUE = 131072;
export const MAX_PARSE_VALUE = 2147483647;

export class ParseError extends Error {}

export function parseFloat32(input: string, parseLimit = MAX_PARSE_VALUE): number {
  const output = Math.fround(Number(input.trim()));
  if (input.trim() === '' || Number.isNaN(output)) throw new ParseError(`Not a number: ${input}`);
  if (output < -parseLimit) throw new ParseError('Value is too low');
  if (output > parseLimit) throw new ParseError('Value is too high');
  return output;
}

export function parseDouble(input: string, parseLimit = MAX_PARSE_VALUE, allowNaN = false): number {
  const trimmed = input.trim();
  const output = trimmed === '' ? NaN : Number(trimmed);
  if (output < -parseLimit) throw new ParseError('Value is too low');
  if (output > parseLimit) throw new ParseError('Value is too high');
  if (!allowNaN && Number.isNaN(output)) throw new ParseError('Not a number');
  return output;
}

export function parseInt32(input: string, parseLimit = MAX_PARSE_VALUE): number {
  const trimmed = input.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) {
    // C# int.Parse is strict; accept float-like values only by failing like it would.
    throw new ParseError(`Not an integer: ${input}`);
  }
  const output = Number(trimmed);
  if (output < -parseLimit) throw new ParseError('Value is too low');
  if (output > parseLimit) throw new ParseError('Value is too high');
  return output;
}

/** Lenient int parser used where C# uses int.TryParse (returns fallback on failure). */
export function tryParseInt(input: string, fallback = 0): number {
  const trimmed = input.trim();
  return /^[+-]?\d+$/.test(trimmed) ? Number(trimmed) : fallback;
}
