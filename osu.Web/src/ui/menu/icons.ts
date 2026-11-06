// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Simple original SVG icons standing in for the OsuIcon / FontAwesome glyphs used by the menu and results screen
// (the osu! icon font is part of osu-resources and isn't redistributable).

const svg = (body: string, viewBox = '0 0 32 32'): string =>
  `<svg viewBox="${viewBox}" width="100%" height="100%" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const ICONS = {
  /** OsuIcon.Logo (the "play" button): a ring with a dot, like the app's favicon. */
  logo: svg('<circle cx="16" cy="16" r="12.5"/><circle cx="16" cy="16" r="5" fill="currentColor" stroke="none"/>'),
  /** OsuIcon.Settings */
  settings: svg(
    '<circle cx="16" cy="16" r="4.2"/><path d="M16 3.5v3.2M16 25.3v3.2M3.5 16h3.2M25.3 16h3.2M7.2 7.2l2.3 2.3M22.5 22.5l2.3 2.3M7.2 24.8l2.3-2.3M22.5 9.5l2.3-2.3"/><circle cx="16" cy="16" r="9"/>',
  ),
  /** OsuIcon.PrevCircle */
  back: svg('<circle cx="16" cy="16" r="12.5"/><path d="M18.5 10.5 13 16l5.5 5.5"/>'),
  /** OsuIcon.Player */
  solo: svg('<circle cx="16" cy="10.5" r="5"/><path d="M6.5 27c0-5.5 4.3-9 9.5-9s9.5 3.5 9.5 9"/>'),
  /** OsuIcon.Beatmap (browse → import) */
  browse: svg('<path d="M12 23.5V7.5l13-3v16"/><circle cx="8.5" cy="23.5" r="3.5"/><circle cx="21.5" cy="20.5" r="3.5"/>'),
  /** FontAwesome.Solid.Lightbulb */
  lightbulb: svg('<path d="M11.5 21.5c0-3-4-5-4-10a8.5 8.5 0 0 1 17 0c0 5-4 7-4 10z"/><path d="M12.5 25.5h7M14 29h4"/>'),
  /** FontAwesome.Solid.Redo */
  redo: svg('<path d="M25 9v7h-7"/><path d="M25 16a9.5 9.5 0 1 0-2.8 6.7"/>'),
  /** FontAwesome.Solid.Download (replay) */
  download: svg('<path d="M16 5v15M9.5 13.5 16 20l6.5-6.5M6 26.5h20"/>'),
  /** FontAwesome.Solid.Check */
  check: svg('<path d="M7 16.5l6 6L25.5 10"/>'),
  /** FontAwesome.Solid.Star */
  star: '<svg viewBox="0 0 32 32" width="100%" height="100%" aria-hidden="true"><path fill="currentColor" d="M16 2.5l4.1 8.6 9.4 1.2-6.9 6.5 1.8 9.3L16 23.6l-8.4 4.5 1.8-9.3-6.9-6.5 9.4-1.2z"/></svg>',
  /** Export (.osr) */
  export: svg('<path d="M16 21V5M9.5 11.5 16 5l6.5 6.5M6 26.5h20"/>'),
};

export function icon(name: keyof typeof ICONS, className = 'icon'): HTMLSpanElement {
  const s = document.createElement('span');
  s.className = className;
  s.innerHTML = ICONS[name];
  return s;
}
