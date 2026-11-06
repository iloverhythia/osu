// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.

export type ScoreRank = 'F' | 'D' | 'C' | 'B' | 'A' | 'S' | 'SH' | 'X' | 'XH';

export const RANK_COLOURS: Record<ScoreRank, string> = {
  XH: '#dee8f1',
  X: '#ffcc22',
  SH: '#dee8f1',
  S: '#ffcc22',
  A: '#88da20',
  B: '#e3b130',
  C: '#ff8e5d',
  D: '#ff5a5a',
  F: '#b0b0b0',
};

export const RANK_DISPLAY: Record<ScoreRank, string> = {
  XH: 'SS',
  X: 'SS',
  SH: 'S',
  S: 'S',
  A: 'A',
  B: 'B',
  C: 'C',
  D: 'D',
  F: 'F',
};
