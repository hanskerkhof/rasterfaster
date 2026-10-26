import { ZGridMode, nearestZLevel, nextZLevel } from './z-levels';

const walk = (start: number, direction: 1 | -1, mode: ZGridMode, count: number) => {
  const seen = [start];
  for (let i = 0; i < count; i++) seen.push(nextZLevel(seen.at(-1)!, direction, mode));
  return seen;
};

describe('z levels', () => {
  describe('fine (every 2 mm)', () => {
    it('steps 0, 2, 4, 6, 8 and back', () => {
      expect(walk(0, 1, 'fine', 4)).toEqual([0, 2, 4, 6, 8]);
      expect(walk(8, -1, 'fine', 5)).toEqual([8, 6, 4, 2, 0, -2]);
    });
    it('snaps to the nearest 2 mm', () => {
      expect(nearestZLevel(0.9, 'fine')).toBe(0);
      expect(nearestZLevel(1.1, 'fine')).toBe(2);
      expect(nearestZLevel(5, 'fine')).toBe(6);
    });
  });

  describe('baseplate (0, 2, 6, 10, 14 …)', () => {
    it('steps up: 0 -> 2 -> 6 -> 10 -> 14', () => {
      expect(walk(0, 1, 'baseplate', 4)).toEqual([0, 2, 6, 10, 14]);
    });
    it('steps down: 14 -> 10 -> 6 -> 2 -> 0 -> -2', () => {
      expect(walk(14, -1, 'baseplate', 5)).toEqual([14, 10, 6, 2, 0, -2]);
    });
    it('moves an off-grid height to the nearest level in the direction of travel', () => {
      expect(nextZLevel(3, 1, 'baseplate')).toBe(6);
      expect(nextZLevel(3, -1, 'baseplate')).toBe(2);
      expect(nextZLevel(0.5, 1, 'baseplate')).toBe(2);
      expect(nextZLevel(-1, 1, 'baseplate')).toBe(0);
    });
    it('snaps to the nearest level', () => {
      expect(nearestZLevel(0.4, 'baseplate')).toBe(0);
      expect(nearestZLevel(1.2, 'baseplate')).toBe(2);
      expect(nearestZLevel(3.9, 'baseplate')).toBe(2);
      expect(nearestZLevel(4.1, 'baseplate')).toBe(6);
      expect(nearestZLevel(7.9, 'baseplate')).toBe(6);
      expect(nearestZLevel(8.1, 'baseplate')).toBe(10);
    });
  });

  describe('coarse (every 4 mm)', () => {
    it('steps 0, 4, 8, 12 and back', () => {
      expect(walk(0, 1, 'coarse', 3)).toEqual([0, 4, 8, 12]);
      expect(walk(12, -1, 'coarse', 4)).toEqual([12, 8, 4, 0, -4]);
    });
    it('snaps to the nearest 4 mm', () => {
      expect(nearestZLevel(1.9, 'coarse')).toBe(0);
      expect(nearestZLevel(2.1, 'coarse')).toBe(4);
    });
  });
});

describe('a height a hair off a level', () => {
  it('still steps to the next level in both directions', () => {
    expect(nextZLevel(38.005, -1, 'baseplate')).toBe(34);
    expect(nextZLevel(38.005, 1, 'baseplate')).toBe(42);
    expect(nextZLevel(37.995, -1, 'baseplate')).toBe(34);
    expect(nextZLevel(37.995, 1, 'baseplate')).toBe(42);
  });
});
