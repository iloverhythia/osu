// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// ModPreset storage (realm ModPreset: Ruleset, Name, Description, Mods, DeletePending).

import { settings } from '../../framework/Settings';
import type { ModSettings } from './Mods';

export interface ModPreset {
  id: string;
  name: string;
  description: string;
  mods: string[];
  settings: ModSettings;
  deletePending?: boolean;
}

const key = (ruleset: string) => `modPresets.${ruleset}`;

export const ModPresets = {
  /** Presets for a ruleset, in creation order, excluding deleted ones. */
  forRuleset(ruleset: string): ModPreset[] {
    return settings.get<ModPreset[]>(key(ruleset), []).filter(p => !p.deletePending);
  },
  private_all(ruleset: string): ModPreset[] {
    return settings.get<ModPreset[]>(key(ruleset), []);
  },
  add(ruleset: string, preset: Omit<ModPreset, 'id'>): void {
    settings.set(key(ruleset), [...this.private_all(ruleset), { ...preset, id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}` }]);
  },
  update(ruleset: string, id: string, changes: Partial<ModPreset>): void {
    settings.set(key(ruleset), this.private_all(ruleset).map(p => (p.id === id ? { ...p, ...changes } : p)));
  },
  /** DeleteModPresetDialog: marks DeletePending. */
  delete(ruleset: string, id: string): void {
    this.update(ruleset, id, { deletePending: true });
  },
  /** Maintenance: "Delete ALL mod presets" (all rulesets). Returns how many were deleted. */
  deleteAll(rulesets: string[]): number {
    let n = 0;
    for (const r of rulesets) {
      const all = this.private_all(r);
      n += all.filter(p => !p.deletePending).length;
      settings.set(key(r), all.map(p => ({ ...p, deletePending: true })));
    }
    return n;
  },
  /** Maintenance: "Restore all recently deleted mod presets". */
  restoreAll(rulesets: string[]): number {
    let n = 0;
    for (const r of rulesets) {
      const all = this.private_all(r);
      n += all.filter(p => p.deletePending).length;
      settings.set(key(r), all.map(p => ({ ...p, deletePending: false })));
    }
    return n;
  },
};
