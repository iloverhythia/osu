// Port of osu.Game/Screens/Play/PlayerSettings (PlayerSettingsGroup / SettingsToolboxGroup, PlayerSliderBar,
// PlayerCheckbox, VisualSettings, AudioSettings + BeatmapOffsetControl, InputSettings, PlaybackSettings).

import './player-settings.css';
import { settings } from '../../framework/Settings';
import { h } from '../dom';

/** SettingsToolboxGroup: 270 wide, header 30, collapsible, background fades to 0.1 when the mouse is elsewhere. */
export function playerSettingsGroup(title: string, ...children: HTMLElement[]): HTMLElement {
  const content = h('div', { class: 'ps-content' }, ...children);
  const button = h('button', { class: 'ps-expand', title: 'Collapse / expand' }, h('span'), h('span'), h('span'));
  const header = h('div', { class: 'ps-header' }, h('div', { class: 'ps-title' }, title), button);
  const el = h('div', { class: 'ps-group' }, h('div', { class: 'ps-bg' }), header, content);
  let expanded = true;
  button.addEventListener('click', () => {
    expanded = !expanded;
    el.classList.toggle('collapsed', !expanded);
  });
  return el;
}

interface SliderOpts {
  min: number;
  max: number;
  step: number;
  percent?: boolean;
  format?: (v: number) => string;
  onChange?: (v: number) => void;
}

/** PlayerSliderBar: label + value above an OsuSliderBar. Bound to a setting key, or to get/set functions. */
export function playerSlider(label: string, bind: string | { get: () => number; set: (v: number) => void }, o: SliderOpts): HTMLElement {
  const get = typeof bind === 'string' ? () => settings.get<number>(bind, 0) : bind.get;
  const set = typeof bind === 'string' ? (v: number) => settings.set(bind, v) : bind.set;
  const fmt = o.format ?? (v => (o.percent ? `${Math.round(v * 100)}%` : String(+v.toFixed(2))));
  const value = h('span', { class: 'ps-value' });
  const input = h('input', { class: 'ps-range', type: 'range', min: String(o.min), max: String(o.max), step: String(o.step) }) as HTMLInputElement;
  const sync = () => {
    const v = get();
    input.value = String(v);
    value.textContent = fmt(v);
    input.style.setProperty('--p', `${((v - o.min) / (o.max - o.min)) * 100}%`);
  };
  input.addEventListener('input', () => {
    const v = Number(input.value);
    set(v);
    o.onChange?.(v);
    sync();
  });
  input.addEventListener('keydown', e => e.stopPropagation());
  sync();
  const el = h('div', { class: 'ps-slider' }, h('div', { class: 'ps-label-row' }, h('span', null, label), value), input);
  (el as HTMLElement & { sync?: () => void }).sync = sync;
  return el;
}

/** PlayerCheckbox (OsuCheckbox with a nub). */
export function playerCheckbox(label: string, key: string, def = true): HTMLElement {
  const nub = h('span', { class: 'ps-nub' });
  const el = h('button', { class: 'ps-checkbox' }, h('span', null, label), nub);
  const sync = () => el.classList.toggle('on', settings.get<boolean>(key, def));
  el.addEventListener('click', () => {
    settings.set(key, !settings.get<boolean>(key, def));
    sync();
  });
  sync();
  return el;
}

/** VisualSettings */
export function visualSettings(): HTMLElement {
  return playerSettingsGroup(
    'Visual Settings',
    playerSlider('Background dim', 'gameplay.backgroundDim', { min: 0, max: 1, step: 0.01, percent: true }),
    playerSlider('Background blur', 'gameplay.backgroundBlur', { min: 0, max: 1, step: 0.01, percent: true }),
    playerCheckbox('Storyboard / video', 'gameplay.storyboard'),
    playerCheckbox('Beatmap skins', 'skin.beatmapSkins'),
    playerCheckbox('Beatmap colours', 'skin.beatmapColours'),
    playerSlider('Combo colour normalisation', 'skin.comboColourNormalisation', { min: 0, max: 1, step: 0.01, percent: true }),
  );
}

// ------------------------------------------------------------------ beatmap offset

/** BeatmapUserSettings.Offset, stored per beatmap set + audio file (lazer applies it to every difficulty sharing the audio). */
export const beatmapOffsetKey = (setId: string, audioFile: string) => `offset.${setId}.${audioFile.toLowerCase()}`;

export function getBeatmapOffset(setId: string, audioFile: string): number {
  return settings.get<number>(beatmapOffsetKey(setId, audioFile), 0);
}

/** BeatmapOffsetControl.computeSuggestedOffset */
export function computeSuggestedOffset(median: number, unstableRate: number, currentOffset: number): number {
  const URAdjustmentCutoff = 90;
  const exponentialFactor = -0.0116;
  let adjustment = median;
  if (unstableRate >= URAdjustmentCutoff) adjustment *= Math.exp(exponentialFactor * (unstableRate - URAdjustmentCutoff));
  return currentOffset - adjustment;
}

/** BeatmapOffsetControl.GetOffsetExplanatoryText */
export function offsetExplanatoryText(offset: number): string {
  const f = String(+offset.toFixed(1));
  if (f === '0') return `${f} ms`;
  return `${f} ms ${offset > 0 ? '(hit objects appear earlier)' : '(hit objects appear later)'}`;
}

export interface ReferencePlay {
  setId: string;
  audioFile: string;
  /** Hit errors (ms) of the timed hit events of the last play. */
  hitErrors: number[];
  offsetAtPlay: number;
  applied?: boolean;
}

/** SessionStatics.LastLocalUserScore (just what the offset control needs). */
export const lastLocalPlay: { value: ReferencePlay | null } = { value: null };

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** HitEventExtensions.CalculateUnstableRate: 10 × standard deviation of the hit errors. */
function unstableRate(values: number[]): number {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / values.length;
  return 10 * Math.sqrt(variance);
}

/** AudioSettings: beatmap hitsounds, hitsound volume and the BeatmapOffsetControl. */
export function audioSettings(setId: string, audioFile: string, onOffsetChanged: (offset: number) => void): HTMLElement {
  const key = beatmapOffsetKey(setId, audioFile);
  const offset = playerSlider(
    'Audio offset (this beatmap)',
    { get: () => settings.get<number>(key, 0), set: v => settings.set(key, Math.round(v * 10) / 10) },
    { min: -50, max: 50, step: 0.1, format: offsetExplanatoryText, onChange: v => onOffsetChanged(v) },
  ) as HTMLElement & { sync?: () => void };
  const reference = h('div', { class: 'ps-reference' });
  const play = lastLocalPlay.value;
  if (play && play.setId === setId && play.audioFile.toLowerCase() === audioFile.toLowerCase()) {
    reference.append(h('div', null, 'Previous play:'));
    if (play.hitErrors.length < 50) reference.append(h('div', { class: 'ps-warning' }, 'Previous play too short to use for calibration'));
    else {
      const med = median(play.hitErrors);
      const ur = unstableRate(play.hitErrors);
      reference.append(h('div', { class: 'ps-hint' }, `Average hit error: ${Math.abs(med).toFixed(2)} ms ${med < 0 ? 'early' : 'late'}`));
      const apply = () => {
        // The last play's hit errors are relative to the offset in use at the time of that play.
        const target = Math.round(computeSuggestedOffset(med, ur, play.offsetAtPlay) * 10) / 10;
        settings.set(key, Math.max(-50, Math.min(50, target)));
        offset.sync?.();
        onOffsetChanged(settings.get<number>(key, 0));
        play.applied = true;
      };
      if (settings.get('audio.autoAdjustOffset', true) && !play.applied) {
        apply();
        reference.append(h('div', { class: 'ps-hint' }, `Beatmap offset was adjusted to ${String(+settings.get<number>(key, 0).toFixed(1))} ms.`));
      } else {
        const b = h('button', { class: 'ps-button' }, 'Calibrate using last play');
        b.addEventListener('click', apply);
        reference.append(b);
      }
    }
  }
  return playerSettingsGroup(
    'Audio Settings',
    playerCheckbox('Beatmap hitsounds', 'skin.beatmapHitsounds'),
    playerSlider('Hitsound volume', 'audio.hitsound', { min: 0, max: 1, step: 0.01, percent: true }),
    offset,
    reference,
  );
}

/** InputSettings */
export function inputSettings(): HTMLElement {
  return playerSettingsGroup('Input Settings', playerCheckbox('Disable clicks during gameplay', 'gameplay.disableMouseButtons', false));
}

/** PlaybackSettings (pause / play and the user playback rate). */
export function playbackSettings(o: { isPaused: () => boolean; togglePause: () => void; setRate: (r: number) => void }): HTMLElement {
  let rate = 1;
  const pause = h('button', { class: 'ps-play' });
  const syncPause = () => (pause.textContent = o.isPaused() ? '▶' : '❚❚');
  pause.addEventListener('click', () => {
    o.togglePause();
    syncPause();
  });
  syncPause();
  const el = playerSettingsGroup(
    'Playback',
    h('div', { class: 'ps-controls' }, pause),
    playerSlider(
      'Playback speed',
      { get: () => rate, set: v => (rate = v) },
      { min: 0.05, max: 2, step: 0.01, format: v => `${v.toFixed(2)}x`, onChange: v => o.setRate(v) },
    ),
  );
  (el as HTMLElement & { syncPause?: () => void }).syncPause = syncPause;
  return el;
}
