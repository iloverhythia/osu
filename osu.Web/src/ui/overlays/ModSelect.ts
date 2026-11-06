// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game/Overlays/Mods/ModSelectOverlay.cs + UserModSelectOverlay.cs, ShearedOverlayContainer.cs, ShearedOverlayHeader.cs,
// ModSelectColumn.cs / ModColumn.cs (+ Input/SequentialModHotkeyHandler.cs, the default hotkey style), ModSelectPanel.cs / ModPanel.cs /
// IncompatibilityDisplayingModPanel.cs, ModSwitchSmall (procedural), ModCustomisationPanel.cs (+ ModSettingsArea controls),
// ModSelectFooterContent.cs, DeselectAllModsButton.cs, RankingInformationDisplay.cs and BeatmapAttributesDisplay.cs.
// ModPresetColumn is not ported (presets are stored in Realm in lazer).

import '../select/select.css';
import { MOD_SETTINGS, MODS, ModDef, ModSet, ModType } from '../../game/mods/Mods';
import { clear, h } from '../dom';
import type { Game } from '../Game';
import { cssEasing, Easing, sequence, tween } from '../select/Anim';
import { css, darken, forModType, gray, lighten, OsuColour, OverlayColourProvider, OverlayColourScheme, RGBA } from '../select/Colours';
import { StarRatingDisplay } from '../select/Components';
import { difficultyCache } from '../select/DifficultyCache';
import { format0dd, getBeatmapAttributesForDisplay } from '../select/DisplayAttributes';
import type { ScreenFooter, ScreenFooterButton } from '../select/Footer';
import { icon } from '../select/Icons';
import { formattedDuration } from '../select/Wedges';
import { roundBPM } from '../select/BeatmapCarouselFilters';

const PADDING = 14;
const HEADER_HEIGHT = 70 + 2 * 14;
const FOOTER_HEIGHT = 50;
const PANEL_HEIGHT = 42;
const COLUMN_WIDTH = 320;
const DISTANCE = 700;

/** Lazer's column order: reduction, increase, automation, conversion, fun. */
const COLUMNS: { type: ModType; title: string; keys: string[] | null }[] = [
  { type: 'reduction', title: 'Difficulty Reduction', keys: ['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY', 'KeyU', 'KeyI', 'KeyO', 'KeyP'] },
  { type: 'increase', title: 'Difficulty Increase', keys: ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK', 'KeyL'] },
  { type: 'automation', title: 'Automation', keys: ['KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'KeyN', 'KeyM'] },
  { type: 'conversion', title: 'Conversion', keys: null },
  { type: 'fun', title: 'Fun', keys: null },
];

/** Mods with RequiresConfiguration (the customisation panel expands when they are selected). */
const REQUIRES_CONFIGURATION = new Set(['DA']);

export interface ModSelectOptions {
  /** The song select footer: the overlay registers its footer content there (ScreenFooter.RegisterActiveOverlayContainer). */
  footer?: ScreenFooter;
  ownerButton?: ScreenFooterButton;
  /** UI scale of the hosting screen (DrawSizePreservingFillContainer). */
  scale?: number;
}

let openInstance: ModSelectOverlay | null = null;

export function openModSelect(game: Game, opts: ModSelectOptions = {}): void {
  if (openInstance) {
    openInstance.hide();
    return;
  }
  openInstance = new ModSelectOverlay(game, opts);
}

interface PanelState {
  def: ModDef;
  el: HTMLDivElement;
  sw: HTMLDivElement;
  main: HTMLDivElement;
  textBg: HTMLDivElement;
  text: HTMLDivElement;
  bg: HTMLDivElement;
  hovered: boolean;
  mouseDown: boolean;
  visible: boolean;
}

class ModSelectOverlay {
  private readonly colours = new OverlayColourProvider(OverlayColourScheme.Green);
  private readonly root: HTMLDivElement;
  private readonly keyProxy: HTMLDivElement;
  private readonly header: HTMLDivElement;
  private readonly columnScroll: HTMLDivElement;
  private readonly columnFlow: HTMLDivElement;
  private readonly aboveColumns: HTMLDivElement;
  private readonly search: HTMLInputElement;
  private readonly customisation: HTMLDivElement;
  private readonly customisationContent: HTMLDivElement;
  private readonly customisationHeader: HTMLDivElement;
  private readonly footerContent: HTMLDivElement;
  private readonly multiplierValue: HTMLSpanElement;
  private readonly rankedText: HTMLSpanElement;
  private readonly rankedBox: HTMLDivElement;
  private readonly deselectAll: HTMLButtonElement;
  private readonly attributes: HTMLDivElement;
  private readonly stars = new StarRatingDisplay('regular', true);
  private readonly panels: PanelState[] = [];
  private readonly columns: { el: HTMLDivElement; top: HTMLDivElement; type: ModType; keys: string[] | null; panels: PanelState[] }[] = [];
  private customisationExpanded: 'collapsed' | 'expandedByUser' | 'expandedByMod' = 'collapsed';
  private unsubscribe: () => void;
  private closed = false;
  private readonly available: ModDef[];
  private starsUnsub: (() => void) | null = null;
  private pendingSelections: (() => void)[] = [];
  private selectionTimer = 0;

  constructor(
    private readonly game: Game,
    private readonly opts: ModSelectOptions,
  ) {
    const r = game.ruleset;
    const c = this.colours;
    this.available = MODS.filter(m => r.availableMods.includes(m.acronym) && (!m.rulesets || m.rulesets.includes(r.shortName)));

    // ShearedOverlayHeader
    const close = h('button', { class: 'mso-close', type: 'button', onclick: () => this.hide() }, icon('times', 18));
    this.header = h(
      'div',
      { class: 'mso-header' },
      h('div', { class: 'mso-header-underlay', style: { background: css(c.dark4), borderColor: css(c.dark4) } }),
      h(
        'div',
        { class: 'mso-header-main', style: { background: css(c.dark3) } },
        h('div', { class: 'mso-header-text' }, h('div', { class: 'mso-title' }, 'Mod Select'), h('div', { class: 'mso-description' }, 'Mods provide different ways to enjoy gameplay. Some have an effect on the score you can achieve during ranked play. Others are just for fun.')),
        close,
      ),
    );

    // Columns
    this.columnFlow = h('div', { class: 'mso-columns' });
    for (const col of COLUMNS) {
      const mods = this.available.filter(m => m.type === col.type);
      const accent = forModType(col.type);
      const hsvTri = lighten(darken(accent, 0.1), 0);
      const words = col.title.split(' ');
      const headerText = h('div', { class: 'mso-col-header-text' }, h('b', null, words[0]), words.length > 1 ? ` ${words.slice(1).join(' ')}` : '');
      const itemsFlow = h('div', { class: 'mso-col-items scroll-thin' });
      const top = h(
        'div',
        { class: 'mso-col-top' },
        h('div', { class: 'mso-col-header', style: { background: css(accent) } }, h('div', { class: 'mso-col-tri', style: { background: `linear-gradient(${css(hsvTri)}, ${css(accent)})` } }), headerText),
        h('div', { class: 'mso-col-content', style: { background: css(c.background4), borderColor: css(c.background3) } }, itemsFlow),
      );
      const el = h('div', { class: 'mso-column' }, top);
      el.style.width = `${COLUMN_WIDTH}px`;
      const columnPanels: PanelState[] = [];
      for (const def of mods) {
        const p = this.createPanel(def);
        itemsFlow.appendChild(p.el);
        columnPanels.push(p);
        this.panels.push(p);
      }
      if (mods.length === 0) el.style.display = 'none';
      this.columnFlow.appendChild(el);
      this.columns.push({ el, top, type: col.type, keys: col.keys, panels: columnPanels });
    }
    this.columnScroll = h('div', { class: 'mso-column-scroll' }, this.columnFlow);
    this.columnScroll.addEventListener(
      'wheel',
      e => {
        if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && !(e.target as HTMLElement).closest('.mso-col-items')) {
          this.columnScroll.scrollLeft += e.deltaY;
          e.preventDefault();
        }
      },
      { passive: false },
    );

    // Above columns: search + customisation panel
    this.search = h('input', { class: 'mso-search', type: 'text', placeholder: 'tab to search...', spellcheck: false, autocomplete: 'off' });
    this.search.addEventListener('input', () => this.applySearch());
    this.search.addEventListener('focus', () => (this.search.placeholder = 'search...'));
    this.search.addEventListener('blur', () => {
      this.search.placeholder = 'tab to search...';
      this.clearPreselection();
    });
    this.customisationContent = h('div', { class: 'mso-cust-content scroll-thin' });
    this.customisationHeader = h('div', { class: 'mso-cust-header', onclick: () => this.toggleCustomisation() }, h('span', null, 'Mod Customisation'), icon('chevronDown', 16));
    this.customisation = h('div', { class: 'mso-customisation', style: { borderColor: css(c.dark3) } }, h('div', { class: 'mso-cust-bg', style: { background: css(c.dark4) } }), this.customisationHeader, this.customisationContent);
    this.aboveColumns = h('div', { class: 'mso-above' }, h('div', { class: 'mso-search-box' }, this.search, icon('search', 16)), this.customisation);

    // ModSelectFooterContent
    this.deselectAll = h('button', { class: 'sheared-button mso-deselect', type: 'button', onclick: () => this.deselectAllMods() }, h('span', { class: 'sb-content' }, 'Deselect All'));
    this.multiplierValue = h('span', { class: 'rid-value' });
    this.rankedText = h('span', null, 'Ranked');
    this.rankedBox = h('div', { class: 'rid-ranked' }, this.rankedText);
    const ranking = h('div', { class: 'ranking-info' }, h('div', { class: 'rid-label' }, 'Mod multiplier'), h('div', { class: 'rid-value-box' }, this.multiplierValue), this.rankedBox);
    this.attributes = h('div', { class: 'beatmap-attributes' });
    this.footerContent = h('div', { class: 'mso-footer-content' }, h('div', { class: 'mso-footer-buttons' }, this.deselectAll), h('div', { class: 'mso-footer-info' }, ranking, this.attributes));

    this.root = h('div', { class: 'mod-select-overlay' }, h('div', { class: 'mso-dim', style: { background: css(c.background6, 0.75) } }), this.header, h('div', { class: 'mso-main', style: { top: `${HEADER_HEIGHT}px`, bottom: `${FOOTER_HEIGHT + PADDING}px` } }, this.columnScroll, this.aboveColumns));
    this.colours.apply(this.root);
    this.root.addEventListener('click', e => {
      // ShearedOverlayContainer.OnClick: clicking outside the content hides the overlay.
      if (e.target === this.root || (e.target as HTMLElement).classList.contains('mso-dim') || e.target === this.columnScroll || e.target === this.columnFlow) this.hide();
    });

    // Host: inside the song select (under its footer) when available, otherwise a scaled full-screen layer.
    const footerEl = opts.footer?.el;
    if (footerEl && footerEl.parentElement) footerEl.parentElement.insertBefore(this.root, footerEl);
    else {
      const s = opts.scale ?? Math.min(innerWidth / 1024, innerHeight / 768);
      const wrap = h('div', { class: 'mso-standalone' }, this.root);
      wrap.style.width = `${innerWidth / s}px`;
      wrap.style.height = `${innerHeight / s}px`;
      wrap.style.transform = `scale(${s})`;
      this.game.overlayLayer.appendChild(wrap);
      wrap.style.pointerEvents = 'auto';
    }

    // Key routing / back handling go through the game's overlay stack via an invisible proxy.
    this.keyProxy = h('div', { style: { display: 'none' } });
    this.game.openOverlay(this.keyProxy, { onKey: e => this.onKey(e), onClose: () => this.hide(true) });

    this.unsubscribe = this.game.subscribe(() => this.updateFromSelection());
    this.updateFromSelection();
    this.popIn();
  }

  // ------------------------------------------------------------------ panels

  private createPanel(def: ModDef): PanelState {
    const c = this.colours;
    const sw = h('div', { class: 'mso-switch' }, h('div', { class: 'mso-switch-icon' }, h('span', null, def.acronym)));
    const textBg = h('div', { class: 'mso-panel-textbg' });
    const text = h('div', { class: 'mso-panel-text' }, h('div', { class: 'mso-panel-title' }, def.name), h('div', { class: 'mso-panel-desc' }, def.description));
    const main = h('div', { class: 'mso-panel-main' }, h('div', { class: 'mso-panel-inner' }, textBg, text));
    const bg = h('div', { class: 'mso-panel-bg' });
    const el = h('div', { class: 'mso-panel', title: def.name }, bg, sw, main);
    void c;
    const p: PanelState = { def, el, sw, main, textBg, text, bg, hovered: false, mouseDown: false, visible: true };
    el.addEventListener('mouseenter', () => ((p.hovered = true), this.updatePanel(p)));
    el.addEventListener('mouseleave', () => ((p.hovered = false), (p.mouseDown = false), this.updatePanel(p)));
    el.addEventListener('mousedown', e => {
      if (e.button === 0) {
        p.mouseDown = true;
        this.updatePanel(p);
      }
    });
    el.addEventListener('mouseup', () => ((p.mouseDown = false), this.updatePanel(p)));
    el.addEventListener('click', e => {
      e.stopPropagation();
      this.togglePanel(p);
    });
    return p;
  }

  private isActive(def: ModDef): boolean {
    return this.game.mods.has(def.acronym);
  }

  private togglePanel(p: PanelState, active = !this.isActive(p.def)): void {
    if (active === this.isActive(p.def)) return;
    // ModPanel.Select: PendingConfiguration = Mod.RequiresConfiguration
    if (active && REQUIRES_CONFIGURATION.has(p.def.acronym)) this.pendingConfiguration = true;
    // UserModSelectOverlay.ComputeNewModsFromSelection drops incompatible mods (ModSet.toggle).
    this.game.setMods(this.game.mods.toggle(p.def.acronym));
    this.game.playUiSample(active ? 'menu-click' : 'menu-back', 0.4);
  }

  private pendingConfiguration = false;

  /** IncompatibilityDisplayingModPanel.updateIncompatibility */
  private isIncompatible(def: ModDef): boolean {
    const selected = this.game.mods.list;
    if (selected.length === 0 || selected.includes(def.acronym)) return false;
    return selected.some(s => def.incompatible.includes(s) || MODS.find(m => m.acronym === s)?.incompatible.includes(def.acronym));
  }

  /** ModSelectPanel.UpdateState */
  private updatePanel(p: PanelState): void {
    const active = this.isActive(p.def);
    const accent = forModType(p.def.type);
    const incompatible = this.isIncompatible(p.def);
    const c = this.colours;
    const idle = 54;
    const expanded = 70;
    let targetWidth = active ? expanded : idle;
    let duration = 150;
    let background: RGBA = incompatible ? c.background6 : active ? darken(accent, 0.3) : c.background3;
    let foreground: RGBA = incompatible ? c.background5 : active ? accent : c.background2;
    const textColour = active ? c.background6 : { r: 1, g: 1, b: 1, a: 1 };
    if (p.hovered) {
      background = lighten(background, 0.1);
      foreground = lighten(foreground, 0.1);
    }
    if (p.mouseDown) {
      targetWidth = idle + (expanded - idle) * 0.5;
      duration *= 4;
    }
    const e = cssEasing(Easing.OutQuint);
    p.el.style.setProperty('--mso-border', `linear-gradient(${css(background)}, ${css(foreground)})`);
    p.el.style.borderImage = '';
    p.bg.style.transition = p.textBg.style.transition = p.text.style.transition = `background ${duration}ms ${e}, color ${duration}ms ${e}`;
    p.bg.style.background = css(background);
    p.el.style.background = `linear-gradient(${css(background)}, ${css(foreground)})`;
    p.sw.style.transition = `width ${duration}ms ${e}, filter ${duration}ms ${e}`;
    p.sw.style.width = `${targetWidth}px`;
    p.main.style.transition = `left ${duration}ms ${e}`;
    p.main.style.left = `${targetWidth}px`;
    p.textBg.style.background = css(foreground);
    p.text.style.color = css(textColour);
    // ModSwitchSmall colours
    const icon = p.sw.firstElementChild as HTMLElement;
    icon.style.background = active ? css(accent) : css(c.background5);
    icon.style.color = active ? css(c.background6) : css(accent);
    p.sw.style.filter = incompatible ? 'grayscale(1) brightness(0.8)' : '';
  }

  // ------------------------------------------------------------------ search (ModSearchContainer / preselection)

  private applySearch(): void {
    const terms = this.search.value.toLowerCase().split(/\s+/).filter(Boolean);
    for (const p of this.panels) {
      const filterTerms = [p.def.name, p.def.name.replace(/ /g, ''), p.def.acronym].map(s => s.toLowerCase());
      p.visible = terms.every(t => filterTerms.some(f => f.includes(t)));
      p.el.style.display = p.visible ? '' : 'none';
    }
    for (const col of this.columns) col.el.style.display = col.panels.some(p => p.visible) ? '' : 'none';
    if (document.activeElement === this.search) this.preselectMod();
  }

  private preselected: PanelState | null = null;

  private preselectMod(): void {
    const term = this.search.value.trim().toLowerCase();
    const visible = this.columns.flatMap(c => c.panels.filter(p => p.visible));
    const match = visible.find(p => p.def.acronym.toLowerCase() === term || p.def.name.toLowerCase() === term) ?? visible[0] ?? null;
    this.clearPreselection();
    if (match && term.length > 0) {
      this.preselected = match;
      match.el.classList.add('preselected');
      match.el.style.setProperty('--mso-glow', css(forModType(match.def.type)));
    }
  }

  private clearPreselection(): void {
    this.preselected?.el.classList.remove('preselected');
    this.preselected = null;
  }

  private setTextBoxFocus(focus: boolean): void {
    if (focus) {
      this.search.focus({ preventScroll: true });
      this.preselectMod();
    } else {
      this.search.blur();
      this.clearPreselection();
    }
  }

  // ------------------------------------------------------------------ customisation (ModCustomisationPanel + ModSettingsArea)

  private toggleCustomisation(): void {
    if (!this.customisationEnabled) return;
    this.setCustomisation(this.customisationExpanded === 'collapsed' ? 'expandedByUser' : 'collapsed');
  }

  private customisationEnabled = false;

  private setCustomisation(state: 'collapsed' | 'expandedByUser' | 'expandedByMod'): void {
    this.customisationExpanded = state;
    const expanded = state !== 'collapsed';
    this.customisation.classList.toggle('expanded', expanded);
    const e = cssEasing(Easing.OutQuint);
    this.columnScroll.style.transition = this.search.style.transition = `filter 400ms ${e}`;
    this.columnScroll.style.filter = expanded ? 'brightness(0.5)' : '';
    (this.search.parentElement as HTMLElement).style.filter = expanded ? 'brightness(0.5)' : '';
    if (expanded) this.setTextBoxFocus(false);
  }

  private updateCustomisation(): void {
    const r = this.game.ruleset;
    const customisable = this.game.mods.list.filter(a => (MOD_SETTINGS[a] ?? []).some(d => !d.rulesets || d.rulesets.includes(r.shortName)));
    this.customisationEnabled = customisable.length > 0;
    this.customisation.classList.toggle('enabled', this.customisationEnabled);
    if (this.customisationEnabled) {
      if (this.pendingConfiguration) this.setCustomisation('expandedByMod');
    } else this.setCustomisation('collapsed');
    this.pendingConfiguration = false;
    this.renderSettings(customisable);
  }

  /** ModSettingsArea: a section per selected customisable mod with its [SettingSource] controls. */
  private renderSettings(acronyms: string[]): void {
    const focused = document.activeElement;
    if (focused && this.customisationContent.contains(focused) && (focused as HTMLInputElement).type === 'range') return;
    clear(this.customisationContent);
    const r = this.game.ruleset;
    for (const acr of acronyms) {
      const def = MODS.find(m => m.acronym === acr)!;
      const section = h('div', { class: 'mso-cust-section' }, h('div', { class: 'mso-cust-mod', style: { color: css(forModType(def.type)) } }, def.name));
      for (const d of (MOD_SETTINGS[acr] ?? []).filter(x => !x.rulesets || x.rulesets.includes(r.shortName))) {
        const row = h('div', { class: 'mso-setting' }, h('label', null, d.label));
        if (d.kind === 'boolean') {
          const input = h('input', { type: 'checkbox', class: 'toggle' });
          input.checked = !!this.game.mods.setting(acr, d.key);
          input.addEventListener('change', () => this.game.setMods(this.game.mods.withSetting(acr, d.key, input.checked)));
          row.appendChild(input);
        } else {
          const isDifficulty = d.kind === 'difficulty';
          const value = h('span', { class: 'value' });
          const slider = h('input', { type: 'range', min: d.min, max: d.max, step: d.step });
          const override = isDifficulty ? h('input', { type: 'checkbox', class: 'toggle', title: "Override the beatmap's value" }) : null;
          const sync = () => {
            const v = this.game.mods.setting<number | null>(acr, d.key);
            const w = this.game.working?.entry;
            const mapValue = w ? (w as unknown as Record<string, number>)[d.key] : 5;
            const shown = v ?? (isDifficulty ? (mapValue ?? 5) : (d.default as number));
            slider.value = String(shown);
            slider.disabled = isDifficulty && v == null;
            if (override) override.checked = v != null;
            value.textContent = v == null && isDifficulty ? `${format0dd(shown)} (map)` : d.key === 'speed' ? `${shown.toFixed(2)}x` : d.key === 'minimumAccuracy' ? `${(shown * 100).toFixed(1)}%` : shown.toFixed(1);
          };
          slider.addEventListener('input', () => {
            this.game.setMods(this.game.mods.withSetting(acr, d.key, parseFloat(slider.value)));
            sync();
          });
          override?.addEventListener('change', () => {
            this.game.setMods(this.game.mods.withSetting(acr, d.key, override.checked ? parseFloat(slider.value) : null));
            sync();
          });
          sync();
          row.appendChild(h('div', { class: 'mso-setting-control' }, override, slider, value));
        }
        section.appendChild(row);
      }
      this.customisationContent.appendChild(section);
    }
  }

  // ------------------------------------------------------------------ selection sync & footer information

  private updateFromSelection(): void {
    if (this.closed) return;
    for (const p of this.panels) this.updatePanel(p);
    this.updateCustomisation();
    this.updateInformation();
    this.deselectAll.disabled = this.game.mods.isEmpty;
  }

  /** ModSelectFooterContent.updateInformation + RankingInformationDisplay + BeatmapAttributesDisplay */
  private updateInformation(): void {
    const r = this.game.ruleset;
    const mods = this.game.mods.forRuleset(r.shortName, r.availableMods);
    let multiplier = 1;
    try {
      multiplier = r.scoreMultiplier(mods);
    } catch {
      /* ignore */
    }
    this.multiplierValue.textContent = `${(Math.floor(multiplier * 100) / 100).toFixed(2)}x`;
    this.multiplierValue.style.color = multiplier > 1 ? css(OsuColour.Red1) : multiplier < 1 ? css(OsuColour.Lime1) : '#fff';
    const ranked = mods.isRanked;
    this.rankedText.textContent = ranked ? 'Ranked' : 'Unranked';
    this.rankedBox.style.background = ranked ? css(this.colours.background3) : css(OsuColour.Orange2);
    this.rankedBox.style.color = ranked ? '#fff' : '#000';

    clear(this.attributes);
    const w = this.game.working;
    if (!w) return;
    const e = w.entry;
    this.attributes.appendChild(this.stars.el);
    this.starsUnsub?.();
    this.starsUnsub = difficultyCache.get(w.set, e, r, this.game.mods, s => this.stars.set(s));
    const rate = mods.rate;
    const attr = (label: string, value: string, adjusted: number) => {
      const v = h('div', { class: 'vad-value' }, value);
      if (adjusted > 0) v.style.color = css(OsuColour.Red1);
      else if (adjusted < 0) v.style.color = css(OsuColour.Lime1);
      return h('div', { class: 'vertical-attribute' }, h('div', { class: 'vad-label', style: { color: css(this.colours.content2) } }, label), v);
    };
    this.attributes.appendChild(attr('BPM', String(roundBPM(e.bpm, rate)), Math.sign(rate - 1)));
    this.attributes.appendChild(attr('Length', formattedDuration(Math.round(e.length / rate)), -Math.sign(rate - 1)));
    for (const a of getBeatmapAttributesForDisplay(e, r.id, mods)) this.attributes.appendChild(attr(a.acronym, format0dd(a.adjustedValue), Math.sign(Math.round((a.adjustedValue - a.originalValue) * 100))));
  }

  // ------------------------------------------------------------------ bulk selection (ModColumn.SelectAll / DeselectAll)

  private deselectAllMods(): void {
    if (this.game.mods.isEmpty) return;
    this.pendingSelections = [];
    clearInterval(this.selectionTimer);
    // Hidden (filtered) panels are deselected immediately, visible ones one after another with a decaying delay.
    const visible = new Set(this.panels.filter(p => p.visible).map(p => p.def.acronym));
    let mods = this.game.mods;
    for (const a of mods.list) if (!visible.has(a)) mods = mods.toggle(a);
    if (mods !== this.game.mods) this.game.setMods(mods);
    for (const a of this.game.mods.list) this.pendingSelections.push(() => this.game.mods.has(a) && this.game.setMods(this.game.mods.toggle(a)));
    let delay = 120;
    const step = () => {
      const op = this.pendingSelections.shift();
      if (!op) return;
      op();
      this.game.playUiSample('menu-back', 0.3);
      delay = Math.max(30, delay * 0.8);
      this.selectionTimer = window.setTimeout(step, delay);
    };
    step();
  }

  // ------------------------------------------------------------------ input

  private onKey(e: KeyboardEvent): boolean {
    const typing = document.activeElement === this.search;
    if (e.code === 'Escape' || e.code === 'F1') {
      if (!e.repeat) this.hide();
      return true;
    }
    if (e.code === 'Tab') {
      if (this.customisationExpanded !== 'collapsed') return true;
      this.setTextBoxFocus(!typing);
      return true;
    }
    if (e.code === 'Enter' || e.code === 'NumpadEnter') {
      if (!this.search.value) {
        this.hide();
        return true;
      }
      if (this.preselected) {
        this.togglePanel(this.preselected);
        this.search.select();
      }
      return true;
    }
    if (typing) return false;
    if (e.code === 'Backspace' && this.customisationExpanded === 'collapsed') {
      this.deselectAllMods();
      return true;
    }
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return false;
    // SequentialModHotkeyHandler (the default ModSelectHotkeyStyle)
    for (const col of this.columns) {
      if (!col.keys) continue;
      const index = col.keys.indexOf(e.code);
      if (index < 0) continue;
      const p = col.panels.filter(x => x.visible)[index];
      if (!p) return false;
      this.togglePanel(p);
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------------ transitions

  private popIn(): void {
    const ease = cssEasing(Easing.OutQuint);
    this.root.style.opacity = '0';
    this.header.style.transform = `translateY(-${HEADER_HEIGHT}px)`;
    this.aboveColumns.style.opacity = '0';
    this.aboveColumns.style.transform = `translateY(-${DISTANCE}px)`;
    void this.root.offsetWidth;
    tween(this.root, { opacity: '1' }, 400, Easing.OutQuint);
    tween(this.header, { transform: 'translateY(0)' }, 400, Easing.OutQuint);
    tween(this.aboveColumns, { opacity: '1', transform: 'translateY(0)' }, 400, Easing.OutQuint);
    let n = 0;
    for (const col of this.columns) {
      if (col.el.style.display === 'none') continue;
      const start = n % 2 === 0 ? -DISTANCE : DISTANCE;
      col.top.style.transition = 'none';
      col.top.style.transform = `translateY(${start}px)`;
      col.top.style.opacity = '0';
      void col.top.offsetWidth;
      col.top.style.transition = `transform 400ms ${ease} ${n * 30}ms, opacity 400ms ${ease} ${n * 30}ms`;
      col.top.style.transform = 'translateY(0)';
      col.top.style.opacity = '1';
      n++;
    }
    // footer integration
    if (this.opts.footer) {
      this.opts.footer.registerActiveOverlay({ onBack: () => this.hide() }, this.opts.ownerButton ?? null, this.colours.hue, this.footerContent);
      if (this.opts.ownerButton) {
        this.opts.ownerButton.overlayVisible = true;
        this.opts.ownerButton.updateDisplay();
      }
    } else this.root.appendChild(h('div', { class: 'mso-standalone-footer', style: { background: css(this.colours.background5) } }, this.footerContent)), this.footerContent.classList.add('visible');
    // ModSelectTextSearchStartsActive = true
    setTimeout(() => this.setTextBoxFocus(true), 0);
  }

  hide(fromGame = false): void {
    if (this.closed) return;
    this.closed = true;
    openInstance = null;
    this.unsubscribe();
    this.starsUnsub?.();
    clearTimeout(this.selectionTimer);
    for (const op of this.pendingSelections) op();
    this.pendingSelections = [];
    if (!fromGame) this.game.closeOverlay(this.keyProxy);
    this.search.blur();
    this.game.playUiSample('menu-back', 0.4);
    const ease = cssEasing(Easing.OutQuint);
    tween(this.root, { opacity: '0' }, 500, Easing.OutQuint);
    tween(this.header, { transform: `translateY(-${HEADER_HEIGHT}px)` }, 500, Easing.OutQuint);
    tween(this.aboveColumns, { opacity: '0', transform: `translateY(-${DISTANCE}px)` }, 250, Easing.OutQuint);
    let n = 0;
    for (const col of this.columns) {
      if (col.el.style.display === 'none') continue;
      col.top.style.transition = `transform 500ms ${ease}, opacity 500ms ${ease}`;
      col.top.style.transform = `translateY(${n % 2 === 0 ? -DISTANCE : DISTANCE}px)`;
      col.top.style.opacity = '0';
      n++;
    }
    this.root.style.pointerEvents = 'none';
    if (this.opts.footer) {
      this.opts.footer.clearActiveOverlay();
      if (this.opts.ownerButton) {
        this.opts.ownerButton.overlayVisible = false;
        this.opts.ownerButton.updateDisplay();
      }
    }
    setTimeout(() => (this.root.parentElement?.classList.contains('mso-standalone') ? this.root.parentElement.remove() : this.root.remove()), 500);
    void sequence;
    void gray;
  }
}
