// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game/Online/Leaderboards/DrawableRank.cs: a pill in the rank colour with triangles and the rank letter.
// Venera (OsuFont.Numeric) is substituted by Exo 2 ExtraBold.

import type { ScoreRank } from '../../game/scoring/ScoreRank';
import { hexToRgb, TrianglesV1, type RGB } from '../Triangles';
import { rankColour, rankLetter, rankLetterColour } from './RankingLogic';

/** Color4Extensions.Darken / Lighten. */
const darken = (c: RGB, amount: number): RGB => c.map(v => v / Math.max(1, 1 + amount)) as RGB;
const lighten = (c: RGB, amount: number): RGB => c.map(v => Math.min(255, v * (1 + amount))) as RGB;

export class DrawableRank {
  private readonly triangles = new TrianglesV1();

  constructor(readonly rank: ScoreRank) {
    const c = hexToRgb(rankColour(rank));
    this.triangles.setColours(darken(c, 0.1), lighten(c, 0.1));
    this.triangles.velocity = 0.25;
  }

  update(elapsed: number): void {
    this.triangles.update(elapsed, 64, 32);
  }

  /** Draws fit (aspect 2) into the box centred at (cx, cy) with the given width. */
  draw(g: CanvasRenderingContext2D, cx: number, cy: number, width: number, alpha = 1): void {
    if (alpha <= 0) return;
    // DrawSizePreservingFillContainer(TargetDrawSize 64x32): draw in 64x32 space, scaled.
    const k = width / 64;
    g.save();
    g.translate(cx - 32 * k, cy - 16 * k);
    g.scale(k, k);
    g.globalAlpha *= alpha;
    g.beginPath();
    g.roundRect(0, 0, 64, 32, 16);
    g.save();
    g.clip();
    g.fillStyle = rankColour(this.rank);
    g.fillRect(0, 0, 64, 32);
    this.triangles.draw(g, 0, 0, 64, 32, 1);
    g.restore();
    const [top, bottom] = rankLetterColour(this.rank);
    const grad = g.createLinearGradient(0, 4, 0, 30);
    grad.addColorStop(0, top);
    grad.addColorStop(1, bottom);
    g.font = '800 25px "Exo 2", sans-serif';
    g.textBaseline = 'middle';
    g.textAlign = 'center';
    const text = rankLetter(this.rank);
    const letterSpacing = -1; // -3 with Venera's wider glyphs
    const widths = [...text].map(ch => g.measureText(ch).width);
    const total = widths.reduce((a, b) => a + b, 0) + letterSpacing * (text.length - 1);
    let x = 32 - total / 2;
    g.shadowColor = 'rgba(0,0,0,0.3)';
    g.shadowOffsetY = 0.08 * 25 * k;
    g.fillStyle = grad;
    [...text].forEach((ch, i) => {
      g.fillText(ch, x + widths[i] / 2, 16 + 2.5);
      x += widths[i] + letterSpacing;
    });
    g.restore();
  }
}
