// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Results screen (port of the essentials of ResultsScreen / statistics panel).

import { settings } from '../../framework/Settings';
import type { WorkingBeatmap } from '../../game/beatmaps/WorkingBeatmap';
import type { ModSet } from '../../game/mods/Mods';
import { calculateOsuDifficulty, calculateOsuPerformance } from '../../game/rulesets/osu/difficulty';
import type { OsuPlayableBeatmap } from '../../game/rulesets/osu/beatmap';
import type { PlayableBeatmap, Ruleset } from '../../game/rulesets/Ruleset';
import { HitResult, isBasic, isHit } from '../../game/scoring/HitResult';
import type { HitEvent } from '../../game/scoring/ScoreProcessor';
import { RANK_COLOURS, RANK_DISPLAY, type ScoreRank } from '../../game/scoring/ScoreRank';
import { Database } from '../../game/storage/Database';
import { formatNumber, h } from '../dom';
import type { Game } from '../Game';
import { Screen } from '../Screen';

export interface PlayResult {
  working: WorkingBeatmap;
  ruleset: Ruleset;
  mods: ModSet;
  playable: PlayableBeatmap;
  totalScore: number;
  accuracy: number;
  maxCombo: number;
  maximumCombo: number;
  rank: ScoreRank;
  statistics: Map<HitResult, number>;
  maximumStatistics: Map<HitResult, number>;
  hitEvents: HitEvent[];
  date: number;
  passed: boolean;
}

/** Performance points (only implemented for osu! standard). */
export function computePp(r: PlayResult): number | undefined {
  if (r.ruleset.id !== 0) return undefined;
  try {
    const attributes = calculateOsuDifficulty(r.playable as OsuPlayableBeatmap);
    const s = r.statistics;
    return calculateOsuPerformance(
      attributes,
      {
        count300: s.get(HitResult.Great) ?? 0,
        count100: s.get(HitResult.Ok) ?? 0,
        count50: s.get(HitResult.Meh) ?? 0,
        countMiss: s.get(HitResult.Miss) ?? 0,
        maxCombo: r.maxCombo,
        accuracy: r.accuracy,
        sliderTailHits: s.get(HitResult.SliderTailHit) ?? 0,
        largeTickMisses: s.get(HitResult.LargeTickMiss) ?? 0,
      } as Parameters<typeof calculateOsuPerformance>[1],
      r.mods,
    );
  } catch {
    return undefined;
  }
}

export class ResultsScreen extends Screen {
  constructor(
    game: Game,
    private readonly result: PlayResult,
  ) {
    super(game, 'results');
    this.backgroundDim = 0.75;
    this.build();
  }

  onEnter(): void {
    this.game.setBackgroundDim(0.75, 8);
    void this.game.startPreview();
    void this.save();
  }

  onExit(): void {
    this.game.setBackgroundDim(0.6, 0);
  }

  private async save(): Promise<void> {
    const r = this.result;
    if (!r.passed || !r.mods.isRanked) return;
    try {
      await Database.addScore({
        beatmapHash: r.working.entry.hash,
        rulesetId: r.ruleset.id,
        totalScore: r.totalScore,
        accuracy: r.accuracy,
        maxCombo: r.maxCombo,
        rank: r.rank,
        mods: r.mods.list,
        statistics: Object.fromEntries([...r.statistics].map(([k, v]) => [HitResult[k], v])),
        date: r.date,
        pp: computePp(r),
        player: settings.get('ui.username', 'Guest'),
      });
    } catch {
      /* storage unavailable */
    }
  }

  private build(): void {
    const r = this.result;
    const e = r.working.entry;
    const pp = computePp(r);
    const rankColour = RANK_COLOURS[r.rank];

    const counts = r.ruleset.displayedResults
      .filter(res => (r.maximumStatistics.get(res) ?? 0) > 0 || (r.statistics.get(res) ?? 0) > 0 || isBasic(res))
      .map(res => {
        const max = r.maximumStatistics.get(res) ?? 0;
        const value = r.statistics.get(res) ?? 0;
        const showMax = !isBasic(res) && max > 0;
        return stat(r.ruleset.resultLabel(res), showMax ? `${value}/${max}` : String(value));
      });

    // Timing statistics (HitEventExtensions.CalculateUnstableRate / CalculateAverageHitError)
    const timed = r.hitEvents.filter(ev => isBasic(ev.result) && isHit(ev.result));
    const offsets = timed.map(ev => ev.timeOffset / (ev.gameplayRate || 1));
    const mean = offsets.length ? offsets.reduce((a, b) => a + b, 0) / offsets.length : 0;
    const ur = offsets.length > 1 ? Math.sqrt(offsets.reduce((a, b) => a + (b - mean) ** 2, 0) / offsets.length) * 10 : 0;

    const graph = h('canvas', { class: 'hit-graph' });

    const card = h(
      'div',
      { class: 'panel results-card' },
      h('div', null, h('div', { class: 'results-rank', style: { color: rankColour } }, r.passed ? RANK_DISPLAY[r.rank] : 'F')),
      h(
        'div',
        null,
        h('div', { class: 'ss-title' }, e.title),
        h('div', { class: 'ss-artist' }, `${e.artist} · [${e.difficultyName}] · ${r.ruleset.name}`),
        h('div', { class: 'results-score' }, formatNumber(r.totalScore)),
        r.mods.isEmpty ? null : h('div', { class: 'mod-pills' }, r.mods.list.map(m => h('span', { class: 'mod-pill', style: { background: '#ffcc22' } }, m))),
        h(
          'div',
          { class: 'results-stats' },
          stat('Accuracy', `${(r.accuracy * 100).toFixed(2)}%`),
          stat('Max combo', `${r.maxCombo}x / ${r.maximumCombo}x`),
          pp !== undefined ? stat('Performance', `${Math.round(pp)}pp`) : null,
          ...counts,
          offsets.length > 1 ? stat('Unstable rate', ur.toFixed(2)) : null,
          offsets.length > 0 ? stat('Avg. hit error', `${mean >= 0 ? '+' : ''}${mean.toFixed(1)}ms`) : null,
        ),
        offsets.length > 0 ? graph : null,
        h(
          'div',
          { class: 'results-actions' },
          h('button', { class: 'btn primary', onclick: () => this.retry() }, 'Retry'),
          h('button', { class: 'btn', onclick: () => this.game.back() }, 'Back to song select'),
          !r.mods.isRanked ? h('span', { style: { color: 'var(--fg-dim)', alignSelf: 'center', fontSize: '13px' } }, 'Score not saved (unranked mods)') : null,
        ),
      ),
    );
    this.el.appendChild(card);
    requestAnimationFrame(() => drawHitGraph(graph, offsets));
  }

  private async retry(): Promise<void> {
    const { PlayerScreen } = await import('./Player');
    this.game.replace(new PlayerScreen(this.game, this.result.working, this.result.ruleset, this.result.mods));
  }

  onKeyDown(e: KeyboardEvent): boolean {
    if (e.code === 'Backquote' || (e.code === 'KeyR' && e.ctrlKey)) {
      void this.retry();
      return true;
    }
    if (e.code === 'Enter') {
      this.game.back();
      return true;
    }
    return false;
  }
}

function stat(label: string, value: string): HTMLElement {
  return h('div', { class: 'stat' }, h('div', { class: 'stat-label' }, label), h('div', { class: 'stat-value' }, value));
}

/** Hit offset distribution histogram (HitEventTimingDistributionGraph). */
function drawHitGraph(canvas: HTMLCanvasElement, offsets: number[]): void {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const hgt = canvas.clientHeight;
  if (!w || !hgt || offsets.length === 0) return;
  canvas.width = w * dpr;
  canvas.height = hgt * dpr;
  const g = canvas.getContext('2d')!;
  g.scale(dpr, dpr);
  const range = Math.max(20, ...offsets.map(o => Math.abs(o)));
  const bins = 51;
  const counts = new Array(bins).fill(0);
  for (const o of offsets) counts[Math.min(bins - 1, Math.max(0, Math.round(((o + range) / (2 * range)) * (bins - 1))))]++;
  const max = Math.max(...counts);
  const bw = w / bins;
  for (let i = 0; i < bins; i++) {
    const bh = (counts[i] / max) * (hgt - 16);
    const d = Math.abs(i - (bins - 1) / 2) / ((bins - 1) / 2);
    g.fillStyle = d < 0.33 ? '#66ccff' : d < 0.66 ? '#b3d944' : '#ffcc22';
    g.fillRect(i * bw + 1, hgt - 14 - bh, bw - 2, Math.max(1, bh));
  }
  g.fillStyle = 'rgba(255,255,255,0.6)';
  g.font = '11px "Exo 2", sans-serif';
  g.textAlign = 'left';
  g.fillText(`-${Math.round(range)}ms (early)`, 0, hgt - 1);
  g.textAlign = 'right';
  g.fillText(`+${Math.round(range)}ms (late)`, w, hgt - 1);
  g.textAlign = 'center';
  g.fillText('0', w / 2, hgt - 1);
}
