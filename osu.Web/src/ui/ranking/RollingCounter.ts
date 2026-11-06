// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game/Graphics/UserInterface/RollingCounter.cs (DisplayedCount transforms towards Current).

import { applyEasing, Easing } from '../../game/storyboard/Easing';

export class RollingCounter {
  readonly el: HTMLSpanElement;
  private displayed = 0;
  private from = 0;
  private to = 0;
  private start = 0;
  private lastText = '';

  constructor(
    private readonly duration: number,
    private readonly easing: Easing,
    private readonly format: (v: number) => string,
    private readonly integer = true,
    className = '',
  ) {
    this.el = document.createElement('span');
    this.el.className = className;
    this.render();
  }

  /** Current.Value = v (rolls from the displayed value). */
  set(v: number, now: number): void {
    this.from = this.displayed;
    this.to = v;
    this.start = now;
  }

  /** FinishTransforms. */
  finish(): void {
    this.from = this.to;
    this.displayed = this.to;
    this.start = -Infinity;
    this.render();
  }

  /** Returns the displayed value; `onChange` is invoked when it changes (TotalScoreCounter's tick sample). */
  update(now: number): number {
    if (this.displayed !== this.to) {
      const t = this.duration <= 0 ? 1 : Math.min(1, Math.max(0, (now - this.start) / this.duration));
      let v = this.from + (this.to - this.from) * applyEasing(this.easing, t);
      if (this.integer) v = Math.round(v);
      if (t >= 1) v = this.to;
      this.displayed = v;
      this.render();
    }
    return this.displayed;
  }

  private render(): void {
    const text = this.format(this.displayed);
    if (text !== this.lastText) {
      this.lastText = text;
      this.el.textContent = text;
    }
  }
}
