// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.

import type { Game } from './Game';

export abstract class Screen {
  readonly el: HTMLElement;
  /** Background dim while this screen is shown (0..1). */
  backgroundDim = 0.5;
  /** Background blur in px (BackgroundScreenBeatmap.BlurAmount). */
  /** IOsuScreen.BackgroundParallaxAmount */
  get backgroundParallaxAmount(): number {
    return 1;
  }

  get backgroundBlur(): number {
    return 0;
  }
  /** Whether the triangles background should be visible. */
  showTriangles = true;

  constructor(
    protected readonly game: Game,
    className: string,
  ) {
    this.el = document.createElement('div');
    this.el.className = `screen ${className}`;
  }

  onEnter(): void {}
  onResume(): void {}
  onSuspend(): void {}
  onExit(): void {}

  /** Return true if handled. */
  onKeyDown(_e: KeyboardEvent): boolean {
    return false;
  }

  onKeyUp(_e: KeyboardEvent): boolean {
    return false;
  }

  /** Called when the user presses back (Escape). Return false to prevent leaving. */
  onBack(): boolean {
    return true;
  }
}
