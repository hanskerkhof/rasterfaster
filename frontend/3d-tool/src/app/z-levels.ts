/**
 * Height grid modes (the Z axis; X and Y always snap to 20 mm).
 *  - fine:      every 2 mm            0, 2, 4, 6, 8 …      (for 2 mm thick parts)
 *  - baseplate: 2 mm, then every 4 mm 0, 2, 6, 10, 14 …    (the top of a 6 mm baseplate is a level)
 *  - coarse:    every 4 mm            0, 4, 8, 12 …
 */
export type ZGridMode = 'fine' | 'baseplate' | 'coarse';

export const zGridModes: { id: ZGridMode; title: string; detail: string }[] = [
  { id: 'fine', title: 'Fine: every 2 mm', detail: '0, 2, 4, 6, 8 …' },
  { id: 'baseplate', title: 'Baseplate: 2 mm, then 4 mm', detail: '0, 2, 6, 10, 14 … (6 mm base)' },
  { id: 'coarse', title: 'Coarse: every 4 mm', detail: '0, 4, 8, 12 …' },
];

export const defaultZGridMode: ZGridMode = 'fine';

/** Levels are `phase + k·step` for whole k, plus the ground (0). */
const ladders: Record<ZGridMode, { step: number; phase: number }> = {
  fine: { step: 2, phase: 0 },
  baseplate: { step: 4, phase: 2 }, // 6 mm baseplate = 2 mm + one 4 mm step
  coarse: { step: 4, phase: 0 },
};
const epsilon = 1e-6;

/** The level (ground, or phase + k·step) closest to `z`. */
export function nearestZLevel(z: number, mode: ZGridMode): number {
  const { step, phase } = ladders[mode];
  const ladder = phase + Math.round((z - phase) / step) * step;
  return Math.abs(ladder - z) <= Math.abs(z) ? ladder : 0;
}

/** The next level strictly above (direction 1) or below (-1) `z`; off-grid heights go to the closest level in that direction. */
export function nextZLevel(z: number, direction: 1 | -1, mode: ZGridMode): number {
  const { step, phase } = ladders[mode];
  if (direction > 0) {
    const ladder = phase + (Math.floor((z - phase + epsilon) / step) + 1) * step;
    return 0 > z + epsilon && 0 < ladder ? 0 : ladder;
  }
  const ladder = phase + (Math.ceil((z - phase - epsilon) / step) - 1) * step;
  return 0 < z - epsilon && 0 > ladder ? 0 : ladder;
}
