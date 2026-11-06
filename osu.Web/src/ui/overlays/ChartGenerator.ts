// Chart generator overlay: pick a game mode and a star rating, then either a song file or a generated song,
// and get a playable beatmap added to the library.

import './generator.css';
import { APP_NAME, RULESET_DISPLAY_NAMES } from '../../brand';
import { LegacyBeatmapDecoder } from '../../game/beatmaps/LegacyBeatmapDecoder';
import { analyseAudio, decodeAudio } from '../../game/generator/AudioAnalysis';
import { renderGeneratedBackground } from '../../game/generator/Background';
import { difficultyName, generateChart, generateForStars, GeneratorMode } from '../../game/generator/ChartGenerator';
import type { RhythmGrid } from '../../game/generator/RhythmGrid';
import { SONG_STYLES, SongStyle, synthesizeSong } from '../../game/generator/SongSynth';
import { getRuleset } from '../../game/rulesets';
import { Database } from '../../game/storage/Database';
import { createSetFromFiles, mimeFor } from '../../game/storage/Importer';
import { h } from '../dom';
import type { Game } from '../Game';
import { css, forStarDifficulty, forStarDifficultyText } from '../select/Colours';
import { rulesetIcon } from '../select/Icons';

interface GeneratorState {
  mode: GeneratorMode;
  stars: number;
  keys: number;
  source: 'generate' | 'file';
  style: SongStyle;
  bpm: number;
  length: number;
  seed: number;
}

const STORAGE_KEY = 'jarvsu.generator';

function loadState(defaultMode: GeneratorMode): GeneratorState {
  const base: GeneratorState = { mode: defaultMode, stars: 3, keys: 4, source: 'generate', style: 'pop', bpm: 128, length: 120, seed: newSeed() };
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (saved && typeof saved === 'object') return { ...base, ...saved, mode: defaultMode, seed: newSeed() };
  } catch {
    /* no storage */
  }
  return base;
}

function saveState(s: GeneratorState): void {
  try {
    const { seed: _seed, ...rest } = s;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rest));
  } catch {
    /* no storage */
  }
}

const newSeed = () => Math.floor(Math.random() * 2 ** 31);

/** Splits "Artist - Title.mp3" style names. */
function metadataFromFilename(name: string): { artist: string; title: string } {
  const base = name.replace(/\.[^.]+$/, '').replace(/_/g, ' ').trim();
  const dash = base.indexOf(' - ');
  if (dash > 0) return { artist: base.slice(0, dash).trim(), title: base.slice(dash + 3).trim() };
  return { artist: 'Unknown Artist', title: base || 'Untitled' };
}

const safeFilename = (s: string) => s.replace(/[\\/:*?"<>|]/g, '').trim() || 'Untitled';

export function openChartGenerator(game: Game, opts: { onPlay?: () => void } = {}): void {
  const state = loadState(Math.min(3, Math.max(0, game.ruleset.id)) as GeneratorMode);
  let file: File | null = null;
  let busy = false;
  let cancelled = false;

  const titleInput = h('input', { class: 'cg-text', type: 'text', placeholder: 'Title', maxLength: 80 }) as HTMLInputElement;
  const artistInput = h('input', { class: 'cg-text', type: 'text', placeholder: 'Artist', maxLength: 80 }) as HTMLInputElement;
  let titleEdited = false;
  let artistEdited = false;
  titleInput.addEventListener('input', () => (titleEdited = true));
  artistInput.addEventListener('input', () => (artistEdited = true));

  // ------------------------------------------------------------- mode
  const modeRow = h('div', { class: 'cg-modes' });
  const keysRow = h('div', { class: 'cg-chips' });
  const keysBlock = h('div', { class: 'cg-field' }, h('div', { class: 'cg-label' }, 'Keys'), keysRow);
  const renderModes = () => {
    modeRow.replaceChildren(
      ...([0, 1, 2, 3] as GeneratorMode[]).map(m =>
        h(
          'button',
          {
            class: `cg-mode${state.mode === m ? ' active' : ''}`,
            onclick: () => {
              state.mode = m;
              renderAll();
            },
          },
          rulesetIcon(m, 26),
          h('span', null, RULESET_DISPLAY_NAMES[m]),
        ),
      ),
    );
    keysRow.replaceChildren(
      ...[4, 5, 6, 7, 8].map(k =>
        h(
          'button',
          {
            class: `cg-chip${state.keys === k ? ' active' : ''}`,
            onclick: () => {
              state.keys = k;
              renderAll();
            },
          },
          `${k}K`,
        ),
      ),
    );
    keysBlock.style.display = state.mode === 3 ? '' : 'none';
  };

  // ------------------------------------------------------------- difficulty
  const starPill = h('div', { class: 'cg-star-pill' });
  const starSlider = h('input', { class: 'cg-range', type: 'range', min: '1', max: '8', step: '0.1' }) as HTMLInputElement;
  starSlider.addEventListener('input', () => {
    state.stars = Number(starSlider.value);
    renderStars();
  });
  const presets = h('div', { class: 'cg-chips' });
  const PRESETS: [string, number][] = [
    ['Easy', 1.5],
    ['Normal', 2.3],
    ['Hard', 3.3],
    ['Insane', 4.6],
    ['Expert', 5.8],
    ['Expert+', 7],
  ];
  const renderStars = () => {
    starSlider.value = String(state.stars);
    const bg = forStarDifficulty(state.stars);
    starPill.style.background = css(bg);
    starPill.style.color = css(forStarDifficultyText(state.stars));
    starPill.textContent = `★ ${state.stars.toFixed(1)}  ·  ${difficultyName(state.stars)}`;
    presets.replaceChildren(
      ...PRESETS.map(([name, s]) =>
        h(
          'button',
          {
            class: `cg-chip${difficultyName(state.stars) === name ? ' active' : ''}`,
            onclick: () => {
              state.stars = s;
              renderStars();
            },
          },
          name,
        ),
      ),
    );
    renderHint();
  };

  // ------------------------------------------------------------- song
  const sourceRow = h('div', { class: 'cg-segment' });
  const generateBlock = h('div', { class: 'cg-source-block' });
  const fileBlock = h('div', { class: 'cg-source-block' });
  const styleRow = h('div', { class: 'cg-chips' });
  const bpmSlider = h('input', { class: 'cg-range', type: 'range', min: '70', max: '200', step: '1' }) as HTMLInputElement;
  const bpmValue = h('span', { class: 'cg-value' });
  const lengthSlider = h('input', { class: 'cg-range', type: 'range', min: '45', max: '240', step: '15' }) as HTMLInputElement;
  const lengthValue = h('span', { class: 'cg-value' });
  const seedValue = h('span', { class: 'cg-value' });
  bpmSlider.addEventListener('input', () => {
    state.bpm = Number(bpmSlider.value);
    renderSong();
  });
  lengthSlider.addEventListener('input', () => {
    state.length = Number(lengthSlider.value);
    renderSong();
  });
  const fileInput = h('input', { type: 'file', accept: 'audio/*,.mp3,.ogg,.wav,.flac,.m4a,.aac,.opus,.webm', style: { display: 'none' } }) as HTMLInputElement;
  const fileName = h('div', { class: 'cg-file-name' });
  fileInput.addEventListener('change', () => {
    file = fileInput.files?.[0] ?? null;
    if (file) {
      const m = metadataFromFilename(file.name);
      if (!titleEdited) titleInput.value = m.title;
      if (!artistEdited) artistInput.value = m.artist;
    }
    renderSong();
  });
  generateBlock.append(
    h('div', { class: 'cg-field' }, h('div', { class: 'cg-label' }, 'Style'), styleRow),
    h('div', { class: 'cg-field' }, h('div', { class: 'cg-label' }, 'BPM ', bpmValue), bpmSlider),
    h('div', { class: 'cg-field' }, h('div', { class: 'cg-label' }, 'Length ', lengthValue), lengthSlider),
    h(
      'div',
      { class: 'cg-field cg-inline' },
      h('div', { class: 'cg-label' }, 'Seed ', seedValue),
      h(
        'button',
        {
          class: 'cg-chip',
          title: 'Roll a different song',
          onclick: () => {
            state.seed = newSeed();
            if (!titleEdited) titleInput.value = '';
            renderSong();
          },
        },
        '🎲 New song',
      ),
    ),
  );
  fileBlock.append(
    h('button', { class: 'cg-file-button', onclick: () => fileInput.click() }, 'Choose audio file…'),
    fileName,
    h('div', { class: 'cg-note' }, 'MP3, OGG, WAV, FLAC, M4A… The tempo and beats are detected automatically. Songs with a steady tempo work best.'),
    fileInput,
  );
  const hint = h('div', { class: 'cg-note cg-hint' });
  const renderHint = () => {
    const bpm = state.source === 'generate' ? state.bpm : null;
    hint.textContent = bpm != null && state.stars >= 5.5 && bpm < 150 ? 'Tip: higher star ratings are easier to reach with faster songs (raise the BPM or pick Drum & Bass).' : '';
  };
  const renderSong = () => {
    sourceRow.replaceChildren(
      ...(
        [
          ['generate', 'Generate a song'],
          ['file', 'Use my own song'],
        ] as const
      ).map(([id, label]) =>
        h(
          'button',
          {
            class: `cg-seg${state.source === id ? ' active' : ''}`,
            onclick: () => {
              state.source = id;
              renderAll();
            },
          },
          label,
        ),
      ),
    );
    styleRow.replaceChildren(
      ...SONG_STYLES.map(s =>
        h(
          'button',
          {
            class: `cg-chip${state.style === s.id ? ' active' : ''}`,
            onclick: () => {
              state.style = s.id;
              state.bpm = Math.round((s.bpm[0] + s.bpm[1]) / 2);
              renderSong();
            },
          },
          s.name,
        ),
      ),
    );
    bpmSlider.value = String(state.bpm);
    bpmValue.textContent = String(state.bpm);
    lengthSlider.value = String(state.length);
    lengthValue.textContent = `${Math.floor(state.length / 60)}:${String(state.length % 60).padStart(2, '0')}`;
    seedValue.textContent = `#${state.seed.toString(36)}`;
    generateBlock.style.display = state.source === 'generate' ? '' : 'none';
    fileBlock.style.display = state.source === 'file' ? '' : 'none';
    fileName.textContent = file ? file.name : 'No file chosen';
    fileName.classList.toggle('empty', !file);
    if (state.source === 'generate' && !artistEdited) artistInput.value = `${APP_NAME} Synth`;
    titleInput.placeholder = state.source === 'generate' ? 'Title (leave empty for a random one)' : 'Title';
    renderHint();
  };

  // ------------------------------------------------------------- footer
  const status = h('div', { class: 'cg-status' });
  const bar = h('div', { class: 'cg-progress-fill' });
  const progress = h('div', { class: 'cg-progress' }, bar);
  const setProgress = (text: string, fraction: number | null) => {
    status.textContent = text;
    progress.style.visibility = fraction == null ? 'hidden' : 'visible';
    bar.style.width = `${Math.round((fraction ?? 0) * 100)}%`;
  };
  setProgress('', null);
  const cancelButton = h('button', { class: 'cg-button', onclick: () => close() }, 'Cancel');
  const generateButton = h('button', { class: 'cg-button primary', onclick: () => void run(false) }, 'Generate');
  const playButton = h('button', { class: 'cg-button primary', onclick: () => void run(true) }, 'Generate & play');

  const renderAll = () => {
    renderModes();
    renderStars();
    renderSong();
  };

  const panel = h(
    'div',
    { class: 'cg-panel', onclick: (e: MouseEvent) => e.stopPropagation() },
    h('div', { class: 'cg-header' }, h('div', { class: 'cg-title' }, 'chart generator'), h('div', { class: 'cg-subtitle' }, 'make a beatmap for any mode from your own song or a brand new one')),
    h(
      'div',
      { class: 'cg-body' },
      h('section', { class: 'cg-section' }, h('h3', null, 'Game mode'), modeRow, keysBlock),
      h('section', { class: 'cg-section' }, h('h3', null, 'Difficulty'), h('div', { class: 'cg-star-row' }, starPill), starSlider, presets),
      h('section', { class: 'cg-section' }, h('h3', null, 'Song'), sourceRow, generateBlock, fileBlock, hint),
      h('section', { class: 'cg-section' }, h('h3', null, 'Metadata'), h('div', { class: 'cg-meta' }, titleInput, artistInput)),
    ),
    h('div', { class: 'cg-footer' }, h('div', { class: 'cg-status-wrap' }, status, progress), cancelButton, generateButton, playButton),
  );
  const el = h('div', { class: 'overlay center cg-overlay', onclick: () => !busy && close() }, panel);

  function close(): void {
    if (busy) {
      cancelled = true;
      setProgress('Cancelling…', null);
      return;
    }
    saveState(state);
    game.closeOverlay(el);
  }

  const setBusy = (b: boolean) => {
    busy = b;
    generateButton.disabled = b;
    playButton.disabled = b;
    panel.classList.toggle('busy', b);
    cancelButton.textContent = b ? 'Stop' : 'Cancel';
  };

  const rate = (text: string) => game.starRater(LegacyBeatmapDecoder.decode(text));

  async function run(play: boolean): Promise<void> {
    if (busy) return;
    if (state.source === 'file' && !file) {
      fileInput.click();
      return;
    }
    cancelled = false;
    setBusy(true);
    saveState(state);
    try {
      const checkCancel = () => {
        if (cancelled) throw new Error('cancelled');
      };
      let grid: RhythmGrid;
      let audioName: string;
      let audio: Blob;
      let title = titleInput.value.trim();
      let artist = artistInput.value.trim();
      if (state.source === 'file') {
        const f = file!;
        setProgress('Decoding audio…', 0.02);
        await tick();
        const data = await f.arrayBuffer();
        const decoded = await decodeAudio(data);
        checkCancel();
        setProgress('Finding the beat…', 0.1);
        await tick();
        grid = analyseAudio(decoded);
        const ext = (f.name.match(/\.([a-z0-9]+)$/i)?.[1] ?? 'mp3').toLowerCase();
        audioName = `audio.${ext}`;
        audio = new Blob([data], { type: f.type || mimeFor(audioName) });
        const m = metadataFromFilename(f.name);
        title ||= m.title;
        artist ||= m.artist;
      } else {
        setProgress('Composing and rendering the song…', 0.02);
        await tick();
        const song = await synthesizeSong({ style: state.style, bpm: state.bpm, lengthSeconds: state.length, seed: state.seed }, f => setProgress('Composing and rendering the song…', 0.02 + f * 0.3));
        grid = song.grid;
        audio = song.wav;
        audioName = 'audio.wav';
        title ||= song.title;
        artist ||= `${APP_NAME} Synth`;
      }
      checkCancel();
      const bpmText = `${Math.round(grid.bpm * 100) / 100} BPM`;
      const mode = state.mode;
      const meta = {
        title,
        artist,
        creator: `${APP_NAME} Generator`,
        version: 'Generated',
        audioFile: audioName,
        backgroundFile: 'bg.jpg',
        source: '',
        tags: `generated ${APP_NAME.toLowerCase()} ${state.source === 'generate' ? state.style : ''}`.trim(),
      };
      const base = { mode, keys: state.keys, seed: state.seed, meta };
      const result = await generateForStars(grid, base, state.stars, rate, (n, total, stars) => {
        checkCancel();
        setProgress(`Building the chart (${bpmText}) — attempt ${n}/${total}: ${stars.toFixed(2)}★`, 0.35 + (n / total) * 0.55);
      });
      checkCancel();
      const version = `${mode === 3 ? `${state.keys}K ` : ''}${difficultyName(result.stars)}`;
      const text = generateChart(grid, { ...base, intensity: result.intensity, meta: { ...meta, version } });
      setProgress('Saving…', 0.95);
      const bg = await renderGeneratedBackground(state.seed);
      const files: Record<string, Blob> = { [audioName]: audio };
      if (bg) files['bg.jpg'] = bg;
      const osuName = `${safeFilename(artist)} - ${safeFilename(title)} (${APP_NAME} Generator) [${safeFilename(version)}].osu`;
      files[osuName] = new Blob([text], { type: 'text/plain' });
      const set = await createSetFromFiles(files, game.starRater);
      if (!set) throw new Error('the generated chart could not be read back');
      let stored = true;
      try {
        await Database.putSet(set);
      } catch {
        stored = false;
      }
      game.library.add([set]);
      if (game.ruleset.id !== mode) game.setRuleset(getRuleset(mode));
      game.select(set, set.beatmaps[0]);
      const stars = set.beatmaps[0].stars ?? result.stars;
      const off = Math.abs(stars - state.stars) > 0.4;
      game.toast(`Generated “${title}” [${version}] — ${stars.toFixed(2)}★, ${bpmText}${off ? ` (closest this song allows to ${state.stars.toFixed(1)}★)` : ''}`, 'success', 6000);
      if (!stored) game.toast('Browser storage is unavailable, so this beatmap will be gone after a reload.', 'error', 6000);
      setBusy(false);
      saveState(state);
      game.closeOverlay(el);
      if (play) opts.onPlay?.();
    } catch (e) {
      setBusy(false);
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === 'cancelled') setProgress('Stopped.', null);
      else {
        setProgress(`Couldn't generate: ${msg}`, null);
        game.toast(`Chart generation failed: ${msg}`, 'error', 6000);
      }
    }
  }

  renderAll();
  game.openOverlay(el, {
    onKey: e => {
      if (e.code === 'Escape') {
        close();
        return true;
      }
      // Let typing in the text fields through; swallow everything else so song select doesn't react.
      return !(e.target instanceof HTMLInputElement && e.target.type === 'text');
    },
  });
}

const tick = () => new Promise(r => setTimeout(r, 16));
