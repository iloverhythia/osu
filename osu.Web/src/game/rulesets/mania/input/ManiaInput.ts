// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of ManiaRuleset.GetDefaultKeyBindings + SingleStageVariantGenerator / DualStageVariantGenerator / VariantMappingGenerator.
// Keys are KeyboardEvent.code values.

import type { RulesetAction } from '../../Ruleset';

export interface ManiaVariant {
  /** Column counts per stage. */
  stages: number[];
}

/** "4K" -> single 4K stage, "7K+7K" -> dual stage. */
export function parseVariant(variant?: string): ManiaVariant {
  if (!variant) return { stages: [4] };
  const parts = variant
    .split('+')
    .map(p => parseInt(p, 10))
    .filter(n => Number.isFinite(n) && n > 0);
  if (parts.length === 0) return { stages: [4] };
  return { stages: parts.slice(0, 2) };
}

export function variantName(stages: readonly number[]): string {
  return stages.map(s => `${s}K`).join('+');
}

export const actionId = (column: number): string => `K${column + 1}`;

export function maniaActions(variant?: string): RulesetAction[] {
  const total = parseVariant(variant).stages.reduce((a, b) => a + b, 0);
  return Array.from({ length: total }, (_, i) => ({ id: actionId(i), label: `Key ${i + 1}` }));
}

/** VariantMappingGenerator.GenerateKeyBindingsFor */
function generateKeyBindingsFor(
  columns: number,
  leftKeys: string[],
  rightKeys: string[],
  specialKey: string,
  actionStart: number,
  out: Record<string, string[]>,
): void {
  let currentAction = actionStart;

  const bind = (key: string | undefined): void => {
    const id = actionId(currentAction++);
    out[id] = key ? [key] : [];
  };

  for (let i = leftKeys.length - Math.trunc(columns / 2); i < leftKeys.length; i++) bind(leftKeys[i]);

  if (columns % 2 === 1) bind(specialKey);

  for (let i = 0; i < Math.trunc(columns / 2); i++) bind(rightKeys[i]);
}

export function maniaDefaultBindings(variant?: string): Record<string, string[]> {
  const { stages } = parseVariant(variant);
  const out: Record<string, string[]> = {};

  if (stages.length === 1) {
    const keys = stages[0];
    // 10K is special because it expands towards the centre of the keyboard (V/N), rather than towards the edges of the keyboard.
    const left = keys === 10 ? ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyV'] : ['KeyA', 'KeyS', 'KeyD', 'KeyF'];
    const right = keys === 10 ? ['KeyN', 'KeyJ', 'KeyK', 'KeyL', 'Semicolon'] : ['KeyJ', 'KeyK', 'KeyL', 'Semicolon'];
    generateKeyBindingsFor(keys, left, right, 'Space', 0, out);
  } else {
    const keys = stages[0];
    let s1Left: string[], s1Right: string[], s2Left: string[], s2Right: string[];
    if (keys === 10) {
      s1Left = ['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyV'];
      s1Right = ['KeyM', 'KeyI', 'KeyO', 'KeyP', 'BracketLeft'];
      s2Left = ['KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyB'];
      s2Right = ['KeyN', 'KeyJ', 'KeyK', 'KeyL', 'Semicolon'];
    } else {
      s1Left = ['KeyQ', 'KeyW', 'KeyE', 'KeyR'];
      s1Right = ['KeyI', 'KeyO', 'KeyP', 'BracketLeft'];
      s2Left = ['KeyS', 'KeyD', 'KeyF', 'KeyG'];
      s2Right = ['KeyJ', 'KeyK', 'KeyL', 'Semicolon'];
    }
    generateKeyBindingsFor(keys, s1Left, s1Right, 'KeyV', 0, out);
    generateKeyBindingsFor(stages[1] ?? keys, s2Left, s2Right, 'KeyB', keys, out);
  }

  return out;
}
