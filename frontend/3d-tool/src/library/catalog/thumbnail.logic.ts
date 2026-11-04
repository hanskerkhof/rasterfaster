/** Parts bigger than this (bytes) are not drawn by themselves: a thumbnail of a huge mesh takes too long. The card offers "Draw anyway". */
export const maxAutoDrawBytes = 20 * 1024 * 1024;

/** Parts bigger than this are never drawn: the browser would have to hold the whole mesh in memory. */
export const maxDrawBytes = 100 * 1024 * 1024;

export function isLarge(size: number): boolean {
  return size > maxAutoDrawBytes;
}

export function isTooLarge(size: number): boolean {
  return size > maxDrawBytes;
}

/** Bump when the look of a drawing changes: drawings of an older version in the cache are drawn again. */
export const thumbnailVersion = 3;
/** A drawing is made at a fixed size for the screen: this many drawing units per CSS pixel (2: sharp on a retina screen, smoothly reduced on a normal one). */
export const thumbnailScale = 2;
/** Line width in drawing units: one CSS pixel. */
const strokeUnits = thumbnailScale;

/** The unit view direction of a thumbnail (from the part towards the camera; +Z is up): from the front, right and above, like the isometric view of the app. */
export const thumbnailDirection: [number, number, number] = [1, -1, 0.9];

/**
 * A drawing from `buildViewSvg` (black lines on a white page) made fit for a dark card: no page, light lines one CSS pixel wide, a fixed
 * size in CSS pixels (the card shows it as it is, not scaled), coordinates rounded to one decimal. Everything else is left as it is.
 */
export function themeSvg(svg: string): string {
  const box = /viewBox="(-?\d+) (-?\d+) (\d+) (\d+)"/.exec(svg);
  const size = box ? ` width="${Math.round(Number(box[3]) / thumbnailScale)}" height="${Math.round(Number(box[4]) / thumbnailScale)}"` : '';
  return svg
    .replace(/<\?xml[^>]*\?>\s*/, '')
    .replace(/<rect [^>]*fill="#fff"\/>\s*/, '')
    .replace(/<title>.*?<\/title>\s*/s, '')
    .replace(/stroke="#000"/g, 'stroke="#e6e6e6"')
    .replace(/stroke-width="[\d.]+"/g, `stroke-width="${strokeUnits}"`)
    .replace(/(\d+\.\d)\d+/g, '$1') // one decimal is plenty, and a dense part's drawing is half as big
    .replace(/<svg ([^>]*)>/, (_, attributes: string) => `<svg ${attributes.replace(/\s(?:width|height)="[^"]*"/g, '')}${size}>`)
    .trim();
}

/** Volume (mm³) of a closed triangle mesh from its positions (x, y, z per vertex, three vertices per triangle): the sum of the signed tetrahedra to the origin. */
export function meshVolume(positions: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i + 8 < positions.length; i += 9) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = [positions[i], positions[i + 1], positions[i + 2], positions[i + 3], positions[i + 4], positions[i + 5], positions[i + 6], positions[i + 7], positions[i + 8]];
    sum += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return Math.abs(sum) / 6;
}

/** `15 × 15 × 44 mm` (one decimal below 100 mm, none above). */
export function formatDims(dims: readonly number[] | null | undefined): string {
  if (!dims || dims.length < 3) return '';
  const part = (n: number) => (n >= 100 ? String(Math.round(n)) : String(Math.round(n * 10) / 10));
  return `${dims.map(part).join(' × ')} mm`;
}
