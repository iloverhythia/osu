// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu-framework's Anchor flags (osu.Framework/Graphics/Anchor.cs) and osu.Game/Storyboards/StoryboardExtensions.cs (AdjustOrigin).

/** osu.Framework.Graphics.Anchor (flags). */
export enum Anchor {
  y0 = 1,
  y1 = 1 << 1,
  y2 = 1 << 2,
  x0 = 1 << 3,
  x1 = 1 << 4,
  x2 = 1 << 5,

  TopLeft = y0 | x0,
  TopCentre = y0 | x1,
  TopRight = y0 | x2,
  CentreLeft = y1 | x0,
  Centre = y1 | x1,
  CentreRight = y1 | x2,
  BottomLeft = y2 | x0,
  BottomCentre = y2 | x1,
  BottomRight = y2 | x2,
}

const Y_MASK = Anchor.y0 | Anchor.y1 | Anchor.y2;
const X_MASK = Anchor.x0 | Anchor.x1 | Anchor.x2;

/**
 * StoryboardExtensions.AdjustOrigin: given an origin and a set of properties, adjust the origin to display the sprite/animation correctly
 * (a flip or a negative vector scale mirrors the sprite "in place" by mirroring its origin too).
 */
export function adjustOrigin(origin: Anchor, vectorScaleX: number, vectorScaleY: number, flipH: boolean, flipV: boolean): Anchor {
  // Either flip horizontally or negative X scale, but not both.
  if (flipH !== vectorScaleX < 0) {
    if (origin & Anchor.x0) origin = Anchor.x2 | (origin & Y_MASK);
    else if (origin & Anchor.x2) origin = Anchor.x0 | (origin & Y_MASK);
  }

  // Either flip vertically or negative Y scale, but not both.
  if (flipV !== vectorScaleY < 0) {
    if (origin & Anchor.y0) origin = Anchor.y2 | (origin & X_MASK);
    else if (origin & Anchor.y2) origin = Anchor.y0 | (origin & X_MASK);
  }

  return origin;
}

/** Relative position of an anchor within a box (0, 0.5 or 1 on each axis), as in Drawable.ComputeAnchorPosition. */
export function anchorX(a: Anchor): number {
  return a & Anchor.x1 ? 0.5 : a & Anchor.x2 ? 1 : 0;
}

export function anchorY(a: Anchor): number {
  return a & Anchor.y1 ? 0.5 : a & Anchor.y2 ? 1 : 0;
}
