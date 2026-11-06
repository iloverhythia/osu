// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game/Screens/Select/Panel.cs, PanelBeatmapSet.cs (+ .SpreadDisplay), PanelBeatmap.cs, PanelBeatmapStandalone.cs
// (+ .SpreadDisplay), PanelGroup.cs, PanelGroupStarDifficulty.cs (colouring), PanelSetBackground.cs and PanelLocalRankDisplay.cs as DOM panels.

import type { ModSet } from '../../game/mods/Mods';
import type { Ruleset } from '../../game/rulesets/Ruleset';
import type { ScoreRank } from '../../game/scoring/ScoreRank';
import type { BeatmapSetRecord } from '../../game/storage/Database';
import { h } from '../dom';
import { cssEasing, Easing, sequence, tween } from './Anim';
import type { CarouselItem } from './BeatmapCarouselFilters';
import { GroupDefinition, GroupedBeatmap, GroupedBeatmapSet, StarDifficultyGroupDefinition, allowGameplayWithRuleset } from './BeatmapCarouselFilters';
import { maniaColumnCount } from './DisplayAttributes';
import type { CarouselSource } from './CarouselModel';
import { css, forRank, forStarDifficulty, forStarDifficultyText, hex, opacity, OverlayColourProvider, rankLetter, rankLetterColour, RGBA, WHITE } from './Colours';
import { StarRatingDisplay, statusPill, updateStatusPill } from './Components';
import { difficultyCache } from './DifficultyCache';
import type { FilterBeatmap, FilterBeatmapSet } from './FilterCriteria';
import { icon, rulesetIcon } from './Icons';

export const CORNER_RADIUS = 10;
const ACTIVE_X_OFFSET = 25;
const DURATION = 400;

export interface PanelContext {
  readonly colours: OverlayColourProvider;
  ruleset(): Ruleset;
  mods(): ModSet;
  showConverts(): boolean;
  sourceOf(b: FilterBeatmap): CarouselSource;
  recordOf(set: FilterBeatmapSet): BeatmapSetRecord | undefined;
  backgroundUrl(record: BeatmapSetRecord): string | null;
  activate(item: CarouselItem): void;
  contextMenu(item: CarouselItem, e: MouseEvent): void;
  scopeToSet(set: FilterBeatmapSet): void;
  canScope(): boolean;
  localRank(b: FilterBeatmap, cb: (rank: ScoreRank | null) => void): void;
  /** Visible difficulties of a set (BeatmapCarousel.updateVisibleBeatmaps), or null. */
  visibleBeatmaps(set: GroupedBeatmapSet): Set<FilterBeatmap> | null;
  preferUnicode(): boolean;
}

export type PanelKind = 'set' | 'beatmap' | 'standalone' | 'group';

/** Panel.cs */
export abstract class Panel {
  readonly el: HTMLDivElement;
  protected readonly top: HTMLDivElement;
  protected readonly bg: HTMLDivElement;
  protected readonly iconBox: HTMLDivElement;
  protected readonly contentPad: HTMLDivElement;
  protected readonly content: HTMLDivElement;
  private readonly hoverLayer: HTMLDivElement;
  private readonly selectionLayer: HTMLDivElement;
  private readonly selectionBox: HTMLDivElement;
  private readonly keyboardLayer: HTMLDivElement;
  private readonly flash: HTMLDivElement;

  item: CarouselItem | null = null;
  drawYPosition = 0;
  /** Panel.X as set by the carousel. */
  x = 0;
  selected = false;
  expanded = false;
  keyboardSelected = false;
  expiring = false;

  protected accentColour: RGBA | null = null;
  protected panelXOffset = 0;
  /** Item.DepthLayer, used by the pulsating selection box. */
  private pulseDepthLayer = 0;
  private lastBeat = -1;

  constructor(
    readonly kind: PanelKind,
    protected readonly ctx: PanelContext,
    height: number,
  ) {
    this.bg = h('div', { class: 'p-bg' });
    this.iconBox = h('div', { class: 'p-icon' });
    this.content = h('div', { class: 'p-content' });
    this.contentPad = h('div', { class: 'p-contentpad' }, this.content);
    this.hoverLayer = h('div', { class: 'p-hover' });
    this.selectionBox = h('div', { class: 'p-selbox' });
    this.selectionLayer = h('div', { class: 'p-sel' }, this.selectionBox);
    this.keyboardLayer = h('div', { class: 'p-kb' });
    this.flash = h('div', { class: 'p-flash' });
    this.top = h('div', { class: 'p-top' }, this.bg, this.iconBox, this.contentPad, this.hoverLayer, this.selectionLayer, this.keyboardLayer, this.flash);
    this.el = h('div', { class: `p p-${kind}` }, this.top);
    this.el.style.height = `${height}px`;

    const c = ctx.colours;
    this.keyboardLayer.style.background = `linear-gradient(90deg, ${css(c.highlight1, 0.1)}, ${css(c.highlight1, 0.4)})`;

    this.el.addEventListener('mouseenter', () => tween(this.hoverLayer, { opacity: '1' }, 100, Easing.OutQuint));
    this.el.addEventListener('mouseleave', () => tween(this.hoverLayer, { opacity: '0' }, 1000, Easing.OutQuint));
    this.el.addEventListener('click', e => {
      e.stopPropagation();
      if (this.item && !this.expiring) ctx.activate(this.item);
    });
    this.el.addEventListener('contextmenu', e => {
      e.preventDefault();
      e.stopPropagation();
      if (this.item && !this.expiring) ctx.contextMenu(this.item, e);
    });
  }

  /** PrepareForUse */
  prepare(item: CarouselItem): void {
    this.item = item;
    this.pulseDepthLayer = -item.depthLayer;
    this.updateAccentColour();
    this.updateXOffset(false);
    this.updateSelectedState(false);
    this.el.style.transition = 'none';
    this.el.style.opacity = '0';
    void this.el.offsetWidth;
    tween(this.el, { opacity: '1' }, DURATION, Easing.OutQuint);
    this.onPrepare();
  }

  protected abstract onPrepare(): void;

  /** FreeAfterUse */
  free(): void {
    this.item = null;
    this.onFree();
  }

  protected onFree(): void {}

  setState(selected: boolean, keyboardSelected: boolean, expanded: boolean): void {
    const changedSel = selected !== this.selected || expanded !== this.expanded;
    const changedKb = keyboardSelected !== this.keyboardSelected;
    this.selected = selected;
    this.expanded = expanded;
    this.keyboardSelected = keyboardSelected;
    if (changedSel) {
      this.updateSelectedState();
      this.updateXOffset();
      this.onExpandedChanged();
    }
    if (changedKb) {
      if (keyboardSelected) sequence(this.keyboardLayer, [{ props: { opacity: 1 }, duration: 80, easing: Easing.Out }, { props: { opacity: 0.5 }, duration: 2000, easing: Easing.OutQuint }], { opacity: getComputedStyle(this.keyboardLayer).opacity });
      else sequence(this.keyboardLayer, [{ props: { opacity: 0 }, duration: 1000, easing: Easing.OutQuint }], { opacity: getComputedStyle(this.keyboardLayer).opacity });
      this.updateXOffset();
    }
  }

  protected onExpandedChanged(): void {}

  activated(): void {
    sequence(this.flash, [{ props: { opacity: 0 }, duration: 1000, easing: Easing.OutQuint }], { opacity: 1 });
  }

  protected setAccentColour(c: RGBA | null): void {
    if (c && this.accentColour && c.r === this.accentColour.r && c.g === this.accentColour.g && c.b === this.accentColour.b) return;
    this.accentColour = c;
    this.updateAccentColour();
  }

  private updateAccentColour(): void {
    const bgc = this.accentColour ?? WHITE;
    this.selectionBox.style.background = `linear-gradient(90deg, ${css(bgc, 0)}, ${css(bgc, 0.5)})`;
    this.updateSelectedState(false);
  }

  private updateSelectedState(animated = true): void {
    const selectedOrExpanded = this.expanded || this.selected;
    if (selectedOrExpanded) tween(this.selectionLayer, { opacity: '1' }, animated ? 100 : 0, Easing.OutQuint);
    else tween(this.selectionLayer, { opacity: '0' }, animated ? 200 : 0, Easing.OutQuint);
    this.applyTop(animated);
  }

  private targetX(): number {
    let x = this.panelXOffset + CORNER_RADIUS;
    if (!this.expanded && !this.selected) x += this.kind === 'beatmap' || this.kind === 'standalone' ? ACTIVE_X_OFFSET * 2 : ACTIVE_X_OFFSET * 4;
    if (!this.keyboardSelected) x += ACTIVE_X_OFFSET;
    return x;
  }

  private updateXOffset(animated = true): void {
    this.applyTop(animated);
  }

  /** TopLevelContent.MoveToX(x, DURATION, OutQuint) + FadeEdgeEffectTo(colour, DURATION, OutQuint). */
  private applyTop(animated: boolean): void {
    const selectedOrExpanded = this.expanded || this.selected;
    const edge = this.accentColour ?? hex('4EBFFF');
    const e = cssEasing(Easing.OutQuint);
    this.top.style.transition = animated ? `transform ${DURATION}ms ${e}, box-shadow ${DURATION}ms ${e}` : 'none';
    this.top.style.transform = `translateX(${this.targetX()}px)`;
    this.top.style.boxShadow = selectedOrExpanded ? `0 0 2px 1px ${css(edge, 0.8)}` : `0 1px 4px 0 rgba(0,0,0,0.2)`;
    if (!animated) void this.top.offsetWidth;
  }

  /** Current TopLevelContent.X (including a running transition). */
  protected currentTopX(): number {
    const t = getComputedStyle(this.top).transform;
    return t && t !== 'none' ? new DOMMatrixReadOnly(t).m41 : this.targetX();
  }

  /** PulsatingBox.OnNewBeat (BeatSyncedContainer, 40ms early activation). */
  onBeat(beatIndex: number, beatLength: number, beatsPerBar: number): void {
    if (beatIndex === this.lastBeat) return;
    this.lastBeat = beatIndex;
    if (!(this.selected || this.expanded)) return;
    if (beatIndex % getFlashInterval(beatsPerBar, this.pulseDepthLayer) !== 0) return;
    let length = beatLength;
    while (length < 250) length *= 2;
    sequence(this.selectionBox, [{ props: { opacity: 0.8 }, duration: 40, easing: Easing.Out }, { props: { opacity: 0.4 }, duration: length, easing: Easing.Out }], { opacity: getComputedStyle(this.selectionBox).opacity });
  }

  /** Per-frame update (Panel.Update / subclass Update). */
  update(): void {}
}

function getFlashInterval(beatsPerBar: number, depthLayer: number): number {
  let beatsPerFlash = 1;
  let remainingBar = beatsPerBar;
  for (let i = 0; i < depthLayer; i++) {
    let factor = smallestPrimeFactor(remainingBar);
    if (factor <= 1) factor = 2;
    beatsPerFlash *= factor;
    if (remainingBar % factor === 0) remainingBar /= factor;
  }
  return beatsPerFlash;
}

function smallestPrimeFactor(value: number): number {
  for (let i = 2; i <= value / i; i++) if (value % i === 0) return i;
  return value;
}

// ---------------------------------------------------------------- PanelSetBackground

/** PanelSetBackground: gradient base, the beatmap background (loaded with a distance-based delay) and the sheared dark overlay. */
class PanelSetBackground {
  readonly el: HTMLDivElement;
  private readonly image: HTMLDivElement;
  private url: string | null = null;
  private timer = 0;

  constructor(colours: OverlayColourProvider) {
    this.image = h('div', { class: 'psb-image' });
    this.el = h('div', { class: 'psb' }, this.image, h('div', { class: 'psb-shear' }));
    this.el.style.background = `linear-gradient(90deg, ${css(colours.background3)}, ${css(colours.background4)})`;
  }

  /** Beatmap = ... (scheduled 50ms after unpooling; the load itself waits proportionally to the distance from the carousel centre). */
  set(url: string | null, delay: number): void {
    clearTimeout(this.timer);
    if (url === this.url) return;
    this.url = url;
    this.image.style.transition = 'none';
    this.image.style.opacity = '0';
    this.image.style.backgroundImage = '';
    if (!url) return;
    this.timer = window.setTimeout(() => {
      const img = new Image();
      img.onload = () => {
        if (this.url !== url) return;
        this.image.style.backgroundImage = `url("${url}")`;
        tween(this.image, { opacity: '1' }, 400, Easing.OutQuint);
      };
      img.src = url;
    }, 50 + delay);
  }

  clear(): void {
    clearTimeout(this.timer);
    this.url = null;
    this.image.style.backgroundImage = '';
    this.image.style.opacity = '0';
  }
}

// ---------------------------------------------------------------- PanelLocalRankDisplay / DrawableRank

class LocalRankDisplay {
  readonly el: HTMLDivElement;
  hasRank = false;
  private token = 0;

  constructor() {
    this.el = h('div', { class: 'local-rank' });
    this.el.style.display = 'none';
  }

  load(ctx: PanelContext, b: FilterBeatmap | null, onChange: () => void): void {
    const token = ++this.token;
    this.set(null);
    if (!b) return;
    ctx.localRank(b, rank => {
      if (token !== this.token) return;
      this.set(rank);
      onChange();
    });
  }

  private set(rank: ScoreRank | null): void {
    this.hasRank = rank != null;
    this.el.style.display = rank ? '' : 'none';
    if (!rank) return;
    this.el.textContent = rankLetter(rank);
    this.el.style.background = css(forRank(rank));
    this.el.style.color = css(rankLetterColour(rank));
  }
}

// ---------------------------------------------------------------- PanelBeatmapSet

export class PanelBeatmapSet extends Panel {
  static readonly HEIGHT = 45 * 1.6;
  private readonly chevron: HTMLDivElement;
  private readonly background: PanelSetBackground;
  private readonly title: HTMLDivElement;
  private readonly artist: HTMLDivElement;
  private readonly pill: HTMLDivElement;
  private readonly spread: SpreadDisplay;

  constructor(ctx: PanelContext) {
    super('set', ctx, PanelBeatmapSet.HEIGHT);
    this.panelXOffset = 20;
    const c = ctx.colours;
    this.chevron = h('div', { class: 'pset-chevron' }, icon('chevronRight', 8));
    this.chevron.style.color = css(c.background5);
    this.iconBox.appendChild(this.chevron);
    this.bg.style.background = '#fff';
    this.bg.style.opacity = '0';
    this.background = new PanelSetBackground(c);
    this.title = h('div', { class: 'pset-title' });
    this.artist = h('div', { class: 'pset-artist' });
    this.pill = statusPill(0, false, c, 'small');
    this.spread = new SpreadDisplay(ctx);
    this.content.append(this.background.el, h('div', { class: 'pset-text' }, this.title, this.artist, h('div', { class: 'pset-row' }, this.pill, this.spread.el)));
  }

  private get groupedSet(): GroupedBeatmapSet {
    return this.item!.model as GroupedBeatmapSet;
  }

  protected onPrepare(): void {
    const set = this.groupedSet.beatmapSet;
    const record = this.ctx.recordOf(set);
    const m = set.metadata;
    const uni = this.ctx.preferUnicode();
    this.title.textContent = (uni && m.titleUnicode) || m.title;
    this.artist.textContent = (uni && m.artistUnicode) || m.artist;
    updateStatusPill(this.pill, set.status, false, this.ctx.colours);
    this.background.set(record ? this.ctx.backgroundUrl(record) : null, 0);
    this.spread.setSet(set, this.ctx.visibleBeatmaps(this.groupedSet));
    this.onExpandedChanged(false);
  }

  refreshVisibleBeatmaps(): void {
    if (this.item) this.spread.setSet(this.groupedSet.beatmapSet, this.ctx.visibleBeatmaps(this.groupedSet));
  }

  protected onFree(): void {
    this.background.clear();
    this.spread.setSet(null, null);
  }

  protected onExpandedChanged(animated = true): void {
    const d = animated ? 1 : 0;
    if (this.expanded) {
      tween(this.bg, { opacity: '1' }, (DURATION / 2) * d, Easing.OutQuint);
      tween(this.chevron, { width: '18px', opacity: '1' }, DURATION * 1.5 * d, Easing.OutElasticQuarter);
      this.chevron.style.transition = `width ${DURATION * 1.5 * d}ms ${cssEasing(Easing.OutElasticQuarter)}, opacity ${DURATION * d}ms ${cssEasing(Easing.OutQuint)}`;
      tween(this.contentPad, { left: '18px' }, DURATION * 1.5 * d, Easing.OutElasticQuarter);
    } else {
      tween(this.bg, { opacity: '0' }, DURATION * d, Easing.OutQuint);
      tween(this.chevron, { width: '0px', opacity: '0' }, DURATION * d, Easing.OutQuint);
      tween(this.contentPad, { left: '0px' }, DURATION * d, Easing.OutQuint);
    }
    this.spread.setExpanded(this.expanded);
  }
}

/** PanelBeatmapSet.SpreadDisplay */
class SpreadDisplay {
  readonly el: HTMLDivElement;
  private readonly flow: HTMLDivElement;
  private readonly eye: SVGSVGElement;
  private set: FilterBeatmapSet | null = null;
  private expanded = false;

  constructor(private readonly ctx: PanelContext) {
    this.flow = h('div', { class: 'spread-flow' });
    this.eye = icon('eye', 12, 'spread-eye');
    this.el = h('div', { class: 'spread' }, this.flow, this.eye);
    this.el.addEventListener('click', e => {
      if (!this.enabled) return;
      e.stopPropagation();
      if (this.set) ctx.scopeToSet(this.set);
    });
  }

  private get enabled(): boolean {
    return this.expanded && this.ctx.canScope();
  }

  setExpanded(v: boolean): void {
    this.expanded = v;
    this.el.classList.toggle('enabled', this.enabled);
  }

  setSet(set: FilterBeatmapSet | null, visible: Set<FilterBeatmap> | null): void {
    this.set = set;
    this.flow.textContent = '';
    if (!set) {
      tween(this.el, { opacity: '0' }, 200, Easing.OutQuint);
      return;
    }
    const MAX_BEFORE_COLLAPSING = 12;
    const r = this.ctx.ruleset();
    const target = { shortName: r.shortName, onlineId: r.id };
    const beatmaps = set.beatmaps.filter(b => allowGameplayWithRuleset(b.ruleset, target, this.ctx.showConverts()));
    tween(this.el, { opacity: beatmaps.length > 0 ? '1' : '0' }, 200, Easing.OutQuint);
    if (beatmaps.length === 0) return;

    const showVisible = visible == null || visible.size <= MAX_BEFORE_COLLAPSING;
    const showHidden = beatmaps.length <= MAX_BEFORE_COLLAPSING;
    const byRuleset = new Map<number, FilterBeatmap[]>();
    for (const b of beatmaps) {
      if (!byRuleset.has(b.ruleset.onlineId)) byRuleset.set(b.ruleset.onlineId, []);
      byRuleset.get(b.ruleset.onlineId)!.push(b);
    }
    for (const [rulesetId, group] of [...byRuleset].sort((a, b) => a[0] - b[0])) {
      const ri = rulesetIcon(rulesetId, 14, 'spread-ruleset');
      if (this.flow.childElementCount > 0) ri.style.marginLeft = '9px';
      this.flow.appendChild(ri);
      let overflowVisible = 0;
      let overflowHidden = 0;
      let lastVisible: boolean | null = null;
      for (const b of [...group].sort((a, c) => a.starRating - c.starRating)) {
        const isVisible = visible?.has(b) !== false;
        if ((isVisible && showVisible) || (!isVisible && showHidden)) {
          const dot = h('div', { class: `spread-dot${isVisible ? '' : ' hidden'}` });
          dot.style.background = css(forStarDifficulty(b.starRating));
          if (lastVisible != null && lastVisible !== isVisible) dot.style.marginLeft = '1px';
          this.flow.appendChild(dot);
          lastVisible = isVisible;
        } else if (isVisible) overflowVisible++;
        else overflowHidden++;
      }
      if (overflowVisible > 0) this.flow.appendChild(h('span', { class: 'spread-count' }, String(overflowVisible)));
      if (overflowHidden > 0) this.flow.appendChild(h('span', { class: 'spread-count hidden' }, `+${overflowHidden}`));
    }
  }
}

// ---------------------------------------------------------------- PanelBeatmap / PanelBeatmapStandalone

abstract class BeatmapPanelBase extends Panel {
  protected readonly diffIcon: HTMLDivElement;
  protected readonly localRank = new LocalRankDisplay();
  protected readonly mainFill: HTMLDivElement;
  protected readonly variantText: HTMLSpanElement;
  protected readonly difficultyText: HTMLSpanElement;
  protected readonly authorText: HTMLSpanElement;
  protected readonly stars: StarRatingDisplay;
  private unsubscribeStars: (() => void) | null = null;

  constructor(kind: PanelKind, ctx: PanelContext, height: number, iconSize: number) {
    super(kind, ctx, height);
    this.diffIcon = h('div', { class: 'pb-icon' });
    this.diffIcon.style.setProperty('--size', `${iconSize}px`);
    this.iconBox.appendChild(this.diffIcon);
    this.variantText = h('span', { class: 'pb-variant' });
    this.difficultyText = h('span', { class: 'pb-diff' });
    this.authorText = h('span', { class: 'pb-author' });
    this.authorText.style.color = css(ctx.colours.content2);
    this.stars = new StarRatingDisplay('small', true);
    this.stars.onChange = () => this.onStarsChanged();
    this.mainFill = h('div', { class: 'pb-main' });
  }

  protected get beatmap(): FilterBeatmap {
    return (this.item!.model as GroupedBeatmap).beatmap;
  }

  protected onPrepare(): void {
    const b = this.beatmap;
    const src = this.ctx.sourceOf(b);
    this.diffIcon.textContent = '';
    this.diffIcon.appendChild(rulesetIcon(b.ruleset.onlineId, parseFloat(this.diffIcon.style.getPropertyValue('--size'))));
    this.difficultyText.textContent = b.difficultyName;
    this.authorText.textContent = `mapped by ${b.metadata.author}`;
    this.localRank.load(this.ctx, b, () => this.updateMainFillMargin());
    this.updateMainFillMargin();
    this.updateKeyCount();
    // computeStarRating (BeatmapDifficultyCache.GetBindableDifficulty with SongSelect.DIFFICULTY_CALCULATION_DEBOUNCE)
    this.unsubscribeStars?.();
    this.stars.set(null);
    this.unsubscribeStars = difficultyCache.get(src.set, src.entry, this.ctx.ruleset(), this.ctx.mods(), s => {
      if (this.item && (this.item.model as GroupedBeatmap).beatmap === b) this.stars.set(s);
    });
  }

  /** Re-requests the star rating (ruleset / mods changed). */
  recomputeStars(): void {
    if (!this.item) return;
    const b = this.beatmap;
    const src = this.ctx.sourceOf(b);
    this.unsubscribeStars?.();
    this.unsubscribeStars = difficultyCache.get(src.set, src.entry, this.ctx.ruleset(), this.ctx.mods(), s => {
      if (this.item && (this.item.model as GroupedBeatmap).beatmap === b) this.stars.set(s);
    });
    this.updateKeyCount();
  }

  protected onFree(): void {
    this.unsubscribeStars?.();
    this.unsubscribeStars = null;
    this.localRank.load(this.ctx, null, () => undefined);
  }

  /** updateKeyCount: "[nK] " when the ruleset has more than one gameplay variant (mania). */
  protected updateKeyCount(): void {
    if (!this.item) return;
    if (this.ctx.ruleset().id === 3) {
      this.variantText.style.display = '';
      this.variantText.textContent = `[${maniaColumnCount(this.ctx.sourceOf(this.beatmap).entry, this.ctx.mods())}K] `;
    } else this.variantText.style.display = 'none';
  }

  private updateMainFillMargin(): void {
    this.mainFill.style.marginLeft = `${(1 / 0.875) * (this.localRank.hasRank ? 0 : -3)}px`;
  }

  protected abstract onStarsChanged(): void;
}

export class PanelBeatmap extends BeatmapPanelBase {
  static readonly HEIGHT = 45;
  private readonly tint: HTMLDivElement;
  private readonly starCounter: HTMLDivElement;

  constructor(ctx: PanelContext) {
    super('beatmap', ctx, PanelBeatmap.HEIGHT, 9);
    this.panelXOffset = 60;
    const c = ctx.colours;
    this.diffIcon.style.margin = '0 1.5px 0 2.5px';
    this.diffIcon.style.color = css(c.background5);
    this.tint = h('div', { class: 'pb-tint' });
    this.starCounter = h('div', { class: 'star-counter' }, Array.from({ length: 10 }, () => icon('star', 8)));
    this.mainFill.append(h('div', { class: 'pb-line1' }, this.variantText, this.difficultyText, this.authorText), h('div', { class: 'pb-line2' }, this.stars.el, this.starCounter));
    const base = h('div', { class: 'pb-base' });
    base.style.background = `linear-gradient(90deg, ${css(c.background3)}, ${css(c.background4)})`;
    this.content.append(base, this.tint, h('div', { class: 'pb-tri' }), h('div', { class: 'pb-flow' }, this.localRank.el, this.mainFill));
  }

  protected onStarsChanged(): void {
    const diff = this.stars.displayedColour;
    this.setAccentColour(diff);
    this.bg.style.background = css(diff);
    this.tint.style.background = `linear-gradient(90deg, ${css(diff, 0.25)}, ${css(diff, 0)})`;
    this.starCounter.style.color = css(diff);
    this.diffIcon.style.color = css(this.stars.displayedTextColour);
    // StarCounter.Current
    const v = this.stars.displayedStars;
    [...this.starCounter.children].forEach((s, i) => {
      const fill = Math.max(0, Math.min(1, v - i));
      (s as SVGElement).style.opacity = String(0.2 + 0.8 * fill);
      (s as SVGElement).style.transform = `scale(${0.5 + 0.5 * fill})`;
    });
  }
}

export class PanelBeatmapStandalone extends BeatmapPanelBase {
  static readonly HEIGHT = 45 * 1.6;
  private readonly background: PanelSetBackground;
  private readonly title: HTMLDivElement;
  private readonly artist: HTMLDivElement;
  private readonly pill: HTMLDivElement;
  private readonly spreadDots: HTMLDivElement;

  constructor(ctx: PanelContext) {
    super('standalone', ctx, PanelBeatmapStandalone.HEIGHT, 12);
    this.panelXOffset = 20;
    this.diffIcon.style.margin = '0 3px 0 4px';
    this.background = new PanelSetBackground(ctx.colours);
    this.title = h('div', { class: 'pbs-title' });
    this.artist = h('div', { class: 'pbs-artist' });
    this.pill = statusPill(0, false, ctx.colours, 'small');
    this.spreadDots = h('div', { class: 'pbs-spread' });
    this.mainFill.classList.add('pbs-main');
    this.mainFill.append(this.title, this.artist, h('div', { class: 'pbs-row' }, this.pill, this.variantText, this.difficultyText, this.authorText), h('div', { class: 'pb-line2' }, this.stars.el, this.spreadDots));
    this.content.append(this.background.el, h('div', { class: 'pb-flow' }, this.localRank.el, this.mainFill));
  }

  protected onPrepare(): void {
    super.onPrepare();
    const b = this.beatmap;
    const m = b.set.metadata;
    const uni = this.ctx.preferUnicode();
    this.title.textContent = (uni && m.titleUnicode) || m.title;
    this.artist.textContent = (uni && m.artistUnicode) || m.artist;
    updateStatusPill(this.pill, b.status, false, this.ctx.colours);
    const record = this.ctx.recordOf(b.set);
    this.background.set(record ? this.ctx.backgroundUrl(record) : null, 0);
    this.updateSpread();
  }

  protected onFree(): void {
    super.onFree();
    this.background.clear();
  }

  /** PanelBeatmapStandalone.SpreadDisplay: the other difficulties of the set as dots, with this one highlighted. */
  private updateSpread(): void {
    this.spreadDots.textContent = '';
    const b = this.beatmap;
    const r = this.ctx.ruleset();
    const others = b.set.beatmaps.filter(x => allowGameplayWithRuleset(x.ruleset, { shortName: r.shortName, onlineId: r.id }, this.ctx.showConverts())).sort((x, y) => x.starRating - y.starRating);
    if (others.length <= 1) return;
    for (const o of others.slice(0, 12)) {
      const dot = h('div', { class: `spread-dot${o === b ? '' : ' hidden'}` });
      dot.style.background = css(forStarDifficulty(o.starRating));
      this.spreadDots.appendChild(dot);
    }
    if (others.length > 12) this.spreadDots.appendChild(h('span', { class: 'spread-count hidden' }, `+${others.length - 12}`));
  }

  protected onStarsChanged(): void {
    const diff = this.stars.displayedColour;
    this.setAccentColour(diff);
    this.bg.style.background = css(diff);
    this.diffIcon.style.color = css(this.stars.displayedTextColour);
  }

  protected onExpandedChanged(): void {
    // Selected.BindValueChanged(s => Expanded.Value = s.NewValue)
  }
}

// ---------------------------------------------------------------- PanelGroup

export class PanelGroup extends Panel {
  static readonly HEIGHT = 45 * 1.2;
  private readonly chevron: HTMLDivElement;
  private readonly tri: HTMLDivElement;
  private readonly glow: HTMLDivElement;
  private readonly title: HTMLDivElement;
  private readonly countPill: HTMLDivElement;
  private readonly countText: HTMLSpanElement;

  constructor(ctx: PanelContext) {
    super('group', ctx, PanelGroup.HEIGHT);
    this.panelXOffset = 0;
    const c = ctx.colours;
    this.chevron = h('div', { class: 'pg-chevron' }, icon('chevronDown', 12));
    this.chevron.style.color = css(c.background3);
    this.iconBox.appendChild(this.chevron);
    this.bg.style.background = css(c.highlight1);
    this.accentColour = c.highlight1;
    const base = h('div', { class: 'pg-base' });
    base.style.background = css(c.background5);
    this.tri = h('div', { class: 'pg-tri' });
    this.glow = h('div', { class: 'pg-glow' });
    this.glow.style.background = `linear-gradient(90deg, ${css(c.highlight1)}, ${css(c.highlight1, 0)})`;
    this.title = h('div', { class: 'pg-title' });
    this.countText = h('span');
    this.countPill = h('div', { class: 'pg-count' }, this.countText);
    this.content.append(base, this.tri, this.glow, this.title, this.countPill);
  }

  protected onPrepare(): void {
    const group = this.item!.model as GroupDefinition;
    this.title.textContent = group.title;
    this.countText.textContent = this.item!.nestedItemCount.toLocaleString('en-US');
    // PanelGroupStarDifficulty: star groups are tinted with the star colour.
    if (group instanceof StarDifficultyGroupDefinition) {
      const col = forStarDifficulty(group.stars);
      this.setAccentColour(col);
      this.bg.style.background = css(col);
      this.glow.style.background = `linear-gradient(90deg, ${css(col)}, ${css(col, 0)})`;
      this.chevron.style.color = css(forStarDifficultyText(group.stars));
    }
    this.onExpandedChanged(false);
  }

  protected onExpandedChanged(animated = true): void {
    const d = animated ? 500 : 0;
    const c = this.ctx.colours;
    tween(this.chevron, { width: this.expanded ? '20px' : '5px', opacity: this.expanded ? '1' : '0' }, d, Easing.OutQuint);
    tween(this.contentPad, { left: this.expanded ? '20px' : '5px' }, d, Easing.OutQuint);
    
    this.tri.style.background = this.expanded
      ? `linear-gradient(90deg, ${css(c.highlight1, 0.25)}, ${css(c.highlight1, 0)})`
      : `linear-gradient(90deg, ${css(c.background6)}, ${css(c.background5)})`;
    tween(this.glow, { opacity: this.expanded ? '0.4' : '0' }, d, Easing.OutQuint);
  }

  /** UpdateAfterChildren: countPill.X = -TopLevelContent.X */
  update(): void {
    this.countPill.style.transform = `translate(${-this.currentTopX()}px, -50%)`;
  }
}

export function opacityOf(c: RGBA, a: number): string {
  return css(opacity(c, a));
}
