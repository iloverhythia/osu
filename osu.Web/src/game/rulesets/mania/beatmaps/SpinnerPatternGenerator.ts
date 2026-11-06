// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game.Rulesets.Mania/Beatmaps/Patterns/Legacy/SpinnerPatternGenerator.cs

import type { LegacyRandom } from '../../../../framework/math';
import { HIT_FINISH, HIT_NORMAL } from '../../../audio/HitSampleInfo';
import type { Beatmap, ConvertHitObject } from '../../../beatmaps/Beatmap';
import { HoldNote, Note, type ManiaHitObject } from '../objects/ManiaHitObject';
import { LegacyPatternGenerator } from './LegacyPatternGenerator';
import { Pattern, PatternType } from './Pattern';

/** Converter for legacy "Spinner" hit objects. */
export class SpinnerPatternGenerator extends LegacyPatternGenerator {
  private readonly endTime: number;
  private readonly convertType: number;

  constructor(random: LegacyRandom, hitObject: ConvertHitObject, beatmap: Beatmap, totalColumns: number, previousPattern: Pattern) {
    super(random, hitObject, beatmap, previousPattern, totalColumns);

    this.endTime = Math.trunc(hitObject.hasDuration ? hitObject.endTime : 0);
    this.convertType = this.previousPattern.columnWithObjects === this.totalColumns ? PatternType.None : PatternType.ForceNotStack;
  }

  generate(): Pattern[] {
    const pattern = new Pattern();
    const h = this.hitObject;

    const generateHold = this.endTime - h.startTime >= 100;

    if (this.totalColumns === 8) {
      if (h.samples.some(s => s.name === HIT_FINISH) && this.endTime - h.startTime < 1000) this.addToPattern(pattern, 0, generateHold);
      else this.addToPattern(pattern, this.getRandomColumnFor(), generateHold);
    } else {
      this.addToPattern(pattern, this.getRandomColumnFor(0), generateHold);
    }

    return [pattern];
  }

  private getRandomColumnFor(lowerBound: number | null = null): number {
    if ((this.convertType & PatternType.ForceNotStack) > 0)
      return this.findAvailableColumn(this.getRandomColumn(lowerBound), { lowerBound, patterns: [this.previousPattern] });

    return this.findAvailableColumn(this.getRandomColumn(lowerBound), { lowerBound });
  }

  private addToPattern(pattern: Pattern, column: number, holdNote: boolean): void {
    const h = this.hitObject;
    let newObject: ManiaHitObject;

    if (holdNote) {
      const hold = new HoldNote();
      hold.startTime = h.startTime;
      hold.duration = this.endTime - h.startTime;
      hold.column = column;
      hold.samples = h.samples;
      hold.nodeSamples = [h.samples.filter(s => s.name === HIT_NORMAL), h.samples];
      newObject = hold;
    } else {
      const note = new Note();
      note.startTime = h.startTime;
      note.samples = h.samples;
      note.column = column;
      newObject = note;
    }

    pattern.add(newObject);
  }
}
