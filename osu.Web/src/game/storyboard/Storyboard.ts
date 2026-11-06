// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game/Storyboards: Storyboard.cs, StoryboardLayer.cs, StoryboardVideoLayer.cs, IStoryboardElement.cs,
// IStoryboardElementWithDuration.cs, StoryboardSprite.cs, StoryboardAnimation.cs, StoryboardVideo.cs, StoryboardSample.cs.

import { Anchor } from './Anchor';
import { StoryboardCommand, StoryboardCommandGroup, StoryboardLoopingGroup, StoryboardTriggerGroup, type Vector2Value } from './Commands';

export enum StoryboardElementSource {
  /** This element was declared in the individual beatmap's .osu file. */
  Beatmap,
  /** This element was declared in a beatmapset-shared .osb file. */
  Shared,
}

export interface IStoryboardElement {
  /** Whether this element was declared in the individual beatmap's .osu file, or in a beatmapset-shared .osb file. */
  readonly source: StoryboardElementSource;
  readonly path: string;
  readonly isDrawable: boolean;
  readonly startTime: number;
}

/** A storyboard element that ends at a different time than its start time (IStoryboardElementWithDuration). */
export interface IStoryboardElementWithDuration extends IStoryboardElement {
  /** The time at which the element ends. Consumed to extend the length of a storyboard to ensure all visuals are played to completion. */
  readonly endTime: number;
  /** The time this element displays until. Used for lifetime purposes; includes long playing animations which don't extend play time. */
  readonly endTimeForDisplay: number;
}

/** StoryboardElementExtensions.GetEndTime: EndTime where available, falling back to StartTime otherwise. */
export function getEndTime(element: IStoryboardElement): number {
  return 'endTime' in element ? (element as IStoryboardElementWithDuration).endTime : element.startTime;
}

export class StoryboardSprite implements IStoryboardElementWithDuration {
  readonly loopingGroups: StoryboardLoopingGroup[] = [];
  readonly triggerGroups: StoryboardTriggerGroup[] = [];
  readonly commands = new StoryboardCommandGroup();

  constructor(
    readonly source: StoryboardElementSource,
    readonly path: string,
    public origin: Anchor,
    public initialPosition: Vector2Value,
  ) {}

  get isDrawable(): boolean {
    return this.hasCommands;
  }

  get startTime(): number {
    // Users that are crafting storyboards using raw osb scripting or external tools may create alpha events far before the actual display time
    // of sprites.
    //
    // To make sure lifetime optimisations work as efficiently as they can, let's locally find the first time a sprite becomes visible.
    const alphaCommands: StoryboardCommand<'Alpha'>[] = [];
    const visibleAtStartOrEnd = (command: StoryboardCommand<'Alpha'>): boolean => command.startValue > 0 || command.endValue > 0;

    for (const command of this.commands.Alpha) {
      alphaCommands.push(command);
      if (visibleAtStartOrEnd(command)) break;
    }

    for (const loop of this.loopingGroups) {
      for (const command of loop.Alpha) {
        alphaCommands.push(command);
        if (visibleAtStartOrEnd(command)) break;
      }
    }

    if (alphaCommands.length > 0) {
      // Special care is given to cases where there's one or more no-op transforms (ie transforming from alpha 0 to alpha 0).
      // - If a 0->0 transform exists, we still need to check it to ensure the absolute first start value is non-visible.
      // - After ascertaining this, we then check the first non-noop transform to get the true start lifetime.
      const firstAlpha = minBy(alphaCommands, c => c.startTime)!;
      const firstRealAlpha = minBy(alphaCommands.filter(visibleAtStartOrEnd), c => c.startTime);

      if (firstAlpha.startValue === 0 && firstRealAlpha != null) return firstRealAlpha.startTime;
    }

    return this.earliestTransformTime;
  }

  get earliestTransformTime(): number {
    // If we got to this point, either no alpha commands were present, or the earliest had a non-zero start value.
    // The sprite's StartTime will be determined by the earliest command, regardless of type.
    let earliestStartTime = this.commands.startTime;
    for (const l of this.loopingGroups) earliestStartTime = Math.min(earliestStartTime, l.startTime);
    return earliestStartTime;
  }

  get endTime(): number {
    let latestEndTime = this.commands.endTime;
    for (const l of this.loopingGroups) latestEndTime = Math.max(latestEndTime, l.endTime);
    return latestEndTime;
  }

  get endTimeForDisplay(): number {
    let latestEndTime = this.commands.endTime;
    for (const l of this.loopingGroups) latestEndTime = Math.max(latestEndTime, l.startTime + l.duration * l.totalIterations);
    return latestEndTime;
  }

  get duration(): number {
    return this.endTime - this.startTime;
  }

  get hasCommands(): boolean {
    return this.commands.hasCommands || this.loopingGroups.some(l => l.hasCommands);
  }

  addLoopingGroup(loopStartTime: number, repeatCount: number): StoryboardLoopingGroup {
    const loop = new StoryboardLoopingGroup(loopStartTime, repeatCount);
    this.loopingGroups.push(loop);
    return loop;
  }

  addTriggerGroup(triggerName: string, startTime: number, endTime: number, groupNumber: number): StoryboardTriggerGroup {
    const trigger = new StoryboardTriggerGroup(triggerName, startTime, endTime, groupNumber);
    this.triggerGroups.push(trigger);
    return trigger;
  }
}

export enum AnimationLoopType {
  LoopForever,
  LoopOnce,
}

export class StoryboardAnimation extends StoryboardSprite {
  constructor(
    source: StoryboardElementSource,
    path: string,
    origin: Anchor,
    initialPosition: Vector2Value,
    public frameCount: number,
    public frameDelay: number,
    public loopType: AnimationLoopType,
  ) {
    super(source, path, origin, initialPosition);
  }

  /** DrawableStoryboardAnimation.getFramePath: every "." in the path is replaced (string.Replace semantics). */
  getFramePath(i: number): string {
    return this.path.split('.').join(`${i}.`);
  }
}

export class StoryboardVideo extends StoryboardSprite {
  private readonly videoStartTime: number;

  constructor(source: StoryboardElementSource, path: string, offset: number) {
    super(source, path, Anchor.Centre, { x: 0, y: 0 });
    // This is just required to get a valid StartTime based on the incoming offset.
    // Actual fades are handled inside DrawableStoryboardVideo for now.
    this.videoStartTime = offset;
  }

  override get startTime(): number {
    return this.videoStartTime;
  }

  override get isDrawable(): boolean {
    return true;
  }
}

export class StoryboardSampleInfo implements IStoryboardElement {
  readonly isDrawable = true;
  readonly isHitsound = false;

  constructor(
    readonly source: StoryboardElementSource,
    readonly path: string,
    readonly startTime: number,
    readonly volume: number,
  ) {}

  /** Try first with the full name, then attempt with no extension (Path.ChangeExtension(Path, null)). */
  get lookupNames(): string[] {
    return [this.path, changeExtensionToNull(this.path)];
  }
}

export class StoryboardLayer {
  visibleWhenPassing = true;
  visibleWhenFailing = true;
  readonly elements: IStoryboardElement[] = [];

  constructor(
    readonly name: string,
    readonly depth: number,
    readonly masking = true,
  ) {}

  add(element: IStoryboardElement): void {
    this.elements.push(element);
  }
}

/** StoryboardVideoLayer: unmasked, and its elements fill the full storyboard area. */
export class StoryboardVideoLayer extends StoryboardLayer {}

const INT_MIN = -2147483648;

export const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png'];
export const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.avi', '.flv', '.mpg', '.wmv', '.m4v'];

export class Storyboard {
  private readonly layers = new Map<string, StoryboardLayer>();

  /** Beatmap-level fields the storyboard needs (lazer: Storyboard.Beatmap / BeatmapInfo). */
  widescreenStoryboard = false;
  /** BeatmapInfo.Metadata.BackgroundFile */
  backgroundFile = '';

  /** Whether the storyboard should prefer textures from the current skin before using local storyboard textures. */
  useSkinSprites = false;

  /** Offset to be applied to the beatmap background (unused in lazer, see https://github.com/ppy/osu/issues/14238). */
  backgroundOffset: Vector2Value = { x: 0, y: 0 };

  /** Depth of the currently front-most storyboard layer, excluding the overlay layer. */
  private minimumLayerDepth: number;

  constructor() {
    this.layers.set('Video', new StoryboardVideoLayer('Video', 4, false));
    this.layers.set('Background', new StoryboardLayer('Background', 3));
    const fail = new StoryboardLayer('Fail', 2);
    fail.visibleWhenPassing = false;
    this.layers.set('Fail', fail);
    const pass = new StoryboardLayer('Pass', 1);
    pass.visibleWhenFailing = false;
    this.layers.set('Pass', pass);
    this.layers.set('Foreground', new StoryboardLayer('Foreground', (this.minimumLayerDepth = 0)));

    this.layers.set('Overlay', new StoryboardLayer('Overlay', INT_MIN));
  }

  get layerList(): StoryboardLayer[] {
    return [...this.layers.values()];
  }

  getLayer(name: string): StoryboardLayer {
    let layer = this.layers.get(name);
    if (!layer) this.layers.set(name, (layer = new StoryboardLayer(name, --this.minimumLayerDepth)));
    return layer;
  }

  get hasDrawable(): boolean {
    for (const l of this.layers.values()) if (l.elements.some(e => e.isDrawable)) return true;
    return false;
  }

  /**
   * Across all layers, find the earliest point in time that a storyboard element exists at, or null if there are no elements.
   * Sample events use their start time as "end time" during this calculation. Video and background events are not included to match stable.
   */
  get earliestEventTime(): number | null {
    let min: number | null = null;
    for (const l of this.layers.values()) {
      for (const e of l.elements) {
        if (e instanceof StoryboardVideo) continue;
        const t = e.startTime;
        if (min === null || t < min) min = t;
      }
    }
    return min;
  }

  /**
   * Across all layers, find the latest point in time that a storyboard element ends at, or null if there are no elements.
   * Video and background events are not included to match stable.
   */
  get latestEventTime(): number | null {
    let max: number | null = null;
    for (const l of this.layers.values()) {
      for (const e of l.elements) {
        if (e instanceof StoryboardVideo) continue;
        const t = getEndTime(e);
        if (max === null || t > max) max = t;
      }
    }
    return max;
  }

  get primaryVideo(): StoryboardVideo | null {
    return (this.getLayer('Video').elements.find(e => e instanceof StoryboardVideo) as StoryboardVideo | undefined) ?? null;
  }

  /** Whether the beatmap's background should be hidden while this storyboard is being displayed. */
  get replacesBackground(): boolean {
    let backgroundPath = this.backgroundFile;
    if (!backgroundPath) return false;
    backgroundPath = backgroundPath.toLowerCase();
    return this.getLayer('Background').elements.some(e => e.path.toLowerCase() === backgroundPath);
  }

  /**
   * Storyboard.GetStoragePathFromStoryboardPath: resolves a storyboard path to a file in the beatmap set.
   * Some old storyboards don't include a file extension, so a best guess is made using the supported image extensions.
   */
  getStoragePathFromStoryboardPath(path: string, getPathForFile: (filename: string) => string | null): string | null {
    let resolvedPath: string | null = null;

    if (hasExtension(path)) {
      resolvedPath = getPathForFile(path);
    } else {
      for (const ext of IMAGE_EXTENSIONS) {
        if ((resolvedPath = getPathForFile(`${path}${ext}`)) != null) break;
      }
    }

    return resolvedPath;
  }
}

function minBy<T>(items: readonly T[], key: (item: T) => number): T | null {
  let best: T | null = null;
  let bestKey = 0;
  for (const item of items) {
    const k = key(item);
    if (best === null || k < bestKey) {
      best = item;
      bestKey = k;
    }
  }
  return best;
}

/** System.IO.Path.HasExtension: whether the file name (after the last directory separator) has a "." followed by at least one character. */
export function hasExtension(path: string): boolean {
  const lastSep = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const dot = path.lastIndexOf('.');
  return dot > lastSep && dot < path.length - 1;
}

/** System.IO.Path.GetExtension (including the dot, or '' when there is none). */
export function getExtension(path: string): string {
  const lastSep = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const dot = path.lastIndexOf('.');
  return dot > lastSep && dot < path.length - 1 ? path.slice(dot) : '';
}

/** System.IO.Path.ChangeExtension(path, null): removes the extension (including a trailing "."). */
export function changeExtensionToNull(path: string): string {
  const lastSep = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const dot = path.lastIndexOf('.');
  return dot > lastSep ? path.slice(0, dot) : path;
}
