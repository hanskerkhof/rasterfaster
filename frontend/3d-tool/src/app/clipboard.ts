import type { DocItem, Quat, Vec3 } from './document.store';

/** A copied part: its content, no id and no absolute position (that is `offset` from the copied selection's lowest corner). */
export interface ClipboardItem {
  path: string;
  name: string;
  color: number;
  rotation: Quat;
  muted: boolean;
  centered: boolean;
  noExport: boolean;
  offset: Vec3;
}

export interface ClipboardContent {
  /** Lowest X, Y and Z over the copied parts when they were copied. */
  origin: Vec3;
  items: ClipboardItem[];
}

/** Copies parts into clipboard form; null when there is nothing to copy. */
export function copyItems(items: readonly DocItem[]): ClipboardContent | null {
  if (!items.length) return null;
  const origin = [0, 1, 2].map(axis => Math.min(...items.map(i => i.position[axis]))) as Vec3;
  return {
    origin,
    items: items.map(i => ({
      path: i.path, name: i.name, color: i.color, rotation: [...i.rotation] as Quat,
      muted: !!i.muted, centered: !!i.centered, noExport: !!i.noExport,
      offset: [i.position[0] - origin[0], i.position[1] - origin[1], i.position[2] - origin[2]],
    })),
  };
}

/**
 * New parts from the clipboard. With an `anchor` (the view centre) the copied group's lowest X/Y corner lands on the nearest grid
 * intersection to it; without one it lands one grid cell away from where it was copied. The height is the one it had.
 * `place` turns a raw position into the final one (centering, work-area clamp), since that needs the part's size.
 */
export function pasteItems(
  clip: ClipboardContent,
  anchor: { x: number; y: number } | null,
  step: { x: number; y: number },
  place: (position: Vec3, item: ClipboardItem) => Vec3,
): Omit<DocItem, 'id'>[] {
  const snap = (value: number, size: number) => Math.round(value / size) * size;
  const base: Vec3 = anchor
    ? [snap(anchor.x, step.x), snap(anchor.y, step.y), clip.origin[2]]
    : [clip.origin[0] + step.x, clip.origin[1] + step.y, clip.origin[2]];
  return clip.items.map(item => ({
    path: item.path, name: item.name, color: item.color, rotation: [...item.rotation] as Quat,
    ...(item.muted ? { muted: true } : {}),
    ...(item.centered ? { centered: true } : {}),
    ...(item.noExport ? { noExport: true } : {}),
    position: place([base[0] + item.offset[0], base[1] + item.offset[1], base[2] + item.offset[2]], item),
  }));
}
