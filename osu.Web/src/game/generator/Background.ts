// Abstract triangle background for generated beatmaps (seeded, so each song gets its own look).

import { createRng } from './RhythmGrid';

export async function renderGeneratedBackground(seed: number): Promise<Blob | null> {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = 1280;
  c.height = 720;
  const g = c.getContext('2d');
  if (!g) return null;
  const rnd = createRng(seed ^ 0x9e3779b9);
  const hue = 240 + rnd() * 90; // violet to magenta, around the JarvSU purple
  const grad = g.createLinearGradient(0, 0, 1280, 720);
  grad.addColorStop(0, `hsl(${hue}, 55%, 14%)`);
  grad.addColorStop(0.55, `hsl(${hue + 25}, 50%, 24%)`);
  grad.addColorStop(1, `hsl(${hue - 40}, 60%, 12%)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, 1280, 720);
  for (let i = 0; i < 90; i++) {
    const x = rnd() * 1280;
    const y = rnd() * 720;
    const s = 16 + rnd() * 130;
    g.globalAlpha = 0.04 + rnd() * 0.12;
    g.fillStyle = `hsl(${hue + (rnd() - 0.5) * 60}, 90%, ${55 + rnd() * 20}%)`;
    g.beginPath();
    g.moveTo(x, y - s);
    g.lineTo(x + s * 0.87, y + s * 0.5);
    g.lineTo(x - s * 0.87, y + s * 0.5);
    g.closePath();
    g.fill();
  }
  g.globalAlpha = 1;
  return new Promise(resolve => c.toBlob(b => resolve(b), 'image/jpeg', 0.85));
}
