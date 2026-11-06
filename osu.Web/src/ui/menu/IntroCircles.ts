// Port of osu.Game/Screens/Menu/IntroCircles.cs and IntroSequence.cs (the "circles" intro played by OsuLogo.PlayIntro):
// expanding rings, converging lines, "welcome" text and the four coloured circles assembling into the logo.

import { applyEasing, Easing } from '../../game/storyboard/Easing';

const LOGO_SIZE = 460;
const LENGTH = 3150; // OsuLogo.PlayIntro length
const FADE = 200;
/** IntroCircles.delay_for_menu */
export const CIRCLES_DELAY_FOR_MENU = 2900;
export const CIRCLES_TRACK_START_DELAY = 600;

/** value of a transform starting at `start` lasting `duration` from `from` to `to`. */
function tw(t: number, start: number, duration: number, from: number, to: number, easing: Easing): number {
  if (t <= start) return from;
  if (duration <= 0 || t >= start + duration) return to;
  return from + (to - from) * applyEasing(easing, (t - start) / duration);
}

export class CirclesIntroSequence {
  private completed = false;

  constructor(
    private readonly startTime: number,
    private readonly onComplete: () => void,
  ) {}

  get finished(): boolean {
    return this.completed;
  }

  update(now: number): void {
    if (!this.completed && now - this.startTime >= CIRCLES_DELAY_FOR_MENU) {
      this.completed = true;
      this.onComplete();
    }
  }

  draw(g: CanvasRenderingContext2D, w: number, h: number, now: number): boolean {
    const t = now - this.startTime;
    if (t >= LENGTH + FADE) return false;
    g.save();
    g.translate(w / 2, h / 2);
    // Scale 0.5 → 1 (InOutCubic) once the logo starts forming.
    const seqStart = 250 + LENGTH * 0.56 + 250;
    const remaining = (start: number) => LENGTH - start;
    const scale = tw(t, seqStart, remaining(seqStart), 0.5, 1, Easing.InOutCubic);
    g.scale(scale, scale);

    // Lines (Size 105 × 1.5, white): fade in over 40ms at 250, shrink to 0 width (550, OutQuint), move outwards (700, OutQuint).
    const lineAlpha = tw(t, 250, 40, 0, 1, Easing.None);
    if (lineAlpha > 0) {
      const lw = tw(t, 250, 700 - 150, 105, 0, Easing.OutQuint);
      const off = tw(t, 250, 700, 80, 120, Easing.OutQuint);
      g.fillStyle = `rgba(255,255,255,${lineAlpha})`;
      const line = (x: number, y: number, rot: number, fromRight: boolean) => {
        g.save();
        g.translate(x, y);
        g.rotate((rot * Math.PI) / 180);
        g.fillRect(fromRight ? -lw : 0, -0.75, lw, 1.5);
        g.restore();
      };
      line(-off, -off, 45, false);
      line(off, -off, -45, true);
      line(-off, off, -45, false);
      line(off, off, 45, true);
    }

    // Rings: an outer circle (scale 0.98) and a black foreground of relative size growing to 1.
    const ring = (size: number, colour: string, fg: number) => {
      if (size <= 0) return;
      g.fillStyle = colour;
      g.beginPath();
      g.arc(0, 0, (size / 2) * 0.98, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#000';
      g.beginPath();
      g.arc(0, 0, (size / 2) * Math.min(1, fg), 0, Math.PI * 2);
      g.fill();
    };
    const bigStart = 250 + LENGTH * 0.56;
    ring(tw(t, bigStart, 500, 0, LOGO_SIZE, Easing.InOutQuint), '#b6c5e9', tw(t, bigStart + 250, 850, 0.85, 1, Easing.OutQuint));
    ring(tw(t, 0, 340, 0, 130, Easing.OutQuad), '#ffffff', tw(t, 0, 880, 0.7, 1, Easing.Out));
    // smallRing: FadeColour(Black, 300) after 650.
    const smallFade = tw(t, 650, 300, 0, 1, Easing.None);
    const sc = Math.round(255 * (1 - smallFade));
    ring(tw(t, 0, 400, 0, LOGO_SIZE * 0.086, Easing.InOutQuint), `rgb(${sc},${sc},${sc})`, tw(t, 250, 700, 0.6, 1, Easing.OutQuint));

    // "welcome": FadeIn(700) at 250, spacing 5 → 20 over the remaining time (Easing.Out).
    const textAlpha = tw(t, 250, 700, 0, 1, Easing.None);
    if (textAlpha > 0) {
      const spacing = tw(t, 250, remaining(250), 5, 20, Easing.Out);
      g.save();
      g.fillStyle = `rgba(255,255,255,${textAlpha})`;
      g.font = `300 42px ${getComputedStyle(document.documentElement).getPropertyValue('--font') || 'sans-serif'}`;
      g.textBaseline = 'middle';
      const chars = [...'welcome'];
      const widths = chars.map(c => g.measureText(c).width);
      const total = widths.reduce((a, b) => a + b, 0) + spacing * (chars.length - 1);
      let x = -total / 2;
      chars.forEach((c, i) => {
        g.fillText(c, x, -5);
        x += widths[i] + spacing;
      });
      g.restore();
    }

    // backgroundFill (#C6D8FF, masked to the logo circle): height 0 → 1 while rotating -90.
    // (foregroundFill starts at Size zero and only its width is animated, so it never becomes visible.)
    const fillStart = bigStart + 250;
    const bgH = tw(t, fillStart, remaining(fillStart), 0, 1, Easing.InOutQuart);
    const bgRot = tw(t, fillStart, remaining(fillStart), 0, -90, Easing.InOutQuart);
    if (bgH > 0) {
      g.save();
      g.beginPath();
      g.arc(0, 0, LOGO_SIZE / 2, 0, Math.PI * 2);
      g.clip();
      g.rotate((bgRot * Math.PI) / 180);
      g.fillStyle = '#c6d8ff';
      g.fillRect(-LOGO_SIZE / 2, (-LOGO_SIZE * bgH) / 2, LOGO_SIZE, LOGO_SIZE * bgH);
      g.restore();
    }

    // The coloured circles converge by rotating 180° around their anchored edge.
    const circleSize = LOGO_SIZE * 0.9;
    const rotationDelay = 110;
    const appearDelay = 80;
    const circle = (start: number, colour: string, axis: 'x' | 'y', sign: number) => {
      const size = tw(t, start, remaining(start), 0, circleSize, Easing.InOutQuart);
      if (size <= 0) return;
      const pos = tw(t, start, remaining(start), 250, circleSize / 2, Easing.InOutQuart) * sign;
      const rot = tw(t, start + rotationDelay, remaining(start) - rotationDelay, 0, -180, Easing.InOutQuart);
      g.save();
      if (axis === 'y') g.translate(0, pos);
      else g.translate(pos, 0);
      g.rotate((rot * Math.PI) / 180);
      // Origin is the edge facing the centre: the circle body extends away from it before rotating.
      const cx = axis === 'x' ? (sign * size) / 2 : 0;
      const cy = axis === 'y' ? (sign * size) / 2 : 0;
      g.fillStyle = colour;
      g.beginPath();
      g.arc(cx, cy, size / 2, 0, Math.PI * 2);
      g.fill();
      g.restore();
    };
    circle(fillStart, '#aa92ff', 'y', 1); // purple: TopCentre at (0, 250)
    circle(fillStart + appearDelay * 2, '#8fe5fe', 'x', -1); // blue: CentreRight at (-250, 0)
    circle(fillStart + appearDelay, '#ffd64c', 'y', -1); // yellow: BottomCentre at (0, -250)
    circle(fillStart + appearDelay * 3, '#e967a1', 'x', 1); // pink: CentreLeft at (250, 0)
    g.restore();
    return true;
  }

  drawAdditive(): void {}
}
