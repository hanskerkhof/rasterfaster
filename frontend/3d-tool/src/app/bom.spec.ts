import { buildBom } from './bom';
import type { DocItem } from './document.store';

const item = (id: string, path: string, extra: Partial<DocItem> = {}): DocItem => ({
  id, path, name: path, color: 1, position: [0, 0, 0], rotation: [0, 0, 0, 1], ...extra,
});

describe('buildBom', () => {
  it('counts how often each file is used', () => {
    const rows = buildBom([item('1', 'a.stl'), item("2", 'b.stl'), item('3', 'a.stl')], {});
    expect(rows.map(r => [r.path, r.quantity])).toEqual([['a.stl', 2], ['b.stl', 1]]);
  });

  it('leaves out parts marked do-not-export, but still counts the printed uses of the same file', () => {
    const rows = buildBom([item('1', 'a.stl'), item('2', 'mock.stl', { noExport: true }), item('3', 'a.stl', { noExport: true })], {});
    expect(rows.map(r => [r.path, r.quantity])).toEqual([['a.stl', 1]]);
  });
});
