// Port of osu.Game/Screens/Play/HUD/DrawableGameplayLeaderboard.cs + DrawableGameplayLeaderboardScore.cs with the
// SoloGameplayLeaderboardProvider (local scores for the beatmap, plus the tracked live score, re-sorted every second).
// Placed at (36, 115) from the top-left, as in the Argon skin's default HUD layout.

import './leaderboard.css';
import { h } from '../dom';
import { css, hex, OsuColour, type RGBA } from '../select/Colours';
import { formatAccuracy } from './ArgonCounter';

const PANEL_HEIGHT = 38;
const AVATAR_SIZE = PANEL_HEIGHT;
const LEFT_PANEL_EXTENSION_WIDTH = 20;
const REGULAR_LEFT_PANEL_WIDTH = AVATAR_SIZE + AVATAR_SIZE / 2;
const EXTENDED_LEFT_PANEL_WIDTH = REGULAR_LEFT_PANEL_WIDTH + LEFT_PANEL_EXTENSION_WIDTH;
const SHEAR_WIDTH = PANEL_HEIGHT * 0.2;
const ELASTIC_WIDTH_LENIENCE = 10;
const X_OFFSET = SHEAR_WIDTH + ELASTIC_WIDTH_LENIENCE;
const WIDTH = 260 + X_OFFSET;
const HEIGHT = 300;
const ACCURACY_COMBO_WIDTH_CUTOFF = 150;
const USERNAME_SCORE_WIDTH_CUTOFF = 50;
const SPACING = 2.5;

const LIME2 = hex('99eb47');
const BLUE4 = hex('2e576b');

export interface LeaderboardEntry {
  player: string;
  totalScore: number;
  accuracy: number;
  /** ComboDisplayMode.Highest */
  maxCombo: number;
  /** For classic display score. */
  displayScore: (totalScore: number) => number;
}

class Panel {
  readonly el: HTMLDivElement;
  private readonly inner: HTMLDivElement;
  private readonly left: HTMLDivElement;
  private readonly right: HTMLDivElement;
  private readonly position: HTMLDivElement;
  private readonly username: HTMLDivElement;
  private readonly accuracyText: HTMLDivElement;
  private readonly scoreText: HTMLDivElement;
  private readonly comboText: HTMLDivElement;
  private readonly components: HTMLDivElement;
  displayOrder = 0;
  scorePosition: number | null = null;
  private lastState = '';
  private rightWidth = 0;

  constructor(
    public entry: LeaderboardEntry,
    readonly tracked: boolean,
  ) {
    this.position = h('div', { class: 'gl-position' });
    this.left = h('div', { class: 'gl-left' }, h('div', { class: 'gl-left-bg' }), h('div', { class: 'gl-position-wrap' }, this.position));
    const avatar = h('div', { class: 'gl-avatar' }, h('div', { class: 'gl-avatar-inner' }, h('span', null, (entry.player[0] ?? '?').toUpperCase())));
    this.username = h('div', { class: 'gl-username' }, entry.player);
    this.accuracyText = h('div', { class: 'gl-accuracy' });
    this.scoreText = h('div', { class: 'gl-score' });
    this.comboText = h('div', { class: 'gl-combo' });
    this.components = h('div', { class: 'gl-components' }, h('div', { class: 'gl-row' }, this.username, this.accuracyText), h('div', { class: 'gl-row' }, this.scoreText, this.comboText));
    this.right = h('div', { class: 'gl-right' }, h('div', { class: 'gl-right-bg' }), this.components);
    this.inner = h('div', { class: 'gl-panel' }, this.left, avatar, this.right);
    this.el = h('div', { class: 'gl-score-panel' }, this.inner);
    this.updateValues();
  }

  updateValues(): void {
    const e = this.entry;
    this.scoreText.textContent = Math.round(e.displayScore(e.totalScore)).toLocaleString('en-US');
    this.accuracyText.textContent = formatAccuracy(e.accuracy);
    this.comboText.textContent = `${e.maxCombo}x`;
  }

  /** updatePanelState + onExpanded */
  update(expanded: boolean): void {
    const key = `${this.scorePosition}|${expanded}`;
    if (key === this.lastState) return;
    this.lastState = key;
    this.position.textContent = this.scorePosition != null ? `#${this.scorePosition.toLocaleString('en-US')}` : '-';
    let colour: RGBA;
    let extension = false;
    if (this.scorePosition === 1) {
      extension = true;
      colour = LIME2;
    } else if (this.tracked) {
      extension = true;
      colour = OsuColour.Orange2;
    } else colour = BLUE4;
    this.inner.style.setProperty('--gl-l0', css(colour, 0.2));
    this.inner.style.setProperty('--gl-l1', css(colour, 0.5));
    this.inner.style.setProperty('--gl-r0', css(colour, 0.1));
    this.inner.style.setProperty('--gl-r1', css(colour, 0.3));
    this.inner.style.setProperty('--gl-b0', css(colour, 0.2));
    this.inner.style.setProperty('--gl-b1', css(colour, 1));
    this.inner.style.transform = `translateX(${extension ? 0 : LEFT_PANEL_EXTENSION_WIDTH}px)`;
    this.left.style.width = `${extension ? EXTENDED_LEFT_PANEL_WIDTH : REGULAR_LEFT_PANEL_WIDTH}px`;
    // computeRightLayerWidth: DrawWidth - extended_left_panel_width - avatar_size / 2
    this.rightWidth = expanded ? Math.max(0, 260 - EXTENDED_LEFT_PANEL_WIDTH - AVATAR_SIZE / 2) : AVATAR_SIZE / 2;
    this.right.style.width = `${this.rightWidth}px`;
    this.components.style.opacity = expanded ? '1' : '0';
    this.components.style.transitionDuration = expanded ? '500ms' : '200ms';
    const showAccuracyAndCombo = this.rightWidth >= ACCURACY_COMBO_WIDTH_CUTOFF;
    const showUsernameAndScore = this.rightWidth >= USERNAME_SCORE_WIDTH_CUTOFF;
    this.accuracyText.style.visibility = this.comboText.style.visibility = showAccuracyAndCombo ? '' : 'hidden';
    this.username.style.visibility = this.scoreText.style.visibility = showUsernameAndScore ? '' : 'hidden';
  }
}

export class GameplayLeaderboard {
  readonly el: HTMLDivElement;
  private readonly flow: HTMLDivElement;
  private readonly panels: Panel[] = [];
  private tracked: Panel | null = null;
  private lastSort = -Infinity;
  private scrollY = 0;

  constructor(scores: LeaderboardEntry[], local: LeaderboardEntry, private readonly visible: boolean) {
    this.flow = h('div', { class: 'gl-flow', style: { left: `${X_OFFSET}px` } });
    this.el = h('div', { class: 'gameplay-leaderboard', style: { width: `${WIDTH}px`, height: `${HEIGHT}px` } }, this.flow);
    // OrderByTotalScore
    for (const s of [...scores].sort((a, b) => b.totalScore - a.totalScore)) this.add(new Panel(s, false));
    this.tracked = new Panel(local, true);
    this.add(this.tracked);
    this.sort(true);
    this.flow.style.opacity = visible ? '1' : '0';
  }

  private add(p: Panel): void {
    this.panels.push(p);
    this.flow.appendChild(p.el);
  }

  /** SoloGameplayLeaderboardProvider.sort (the local leaderboard is complete, so positions are simply the order). */
  private sort(force = false): void {
    // Ties: the local score shows below existing scores (TotalScoreTiebreaker = long.MaxValue).
    const ordered = [...this.panels].sort((a, b) => b.entry.totalScore - a.entry.totalScore || Number(a.tracked) - Number(b.tracked));
    let changed = force;
    ordered.forEach((p, i) => {
      if (p.displayOrder !== i + 1) changed = true;
      p.displayOrder = i + 1;
      p.scorePosition = i + 1;
    });
    if (!changed) return;
    // FillFlowContainer layout (LayoutDuration 450, OutQuint): absolute positions with a transform transition.
    for (const p of this.panels) p.el.style.transform = `translateY(${(p.displayOrder - 1) * (PANEL_HEIGHT + SPACING)}px)`;
    this.flow.style.height = `${this.panels.length * (PANEL_HEIGHT + SPACING) - SPACING}px`;
  }

  /** `expanded`: !CollapseDuringGameplay || not Playing || holding for HUD. */
  update(now: number, liveScore: { totalScore: number; accuracy: number; maxCombo: number }, expanded: boolean): void {
    if (!this.visible) return;
    if (this.tracked) {
      this.tracked.entry.totalScore = liveScore.totalScore;
      this.tracked.entry.accuracy = liveScore.accuracy;
      this.tracked.entry.maxCombo = liveScore.maxCombo;
      this.tracked.updateValues();
    }
    if (now - this.lastSort >= 1000) {
      this.lastSort = now;
      this.sort();
    }
    for (const p of this.panels) p.update(expanded);
    // Keep the tracked score centred when the list is taller than the leaderboard, with edge fades.
    const contentHeight = this.panels.length * (PANEL_HEIGHT + SPACING) - SPACING;
    const requiresScroll = contentHeight > HEIGHT;
    if (requiresScroll && this.tracked) {
      const target = (this.tracked.displayOrder - 1) * (PANEL_HEIGHT + SPACING) + PANEL_HEIGHT / 2 - HEIGHT / 2;
      this.scrollY = Math.max(0, Math.min(contentHeight - HEIGHT, target));
    } else this.scrollY = 0;
    this.flow.style.top = `${-this.scrollY}px`;
    const atStart = this.scrollY <= 0;
    const atEnd = this.scrollY >= contentHeight - HEIGHT - 0.5;
    let fadeTop = this.scrollY + PANEL_HEIGHT;
    let fadeBottom = this.scrollY + HEIGHT;
    if (atStart) fadeTop -= PANEL_HEIGHT;
    if (!atEnd) fadeBottom -= PANEL_HEIGHT;
    for (const p of this.panels) {
      const topY = (p.displayOrder - 1) * (PANEL_HEIGHT + SPACING);
      const bottomY = topY + PANEL_HEIGHT;
      const top = requiresScroll && topY <= fadeTop;
      const bottom = requiresScroll && bottomY >= fadeBottom;
      let mask = '';
      if (top || bottom) {
        if (topY > fadeBottom + PANEL_HEIGHT || bottomY < fadeTop - PANEL_HEIGHT) mask = 'linear-gradient(transparent, transparent)';
        else if (bottom) mask = `linear-gradient(rgba(0,0,0,${Math.min(1 - (topY - fadeBottom) / PANEL_HEIGHT, 1)}), rgba(0,0,0,${Math.min(1 - (bottomY - fadeBottom) / PANEL_HEIGHT, 1)}))`;
        else mask = `linear-gradient(rgba(0,0,0,${Math.min(1 - (fadeTop - topY) / PANEL_HEIGHT, 1)}), rgba(0,0,0,${Math.min(1 - (fadeTop - bottomY) / PANEL_HEIGHT, 1)}))`;
      }
      if (p.el.style.maskImage !== mask) {
        p.el.style.maskImage = mask;
        p.el.style.webkitMaskImage = mask;
      }
    }
  }

  /** HUD hide-target alpha. */
  setAlpha(a: number): void {
    this.el.style.opacity = String(a);
  }
}
