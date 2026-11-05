import { describe, expect, it } from 'vitest';
import { distinctLabels } from './together';

describe('distinctLabels', () => {
  it('keeps what differs, at word boundaries', () => {
    expect(distinctLabels(['3.43 USB-C FEMALE BACK', '3.43 USB-C FEMALE FRONT'])).toEqual(['BACK', 'FRONT']);
    expect(distinctLabels(['X LEFT 3h', 'X RIGHT 3h'])).toEqual(['LEFT', 'RIGHT']);
    expect(distinctLabels(['c TOP LEFT', 'c TOP RIGHT', 'c BOTTOM LEFT'])).toEqual(['TOP LEFT', 'TOP RIGHT', 'BOTTOM LEFT']);
  });

  it('does not cut words, and keeps a whole name when nothing is left', () => {
    expect(distinctLabels(['PLATE_LEFTY', 'PLATE_LEFTIE'])).toEqual(['LEFTY', 'LEFTIE']);
    expect(distinctLabels(['same', 'same'])).toEqual(['same', 'same']);
    expect(distinctLabels(['only'])).toEqual(['only']);
  });
});
