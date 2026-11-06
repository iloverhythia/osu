// Original line icons standing in for the OsuIcon glyphs used by the settings sidebar
// (the osu! icon font is part of osu-resources and isn't redistributable).

const svg = (body: string): string =>
  `<svg viewBox="0 0 32 32" width="100%" height="100%" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const SETTINGS_ICONS = {
  /** OsuIcon.Settings */
  general: svg('<circle cx="16" cy="16" r="4.2"/><path d="M16 3.5v3.2M16 25.3v3.2M3.5 16h3.2M25.3 16h3.2M7.2 7.2l2.3 2.3M22.5 22.5l2.3 2.3M7.2 24.8l2.3-2.3M22.5 9.5l2.3-2.3"/><circle cx="16" cy="16" r="9"/>'),
  /** OsuIcon.SkinB */
  skin: svg('<path d="M21 4.5l6.5 6.5-11 11-6.5-6.5z"/><path d="M10 15.5c-3 0-5 2.2-5 5 0 2.5-1 4-2 5 4.5 1 10 .5 11.5-4.5"/>'),
  /** OsuIcon.Input */
  input: svg('<rect x="3.5" y="8.5" width="25" height="15" rx="3"/><path d="M8 13h1.5M12.5 13H14M17.5 13H19M22.5 13H24M10 18.5h12"/>'),
  /** OsuIcon.UserInterface */
  userInterface: svg('<rect x="4" y="5.5" width="24" height="21" rx="3"/><path d="M4 11h24M9 16h8M9 20.5h12"/>'),
  /** OsuIcon.GameplayC */
  gameplay: svg('<path d="M9.5 10.5h13a6 6 0 0 1 5.8 7.6l-1.1 4.1a3 3 0 0 1-5.1 1.3l-2.8-3h-6.6l-2.8 3a3 3 0 0 1-5.1-1.3l-1.1-4.1a6 6 0 0 1 5.8-7.6z"/><path d="M10.5 14.5v4M8.5 16.5h4"/><circle cx="21.5" cy="15" r="0.9" fill="currentColor"/><circle cx="23.5" cy="18" r="0.9" fill="currentColor"/>'),
  /** OsuIcon.Audio */
  audio: svg('<path d="M5 12.5h5l6.5-5.5v18L10 19.5H5z"/><path d="M21 11.5a6 6 0 0 1 0 9M24.5 8a11 11 0 0 1 0 16"/>'),
  /** OsuIcon.Graphics */
  graphics: svg('<rect x="3.5" y="5.5" width="25" height="16.5" rx="2.5"/><path d="M12 27h8M16 22v5"/>'),
  /** OsuIcon.Online */
  online: svg('<circle cx="16" cy="16" r="12"/><path d="M4 16h24M16 4c3.5 3.5 5 7.5 5 12s-1.5 8.5-5 12c-3.5-3.5-5-7.5-5-12s1.5-8.5 5-12z"/>'),
  /** OsuIcon.Maintenance */
  maintenance: svg('<path d="M20.5 4.5a6.5 6.5 0 0 0-6 9L5 23a2.8 2.8 0 0 0 4 4l9.5-9.5a6.5 6.5 0 0 0 9-6l-3.8 3.8-3.7-1-1-3.7z"/>'),
  /** OsuIcon.Debug */
  debug: svg('<rect x="10" y="9.5" width="12" height="16" rx="6"/><path d="M13 9.5a3 3 0 0 1 6 0M10 15H5.5M22 15h4.5M10 21H6M22 21h4M11 12l-3.5-3.5M21 12l3.5-3.5M16 14v11"/>'),
  /** FontAwesome.Solid.Undo */
  undo: '<svg viewBox="0 0 32 32" width="100%" height="100%" aria-hidden="true"><path fill="currentColor" d="M5 4v10h10l-3.8-3.8A8.5 8.5 0 1 1 9 22.5l-3.5 2.2A12.5 12.5 0 1 0 8.4 7.4z"/></svg>',
  /** FontAwesome.Solid.ChevronDown */
  chevronDown: svg('<path d="M7 12l9 9 9-9"/>'),
  /** FontAwesome.Solid.ChevronLeft */
  chevronLeft: svg('<path d="M20 6l-10 10 10 10"/>'),
  /** FontAwesome.Solid.QuestionCircle */
  question: '<svg viewBox="0 0 32 32" width="100%" height="100%" aria-hidden="true"><circle cx="16" cy="16" r="14" fill="currentColor"/><path d="M12 12.5a4 4 0 1 1 5.5 3.7c-1 .5-1.5 1.2-1.5 2.3v.5" fill="none" stroke="#000" stroke-opacity="0.75" stroke-width="2.8" stroke-linecap="round"/><circle cx="16" cy="23.3" r="1.7" fill="#000" fill-opacity="0.75"/></svg>',
  /** FontAwesome.Solid.Search */
  search: svg('<circle cx="14" cy="14" r="8.5"/><path d="M20.5 20.5l7 7"/>'),
};

export function iconEl(markup: string, cls: string): HTMLSpanElement {
  const s = document.createElement('span');
  s.className = cls;
  s.innerHTML = markup;
  return s;
}
