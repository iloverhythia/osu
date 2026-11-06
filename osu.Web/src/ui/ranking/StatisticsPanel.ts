// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Ports of osu.Game/Screens/Ranking/Statistics/StatisticsPanel.cs, StatisticItem.cs, StatisticItemContainer.cs,
// StatisticItemHeader.cs, HitEventTimingDistributionGraph.cs, SimpleStatisticTable.cs, SimpleStatisticItem.cs,
// AverageHitError.cs, UnstableRate.cs, PerformanceBreakdownChart.cs, and the rulesets' CreateStatisticsForScore.
// Not ported: OsuRuleset's AccuracyHeatmap, the online-only OverallRanking and beatmap tags items; the breakdown is only
// available for osu! (the only ruleset with a performance calculator in this port).

import { HitCircle, SliderEndCircle } from '../../game/rulesets/osu/objects';
import { Hit } from '../../game/rulesets/taiko/objects';
import type { HitResult } from '../../game/scoring/HitResult';
import type { HitEvent } from '../../game/scoring/ScoreProcessor';
import { applyEasing, Easing } from '../../game/storyboard/Easing';
import { h } from '../dom';
import {
  binTimingDistribution,
  calculateAverageHitError,
  calculateUnstableRate,
  formatHitError,
  formatUnstableRate,
  hitResultColour,
  indexForOrderedDisplay,
  TIMING_DISTRIBUTION_BINS,
  TIMING_DISTRIBUTION_CENTRE_BIN_INDEX,
  timingBinSize,
  timingGraphEvents,
} from './RankingLogic';
import type { ScoreView } from './ScoreView';

export const SIDE_PADDING = 20;
export const FONT_SIZE = 13;

export interface PerformanceBreakdown {
  /** [display name, achieved, perfect] for each attribute (GetAttributesForDisplay, without Total). */
  attributes: [string, number, number][];
  total: number;
  perfectTotal: number;
}

interface StatisticItem {
  name: string;
  create: () => { el: HTMLElement; update?: (now: number) => void };
  requiresHitEvents: boolean;
  fullWidth: boolean;
}

export interface StatisticsContext {
  breakdown: (score: ScoreView) => Promise<PerformanceBreakdown | undefined>;
  /** ReplayDownloadButton placeholder action ("watch the replay"), if the score has one. */
  replayButton: (score: ScoreView) => HTMLElement | null;
}

/** The ruleset's CreateStatisticsForScore. */
function createStatisticItems(score: ScoreView, ctx: StatisticsContext): StatisticItem[] {
  const items: StatisticItem[] = [];
  const breakdown: StatisticItem = { name: 'Performance Breakdown', create: () => performanceBreakdownChart(score, ctx), requiresHitEvents: false, fullWidth: true };
  const timing = (events: HitEvent[]): StatisticItem => ({
    name: 'Timing Distribution',
    create: () => {
      const graph = new HitEventTimingDistributionGraph(events);
      return {
        el: h('div', { class: 'timing-distribution' }, graph.el, simpleStatisticTable([['Average Hit Error', formatHitError(calculateAverageHitError(events))], ['Unstable Rate', formatUnstableRate(calculateUnstableRate(events))]])),
        update: now => graph.update(now),
      };
    },
    requiresHitEvents: true,
    fullWidth: false,
  });

  switch (score.ruleset.id) {
    case 0:
      items.push(breakdown, timing(score.hitEvents.filter(e => e.hitObject instanceof HitCircle && !(e.hitObject instanceof SliderEndCircle))));
      break;
    case 1:
      items.push(timing(score.hitEvents.filter(e => e.hitObject instanceof Hit)));
      break;
    case 3:
      items.push(timing(score.hitEvents));
      break;
  }
  return items;
}

export class StatisticsPanel {
  readonly el: HTMLDivElement;
  private readonly content: HTMLDivElement;
  private visible = false;
  private alpha = { from: 0, to: 0, start: 0, duration: 0, easing: Easing.None };
  private contentAlpha = { start: Infinity };
  private updaters: ((now: number) => void)[] = [];
  private wasOpened = false;
  private score: ScoreView | null = null;
  onToggle: (() => void) | null = null;

  constructor(
    private readonly ctx: StatisticsContext,
    private readonly playSample: (name: string, volume: number) => void,
  ) {
    this.content = h('div', { class: 'statistics-content' });
    this.el = h('div', { class: 'statistics-panel' }, this.content);
    this.el.addEventListener('click', () => this.onToggle?.());
    this.el.style.display = 'none';
  }

  get isVisible(): boolean {
    return this.visible;
  }

  /** Score.BindValueChanged(populateStatistics). */
  setScore(score: ScoreView | null, now: number): void {
    if (score === this.score) return;
    this.score = score;
    this.content.replaceChildren();
    this.updaters = [];
    if (!score) return;

    const hitEventsAvailable = score.hitEvents.length !== 0;
    const items = createStatisticItems(score, this.ctx);
    let container: HTMLElement;
    if (!hitEventsAvailable && items.every(i => i.requiresHitEvents)) {
      container = h('div', { class: 'statistics-placeholder-flow' }, messagePlaceholder('Extended statistics are only available after watching a replay!'), this.ctx.replayButton(score));
    } else {
      const flow = h('div', { class: 'statistics-flow' });
      let anyRequired = false;
      for (const item of items) {
        if (!hitEventsAvailable && item.requiresHitEvents) {
          anyRequired = true;
          continue;
        }
        const c = item.create();
        if (c.update) this.updaters.push(c.update);
        flow.appendChild(statisticItemContainer(item, c.el));
      }
      if (anyRequired) flow.appendChild(h('div', { class: 'statistics-more' }, messagePlaceholder('More statistics available after watching a replay!'), this.ctx.replayButton(score)));
      container = flow;
    }
    this.content.appendChild(container);
    // d.FadeIn(250, OutQuint)
    this.contentAlpha = { start: now };
  }

  toggle(now: number): void {
    if (this.visible) this.hide(now);
    else this.show(now);
  }

  show(now: number): void {
    if (this.visible) return;
    this.visible = true;
    this.alpha = { from: this.currentAlpha(now), to: 1, start: now, duration: 350, easing: Easing.OutQuint };
    this.playSample('menu-click', 0.5); // Results/statistics-panel-pop-in
    this.wasOpened = true;
  }

  hide(now: number): void {
    if (!this.visible) return;
    this.visible = false;
    this.alpha = { from: this.currentAlpha(now), to: 0, start: now, duration: 250, easing: Easing.OutQuint };
    if (this.wasOpened) this.playSample('menu-back', 0.4); // Results/statistics-panel-pop-out
  }

  private currentAlpha(now: number): number {
    const a = this.alpha;
    if (now >= a.start + a.duration || a.duration <= 0) return a.to;
    return a.from + (a.to - a.from) * applyEasing(a.easing, (now - a.start) / a.duration);
  }

  update(now: number): void {
    const a = this.currentAlpha(now);
    this.el.style.display = a > 0 ? '' : 'none';
    this.el.style.opacity = String(a);
    this.el.style.pointerEvents = this.visible ? 'auto' : 'none';
    this.content.style.opacity = String(applyEasing(Easing.OutQuint, Math.min(1, Math.max(0, (now - this.contentAlpha.start) / 250))));
    if (a > 0) for (const u of this.updaters) u(now);
  }
}

function messagePlaceholder(text: string): HTMLElement {
  return h('div', { class: 'message-placeholder' }, text);
}

/** StatisticItemContainer + StatisticItemHeader. */
function statisticItemContainer(item: StatisticItem, content: HTMLElement): HTMLElement {
  return h(
    'div',
    { class: `statistic-item${item.fullWidth ? ' full' : ''}` },
    h(
      'div',
      { class: 'statistic-item-box' },
      h('div', { class: 'statistic-item-body' }, content),
      h('div', { class: 'statistic-item-fade-top' }),
      h('div', { class: 'statistic-item-fade-bottom' }),
      item.name ? h('div', { class: 'statistic-item-header' }, h('span', null, item.name)) : null,
    ),
  );
}

/** SimpleStatisticTable(1, items). */
function simpleStatisticTable(items: [string, string][]): HTMLElement {
  return h(
    'div',
    { class: 'simple-statistic-table' },
    items.map(([name, value]) => h('div', { class: 'simple-statistic-item' }, h('span', null, name), h('b', null, value))),
  );
}

/** PerformanceBreakdownChart. */
function performanceBreakdownChart(score: ScoreView, ctx: StatisticsContext): { el: HTMLElement } {
  const chart = h('div', { class: 'pb-chart' });
  const achieved = h('span', { class: 'pb-achieved' });
  const maximum = h('span', { class: 'pb-maximum' });
  const spinner = h('div', { class: 'loading-spinner' });
  const content = h(
    'div',
    { class: 'pb-content', style: { opacity: '0' } },
    chart,
    h('div', { class: 'simple-statistic-spacer' }),
    h('div', { class: 'pb-totals' }, h('span', { class: 'pb-achieved' }, 'Achieved PP'), achieved, h('span', { class: 'pb-maximum' }, 'Maximum'), maximum),
  );
  const el = h('div', { class: 'performance-breakdown' }, spinner, content);
  void ctx.breakdown(score).then(b => {
    if (!b) return;
    spinner.remove();
    content.style.transition = 'opacity 0.2s';
    content.style.opacity = '1';
    achieved.textContent = String(Math.round(b.total));
    maximum.textContent = String(Math.round(b.perfectTotal));
    for (const [name, value, perfect] of b.attributes) {
      // Don't display the attribute if its maximum is 0 (e.g. flashlight without the mod).
      if (Math.abs(perfect) < 1e-3) continue;
      const percentage = value / perfect;
      chart.append(
        h('span', { class: 'pb-name' }, name),
        h('div', { class: 'pb-bar' }, h('div', { style: { width: `${Math.max(0, Math.min(1, percentage)) * 100}%` } })),
        h('span', { class: 'pb-percent' }, `${Math.round(percentage * 100)}%`),
      );
    }
  });
  return { el };
}

const MINIMUM_HEIGHT = 0.02;
const BAR_DURATION = 300;
const AXIS_POINTS = 5;

/** HitEventTimingDistributionGraph (bars animate in with OutQuint over 300ms). */
class HitEventTimingDistributionGraph {
  readonly el: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly bins: { result: HitResult; count: number }[][];
  private readonly maxCount: number;
  private readonly binSize: number;
  private start: number | null = null;

  constructor(hitEvents: HitEvent[]) {
    const events = timingGraphEvents(hitEvents);
    this.binSize = timingBinSize(events);
    const bins = events.length ? binTimingDistribution(events, this.binSize) : [];
    this.bins = bins.map(b => [...b.entries()].map(([result, count]) => ({ result, count })).sort((x, y) => indexForOrderedDisplay(x.result) - indexForOrderedDisplay(y.result)));
    this.maxCount = Math.max(0, ...this.bins.map(b => b.reduce((a, v) => a + v.count, 0)));
    this.canvas = h('canvas', { class: 'timing-graph-canvas' });
    const axis = h('div', { class: 'timing-axis' });
    if (events.length) {
      const maxValue = TIMING_DISTRIBUTION_BINS * this.binSize;
      const step = maxValue / AXIS_POINTS;
      axis.appendChild(h('span', { class: 'centre', style: { left: '50%' } }, '0'));
      for (let i = 1; i <= AXIS_POINTS; i++) {
        const value = i * step;
        const position = maxValue === 0 ? 0 : value / maxValue;
        const alpha = String(1 - position * 0.8);
        axis.appendChild(h('span', { style: { left: `${50 - position * 50}%`, opacity: alpha } }, `-${Math.round(value)}`));
        axis.appendChild(h('span', { style: { left: `${50 + position * 50}%`, opacity: alpha } }, `+${Math.round(value)}`));
      }
    }
    this.el = h('div', { class: 'timing-graph' }, this.canvas, axis);
  }

  update(now: number): void {
    if (this.bins.length === 0) return;
    this.start ??= now;
    const c = this.canvas;
    const w = c.clientWidth;
    const hh = c.clientHeight;
    if (!w || !hh) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(hh * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(hh * dpr);
    }
    const t = (now - this.start) / BAR_DURATION;
    if (t > 1.5 && c.dataset.done === '1') return;
    c.dataset.done = t > 1.5 ? '1' : '0';
    const k = applyEasing(Easing.OutQuint, Math.min(1, t));
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, hh);

    // Pink markers above and below the centre bar take 4px each.
    const top = 5;
    const barH = hh - 10;
    const bw = w / this.bins.length;
    const offsetFor = (v: number) => (this.maxCount === 0 ? 0 : ((1 - MINIMUM_HEIGHT) * v) / this.maxCount);
    const heightFor = (v: number) => MINIMUM_HEIGHT + offsetFor(v);
    const pill = (x: number, y: number, width: number, height: number, colour: string) => {
      if (height <= 0) return;
      g.fillStyle = colour;
      g.beginPath();
      g.roundRect(x, y, width, height, Math.min(width, height) / 2);
      g.fill();
    };

    for (let i = 0; i < this.bins.length; i++) {
      const values = this.bins[i];
      const isCentre = i === TIMING_DISTRIBUTION_CENTRE_BIN_INDEX;
      const x = i * bw;
      const bottom = top + barH;
      if (values.length === 0) {
        // A bin with no value draws a grey dot instead.
        const hgt = heightFor(0) * barH * k;
        pill(x, bottom - hgt, bw, hgt, isCentre ? '#ffffff' : '#808080');
      } else {
        // Stacked from the bottom; the bottom bar is drawn in front (drawn last).
        let offset = 0;
        const boxes: [number, number, string][] = [];
        values.forEach((v, j) => {
          const hgt = heightFor(v.count) * barH * k;
          const y = bottom + offsetFor(offset) * barH * k - hgt;
          boxes.push([y, hgt, isCentre && j === 0 ? '#ffffff' : hitResultColour(v.result)]);
          offset -= v.count;
        });
        for (let j = boxes.length - 1; j >= 0; j--) pill(x, boxes[j][0], bw, boxes[j][1], boxes[j][2]);
      }
      if (isCentre) {
        pill(x, top - 1 - 4, bw, 4, '#ffc0cb');
        pill(x, bottom, bw, 4, '#ffc0cb');
      }
    }
  }
}
