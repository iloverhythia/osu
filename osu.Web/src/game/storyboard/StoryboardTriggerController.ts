// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game/Storyboards/Drawables/StoryboardTriggerController.cs.
// Instead of bindables, the storyboard player forwards GameplayState's changes (passing state, last judgement result, last played samples)
// to `onPassingChanged` / `onJudgement` / `onSamplesPlayed`.

import { BANK_DRUM, BANK_NORMAL, BANK_SOFT, HIT_CLAP, HIT_FINISH, HIT_NORMAL, HIT_WHISTLE, type HitSampleInfo } from '../audio/HitSampleInfo';
import type { StoryboardTriggerGroup } from './Commands';
import type { SpriteTimeline } from './CommandTimeline';

const PREFIX = 'HitSound';

const parse_regex = /^HitSound(All|Normal|Soft|Drum)?(All|Normal|Soft|Drum)?(Whistle|Clap|Finish)?(\d+)?$/i;

/** StoryboardTriggerController.HitSampleTriggerDefinition */
export class HitSampleTriggerDefinition {
  private constructor(
    readonly rawName: string,
    readonly normalBank: string | null,
    readonly additionBank: string | null,
    readonly additionName: string | null,
    readonly suffix: string | null,
  ) {}

  toString(): string {
    return this.rawName;
  }

  static tryParse(triggerName: string): HitSampleTriggerDefinition | null {
    const match = parse_regex.exec(triggerName);
    if (!match) return null;

    let name: string | null = match[3] ?? null;
    let bank1: string | null = match[1] ?? null;
    let bank2: string | null = match[2] ?? null;
    const suffix: string | null = match[4] ?? null;

    // https://github.com/peppy/osu-stable-reference/blob/baa8705f782c0de2b10a7387d78014c61c8b17fb/osu!/GameplayElements/Events/Trigger/EventTriggerHitSound.cs#L70-L80
    const bank1IsAddition = bank1 != null && bank2 == null && name != null;

    // remap names from the regex onto `HitSampleInfo` constants.
    switch (name?.toLowerCase()) {
      case 'whistle':
        name = HIT_WHISTLE;
        break;
      case 'clap':
        name = HIT_CLAP;
        break;
      case 'finish':
        name = HIT_FINISH;
        break;
      default:
        name = null;
    }
    bank1 = mapBankName(bank1);
    bank2 = mapBankName(bank2);

    return new HitSampleTriggerDefinition(triggerName, bank1IsAddition ? bank2 : bank1, bank1IsAddition ? bank1 : bank2, name, suffix);
  }

  matches(hitSamples: Iterable<HitSampleInfo>): boolean {
    // lazer treats "addition bank" and "addition samples" slightly differently than stable does: lazer will just not emit an addition
    // `HitSampleInfo` at all, so there is nowhere for the addition bank definition to go (see the comment in the C# source).

    // if the addition name is specified, it must be found among the samples.
    let foundAddition = this.additionName == null;
    // if the addition bank is specified, at least one addition sound must use this bank.
    let additionBankCorrect = this.additionBank == null;

    for (const hitSampleInfo of hitSamples) {
      if (hitSampleInfo.name === HIT_NORMAL) {
        if (this.normalBank != null && hitSampleInfo.bank !== this.normalBank) return false;
      } else {
        if (this.additionName != null && hitSampleInfo.name === this.additionName) foundAddition = true;
        if (this.additionBank != null && hitSampleInfo.bank === this.additionBank) additionBankCorrect = true;
      }

      if (this.suffix != null && (hitSampleInfo.suffix == null || this.suffix.toLowerCase() !== hitSampleInfo.suffix.toLowerCase())) return false;
    }

    return foundAddition && additionBankCorrect;
  }
}

function mapBankName(triggerBank: string | null): string | null {
  switch (triggerBank?.toLowerCase()) {
    case 'normal':
      return BANK_NORMAL;
    case 'soft':
      return BANK_SOFT;
    case 'drum':
      return BANK_DRUM;
    default:
      return null; // "all" falls into this case which is intended as it means no filter anyway.
  }
}

interface Binding {
  readonly timeline: SpriteTimeline;
  readonly group: StoryboardTriggerGroup;
}

interface HitSampleBinding extends Binding {
  readonly definition: HitSampleTriggerDefinition;
}

export class StoryboardTriggerController {
  private readonly passing: Binding[] = [];
  private readonly failing: Binding[] = [];
  private readonly hitObjectHit: Binding[] = [];
  private readonly hitSample: HitSampleBinding[] = [];

  get hasBindings(): boolean {
    return this.passing.length + this.failing.length + this.hitObjectHit.length + this.hitSample.length > 0;
  }

  bind(timeline: SpriteTimeline, triggerGroup: StoryboardTriggerGroup): void {
    const name = triggerGroup.triggerName;
    switch (name) {
      case 'Passing':
        this.passing.push({ timeline, group: triggerGroup });
        return;

      case 'Failing':
        this.failing.push({ timeline, group: triggerGroup });
        return;

      case 'HitObjectHit':
        this.hitObjectHit.push({ timeline, group: triggerGroup });
        return;
    }

    if (name.toLowerCase().startsWith(PREFIX.toLowerCase())) {
      const definition = HitSampleTriggerDefinition.tryParse(name);
      if (definition) this.hitSample.push({ timeline, group: triggerGroup, definition });
    }
  }

  /** The `passing` bindable changed (bindPassing). */
  onPassingChanged(passing: boolean, now: number): void {
    for (const b of passing ? this.passing : this.failing) b.timeline.playTrigger(b.group, now);
  }

  /** GameplayState.LastJudgementResult changed and the result was a scorable hit (bindHitObjectHit). */
  onHitObjectHit(now: number): void {
    for (const b of this.hitObjectHit) b.timeline.playTrigger(b.group, now);
  }

  /** GameplayState.LastPlayedSamples changed (bindHitSample). */
  onSamplesPlayed(samples: readonly HitSampleInfo[], now: number): void {
    for (const b of this.hitSample) {
      if (!b.group.activeAt(now)) continue;
      if (b.definition.matches(samples)) b.timeline.playTrigger(b.group, now);
    }
  }
}
