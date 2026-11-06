// Ruleset.CreateHitObjectComposer

import type { Composer, ComposerHost } from './Composer';
import { OsuComposer } from './OsuComposer';
import { ScrollingComposer } from './ScrollingComposer';

export function createComposer(host: ComposerHost): Composer {
  switch (host.editor.beatmap.rulesetId) {
    case 1:
      return new ScrollingComposer(host, 'taiko');
    case 2:
      return new ScrollingComposer(host, 'catch');
    case 3:
      return new ScrollingComposer(host, 'mania');
    default:
      return new OsuComposer(host);
  }
}
