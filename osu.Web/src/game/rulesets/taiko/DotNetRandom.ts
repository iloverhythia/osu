// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of .NET's seeded System.Random (the legacy Knuth subtractive generator, "Net5CompatSeedImpl"),
// which TaikoModRandom uses via `new Random(seed)`. Needed so a given seed reproduces lazer's colour shuffle.

const MBIG = 2147483647;
const MSEED = 161803398;

export class DotNetRandom {
  private readonly seedArray = new Array<number>(56).fill(0);
  private inext = 0;
  private inextp = 21;

  constructor(seed: number) {
    seed |= 0;
    const subtraction = seed === -2147483648 ? MBIG : Math.abs(seed);
    let mj = MSEED - subtraction;
    this.seedArray[55] = mj;
    let mk = 1;
    let ii = 0;
    for (let i = 1; i < 55; i++) {
      if ((ii += 21) >= 55) ii -= 55;
      this.seedArray[ii] = mk;
      mk = mj - mk;
      if (mk < 0) mk += MBIG;
      mj = this.seedArray[ii];
    }
    for (let k = 1; k < 5; k++) {
      for (let i = 1; i < 56; i++) {
        let n = i + 30;
        if (n >= 55) n -= 55;
        this.seedArray[i] -= this.seedArray[1 + n];
        if (this.seedArray[i] < 0) this.seedArray[i] += MBIG;
      }
    }
  }

  private internalSample(): number {
    let locINext = this.inext;
    if (++locINext >= 56) locINext = 1;
    let locINextp = this.inextp;
    if (++locINextp >= 56) locINextp = 1;
    let retVal = this.seedArray[locINext] - this.seedArray[locINextp];
    if (retVal === MBIG) retVal--;
    if (retVal < 0) retVal += MBIG;
    this.seedArray[locINext] = retVal;
    this.inext = locINext;
    this.inextp = locINextp;
    return retVal;
  }

  /** Random.NextDouble() / Sample(): [0, 1). */
  nextDouble(): number {
    return this.internalSample() * (1.0 / MBIG);
  }

  /** Random.Next(maxValue): [0, maxValue). */
  nextMax(maxValue: number): number {
    return Math.trunc(this.nextDouble() * maxValue);
  }

  /** Random.Next(): [0, int.MaxValue). */
  next(): number {
    return this.internalSample();
  }
}
