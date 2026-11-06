// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Small inline SVG icons standing in for the FontAwesome / OsuIcon glyphs used by song select (FontAwesome itself is not bundled).
// Ruleset icons are simple procedural shapes (lazer's ruleset icons are part of the non-redistributable osu! font).

const NS = 'http://www.w3.org/2000/svg';

const PATHS: Record<string, string> = {
  chevronRight: 'M9 4l8 8-8 8-2-2 6-6-6-6z',
  chevronLeft: 'M15 4l2 2-6 6 6 6-2 2-8-8z',
  chevronDown: 'M4 9l2-2 6 6 6-6 2 2-8 8z',
  star: 'M12 2l2.9 6.6 7.1.6-5.4 4.7 1.6 7L12 17.3 5.8 20.9l1.6-7L2 9.2l7.1-.6z',
  random: 'M17 3l4 4-4 4V8h-2.3l-7 9H3v-2h3.7l7-9H17zM3 7h4.7l2.1 2.7-1.3 1.6L6.7 9H3zm14 6l4 4-4 4v-3h-3.3l-2.1-2.7 1.3-1.6 1.8 2.3H17z',
  exchange: 'M16 3l5 5-5 5v-3H4V6h12zM8 11v3h12v4H8v3l-5-5z',
  cog: 'M12 8a4 4 0 100 8 4 4 0 000-8zm9 5.5v-3l-2.6-.5a7 7 0 00-.8-1.9l1.5-2.2-2.1-2.1-2.2 1.5a7 7 0 00-1.9-.8L12.5 2h-3l-.5 2.6a7 7 0 00-1.9.8L4.9 3.9 2.8 6l1.5 2.2a7 7 0 00-.8 1.9L1 10.5v3l2.6.5c.2.7.4 1.3.8 1.9l-1.5 2.2 2.1 2.1 2.2-1.5c.6.4 1.2.6 1.9.8l.4 2.5h3l.5-2.6c.7-.2 1.3-.4 1.9-.8l2.2 1.5 2.1-2.1-1.5-2.2c.4-.6.6-1.2.8-1.9z',
  clock: 'M12 2a10 10 0 110 20 10 10 0 010-20zm0 2a8 8 0 100 16 8 8 0 000-16zm1 3v5l4 2-1 1.7-5-2.7V7z',
  metronome: 'M9 2h6l4 20H5zm1.6 2L8 16h8l-.6-3-4.4-4.4L12.4 7 14.6 9.3 13.4 4zM12 18a1 1 0 100 2 1 1 0 000-2z',
  sortUp: 'M12 4l7 9H5z',
  sortDown: 'M12 20l-7-9h14z',
  eye: 'M12 5c5 0 9 4 10 7-1 3-5 7-10 7S3 15 2 12c1-3 5-7 10-7zm0 3a4 4 0 100 8 4 4 0 000-8zm0 2a2 2 0 110 4 2 2 0 010-4z',
  trash: 'M9 2h6l1 2h4v2H4V4h4zM5 8h14l-1 14H6z',
  eraser: 'M15 3l6 6-10 10H5l-2-2zm-4 15l3-3-5-5-4 4 3 4z',
  check: 'M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z',
  timesCircle: 'M12 2a10 10 0 110 20 10 10 0 010-20zm-3.5 5L7 8.5l3.5 3.5L7 15.5 8.5 17l3.5-3.5 3.5 3.5 1.5-1.5-3.5-3.5L17 8.5 15.5 7 12 10.5z',
  play: 'M7 4l13 8-13 8z',
  search: 'M10 3a7 7 0 015.6 11.2l5.6 5.6-1.4 1.4-5.6-5.6A7 7 0 1110 3zm0 2a5 5 0 100 10 5 5 0 000-10z',
  times: 'M6.4 5L12 10.6 17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6 10.6 12 5 6.4z',
  circle: 'M12 4a8 8 0 110 16 8 8 0 010-16z',
  ghost: 'M12 2a8 8 0 018 8v12l-3-2-2.5 2-2.5-2-2.5 2L7 20l-3 2V10a8 8 0 018-8zm-3 7a1.5 1.5 0 100 3 1.5 1.5 0 000-3zm6 0a1.5 1.5 0 100 3 1.5 1.5 0 000-3z',
  book: 'M5 3h11a3 3 0 013 3v15H7a3 3 0 01-3-3V4zm2 14a1 1 0 000 2h10v-2z',
  pencil: 'M15 3l6 6L9 21H3v-6zM14 6l-9 9v3h3l9-9z',
};

export function icon(name: keyof typeof PATHS | string, size: number, cls = ''): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('class', `ss-icon ${cls}`);
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', PATHS[name] ?? PATHS.circle);
  p.setAttribute('fill', 'currentColor');
  svg.appendChild(p);
  return svg;
}

/** Procedural ruleset icon (Ruleset.CreateIcon()). */
export function rulesetIcon(rulesetId: number, size: number, cls = ''): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('class', `ss-icon ${cls}`);
  svg.setAttribute('aria-hidden', 'true');
  const add = (tag: string, attrs: Record<string, string | number>) => {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    svg.appendChild(e);
  };
  const stroke = { fill: 'none', stroke: 'currentColor', 'stroke-width': 2.4 };
  switch (rulesetId) {
    case 0:
      add('circle', { cx: 12, cy: 12, r: 9.5, ...stroke });
      add('circle', { cx: 12, cy: 12, r: 4.5, fill: 'currentColor' });
      break;
    case 1:
      add('circle', { cx: 12, cy: 12, r: 9.5, ...stroke });
      add('circle', { cx: 12, cy: 12, r: 5, ...stroke, 'stroke-width': 2 });
      add('line', { x1: 12, y1: 2.5, x2: 12, y2: 21.5, stroke: 'currentColor', 'stroke-width': 2 });
      break;
    case 2:
      add('circle', { cx: 12, cy: 12, r: 9.5, ...stroke });
      add('circle', { cx: 9, cy: 9.5, r: 2.4, fill: 'currentColor' });
      add('circle', { cx: 15, cy: 9.5, r: 2.4, fill: 'currentColor' });
      add('circle', { cx: 12, cy: 15.5, r: 2.4, fill: 'currentColor' });
      break;
    default:
      add('circle', { cx: 12, cy: 12, r: 9.5, ...stroke });
      for (const x of [8, 12, 16]) add('rect', { x: x - 1.1, y: 6.5, width: 2.2, height: 11, rx: 1.1, fill: 'currentColor' });
      break;
  }
  return svg;
}
