import { describe, expect, it } from 'vitest';
import { similarNames } from './name-similarity';

describe('similarNames', () => {
  it('treats bolts that differ by their size number as alike', () => {
    expect(similarNames('BOLT_S2', 'BOLT_S20')).toBe(true);
  });
  it('ignores copy numbers and the extension', () => {
    expect(similarNames('RF7 CONNECTOR OUT (2).stl', 'RF7 CONNECTOR OUT.stl')).toBe(true);
  });
  it('keeps different parts apart', () => {
    expect(similarNames('RF7 CONNECTOR MID (3).stl', 'RF7 CONNECTOR OUT (1).stl')).toBe(false);
    expect(similarNames('BOLT_S2', 'NUT_S2')).toBe(false);
  });
});
