// Port of SettingsOverlay / SettingsPanel: a sidebar of section buttons (SettingsSidebar + SidebarIconButton),
// the settings panel with its expandable header (SettingsHeader), fixed search box, sections (SettingsSection /
// SettingsSubsection) and footer (SettingsFooter), plus the key binding sub-panel (KeyBindingPanel).

import './settings.css';
import { APP_NAME, ATTRIBUTION, CREDITS } from '../../../brand';
import { settings } from '../../../framework/Settings';
import { availableRulesets } from '../../../game/rulesets';
import { h } from '../../dom';
import type { Game } from '../../Game';
import { OverlayColourProvider, OverlayColourScheme, darken, css, lighten, OsuColour } from '../../select/Colours';
import { rulesetIcon } from '../../select/Icons';
import { hideTooltip, SettingsItem } from './controls';
import { iconEl, SETTINGS_ICONS } from './icons';
import { createKeyBindingPanel } from './KeyBindingPanel';
import { buildSections, SectionDef } from './sections';

/** SettingsPanel constants */
export const PANEL_WIDTH = 400;
export const SIDEBAR_EXPANDED = 170;
export const SIDEBAR_CONTRACTED = 60;
const TRANSITION_LENGTH = 600;
const FADE_IN_DURATION = 500;

export interface SidebarEntry {
  header: string;
  icon: () => Node;
  small?: boolean;
  el: HTMLElement;
}

export function applyColours(el: HTMLElement): void {
  const c = new OverlayColourProvider(OverlayColourScheme.Purple);
  c.apply(el);
  el.style.setProperty('--c-background4-darken', css(darken(c.background4, 0.1)));
  el.style.setProperty('--c-highlight1-darken', css(darken(c.highlight1, 0.1)));
  el.style.setProperty('--c-light4-darken', css(darken(c.light4, 0.4)));
  el.style.setProperty('--c-colour3-lighten', css(lighten(c.colour3, 0.2)));
  el.style.setProperty('--c-dangerous', css(OsuColour.Pink3));
  el.style.setProperty('--c-dangerous-lighten', css(lighten(OsuColour.Pink3, 0.2)));
  el.style.setProperty('--c-content1-lighten', css(lighten(c.content1, 0.4)));
}

/** SettingsSidebar with SidebarIconButtons (and the optional back button used by sub-panels). */
export function createSidebar(entries: SidebarEntry[], onSelect: (e: SidebarEntry) => void, back?: () => void): { el: HTMLElement; setSelected: (e: SidebarEntry | null) => void; buttons: HTMLElement[] } {
  const buttons: HTMLElement[] = [];
  const flow = h('div', { class: 'st-sidebar-flow' });
  entries.forEach((entry, i) => {
    const b = h(
      'button',
      { class: `st-sidebar-button${entry.small ? ' small' : ''}`, onclick: () => onSelect(entry), title: entry.header },
      h('span', { class: 'st-sidebar-indicator' }),
      h('span', { class: 'st-sidebar-content' }, h('span', { class: 'st-sidebar-icon' }, entry.icon()), h('span', { class: 'st-sidebar-text' }, entry.header)),
    );
    b.style.animationDelay = `${TRANSITION_LENGTH / 3 + i * 40}ms`;
    buttons.push(b);
    flow.appendChild(b);
  });
  const el = h('div', { class: 'st-sidebar' }, flow);
  if (back) {
    el.appendChild(
      h('button', { class: 'st-sidebar-back', onclick: back }, iconEl(SETTINGS_ICONS.chevronLeft, 'st-back-icon'), h('span', null, 'back')),
    );
  }
  return {
    el,
    buttons,
    setSelected: e => buttons.forEach((b, i) => b.classList.toggle('selected', entries[i] === e)),
  };
}

interface RenderedSection {
  def: SectionDef;
  el: HTMLElement;
  dim: HTMLElement;
  subsections: { el: HTMLElement; header: string; items: SettingsItem[] }[];
  items: SettingsItem[];
  entry: SidebarEntry;
}

function renderSection(def: SectionDef): RenderedSection {
  const flow = h('div', { class: 'st-section-flow' });
  const items: SettingsItem[] = [...(def.items ?? [])];
  for (const it of def.items ?? []) flow.appendChild(it.el);
  const subsections = def.subsections.map(sub => {
    const el = h('div', { class: 'st-subsection' }, sub.header ? h('div', { class: 'st-subsection-header' }, sub.header) : null, h('div', { class: 'st-subsection-flow' }, ...sub.items.map(i => i.el)));
    items.push(...sub.items);
    flow.appendChild(el);
    return { el, header: sub.header, items: sub.items };
  });
  const dim = h('div', { class: 'st-section-dim' });
  const el = h('section', { class: 'st-section' }, h('div', { class: 'st-section-separator' }), h('div', { class: 'st-section-body' }, h('div', { class: 'st-section-header' }, def.header), flow), dim);
  return { def, el, dim, subsections, items, entry: { header: def.header, icon: def.icon, small: def.small, el } };
}

function searchBox(onChange: (term: string) => void): { el: HTMLElement; input: HTMLInputElement } {
  const input = h('input', { class: 'st-search-input', type: 'text', placeholder: 'type to search', spellcheck: false }) as HTMLInputElement;
  input.addEventListener('input', () => onChange(input.value));
  input.addEventListener('keydown', e => {
    if (e.key === 'Escape' && input.value) {
      e.stopPropagation();
      input.value = '';
      onChange('');
    }
  });
  return { el: h('div', { class: 'st-search' }, input, iconEl(SETTINGS_ICONS.search, 'st-search-icon')), input };
}

const matches = (terms: string[], words: string[]) => {
  const hay = terms.join(' ').toLowerCase();
  return words.every(w => hay.includes(w));
};

/** SettingsFooter: game name, build, ruleset icons (plus the credits). */
function footer(): HTMLElement {
  const modes = h('div', { class: 'st-footer-modes' }, ...availableRulesets().map(r => rulesetIcon(r.id, 20)));
  return h(
    'div',
    { class: 'st-footer' },
    modes,
    h('div', { class: 'st-footer-name' }, APP_NAME),
    h('div', { class: 'st-footer-version' }, 'web build'),
    h('div', { class: 'st-footer-credits' }, `${APP_NAME} by ${CREDITS.join(', ')}`),
    h('div', { class: 'st-footer-attribution' }, ATTRIBUTION),
  );
}

let openInstance: { close: () => void } | null = null;

export function openSettings(game: Game): void {
  if (openInstance) {
    openInstance.close();
    return;
  }
  const root = h('div', { class: 'st-root' });
  applyColours(root);
  const catcher = h('div', { class: 'st-catcher' });
  const sections = buildSections(game, () => openKeyBindings()).map(renderSection);

  // ---------------------------------------------------------------- panel content
  const header = h('div', { class: 'st-header' }, h('div', { class: 'st-header-title' }, 'settings'), h('div', { class: 'st-header-subtitle' }, `change the way ${APP_NAME} behaves`));
  let currentTerm = '';
  const { el: searchEl, input: search } = searchBox(term => {
    currentTerm = term;
    applyFilter();
  });
  const fixedHeaderBg = h('div', { class: 'st-fixed-header-bg' });
  const fixedHeader = h('div', { class: 'st-fixed-header' }, fixedHeaderBg, searchEl);
  const sectionsFlow = h('div', { class: 'st-sections' }, ...sections.map(s => s.el));
  const noResults = h('div', { class: 'st-no-results' }, 'No matching settings');
  const scroll = h('div', { class: 'st-scroll' }, header, fixedHeader, sectionsFlow, noResults, footer());
  const content = h('div', { class: 'st-content' }, h('div', { class: 'st-content-bg' }), scroll);

  const applyFilter = () => {
    const words = currentTerm.toLowerCase().split(/\s+/).filter(Boolean);
    let any = false;
    for (const s of sections) {
      const sectionMatch = words.length === 0 || matches([s.def.header, ...(s.def.keywords ?? [])], words);
      let sectionVisible = sectionMatch;
      for (const it of s.def.items ?? []) {
        const v = sectionMatch || matches(it.terms, words);
        it.el.style.display = v ? '' : 'none';
        sectionVisible ||= v;
      }
      for (const sub of s.subsections) {
        const subMatch = sectionMatch || (!!sub.header && matches([sub.header], words));
        let subVisible = subMatch;
        for (const it of sub.items) {
          const v = subMatch || matches(it.terms, words);
          it.el.style.display = v ? '' : 'none';
          subVisible ||= v;
        }
        sub.el.style.display = subVisible ? '' : 'none';
        sectionVisible ||= subVisible;
      }
      s.el.style.display = sectionVisible ? '' : 'none';
      any ||= sectionVisible;
    }
    noResults.style.display = any ? 'none' : '';
    updateCurrent();
  };

  // ---------------------------------------------------------------- current section (SectionsContainer)
  let current: RenderedSection | null = null;
  let scrollTarget: RenderedSection | null = null;
  const sectionTop = (s: RenderedSection) => s.el.offsetTop - fixedHeader.offsetHeight;
  const updateCurrent = () => {
    const visible = sections.filter(s => s.el.style.display !== 'none');
    if (visible.length === 0) return;
    let sel: RenderedSection;
    const top = scroll.scrollTop;
    if (scrollTarget && Math.abs(sectionTop(scrollTarget) - top) > 2 && top + scroll.clientHeight < scroll.scrollHeight - 2) sel = scrollTarget;
    else {
      scrollTarget = null;
      if (top <= 0) sel = visible[0];
      else if (top + scroll.clientHeight >= scroll.scrollHeight - 2) sel = visible[visible.length - 1];
      else {
        // The last section whose top has scrolled to (or past) a point slightly below the fixed header.
        const line = top + scroll.clientHeight * 0.1;
        sel = visible[0];
        for (const s of visible) if (sectionTop(s) <= line) sel = s;
      }
    }
    if (sel !== current) {
      current = sel;
      for (const s of sections) s.el.classList.toggle('current', s === sel);
      sidebar.setSelected(sel.entry);
    }
    // HeaderBackground.Alpha = -ExpandableHeader.Y / ExpandableHeader.LayoutSize.Y
    fixedHeaderBg.style.opacity = String(Math.min(1, Math.max(0, top / Math.max(1, header.offsetHeight))));
  };
  const scrollToSection = (s: RenderedSection) => {
    scrollTarget = s;
    scroll.scrollTo({ top: Math.max(0, sectionTop(s)), behavior: 'smooth' });
    current = null;
    updateCurrent();
  };
  for (const s of sections) {
    // Only the current section takes input; clicking another one scrolls to it.
    s.dim.addEventListener('click', e => {
      e.stopPropagation();
      scrollToSection(s);
    });
  }
  scroll.addEventListener('scroll', () => {
    hideTooltip();
    updateCurrent();
  });

  const sidebar = createSidebar(
    sections.map(s => s.entry),
    e => {
      const s = sections.find(x => x.entry === e);
      if (s) scrollToSection(s);
    },
  );

  // Keep controls in sync with changes made elsewhere (and dependent disabled states).
  const allItems = sections.flatMap(s => s.items);
  const unsubscribe = settings.subscribe(() => {
    for (const it of allItems) it.update();
  });
  const onFullscreen = () => allItems.forEach(it => it.update());
  document.addEventListener('fullscreenchange', onFullscreen);

  // ---------------------------------------------------------------- key binding sub-panel
  let subPanel: { el: HTMLElement; destroy: () => void; onKey: (e: KeyboardEvent) => boolean } | null = null;
  const closeSubPanel = () => {
    if (!subPanel) return;
    const p = subPanel;
    subPanel = null;
    root.classList.remove('sub-open');
    p.el.classList.remove('open');
    setTimeout(() => {
      p.destroy();
      p.el.remove();
    }, TRANSITION_LENGTH);
    search.focus();
  };
  function openKeyBindings(): void {
    if (subPanel) return;
    subPanel = createKeyBindingPanel(game, closeSubPanel);
    root.appendChild(subPanel.el);
    requestAnimationFrame(() => {
      root.classList.add('sub-open');
      subPanel?.el.classList.add('open');
    });
  }

  // ---------------------------------------------------------------- open / close
  root.append(catcher, content, sidebar.el);
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    openInstance = null;
    hideTooltip();
    unsubscribe();
    document.removeEventListener('fullscreenchange', onFullscreen);
    subPanel?.destroy();
    root.classList.remove('open');
    root.classList.add('closing');
    setTimeout(() => game.closeOverlay(root), TRANSITION_LENGTH / 2);
  };
  openInstance = { close };
  catcher.addEventListener('pointerdown', () => close());
  game.openOverlay(root, {
    capture: true,
    onClose: () => {
      openInstance = null;
    },
    onKey: e => {
      if (subPanel) {
        if (subPanel.onKey(e)) return true;
        if (e.code === 'Escape') {
          closeSubPanel();
          return true;
        }
        return false;
      }
      if (e.code === 'Escape') {
        if (search.value) {
          search.value = '';
          currentTerm = '';
          applyFilter();
        } else close();
        return true;
      }
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyO') {
        close();
        return true;
      }
      // SearchTextBox.HoldFocus: typing anywhere goes to the search box.
      const t = e.target as HTMLElement | null;
      if (!(t instanceof HTMLInputElement) && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) search.focus();
      return false;
    },
  });
  requestAnimationFrame(() => {
    root.classList.add('open');
    search.focus({ preventScroll: true });
    applyFilter();
    updateCurrent();
  });
  setTimeout(() => root.classList.add('loaded'), TRANSITION_LENGTH / 3);
}

export { FADE_IN_DURATION, TRANSITION_LENGTH };
