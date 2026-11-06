// Port of osu.Game/Overlays/OnScreenDisplay.cs + OSD/Toast.cs, OSD/TrackedSettingToast.cs: a rounded black box at
// (0.5, 0.75) of the screen showing a description, a value, option lights and the shortcut. It fades in (500ms
// OutQuint, growing from 90% height) and out after 500ms (1500ms InQuint). The tracked settings are those of
// OsuConfigManager.CreateTrackedSettings: FPS counter, gameplay mouse buttons, in-game leaderboard, HUD visibility,
// skin and UI scale.

import './osd.css';
import { APP_NAME } from '../../brand';
import { settings } from '../../framework/Settings';
import { ACTIVE_SKIN_SETTING, listSkins } from '../../game/skinning';
import { h } from '../dom';

export interface ToastContent {
  description: string;
  value: string;
  extra?: string;
  /** TrackedSettingToast option lights: 1 for a bool (lit when true), n for an enum. */
  lights?: { count: number; selected: number };
}

let box: HTMLElement | null = null;
let fadeOutTimer = 0;

function ensureBox(): HTMLElement {
  if (box?.isConnected) return box;
  box = h('div', { class: 'osd-box' });
  document.body.appendChild(box);
  return box;
}

/** OnScreenDisplay.Display(Toast) */
export function displayToast(t: ToastContent): void {
  const b = ensureBox();
  const lights = t.lights
    ? h(
        'div',
        { class: 'osd-lights' },
        ...Array.from({ length: t.lights.count }, (_, i) => h('div', { class: `osd-light${(t.lights!.count === 1 ? t.lights!.selected === 1 : i === t.lights!.selected) ? ' glowing' : ''}` })),
      )
    : null;
  b.replaceChildren(
    h(
      'div',
      { class: 'osd-toast' },
      h('div', { class: 'osd-description' }, t.description.toUpperCase()),
      h('div', { class: `osd-value${lights ? ' with-lights' : ''}` }, t.value),
      lights,
      t.extra ? h('div', { class: 'osd-extra' }, t.extra) : null,
    ),
  );
  // DisplayTemporarily
  b.classList.remove('fading-out');
  b.classList.add('shown');
  clearTimeout(fadeOutTimer);
  fadeOutTimer = window.setTimeout(() => {
    b.classList.add('fading-out');
    b.classList.remove('shown');
  }, 500);
}

// ------------------------------------------------------------------ tracked settings

const enabled = (v: boolean) => (v ? 'enabled' : 'disabled');
const HUD_MODES = ['never', 'hideDuringGameplay', 'always'] as const;
const HUD_NAMES: Record<string, string> = { never: 'Never', hideDuringGameplay: 'Hide during gameplay', always: 'Always' };

let tracking = false;

/** OnScreenDisplay.BeginTracking(OsuConfigManager) */
export function trackSettings(): void {
  if (tracking) return;
  tracking = true;
  const last = new Map<string, unknown>();
  const watched = ['graphics.showFps', 'gameplay.disableMouseButtons', 'gameplay.leaderboard', 'gameplay.hudVisibilityMode', ACTIVE_SKIN_SETTING, 'graphics.uiScale'];
  for (const k of watched) last.set(k, settings.get(k, null));
  settings.subscribe(k => {
    if (!watched.includes(k)) return;
    const v = settings.get<unknown>(k, null);
    if (last.get(k) === v) return;
    last.set(k, v);
    switch (k) {
      case 'graphics.showFps':
        displayToast({ description: 'Toggle FPS counter', value: enabled(!!v), extra: 'Ctrl+Shift+F', lights: { count: 1, selected: v ? 1 : 0 } });
        break;
      case 'gameplay.disableMouseButtons':
        displayToast({ description: 'Toggle gameplay mouse buttons', value: enabled(!v), extra: 'F10', lights: { count: 1, selected: v ? 0 : 1 } });
        break;
      case 'gameplay.leaderboard':
        displayToast({ description: 'Toggle in-game leaderboard', value: enabled(!!v), extra: 'Tab', lights: { count: 1, selected: v ? 1 : 0 } });
        break;
      case 'gameplay.hudVisibilityMode':
        if (typeof v === 'string')
          displayToast({ description: 'HUD visibility mode', value: HUD_NAMES[v] ?? v, extra: 'Toggle in-game interface: Shift+Tab Hold for HUD: Ctrl', lights: { count: HUD_MODES.length, selected: HUD_MODES.indexOf(v as (typeof HUD_MODES)[number]) } });
        break;
      case ACTIVE_SKIN_SETTING:
        void listSkins().then(skins => {
          const name = typeof v === 'string' ? (skins.find(s => s.id === v)?.name ?? 'unknown') : `argon (${APP_NAME})`;
          displayToast({ description: 'Skin', value: name, extra: 'Random skin: Ctrl+Shift+R' });
        });
        break;
      case 'graphics.uiScale':
        if (typeof v === 'number') displayToast({ description: 'UI scaling', value: `${v.toFixed(2)}x` });
        break;
    }
  });
}
