// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game/Storyboards/Drawables/DrawableStoryboard.cs, DrawableStoryboardLayer.cs (+ LayerElementContainer, a
// LifetimeManagementContainer), DrawableStoryboardSprite.cs and DrawableStoryboardAnimation.cs (with osu-framework's Animation frame logic),
// rendered with Canvas 2D.
//
// Layout (as in lazer): the storyboard is 640x480 (or 16:9 wide — 853.33x480 — when WidescreenStoryboard is set or it only contains a video),
// centred on the screen and scaled by screen height / 480. Each layer (except Video) masks its elements to that area; elements are positioned
// in a centred 640x480 container. Layers are drawn by decreasing depth (Video, Background, Fail, Pass, Foreground, custom layers), with the
// Overlay layer drawn separately above the playfield. Fail/Pass are switched by the passing state.

import type { HitSampleInfo } from '../audio/HitSampleInfo';
import { adjustOrigin, anchorX, anchorY } from './Anchor';
import { SpriteState, SpriteTimeline } from './CommandTimeline';
import type { DrawableStoryboardSamples } from './DrawableStoryboardSample';
import { DrawableStoryboardVideo, type ScreenMapping } from './DrawableStoryboardVideo';
import { AnimationLoopType, type Storyboard, StoryboardAnimation, type StoryboardLayer, StoryboardSprite, StoryboardVideo } from './Storyboard';
import { StoryboardTriggerController } from './StoryboardTriggerController';
import { type StoryboardTexture, type StoryboardTextureStore, TextureState } from './TextureStore';

/** Textures are decoded this far (ms) ahead of the elements using them becoming alive. */
const PREFETCH_LOOKAHEAD = 4000;
/** Decoded textures are released once no element will display them for this long (ms). */
const EVICTION_DELAY = 2000;

const toByte = (v: number): number => (v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255));

/** DrawableStoryboardSprite / DrawableStoryboardAnimation */
export class DrawableStoryboardSprite {
  readonly timeline: SpriteTimeline;
  readonly lifetimeStart: number;
  readonly lifetimeEnd: number;
  /** One texture for sprites, one per frame for animations (null where the file is missing). */
  readonly textures: (StoryboardTexture | null)[];
  private readonly animation: StoryboardAnimation | null;
  private readonly earliestTransformTime: number;

  constructor(
    readonly sprite: StoryboardSprite,
    readonly index: number,
    store: StoryboardTextureStore,
  ) {
    this.timeline = new SpriteTimeline(sprite);
    this.lifetimeStart = sprite.startTime;
    this.lifetimeEnd = sprite.endTimeForDisplay;
    this.earliestTransformTime = sprite.earliestTransformTime;

    if (sprite instanceof StoryboardAnimation) {
      this.animation = sprite;
      this.textures = [];
      // addFramesFromStoryboardSource
      for (let i = 0; i < sprite.frameCount; i++) this.textures.push(store.get(sprite.getFramePath(i)));
    } else {
      this.animation = null;
      this.textures = [store.get(sprite.path)];
    }

    for (const t of this.textures) if (t && this.lifetimeEnd > t.lastUseEnd) t.lastUseEnd = this.lifetimeEnd;
  }

  /** LifetimeManagementContainer: alive while LifetimeStart <= time < LifetimeEnd. */
  isAliveAt(time: number): boolean {
    return time >= this.lifetimeStart && time < this.lifetimeEnd;
  }

  /** The animation frame shown at `time` (Animation.updateFrameIndex with PlaybackPosition = time - EarliestTransformTime). */
  frameAt(time: number): number {
    const anim = this.animation;
    if (!anim) return 0;
    const count = this.textures.length;
    if (count === 0) return -1;
    const delay = anim.frameDelay;
    const duration = count * delay;
    if (!(duration >= 0)) return 0;
    let position = time - this.earliestTransformTime;
    if (anim.loopType === AnimationLoopType.LoopForever) position %= duration;
    position = Math.min(Math.max(position, 0), duration);
    if (!(position >= 0) || !(delay > 0)) return 0;
    const frame = Math.floor(position / delay);
    return frame >= count ? count - 1 : frame;
  }
}

class DrawableStoryboardLayer {
  /** Elements in file order (LayerElementContainer only adds drawable elements). */
  readonly sprites: DrawableStoryboardSprite[] = [];
  readonly videos: DrawableStoryboardVideo[] = [];
  /** Indices into `sprites`, sorted by lifetime start. */
  private byStart: Int32Array = new Int32Array(0);
  /** Alive sprite indices, kept in file order. */
  private active = new Int32Array(0);
  private activeCount = 0;
  private nextToActivate = 0;
  private nextToPrefetch = 0;
  private lastTime = NaN;

  /** DrawableStoryboardLayer.Enabled */
  enabled: boolean;

  constructor(readonly layer: StoryboardLayer) {
    this.enabled = layer.visibleWhenPassing;
  }

  finalise(): void {
    const n = this.sprites.length;
    const order = Array.from({ length: n }, (_, i) => i);
    order.sort((a, b) => this.sprites[a].lifetimeStart - this.sprites[b].lifetimeStart || a - b);
    this.byStart = Int32Array.from(order);
    this.active = new Int32Array(n);
  }

  /** Elements becoming alive before `until` (used to preload textures). */
  spritesStartingBefore(from: number, until: number): DrawableStoryboardSprite[] {
    return this.sprites.filter(s => s.lifetimeStart <= until && s.lifetimeEnd > from);
  }

  /** Updates the alive list for `time` (time-ordered activation; a full rebuild only when time goes backwards). */
  update(time: number, store: StoryboardTextureStore): void {
    if (time === this.lastTime) return;
    const sprites = this.sprites;
    const byStart = this.byStart;
    const n = byStart.length;

    if (!(time >= this.lastTime)) {
      // first update or rewind: rebuild
      this.activeCount = 0;
      let i = 0;
      while (i < n && sprites[byStart[i]].lifetimeStart <= time) i++;
      this.nextToActivate = i;
      this.nextToPrefetch = i;
      for (let j = 0; j < sprites.length; j++) if (sprites[j].isAliveAt(time)) this.active[this.activeCount++] = j;
    } else {
      let changed = false;
      // remove elements which are no longer alive
      let w = 0;
      for (let r = 0; r < this.activeCount; r++) {
        const idx = this.active[r];
        if (time < sprites[idx].lifetimeEnd) this.active[w++] = idx;
      }
      this.activeCount = w;
      // add newly alive elements
      while (this.nextToActivate < n && sprites[byStart[this.nextToActivate]].lifetimeStart <= time) {
        const idx = byStart[this.nextToActivate++];
        if (time < sprites[idx].lifetimeEnd) {
          this.active[this.activeCount++] = idx;
          changed = true;
        }
      }
      if (changed) this.active.subarray(0, this.activeCount).sort();
    }
    this.lastTime = time;

    // decode textures shortly before they are needed
    if (this.nextToPrefetch < this.nextToActivate) this.nextToPrefetch = this.nextToActivate;
    while (this.nextToPrefetch < n && sprites[byStart[this.nextToPrefetch]].lifetimeStart <= time + PREFETCH_LOOKAHEAD) {
      for (const t of sprites[byStart[this.nextToPrefetch++]].textures) if (t) store.request(t);
    }
  }

  get activeSprites(): Int32Array {
    return this.active.subarray(0, this.activeCount);
  }
}

export interface StoryboardFrameState {
  passing: boolean;
  running: boolean;
  rate: number;
}

export class DrawableStoryboard {
  readonly layers: DrawableStoryboardLayer[] = [];
  readonly overlayLayer: DrawableStoryboardLayer | null;
  readonly triggerController = new StoryboardTriggerController();
  /** Storyboard width in storyboard units (DrawableStoryboard: Height * (widescreen || onlyHasVideoElements ? 16 / 9 : 4 / 3)). */
  readonly storyboardWidth: number;
  readonly videos: DrawableStoryboardVideo[] = [];

  private readonly state = new SpriteState();
  private lastUpdateTime = NaN;
  private lastSyncTime = NaN;
  private lastSyncRunning = false;
  private lastSyncRate = NaN;
  private passing = true;
  private nextEvictionTime = -Infinity;

  constructor(
    readonly storyboard: Storyboard,
    readonly store: StoryboardTextureStore,
    readonly samples: DrawableStoryboardSamples | null,
  ) {
    const elements = storyboard.layerList.flatMap(l => l.elements);
    const onlyHasVideoElements = elements.every(e => e instanceof StoryboardVideo);
    this.storyboardWidth = 480 * (storyboard.widescreenStoryboard || onlyHasVideoElements ? 16 / 9 : 4 / 3);

    let overlay: DrawableStoryboardLayer | null = null;
    // Container children are drawn by decreasing depth (higher depth = further back).
    const layers = [...storyboard.layerList].sort((a, b) => b.depth - a.depth);
    for (const layer of layers) {
      const drawable = new DrawableStoryboardLayer(layer);
      for (const element of layer.elements) {
        if (!element.isDrawable) continue;
        if (element instanceof StoryboardVideo) {
          const blob = store.getBlob(store.getPathForFile(element.path) ?? '');
          if (!blob) continue;
          const video = new DrawableStoryboardVideo(element, blob);
          drawable.videos.push(video);
          this.videos.push(video);
          for (const tg of element.triggerGroups) this.triggerController.bind(video.timeline, tg);
        } else if (element instanceof StoryboardSprite) {
          const sprite = new DrawableStoryboardSprite(element, drawable.sprites.length, store);
          drawable.sprites.push(sprite);
          for (const tg of element.triggerGroups) this.triggerController.bind(sprite.timeline, tg);
        }
        // StoryboardSampleInfo elements are played by DrawableStoryboardSamples.
      }
      drawable.finalise();
      if (layer.name === 'Overlay') overlay = drawable;
      else this.layers.push(drawable);
    }
    this.overlayLayer = overlay;
  }

  /** Waits for the textures needed around `time` to be decoded (and for video metadata), so the first frames aren't missing elements. */
  async preload(time: number, window = 3000): Promise<void> {
    const jobs: Promise<void>[] = [];
    const seen = new Set<StoryboardTexture>();
    for (const layer of [...this.layers, ...(this.overlayLayer ? [this.overlayLayer] : [])]) {
      for (const s of layer.spritesStartingBefore(time, time + window)) {
        for (const t of s.textures) {
          if (!t || seen.has(t)) continue;
          seen.add(t);
          jobs.push(this.store.load(t));
        }
      }
    }
    for (const v of this.videos) jobs.push(v.ready);
    await Promise.all(jobs);
  }

  /** Advances lifetimes, triggers, samples, video sync and texture streaming to `time` (idempotent for the same time). */
  update(time: number, frame: StoryboardFrameState): void {
    if (time !== this.lastUpdateTime) {
      if (time < this.lastUpdateTime) this.nextEvictionTime = -Infinity;
      this.lastUpdateTime = time;

      // DrawableStoryboard: passing.BindValueChanged(updateLayerVisibility) + StoryboardTriggerController.bindPassing
      if (frame.passing !== this.passing) {
        this.passing = frame.passing;
        this.triggerController.onPassingChanged(frame.passing, time);
      }

      for (const layer of this.layers) layer.update(time, this.store);
      this.overlayLayer?.update(time, this.store);

      if (time >= this.nextEvictionTime) {
        this.store.evict(time - EVICTION_DELAY);
        this.nextEvictionTime = time + 1000;
      }
    }

    for (const layer of this.layers) layer.enabled = frame.passing ? layer.layer.visibleWhenPassing : layer.layer.visibleWhenFailing;
    if (this.overlayLayer) this.overlayLayer.enabled = frame.passing ? this.overlayLayer.layer.visibleWhenPassing : this.overlayLayer.layer.visibleWhenFailing;

    // drawUnder and drawOver both update; only re-sync audio/video when something changed.
    if (time === this.lastSyncTime && frame.running === this.lastSyncRunning && frame.rate === this.lastSyncRate) return;
    this.lastSyncTime = time;
    this.lastSyncRunning = frame.running;
    this.lastSyncRate = frame.rate;
    this.samples?.update(time, frame.running, frame.rate);
    for (const v of this.videos) v.update(time, frame.running, frame.rate);
  }

  /** The time the last judgement/sample was applied at (the drawables' Time.Current). */
  get currentTime(): number {
    return Number.isNaN(this.lastUpdateTime) ? 0 : this.lastUpdateTime;
  }

  onHitObjectHit(): void {
    this.triggerController.onHitObjectHit(this.currentTime);
  }

  onSamplesPlayed(samples: readonly HitSampleInfo[]): void {
    this.triggerController.onSamplesPlayed(samples, this.currentTime);
  }

  mapping(width: number, height: number): ScreenMapping {
    const scale = height / 480;
    return {
      scale,
      originX: width / 2 - 320 * scale,
      originY: height / 2 - 240 * scale,
      storyboardWidth: this.storyboardWidth,
      canvasWidth: width,
      canvasHeight: height,
    };
  }

  /** Draws every layer except Overlay. */
  drawLayers(g: CanvasRenderingContext2D, width: number, height: number, time: number): void {
    const map = this.mapping(width, height);
    const base = g.getTransform();
    for (const layer of this.layers) this.drawLayer(g, layer, time, map, base);
    g.setTransform(base);
  }

  /**
   * Draws the Overlay layer. In lazer it is a proxy of a layer inside the dimmed storyboard container, so it is dimmed like the rest of the
   * storyboard even though it is displayed above the playfield: `dim` (0..1) darkens its colours accordingly.
   */
  drawOverlay(g: CanvasRenderingContext2D, width: number, height: number, time: number, dim = 0): void {
    if (!this.overlayLayer) return;
    const map = this.mapping(width, height);
    const base = g.getTransform();
    this.drawLayer(g, this.overlayLayer, time, map, base, 1 - Math.min(1, Math.max(0, dim)));
    g.setTransform(base);
  }

  private drawLayer(g: CanvasRenderingContext2D, layer: DrawableStoryboardLayer, time: number, map: ScreenMapping, base: DOMMatrix, colourScale = 1): void {
    if (!layer.enabled) return;
    const active = layer.activeSprites;
    if (active.length === 0 && layer.videos.length === 0) return;

    g.save();
    g.setTransform(base);

    // Clip/cull rectangle in screen (CSS pixel) space.
    let clipX = 0;
    let clipY = 0;
    let clipR = map.canvasWidth;
    let clipB = map.canvasHeight;
    if (layer.layer.masking) {
      const k = map.scale;
      const x = map.canvasWidth / 2 - (map.storyboardWidth * k) / 2;
      const y = map.canvasHeight / 2 - 240 * k;
      g.beginPath();
      g.rect(x, y, map.storyboardWidth * k, 480 * k);
      g.clip();
      clipX = Math.max(clipX, x);
      clipY = Math.max(clipY, y);
      clipR = Math.min(clipR, x + map.storyboardWidth * k);
      clipB = Math.min(clipB, y + 480 * k);
    }

    for (const v of layer.videos) v.draw(g, time, map, base);

    let currentAlpha = -1;
    let currentAdditive: boolean | null = null;
    const sprites = layer.sprites;
    for (let i = 0; i < active.length; i++) {
      const sprite = sprites[active[i]];
      const tl = sprite.timeline;

      // In stable, alpha transforms exceeding values of 1 would result in sprites disappearing from view. Over the years, storyboarders
      // have taken advantage of this to create "flicker" patterns, so this is reproduced here (DrawableStoryboardSprite.Update).
      let alpha = tl.alphaAt(time);
      if (alpha > 1) alpha %= 1;
      if (!(alpha > 0.0001)) continue; // Drawable.IsPresent

      const frame = sprite.frameAt(time);
      if (frame < 0) continue;
      const tex = sprite.textures[frame];
      if (!tex) continue;
      if (tex.state !== TextureState.Ready) {
        this.store.request(tex);
        continue;
      }
      const w = tex.width;
      const h = tex.height;
      if (w === 0 || h === 0) continue;

      const st = this.state;
      tl.evaluate(time, st);

      // DrawScale = (flip ? -1 : 1) * Scale * VectorScale
      const sx = (st.flipH ? -1 : 1) * st.scaleX * st.vectorScaleX;
      const sy = (st.flipV ? -1 : 1) * st.scaleY * st.vectorScaleY;
      if (!(Math.abs(sx) > 0.0001 && Math.abs(sy) > 0.0001)) continue;
      if (Number.isNaN(st.x) || Number.isNaN(st.y)) continue;

      const origin = adjustOrigin(sprite.sprite.origin, st.vectorScaleX, st.vectorScaleY, st.flipH, st.flipV);
      const ox = anchorX(origin) * w;
      const oy = anchorY(origin) * h;

      // local → screen: Scale(storyboard) · Translate(position) · Rotate · Scale(DrawScale) · Translate(-OriginPosition)
      const k = map.scale;
      const rad = (st.rotation * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      const a = k * cos * sx;
      const b = k * sin * sx;
      const c = -k * sin * sy;
      const d = k * cos * sy;
      const e = map.originX + k * (st.x - cos * sx * ox + sin * sy * oy);
      const f = map.originY + k * (st.y - sin * sx * ox - cos * sy * oy);

      // cull against the visible (clipped) area
      const x1 = a * w;
      const y1 = b * w;
      const x2 = c * h;
      const y2 = d * h;
      const minX = e + Math.min(0, x1) + Math.min(0, x2);
      const maxX = e + Math.max(0, x1) + Math.max(0, x2);
      const minY = f + Math.min(0, y1) + Math.min(0, y2);
      const maxY = f + Math.max(0, y1) + Math.max(0, y2);
      if (maxX < clipX || minX > clipR || maxY < clipY || minY > clipB) continue;

      g.setTransform(base.a * a + base.c * b, base.b * a + base.d * b, base.a * c + base.c * d, base.b * c + base.d * d, base.a * e + base.c * f + base.e, base.b * e + base.d * f + base.f);
      if (st.additive !== currentAdditive) {
        currentAdditive = st.additive;
        g.globalCompositeOperation = st.additive ? 'lighter' : 'source-over';
      }

      // Colour (multiplicative tint), clamped to displayable values.
      const cr = toByte(st.r * colourScale);
      const cg = toByte(st.g * colourScale);
      const cb = toByte(st.b * colourScale);

      const solid = tex.solid;
      if (solid) {
        const drawAlpha = alpha * solid[3];
        if (drawAlpha !== currentAlpha) g.globalAlpha = currentAlpha = drawAlpha;
        g.fillStyle = this.store.fillStyle(Math.round(solid[0] * cr), Math.round(solid[1] * cg), Math.round(solid[2] * cb));
        g.fillRect(0, 0, w, h);
        continue;
      }

      if (cr === 255 && cg === 255 && cb === 255) {
        if (alpha !== currentAlpha) g.globalAlpha = currentAlpha = alpha;
        g.drawImage(tex.bitmap!, 0, 0);
        continue;
      }

      const channels = st.colourAnimating ? this.store.getChannels(tex) : null;
      if (channels) {
        // dest · (1 - α·a) + α·a·(c ∘ rgb): erase with the silhouette (normal blending only), then add each channel scaled by the colour.
        if (!st.additive) {
          g.globalAlpha = alpha;
          g.drawImage(channels[0], 0, 0);
          g.globalCompositeOperation = 'lighter';
        }
        if (cr > 0) {
          g.globalAlpha = (alpha * cr) / 255;
          g.drawImage(channels[1], 0, 0);
        }
        if (cg > 0) {
          g.globalAlpha = (alpha * cg) / 255;
          g.drawImage(channels[2], 0, 0);
        }
        if (cb > 0) {
          g.globalAlpha = (alpha * cb) / 255;
          g.drawImage(channels[3], 0, 0);
        }
        currentAlpha = -1;
        if (!st.additive) g.globalCompositeOperation = 'source-over';
        continue;
      }

      if (alpha !== currentAlpha) g.globalAlpha = currentAlpha = alpha;
      const tinted = this.store.getTinted(tex, cr, cg, cb);
      if (tinted) g.drawImage(tinted, 0, 0, w, h);
    }

    g.restore();
  }

  dispose(): void {
    for (const v of this.videos) v.dispose();
    this.samples?.dispose();
    this.store.dispose();
  }
}
