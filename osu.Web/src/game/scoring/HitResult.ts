// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game/Rulesets/Scoring/HitResult.cs

export enum HitResult {
  None = 0,
  Miss,
  Meh,
  Ok,
  Good,
  Great,
  Perfect,
  SmallTickMiss,
  SmallTickHit,
  LargeTickMiss,
  LargeTickHit,
  SmallBonus,
  LargeBonus,
  IgnoreMiss,
  IgnoreHit,
  ComboBreak,
  SliderTailHit,
}

export function affectsCombo(r: HitResult): boolean {
  switch (r) {
    case HitResult.Miss:
    case HitResult.Meh:
    case HitResult.Ok:
    case HitResult.Good:
    case HitResult.Great:
    case HitResult.Perfect:
    case HitResult.LargeTickHit:
    case HitResult.LargeTickMiss:
    case HitResult.ComboBreak:
    case HitResult.SliderTailHit:
      return true;
    default:
      return false;
  }
}

export const increasesCombo = (r: HitResult): boolean => affectsCombo(r) && isHit(r);
export const breaksCombo = (r: HitResult): boolean => affectsCombo(r) && !isHit(r);

export function isBonus(r: HitResult): boolean {
  return r === HitResult.SmallBonus || r === HitResult.LargeBonus;
}

export function isTick(r: HitResult): boolean {
  switch (r) {
    case HitResult.LargeTickHit:
    case HitResult.LargeTickMiss:
    case HitResult.SmallTickHit:
    case HitResult.SmallTickMiss:
    case HitResult.SliderTailHit:
      return true;
    default:
      return false;
  }
}

export function isHit(r: HitResult): boolean {
  switch (r) {
    case HitResult.None:
    case HitResult.IgnoreMiss:
    case HitResult.Miss:
    case HitResult.SmallTickMiss:
    case HitResult.LargeTickMiss:
    case HitResult.ComboBreak:
      return false;
    default:
      return true;
  }
}

export function isMiss(r: HitResult): boolean {
  switch (r) {
    case HitResult.IgnoreMiss:
    case HitResult.Miss:
    case HitResult.SmallTickMiss:
    case HitResult.LargeTickMiss:
    case HitResult.ComboBreak:
      return true;
    default:
      return false;
  }
}

export function isScorable(r: HitResult): boolean {
  switch (r) {
    case HitResult.ComboBreak:
    case HitResult.SliderTailHit:
      return true;
    default:
      return r >= HitResult.Miss && r < HitResult.IgnoreMiss;
  }
}

export const affectsAccuracy = (r: HitResult): boolean => r !== HitResult.ComboBreak && isScorable(r) && !isBonus(r);
export const isBasic = (r: HitResult): boolean => r !== HitResult.ComboBreak && isScorable(r) && !isTick(r) && !isBonus(r);

/** Judgement.MinResult default mapping. */
export function minResultFor(max: HitResult): HitResult {
  switch (max) {
    case HitResult.SmallBonus:
    case HitResult.LargeBonus:
    case HitResult.IgnoreHit:
      return HitResult.IgnoreMiss;
    case HitResult.SmallTickHit:
      return HitResult.SmallTickMiss;
    case HitResult.LargeTickHit:
    case HitResult.SliderTailHit:
      return HitResult.LargeTickMiss;
    default:
      return HitResult.Miss;
  }
}

/** Judgement.HealthIncreaseFor default values. */
export function defaultHealthIncreaseFor(r: HitResult): number {
  const MAX = 0.05;
  switch (r) {
    case HitResult.SmallTickHit:
      return MAX * 0.5;
    case HitResult.SmallTickMiss:
      return -MAX * 0.5;
    case HitResult.SliderTailHit:
    case HitResult.LargeTickHit:
      return MAX;
    case HitResult.LargeTickMiss:
      return -MAX;
    case HitResult.Miss:
      return -MAX * 2;
    case HitResult.Meh:
      return MAX * 0.05;
    case HitResult.Ok:
      return MAX * 0.5;
    case HitResult.Good:
      return MAX * 0.75;
    case HitResult.Great:
      return MAX;
    case HitResult.Perfect:
      return MAX * 1.05;
    case HitResult.SmallBonus:
      return MAX * 0.5;
    case HitResult.LargeBonus:
      return MAX;
    default:
      return 0;
  }
}

export const HIT_RESULT_NAMES: Record<HitResult, string> = {
  [HitResult.None]: 'None',
  [HitResult.Miss]: 'Miss',
  [HitResult.Meh]: 'Meh',
  [HitResult.Ok]: 'Ok',
  [HitResult.Good]: 'Good',
  [HitResult.Great]: 'Great',
  [HitResult.Perfect]: 'Perfect',
  [HitResult.SmallTickMiss]: 'Small tick miss',
  [HitResult.SmallTickHit]: 'Small tick',
  [HitResult.LargeTickMiss]: 'Large tick miss',
  [HitResult.LargeTickHit]: 'Large tick',
  [HitResult.SmallBonus]: 'Small bonus',
  [HitResult.LargeBonus]: 'Large bonus',
  [HitResult.IgnoreMiss]: 'Ignore miss',
  [HitResult.IgnoreHit]: 'Ignore hit',
  [HitResult.ComboBreak]: 'Combo break',
  [HitResult.SliderTailHit]: 'Slider tail',
};
