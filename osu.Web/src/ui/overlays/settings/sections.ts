// The settings sections, subsections and items, in the order and with the captions / hints / ranges of
// SettingsOverlay (GeneralSection … DebugSection, plus one RulesetSection per ruleset).
// Items lazer only shows on platforms with the relevant hardware (updater, install folder, tablet, Windows key,
// Discord…) are left out, as lazer itself does on such platforms. Items whose feature doesn't exist in the
// browser version are shown disabled with a note.

import { zipSync } from 'fflate';
import { APP_NAME, RULESET_DISPLAY_NAMES } from '../../../brand';
import { settings } from '../../../framework/Settings';
import { availableRulesets } from '../../../game/rulesets';
import { ACTIVE_SKIN_SETTING, deleteSkin, listSkins, SkinStore, type SkinInfo } from '../../../game/skinning';
import { Database } from '../../../game/storage/Database';
import { confirmDialog } from '../../confirm';
import { h } from '../../dom';
import type { Game } from '../../Game';
import { rulesetIcon } from '../../select/Icons';
import { Bindable, bindSetting, bindValue, customItem, formCheckBox, formDropdown, formSliderBar, formTextBox, settingsButton, settingsItem, SettingsItem, standardFormat } from './controls';
import { SETTINGS_ICONS } from './icons';

export interface SubsectionDef {
  header: string;
  items: SettingsItem[];
}

export interface SectionDef {
  header: string;
  icon: () => Node;
  /** RulesetSection: UseSmallerSidebarButton */
  small?: boolean;
  keywords?: string[];
  items?: SettingsItem[];
  subsections: SubsectionDef[];
}

const NA = 'Not available in the browser version.';

const svgIcon = (markup: string) => () => {
  const s = document.createElement('span');
  s.innerHTML = markup;
  return s.firstElementChild!;
};

const check = (caption: string, key: string, o: { hint?: string; also?: string[]; keywords?: string[]; unavailable?: boolean; disabled?: () => boolean } = {}) => {
  const b = bindSetting<boolean>(key, o.also);
  if (o.disabled) b.disabled = o.disabled;
  return settingsItem(formCheckBox(caption, b, { hint: o.hint, unavailable: o.unavailable ? NA : undefined }), { keywords: o.keywords, unavailable: o.unavailable ? NA : undefined });
};

const slider = (
  caption: string,
  key: string,
  min: number,
  max: number,
  precision: number,
  o: { percent?: boolean; keyboardStep?: number; format?: (v: number) => string; hint?: string; also?: string[]; keywords?: string[]; unavailable?: boolean } = {},
) =>
  settingsItem(
    formSliderBar(caption, bindSetting<number>(key, o.also), {
      min,
      max,
      precision,
      keyboardStep: o.keyboardStep,
      displayAsPercentage: o.percent,
      labelFormat: o.format,
      hint: o.hint,
      unavailable: o.unavailable ? NA : undefined,
    }),
    { keywords: o.keywords, unavailable: o.unavailable ? NA : undefined },
  );

const dropdown = <T extends string | number>(caption: string, key: string, items: readonly (readonly [T, string])[], o: { hint?: string; keywords?: string[]; unavailable?: boolean } = {}) =>
  settingsItem(formDropdown<T>(caption, bindSetting<T>(key), items, { hint: o.hint, unavailable: o.unavailable ? NA : undefined }), { keywords: o.keywords, unavailable: o.unavailable ? NA : undefined });

const button = (text: string, action: () => void, o: { dangerous?: boolean; tooltip?: string; unavailable?: boolean; keywords?: string[] } = {}) =>
  settingsButton(text, action, { dangerous: o.dangerous, tooltip: o.tooltip, unavailable: o.unavailable ? NA : undefined, keywords: o.keywords });

function openLink(game: Game, url: string): void {
  const w = window.open(url, '_blank', 'noopener');
  if (!w) game.toast(`Couldn't open ${url}`, 'error');
}

function download(game: Game, blob: Blob, name: string): void {
  try {
    const a = h('a', { href: URL.createObjectURL(blob), download: name });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  } catch {
    game.toast('Downloads are blocked here.', 'error');
  }
}

// ------------------------------------------------------------------ skin section

function skinSection(game: Game): SectionDef {
  const host = h('div', { class: 'st-skin-host' });
  let skins: SkinInfo[] = [];
  const RANDOM = '__random__';
  const render = () => {
    const items: [string, string][] = [['', `argon (${APP_NAME})`], ...skins.map(s => [s.id, `${s.name} (${s.creator})`] as [string, string]), [RANDOM, '<Random Skin>']];
    const active = bindSetting<string | null>(ACTIVE_SKIN_SETTING);
    const bind: Bindable<string> = bindValue(
      () => {
        const id = active.get() ?? '';
        return skins.some(s => s.id === id) ? id : '';
      },
      v => {
        if (v === RANDOM) {
          // SkinManager.SelectRandomSkin: anything but the current skin.
          const pool = ['', ...skins.map(s => s.id)].filter(id => id !== (active.get() ?? ''));
          if (pool.length) settings.set(ACTIVE_SKIN_SETTING, pool[Math.floor(Math.random() * pool.length)] || null);
        } else settings.set(ACTIVE_SKIN_SETTING, v || null);
      },
      '',
    );
    const dd = settingsItem(formDropdown('Current skin', bind, items), { showRevert: true });
    const current = () => skins.find(s => s.id === (active.get() ?? ''));
    const rename = settingsButton('Rename selected skin', () => {
      const s = current();
      if (!s) return;
      const input = h('input', { class: 'st-popover-input', type: 'text', value: s.name, maxLength: 64 }) as HTMLInputElement;
      const pop = h('div', { class: 'st-popover' }, input, h('button', { class: 'st-button', onclick: () => void save() }, h('span', null, 'Save')));
      const save = async () => {
        const name = input.value.trim();
        pop.remove();
        if (!name || name === s.name) return;
        const rec = await SkinStore.get(s.id);
        if (rec) await SkinStore.put({ ...rec, name });
      };
      input.addEventListener('keydown', e => {
        e.stopPropagation();
        if (e.key === 'Enter') void save();
        if (e.key === 'Escape') pop.remove();
      });
      buttons.after(pop);
      input.focus();
      input.select();
    });
    const exportButton = settingsButton('Export selected skin', async () => {
      const s = current();
      if (!s) return;
      const rec = await SkinStore.get(s.id);
      if (!rec) return;
      const files: Record<string, Uint8Array> = {};
      for (const [path, blob] of Object.entries(rec.files)) files[path] = new Uint8Array(await blob.arrayBuffer());
      download(game, new Blob([zipSync(files) as BlobPart], { type: 'application/zip' }), `${rec.name}.osk`);
    });
    const del = settingsButton(
      'Delete selected skin',
      async () => {
        const s = current();
        if (!s) return;
        if (!(await confirmDialog(game, `Are you sure you want to delete "${s.name}"?`, 'Yes. Totally. Delete it.'))) return;
        await deleteSkin(s.id);
      },
      { dangerous: true },
    );
    const editable = !!current();
    for (const b of [rename, exportButton, del]) (b.el.querySelector('button') as HTMLButtonElement).disabled = !editable;
    const buttons = h('div', { class: 'st-skin-buttons' }, rename.el, exportButton.el, del.el);
    const editor = button('Skin layout editor', () => {}, { unavailable: true });
    host.replaceChildren(dd.el, buttons, editor.el);
  };
  const refresh = async () => {
    try {
      skins = await listSkins();
    } catch {
      skins = [];
    }
    render();
  };
  void refresh();
  SkinStore.subscribe(() => void refresh());
  settings.subscribe(k => {
    if (k === ACTIVE_SKIN_SETTING && host.isConnected) render();
  });
  render();
  return {
    header: 'Skin',
    icon: svgIcon(SETTINGS_ICONS.skin),
    keywords: ['skins'],
    items: [customItem(host, ['Current skin', 'Rename selected skin', 'Export selected skin', 'Delete selected skin', 'Skin layout editor', 'skins'])],
    subsections: [],
  };
}

// ------------------------------------------------------------------ all sections

/** MouseSettings: the sensitivity slider only applies (and is only enabled) in high precision mode. */
function sensitivityItem(): SettingsItem {
  const b = bindSetting<number>('input.sensitivity');
  b.disabled = () => !settings.get('input.highPrecision', false);
  return settingsItem(formSliderBar('Cursor sensitivity', b, { min: 0.1, max: 6, precision: 0.01, keyboardStep: 0.01, labelFormat: v => `${v.toFixed(2)}x` }), { keywords: ['speed', 'velocity'] });
}

export function buildSections(game: Game, openKeyBindings: () => void): SectionDef[] {
  const fullscreen = bindValue<string>(
    () => (document.fullscreenElement ? 'fullscreen' : 'windowed'),
    v => {
      if (v === 'fullscreen') void document.documentElement.requestFullscreen?.().catch(() => game.toast('Fullscreen is blocked here.', 'error'));
      else if (document.fullscreenElement) void document.exitFullscreen();
    },
    'windowed',
  );
  const canFullscreen = typeof document.documentElement.requestFullscreen === 'function' && document.fullscreenEnabled !== false;

  const general: SectionDef = {
    header: 'General',
    icon: svgIcon(SETTINGS_ICONS.general),
    subsections: [
      {
        header: 'Quick Actions',
        items: [
          button('Run setup wizard', () => {}, { unavailable: true }),
          button('Learn more about osu!lazer', () => openLink(game, 'https://github.com/ppy/osu'), { tooltip: `${APP_NAME} is a browser port of the open-source osu!lazer.` }),
          button('Report an issue', () => openLink(game, 'https://github.com/iloverhythia/osu/issues')),
          button('Export logs', () => {}, { unavailable: true }),
        ],
      },
      {
        header: 'Language',
        items: [
          dropdown('Language', 'ui.language', [['en', 'English']] as const),
          check('Prefer metadata in original language', 'ui.preferUnicode'),
          check('Prefer 24-hour time display', 'ui.prefer24h'),
        ],
      },
    ],
  };

  const input: SectionDef = {
    header: 'Input',
    icon: svgIcon(SETTINGS_ICONS.input),
    subsections: [
      { header: 'Shortcuts and gameplay bindings', items: [button('Configure', openKeyBindings, { tooltip: 'change global shortcut keys and gameplay bindings', keywords: ['keybindings', 'controls', 'keyboard', 'keys'] })] },
      {
        header: 'Mouse',
        items: [
          check('High precision mouse', 'input.highPrecision', { hint: 'Attempts to bypass any operating system mouse acceleration. On Windows, this is equivalent to what used to be known as "Raw Input".', keywords: ['raw', 'input', 'relative', 'cursor'] }),
          sensitivityItem(),
          dropdown('Confine mouse cursor to window', 'input.confine', [['never', 'Never'], ['duringGameplay', 'During Gameplay'], ['always', 'Always']] as const, { unavailable: true }),
          check('Disable mouse wheel adjusting volume during gameplay', 'input.mouseDisableWheel', { hint: 'Volume can still be adjusted using the mouse wheel by holding "Alt"' }),
          check('Disable clicks during gameplay', 'gameplay.disableMouseButtons'),
        ],
      },
      { header: 'Touch', items: [check('Disable taps during gameplay', 'input.touchDisableTaps')] },
    ],
  };

  const userInterface: SectionDef = {
    header: 'User Interface',
    icon: svgIcon(SETTINGS_ICONS.userInterface),
    subsections: [
      {
        header: 'General',
        items: [
          check('Rotate cursor when dragging', 'ui.cursorRotation', { unavailable: true }),
          slider('Menu cursor size', 'ui.menuCursorSize', 0.5, 2, 0.01, { keyboardStep: 0.01, format: v => `${v.toFixed(2)}x`, unavailable: true }),
          slider('Parallax', 'ui.parallax', 0, 2, 0.1, { percent: true }),
          slider('Hold-to-confirm activation time', 'ui.holdActivationDelay', 0, 500, 50, { keyboardStep: 50, format: v => `${v} ms`, keywords: ['delay'] }),
        ],
      },
      {
        header: 'Main Menu',
        items: [
          check('Menu tips', 'ui.menuTips'),
          check('Interface voices', 'ui.menuVoice', { unavailable: true }),
          check(`${APP_NAME} music theme`, 'ui.menuMusic', { unavailable: true }),
          dropdown('Intro sequence', 'ui.introSequence', [['circles', 'Circles'], ['welcome', 'Welcome'], ['triangles', 'Triangles'], ['random', 'Random']] as const, { unavailable: true }),
          dropdown('Background source', 'ui.menuBackgroundSource', [['skin', 'Skin'], ['beatmap', 'Beatmap'], ['beatmapWithStoryboard', 'Beatmap (with storyboard / video)']] as const, { unavailable: true }),
          dropdown('Seasonal backgrounds', 'ui.seasonalBackgrounds', [['always', 'Always'], ['never', 'Never'], ['sometimes', 'Sometimes']] as const, { unavailable: true }),
        ],
      },
      {
        header: 'Song Select',
        items: [
          check('Show converted beatmaps', 'select.showConverts', { keywords: ['convert', 'converted'] }),
          dropdown('Random selection algorithm', 'select.randomAlgorithm', [['permutation', 'Never repeat'], ['random', 'True Random']] as const),
          dropdown('Mod select hotkey style', 'ui.modSelectHotkeyStyle', [['sequential', 'Sequential'], ['classic', 'Classic']] as const, { hint: 'Sequential: Uses a sequence of letters to select mods. Classic: Uses osu!stable mod hotkeys.' }),
          check('Automatically focus search text box in mod select', 'ui.modSelectSearchAutofocus'),
          check('Background blur', 'select.backgroundBlur'),
        ],
      },
    ],
  };

  const gameplay: SectionDef = {
    header: 'Gameplay',
    icon: svgIcon(SETTINGS_ICONS.gameplay),
    subsections: [
      {
        header: 'General',
        items: [
          dropdown('Score display mode', 'gameplay.scoreDisplayMode', [['standardised', 'Standardised'], ['classic', 'Classic']] as const, { keywords: ['scoring'] }),
          check('Hit lighting', 'gameplay.hitLighting', { also: ['osu.hitLighting', 'fruits.hitLighting'] }),
          check('Star fountains', 'gameplay.starFountains'),
        ],
      },
      {
        header: 'Audio',
        items: [
          slider('Hitsound stereo separation', 'audio.positionalHitsoundsLevel', 0, 1, 0.01, { percent: true, keyboardStep: 0.01, also: ['fruits.positionalHitsoundsLevel'] }),
          check('Always play first combo break sound', 'gameplay.alwaysPlayFirstComboBreak'),
        ],
      },
      {
        header: 'Background',
        items: [
          slider('Background dim', 'gameplay.backgroundDim', 0, 1, 0.01, { percent: true, keyboardStep: 0.01 }),
          slider('Background blur', 'gameplay.backgroundBlur', 0, 1, 0.01, { percent: true, keyboardStep: 0.01 }),
          check('Lighten playfield during breaks', 'gameplay.lightenDuringBreaks'),
          check('Fade playfield to red when health is low', 'gameplay.fadePlayfieldWhenHealthLow'),
        ],
      },
      {
        header: 'Beatmap',
        items: [
          check('Beatmap skins', 'skin.beatmapSkins'),
          check('Beatmap colours', 'skin.beatmapColours'),
          check('Beatmap hitsounds', 'skin.beatmapHitsounds'),
          check('Storyboard / video', 'gameplay.storyboard'),
          slider('Combo colour normalisation', 'skin.comboColourNormalisation', 0, 1, 0.01, { percent: true }),
        ],
      },
      {
        header: 'HUD',
        items: [
          dropdown('HUD overlay visibility mode', 'gameplay.hudVisibilityMode', [['never', 'Never'], ['hideDuringGameplay', 'Hide during gameplay'], ['always', 'Always']] as const),
          check('Show replay settings overlay', 'gameplay.replaySettingsOverlay'),
          check('Always show key overlay', 'gameplay.showKeyCounter'),
          check('Always show gameplay leaderboard', 'gameplay.leaderboard'),
          check('Require holding key to pause gameplay', 'gameplay.alwaysRequireHoldForPause'),
          check('Always show hold for menu button', 'gameplay.alwaysShowHoldForMenu'),
          check("Show health display even when you can't fail", 'gameplay.showHealthDisplayWhenCantFail'),
        ],
      },
      {
        header: 'Input',
        items: [
          slider('Gameplay cursor size', 'osu.cursorSize', 0.1, 2, 0.01, { keyboardStep: 0.01, format: v => `${v.toFixed(2)}x` }),
          check('Adjust gameplay cursor size based on current beatmap', 'osu.autoCursorSize'),
          check('Show gameplay cursor during touch input', 'osu.cursorDuringTouch'),
        ],
      },
      { header: 'Mods', items: [check('Increase first object visibility on visual impairment mods', 'gameplay.increaseFirstObjectVisibility')] },
    ],
  };

  const rulesetSections: SectionDef[] = [];
  for (const r of availableRulesets()) {
    const name = RULESET_DISPLAY_NAMES[r.id] ?? r.name;
    let items: SettingsItem[] | null = null;
    if (r.id === 0) {
      items = [
        check('Snaking in sliders', 'osu.snakingIn'),
        check('Snaking out sliders', 'osu.snakingOut'),
        check('Hit animations', 'osu.hitAnimations', { hint: 'When enabled, hit circles will play an animation when hit. When disabled, they will disappear almost immediately.' }),
        check('Cursor trail', 'osu.cursorTrail'),
        check('Cursor ripples', 'osu.cursorRipples'),
        dropdown('Playfield border style', 'osu.playfieldBorderStyle', [['none', 'None'], ['corners', 'Corners'], ['full', 'Full']] as const),
      ];
    } else if (r.id === 1) {
      const hitAnimations = bindSetting<boolean>('taiko.hitAnimations');
      const rateAdjusted = bindSetting<boolean>('taiko.rateAdjustedHitAnimation');
      rateAdjusted.disabled = () => !hitAnimations.get();
      items = [
        dropdown('Touch control scheme', 'taiko.touchControlScheme', [['KDDK', 'KDDK'], ['DDKK', 'DDKK'], ['KKDD', 'KKDD']] as const),
        settingsItem(formCheckBox('Hit animations', hitAnimations, { hint: 'When enabled, hits will fly off the screen. When disabled, hits will disappear immediately.' })),
        settingsItem(formCheckBox('Rate-adjusted hit animations', rateAdjusted, { hint: 'Hits will fly faster or slower when beatmap rate is adjusted via mods.' })),
      ];
    } else if (r.id === 3) {
      // DrawableManiaRuleset.ComputeScrollTime: MAX_TIME_RANGE / speed
      const MAX_TIME_RANGE = 11485;
      items = [
        dropdown('Scrolling direction', 'mania.scrollDirection', [['down', 'Down'], ['up', 'Up']] as const),
        slider('Scroll speed', 'mania.scrollSpeed', 1, 40, 0.1, { keyboardStep: 1, format: v => `${Math.floor(MAX_TIME_RANGE / v)}ms (speed ${v.toFixed(1)})` }),
        check('Timing-based note colouring', 'mania.timingBasedColouring', { keywords: ['color'] }),
        check('Touch overlay', 'mania.touchOverlay', { unavailable: true }),
      ];
    }
    // RulesetSection only exists for rulesets that create settings (osu!catch has none).
    if (items) rulesetSections.push({ header: name, icon: () => rulesetIcon(r.id, 20), small: true, subsections: [{ header: '', items }] });
  }

  const audio: SectionDef = {
    header: 'Audio',
    icon: svgIcon(SETTINGS_ICONS.audio),
    keywords: ['sound'],
    subsections: [
      { header: 'Devices', items: [settingsItem(formDropdown('Output device', bindValue(() => 'default', () => {}, 'default'), [['default', 'Default']] as const, { unavailable: NA }), { unavailable: NA, keywords: ['speaker', 'headphone', 'output'] })] },
      {
        header: 'Volume',
        items: [
          slider('Master', 'audio.master', 0, 1, 0.01, { percent: true, keyboardStep: 0.01 }),
          slider('Master (window inactive)', 'audio.masterInactive', 0, 1, 0.01, { percent: true, keyboardStep: 0.01 }),
          slider('Music', 'audio.music', 0, 1, 0.01, { percent: true, keyboardStep: 0.01 }),
          slider('Effect', 'audio.effects', 0, 1, 0.01, { percent: true, keyboardStep: 0.01 }),
          slider('Hitsound', 'audio.hitsound', 0, 1, 0.01, { percent: true, keyboardStep: 0.01 }),
        ],
      },
      {
        header: 'Offset Adjustment',
        items: [
          slider('Audio offset', 'audio.offset', -500, 500, 1, { keyboardStep: 1, format: v => `${v.toFixed(0)} ms`, keywords: ['universal', 'uo', 'timing', 'delay', 'latency'] }),
          check('Compensate for output latency', 'audio.compensateLatency', { hint: 'Uses the audio output latency reported by the browser.' }),
          check('Adjust beatmap offset automatically', 'audio.autoAdjustOffset', { hint: 'If enabled, the offset suggested from last play on a beatmap is automatically applied.' }),
        ],
      },
    ],
  };

  const graphics: SectionDef = {
    header: 'Graphics',
    icon: svgIcon(SETTINGS_ICONS.graphics),
    subsections: [
      {
        header: 'Layout',
        items: [
          settingsItem(formDropdown('Screen mode', fullscreen, [['windowed', 'Windowed'], ['fullscreen', 'Fullscreen']] as const, { unavailable: canFullscreen ? undefined : NA }), { showRevert: false, unavailable: canFullscreen ? undefined : NA }),
          slider('UI scaling', 'graphics.uiScale', 0.8, 1.6, 0.01, { keyboardStep: 0.01, format: v => `${v.toFixed(2)}x`, keywords: ['scale', 'letterbox'], unavailable: true }),
        ],
      },
      {
        header: 'Renderer',
        items: [
          dropdown('Frame limiter', 'graphics.frameLimiter', [['vsync', 'VSync']] as const, { keywords: ['fps'] }),
          slider('Render resolution', 'graphics.renderScale', 0.5, 1, 0.05, { percent: true, hint: 'Lower this if gameplay stutters.', keywords: ['performance', 'lag', 'quality'] }),
          check('Show FPS', 'graphics.showFps', { keywords: ['framerate', 'counter'] }),
        ],
      },
      {
        header: 'Screenshots',
        items: [
          dropdown('Screenshot format', 'graphics.screenshotFormat', [['png', 'PNG (lossless)'], ['jpg', 'JPG (web-friendly)']] as const),
          check('Show menu cursor in screenshots', 'graphics.screenshotCursor', { unavailable: true }),
        ],
      },
    ],
  };

  const username = bindSetting<string>('ui.username');
  const online: SectionDef = {
    header: 'Online',
    icon: svgIcon(SETTINGS_ICONS.online),
    subsections: [
      { header: 'Player', items: [settingsItem(formTextBox('Player name', username, { placeholder: 'Guest', hint: 'Shown on your local scores and replays.' }), { keywords: ['username', 'name'] })] },
      {
        header: 'External content and downloads',
        items: [
          check('Warn before opening external links', 'online.externalLinkWarning', { unavailable: true }),
          check('Prefer downloads without video', 'online.preferNoVideo', { unavailable: true }),
          check('Automatically download missing beatmaps', 'online.autoDownload', { unavailable: true }),
          check('Show explicit content in search results', 'online.explicitContent', { unavailable: true }),
          check('Hide all country flags', 'online.hideFlags', { unavailable: true }),
        ],
      },
      {
        header: 'Alerts and Privacy',
        items: [
          check('Show a notification when someone mentions your name', 'online.notifyMention', { unavailable: true }),
          check('Show a notification when you receive a private message', 'online.notifyPM', { unavailable: true }),
          check('Show notification popups when friends change status', 'online.notifyFriends', { hint: 'Notifications will be shown when friends go online/offline.', unavailable: true }),
          check('Only allow messages from friends', 'online.pmFriendsOnly', { unavailable: true }),
        ],
      },
    ],
  };

  const deleteAllBeatmaps = async () => {
    if (!(await confirmDialog(game, 'Are you sure you want to delete all beatmaps?', 'Yes. Go for it.'))) return;
    const sets = game.library.sets.filter(s => !s.builtIn);
    for (const s of sets) await game.library.remove(s.id);
    game.toast(`Deleted ${sets.length} beatmap set${sets.length === 1 ? '' : 's'}`, 'success');
  };
  const deleteAllScores = async () => {
    if (!(await confirmDialog(game, 'Are you sure you want to delete all scores?', 'Yes. Go for it.'))) return;
    const scores = await Database.getAllScores();
    for (const s of scores) if (s.id != null) await Database.deleteScore(s.id);
    game.toast(`Deleted ${scores.length} score${scores.length === 1 ? '' : 's'}`, 'success');
  };
  const deleteAllSkins = async () => {
    if (!(await confirmDialog(game, 'Are you sure you want to delete all skins?', 'Yes. Go for it.'))) return;
    const skins = await listSkins();
    for (const s of skins) await deleteSkin(s.id);
    settings.set(ACTIVE_SKIN_SETTING, null);
    game.toast(`Deleted ${skins.length} skin${skins.length === 1 ? '' : 's'}`, 'success');
  };

  const maintenance: SectionDef = {
    header: 'Maintenance',
    icon: svgIcon(SETTINGS_ICONS.maintenance),
    keywords: ['maintenance', 'storage'],
    subsections: [
      { header: 'General', items: [button('Import files', () => game.openFilePicker()), button('Run latency certifier', () => {}, { unavailable: true })] },
      {
        header: 'Beatmaps',
        items: [
          button('Delete ALL beatmaps', () => void deleteAllBeatmaps(), { dangerous: true }),
          button('Delete ALL beatmap videos', () => {}, { dangerous: true, unavailable: true }),
          button(
            'Reset ALL beatmap offsets',
            async () => {
              if (!(await confirmDialog(game, 'Are you sure you want to reset all local beatmap offsets? This cannot be undone!', 'Yes. Go for it.'))) return;
              const n = settings.resetPrefix('offset.');
              game.toast(`Reset ${n} beatmap offset${n === 1 ? '' : 's'}`, 'success');
            },
            { dangerous: true },
          ),
          button('Restore all hidden difficulties', () => {}, { unavailable: true }),
          button('Restore all recently deleted beatmaps', () => {}, { unavailable: true }),
        ],
      },
      { header: 'Skins', items: [button('Delete ALL skins', () => void deleteAllSkins(), { dangerous: true })] },
      { header: 'Collections', items: [button('Delete ALL collections', () => {}, { dangerous: true, unavailable: true })] },
      { header: 'Scores', items: [button('Delete ALL scores', () => void deleteAllScores(), { dangerous: true })] },
      { header: 'Mod presets', items: [button('Delete ALL mod presets', () => {}, { dangerous: true, unavailable: true }), button('Restore all recently deleted mod presets', () => {}, { unavailable: true })] },
    ],
  };

  const debug: SectionDef = {
    header: 'Debug',
    icon: svgIcon(SETTINGS_ICONS.debug),
    subsections: [
      {
        header: 'Memory',
        items: [
          button('Clear all caches', () => {
            game.toast('Cleared all caches', 'success');
          }),
          dropdown('GC mode', 'debug.gcMode', [['sustainedLowLatency', 'SustainedLowLatency'], ['interactive', 'Interactive']] as const, { unavailable: true }),
          button('Compact realm', () => {}, { unavailable: true }),
          button('Block realm', () => {}, { unavailable: true }),
          button('Unblock realm', () => {}, { unavailable: true }),
        ],
      },
    ],
  };

  return [general, skinSection(game), input, userInterface, gameplay, ...rulesetSections, audio, graphics, online, maintenance, debug];
}

export { standardFormat };
