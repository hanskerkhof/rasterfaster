import { nearestZLevel, nextZLevel } from './z-levels';

describe('z levels (0, 2, 6, 10, 14, … for a 6 mm base)', () => {
  it('steps up: 0 -> 2 -> 6 -> 10 -> 14', () => {
    const seen = [0];
    for (let i = 0; i < 4; i++) seen.push(nextZLevel(seen.at(-1)!, 1));
    expect(seen).toEqual([0, 2, 6, 10, 14]);
  });

  it('steps down: 14 -> 10 -> 6 -> 2 -> 0 -> -2', () => {
    const seen = [14];
    for (let i = 0; i < 5; i++) seen.push(nextZLevel(seen.at(-1)!, -1));
    expect(seen).toEqual([14, 10, 6, 2, 0, -2]);
  });

  it('moves an off-grid height to the nearest level in the direction of travel', () => {
    expect(nextZLevel(3, 1)).toBe(6);
    expect(nextZLevel(3, -1)).toBe(2);
    expect(nextZLevel(0.5, 1)).toBe(2);
    expect(nextZLevel(-1, 1)).toBe(0);
  });

  it('snaps to the nearest level', () => {
    expect(nearestZLevel(0.4)).toBe(0);
    expect(nearestZLevel(1.2)).toBe(2);
    expect(nearestZLevel(3.9)).toBe(2);
    expect(nearestZLevel(4.1)).toBe(6);
    expect(nearestZLevel(7.9)).toBe(6);
    expect(nearestZLevel(8.1)).toBe(10);
    expect(nearestZLevel(6)).toBe(6);
  });
});
