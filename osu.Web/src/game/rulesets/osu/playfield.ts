// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// OsuPlayfieldAdjustmentContainer: a 4:3 playfield taking 80% of the available space, shifted down slightly like stable.

export const OSU_PLAYFIELD_WIDTH = 512;
export const OSU_PLAYFIELD_HEIGHT = 384;

export interface PlayfieldTransform {
  scale: number;
  offsetX: number;
  offsetY: number;
}

export function osuPlayfieldTransform(width: number, height: number): PlayfieldTransform {
  const scale = Math.min((width * 0.8) / OSU_PLAYFIELD_WIDTH, (height * 0.8) / OSU_PLAYFIELD_HEIGHT);
  return {
    scale,
    offsetX: (width - OSU_PLAYFIELD_WIDTH * scale) / 2,
    offsetY: (height - OSU_PLAYFIELD_HEIGHT * scale) / 2 + 8 * scale,
  };
}
