import { copyItems, pasteItems } from './clipboard';
import type { DocItem } from './document.store';

const item = (id: string, position: [number, number, number], extra: Partial<DocItem> = {}): DocItem => ({
  id, path: `${id}.stl`, name: id, color: 0xff0000, position, rotation: [0, 0, 0, 1], ...extra,
});

const step = { x: 20, y: 20 };
const identity = (position: [number, number, number]) => position;

describe('clipboard', () => {
  it('copies nothing when nothing is selected', () => {
    expect(copyItems([])).toBeNull();
  });

  it('stores offsets from the lowest corner and the flags, but no ids', () => {
    const clip = copyItems([item('a', [100, 60, 6]), item('b', [140, 40, 10], { muted: true, centered: true })])!;
    expect(clip.origin).toEqual([100, 40, 6]);
    expect(clip.items.map(i => i.offset)).toEqual([[0, 20, 0], [40, 0, 4]]);
    expect(clip.items.map(i => [i.muted, i.centered, i.noExport])).toEqual([[false, false, false], [true, true, false]]);
    expect(JSON.stringify(clip)).not.toContain('"id"');
  });

  it('pastes at the anchor, snapped to the grid, with the same spacing and height', () => {
    const clip = copyItems([item('a', [100, 60, 6]), item('b', [140, 40, 10])])!;
    const pasted = pasteItems(clip, { x: 213, y: -47 }, step, identity);
    expect(pasted.map(p => p.position)).toEqual([[220, -20, 6], [260, -40, 10]]); // origin (100,40,6) -> (220,-40,6)
    expect(pasted[0].rotation).toEqual([0, 0, 0, 1]);
  });

  it('pastes one grid cell away from the original when there is no anchor', () => {
    const clip = copyItems([item('a', [100, 60, 6])])!;
    expect(pasteItems(clip, null, step, identity)[0].position).toEqual([120, 80, 6]);
  });

  it('carries the do-not-export flag along', () => {
    const clip = copyItems([item('a', [0, 0, 0], { noExport: true }), item('b', [20, 0, 0])])!;
    const pasted = pasteItems(clip, null, step, identity);
    expect(pasted[0].noExport).toBe(true);
    expect('noExport' in pasted[1]).toBe(false);
  });

  it('keeps muted/centered only when set, and lets `place` have the last word', () => {
    const clip = copyItems([item('a', [0, 0, 0], { muted: true }), item('b', [20, 0, 0])])!;
    const pasted = pasteItems(clip, null, step, p => [p[0], p[1], 99]);
    expect(pasted[0].muted).toBe(true);
    expect('muted' in pasted[1]).toBe(false);
    expect(pasted.map(p => p.position[2])).toEqual([99, 99]);
  });
});
