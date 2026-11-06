// Port of osu.Game/Screens/Edit/Setup/SetupScreen.cs and its sections (ResourcesSection, MetadataSection,
// DifficultySection, ColoursSection, DesignSection, RulesetSetupSection), built from the same Form* controls as the
// settings overlay. Every change is one undoable editor change.

import '../overlays/settings/settings.css';
import { mimeFor } from '../../game/storage/Importer';
import { h } from '../dom';
import { applyColours } from '../overlays/settings/SettingsOverlay';
import { bindValue, formCheckBox, formDropdown, formSliderBar, formTextBox, type FormControl } from '../overlays/settings/controls';
import type { EditorScreen } from './Editor';
import { comboColours } from './colours';

export class SetupScreen {
  readonly el: HTMLElement;
  private readonly controls: FormControl[] = [];
  private readonly body: HTMLElement;

  constructor(private readonly host: EditorScreen) {
    this.body = h('div', { class: 'ed-setup-sections' });
    this.el = h('div', { class: 'ed-setup st-root ed-st' }, this.header(), this.body);
    applyColours(this.el);
    this.render();
  }

  update(): void {
    for (const c of this.controls) c.update();
  }

  dispose(): void {}

  private get b() {
    return this.host.editor.beatmap;
  }

  /** Wraps a field setter in an editor change. */
  private bind<T>(get: () => T, set: (v: T) => void, def: T) {
    return bindValue<T>(get, v => this.host.editor.change(() => set(v)), def);
  }

  private add(c: FormControl): HTMLElement {
    this.controls.push(c);
    return c.el;
  }

  /** SetupScreenHeader: background preview with the title and description. */
  private header(): HTMLElement {
    const bg = h('div', { class: 'ed-setup-header-bg' });
    const url = this.host.set.files && this.b.metadata.backgroundFile ? this.fileUrl(this.b.metadata.backgroundFile) : null;
    if (url) bg.style.backgroundImage = `url("${url}")`;
    return h('div', { class: 'ed-setup-header' }, bg, h('div', { class: 'ed-setup-header-text' }, h('div', { class: 'ed-setup-title' }, 'beatmap setup'), h('div', { class: 'ed-setup-desc' }, 'change general settings of your beatmap')));
  }

  private fileUrl(name: string): string | null {
    const blob = Object.entries(this.host.set.files).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
    return blob ? URL.createObjectURL(blob) : null;
  }

  private section(title: string, children: (HTMLElement | null)[]): HTMLElement {
    return h('div', { class: 'ed-setup-section' }, h('div', { class: 'ed-setup-section-title' }, title), h('div', { class: 'ed-setup-section-body' }, ...children));
  }

  private render(): void {
    const b = this.b;
    const m = () => this.b.metadata;
    const d = () => this.b.difficulty;
    this.controls.length = 0;
    const rulesetId = b.rulesetId;

    // ------------------------------------------------------------ resources (FormBeatmapFileSelector)
    const fileRow = (label: string, accept: string, current: () => string, apply: (file: File) => void, hint: string) => {
      const name = h('div', { class: 'ed-file-name' }, current() || '(none)');
      const input = h('input', { type: 'file', accept, style: { display: 'none' } }) as HTMLInputElement;
      input.addEventListener('change', () => {
        const f = input.files?.[0];
        if (f) {
          apply(f);
          name.textContent = current();
        }
        input.value = '';
      });
      return h('div', { class: 'sf ed-file-row', onclick: () => input.click() }, h('div', { class: 'sf-bg' }), h('div', { class: 'sf-stack' }, h('div', { class: 'sf-caption' }, label), name, h('div', { class: 'ed-file-hint' }, hint)), input);
    };
    const resources = this.section('Resources', [
      fileRow('Background', 'image/*', () => m().backgroundFile, f => this.setFile(f, 'background'), 'Click to select a background image'),
      fileRow('Audio track', 'audio/*,.mp3,.ogg,.wav', () => m().audioFile, f => this.setFile(f, 'audio'), 'Click to select a track'),
    ]);

    // ------------------------------------------------------------ metadata
    const text = (label: string, get: () => string, set: (v: string) => void, max = 1000) => this.add(formTextBox(label, this.bind(get, set, ''), { maxLength: max }));
    const metadata = this.section('Metadata', [
      text('Artist', () => m().artistUnicode || m().artist, v => {
        m().artistUnicode = v;
        // MetadataSection: the romanised field follows while it's still ASCII.
        if (/^[\x20-\x7e]*$/.test(v)) m().artist = v;
      }),
      text('Romanised Artist', () => m().artist, v => (m().artist = v.replace(/[^\x20-\x7e]/g, ''))),
      text('Title', () => m().titleUnicode || m().title, v => {
        m().titleUnicode = v;
        if (/^[\x20-\x7e]*$/.test(v)) m().title = v;
      }),
      text('Romanised Title', () => m().title, v => (m().title = v.replace(/[^\x20-\x7e]/g, ''))),
      text('Creator', () => m().creator, v => (m().creator = v)),
      text('Difficulty Name', () => this.b.difficultyName, v => (this.b.difficultyName = v)),
      text('Source', () => m().source, v => (m().source = v)),
      text('Tags', () => m().tags, v => (m().tags = v)),
    ]);

    // ------------------------------------------------------------ difficulty
    const slider = (label: string, get: () => number, set: (v: number) => void, min: number, max: number, precision: number, hint: string, fmt?: (v: number) => string) =>
      this.add(formSliderBar(label, this.bind(get, set, get()), { min, max, precision, hint, labelFormat: fmt }));
    const difficulty = this.section('Difficulty', [
      rulesetId === 3
        ? slider('Key Count', () => d().circleSize, v => (d().circleSize = v), 1, 18, 1, 'The number of columns in the beatmap', v => `${v}`)
        : rulesetId === 1
          ? null
          : slider('Circle Size', () => d().circleSize, v => (d().circleSize = v), 0, 10, 0.1, 'The size of all hit objects'),
      slider('Health Drain', () => d().drainRate, v => (d().drainRate = v), 0, 10, 0.1, 'The rate of passive health drain throughout playable time'),
      rulesetId === 0 || rulesetId === 2 ? slider('Approach Rate', () => d().approachRate, v => (d().approachRate = v), 0, 10, 0.1, 'The speed at which objects are presented to the player') : null,
      slider('Overall Difficulty', () => d().overallDifficulty, v => (d().overallDifficulty = v), 0, 10, 0.1, 'The harshness of hit windows and difficulty of special objects (ie. spinners)'),
      slider('Base Velocity', () => d().sliderMultiplier, v => (d().sliderMultiplier = v), 0.4, 3.6, 0.01, 'The base velocity of the beatmap, affecting things like slider velocity and scroll speed in some rulesets.'),
      slider('Tick Rate', () => d().sliderTickRate, v => (d().sliderTickRate = v), 1, 4, 1, 'Determines how many "ticks" are generated within long hit objects. A tick rate of 1 will generate ticks on each beat, 2 would be twice per beat, etc.'),
    ]);

    // ------------------------------------------------------------ colours (ColoursSection, osu! / catch)
    const colourList = h('div', { class: 'ed-colours' });
    const renderColours = () => {
      const list = this.b.comboColours.length ? this.b.comboColours : [];
      colourList.replaceChildren(
        ...list.map((c, i) => {
          const input = h('input', { type: 'color', value: `#${c.map(x => x.toString(16).padStart(2, '0')).join('')}` }) as HTMLInputElement;
          input.addEventListener('change', () =>
            this.host.editor.change(() => {
              const v = input.value;
              this.b.comboColours[i] = [parseInt(v.slice(1, 3), 16), parseInt(v.slice(3, 5), 16), parseInt(v.slice(5, 7), 16)];
            }),
          );
          const remove = h(
            'button',
            {
              class: 'ed-colour-remove',
              title: 'Remove',
              onclick: () => {
                this.host.editor.change(() => this.b.comboColours.splice(i, 1));
                renderColours();
              },
            },
            '✕',
          );
          return h('div', { class: 'ed-colour' }, input, h('span', null, `Combo ${i + 1}`), remove);
        }),
        ...(list.length < 8
          ? [h(
              'button',
              {
                class: 'ed-button',
                onclick: () => {
                  this.host.editor.change(() => {
                    if (this.b.comboColours.length === 0) this.b.comboColours.push(...comboColours(this.b).map(c => [...c] as [number, number, number]));
                    else this.b.comboColours.push([255, 255, 255]);
                  });
                  renderColours();
                },
              },
              list.length === 0 ? 'Use custom combo colours' : '+ Add colour',
            )]
          : []),
      );
    };
    renderColours();
    const colours = rulesetId === 0 || rulesetId === 2 ? this.section('Colours', [h('div', { class: 'ed-setup-note' }, 'Hit circle / Slider Combos'), colourList]) : null;

    // ------------------------------------------------------------ design
    const check = (label: string, get: () => boolean, set: (v: boolean) => void, hint?: string) => this.add(formCheckBox(label, this.bind(get, set, get()), { hint }));
    const design = this.section('Design', [
      check('Enable countdown', () => this.b.countdown > 0, v => (this.b.countdown = v ? Math.max(1, this.b.countdown) : 0), 'If enabled, an "Are you ready? 3, 2, 1, GO!" countdown will be inserted at the beginning of the beatmap, assuming there is enough time to do so.'),
      this.add(
        formDropdown<number>('Countdown speed', this.bind(() => (this.b.countdown > 0 ? this.b.countdown : 1), v => (this.b.countdown = v), 1), [
          [1, 'Normal'],
          [2, 'Half'],
          [3, 'Double'],
        ]),
      ),
      slider('Countdown offset', () => this.b.countdownOffset, v => (this.b.countdownOffset = v), 0, 3, 1, 'If the countdown sounds off-time, use this to make it appear one or more beats early.', v => `${v} beat${v === 1 ? '' : 's'}`),
      check('Widescreen support', () => this.b.widescreenStoryboard, v => (this.b.widescreenStoryboard = v), 'Allows storyboards to use the full screen space, rather than be confined to a 4:3 area.'),
      check('Epilepsy warning', () => this.b.epilepsyWarning, v => (this.b.epilepsyWarning = v), 'Recommended if the storyboard or video contain scenes with rapidly flashing colours.'),
      check('Letterbox during breaks', () => this.b.letterboxInBreaks, v => (this.b.letterboxInBreaks = v), 'Adds horizontal letterboxing to give a cinematic look during breaks.'),
      check('Samples match playback rate', () => this.b.samplesMatchPlaybackRate, v => (this.b.samplesMatchPlaybackRate = v), 'When enabled, all samples will speed up or slow down when rate-changing mods are enabled.'),
    ]);

    // ------------------------------------------------------------ ruleset (RulesetSetupSection)
    const rulesetSection =
      rulesetId === 0
        ? this.section('osu!', [slider('Stack Leniency', () => this.b.stackLeniency, v => (this.b.stackLeniency = v), 0, 1, 0.1, 'In play mode, osu! automatically stacks notes which occur at the same location. Increasing this value means it is more likely to snap notes of further time-distance.')])
        : rulesetId === 3
          ? this.section('osu!mania', [check('Use special (N+1) style', () => this.b.specialStyle, v => (this.b.specialStyle = v), 'Changes one column to act as a classic "scratch" or "special" column, which can be moved around by the user\'s skin (to the left/right/centre). Generally used in 6K (5+1) or 8K (7+1) configurations.')])
          : null;

    this.body.replaceChildren(resources, metadata, difficulty, ...(colours ? [colours] : []), design, ...(rulesetSection ? [rulesetSection] : []));
  }

  /** ResourcesSection.ChangeBackgroundImage / ChangeAudioTrack: the file is copied into the set. */
  private setFile(file: File, kind: 'background' | 'audio'): void {
    const set = this.host.set;
    const blob = new Blob([file], { type: file.type || mimeFor(file.name) });
    const previous = kind === 'audio' ? this.b.metadata.audioFile : this.b.metadata.backgroundFile;
    // Other difficulties may still use the previous file; only replace it when no other difficulty references it.
    const usedElsewhere = set.beatmaps.some(e => e.filename !== this.host.filename && (kind === 'audio' ? e.audioFile : e.backgroundFile) === previous);
    if (previous && !usedElsewhere) delete set.files[previous];
    set.files[file.name] = blob;
    this.host.editor.change(() => {
      if (kind === 'audio') this.b.metadata.audioFile = file.name;
      else this.b.metadata.backgroundFile = file.name;
    });
    if (kind === 'audio') {
      this.host.loadTrack();
      // MetadataSection: a new beatmap takes artist / title from the audio file name ("Artist - Title.mp3").
      const base = file.name.replace(/\.[^.]+$/, '');
      const parts = base.split(' - ');
      if (!this.b.metadata.title && parts.length >= 2)
        this.host.editor.change(() => {
          this.b.metadata.artist = this.b.metadata.artistUnicode = parts[0].trim();
          this.b.metadata.title = this.b.metadata.titleUnicode = parts.slice(1).join(' - ').trim();
        });
      this.render();
    } else {
      this.host.applyBackgroundFromSetup();
      const bg = this.el.querySelector('.ed-setup-header-bg') as HTMLElement | null;
      const url = URL.createObjectURL(blob);
      if (bg) bg.style.backgroundImage = `url("${url}")`;
    }
  }
}
