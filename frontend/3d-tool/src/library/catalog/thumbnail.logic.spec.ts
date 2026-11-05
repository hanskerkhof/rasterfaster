import { describe, expect, it } from 'vitest';
import { formatDims, isLarge, isTooLarge, maxAutoDrawBytes, maxDrawBytes, meshVolume, themeSvg } from './thumbnail.logic';

describe('thumbnail logic', () => {
  it('makes a drawing fit for a dark card', () => {
    const drawn = '<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80" viewBox="4 5 120 80">\n<title>View</title>\n<rect x="4" y="5" width="120" height="80" fill="#fff"/>\n<path d="M0.123 0.987L11.55 1.04" fill="none" stroke="#000" stroke-width="1.4" stroke-linecap="round"/>\n</svg>\n';
    const themed = themeSvg(drawn);
    expect(themed.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="4 5 120 80" width="60" height="40">')).toBe(true); // half the units: 2 units per CSS pixel
    expect(themed).toContain('stroke-width="2"'); // one CSS pixel
    expect(themed).toContain('stroke="#e6e6e6"');
    expect(themed).toContain('d="M0.1 0.9L11.5 1.0"'); // one decimal
    expect(themed).not.toMatch(/#fff|#000|<rect|<title|width="120"|1\.4/);
    expect(themed.endsWith('</svg>')).toBe(true);
    expect(themeSvg('<svg viewBox="0 0 125 61" width="1" height="1"></svg>')).toBe('<svg viewBox="0 0 125 61" width="62" height="30"></svg>'); // even sizes (62.5 and 30.5 round to whole even pixels)
  });

  it('measures the volume of a closed mesh', () => {
    // a 2 × 3 × 4 box from 12 triangles
    const p = [[0, 0, 0], [2, 0, 0], [2, 3, 0], [0, 3, 0], [0, 0, 4], [2, 0, 4], [2, 3, 4], [0, 3, 4]];
    const faces = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [2, 3, 7], [2, 7, 6], [1, 2, 6], [1, 6, 5], [3, 0, 4], [3, 4, 7]];
    expect(meshVolume(faces.flatMap(f => f.flatMap(i => p[i])))).toBeCloseTo(24, 6);
    expect(meshVolume([])).toBe(0);
  });

  it('formats the dimensions', () => {
    expect(formatDims([15.26, 15.3, 44])).toBe('15.3 × 15.3 × 44 mm');
    expect(formatDims([250.4, 99.94, 3])).toBe('250 × 99.9 × 3 mm');
    expect(formatDims(null)).toBe('');
    expect(formatDims([1, 2])).toBe('');
  });

  it('calls a file large above the limit', () => {
    expect(isLarge(maxAutoDrawBytes)).toBe(false);
    expect(isLarge(maxAutoDrawBytes + 1)).toBe(true);
    expect(isTooLarge(maxDrawBytes)).toBe(false); // above this a part is never drawn
    expect(isTooLarge(maxDrawBytes + 1)).toBe(true);
  });
});
