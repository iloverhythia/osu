// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game/Rulesets/Objects/SliderPath.cs (+ PathControlPoint / PathType).

import { Vec2, almostEquals, binarySearch, equals } from '../../framework/math';

// osuTK Vector2 maths is single precision.
const f = Math.fround;
const lengthF = (dx: number, dy: number) => f(Math.sqrt(f(f(dx * dx) + f(dy * dy))));
const distance = (a: Vec2, b: Vec2) => lengthF(f(a.x - b.x), f(a.y - b.y));
import {
  CircularArcProperties,
  bSplineToPiecewiseLinear,
  catmullToPiecewiseLinear,
  circularArcToPiecewiseLinear,
  linearToPiecewiseLinear,
} from './PathApproximator';

export type SplineType = 'Catmull' | 'BSpline' | 'Linear' | 'PerfectCurve';

export interface PathType {
  type: SplineType;
  /** Degree for B-splines; undefined means a plain bezier. */
  degree?: number;
}

export const PathTypes = {
  CATMULL: { type: 'Catmull' } as PathType,
  BEZIER: { type: 'BSpline' } as PathType,
  LINEAR: { type: 'Linear' } as PathType,
  PERFECT_CURVE: { type: 'PerfectCurve' } as PathType,
  bSpline: (degree: number): PathType => ({ type: 'BSpline', degree }),
};

export const pathTypeEquals = (a: PathType | null | undefined, b: PathType | null | undefined): boolean =>
  a == null || b == null ? a == b : a.type === b.type && a.degree === b.degree;

export interface PathControlPoint {
  position: Vec2;
  type: PathType | null;
}

export class SliderPath {
  readonly controlPoints: PathControlPoint[];
  expectedDistance: number | null;
  optimiseCatmull = false;

  private valid = false;
  private calculatedPath: Vec2[] = [];
  private cumulativeLength: number[] = [];
  private segmentEnds: number[] = [];
  private segmentEndDistances: number[] = [];
  private optimisedLength = 0;
  private calculatedLength = 0;

  constructor(controlPoints: PathControlPoint[] = [], expectedDistance: number | null = null, optimiseCatmull = false) {
    this.controlPoints = controlPoints;
    this.expectedDistance = expectedDistance;
    this.optimiseCatmull = optimiseCatmull;
  }

  static fromPoints(type: PathType, points: Vec2[], expectedDistance: number | null = null): SliderPath {
    return new SliderPath(points.map((p, i) => ({ position: p, type: i === 0 ? type : null })), expectedDistance);
  }

  clone(): SliderPath {
    return new SliderPath(
      this.controlPoints.map(c => ({ position: { ...c.position }, type: c.type })),
      this.expectedDistance,
      this.optimiseCatmull,
    );
  }

  invalidate(): void {
    this.valid = false;
  }

  get distance(): number {
    this.ensureValid();
    return this.cumulativeLength.length === 0 ? 0 : this.cumulativeLength[this.cumulativeLength.length - 1];
  }

  get calculatedDistance(): number {
    this.ensureValid();
    return this.calculatedLength;
  }

  get path(): readonly Vec2[] {
    this.ensureValid();
    return this.calculatedPath;
  }

  getSegmentEnds(): number[] {
    this.ensureValid();
    const d = this.distance;
    return this.segmentEndDistances.map(x => x / d);
  }

  /** Computes the slider path until a given progress that ranges from 0 (beginning) to 1 (end). */
  getPathToProgress(p0: number, p1: number): Vec2[] {
    this.ensureValid();
    const d0 = this.progressToDistance(p0);
    const d1 = this.progressToDistance(p1);
    const path: Vec2[] = [];
    let i = 0;
    for (; i < this.calculatedPath.length && this.cumulativeLength[i] < d0; ++i) {
      /* skip */
    }
    path.push(this.interpolateVertices(i, d0));
    for (; i < this.calculatedPath.length && this.cumulativeLength[i] <= d1; ++i) path.push(this.calculatedPath[i]);
    path.push(this.interpolateVertices(i, d1));
    return path;
  }

  /** Position relative to the slider head at a progress in [0, 1]. */
  positionAt(progress: number): Vec2 {
    this.ensureValid();
    const d = this.progressToDistance(progress);
    return this.interpolateVertices(this.indexOfDistance(d), d);
  }

  private ensureValid(): void {
    if (this.valid) return;
    this.calculatePath();
    this.calculateLength();
    this.valid = true;
  }

  private calculatePath(): void {
    this.calculatedPath = [];
    this.segmentEnds = [];
    this.optimisedLength = 0;
    const cps = this.controlPoints;
    if (cps.length === 0) return;

    const vertices = cps.map(c => c.position);
    let start = 0;
    for (let i = 0; i < cps.length; i++) {
      if (cps[i].type == null && i < cps.length - 1) continue;

      // The current vertex ends the segment
      const segmentVertices = vertices.slice(start, i + 1);
      const segmentType = cps[start].type ?? PathTypes.LINEAR;

      if (segmentVertices.length === 1) this.calculatedPath.push(segmentVertices[0]);
      else if (segmentVertices.length > 1) {
        const subPath = this.calculateSubPath(segmentVertices, segmentType);
        // Skip the first vertex if it is the same as the last vertex from the previous segment
        const last = this.calculatedPath[this.calculatedPath.length - 1];
        const skipFirst = this.calculatedPath.length > 0 && subPath.length > 0 && equals(last, subPath[0]);
        for (let j = skipFirst ? 1 : 0; j < subPath.length; j++) this.calculatedPath.push(subPath[j]);
      }

      if (i > 0) this.segmentEnds.push(this.calculatedPath.length - 1);
      start = i;
    }
  }

  private calculateSubPath(subControlPoints: Vec2[], type: PathType): Vec2[] {
    switch (type.type) {
      case 'Linear':
        return linearToPiecewiseLinear(subControlPoints);

      case 'PerfectCurve': {
        if (subControlPoints.length !== 3) break;
        const props = new CircularArcProperties(subControlPoints);
        if (!props.isValid) break;
        // If we have a lot of points, it's probably better to use a bezier curve instead.
        const subPoints =
          f(2 * props.radius) <= f(0.1) ? 2 : Math.max(2, Math.ceil(props.thetaRange / (2 * Math.acos(f(1 - f(f(0.1) / props.radius))))));
        if (subPoints >= 1000) break;
        const subPath = circularArcToPiecewiseLinear(subControlPoints);
        if (subPath.length === 0) break;
        return subPath;
      }

      case 'Catmull': {
        const subPath = catmullToPiecewiseLinear(subControlPoints);
        if (!this.optimiseCatmull) return subPath;

        // At this point the catmull is fully approximated; optimise away redundant short segments.
        const optimisedPath: Vec2[] = [];
        let lastStart: Vec2 | null = null;
        let lengthRemovedSinceStart = 0;
        for (let i = 0; i < subPath.length; i++) {
          if (lastStart == null) {
            optimisedPath.push(subPath[i]);
            lastStart = subPath[i];
            continue;
          }
          const distFromStart = distance(lastStart, subPath[i]);
          lengthRemovedSinceStart += distance(subPath[i - 1], subPath[i]);
          const catmullSegmentLength = 50 * 2;
          if (distFromStart > 6 || (i + 1) % catmullSegmentLength === 0 || i === subPath.length - 1) {
            optimisedPath.push(subPath[i]);
            this.optimisedLength += lengthRemovedSinceStart - distFromStart;
            lastStart = null;
            lengthRemovedSinceStart = 0;
          }
        }
        return optimisedPath;
      }
    }
    return bSplineToPiecewiseLinear(subControlPoints, type.degree ?? subControlPoints.length);
  }

  private calculateLength(): void {
    this.calculatedLength = this.optimisedLength;
    this.cumulativeLength = [0];
    const path = this.calculatedPath;
    for (let i = 0; i < path.length - 1; i++) {
      this.calculatedLength += distance(path[i + 1], path[i]);
      this.cumulativeLength.push(this.calculatedLength);
    }

    this.segmentEndDistances = this.segmentEnds.map(i => this.cumulativeLength[i]);

    const expectedDistance = this.expectedDistance;
    if (expectedDistance != null && this.calculatedLength !== expectedDistance) {
      // In osu-stable, if the last two path points of a slider are equal, extension is not performed.
      if (path.length >= 2 && equals(path[path.length - 1], path[path.length - 2]) && expectedDistance > this.calculatedLength) {
        this.cumulativeLength.push(this.calculatedLength);
        return;
      }

      // The last length is always incorrect
      this.cumulativeLength.pop();
      let pathEndIndex = path.length - 1;

      if (this.calculatedLength > expectedDistance) {
        // The path will be shortened further, in which case we should trim any more unnecessary lengths and their associated path segments
        while (this.cumulativeLength.length > 0 && this.cumulativeLength[this.cumulativeLength.length - 1] >= expectedDistance) {
          this.cumulativeLength.pop();
          path.splice(pathEndIndex--, 1);
        }
      }

      if (pathEndIndex <= 0) {
        // The expected distance is negative or zero
        this.cumulativeLength.push(0);
        return;
      }

      // The direction of the segment to shorten or lengthen (Vector2.Normalized: this * (1 / Length), in float)
      const dx = f(path[pathEndIndex].x - path[pathEndIndex - 1].x);
      const dy = f(path[pathEndIndex].y - path[pathEndIndex - 1].y);
      const inv = f(1 / lengthF(dx, dy));
      const dir = { x: f(dx * inv), y: f(dy * inv) };
      const remaining = f(expectedDistance - this.cumulativeLength[this.cumulativeLength.length - 1]);
      path[pathEndIndex] = { x: f(path[pathEndIndex - 1].x + f(dir.x * remaining)), y: f(path[pathEndIndex - 1].y + f(dir.y * remaining)) };
      this.cumulativeLength.push(expectedDistance);
    }
  }

  private indexOfDistance(d: number): number {
    let i = binarySearch(this.cumulativeLength, d);
    if (i < 0) i = ~i;
    return i;
  }

  private progressToDistance(progress: number): number {
    return Math.min(1, Math.max(0, progress)) * this.distance;
  }

  private interpolateVertices(i: number, d: number): Vec2 {
    const path = this.calculatedPath;
    if (path.length === 0) return { x: 0, y: 0 };
    if (i <= 0) return path[0];
    if (i >= path.length) return path[path.length - 1];

    const p0 = path[i - 1];
    const p1 = path[i];
    const d0 = this.cumulativeLength[i - 1];
    const d1 = this.cumulativeLength[i];

    // Avoid division by and almost-zero number in case two points are extremely close to each other.
    if (almostEquals(d0, d1)) return p0;
    const w = f((d - d0) / (d1 - d0));
    return { x: f(p0.x + f(f(p1.x - p0.x) * w)), y: f(p0.y + f(f(p1.y - p0.y) * w)) };
  }
}
