/**
 * Height grid. Almost every RASTERFASTER design stands on a 6 mm baseplate, so the levels are
 * 0 (ground), then 2, 6, 10, 14, … : the first step up is 2 mm, which puts the next level on top of the baseplate,
 * and from there every step is 4 mm. Change `baseThicknessMm` for another base.
 */
export const zStepMm = 4;
export const baseThicknessMm = 6;

/** Offset of the 4 mm ladder above the ground: 2 mm for a 6 mm base. */
const phase = ((baseThicknessMm % zStepMm) + zStepMm) % zStepMm;
const epsilon = 1e-6;

/** The level (ground, or phase + k·step) closest to `z`. */
export function nearestZLevel(z: number): number {
  const ladder = phase + Math.round((z - phase) / zStepMm) * zStepMm;
  return Math.abs(ladder - z) <= Math.abs(z) ? ladder : 0;
}

/** The next level strictly above (direction 1) or below (-1) `z`; off-grid heights go to the closest level in that direction. */
export function nextZLevel(z: number, direction: 1 | -1): number {
  if (direction > 0) {
    const ladder = phase + (Math.floor((z - phase + epsilon) / zStepMm) + 1) * zStepMm;
    return 0 > z + epsilon && 0 < ladder ? 0 : ladder;
  }
  const ladder = phase + (Math.ceil((z - phase - epsilon) / zStepMm) - 1) * zStepMm;
  return 0 < z - epsilon && 0 > ladder ? 0 : ladder;
}
