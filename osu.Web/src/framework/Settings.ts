// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Persistent configuration (port of OsuConfigManager essentials) backed by localStorage.

const STORAGE_KEY = 'osu-web.settings';

function prefers24HourTime(): boolean {
  try {
    const hc = new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hourCycle;
    return hc === 'h23' || hc === 'h24';
  } catch {
    return true;
  }
}

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
  'osu.hitAnimations': true,
  'osu.autoCursorSize': false,
  'audio.positionalHitsoundsLevel': 0.2,
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
  // Settings overlay additions (OsuConfigManager / ruleset config defaults).
  'ui.language': 'en',
  // OsuSetting.Prefer24HourTime defaults to the system culture's short time pattern having no AM/PM designator.
  'ui.prefer24h': prefers24HourTime(),
  'ui.cursorRotation': true,
  'ui.menuCursorSize': 1,
  'ui.parallax': 1,
  'ui.menuTips': true,
  'ui.menuVoice': true,
  'ui.menuMusic': true,
  'ui.introSequence': 'triangles',
  'ui.menuBackgroundSource': 'skin',
  'ui.seasonalBackgrounds': 'sometimes',
  'ui.modSelectHotkeyStyle': 'sequential',
  'ui.modSelectSearchAutofocus': true,
  'select.showConverts': true,
  'select.randomAlgorithm': 'permutation',
  'select.backgroundBlur': false,
  'gameplay.scoreDisplayMode': 'standardised',
  'gameplay.hitLighting': true,
  'gameplay.backgroundBlur': 0,
  'gameplay.replaySettingsOverlay': true,
  'gameplay.leaderboard': true,
  'gameplay.alwaysRequireHoldForPause': false,
  'gameplay.alwaysShowHoldForMenu': false,
  'skin.beatmapColours': true,
  'skin.beatmapHitsounds': true,
  'skin.comboColourNormalisation': 0.2,
  'osu.cursorDuringTouch': false,
  'osu.cursorRipples': false,
  'osu.playfieldBorderStyle': 'none',
  'mania.timingBasedColouring': false,
  'mania.touchOverlay': false,
  'audio.masterInactive': 0.25,
  'audio.hitsound': 0.6,
  'audio.autoAdjustOffset': true,
  'graphics.uiScale': 1,
  'graphics.frameLimiter': 'vsync',
  'graphics.screenshotFormat': 'jpg',
  'graphics.screenshotCursor': false,
  'input.highPrecision': false,
  'input.sensitivity': 1,
  // lazer defaults to DuringGameplay; in a browser confining means pointer lock, so it is opt-in.
  'input.confine': 'never',
  'input.mouseDisableWheel': false,
  'input.touchDisableTaps': false,
  'online.externalLinkWarning': true,
  'online.preferNoVideo': false,
  'online.autoDownload': true,
  'online.explicitContent': false,
  'online.hideFlags': false,
  'online.notifyMention': true,
  'online.notifyPM': true,
  'online.notifyFriends': true,
  'online.pmFriendsOnly': false,
  'debug.gcMode': 'sustainedLowLatency',
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

  /** Resets every stored key starting with `prefix`; returns how many were reset. */
  resetPrefix(prefix: string): number {
    const keys = Object.keys(this.values).filter(k => k.startsWith(prefix));
    for (const k of keys) delete this.values[k];
    this.save();
    for (const k of keys) for (const l of this.listeners) l(k, this.get(k));
    return keys.length;
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
