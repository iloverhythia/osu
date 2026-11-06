// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Tiny DOM helper.

type Attrs = Record<string, unknown> & { class?: string; style?: string | Partial<CSSStyleDeclaration> };
type Child = Node | string | number | null | undefined | false | Child[];

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = String(v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      else if (k in el && typeof v !== 'string') (el as unknown as Record<string, unknown>)[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el: Node, children: Child[]): void {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  }
}

export function clear(el: Node): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export const formatTime = (ms: number): string => {
  const neg = ms < 0;
  const s = Math.floor(Math.abs(ms) / 1000);
  return `${neg ? '-' : ''}${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export const formatNumber = (n: number): string => Math.round(n).toLocaleString('en-US');

/** osu!'s star rating colour spectrum (OsuColour.ForStarDifficulty). */
export function starColour(stars: number): string {
  const stops: [number, string][] = [
    [0.1, '#aaaaaa'],
    [0.1, '#4290fb'],
    [1.25, '#4fc0ff'],
    [2.0, '#4fffd5'],
    [2.5, '#7cff4f'],
    [3.3, '#f6f05c'],
    [4.2, '#ff8068'],
    [4.9, '#ff4e6f'],
    [5.8, '#c645b8'],
    [6.7, '#6563de'],
    [7.7, '#18158e'],
    [9.0, '#000000'],
  ];
  if (stars < 0.1) return '#aaaaaa';
  for (let i = 1; i < stops.length; i++) {
    if (stars < stops[i][0]) {
      const [a, ca] = stops[i - 1];
      const [b, cb] = stops[i];
      const t = (stars - a) / (b - a || 1);
      return mix(ca, cb, t);
    }
  }
  return '#000000';
}

function mix(a: string, b: string, t: number): string {
  const pa = [1, 3, 5].map(i => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map(i => parseInt(b.slice(i, i + 2), 16));
  return '#' + pa.map((v, i) => Math.round(v + (pb[i] - v) * t).toString(16).padStart(2, '0')).join('');
}

export function starTextColour(stars: number): string {
  return stars >= 6.5 ? '#ffd966' : '#1a1420';
}

export function keyLabel(code: string): string {
  if (code === 'Mouse0') return 'M1';
  if (code === 'Mouse2') return 'M2';
  if (code === 'Mouse1') return 'M3';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return 'Num' + code.slice(6);
  const map: Record<string, string> = {
    Space: 'Space',
    ShiftLeft: 'LShift',
    ShiftRight: 'RShift',
    ControlLeft: 'LCtrl',
    ControlRight: 'RCtrl',
    AltLeft: 'LAlt',
    AltRight: 'RAlt',
    ArrowLeft: '←',
    ArrowRight: '→',
    ArrowUp: '↑',
    ArrowDown: '↓',
    Semicolon: ';',
    Quote: "'",
    Comma: ',',
    Period: '.',
    Slash: '/',
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\',
    Minus: '-',
    Equal: '=',
    Backquote: '`',
    Enter: 'Enter',
    Tab: 'Tab',
    CapsLock: 'Caps',
  };
  return map[code] ?? code;
}
