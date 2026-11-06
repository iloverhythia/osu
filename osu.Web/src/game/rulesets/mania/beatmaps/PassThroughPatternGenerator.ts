// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game.Rulesets.Mania/Beatmaps/Patterns/Legacy/PassThroughPatternGenerator.cs

import type { LegacyRandom } from '../../../../framework/math';
import { LegacyHitObjectType, type Beatmap, type ConvertHitObject } from '../../../beatmaps/Beatmap';
import { HoldNote, Note } from '../objects/ManiaHitObject';
import { LegacyPatternGenerator } from './LegacyPatternGenerator';
import { Pattern } from './Pattern';

/**
 * A simple generator which, for any object, if the hitobject has an end time
 * it becomes a HoldNote or otherwise a Note.
 */
export class PassThroughPatternGenerator extends LegacyPatternGenerator {
  constructor(random: LegacyRandom, hitObject: ConvertHitObject, beatmap: Beatmap, totalColumns: number, previousPattern: Pattern) {
    super(random, hitObject, beatmap, previousPattern, totalColumns);
  }

  generate(): Pattern[] {
    const column = this.getColumn(this.xPosition);
    const pattern = new Pattern();
    const h = this.hitObject;

    if (h.hasDuration) {
      // despite the beatmap originally being made for mania, if the object is parsed as a slider rather than a hold, sliding samples should still be played.
      const playSlidingSamples = h.legacyType === LegacyHitObjectType.Slider || h.kind === 'slider';

      const hold = new HoldNote();
      hold.startTime = h.startTime;
      hold.duration = h.duration;
      hold.column = column;
      hold.samples = h.samples;
      hold.playSlidingSamples = playSlidingSamples;
      hold.nodeSamples = h.kind === 'slider' ? h.nodeSamples : HoldNote.createDefaultNodeSamples(h.samples);
      pattern.add(hold);
    } else {
      const note = new Note();
      note.startTime = h.startTime;
      note.samples = h.samples;
      note.column = column;
      pattern.add(note);
    }

    return [pattern];
  }
}
