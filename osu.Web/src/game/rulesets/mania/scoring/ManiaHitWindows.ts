// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game.Rulesets.Mania/Scoring/ManiaHitWindows.cs

import { difficultyRange, range } from '../../../beatmaps/Difficulty';
import { HitResult } from '../../../scoring/HitResult';
import { HitWindows } from '../../../scoring/HitWindows';
import { roundHalfEven } from '../utils';

export const PERFECT_WINDOW_RANGE = range(22.4, 19.4, 13.9);
const great_window_range = range(64, 49, 34);
const good_window_range = range(97, 82, 67);
const ok_window_range = range(127, 112, 97);
const meh_window_range = range(151, 136, 121);
const miss_window_range = range(188, 173, 158);

export class ManiaHitWindows extends HitWindows {
  private _speedMultiplier = 1;
  private _difficultyMultiplier = 1;
  private _classicModActive = false;
  private _scoreV2Active = false;
  private _isConvert = false;
  private overallDifficulty = 0;

  private perfect = 0;
  private great = 0;
  private good = 0;
  private ok = 0;
  private meh = 0;
  private miss = 0;

  /** Multiplier used to compensate for the playback speed of the track (rate-adjust mods). */
  get speedMultiplier(): number {
    return this._speedMultiplier;
  }

  set speedMultiplier(v: number) {
    this._speedMultiplier = v;
    this.updateWindows();
  }

  /** Multiplier used to make gameplay more (>1) or less (<1) difficult (HR / EZ). */
  get difficultyMultiplier(): number {
    return this._difficultyMultiplier;
  }

  set difficultyMultiplier(v: number) {
    this._difficultyMultiplier = v;
    this.updateWindows();
  }

  get classicModActive(): boolean {
    return this._classicModActive;
  }

  set classicModActive(v: boolean) {
    this._classicModActive = v;
    this.updateWindows();
  }

  get scoreV2Active(): boolean {
    return this._scoreV2Active;
  }

  set scoreV2Active(v: boolean) {
    this._scoreV2Active = v;
    this.updateWindows();
  }

  get isConvert(): boolean {
    return this._isConvert;
  }

  set isConvert(v: boolean) {
    this._isConvert = v;
    this.updateWindows();
  }

  private get totalMultiplier(): number {
    return this._speedMultiplier / this._difficultyMultiplier;
  }

  isHitResultAllowed(result: HitResult): boolean {
    switch (result) {
      case HitResult.Perfect:
      case HitResult.Great:
      case HitResult.Good:
      case HitResult.Ok:
      case HitResult.Meh:
      case HitResult.Miss:
        return true;
    }
    return false;
  }

  setDifficulty(difficulty: number): void {
    this.overallDifficulty = difficulty;
    this.updateWindows();
  }

  private updateWindows(): void {
    const m = this.totalMultiplier;
    const od = this.overallDifficulty;

    if (this._classicModActive && !this._scoreV2Active) {
      if (this._isConvert) {
        const roundedOd = roundHalfEven(od);
        this.perfect = Math.floor(16 * m) + 0.5;
        this.great = Math.floor((roundedOd > 4 ? 34 : 47) * m) + 0.5;
        this.good = Math.floor((roundedOd > 4 ? 67 : 77) * m) + 0.5;
        this.ok = Math.floor(97 * m) + 0.5;
        this.meh = Math.floor(121 * m) + 0.5;
        this.miss = Math.floor(158 * m) + 0.5;
      } else {
        const invertedOd = Math.min(Math.max(10 - od, 0), 10);
        this.perfect = Math.floor(16 * m) + 0.5;
        this.great = Math.floor((34 + 3 * invertedOd) * m) + 0.5;
        this.good = Math.floor((67 + 3 * invertedOd) * m) + 0.5;
        this.ok = Math.floor((97 + 3 * invertedOd) * m) + 0.5;
        this.meh = Math.floor((121 + 3 * invertedOd) * m) + 0.5;
        this.miss = Math.floor((158 + 3 * invertedOd) * m) + 0.5;
      }
    } else {
      this.perfect = Math.floor(difficultyRange(od, PERFECT_WINDOW_RANGE) * m) + 0.5;
      this.great = Math.floor(difficultyRange(od, great_window_range) * m) + 0.5;
      this.good = Math.floor(difficultyRange(od, good_window_range) * m) + 0.5;
      this.ok = Math.floor(difficultyRange(od, ok_window_range) * m) + 0.5;
      this.meh = Math.floor(difficultyRange(od, meh_window_range) * m) + 0.5;
      this.miss = Math.floor(difficultyRange(od, miss_window_range) * m) + 0.5;
    }
  }

  windowFor(result: HitResult): number {
    switch (result) {
      case HitResult.Perfect:
        return this.perfect;
      case HitResult.Great:
        return this.great;
      case HitResult.Good:
        return this.good;
      case HitResult.Ok:
        return this.ok;
      case HitResult.Meh:
        return this.meh;
      case HitResult.Miss:
        return this.miss;
      default:
        throw new Error(`No hit window for result ${result}`);
    }
  }
}
