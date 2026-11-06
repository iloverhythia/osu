// Port of osu.Game/Overlays/MusicController.cs + Music/MusicKeyBindingHandler.cs: next / previous / play-pause of the
// global track across the beatmap library (with shuffle and history), automatic advance when a non-looping track
// ends, and the "Music Playback" on-screen toasts for the global music keys (F1 previous, F3 play/pause, F5 next).

import { settings } from '../framework/Settings';
import { DeletePending } from '../game/Collections';
import type { BeatmapEntry, BeatmapSetRecord } from '../game/storage/Database';
import type { Game } from './Game';
import { displayToast } from './overlays/OnScreenDisplay';

/** MusicController.restart_cutoff_point */
const RESTART_CUTOFF = 5000;

export type PreviousTrackResult = 'none' | 'restart' | 'previous';

export class MusicController {
  /** IsUserPaused: the user paused the track, so menus don't start something else. */
  userPaused = false;
  private readonly history: string[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(private readonly game: Game) {
    game.subscribe(() => this.noteCurrent());
    // MusicController.Update: a finished non-looping track moves on to the next one.
    setInterval(() => {
      const t = game.previewTrack;
      if (t && !t.loop && t.hasEnded && this.allowTrackControl && !this.userPaused) this.next();
    }, 250);
  }

  get shuffle(): boolean {
    return settings.get<boolean>('music.shuffle', true);
  }

  set shuffle(v: boolean) {
    settings.set('music.shuffle', v);
    this.emit();
  }

  /** IOsuScreen.AllowTrackControl (gameplay doesn't allow it). */
  get allowTrackControl(): boolean {
    return this.game.currentScreen?.allowTrackControl ?? true;
  }

  get isPlaying(): boolean {
    return !!this.game.previewTrack?.isRunning;
  }

  subscribe(l: () => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  emit(): void {
    for (const l of this.listeners) l();
  }

  private playable(): BeatmapSetRecord[] {
    const pending = new Set(DeletePending.all());
    return this.game.library.sets.filter(s => s.beatmaps.length > 0 && !pending.has(s.id));
  }

  private noteCurrent(): void {
    const id = this.game.working?.set.id;
    if (id && this.history[this.history.length - 1] !== id) {
      this.history.push(id);
      if (this.history.length > 200) this.history.shift();
    }
  }

  private entryFor(set: BeatmapSetRecord): BeatmapEntry {
    // Prefer a difficulty of the current ruleset so song select can show it.
    return set.beatmaps.find(b => b.rulesetId === this.game.ruleset.id) ?? set.beatmaps[0];
  }

  private play(set: BeatmapSetRecord): void {
    this.userPaused = false;
    this.game.select(set, this.entryFor(set), false);
    void this.game.startPreview(true).then(() => this.emit());
  }

  /** MusicController.TogglePause; returns whether the track was playing. */
  togglePause(): boolean {
    const t = this.game.previewTrack;
    if (!t) {
      void this.game.startPreview().then(() => this.emit());
      this.userPaused = false;
      return false;
    }
    if (t.isRunning) {
      t.stop();
      this.userPaused = true;
      this.emit();
      return true;
    }
    this.userPaused = false;
    void t.start().then(() => this.emit());
    return false;
  }

  /** MusicController.NextTrack */
  next(): boolean {
    const sets = this.playable();
    if (sets.length === 0) return false;
    const cur = this.game.working?.set.id;
    let next: BeatmapSetRecord;
    if (this.shuffle && sets.length > 1) {
      // Avoid the recently played sets where possible.
      const recent = new Set(this.history.slice(-Math.min(sets.length - 1, 20)));
      const pool = sets.filter(s => !recent.has(s.id) && s.id !== cur);
      const from = pool.length ? pool : sets.filter(s => s.id !== cur);
      next = from[Math.floor(Math.random() * from.length)];
    } else {
      const i = sets.findIndex(s => s.id === cur);
      next = sets[(i + 1) % sets.length];
    }
    this.play(next);
    return true;
  }

  /** MusicController.PreviousTrack */
  previous(): PreviousTrackResult {
    const t = this.game.previewTrack;
    if (t && t.currentTime >= RESTART_CUTOFF) {
      t.currentTime = 0;
      this.userPaused = false;
      if (!t.isRunning) void t.start();
      this.emit();
      return 'restart';
    }
    const sets = this.playable();
    if (sets.length === 0) return 'none';
    const cur = this.game.working?.set.id;
    let prev: BeatmapSetRecord | undefined;
    if (this.shuffle) {
      // Walk back through the history.
      while (this.history.length > 1 && !prev) {
        if (this.history[this.history.length - 1] === cur) this.history.pop();
        const id = this.history.pop();
        prev = sets.find(s => s.id === id && s.id !== cur);
      }
    }
    if (!prev) {
      const i = sets.findIndex(s => s.id === cur);
      prev = sets[(i - 1 + sets.length) % sets.length];
    }
    this.play(prev);
    return 'previous';
  }

  /** Seeks the current track (NowPlayingOverlay progress bar). */
  seek(ms: number): void {
    const t = this.game.previewTrack;
    if (t) t.currentTime = Math.max(0, Math.min(t.length, ms));
  }

  /** Plays a specific set (playlist click). */
  playSet(set: BeatmapSetRecord): void {
    this.play(set);
  }

  /** MusicKeyBindingHandler.OnPressed; returns true when the key was a music key. */
  handleKey(e: KeyboardEvent): boolean {
    if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return false;
    const key = e.code === 'F1' || e.code === 'MediaTrackPrevious' ? 'prev' : e.code === 'F3' || e.code === 'MediaPlayPause' ? 'play' : e.code === 'F5' || e.code === 'MediaTrackNext' ? 'next' : null;
    if (!key || e.repeat || !this.allowTrackControl) return false;
    const toast = (value: string, shortcut: string) => displayToast({ description: 'Music Playback', value, extra: shortcut });
    if (key === 'play') {
      const wasPlaying = this.togglePause();
      toast(wasPlaying ? 'Pause track' : 'Play track', 'F3');
    } else if (key === 'next') {
      if (this.next()) toast('Next track', 'F5');
    } else {
      const r = this.previous();
      if (r === 'restart') toast('Restart track', 'F1');
      else if (r === 'previous') toast('Previous track', 'F1');
    }
    return true;
  }
}
