// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game/Rulesets/Objects/SliderEventGenerator.cs

export type SliderEventType = 'Tick' | 'LegacyLastTick' | 'Head' | 'Tail' | 'Repeat';

export interface SliderEventDescriptor {
  type: SliderEventType;
  time: number;
  spanIndex: number;
  spanStartTime: number;
  pathProgress: number;
}

export const TAIL_LENIENCY = -36;

export function generateSliderEvents(
  startTime: number,
  spanDuration: number,
  velocity: number,
  tickDistance: number,
  totalDistance: number,
  spanCount: number,
): SliderEventDescriptor[] {
  // A very lenient maximum length of a slider for ticks to be generated.
  const maxLength = 100000;
  const length = Math.min(maxLength, totalDistance);
  tickDistance = Math.min(Math.max(tickDistance, 0), length);
  const minDistanceFromEnd = velocity * 10;

  const events: SliderEventDescriptor[] = [];
  events.push({ type: 'Head', spanIndex: 0, spanStartTime: startTime, time: startTime, pathProgress: 0 });

  for (let span = 0; span < spanCount; span++) {
    const spanStartTime = startTime + span * spanDuration;
    const reversed = span % 2 === 1;

    if (tickDistance !== 0) {
      const ticks = generateTicks(span, spanStartTime, spanDuration, reversed, length, tickDistance, minDistanceFromEnd);
      if (reversed) ticks.reverse();
      events.push(...ticks);
    }

    if (span < spanCount - 1) {
      events.push({
        type: 'Repeat',
        spanIndex: span,
        spanStartTime: startTime + span * spanDuration,
        time: spanStartTime + spanDuration,
        pathProgress: (span + 1) % 2,
      });
    }
  }

  const totalDuration = spanCount * spanDuration;
  const finalSpanIndex = spanCount - 1;
  const finalSpanStartTime = startTime + finalSpanIndex * spanDuration;

  // Legacy last tick: placed 36ms before the end of the slider, or at the middle for very short sliders.
  const legacyLastTickTime = Math.max(startTime + totalDuration / 2, finalSpanStartTime + spanDuration + TAIL_LENIENCY);
  let legacyLastTickProgress = (legacyLastTickTime - finalSpanStartTime) / spanDuration;
  if (spanCount % 2 === 0) legacyLastTickProgress = 1 - legacyLastTickProgress;

  events.push({
    type: 'LegacyLastTick',
    spanIndex: finalSpanIndex,
    spanStartTime: finalSpanStartTime,
    time: legacyLastTickTime,
    pathProgress: legacyLastTickProgress,
  });

  events.push({
    type: 'Tail',
    spanIndex: finalSpanIndex,
    spanStartTime: startTime + (spanCount - 1) * spanDuration,
    time: startTime + totalDuration,
    pathProgress: spanCount % 2,
  });

  return events;
}

function generateTicks(
  spanIndex: number,
  spanStartTime: number,
  spanDuration: number,
  reversed: boolean,
  length: number,
  tickDistance: number,
  minDistanceFromEnd: number,
): SliderEventDescriptor[] {
  const ticks: SliderEventDescriptor[] = [];
  for (let d = tickDistance; d <= length; d += tickDistance) {
    if (d >= length - minDistanceFromEnd) break;
    // Always generate ticks from the start of the path rather than the span to ensure that ticks in repeat spans are positioned identically to those in non-repeat spans
    const pathProgress = d / length;
    const timeProgress = reversed ? 1 - pathProgress : pathProgress;
    ticks.push({ type: 'Tick', spanIndex, spanStartTime, time: spanStartTime + timeProgress * spanDuration, pathProgress });
  }
  return ticks;
}
