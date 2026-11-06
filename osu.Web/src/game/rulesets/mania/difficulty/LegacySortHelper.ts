// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port of osu.Game.Rulesets.Mania/MathUtils/LegacySortHelper.cs
// (the unstable introsort of .NET Framework 4, reproduced so that tie ordering matches osu!stable).

const quick_sort_depth_threshold = 32;

export function legacySort<T>(keys: T[], comparer: (a: T, b: T) => number): void {
  if (keys.length === 0) return;
  depthLimitedQuickSort(keys, 0, keys.length - 1, comparer, quick_sort_depth_threshold);
}

function depthLimitedQuickSort<T>(keys: T[], left: number, right: number, comparer: (a: T, b: T) => number, depthLimit: number): void {
  do {
    if (depthLimit === 0) {
      heapsort(keys, left, right, comparer);
      return;
    }

    let i = left;
    let j = right;

    // pre-sort the low, middle (pivot), and high values in place.
    const middle = i + ((j - i) >> 1);
    swapIfGreater(keys, comparer, i, middle); // swap the low with the mid point
    swapIfGreater(keys, comparer, i, j); // swap the low with the high
    swapIfGreater(keys, comparer, middle, j); // swap the middle with the high

    const x = keys[middle];

    do {
      while (comparer(keys[i], x) < 0) i++;
      while (comparer(x, keys[j]) < 0) j--;
      if (i > j) break;

      if (i < j) {
        const t = keys[i];
        keys[i] = keys[j];
        keys[j] = t;
      }

      i++;
      j--;
    } while (i <= j);

    depthLimit--;

    if (j - left <= right - i) {
      if (left < j) depthLimitedQuickSort(keys, left, j, comparer, depthLimit);
      left = i;
    } else {
      if (i < right) depthLimitedQuickSort(keys, i, right, comparer, depthLimit);
      right = j;
    }
  } while (left < right);
}

function heapsort<T>(keys: T[], lo: number, hi: number, comparer: (a: T, b: T) => number): void {
  const n = hi - lo + 1;

  for (let i = n >> 1; i >= 1; i--) downHeap(keys, i, n, lo, comparer);

  for (let i = n; i > 1; i--) {
    swap(keys, lo, lo + i - 1);
    downHeap(keys, 1, i - 1, lo, comparer);
  }
}

function downHeap<T>(keys: T[], i: number, n: number, lo: number, comparer: (a: T, b: T) => number): void {
  const d = keys[lo + i - 1];

  while (i <= n >> 1) {
    let child = 2 * i;

    if (child < n && comparer(keys[lo + child - 1], keys[lo + child]) < 0) child++;

    if (!(comparer(d, keys[lo + child - 1]) < 0)) break;

    keys[lo + i - 1] = keys[lo + child - 1];
    i = child;
  }

  keys[lo + i - 1] = d;
}

function swap<T>(a: T[], i: number, j: number): void {
  if (i !== j) {
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
}

function swapIfGreater<T>(keys: T[], comparer: (a: T, b: T) => number, a: number, b: number): void {
  if (a !== b && comparer(keys[a], keys[b]) > 0) {
    const t = keys[a];
    keys[a] = keys[b];
    keys[b] = t;
  }
}
