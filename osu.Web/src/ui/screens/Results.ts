// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game/Screens/Ranking/ResultsScreen.cs + SoloResultsScreen.cs (lazer's default results screen; the
// skinnable Screens/RankingV2 one isn't used by default). The leaderboard shown beside the new score is the local one
// (stored scores for this beatmap + ruleset), as SoloResultsScreen shows for the local scope.

import { calculatePerformance } from '../../game/scoring/Performance';
import { Profiles } from '../../game/Profiles';
import { settings } from '../../framework/Settings';
import type { WorkingBeatmap } from '../../game/beatmaps/WorkingBeatmap';
import type { ModSet } from '../../game/mods/Mods';
import { calculateOsuDifficulty, calculateOsuPerformance, calculateOsuPerformanceAttributes } from '../../game/rulesets/osu/difficulty';
import type { OsuDifficultyAttributes } from '../../game/rulesets/osu/difficulty';
import type { OsuPlayableBeatmap } from '../../game/rulesets/osu/beatmap';
import type { PlayableBeatmap, Ruleset } from '../../game/rulesets/Ruleset';
import { HitResult } from '../../game/scoring/HitResult';
import type { HitEvent } from '../../game/scoring/ScoreProcessor';
import type { ScoreRank } from '../../game/scoring/ScoreRank';
import { Database } from '../../game/storage/Database';
import { h } from '../dom';
import type { Game } from '../Game';
import { Screen } from '../Screen';
import type { Replay } from '../../game/replays/Replay';
import { encodeOsr, replayToLegacyFrames } from '../../game/replays/LegacyReplay';
import { md5 } from '../../game/replays/md5';
import { findFile } from '../../game/storage/Importer';
import { icon } from '../menu/icons';
import { PanelState, type PanelContext } from '../ranking/ScorePanel';
import { ScorePanelList } from '../ranking/ScorePanelList';
import { scoreViewFromRecord, type ScoreView } from '../ranking/ScoreView';
import { StatisticsPanel, type PerformanceBreakdown, type StatisticsContext } from '../ranking/StatisticsPanel';
import '../ranking/ranking.css';

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
  /** The recorded (or watched) replay. */
  replay?: Replay | null;
  /** True when these results come from watching a replay (not saved again). */
  isReplay?: boolean;
}

type PerfScore = Parameters<typeof calculateOsuPerformance>[1];

function perfScore(statistics: ReadonlyMap<HitResult, number>, maxCombo: number, accuracy: number): PerfScore {
  const s = (r: HitResult) => statistics.get(r) ?? 0;
  return {
    count300: s(HitResult.Great),
    count100: s(HitResult.Ok),
    count50: s(HitResult.Meh),
    countMiss: s(HitResult.Miss),
    maxCombo,
    accuracy,
    sliderTailHits: s(HitResult.SliderTailHit),
    largeTickMisses: s(HitResult.LargeTickMiss),
  } as PerfScore;
}

/** Performance points (PerformanceCalculator for the score's ruleset). */
export function computePp(r: PlayResult): number | undefined {
  try {
    return calculatePerformance(r.ruleset.id, r.playable, { statistics: r.statistics, maxCombo: r.maxCombo, accuracy: r.accuracy, mods: r.mods });
  } catch {
    return undefined;
  }
}

/** TwoLayerButton.SIZE_EXTENDED.Y (the bottom panel height). */
const BOTTOM_PANEL_HEIGHT = 50;
const SCREEN_HEIGHT = 768 - BOTTOM_PANEL_HEIGHT;
const BACKGROUND_BLUR = 10;
const HOLD_TO_RETRY = 200;

export class ResultsScreen extends Screen {
  private readonly current: ScoreView;
  private readonly list: ScorePanelList;
  private readonly statistics: StatisticsPanel;
  private readonly scrollEl: HTMLDivElement;
  private readonly contentEl: HTMLDivElement;
  private readonly bottomPanel: HTMLDivElement;
  private readonly replayButton: HTMLButtonElement;
  private selected: ScoreView;
  private raf = 0;
  private enteredAt = 0;
  private retryHeldSince: number | null = null;
  private readonly difficultyCache = new Map<string, Promise<{ playable: PlayableBeatmap; attributes?: OsuDifficultyAttributes } | null>>();

  constructor(
    game: Game,
    private readonly result: PlayResult,
  ) {
    super(game, 'results');
    this.backgroundDim = 0.5;
    this.showTriangles = false;
    const r = result;
    this.current = {
      key: 'current',
      working: r.working,
      ruleset: r.ruleset,
      mods: r.mods,
      totalScore: r.totalScore,
      accuracy: r.accuracy,
      maxCombo: r.maxCombo,
      maximumCombo: r.maximumCombo,
      rank: r.passed ? r.rank : 'F',
      statistics: r.statistics,
      maximumStatistics: r.maximumStatistics,
      hitEvents: r.hitEvents,
      date: r.date,
      player: r.replay?.player ?? settings.get('ui.username', 'Guest'),
      pp: computePp(r),
      replay: r.replay ?? null,
      hasReplay: !!r.replay && r.replay.events.length > 0,
      isNewLocalScore: true,
    };
    this.selected = this.current;

    const playSample = (name: string, volume: number, rate = 1) => {
      const audio = this.game.audio;
      const b = audio?.getDefaultSample(name);
      if (audio && b) audio.play(b, { volume, rate });
    };
    const panelCtx: PanelContext = {
      playSample,
      playApplause: () => undefined, // Results/applause-* samples have no synthesised stand-in.
      starRating: s => this.starRating(s),
      performance: s => this.performance(s),
      isRanked: s => s.mods.isRanked,
    };
    const statsCtx: StatisticsContext = {
      breakdown: s => this.breakdown(s),
      replayButton: s => (this.canWatch(s) ? this.createReplayButton(s, 1.5) : null),
    };

    this.statistics = new StatisticsPanel(statsCtx, (n, v) => playSample(n, v));
    this.statistics.onToggle = () => this.toggleStatistics();
    this.list = new ScorePanelList(panelCtx);
    this.list.postExpandAction = () => this.toggleStatistics();
    this.list.onSelectedChanged = s => {
      this.selected = s;
      this.statistics.setScore(s, performance.now());
      this.updateReplayButton();
    };

    this.contentEl = h('div', { class: 'results-content' }, this.statistics.el, this.list.el);
    this.scrollEl = h('div', { class: 'results-scroll' }, this.contentEl);

    this.replayButton = this.createReplayButton(null, 1);
    this.replayButton.classList.add('wide');
    const buttons = h(
      'div',
      { class: 'results-buttons' },
      this.replayButton,
      h('button', { class: 'animated-button green wide', title: r.isReplay ? 'replay' : 'retry', onclick: () => void this.retry() }, icon('redo', 'animated-button-icon')),
      // Downloads are blocked inside the artifact viewer, so the .osr export is only offered on the full site.
      r.replay && r.replay.events.length > 0 && r.ruleset.id !== 2 && import.meta.env.VITE_TARGET !== 'artifact'
        ? h('button', { class: 'animated-button', title: 'Export .osr', onclick: () => void this.exportOsr() }, icon('export', 'animated-button-icon'))
        : null,
    );
    this.bottomPanel = h('div', { class: 'results-bottom' }, buttons);
    const back = h('button', { class: 'results-back', onclick: () => this.game.back() }, h('span', { class: 'results-back-icon' }, '‹'), h('span', null, 'back'));
    this.el.append(this.scrollEl, this.bottomPanel, back);
    if (!r.mods.isRanked && !r.isReplay) this.el.appendChild(h('div', { class: 'results-unranked-note' }, 'Score not saved (unranked mods)'));

    // ScorePanelList.AddScore(Score, shouldFlair): flair only when arriving from a play that isn't autoplay.
    const panel = this.list.addScore(this.current, !r.mods.isAutoplay);
    this.list.select(panel);
    this.statistics.setScore(this.current, performance.now());
    this.updateReplayButton();
  }

  onEnter(): void {
    const t = performance.now();
    this.enteredAt = t;
    // ApplyToBackground: BlurAmount = BACKGROUND_BLUR, FadeColour(Gray(0.5), 250).
    this.game.setBackgroundDim(0.5, BACKGROUND_BLUR);
    void this.game.startPreview();
    this.game.playUiSample('menu-confirm', 0.3); // UI/overlay-pop-in
    void this.fetchAndSave();
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      this.update(performance.now());
    };
    this.raf = requestAnimationFrame(loop);
  }

  onExit(): void {
    cancelAnimationFrame(this.raf);
    this.game.setBackgroundDim(0.6, 0);
  }

  private update(now: number): void {
    const fit = Math.max(SCREEN_HEIGHT, this.scrollEl.clientHeight);
    this.contentEl.style.height = `${fit}px`;
    // bottomPanel.FadeTo(1, 250)
    this.bottomPanel.style.opacity = String(Math.min(1, (now - this.enteredAt) / 250));
    this.list.update(now);
    this.statistics.update(now);
    if (this.retryHeldSince != null && now - this.retryHeldSince >= HOLD_TO_RETRY) {
      this.retryHeldSince = null;
      void this.retry();
    }
  }

  // ---------------------------------------------------------------- scores

  private async fetchAndSave(): Promise<void> {
    const r = this.result;
    // SoloResultsScreen.FetchScores (local scope): the other stored scores of this beatmap in this ruleset.
    try {
      const records = (await Database.getScores(r.working.entry.hash)).filter(s => s.rulesetId === r.ruleset.id && !(s.date === r.date && s.totalScore === r.totalScore));
      const views = records.map(rec => scoreViewFromRecord(rec, r.working, r.ruleset, r.maximumStatistics, r.maximumCombo));
      const all = [...views, this.current].sort((a, b) => b.totalScore - a.totalScore);
      all.forEach((s, i) => (s.position = i + 1));
      for (const v of views.slice(0, 50)) this.list.addScore(v);
      const panel = this.list.panels.find(p => p.score === this.current);
      if (panel) panel.position = this.current.position;
      if (this.list.selected) this.list.select(this.list.selected);
    } catch {
      /* storage unavailable */
    }
    await this.save();
  }

  private async save(): Promise<void> {
    const r = this.result;
    if (!r.passed || !r.mods.isRanked || r.isReplay) return;
    try {
      const id = await Database.addScore({
        beatmapHash: r.working.entry.hash,
        rulesetId: r.ruleset.id,
        totalScore: r.totalScore,
        accuracy: r.accuracy,
        maxCombo: r.maxCombo,
        rank: r.rank,
        mods: r.mods.list,
        modSettings: r.mods.settings,
        statistics: Object.fromEntries([...r.statistics].map(([k, v]) => [HitResult[k], v])),
        maximumStatistics: Object.fromEntries([...r.maximumStatistics].map(([k, v]) => [HitResult[k], v])),
        date: r.date,
        pp: computePp(r),
        player: settings.get('ui.username', 'Guest'),
        profileId: Profiles.current().id,
        hasReplay: !!r.replay,
      });
      this.current.recordId = id;
      if (r.replay) await Database.putReplay(id, r.replay);
    } catch {
      /* storage unavailable */
    }
  }

  /** The playable beatmap (and osu! difficulty attributes) for a score's mods. */
  private difficulty(score: ScoreView): Promise<{ playable: PlayableBeatmap; attributes?: OsuDifficultyAttributes } | null> {
    const key = score.mods.toString();
    let p = this.difficultyCache.get(key);
    if (!p) {
      p = (async () => {
        try {
          const playable = key === this.result.mods.toString() ? this.result.playable : score.ruleset.createPlayable(await score.working.getBeatmap(), score.mods);
          const attributes = score.ruleset.id === 0 ? calculateOsuDifficulty(playable as OsuPlayableBeatmap) : undefined;
          return { playable, attributes };
        } catch {
          return null;
        }
      })();
      this.difficultyCache.set(key, p);
    }
    return p;
  }

  private async starRating(score: ScoreView): Promise<number | undefined> {
    const d = await this.difficulty(score);
    if (!d) return undefined;
    if (d.attributes) return d.attributes.starRating;
    try {
      return score.ruleset.starRating?.(d.playable);
    } catch {
      return undefined;
    }
  }

  private async performance(score: ScoreView): Promise<number | undefined> {
    if (score.pp !== undefined) return score.pp;
    const d = await this.difficulty(score);
    if (!d) return undefined;
    try {
      return calculatePerformance(score.ruleset.id, d.playable, { statistics: score.statistics, maxCombo: score.maxCombo, accuracy: score.accuracy, mods: score.mods });
    } catch {
      return undefined;
    }
  }

  /** PerformanceBreakdownChart.computePerformance: the score's performance and a perfect score's (BeatmapDifficultyCache). */
  private async breakdown(score: ScoreView): Promise<PerformanceBreakdown | undefined> {
    const d = await this.difficulty(score);
    if (!d?.attributes) return undefined;
    const achieved = calculateOsuPerformanceAttributes(d.attributes, perfScore(score.statistics, score.maxCombo, score.accuracy), score.mods);
    const perfect = calculateOsuPerformanceAttributes(d.attributes, perfScore(score.maximumStatistics, d.attributes.maxCombo, 1), score.mods);
    return {
      total: achieved.total,
      perfectTotal: perfect.total,
      attributes: [
        ['Aim', achieved.aim, perfect.aim],
        ['Speed', achieved.speed, perfect.speed],
        ['Accuracy', achieved.accuracy, perfect.accuracy],
        ['Flashlight Bonus', achieved.flashlight, perfect.flashlight],
        ['Reading', achieved.reading, perfect.reading],
      ],
    };
  }

  // ---------------------------------------------------------------- statistics

  private toggleStatistics(): void {
    const t = performance.now();
    this.statistics.toggle(t);
    this.list.setStatisticsVisible(this.statistics.isVisible, t);
    // Dim background: Gray(0.4) while shown, Gray(0.5) otherwise.
    this.game.setBackgroundDim(this.statistics.isVisible ? 0.6 : 0.5, BACKGROUND_BLUR);
  }

  // ---------------------------------------------------------------- replay / retry

  private canWatch(s: ScoreView): boolean {
    return s.hasReplay && (!!s.replay || s.recordId != null);
  }

  /** ReplayDownloadButton (locally available → green with a check; otherwise disabled). */
  private createReplayButton(score: ScoreView | null, scale: number): HTMLButtonElement {
    const b = h(
      'button',
      { class: 'animated-button replay-button', onclick: (e: Event) => (e.stopPropagation(), void this.watchReplay(score ?? this.selected)) },
      h('span', { class: 'replay-icons' }, icon('download', 'animated-button-icon'), icon('check', 'animated-button-icon check')),
    );
    if (scale !== 1) b.style.transform = `scale(${scale})`;
    if (score) this.setReplayButtonState(b, score);
    return b;
  }

  private setReplayButtonState(b: HTMLButtonElement, s: ScoreView): void {
    const local = this.canWatch(s);
    b.classList.toggle('green', local);
    b.classList.toggle('available', local);
    b.disabled = !local;
    b.title = local ? 'watch replay' : 'replay unavailable';
  }

  private updateReplayButton(): void {
    this.setReplayButtonState(this.replayButton, this.selected);
  }

  private async watchReplay(s: ScoreView): Promise<void> {
    if (!this.canWatch(s)) return;
    let replay = s.replay ?? null;
    if (!replay && s.recordId != null) replay = (await Database.getReplay(s.recordId).catch(() => undefined)) ?? null;
    if (!replay) return;
    const { PlayerScreen } = await import('./Player');
    this.game.replace(new PlayerScreen(this.game, s.working, s.ruleset, s.mods, replay));
  }

  /** Exports the replay in osu!stable's .osr format (LegacyScoreEncoder) so it can be opened in osu! / lazer. */
  private async exportOsr(): Promise<void> {
    const r = this.result;
    if (!r.replay) return;
    try {
      const blob = findFile(r.working.set.files, r.working.entry.filename);
      if (!blob) throw new Error('beatmap file missing');
      const beatmapMD5 = md5(new Uint8Array(await blob.arrayBuffer()));
      const s = r.statistics;
      const c = (x: HitResult) => s.get(x) ?? 0;
      // Legacy count mapping (ScoreInfoExtensions / LegacyScoreDecoder.SetCount*): mania uses geki = Perfect, katu = Good.
      const isMania = r.ruleset.id === 3;
      const bytes = encodeOsr(
        {
          rulesetId: r.ruleset.id,
          beatmapMD5,
          playerName: r.replay.player,
          count300: c(HitResult.Great),
          count100: c(HitResult.Ok),
          count50: c(HitResult.Meh),
          countGeki: isMania ? c(HitResult.Perfect) : 0,
          countKatu: isMania ? c(HitResult.Good) : 0,
          countMiss: c(HitResult.Miss),
          totalScore: r.totalScore,
          maxCombo: r.maxCombo,
          perfect: r.maxCombo === r.maximumCombo,
          mods: r.mods.list,
          date: r.date,
        },
        replayToLegacyFrames(r.replay),
      );
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/octet-stream' }));
      const a = document.createElement('a');
      const e = r.working.entry;
      a.href = url;
      a.download = `${r.replay.player} - ${e.artist} - ${e.title} [${e.difficultyName}] (${new Date(r.date).toISOString().slice(0, 10)}).osr`.replace(/[\\/:*?"<>|]/g, '_');
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (err) {
      this.game.toast(`Export failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  }

  /** RetryButton / HotkeyRetryOverlay: Player.Restart (a replay restarts the replay). */
  private async retry(): Promise<void> {
    const r = this.result;
    const { PlayerScreen } = await import('./Player');
    if (r.isReplay && r.replay) this.game.replace(new PlayerScreen(this.game, r.working, r.ruleset, r.mods, r.replay));
    else this.game.replace(new PlayerScreen(this.game, r.working, r.ruleset, r.mods));
  }

  // ---------------------------------------------------------------- input

  onKeyDown(e: KeyboardEvent): boolean {
    if (e.code === 'Backquote' && !e.repeat) {
      this.retryHeldSince = performance.now();
      return true;
    }
    if (e.code === 'KeyR' && e.ctrlKey) {
      void this.retry();
      return true;
    }
    if (e.repeat) return false;
    switch (e.code) {
      case 'Enter':
      case 'NumpadEnter':
        // GlobalAction.Select toggles the statistics of the selected score.
        if (this.list.selected?.state === PanelState.Expanded) this.toggleStatistics();
        return true;
      case 'ArrowLeft':
        if (!this.statistics.isVisible) this.list.selectPrevious();
        return true;
      case 'ArrowRight':
        if (!this.statistics.isVisible) this.list.selectNext();
        return true;
    }
    return false;
  }

  onKeyUp(e: KeyboardEvent): boolean {
    if (e.code === 'Backquote') {
      this.retryHeldSince = null;
      return true;
    }
    return false;
  }

  /** OnBackButton: hide the statistics first. */
  onBack(): boolean {
    if (this.statistics.isVisible) {
      this.toggleStatistics();
      return false;
    }
    return true;
  }
}
