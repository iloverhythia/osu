// Port of osu.Game/Overlays/FirstRunSetupOverlay.cs (WizardOverlay) and its screens: ScreenWelcome, ScreenUIScale,
// ScreenBehaviour ("New defaults" / "Classic defaults" for every setting with a classic default), ScreenBeatmaps and
// ScreenImportFromStable. Shown once after the intro (OsuSetting.ShowFirstRunSetup) and from Settings → Run setup wizard.
// The online-only parts (downloading the tutorial / bundled beatmaps) are replaced by importing files here.

import './firstrun.css';
import './settings/settings.css';
import { APP_NAME } from '../../brand';
import { settings } from '../../framework/Settings';
import { h } from '../dom';
import type { Game } from '../Game';
import { applyColours } from './settings/SettingsOverlay';
import { bindSetting, formSliderBar } from './settings/controls';

/** Settings with ApplyClassicDefault in lazer, and their classic values. */
const CLASSIC_DEFAULTS: [string, unknown][] = [
  ['gameplay.alwaysPlayFirstComboBreak', false],
  ['gameplay.scoreDisplayMode', 'classic'],
  ['gameplay.showHealthDisplayWhenCantFail', false],
  ['ui.holdActivationDelay', 0],
  ['ui.modSelectHotkeyStyle', 'classic'],
  ['ui.modSelectSearchAutofocus', false],
  ['osu.snakingOut', false],
  ['taiko.rateAdjustedHitAnimation', false],
];

const SETTING_NAMES: Record<string, string> = {
  'gameplay.alwaysPlayFirstComboBreak': 'Always play first combo break sound',
  'gameplay.scoreDisplayMode': 'Score display mode',
  'gameplay.showHealthDisplayWhenCantFail': 'Show health display even when you can\'t fail',
  'ui.holdActivationDelay': 'Hold-to-confirm activation time',
  'ui.modSelectHotkeyStyle': 'Mod select hotkey style',
  'ui.modSelectSearchAutofocus': 'Automatically focus search text box in mod select',
  'osu.snakingOut': 'Snaking out sliders',
  'taiko.rateAdjustedHitAnimation': 'Rate-adjusted hit animations',
};

interface Step {
  title: string;
  render: () => HTMLElement;
}

let open: HTMLElement | null = null;

export function openFirstRunSetup(game: Game): void {
  if (open) return;
  const steps: Step[] = [
    {
      title: 'Welcome',
      render: () =>
        h(
          'div',
          { class: 'fr-text' },
          h('p', null, 'Welcome to the first-run setup guide!'),
          h('p', null, `${APP_NAME} is a very configurable game, and diving straight into the settings can sometimes be overwhelming. This guide will help you get the important choices out of the way to ensure a great first experience!`),
        ),
    },
    {
      title: 'UI Scaling',
      render: () => {
        const root = h('div', { class: 'st-root fr-st' });
        applyColours(root);
        root.append(formSliderBar('UI scaling', bindSetting<number>('graphics.uiScale'), { min: 0.8, max: 1.6, precision: 0.01, labelFormat: v => `${v.toFixed(2)}x` }).el);
        // ScreenUIScale's preview of song select at the chosen scale.
        const preview = h('div', { class: 'fr-scale-preview' }, h('div', { class: 'fr-scale-inner' }, h('div', { class: 'fr-mock-wedge' }), h('div', { class: 'fr-mock-panels' }, ...Array.from({ length: 5 }, () => h('div', { class: 'fr-mock-panel' }))), h('div', { class: 'fr-mock-footer' })));
        const apply = () => ((preview.firstChild as HTMLElement).style.transform = `scale(${settings.get<number>('graphics.uiScale', 1)})`);
        apply();
        const unsub = settings.subscribe(k => {
          if (!root.isConnected) return unsub();
          if (k === 'graphics.uiScale') apply();
        });
        return h('div', null, h('p', { class: 'fr-text' }, `The size of the ${APP_NAME} user interface can be adjusted to your liking.`), root, preview);
      },
    },
    {
      title: 'Behaviour',
      render: () => {
        const list = h('div', { class: 'fr-classic-list' });
        const renderList = () =>
          list.replaceChildren(
            ...CLASSIC_DEFAULTS.map(([key]) => {
              const v = settings.get<unknown>(key, null);
              return h('div', { class: 'fr-classic-row' }, h('span', null, SETTING_NAMES[key] ?? key), h('span', { class: 'fr-classic-value' }, typeof v === 'boolean' ? (v ? 'On' : 'Off') : String(v)));
            }),
          );
        renderList();
        return h(
          'div',
          null,
          h(
            'div',
            { class: 'fr-text' },
            h('p', null, 'Some new defaults for game behaviours have been implemented, with the aim of improving the game experience and making it more accessible to everyone.'),
            h('p', null, 'We recommend you give the new defaults a try, but if you\'d like to have things feel more like classic versions of osu!, you can easily apply some sane defaults below.'),
          ),
          h(
            'div',
            { class: 'fr-two-buttons' },
            h(
              'button',
              {
                class: 'fr-button',
                onclick: () => {
                  for (const [key] of CLASSIC_DEFAULTS) settings.reset?.(key);
                  renderList();
                },
              },
              'New defaults',
            ),
            h(
              'button',
              {
                class: 'fr-button',
                onclick: () => {
                  for (const [key, value] of CLASSIC_DEFAULTS) settings.set(key, value);
                  renderList();
                },
              },
              'Classic defaults',
            ),
          ),
          list,
        );
      },
    },
    {
      title: 'Obtaining Beatmaps',
      render: () =>
        h(
          'div',
          { class: 'fr-text' },
          h('p', null, `"Beatmaps" are what we call sets of playable levels. ${APP_NAME} comes with a generated demo beatmap; this step will help you get started on your beatmap collection.`),
          h('p', null, 'Import beatmaps (.osz), skins (.osk) and replays (.osr) from your computer, or drop them anywhere on the game window at any time.'),
          h('div', { class: 'fr-two-buttons' }, h('button', { class: 'fr-button primary', onclick: () => game.openFilePicker() }, 'Import files'), h('button', { class: 'fr-button', onclick: () => game.openFolderPicker() }, 'Import a folder')),
          h('p', { class: 'fr-note' }, `You can also generate a beatmap for any song from the main menu: edit → generator. Currently ${game.library.sets.length} beatmap set${game.library.sets.length === 1 ? '' : 's'} loaded.`),
        ),
    },
    {
      title: 'Import from stable',
      render: () =>
        h(
          'div',
          { class: 'fr-text' },
          h('p', null, 'If you have an installation of a previous osu! version, you can choose to migrate your existing content. Choose your osu!stable "Songs" folder (or any folder of beatmaps) to import everything in it.'),
          h('div', { class: 'fr-two-buttons' }, h('button', { class: 'fr-button primary', onclick: () => game.openFolderPicker() }, 'Import content from previous version')),
          h('p', { class: 'fr-note' }, 'Your files stay where they are; the beatmaps are copied into this browser.'),
        ),
    },
  ];

  let index = 0;
  const stepTitle = h('div', { class: 'fr-step-title' });
  const content = h('div', { class: 'fr-content' });
  const back = h('button', { class: 'fr-nav back' }, 'Back');
  const next = h('button', { class: 'fr-nav next' });
  const progress = h('div', { class: 'fr-progress' });

  const close = (completed: boolean) => {
    // OsuSetting.ShowFirstRunSetup is cleared once the wizard has been completed (or dismissed).
    if (completed || index > 0) settings.set('ui.showFirstRunSetup', false);
    open = null;
    game.closeOverlay(el);
  };
  const show = () => {
    const s = steps[index];
    stepTitle.textContent = s.title;
    content.replaceChildren(s.render());
    back.style.visibility = index === 0 ? 'hidden' : 'visible';
    next.textContent = index === 0 ? 'Get started' : index === steps.length - 1 ? 'Finish' : `Next (${steps[index + 1].title})`;
    progress.replaceChildren(...steps.map((_, i) => h('span', { class: `fr-dot${i === index ? ' active' : i < index ? ' done' : ''}` })));
  };
  back.addEventListener('click', () => {
    if (index > 0) {
      index--;
      show();
    }
  });
  next.addEventListener('click', () => {
    if (index === steps.length - 1) close(true);
    else {
      index++;
      show();
    }
  });

  const panel = h(
    'div',
    { class: 'fr-panel' },
    h('div', { class: 'fr-header' }, h('div', { class: 'fr-header-title' }, h('b', null, 'first-run setup')), h('div', { class: 'fr-header-desc' }, `Set up ${APP_NAME} to suit you`), h('button', { class: 'fr-close', title: 'Close', onclick: () => close(false) }, '✕')),
    h('div', { class: 'fr-body' }, stepTitle, content),
    h('div', { class: 'fr-footer' }, back, progress, next),
  );
  const el = h('div', { class: 'overlay fr-overlay' }, panel);
  open = el;
  applyColours(panel);
  show();
  game.openOverlay(el, {
    capture: true,
    onClose: () => (open = null),
    onKey: e => {
      if (e.code === 'Escape') {
        close(false);
        return true;
      }
      if (e.code === 'Enter') {
        next.click();
        return true;
      }
      return false;
    },
  });
}
