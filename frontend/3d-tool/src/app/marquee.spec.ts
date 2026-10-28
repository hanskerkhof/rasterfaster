import { describe, expect, it } from 'vitest';
import { segmentTouchesRect, triangleTouchesRect } from './document-scene';

const rect = { left: 10, right: 20, top: 10, bottom: 20 };
const triangle = (...p: number[]) => triangleTouchesRect(new Float32Array(p), 0, 1, 2, rect);

describe('selection rectangle', () => {
  it('segments: inside, crossing, outside', () => {
    expect(segmentTouchesRect(12, 12, 14, 14, rect)).toBe(true);
    expect(segmentTouchesRect(0, 15, 30, 15, rect)).toBe(true);
    expect(segmentTouchesRect(0, 0, 5, 30, rect)).toBe(false);
    expect(segmentTouchesRect(0, 5, 30, 5, rect)).toBe(false);
  });

  it('triangles: a vertex inside, an edge crossing, the rectangle inside a big triangle, and a miss', () => {
    expect(triangle(12, 12, 40, 12, 12, 40)).toBe(true);
    expect(triangle(0, 15, 30, 15, 15, 40)).toBe(true);
    expect(triangle(-100, -100, 200, -100, 0, 300)).toBe(true);
    expect(triangle(30, 30, 40, 30, 30, 40)).toBe(false);
    expect(triangle(0, 0, 8, 0, 0, 8)).toBe(false); // near the corner but short of it
  });
});
