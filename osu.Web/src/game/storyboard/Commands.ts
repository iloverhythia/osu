// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game/Storyboards/Commands/*: IStoryboardCommand, StoryboardCommand<T> (+ the X/Y/Scale/VectorScale/Rotation/Colour/Alpha/
// BlendingParameters/FlipH/FlipV command types), StoryboardCommandGroup, StoryboardLoopingGroup and StoryboardTriggerGroup.
//
// The per-type ApplyInitialValue / ApplyTransforms implementations (which generate osu-framework transforms) are ported as data in
// CommandTimeline.ts, which evaluates the resulting transforms directly at a given time.

export interface Vector2Value {
  readonly x: number;
  readonly y: number;
}

/** Storyboard colours are Color4 with alpha 1; components are 0..1 (C command values / 255). */
export interface ColourValue {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** The subset of osu-framework BlendingParameters storyboards can produce. */
export type BlendingValue = 'Additive' | 'Inherit';

/** The Drawable property affected by a command (IStoryboardCommand.PropertyName). */
export type CommandProperty = 'X' | 'Y' | 'Scale' | 'VectorScale' | 'Rotation' | 'Colour' | 'Alpha' | 'Blending' | 'FlipH' | 'FlipV';

export interface CommandValueTypes {
  X: number;
  Y: number;
  Scale: number;
  VectorScale: Vector2Value;
  Rotation: number;
  Colour: ColourValue;
  Alpha: number;
  Blending: BlendingValue;
  FlipH: boolean;
  FlipV: boolean;
}

/** Parameter commands (P) only apply their start value initially when they have zero duration, and switch values instantly. */
export const isParameterProperty = (p: CommandProperty): boolean => p === 'Blending' || p === 'FlipH' || p === 'FlipV';

export class StoryboardCommand<P extends CommandProperty = CommandProperty> {
  readonly startTime: number;
  readonly endTime: number;

  constructor(
    readonly property: P,
    readonly easing: number,
    startTime: number,
    endTime: number,
    readonly startValue: CommandValueTypes[P],
    readonly endValue: CommandValueTypes[P],
  ) {
    if (endTime < startTime) endTime = startTime;
    this.startTime = startTime;
    this.endTime = endTime;
  }

  get duration(): number {
    return this.endTime - this.startTime;
  }

  /** IStoryboardCommand.PropertyName */
  get propertyName(): P {
    return this.property;
  }

  compareTo(other: StoryboardCommand | null): number {
    if (other == null) return 1;
    const result = compareDouble(this.startTime, other.startTime);
    if (result !== 0) return result;
    return compareDouble(this.endTime, other.endTime);
  }

  toString(): string {
    return `${this.startTime} -> ${this.endTime}, ${String(this.startValue)} -> ${String(this.endValue)} ${this.easing}`;
  }
}

function compareDouble(a: number, b: number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** osu.Framework.Lists.SortedList.Add: binary search, then insert after any equal elements (insertion order is kept for ties). */
function addSorted(list: StoryboardCommand[], value: StoryboardCommand): void {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (list[mid].compareTo(value) <= 0) lo = mid + 1;
    else hi = mid;
  }
  list.splice(lo, 0, value);
}

export class StoryboardCommandGroup {
  readonly X: StoryboardCommand<'X'>[] = [];
  readonly Y: StoryboardCommand<'Y'>[] = [];
  readonly Scale: StoryboardCommand<'Scale'>[] = [];
  readonly VectorScale: StoryboardCommand<'VectorScale'>[] = [];
  readonly Rotation: StoryboardCommand<'Rotation'>[] = [];
  readonly Colour: StoryboardCommand<'Colour'>[] = [];
  readonly Alpha: StoryboardCommand<'Alpha'>[] = [];
  readonly Blending: StoryboardCommand<'Blending'>[] = [];
  readonly FlipH: StoryboardCommand<'FlipH'>[] = [];
  readonly FlipV: StoryboardCommand<'FlipV'>[] = [];

  /** Returns the earliest start time of the commands added to this group. */
  startTime = Number.MAX_VALUE;
  /** Returns the latest end time of the commands added to this group. */
  endTime = -Number.MAX_VALUE;
  hasCommands = false;

  get duration(): number {
    return this.endTime - this.startTime;
  }

  /** The lists in the same order as lazer's `lists` array (X, Y, Scale, VectorScale, Rotation, Colour, Alpha, BlendingParameters, FlipH, FlipV). */
  get lists(): readonly (readonly StoryboardCommand[])[] {
    return [this.X, this.Y, this.Scale, this.VectorScale, this.Rotation, this.Colour, this.Alpha, this.Blending, this.FlipH, this.FlipV];
  }

  get allCommands(): StoryboardCommand[] {
    const all: StoryboardCommand[] = [];
    for (const l of this.lists) for (const c of l) all.push(c);
    return all;
  }

  addX(easing: number, startTime: number, endTime: number, startValue: number, endValue: number): void {
    this.addCommand(this.X, new StoryboardCommand('X', easing, startTime, endTime, startValue, endValue));
  }

  addY(easing: number, startTime: number, endTime: number, startValue: number, endValue: number): void {
    this.addCommand(this.Y, new StoryboardCommand('Y', easing, startTime, endTime, startValue, endValue));
  }

  addScale(easing: number, startTime: number, endTime: number, startValue: number, endValue: number): void {
    this.addCommand(this.Scale, new StoryboardCommand('Scale', easing, startTime, endTime, startValue, endValue));
  }

  addVectorScale(easing: number, startTime: number, endTime: number, startValue: Vector2Value, endValue: Vector2Value): void {
    this.addCommand(this.VectorScale, new StoryboardCommand('VectorScale', easing, startTime, endTime, startValue, endValue));
  }

  addRotation(easing: number, startTime: number, endTime: number, startValue: number, endValue: number): void {
    this.addCommand(this.Rotation, new StoryboardCommand('Rotation', easing, startTime, endTime, startValue, endValue));
  }

  addColour(easing: number, startTime: number, endTime: number, startValue: ColourValue, endValue: ColourValue): void {
    this.addCommand(this.Colour, new StoryboardCommand('Colour', easing, startTime, endTime, startValue, endValue));
  }

  addAlpha(easing: number, startTime: number, endTime: number, startValue: number, endValue: number): void {
    this.addCommand(this.Alpha, new StoryboardCommand('Alpha', easing, startTime, endTime, startValue, endValue));
  }

  addBlendingParameters(easing: number, startTime: number, endTime: number, startValue: BlendingValue, endValue: BlendingValue): void {
    this.addCommand(this.Blending, new StoryboardCommand('Blending', easing, startTime, endTime, startValue, endValue));
  }

  addFlipH(easing: number, startTime: number, endTime: number, startValue: boolean, endValue: boolean): void {
    this.addCommand(this.FlipH, new StoryboardCommand('FlipH', easing, startTime, endTime, startValue, endValue));
  }

  addFlipV(easing: number, startTime: number, endTime: number, startValue: boolean, endValue: boolean): void {
    this.addCommand(this.FlipV, new StoryboardCommand('FlipV', easing, startTime, endTime, startValue, endValue));
  }

  /**
   * Adds the given storyboard command to the target list.
   * Can be overridden to apply custom effects to the given command before adding it to the list (e.g. looping or time offsets).
   */
  protected addCommand(list: StoryboardCommand[], command: StoryboardCommand): void {
    addSorted(list, command);
    this.hasCommands = true;

    if (command.startTime < this.startTime) this.startTime = command.startTime;
    if (command.endTime > this.endTime) this.endTime = command.endTime;
  }
}

/** A command inside a loop: its times are offset by the loop's start time (StoryboardLoopingGroup.StoryboardLoopingCommand). */
export class StoryboardLoopingCommand<P extends CommandProperty = CommandProperty> extends StoryboardCommand<P> {
  constructor(
    readonly originalCommand: StoryboardCommand<P>,
    readonly loopingGroup: StoryboardLoopingGroup,
  ) {
    // In an ideal world, we would multiply the command duration by TotalIterations in command end time.
    // Unfortunately this would clash with how stable handled end times, and results in some storyboards playing outro
    // sequences for minutes or hours.
    super(
      originalCommand.property,
      originalCommand.easing,
      loopingGroup.loopStartTime + originalCommand.startTime,
      loopingGroup.loopStartTime + originalCommand.endTime,
      originalCommand.startValue,
      originalCommand.endValue,
    );
  }
}

export class StoryboardLoopingGroup extends StoryboardCommandGroup {
  /** Time at which the loop starts (different from `startTime`, which is the time of the earliest command of this group). */
  readonly loopStartTime: number;
  /** The total number of times this loop is played back. Always greater than zero. */
  readonly totalIterations: number;

  /**
   * @param startTime The start time of the loop.
   * @param repeatCount The number of times the loop should repeat. Should be greater than zero. Zero means a single playback.
   */
  constructor(startTime: number, repeatCount: number) {
    super();
    if (repeatCount < 0) throw new RangeError('repeatCount must not be negative');
    this.loopStartTime = startTime;
    this.totalIterations = repeatCount + 1;
  }

  protected override addCommand(list: StoryboardCommand[], command: StoryboardCommand): void {
    super.addCommand(list, new StoryboardLoopingCommand(command, this));
  }

  toString(): string {
    return `${this.loopStartTime} x${this.totalIterations}`;
  }
}

export class StoryboardTriggerGroup extends StoryboardCommandGroup {
  constructor(
    public triggerName: string,
    public triggerStartTime: number,
    public triggerEndTime: number,
    public groupNumber: number,
  ) {
    super();
  }

  activeAt(time: number): boolean {
    return this.triggerStartTime <= time && time <= this.triggerEndTime;
  }

  toString(): string {
    return `${this.triggerName} ${this.triggerStartTime} -> ${this.triggerEndTime} (${this.groupNumber})`;
  }
}
