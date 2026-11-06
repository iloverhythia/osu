// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Replay model. Lazer stores per-ruleset ReplayFrames; this port records the input events that drive a DrawableRuleset
// (which is deterministic given its inputs), so a replay can be played back for any ruleset.

export type ReplayEvent =
  | { t: number; k: 'p' | 'r'; a: string }
  | { t: number; k: 'm'; x: number; y: number }
  | { t: number; k: 'ts' | 'tm' | 'te'; id: number; x: number; y: number };

export interface Replay {
  rulesetId: number;
  /**
   * Coordinate space of pointer events: "gamefield" = ruleset gamefield coordinates (e.g. osu! playfield pixels);
   * "screen" = fraction of the canvas size (0..1).
   */
  space: 'gamefield' | 'screen';
  events: ReplayEvent[];
  player: string;
  mods: string[];
  /** Customised mod settings (rates, Difficulty Adjust values). */
  modSettings?: import('../mods/Mods').ModSettings;
}

export class ReplayRecorder {
  readonly events: ReplayEvent[] = [];
  private lastMove = -Infinity;

  press(t: number, a: string): void {
    this.events.push({ t, k: 'p', a });
  }

  release(t: number, a: string): void {
    this.events.push({ t, k: 'r', a });
  }

  move(t: number, x: number, y: number): void {
    // Keep replays compact: at most one pointer sample per ~4ms.
    if (t - this.lastMove < 4 && this.events.length > 0 && this.events[this.events.length - 1].k === 'm') {
      const last = this.events[this.events.length - 1] as { t: number; k: 'm'; x: number; y: number };
      last.x = x;
      last.y = y;
      return;
    }
    this.lastMove = t;
    this.events.push({ t, k: 'm', x: round(x), y: round(y) });
  }

  touch(t: number, k: 'ts' | 'tm' | 'te', id: number, x: number, y: number): void {
    this.events.push({ t, k, id, x: round(x, 4), y: round(y, 4) });
  }
}

const round = (v: number, digits = 2) => Math.round(v * 10 ** digits) / 10 ** digits;
