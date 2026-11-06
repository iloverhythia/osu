// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game/Screens/Ranking/ScorePanelList.cs (+ ScorePanelTrackingContainer.cs and the panel detaching done by
// ResultsScreen.onStatisticsStateChanged). Panels are laid out horizontally sorted by total score, the expanded panel
// centred; the list scrolls like an OsuScrollContainer (exponential approach, DistanceDecayJump = 0.01).

import { applyEasing, Easing } from '../../game/storyboard/Easing';
import { h } from '../dom';
import { CONTRACTED_WIDTH, EXPANDED_WIDTH, PanelState, ScorePanel, type PanelContext } from './ScorePanel';
import type { ScoreView } from './ScoreView';
import { SIDE_PADDING } from './StatisticsPanel';

const PANEL_SPACING = 5;
const EXPANDED_PANEL_SPACING = 15;

interface Tween {
  from: number;
  to: number;
  start: number;
  duration: number;
  easing: Easing;
}

const at = (t: Tween, now: number): number => (now >= t.start + t.duration || t.duration <= 0 ? t.to : now < t.start ? t.from : t.from + (t.to - t.from) * applyEasing(t.easing, (now - t.start) / t.duration));
const still = (v: number): Tween => ({ from: v, to: v, start: 0, duration: 0, easing: Easing.None });

interface Entry {
  panel: ScorePanel;
  alpha: Tween;
  /** Offset from the list position (re-attach animation), or the absolute x while detached. */
  x: Tween;
  detached: boolean;
  lastScreenX: number;
}

export class ScorePanelList {
  readonly el: HTMLDivElement;
  private readonly entries: Entry[] = [];
  private scroll = 0;
  private scrollTarget = 0;
  private maxScroll = 0;
  private lastTime = 0;
  private handleInput = true;
  selected: ScorePanel | null = null;
  onSelectedChanged: ((score: ScoreView) => void) | null = null;
  postExpandAction: (() => void) | null = null;

  constructor(private readonly ctx: PanelContext) {
    this.el = h('div', { class: 'score-panel-list' });
    this.el.addEventListener(
      'wheel',
      e => {
        if (!this.handleInput || e.ctrlKey || e.altKey || e.shiftKey || e.metaKey) return;
        this.scrollTarget = Math.max(0, Math.min(this.maxScroll, this.scrollTarget + (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY)));
      },
      { passive: true },
    );
  }

  get panels(): ScorePanel[] {
    return this.sorted().map(e => e.panel);
  }

  /** AddScore. */
  addScore(score: ScoreView, isNewLocalScore = false): ScorePanel {
    const panel = new ScorePanel(score, this.ctx, isNewLocalScore);
    panel.postExpandAction = () => this.postExpandAction?.();
    panel.onStateChanged = s => {
      if (s === PanelState.Expanded) this.select(panel);
    };
    this.entries.push({ panel, alpha: still(1), x: still(0), detached: false, lastScreenX: 0 });
    this.el.appendChild(panel.el);
    panel.load(performance.now());
    return panel;
  }

  private sorted(): Entry[] {
    return [...this.entries].sort((a, b) => b.panel.score.totalScore - a.panel.score.totalScore || a.panel.score.date - b.panel.score.date);
  }

  /** SelectedScore.Value = score (selectedScoreChanged). */
  select(panel: ScorePanel): void {
    if (this.selected !== panel) {
      const old = this.selected;
      this.selected = panel;
      if (old) old.state = PanelState.Contracted;
      panel.state = PanelState.Expanded;
      this.onSelectedChanged?.(panel.score);
    }
    const index = this.sorted().findIndex(e => e.panel === panel);
    this.scrollTarget = index * (CONTRACTED_WIDTH + PANEL_SPACING);
  }

  selectPrevious(): void {
    const s = this.sorted();
    const i = s.findIndex(e => e.panel === this.selected);
    if (i > 0) this.select(s[i - 1].panel);
  }

  selectNext(): void {
    const s = this.sorted();
    const i = s.findIndex(e => e.panel === this.selected);
    if (i >= 0 && i < s.length - 1) this.select(s[i + 1].panel);
  }

  /** Statistics shown: detach the expanded panel and move it to the left; hide contracted panels. */
  setStatisticsVisible(visible: boolean, now: number): void {
    this.handleInput = !visible;
    for (const e of this.entries) {
      if (e.panel === this.selected) {
        if (visible) {
          e.detached = true;
          e.x = { from: e.lastScreenX, to: SIDE_PADDING, start: now, duration: 400, easing: Easing.OutElasticQuarter };
        } else if (e.detached) {
          e.detached = false;
          const listX = this.listX(e);
          e.x = { from: e.lastScreenX - listX, to: 0, start: now, duration: 250, easing: Easing.OutElasticQuarter };
        }
      } else if (e.panel.state === PanelState.Contracted) e.alpha = { from: at(e.alpha, now), to: visible ? 0 : 1, start: now, duration: 150, easing: Easing.OutQuint };
    }
  }

  private layoutCache = new Map<Entry, number>();

  private listX(e: Entry): number {
    return this.layoutCache.get(e) ?? 0;
  }

  update(now: number): void {
    const elapsed = Math.min(100, now - (this.lastTime || now));
    this.lastTime = now;
    const w = this.el.clientWidth;
    const hgt = this.el.clientHeight;

    // Padding such that the centre of an expanded panel on either side is in the middle of the screen.
    const offset = w / 2 - (this.selected ? EXPANDED_WIDTH / 2 + EXPANDED_PANEL_SPACING : CONTRACTED_WIDTH / 2);
    let cursor = offset;
    const sorted = this.sorted();
    sorted.forEach((e, i) => {
      if (i > 0) cursor += PANEL_SPACING;
      const margin = e.panel === this.selected ? EXPANDED_PANEL_SPACING : 0;
      cursor += margin;
      this.layoutCache.set(e, cursor);
      cursor += e.panel.size[0] + margin;
    });
    const contentWidth = cursor + offset;
    this.maxScroll = Math.max(0, contentWidth - w);
    this.scrollTarget = Math.max(0, Math.min(this.maxScroll, this.scrollTarget));
    this.scroll = this.scrollTarget + (this.scroll - this.scrollTarget) * Math.exp(-0.01 * elapsed);
    if (Math.abs(this.scroll - this.scrollTarget) < 0.5) this.scroll = this.scrollTarget;

    for (const e of sorted) {
      const p = e.panel;
      const listX = this.listX(e) - this.scroll;
      const x = e.detached ? at(e.x, now) : listX + at(e.x, now);
      e.lastScreenX = x;
      const st = p.el.style;
      st.width = `${p.size[0]}px`;
      st.height = `${p.size[1]}px`;
      st.transform = `translate(${x}px, ${hgt / 2 - p.size[1] / 2}px)`;
      const a = at(e.alpha, now);
      st.opacity = String(a);
      st.visibility = a > 0 ? 'visible' : 'hidden';
      st.pointerEvents = this.handleInput || e.detached ? 'auto' : 'none';
      st.zIndex = e.detached ? '2' : '';
      p.update(now);
    }
  }
}
