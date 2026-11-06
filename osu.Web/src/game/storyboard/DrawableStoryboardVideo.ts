// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game/Storyboards/Drawables/DrawableStoryboardVideo.cs (+ the inner DrawableVideo and the relevant behaviour of
// osu-framework's Video / AnimationClockComposite), playing the file through a muted HTMLVideoElement kept in sync with gameplay time.

import { adjustOrigin, Anchor, anchorX, anchorY } from './Anchor';
import { Prop, PropertyTimeline, SpriteState, SpriteTimeline } from './CommandTimeline';
import type { StoryboardVideo } from './Storyboard';

/** Re-seek the video element when it drifts further than this from gameplay time (seconds). */
const SEEK_THRESHOLD = 0.08;
/** Minimum wall-clock time between seeks (ms), so a slow seek can't cause a seek storm. */
const SEEK_COOLDOWN = 300;

export interface ScreenMapping {
  /** Screen pixels per storyboard unit. */
  readonly scale: number;
  /** Screen position of storyboard space (0, 0) (the top-left of the 640x480 element area). */
  readonly originX: number;
  readonly originY: number;
  /** Width of the storyboard area in storyboard units (640, or 853.33 for widescreen storyboards). */
  readonly storyboardWidth: number;
  readonly canvasWidth: number;
  readonly canvasHeight: number;
}

export class DrawableStoryboardVideo {
  readonly timeline: SpriteTimeline;
  private readonly state = new SpriteState();
  private readonly element: HTMLVideoElement;
  private readonly url: string;
  /** Video duration in ms, once the metadata has loaded. */
  private duration = NaN;
  private failed = false;
  private fadesApplied = false;
  private lastSeek = -Infinity;
  private playRequested = false;
  /**
   * In osu-stable, a mapper can add a scale command for a storyboard video. This allows scaling based on the video's absolute size.
   * If not specified we take up the full available space (FillMode.Fill).
   */
  private readonly useRelative: boolean;

  readonly ready: Promise<void>;

  constructor(
    readonly video: StoryboardVideo,
    blob: Blob,
  ) {
    this.useRelative = video.commands.Scale.length === 0;
    this.timeline = new SpriteTimeline(video);

    // DrawableVideo is created with Alpha = 0 before the commands are applied.
    let alpha = this.timeline.props[Prop.Alpha];
    if (!alpha) alpha = this.timeline.props[Prop.Alpha] = new PropertyTimeline(Prop.Alpha);
    if (!alpha.hasInitial) {
      alpha.hasInitial = true;
      alpha.initial[0] = 0;
    }

    const el = (this.element = document.createElement('video'));
    el.muted = true;
    el.defaultMuted = true;
    el.playsInline = true;
    el.preload = 'auto';
    el.loop = false;
    this.url = URL.createObjectURL(blob);

    this.ready = new Promise<void>(resolve => {
      const done = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(done, 8000);
      el.addEventListener(
        'loadedmetadata',
        () => {
          this.duration = el.duration * 1000;
          this.applyFades();
          done();
        },
        { once: true },
      );
      el.addEventListener(
        'error',
        () => {
          this.failed = true;
          done();
        },
        { once: true },
      );
    });
    el.src = this.url;
  }

  /** DrawableStoryboardVideo.LoadComplete: fade in at the start time, fade out over the last 500ms of the video. */
  private applyFades(): void {
    if (this.fadesApplied || !Number.isFinite(this.duration)) return;
    this.fadesApplied = true;
    const tl = this.timeline;
    const alpha = tl.props[Prop.Alpha]!;
    const start = this.video.startTime;
    const scratch = new Float64Array(3);
    const valueAt = (t: number): number => (alpha.evaluate(t, scratch) ? scratch[0] : alpha.initial[0]);

    // Transforms added here get greater TransformIDs than the commands, and remove any alpha commands starting after them.
    const fadeIn = { start, end: start + 500, easing: 0, a0: valueAt(start), a1: 0, a2: 0, b0: 1, b1: 0, b2: 0, id: 1e9 };
    alpha.addDynamic(fadeIn, -Infinity);
    const fadeOutStart = start + this.duration - 500;
    const fadeOut = { start: fadeOutStart, end: fadeOutStart + 500, easing: 0, a0: valueAt(fadeOutStart), a1: 0, a2: 0, b0: 0, b1: 0, b2: 0, id: 1e9 + 2 };
    alpha.addDynamic(fadeOut, -Infinity);
  }

  /** Keeps the element's playback in sync with the gameplay clock (Video.PlaybackPosition = Time.Current - Video.StartTime). */
  update(time: number, running: boolean, rate: number): void {
    if (this.failed || !this.fadesApplied) return;
    const el = this.element;
    const position = (time - this.video.startTime) / 1000;
    const durationSec = this.duration / 1000;

    if (position < 0 || position >= durationSec) {
      if (!el.paused) el.pause();
      this.playRequested = false;
      // keep the first frame ready for when playback starts
      if (position < 0 && el.currentTime !== 0 && !el.seeking && performance.now() - this.lastSeek > SEEK_COOLDOWN) {
        el.currentTime = 0;
        this.lastSeek = performance.now();
      }
      return;
    }

    const drift = el.currentTime - position;

    if (running) {
      if (el.paused && !this.playRequested) {
        this.playRequested = true;
        el.play().then(
          () => (this.playRequested = false),
          () => (this.playRequested = false),
        );
      }
      // Small drifts are corrected by nudging the playback rate; larger ones by seeking.
      const nudge = Math.max(-0.1, Math.min(0.1, -drift * 1.5));
      const targetRate = Math.max(0.0625, Math.min(16, rate * (1 + nudge)));
      if (Math.abs(el.playbackRate - targetRate) > 0.002) el.playbackRate = targetRate;
    } else if (!el.paused) {
      el.pause();
      this.playRequested = false;
    }

    if (Math.abs(drift) > (running ? SEEK_THRESHOLD : 0.03) && !el.seeking && performance.now() - this.lastSeek > SEEK_COOLDOWN) {
      // when playing, aim slightly ahead to account for the seek itself taking time
      el.currentTime = Math.min(durationSec, position + (running ? 0.05 * rate : 0));
      this.lastSeek = performance.now();
    }
  }

  /** Draws the current video frame (behind everything, in the unmasked video layer). */
  draw(g: CanvasRenderingContext2D, time: number, map: ScreenMapping, base: DOMMatrix): void {
    if (this.failed || !this.fadesApplied) return;
    const el = this.element;
    if (el.readyState < 2 || el.videoWidth === 0 || el.videoHeight === 0) return;

    const st = this.state;
    this.timeline.evaluate(time, st);
    let alpha = st.alpha;
    if (!(alpha > 0.0001)) return;
    if (alpha > 1) alpha = 1;

    const vw = el.videoWidth;
    const vh = el.videoHeight;
    // DrawableVideo size in storyboard units.
    let w: number;
    let h: number;
    if (this.useRelative) {
      // RelativeSizeAxes.Both of the storyboard area with FillMode.Fill (cover, preserving aspect ratio).
      const areaW = map.storyboardWidth;
      const areaH = 480;
      const s = Math.max(areaW / vw, areaH / vh);
      w = vw * s;
      h = vh * s;
    } else {
      w = vw;
      h = vh;
    }

    const sx = (st.flipH ? -1 : 1) * st.scaleX * st.vectorScaleX;
    const sy = (st.flipV ? -1 : 1) * st.scaleY * st.vectorScaleY;
    if (sx === 0 || sy === 0 || Number.isNaN(st.x) || Number.isNaN(st.y)) return;

    const origin = adjustOrigin(Anchor.Centre, st.vectorScaleX, st.vectorScaleY, st.flipH, st.flipV);
    const ox = anchorX(origin) * w;
    const oy = anchorY(origin) * h;
    // Anchor.Centre of the storyboard area (which is centred on storyboard position (320, 240)).
    const px = 320 + st.x;
    const py = 240 + st.y;

    const k = map.scale;
    const rad = (st.rotation * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const a = k * cos * sx;
    const b = k * sin * sx;
    const c = -k * sin * sy;
    const d = k * cos * sy;
    const e = map.originX + k * (px - cos * sx * ox + sin * sy * oy);
    const f = map.originY + k * (py - sin * sx * ox - cos * sy * oy);

    g.setTransform(base.a * a + base.c * b, base.b * a + base.d * b, base.a * c + base.c * d, base.b * c + base.d * d, base.a * e + base.c * f + base.e, base.b * e + base.d * f + base.f);
    g.globalAlpha = alpha;
    g.globalCompositeOperation = st.additive ? 'lighter' : 'source-over';
    g.drawImage(el, 0, 0, w, h);
  }

  dispose(): void {
    const el = this.element;
    try {
      el.pause();
      el.removeAttribute('src');
      el.load();
    } catch {
      /* ignore */
    }
    URL.revokeObjectURL(this.url);
  }
}
