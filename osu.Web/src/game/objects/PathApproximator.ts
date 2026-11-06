// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Framework.Utils.PathApproximator.

import { Vec2, almostEquals, add, scale, sub, lengthSq } from '../../framework/math';

const BEZIER_TOLERANCE = Math.fround(0.25);
const CATMULL_DETAIL = 50;
const CIRCULAR_ARC_TOLERANCE = Math.fround(0.1);

export function linearToPiecewiseLinear(controlPoints: readonly Vec2[]): Vec2[] {
  return controlPoints.map(p => ({ x: p.x, y: p.y }));
}

export function bezierToPiecewiseLinear(controlPoints: readonly Vec2[]): Vec2[] {
  return bSplineToPiecewiseLinear(controlPoints, Math.max(1, controlPoints.length - 1));
}

export function bSplineToPiecewiseLinear(controlPoints: readonly Vec2[], degree: number): Vec2[] {
  if (controlPoints.length < 2) return controlPoints.length === 0 ? [] : [{ ...controlPoints[0] }];

  degree = Math.min(degree, controlPoints.length - 1);
  const output: Vec2[] = [];
  const pointCount = controlPoints.length - 1;
  const toFlatten = bSplineToBezierInternal(controlPoints, degree);
  degree = toFlatten.degree;
  const stack = toFlatten.stack;
  const freeBuffers: Vec2[][] = [];

  const subdivisionBuffer1: Vec2[] = new Array(degree + 1);
  const subdivisionBuffer2: Vec2[] = new Array(degree * 2 + 1);
  const leftChild = subdivisionBuffer2;

  while (stack.length > 0) {
    const parent = stack.pop()!;
    if (bezierIsFlatEnough(parent)) {
      bezierApproximate(parent, output, subdivisionBuffer1, subdivisionBuffer2, degree + 1);
      freeBuffers.push(parent);
      continue;
    }
    const rightChild = freeBuffers.length > 0 ? freeBuffers.pop()! : new Array<Vec2>(degree + 1);
    bezierSubdivide(parent, leftChild, rightChild, subdivisionBuffer1, degree + 1);
    for (let i = 0; i < degree + 1; ++i) parent[i] = leftChild[i];
    stack.push(rightChild);
    stack.push(parent);
  }

  output.push({ ...controlPoints[pointCount] });
  return output;
}

function bSplineToBezierInternal(controlPoints: readonly Vec2[], degree: number): { stack: Vec2[][]; degree: number } {
  degree = Math.min(degree, controlPoints.length - 1);
  const pointCount = controlPoints.length - 1;
  const points = controlPoints.map(p => ({ x: p.x, y: p.y }));

  if (degree === pointCount) return { stack: [points], degree };

  const ordered: Vec2[][] = [];
  for (let i = 0; i < pointCount - degree; i++) {
    const subBezier: Vec2[] = new Array(degree + 1);
    subBezier[0] = points[i];
    // Destructively insert the knot degree-1 times via Boehm's algorithm.
    for (let j = 0; j < degree - 1; j++) {
      subBezier[j + 1] = points[i + 1];
      for (let k = 1; k < degree - j; k++) {
        const l = Math.min(k, pointCount - degree - i);
        points[i + k] = scale(add(scale(points[i + k], l), points[i + k + 1]), 1 / (l + 1));
      }
    }
    subBezier[degree] = points[i + 1];
    ordered.push(subBezier);
  }
  ordered.push(points.slice(pointCount - degree));
  // Stack is consumed via pop(), so reverse to keep the first segment on top.
  return { stack: ordered.reverse(), degree };
}

function bezierIsFlatEnough(controlPoints: Vec2[]): boolean {
  for (let i = 1; i < controlPoints.length - 1; i++) {
    const p = add(sub(controlPoints[i - 1], scale(controlPoints[i], 2)), controlPoints[i + 1]);
    if (lengthSq(p) > BEZIER_TOLERANCE * BEZIER_TOLERANCE * 4) return false;
  }
  return true;
}

function bezierSubdivide(controlPoints: Vec2[], l: Vec2[], r: Vec2[], subdivisionBuffer: Vec2[], count: number): void {
  const midpoints = subdivisionBuffer;
  for (let i = 0; i < count; ++i) midpoints[i] = controlPoints[i];
  for (let i = 0; i < count; i++) {
    l[i] = midpoints[0];
    r[count - i - 1] = midpoints[count - i - 1];
    for (let j = 0; j < count - i - 1; j++) midpoints[j] = scale(add(midpoints[j], midpoints[j + 1]), 0.5);
  }
}

function bezierApproximate(controlPoints: Vec2[], output: Vec2[], subdivisionBuffer1: Vec2[], subdivisionBuffer2: Vec2[], count: number): void {
  const l = subdivisionBuffer2;
  const r = subdivisionBuffer1;
  bezierSubdivide(controlPoints, l, r, subdivisionBuffer1, count);
  for (let i = 0; i < count - 1; ++i) l[count + i] = r[i + 1];
  output.push({ ...controlPoints[0] });
  for (let i = 1; i < count - 1; ++i) {
    const index = 2 * i;
    const p = scale(add(add(l[index - 1], scale(l[index], 2)), l[index + 1]), 0.25);
    output.push(p);
  }
}

export function catmullToPiecewiseLinear(controlPoints: readonly Vec2[]): Vec2[] {
  const result: Vec2[] = [];
  for (let i = 0; i < controlPoints.length - 1; i++) {
    const v1 = i > 0 ? controlPoints[i - 1] : controlPoints[i];
    const v2 = controlPoints[i];
    const v3 = i < controlPoints.length - 1 ? controlPoints[i + 1] : sub(scale(v2, 2), v1);
    const v4 = i < controlPoints.length - 2 ? controlPoints[i + 2] : sub(scale(v3, 2), v2);
    for (let c = 0; c < CATMULL_DETAIL; c++) {
      result.push(catmullFindPoint(v1, v2, v3, v4, c / CATMULL_DETAIL));
      result.push(catmullFindPoint(v1, v2, v3, v4, (c + 1) / CATMULL_DETAIL));
    }
  }
  return result;
}

function catmullFindPoint(v1: Vec2, v2: Vec2, v3: Vec2, v4: Vec2, t: number): Vec2 {
  const t2 = t * t;
  const t3 = t * t2;
  return {
    x: 0.5 * (2 * v2.x + (-v1.x + v3.x) * t + (2 * v1.x - 5 * v2.x + 4 * v3.x - v4.x) * t2 + (-v1.x + 3 * v2.x - 3 * v3.x + v4.x) * t3),
    y: 0.5 * (2 * v2.y + (-v1.y + v3.y) * t + (2 * v1.y - 5 * v2.y + 4 * v3.y - v4.y) * t2 + (-v1.y + 3 * v2.y - 3 * v3.y + v4.y) * t3),
  };
}

export class CircularArcProperties {
  isValid = false;
  thetaStart = 0;
  thetaRange = 0;
  direction = 1;
  radius = 0;
  centre: Vec2 = { x: 0, y: 0 };

  constructor(controlPoints: readonly Vec2[]) {
    const a = controlPoints[0];
    const b = controlPoints[1];
    const c = controlPoints[2];

    // Degenerate triangle: fall back to a more numerically stable method.
    if (almostEquals(0, (b.y - a.y) * (c.x - a.x) - (b.x - a.x) * (c.y - a.y))) return;

    const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
    const aSq = lengthSq(a);
    const bSq = lengthSq(b);
    const cSq = lengthSq(c);

    this.centre = {
      x: (aSq * (b.y - c.y) + bSq * (c.y - a.y) + cSq * (a.y - b.y)) / d,
      y: (aSq * (c.x - b.x) + bSq * (a.x - c.x) + cSq * (b.x - a.x)) / d,
    };

    const dA = sub(a, this.centre);
    const dC = sub(c, this.centre);
    this.radius = Math.hypot(dA.x, dA.y);
    this.thetaStart = Math.atan2(dA.y, dA.x);
    let thetaEnd = Math.atan2(dC.y, dC.x);
    while (thetaEnd < this.thetaStart) thetaEnd += 2 * Math.PI;

    this.direction = 1;
    this.thetaRange = thetaEnd - this.thetaStart;

    // Decide in which direction to draw the circle, depending on which side of AC B lies.
    const orthoAtoC = { x: c.y - a.y, y: -(c.x - a.x) };
    if (orthoAtoC.x * (b.x - a.x) + orthoAtoC.y * (b.y - a.y) < 0) {
      this.direction = -this.direction;
      this.thetaRange = 2 * Math.PI - this.thetaRange;
    }
    this.isValid = true;
  }
}

export function circularArcToPiecewiseLinear(controlPoints: readonly Vec2[]): Vec2[] {
  const pr = new CircularArcProperties(controlPoints);
  if (!pr.isValid) return bezierToPiecewiseLinear(controlPoints);

  const amountPoints =
    2 * pr.radius <= CIRCULAR_ARC_TOLERANCE
      ? 2
      : Math.max(2, Math.ceil(pr.thetaRange / (2 * Math.acos(1 - CIRCULAR_ARC_TOLERANCE / pr.radius))));

  const output: Vec2[] = [];
  for (let i = 0; i < amountPoints; ++i) {
    const fract = i / (amountPoints - 1);
    const theta = pr.thetaStart + pr.direction * fract * pr.thetaRange;
    output.push({ x: pr.centre.x + Math.cos(theta) * pr.radius, y: pr.centre.y + Math.sin(theta) * pr.radius });
  }
  return output;
}
