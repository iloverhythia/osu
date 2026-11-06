// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Ports of osu.Game/Screens/Ranking/ScorePanel.cs, Expanded/ExpandedPanelMiddleContent.cs, Expanded/ExpandedPanelTopContent.cs,
// Expanded/PlayedOnText.cs, Expanded/TotalScoreCounter.cs, Expanded/Statistics/* (StatisticDisplay, AccuracyStatistic,
// ComboStatistic, CounterStatistic, HitResultStatistic, PerformanceStatistic, StatisticCounter),
// Contracted/ContractedPanelMiddleContent.cs, Contracted/ContractedPanelTopContent.cs and
// osu.Game/Beatmaps/Drawables/StarRatingDisplay.cs. Torus is substituted by Exo 2.

import { getDisplayScore } from '../../game/scoring/DisplayScore';
import { MOD_BY_ACRONYM, MOD_TYPE_COLOURS } from '../../game/mods/Mods';
import { HitResult } from '../../game/scoring/HitResult';
import type { ScoreRank } from '../../game/scoring/ScoreRank';
import { applyEasing, Easing } from '../../game/storyboard/Easing';
import { h, starColour } from '../dom';
import { icon } from '../menu/icons';
import { AccuracyCircle, type PlaySample } from './AccuracyCircle';
import { DrawableRank } from './DrawableRank';
import {
  ACCURACY_TRANSFORM_DELAY,
  ACCURACY_TRANSFORM_DURATION,
  ACCURACY_TRANSFORM_EASING,
  formatAccuracy,
  formatN0,
  formatStarRating,
  hitResultColour,
  statisticsForDisplay,
} from './RankingLogic';
import { RollingCounter } from './RollingCounter';
import type { ScoreView } from './ScoreView';

export const CONTRACTED_WIDTH = 130;
export const CONTRACTED_HEIGHT = 385;
export const EXPANDED_WIDTH = 360;
export const EXPANDED_HEIGHT = 586;
export const EXPANDED_TOP_LAYER_HEIGHT = 53;
const CONTRACTED_TOP_LAYER_HEIGHT = 30;
export const RESIZE_DURATION = 200;
export const TOP_LAYER_EXPAND_DELAY = 100;
const TOP_LAYER_EXPAND_DURATION = 200;
const CONTENT_FADE_DURATION = 50;
const VERTICAL_FUDGE = 20;

export enum PanelState {
  Expanded,
  Contracted,
}

export interface PanelContext {
  playSample: PlaySample;
  playApplause: (rank: ScoreRank) => void;
  /** Star rating with the score's mods (async). */
  starRating: (score: ScoreView) => Promise<number | undefined>;
  /** Performance points for the score (async; undefined when the ruleset has no performance calculator). */
  performance: (score: ScoreView) => Promise<number | undefined>;
  /** Whether the score's mods are all ranked (PerformanceStatistic.hasUnrankedMods). */
  isRanked: (score: ScoreView) => boolean;
}

interface Tween {
  from: number;
  to: number;
  start: number;
  duration: number;
  easing: Easing;
}

const tweenAt = (t: Tween, now: number): number =>
  now < t.start ? t.from : t.duration <= 0 || now >= t.start + t.duration ? t.to : t.from + (t.to - t.from) * applyEasing(t.easing, (now - t.start) / t.duration);

interface Content {
  el: HTMLElement;
  update(now: number): void;
}

export class ScorePanel {
  readonly el: HTMLDivElement;
  private readonly audioContent: HTMLDivElement;
  private readonly topLayer: HTMLDivElement;
  private readonly topBg: HTMLDivElement;
  private readonly topContentContainer: HTMLDivElement;
  private readonly middleLayer: HTMLDivElement;
  private readonly middleBg: HTMLDivElement;
  private readonly middleContentContainer: HTMLDivElement;

  private _state = PanelState.Contracted;
  private loaded = false;
  private displayWithFlair: boolean;
  private width: Tween = { from: 40, to: 40, start: 0, duration: 0, easing: Easing.None };
  private height: Tween = { from: 40, to: 40, start: 0, duration: 0, easing: Easing.None };
  private topY: Tween = { from: 0, to: 0, start: 0, duration: 0, easing: Easing.None };
  private middleY: Tween = { from: 0, to: 0, start: 0, duration: 0, easing: Easing.None };
  private topAlphaAt = Infinity;
  private contents: { c: Content; container: HTMLElement; fadeInAt: number; fadeOutAt: number | null }[] = [];
  private firstExpand = true;

  /** Size (set instantly; the visual box resizes over RESIZE_DURATION). */
  size: [number, number] = [CONTRACTED_WIDTH, CONTRACTED_HEIGHT];
  onStateChanged: ((s: PanelState) => void) | null = null;
  postExpandAction: (() => void) | null = null;
  position: number | undefined;

  constructor(
    readonly score: ScoreView,
    private readonly ctx: PanelContext,
    isNewLocalScore = false,
  ) {
    this.displayWithFlair = isNewLocalScore;
    this.position = score.position;
    this.el = h('div', { class: 'score-panel' });
    this.topBg = h('div', { class: 'sp-layer-bg' });
    this.topContentContainer = h('div', { class: 'sp-layer-content' });
    this.topLayer = h('div', { class: 'sp-top' }, this.topBg, this.topContentContainer);
    this.middleBg = h('div', { class: 'sp-layer-bg' });
    this.middleContentContainer = h('div', { class: 'sp-layer-content' });
    this.middleLayer = h('div', { class: 'sp-middle' }, this.middleBg, this.middleContentContainer);
    this.audioContent = h('div', { class: 'sp-audio' }, this.topLayer, this.middleLayer);
    this.el.appendChild(this.audioContent);
    this.el.addEventListener('click', () => {
      if (this._state === PanelState.Contracted) {
        this.state = PanelState.Expanded;
        return;
      }
      this.postExpandAction?.();
    });
  }

  get state(): PanelState {
    return this._state;
  }

  set state(v: PanelState) {
    if (this._state === v) return;
    this._state = v;
    if (this.loaded) {
      this.updateState(performance.now());
      // Results/score-panel-focus, frequency 0.99 + random(0.2)
      if (v === PanelState.Expanded) this.ctx.playSample('menu-hover', 0.5, 0.99 + Math.random() * 0.2);
    }
    this.onStateChanged?.(v);
  }

  /** LoadComplete. */
  load(now: number): void {
    if (this.loaded) return;
    this.loaded = true;
    this.updateState(now);
  }

  private updateState(now: number): void {
    for (const c of this.contents) if (c.fadeOutAt == null) c.fadeOutAt = now;

    const expanded = this._state === PanelState.Expanded;
    this.size = expanded ? [EXPANDED_WIDTH, EXPANDED_HEIGHT] : [CONTRACTED_WIDTH, CONTRACTED_HEIGHT];
    this.topLayer.classList.toggle('expanded', expanded);
    this.middleLayer.classList.toggle('expanded', expanded);

    const topLayerExpanded = tweenAt(this.topY, now) < 0;
    const delay = topLayerExpanded ? 0 : RESIZE_DURATION + TOP_LAYER_EXPAND_DELAY;

    let top: Content;
    let middle: Content;
    if (expanded) {
      top = new ExpandedPanelTopContent(this.score, this.firstExpand && this.displayWithFlair, this.ctx, now);
      this.firstExpand = false;
      middle = new ExpandedPanelMiddleContent(this.score, this.displayWithFlair, this.ctx, now);
      // only the first expanded display should happen with flair.
      this.displayWithFlair = false;
    } else {
      top = new ContractedPanelTopContent(this);
      middle = new ContractedPanelMiddleContent(this.score);
    }
    this.contents.push({ c: top, container: this.topContentContainer, fadeInAt: now + delay, fadeOutAt: null });
    this.contents.push({ c: middle, container: this.middleContentContainer, fadeInAt: now + delay, fadeOutAt: null });
    this.topContentContainer.appendChild(top.el);
    this.middleContentContainer.appendChild(middle.el);
    top.el.style.opacity = middle.el.style.opacity = '0';

    this.width = { from: tweenAt(this.width, now), to: this.size[0], start: now, duration: RESIZE_DURATION, easing: Easing.OutQuint };
    this.height = { from: tweenAt(this.height, now), to: this.size[1], start: now, duration: RESIZE_DURATION, easing: Easing.OutQuint };

    const layerH = expanded ? EXPANDED_TOP_LAYER_HEIGHT : CONTRACTED_TOP_LAYER_HEIGHT;
    this.topAlphaAt = Math.min(this.topAlphaAt, now + delay);
    this.topY = { from: tweenAt(this.topY, now), to: -layerH / 2, start: now + delay, duration: TOP_LAYER_EXPAND_DURATION, easing: Easing.OutQuint };
    this.middleY = { from: tweenAt(this.middleY, now), to: layerH / 2, start: now + delay, duration: TOP_LAYER_EXPAND_DURATION, easing: Easing.OutQuint };
  }

  update(now: number): void {
    const w = tweenAt(this.width, now);
    const hgt = tweenAt(this.height, now);
    const st = this.audioContent.style;
    st.width = `${w}px`;
    st.height = `${hgt}px`;
    st.left = `${(this.size[0] - w) / 2}px`;
    st.top = `${(this.size[1] - hgt) / 2 + VERTICAL_FUDGE}px`;
    this.topLayer.style.opacity = now >= this.topAlphaAt ? '1' : '0';
    this.topLayer.style.transform = `translateY(${tweenAt(this.topY, now)}px)`;
    this.middleLayer.style.transform = `translateY(${tweenAt(this.middleY, now)}px)`;

    this.contents = this.contents.filter(c => {
      if (c.fadeOutAt != null) {
        const a = 1 - (now - c.fadeOutAt) / CONTENT_FADE_DURATION;
        if (a <= 0) {
          c.c.el.remove();
          return false;
        }
        c.c.el.style.opacity = String(Math.min(a, now >= c.fadeInAt ? 1 : 0));
      } else c.c.el.style.opacity = String(Math.min(1, Math.max(0, (now - c.fadeInAt) / CONTENT_FADE_DURATION)));
      c.c.update(now);
      return true;
    });
  }
}

// ------------------------------------------------------------------ expanded

class ExpandedPanelTopContent implements Content {
  readonly el: HTMLElement;

  constructor(score: ScoreView, playAppearanceSound: boolean, ctx: PanelContext, _now: number) {
    const initial = (score.player || '?').trim().charAt(0).toUpperCase() || '?';
    this.el = h('div', { class: 'sp-expanded-top' }, h('div', { class: 'sp-avatar' }, initial), h('div', { class: 'sp-username' }, score.player));
    // Results/score-panel-top-appear
    if (playAppearanceSound) ctx.playSample('menu-hover', 0.6, 0.8);
  }

  update(): void {}
}

abstract class StatisticDisplay {
  readonly el: HTMLElement;
  protected readonly header: HTMLElement;
  protected readonly content: HTMLElement;
  private appearAt = Infinity;

  constructor(header: string) {
    this.header = h('div', { class: 'stat-display-header' }, header.toUpperCase());
    this.content = h('div', { class: 'stat-display-content' });
    this.el = h('div', { class: 'stat-display' }, h('div', { class: 'stat-display-header-bg' }, this.header), this.content);
    this.content.style.opacity = '0';
  }

  /** Appear: content.FadeIn(100). */
  appear(now: number): void {
    this.appearAt = now;
  }

  update(now: number): void {
    this.content.style.opacity = String(Math.min(1, Math.max(0, (now - this.appearAt) / 100)));
  }
}

class CounterStatistic extends StatisticDisplay {
  protected readonly counter = new RollingCounter(ACCURACY_TRANSFORM_DURATION, ACCURACY_TRANSFORM_EASING, v => String(v), true, 'stat-counter');

  constructor(
    header: string,
    private readonly count: number,
    maxCount: number | null,
  ) {
    super(header);
    const row = h('div', { class: 'stat-counter-row' }, this.counter.el, maxCount != null ? h('span', { class: 'stat-counter-max' }, `/${maxCount}`) : null);
    this.content.appendChild(row);
  }

  appear(now: number): void {
    super.appear(now);
    this.counter.set(this.count, now);
  }

  update(now: number): void {
    super.update(now);
    this.counter.update(now);
  }

  finish(): void {
    this.counter.finish();
  }
}

class HitResultStatistic extends CounterStatistic {
  constructor(
    readonly result: HitResult,
    name: string,
    count: number,
    maxCount: number | null,
  ) {
    super(name, count, maxCount);
    this.header.style.color = hitResultColour(result);
  }
}

class ComboStatistic extends CounterStatistic {
  private readonly perfect: HTMLElement | null;
  private perfectAt = Infinity;

  constructor(combo: number, maxCombo: number) {
    super('Max Combo', combo, maxCombo);
    this.perfect = combo === maxCombo ? h('span', { class: 'stat-perfect' }, 'PERFECT') : null;
    if (this.perfect) {
      this.perfect.style.opacity = '0';
      this.content.firstElementChild!.appendChild(this.perfect);
    }
  }

  appear(now: number): void {
    super.appear(now);
    this.perfectAt = now + ACCURACY_TRANSFORM_DURATION / 2;
  }

  update(now: number): void {
    super.update(now);
    if (this.perfect) this.perfect.style.opacity = String(Math.min(1, Math.max(0, (now - this.perfectAt) / 50)));
  }
}

class AccuracyStatistic extends StatisticDisplay {
  // FormatAccuracy doesn't round, so a shorter OutQuad roll (ACCURACY_TRANSFORM_DURATION / 2) is used.
  private readonly counter = new RollingCounter(ACCURACY_TRANSFORM_DURATION / 2, Easing.OutQuad, formatAccuracy, false, 'stat-counter');

  constructor(private readonly accuracy: number) {
    super('Accuracy');
    this.content.appendChild(this.counter.el);
  }

  appear(now: number): void {
    super.appear(now);
    this.counter.set(this.accuracy, now);
  }

  update(now: number): void {
    super.update(now);
    this.counter.update(now);
  }
}

class PerformanceStatistic extends StatisticDisplay {
  private readonly counter = new RollingCounter(ACCURACY_TRANSFORM_DURATION, ACCURACY_TRANSFORM_EASING, v => String(v), true, 'stat-counter');
  private value: number | null = null;
  private appeared: number | null = null;
  private bound = false;

  constructor(score: ScoreView, ctx: PanelContext) {
    super('pp');
    this.content.appendChild(this.counter.el);
    void ctx.performance(score).then(pp => {
      if (pp === undefined) {
        this.counter.el.textContent = '-';
        return;
      }
      this.value = Math.round(pp);
      // Alpha 0.5 for unranked mods / failed scores (the beatmap's ranked status isn't known offline).
      if (!ctx.isRanked(score) || score.rank === 'F') this.el.style.opacity = '0.5';
      if (this.appeared != null) this.bind(performance.now());
    });
  }

  private bind(now: number): void {
    if (this.bound || this.value == null) return;
    this.bound = true;
    this.counter.set(this.value, now);
  }

  appear(now: number): void {
    super.appear(now);
    this.appeared = now;
    this.bind(now);
  }

  update(now: number): void {
    super.update(now);
    if (this.value != null) this.counter.update(now);
  }
}

/** StarRatingDisplay (Regular size). */
export function starRatingDisplay(stars: number): HTMLElement {
  const text = stars < 0 ? '-' : formatStarRating(stars);
  const textColour = stars < 6.5 ? 'rgba(0,0,0,0.75)' : stars < 9 ? '#ffd966' : starColour(stars);
  return h(
    'div',
    { class: 'star-rating-display', style: { background: starColour(stars), color: textColour } },
    icon('star', 'star-rating-icon'),
    h('span', { class: 'star-rating-text' }, text),
  );
}

export function modIcons(score: ScoreView, className = 'mod-display'): HTMLElement {
  return h(
    'div',
    { class: className },
    score.mods.list.map(m => {
      const def = MOD_BY_ACRONYM.get(m);
      return h('span', { class: 'mod-icon', style: { background: def ? MOD_TYPE_COLOURS[def.type] : '#fff' } }, score.mods.label(m));
    }),
  );
}

/** DifficultyIcon: the ruleset icon in the star rating colour. */
export function difficultyIcon(rulesetId: number, stars: number): HTMLElement {
  const glyph = ['<circle cx="16" cy="16" r="5.5" fill="currentColor" stroke="none"/>', '<circle cx="16" cy="16" r="7"/><path d="M16 9v14"/>', '<circle cx="16" cy="17.5" r="5" fill="currentColor" stroke="none"/><path d="M16 12c1-3 3-4 5-4"/>', '<path d="M11 10v12M14.3 10v12M17.7 10v12M21 10v12"/>'][rulesetId] ?? '';
  const el = h('span', { class: 'difficulty-icon', style: { color: starColour(stars) } });
  el.innerHTML = `<svg viewBox="0 0 32 32" width="100%" height="100%" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><circle cx="16" cy="16" r="13.5"/>${glyph}</svg>`;
  return el;
}

class ExpandedPanelMiddleContent implements Content {
  readonly el: HTMLElement;
  private readonly circle: AccuracyCircle;
  private readonly scoreCounter = new RollingCounter(ACCURACY_TRANSFORM_DURATION, ACCURACY_TRANSFORM_EASING, formatN0, true, 'total-score-counter');
  private readonly statistics: StatisticDisplay[] = [];
  private readonly appearAt: number;
  private appeared = false;
  private readonly starsHolder: HTMLElement;
  private readonly diffIconHolder: HTMLElement;

  constructor(
    private readonly score: ScoreView,
    private readonly withFlair: boolean,
    ctx: PanelContext,
    now: number,
  ) {
    const e = score.working.entry;
    this.circle = new AccuracyCircle(score.accuracy, score.rank, withFlair, now, ctx.playSample, ctx.playApplause);

    const top: StatisticDisplay[] = [new AccuracyStatistic(score.accuracy), new ComboStatistic(score.maxCombo, score.maximumCombo), new PerformanceStatistic(score, ctx)];
    const bottom = statisticsForDisplay(score.ruleset.id, score.statistics, score.maximumStatistics).map(s => new HitResultStatistic(s.result, s.displayName, s.count, s.maxCount));
    this.statistics.push(...top, ...bottom);

    const row = (items: StatisticDisplay[]) => h('div', { class: 'stat-grid', style: { gridTemplateColumns: `repeat(${Math.max(1, items.length)}, 1fr)` } }, items.map(s => s.el));

    this.starsHolder = h('span', null, starRatingDisplay(e.stars ?? 0));
    this.diffIconHolder = h('span', null, difficultyIcon(score.ruleset.id, e.stars ?? 0));
    void ctx.starRating(score).then(stars => {
      if (stars === undefined) return;
      this.starsHolder.replaceChildren(starRatingDisplay(stars));
      this.diffIconHolder.replaceChildren(difficultyIcon(score.ruleset.id, stars));
    });

    this.scoreCounter.el.style.opacity = '0';
    this.el = h(
      'div',
      { class: 'sp-expanded-middle' },
      h(
        'div',
        { class: 'sp-flow' },
        h(
          'div',
          { class: 'sp-top-flow' },
          h('div', { class: 'sp-title' }, e.titleUnicode || e.title),
          h('div', { class: 'sp-artist' }, e.artistUnicode || e.artist),
          h('div', { class: 'sp-circle-holder' }, this.circle.el),
          this.scoreCounter.el,
          h('div', { class: 'sp-difficulty-row' }, this.starsHolder, this.diffIconHolder, modIcons(score)),
          h('div', { class: 'sp-difficulty-name' }, e.difficultyName),
          e.creator ? h('div', { class: 'sp-mapper' }, 'mapped by ', h('b', null, e.creator)) : null,
        ),
        h(
          'div',
          { class: 'sp-bottom-flow' },
          row(top),
          row(bottom.filter(s => s.result <= HitResult.Perfect)),
          row(bottom.filter(s => s.result > HitResult.Perfect)),
        ),
      ),
      score.date ? h('div', { class: 'played-on' }, `Played on ${formatPlayedOn(score.date)}`) : null,
    );
    this.appearAt = now + ACCURACY_TRANSFORM_DELAY;
  }

  update(now: number): void {
    if (!this.appeared && (now >= this.appearAt || !this.withFlair)) {
      this.appeared = true;
      const t = this.withFlair ? this.appearAt : now;
      this.scoreCounter.el.style.opacity = '1';
      this.scoreCounter.set(getDisplayScore(this.score.ruleset.id, this.score.totalScore, this.score.maximumStatistics), t);
      this.statistics.forEach((s, i) => s.appear(t + 200 * i));
      if (!this.withFlair) {
        // FinishTransforms(true)
        this.scoreCounter.finish();
        for (const s of this.statistics) {
          s.appear(-Infinity);
          if (s instanceof CounterStatistic) s.finish();
        }
      }
    }
    this.circle.update(now);
    this.scoreCounter.update(now);
    for (const s of this.statistics) s.update(this.withFlair ? now : Infinity);
  }
}

/** PlayedOnText: "d MMMM yyyy h:mm tt". */
function formatPlayedOn(date: number): string {
  const d = new Date(date);
  const month = d.toLocaleString('en-US', { month: 'long' });
  let hours = d.getHours();
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12 || 12;
  return `${d.getDate()} ${month} ${d.getFullYear()} ${hours}:${String(d.getMinutes()).padStart(2, '0')} ${ampm}`;
}

// ------------------------------------------------------------------ contracted

class ContractedPanelTopContent implements Content {
  readonly el: HTMLElement;

  constructor(panel: ScorePanel) {
    this.el = h('div', { class: 'sp-contracted-top' }, panel.position != null ? `#${panel.position}` : '');
  }

  update(): void {}
}

class ContractedPanelMiddleContent implements Content {
  readonly el: HTMLElement;
  private readonly rank: DrawableRank;
  private readonly rankCanvas: HTMLCanvasElement;
  private last = 0;

  constructor(score: ScoreView) {
    const stat = (key: string, value: string) => h('div', { class: 'cp-stat' }, h('span', null, toTitle(key)), h('span', { class: 'cp-stat-value' }, value));
    const stats = statisticsForDisplay(score.ruleset.id, score.statistics, score.maximumStatistics).filter(s => s.result !== HitResult.SmallBonus && s.result !== HitResult.LargeBonus);
    this.rank = new DrawableRank(score.rank);
    this.rankCanvas = h('canvas', { class: 'cp-rank' });
    const initial = (score.player || '?').trim().charAt(0).toUpperCase() || '?';
    this.el = h(
      'div',
      { class: 'sp-contracted-middle' },
      h(
        'div',
        { class: 'cp-card' },
        h('div', { class: 'sp-avatar cp-avatar' }, initial),
        h('div', { class: 'sp-username' }, score.player),
        h('div', { class: 'cp-stats' }, stats.map(s => stat(s.displayName, s.maxCount == null ? `${s.count}` : `${s.count}/${s.maxCount}`))),
        h('div', { class: 'cp-stats', style: { marginTop: '10px' } }, stat('Max Combo', `x${score.maxCombo}`), stat('Accuracy', formatAccuracy(score.accuracy))),
        h('div', { class: 'cp-mods' }, difficultyIcon(score.ruleset.id, score.working.entry.stars ?? 0), modIcons(score, 'cp-mod-list')),
      ),
      h('div', { class: 'cp-bottom' }, h('div', { class: 'cp-score' }, formatN0(getDisplayScore(score.ruleset.id, score.totalScore, score.maximumStatistics))), this.rankCanvas),
    );
  }

  update(now: number): void {
    const elapsed = Math.min(100, now - (this.last || now));
    this.last = now;
    this.rank.update(elapsed);
    const c = this.rankCanvas;
    const w = c.clientWidth;
    const hh = c.clientHeight;
    if (!w || !hh) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (c.width !== Math.round(w * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(hh * dpr);
    }
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, hh);
    const rw = Math.min(w, hh * 2);
    this.rank.draw(g, w / 2, hh / 2, rw);
  }
}

/** LocalisableString.ToTitle (TextInfo.ToTitleCase keeps all-caps words). */
function toTitle(s: string): string {
  return s.replace(/\S+/g, w => (w === w.toUpperCase() ? w : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()));
}
