// HitObjectComposer contract shared by the ruleset composers.

import type { EditorBeatmap } from './EditorBeatmap';
import type { EditorClock } from './EditorClock';

export interface ViewOptions {
  autoSeekOnPlacement: boolean;
  showHitMarkers: boolean;
}

export interface ComposerHost {
  editor: EditorBeatmap;
  clock: EditorClock;
  view: ViewOptions;
  /** EditorSelectionHandler.AddHitSample / RemoveHitSample on the selection. */
  toggleSampleOnSelection(name: string): void;
  /** Sets a bank on the selection ('normal' bank or 'addition' bank). */
  setBankOnSelection(target: 'normal' | 'addition', bank: string | null): void;
}

export interface Composer {
  readonly el: HTMLElement;
  resize(): void;
  draw(now: number): void;
  refresh(): void;
  onKeyDown(e: KeyboardEvent): boolean;
  dispose(): void;
}
