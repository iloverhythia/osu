// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Persistent configuration (port of OsuConfigManager essentials) backed by localStorage.

const STORAGE_KEY = 'osu-web.settings';

export const DEFAULT_SETTINGS = {
  // FrameworkConfigManager VolumeUniversal / VolumeMusic / VolumeEffect defaults.
  'audio.master': 1,
  'audio.music': 1,
  'audio.effects': 1,
  /** Universal offset in ms (positive = hit objects later). */
  'audio.offset': 0,
  'audio.compensateLatency': true,
  // OsuConfigManager defaults: DimLevel 0.7, KeyOverlay false, LightenDuringBreaks true, IncreaseFirstObjectVisibility true.
  'gameplay.backgroundDim': 0.7,
  'gameplay.lightenDuringBreaks': true,
  'gameplay.increaseFirstObjectVisibility': true,
  'gameplay.fadePlayfieldWhenHealthLow': true,
  'gameplay.alwaysPlayFirstComboBreak': true,
  'gameplay.showHud': true,
  'gameplay.hudVisibilityMode': 'always',
  'gameplay.showHealthDisplayWhenCantFail': true,
  'gameplay.starFountains': true,
  'ui.holdActivationDelay': 200,
  'gameplay.hitErrorMeter': true,
  'gameplay.showKeyCounter': false,
  'gameplay.disableMouseButtons': false,
  'gameplay.storyboard': true,
  'skin.beatmapSkins': true,
  'skin.active': null as string | null,
  'gameplay.comboBreakSound': true,
  'osu.cursorSize': 1,
  'osu.cursorTrail': true,
  'osu.followPoints': true,
  'osu.snakingIn': true,
  'osu.snakingOut': true,
  'osu.hitLighting': true,
  'mania.scrollSpeed': 8,
  'mania.scrollDirection': 'down',
  'taiko.touchControlScheme': 'KDDK',
  'taiko.hitAnimations': true,
  'taiko.rateAdjustedHitAnimation': true,
  'taiko.drumCombo': false, // not a lazer feature (stable-style combo on the drum)
  'fruits.hitLighting': true,
  'fruits.positionalHitsoundsLevel': 0.2,
  'fruits.flashlightSizeMultiplier': 1,
  'fruits.touchZoneWidth': 0.15,
  'graphics.renderScale': 1,
  'graphics.showFps': false,
  'ui.ruleset': 0,
  'ui.username': 'Guest',
  'ui.preferUnicode': false,
  'ui.sortMode': 'title',
} as const;

type Defaults = typeof DEFAULT_SETTINGS;
export type SettingKey = keyof Defaults | string;

type Listener = (key: string, value: unknown) => void;

class SettingsStore {
  private values: Record<string, unknown> = {};
  private listeners = new Set<Listener>();

  constructor() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) this.values = JSON.parse(raw);
    } catch {
      this.values = {};
    }
  }

  get<T>(key: string, fallback?: T): T {
    if (key in this.values) return this.values[key] as T;
    if (key in DEFAULT_SETTINGS) return DEFAULT_SETTINGS[key as keyof Defaults] as unknown as T;
    return fallback as T;
  }

  set(key: string, value: unknown): void {
    this.values[key] = value;
    this.save();
    for (const l of this.listeners) l(key, value);
  }

  reset(key: string): void {
    delete this.values[key];
    this.save();
    for (const l of this.listeners) l(key, this.get(key));
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.values));
    } catch {
      /* storage may be unavailable (private mode) */
    }
  }

  /** Key bindings for a ruleset + variant, falling back to the ruleset defaults. */
  getBindings(rulesetShortName: string, variant: string | undefined, defaults: Record<string, string[]>): Record<string, string[]> {
    const stored = this.get<Record<string, string[]> | undefined>(`bindings.${rulesetShortName}.${variant ?? 'default'}`, undefined);
    return stored ? { ...defaults, ...stored } : defaults;
  }

  setBindings(rulesetShortName: string, variant: string | undefined, bindings: Record<string, string[]>): void {
    this.set(`bindings.${rulesetShortName}.${variant ?? 'default'}`, bindings);
  }
}

export const settings = new SettingsStore();
