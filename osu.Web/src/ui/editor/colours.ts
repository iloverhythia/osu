// Combo colours for the editor: the beatmap's own [Colours] when it has them, otherwise the skin's (argon) defaults.

import type { Beatmap } from '../../game/beatmaps/Beatmap';
import { ARGON_COMBO_COLOURS } from '../../game/rulesets/osu/argon';

export function comboColours(b: Beatmap): [number, number, number][] {
  return b.comboColours.length > 0 ? b.comboColours : ARGON_COMBO_COLOURS;
}

export function comboColour(b: Beatmap, comboIndex: number): [number, number, number] {
  const list = comboColours(b);
  return list[((comboIndex % list.length) + list.length) % list.length];
}
