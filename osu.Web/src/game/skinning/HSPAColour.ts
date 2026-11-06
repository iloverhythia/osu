// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game/Graphics/HSPAColour.cs (hue, saturation, perceived brightness) and the combo colour
// normalisation of DrawableHitObject.UpdateComboColour (OsuSetting.ComboColourNormalisationAmount).

import { settings } from '../../framework/Settings';
import { toLinear, toSRGB } from '../storyboard/Easing';

const PR = 0.299;
const PG = 0.587;
const PB = 0.114;

export interface HSPA {
  h: number;
  s: number;
  p: number;
}

export function toHSPA(r: number, g: number, b: number): HSPA {
  let h = 0;
  let s = 0;
  const p = Math.sqrt(r * r * PR + g * g * PG + b * b * PB);
  if (r === g && r === b) return { h, s, p };
  if (r >= g && r >= b) {
    if (b >= g) {
      h = 6 / 6 - ((1 / 6) * (b - g)) / (r - g);
      s = 1 - g / r;
    } else {
      h = 0 / 6 + ((1 / 6) * (g - b)) / (r - b);
      s = 1 - b / r;
    }
  } else if (g >= r && g >= b) {
    if (r >= b) {
      h = 2 / 6 - ((1 / 6) * (r - b)) / (g - b);
      s = 1 - b / g;
    } else {
      h = 2 / 6 + ((1 / 6) * (b - r)) / (g - r);
      s = 1 - r / g;
    }
  } else if (g >= r) {
    h = 4 / 6 - ((1 / 6) * (g - r)) / (b - r);
    s = 1 - r / b;
  } else {
    h = 4 / 6 + ((1 / 6) * (r - g)) / (b - g);
    s = 1 - g / b;
  }
  return { h, s, p };
}

export function fromHSPA({ h, s, p: P }: HSPA): [number, number, number] {
  const m = 1 - s;
  let r = 0;
  let g = 0;
  let b = 0;
  if (m > 0) {
    if (h < 1 / 6) {
      h = 6 * (h - 0 / 6);
      const part = 1 + h * (1 / m - 1);
      b = P / Math.sqrt(PR / m / m + PG * part * part + PB);
      r = b / m;
      g = b + h * (r - b);
    } else if (h < 2 / 6) {
      h = 6 * (-h + 2 / 6);
      const part = 1 + h * (1 / m - 1);
      b = P / Math.sqrt(PG / m / m + PR * part * part + PB);
      g = b / m;
      r = b + h * (g - b);
    } else if (h < 3 / 6) {
      h = 6 * (h - 2 / 6);
      const part = 1 + h * (1 / m - 1);
      r = P / Math.sqrt(PG / m / m + PB * part * part + PR);
      g = r / m;
      b = r + h * (g - r);
    } else if (h < 4 / 6) {
      h = 6 * (-h + 4 / 6);
      const part = 1 + h * (1 / m - 1);
      r = P / Math.sqrt(PB / m / m + PG * part * part + PR);
      b = r / m;
      g = r + h * (b - r);
    } else if (h < 5 / 6) {
      h = 6 * (h - 4 / 6);
      const part = 1 + h * (1 / m - 1);
      g = P / Math.sqrt(PB / m / m + PR * part * part + PG);
      b = g / m;
      r = g + h * (b - g);
    } else {
      h = 6 * (-h + 6 / 6);
      const part = 1 + h * (1 / m - 1);
      g = P / Math.sqrt(PR / m / m + PB * part * part + PG);
      r = g / m;
      b = g + h * (r - g);
    }
  } else if (h < 1 / 6) {
    h = 6 * (h - 0 / 6);
    r = Math.sqrt((P * P) / (PR + PG * h * h));
    g = r * h;
  } else if (h < 2 / 6) {
    h = 6 * (-h + 2 / 6);
    g = Math.sqrt((P * P) / (PG + PR * h * h));
    r = g * h;
  } else if (h < 3 / 6) {
    h = 6 * (h - 2 / 6);
    g = Math.sqrt((P * P) / (PG + PB * h * h));
    b = g * h;
  } else if (h < 4 / 6) {
    h = 6 * (-h + 4 / 6);
    b = Math.sqrt((P * P) / (PB + PG * h * h));
    g = b * h;
  } else if (h < 5 / 6) {
    h = 6 * (h - 4 / 6);
    b = Math.sqrt((P * P) / (PB + PR * h * h));
    r = b * h;
  } else {
    h = 6 * (-h + 6 / 6);
    r = Math.sqrt((P * P) / (PR + PB * h * h));
    b = r * h;
  }
  return [r, g, b];
}

/**
 * DrawableHitObject.UpdateComboColour: Interpolation.ValueAt(|amount|, colour, HSPA(colour){ P = 0.6 }, 0, 1)
 * (a linear-space lerp). Colours are 0..255 sRGB.
 */
export function normaliseComboColour<T extends readonly number[]>(c: T, amount = settings.get('skin.comboColourNormalisation', 0.2)): T {
  if (amount === 0) return c;
  const r = c[0] / 255;
  const g = c[1] / 255;
  const b = c[2] / 255;
  const hspa = toHSPA(r, g, b);
  hspa.p = 0.6;
  const target = fromHSPA(hspa);
  const t = Math.min(1, Math.abs(amount));
  const mix = (a: number, z: number) => Math.round(toSRGB(toLinear(a) + t * (toLinear(z) - toLinear(a))) * 255);
  const out = [...c] as number[];
  out[0] = mix(r, target[0]);
  out[1] = mix(g, target[1]);
  out[2] = mix(b, target[2]);
  return out as unknown as T;
}
