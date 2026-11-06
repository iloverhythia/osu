// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game/Screens/Menu/LogoVisualisation.cs (+ MenuLogoVisualisation.cs: white for non-supporters).

import type { MenuBeatSource } from './BeatSync';

/** The number of bars to jump each update iteration. */
const INDEX_CHANGE = 5;
/** The maximum length of each bar in the visualiser. Will be reduced when kiai is not activated. */
const BAR_LENGTH = 600;
/** The number of bars in one rotation of the visualiser. */
const BARS_PER_VISUALISER = 200;
/** How many times we should stretch around the circumference (overlapping overselves). */
const VISUALISER_ROUNDS = 5;
/** How much should each bar go down each millisecond (based on a full bar). */
const DECAY_PER_MILLISECOND = 0.0024;
/** Number of milliseconds between each amplitude update. */
const TIME_BETWEEN_UPDATES = 50;
/** The minimum amplitude to show a bar. */
const AMPLITUDE_DEAD_ZONE = 1 / BAR_LENGTH;

const BAR_WIDTH_FACTOR = Math.sqrt(2 * (1 - Math.cos((360 / BARS_PER_VISUALISER) * (Math.PI / 180)))) / 2;

export class LogoVisualisation {
  private indexOffset = 0;
  private readonly frequencyAmplitudes = new Float32Array(256);
  private readonly temporalAmplitudes = new Float32Array(256);
  private nextUpdate = -1;

  constructor(private readonly source: MenuBeatSource) {}

  update(now: number, elapsed: number, frame: number): void {
    // Scheduler.AddDelayed(updateAmplitudes, 50, repeat: true) with PerformRepeatCatchUpExecutions = false.
    if (this.nextUpdate < 0) this.nextUpdate = now + TIME_BETWEEN_UPDATES;
    if (now >= this.nextUpdate) {
      this.updateAmplitudes(frame);
      this.nextUpdate += TIME_BETWEEN_UPDATES;
      if (this.nextUpdate <= now) this.nextUpdate = now + TIME_BETWEEN_UPDATES;
    }

    const decayFactor = elapsed * DECAY_PER_MILLISECOND;
    for (let i = 0; i < BARS_PER_VISUALISER; i++) {
      // 3% of extra bar length to make it a little faster when bar is almost at it's minimum
      this.frequencyAmplitudes[i] -= decayFactor * (this.frequencyAmplitudes[i] + 0.03);
      if (this.frequencyAmplitudes[i] < 0) this.frequencyAmplitudes[i] = 0;
    }
  }

  private updateAmplitudes(frame: number): void {
    const t = this.temporalAmplitudes;
    t.fill(0);
    const amps = this.source.currentAmplitudes(frame).frequencies;
    for (let i = 0; i < amps.length && i < t.length; i++) t[i] += amps[i];

    const kiaiMultiplier = this.source.isKiaiTime() ? 1 : 0.5;
    for (let i = 0; i < BARS_PER_VISUALISER; i++) {
      const target = t[(i + this.indexOffset) % BARS_PER_VISUALISER] * kiaiMultiplier;
      if (target > this.frequencyAmplitudes[i]) this.frequencyAmplitudes[i] = target;
    }
    this.indexOffset = (this.indexOffset + INDEX_CHANGE) % BARS_PER_VISUALISER;
  }

  /**
   * Draws additively (the caller's context should use 'lighter' compositing) around a circle of diameter `size`
   * centred at (cx, cy). `scale` converts local units (bar length) to pixels.
   */
  draw(g: CanvasRenderingContext2D, cx: number, cy: number, size: number, scale: number, alpha: number): void {
    if (alpha <= 0) return;
    const data = this.frequencyAmplitudes;
    const barWidth = size * BAR_WIDTH_FACTOR;
    g.fillStyle = `rgba(255,255,255,${0.2 * alpha})`;
    for (let j = 0; j < VISUALISER_ROUNDS; j++) {
      for (let i = 0; i < BARS_PER_VISUALISER; i++) {
        if (data[i] < AMPLITUDE_DEAD_ZONE) continue;
        const rotation = ((i / BARS_PER_VISUALISER) * 360 + (j * 360) / VISUALISER_ROUNDS) * (Math.PI / 180);
        const cos = Math.cos(rotation);
        const sin = Math.sin(rotation);
        const px = cx + (cos * size) / 2;
        const py = cy + (sin * size) / 2;
        const len = BAR_LENGTH * data[i] * scale;
        const bx = (-sin * barWidth) / 2;
        const by = (cos * barWidth) / 2;
        const ax = cos * len;
        const ay = sin * len;
        g.beginPath();
        g.moveTo(px - bx, py - by);
        g.lineTo(px - bx + ax, py - by + ay);
        g.lineTo(px + bx + ax, py + by + ay);
        g.lineTo(px + bx, py + by);
        g.closePath();
        g.fill();
      }
    }
  }
}
