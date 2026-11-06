// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of .NET's seeded System.Random (Net5CompatSeedImpl / Knuth subtractive generator),
// used by ManiaModRandom (`new Random(seed)`).

const MBIG = 2147483647;
const MSEED = 161803398;

export class DotNetRandom {
  private readonly seedArray = new Int32Array(56);
  private inext = 0;
  private inextp = 21;

  constructor(seed: number) {
    seed |= 0;
    const subtraction = seed === -2147483648 ? MBIG : Math.abs(seed);
    let mj = (MSEED - subtraction) | 0;
    this.seedArray[55] = mj;
    let mk = 1;
    for (let i = 1; i < 55; i++) {
      const ii = (21 * i) % 55;
      this.seedArray[ii] = mk;
      mk = (mj - mk) | 0;
      if (mk < 0) mk = (mk + MBIG) | 0;
      mj = this.seedArray[ii];
    }
    for (let k = 1; k < 5; k++) {
      for (let i = 1; i < 56; i++) {
        let n = i + 30;
        if (n >= 55) n -= 55;
        let v = (this.seedArray[i] - this.seedArray[1 + n]) | 0;
        if (v < 0) v = (v + MBIG) | 0;
        this.seedArray[i] = v;
      }
    }
  }

  private internalSample(): number {
    let locINext = this.inext;
    if (++locINext >= 56) locINext = 1;
    let locINextp = this.inextp;
    if (++locINextp >= 56) locINextp = 1;

    let retVal = (this.seedArray[locINext] - this.seedArray[locINextp]) | 0;
    if (retVal === MBIG) retVal--;
    if (retVal < 0) retVal = (retVal + MBIG) | 0;

    this.seedArray[locINext] = retVal;
    this.inext = locINext;
    this.inextp = locINextp;
    return retVal;
  }

  /** Random.Next(): a non-negative integer less than int.MaxValue. */
  next(): number {
    return this.internalSample();
  }

  /** Random.NextDouble() */
  nextDouble(): number {
    return this.internalSample() * (1.0 / MBIG);
  }
}
